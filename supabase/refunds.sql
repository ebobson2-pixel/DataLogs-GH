-- Refund & dispute management for DataLogs.shop
-- Integrates with orders, payments, wallets, and Paystack (via edge function).

alter table public.site_settings
  add column if not exists refund_settings jsonb not null default '{
    "auto_max_amount": 100,
    "processing_timeout_minutes": 45,
    "max_requests_per_30_days": 5,
    "manual_review_amount": 150,
    "auto_failed_delivery": true,
    "auto_duplicate": true,
    "require_admin_approval": true
  }'::jsonb;

alter table public.orders
  add column if not exists refunded_at timestamptz;

create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),
  refund_code text not null unique,
  order_id uuid not null unique references public.orders(id) on delete restrict,
  order_code text not null,
  buyer_id uuid references public.profiles(id) on delete set null,
  agent_store_id uuid references public.agent_stores(id) on delete set null,
  agent_id uuid references public.profiles(id) on delete set null,
  amount numeric(12,2) not null check (amount > 0),
  reason text not null check (reason in (
    'data_not_received',
    'payment_deducted_failed',
    'stuck_processing',
    'duplicate_charge',
    'incorrect_amount',
    'wrong_number',
    'other'
  )),
  reason_detail text,
  status text not null default 'requested' check (status in (
    'requested', 'under_review', 'approved', 'rejected',
    'processing', 'completed', 'failed', 'cancelled'
  )),
  eligibility text not null default 'manual_review' check (eligibility in (
    'auto_eligible', 'manual_review', 'not_eligible'
  )),
  payment_method text,
  payment_reference text,
  paystack_refund_id text,
  idempotency_key text not null unique,
  fraud_flag boolean not null default false,
  support_ticket_code text,
  requested_by uuid references public.profiles(id) on delete set null,
  reviewed_by uuid references public.profiles(id) on delete set null,
  admin_note text,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists refunds_status_idx on public.refunds(status, created_at desc);
create index if not exists refunds_buyer_idx on public.refunds(buyer_id, created_at desc);
create index if not exists refunds_agent_idx on public.refunds(agent_id, created_at desc);
create index if not exists refunds_order_code_idx on public.refunds(order_code);

create table if not exists public.refund_events (
  id uuid primary key default gen_random_uuid(),
  refund_id uuid not null references public.refunds(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  actor_role text not null default 'system' check (actor_role in ('system', 'customer', 'admin')),
  action text not null,
  from_status text,
  to_status text,
  note text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists refund_events_refund_idx on public.refund_events(refund_id, created_at asc);

drop trigger if exists refunds_updated_at on public.refunds;
create trigger refunds_updated_at before update on public.refunds
for each row execute function public.set_updated_at();

alter table public.refunds enable row level security;
alter table public.refund_events enable row level security;

drop policy if exists "refunds_select_scope" on public.refunds;
create policy "refunds_select_scope" on public.refunds
  for select using (
    public.is_admin()
    or buyer_id = auth.uid()
    or requested_by = auth.uid()
    or agent_id = auth.uid()
  );

drop policy if exists "refund_events_select_scope" on public.refund_events;
create policy "refund_events_select_scope" on public.refund_events
  for select using (
    public.is_admin()
    or exists (
      select 1 from public.refunds r
      where r.id = refund_events.refund_id
        and (r.buyer_id = auth.uid() or r.requested_by = auth.uid() or r.agent_id = auth.uid())
    )
  );

grant select on public.refunds to authenticated;
grant select on public.refund_events to authenticated;

create or replace function public.refund_policy()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select refund_settings from public.site_settings where id = 1),
    '{}'::jsonb
  );
$$;

create or replace function public.new_refund_code()
returns text
language plpgsql
as $$
declare
  code text;
begin
  code := 'RF-' || to_char(now(), 'YYYY') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  return code;
end;
$$;

create or replace function public.new_support_ticket_code()
returns text
language plpgsql
as $$
begin
  return 'TK-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
end;
$$;

create or replace function public.log_refund_event(
  p_refund_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_action text,
  p_from_status text,
  p_to_status text,
  p_note text default null,
  p_meta jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.refund_events (refund_id, actor_id, actor_role, action, from_status, to_status, note, meta)
  values (p_refund_id, p_actor_id, coalesce(p_actor_role, 'system'), p_action, p_from_status, p_to_status, p_note, coalesce(p_meta, '{}'::jsonb));
end;
$$;

create or replace function public.debit_agent_wallet(
  p_agent_id uuid,
  p_amount numeric,
  p_reference text,
  p_description text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets%rowtype;
begin
  if p_amount is null or p_amount <= 0 then
    return;
  end if;
  w := public.ensure_wallet(p_agent_id);
  update public.wallets
    set balance = balance - p_amount
    where agent_id = p_agent_id and balance >= p_amount
    returning * into w;
  if not found then
    raise exception 'Insufficient wallet balance for debit';
  end if;
  insert into public.wallet_transactions (agent_id, type, amount, balance_after, reference, description)
  values (p_agent_id, 'debit', p_amount, w.balance, p_reference, p_description);
end;
$$;

create or replace function public.order_accessible_for_refund(
  p_order public.orders,
  p_phone text default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  key text;
begin
  if public.is_admin() then
    return true;
  end if;
  if auth.uid() is not null and p_order.buyer_id = auth.uid() then
    return true;
  end if;
  if auth.uid() is not null and exists (
    select 1 from public.agent_stores s
    where s.id = p_order.agent_store_id and s.agent_id = auth.uid()
  ) then
    return true;
  end if;
  key := public.phone_last9(p_phone);
  if key is not null and public.phone_last9(p_order.recipient_number) = key then
    return true;
  end if;
  return false;
end;
$$;

create or replace function public.detect_duplicate_order(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.orders o
    join public.orders dup on dup.id <> o.id
    where o.id = p_order_id
      and dup.payment_status = 'paid'
      and o.payment_status = 'paid'
      and dup.package_id = o.package_id
      and public.phone_last9(dup.recipient_number) = public.phone_last9(o.recipient_number)
      and abs(extract(epoch from (dup.created_at - o.created_at))) <= 300
      and (
        (o.payment_reference is not null and dup.payment_reference = o.payment_reference)
        or (coalesce(o.buyer_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(dup.buyer_id, '00000000-0000-0000-0000-000000000000'::uuid))
      )
  );
$$;

create or replace function public.check_refund_eligibility(
  p_order_code text,
  p_reason text,
  p_phone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ord public.orders%rowtype;
  store_rec public.agent_stores%rowtype;
  policy jsonb := public.refund_policy();
  auto_max numeric := coalesce((policy->>'auto_max_amount')::numeric, 100);
  review_amt numeric := coalesce((policy->>'manual_review_amount')::numeric, 150);
  timeout_min int := coalesce((policy->>'processing_timeout_minutes')::int, 45);
  max_req int := coalesce((policy->>'max_requests_per_30_days')::int, 5);
  recent_count int := 0;
  delivered boolean;
  failed boolean;
  processing boolean;
  dup boolean;
  eligible text := 'not_eligible';
  auto_ok boolean := false;
  review boolean := false;
  msg text := '';
  amount numeric;
  existing public.refunds%rowtype;
begin
  select * into ord from public.orders where upper(order_code) = upper(trim(p_order_code));
  if not found then
    return jsonb_build_object('ok', false, 'message', 'Order not found');
  end if;

  if not public.order_accessible_for_refund(ord, p_phone) then
    return jsonb_build_object('ok', false, 'message', 'You cannot request a refund for this order');
  end if;

  select * into existing from public.refunds where order_id = ord.id;
  if found then
    return jsonb_build_object(
      'ok', true,
      'existing', true,
      'refund_code', existing.refund_code,
      'status', existing.status,
      'amount', existing.amount,
      'eligibility', existing.eligibility,
      'message', 'A refund request already exists for this order'
    );
  end if;

  if ord.payment_status <> 'paid' then
    return jsonb_build_object('ok', true, 'eligible', 'not_eligible', 'message', 'This order was not paid successfully');
  end if;

  amount := ord.amount_paid;
  delivered := ord.delivery_status in ('delivered', 'completed');
  failed := ord.delivery_status = 'failed';
  processing := ord.delivery_status in ('pending', 'processing') and not delivered and not failed;
  dup := public.detect_duplicate_order(ord.id);

  if ord.buyer_id is not null then
    select count(*) into recent_count
    from public.refunds r
    where r.buyer_id = ord.buyer_id
      and r.created_at >= now() - interval '30 days'
      and r.status not in ('cancelled', 'rejected');
  elsif p_phone is not null then
    select count(*) into recent_count
    from public.refunds r
    join public.orders o on o.id = r.order_id
    where public.phone_last9(o.recipient_number) = public.phone_last9(p_phone)
      and r.created_at >= now() - interval '30 days'
      and r.status not in ('cancelled', 'rejected');
  end if;

  if recent_count >= max_req then
    review := true;
    msg := 'Refund review required due to recent refund activity on this account.';
  end if;

  if amount > review_amt then
    review := true;
    msg := coalesce(nullif(msg, ''), 'High-value refunds require manual review.');
  end if;

  if p_reason = 'wrong_number' then
    eligible := 'manual_review';
    msg := coalesce(nullif(msg, ''), 'Wrong-number cases require support review.');
  elsif delivered and p_reason in ('data_not_received', 'payment_deducted_failed') then
    eligible := 'manual_review';
    msg := 'This transaction is marked as successfully delivered. Contact support if you believe this is incorrect.';
  elsif dup and p_reason = 'duplicate_charge' and coalesce((policy->>'auto_duplicate')::boolean, true) then
    eligible := 'auto_eligible';
    auto_ok := true;
    msg := 'Duplicate transaction detected.';
  elsif failed and coalesce((policy->>'auto_failed_delivery')::boolean, true) then
    eligible := 'auto_eligible';
    auto_ok := true;
    msg := 'Payment succeeded but data delivery failed.';
  elsif processing then
    if ord.created_at < now() - make_interval(mins => timeout_min) then
      eligible := 'manual_review';
      review := true;
      msg := coalesce(nullif(msg, ''), 'Transaction processing timed out and needs review.');
    else
      eligible := 'not_eligible';
      msg := 'Your transaction is still being processed. Check again shortly.';
    end if;
  elsif p_reason in ('incorrect_amount', 'other', 'stuck_processing') then
    eligible := 'manual_review';
    msg := coalesce(nullif(msg, ''), 'This refund requires review.');
  else
    eligible := 'manual_review';
    msg := coalesce(nullif(msg, ''), 'Refund requires review.');
  end if;

  if review and eligible = 'auto_eligible' then
    eligible := 'manual_review';
    auto_ok := false;
  end if;

  if eligible = 'auto_eligible' and amount > auto_max then
    eligible := 'manual_review';
    auto_ok := false;
    msg := coalesce(nullif(msg, ''), 'Amount exceeds automatic refund limit.');
  end if;

  if ord.agent_store_id is not null then
    select * into store_rec from public.agent_stores where id = ord.agent_store_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'existing', false,
    'order_id', ord.id,
    'order_code', ord.order_code,
    'amount', amount,
    'eligible', eligible,
    'auto_process', false,
    'requires_review', true,
    'fraud_flag', recent_count >= max_req,
    'message', msg,
    'payment_status', ord.payment_status,
    'delivery_status', ord.delivery_status,
    'network', ord.network,
    'gb', ord.gb,
    'recipient_number', ord.recipient_number,
    'duplicate_detected', dup,
    'store_name', store_rec.name
  );
end;
$$;

create or replace function public.create_refund_request(
  p_order_code text,
  p_reason text,
  p_reason_detail text default null,
  p_phone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  chk jsonb;
  ord public.orders%rowtype;
  store_rec public.agent_stores%rowtype;
  rf public.refunds%rowtype;
  ticket text;
  init_status text;
begin
  chk := public.check_refund_eligibility(p_order_code, p_reason, p_phone);
  if coalesce((chk->>'ok')::boolean, false) is not true then
    return chk;
  end if;
  if coalesce((chk->>'existing')::boolean, false) then
    return chk;
  end if;
  if (chk->>'eligible') = 'not_eligible' then
    return chk;
  end if;

  select * into ord from public.orders where id = (chk->>'order_id')::uuid;

  if ord.agent_store_id is not null then
    select * into store_rec from public.agent_stores where id = ord.agent_store_id;
  end if;

  init_status := 'under_review';
  ticket := public.new_support_ticket_code();

  insert into public.refunds (
    refund_code, order_id, order_code, buyer_id, agent_store_id, agent_id,
    amount, reason, reason_detail, status, eligibility,
    payment_method, payment_reference, idempotency_key,
    fraud_flag, support_ticket_code, requested_by
  ) values (
    public.new_refund_code(),
    ord.id,
    ord.order_code,
    ord.buyer_id,
    ord.agent_store_id,
    store_rec.agent_id,
    ord.amount_paid,
    p_reason,
    nullif(trim(p_reason_detail), ''),
    init_status,
    chk->>'eligible',
    ord.payment_method,
    ord.payment_reference,
    'refund:' || ord.id::text,
    coalesce((chk->>'fraud_flag')::boolean, false),
    ticket,
    auth.uid()
  )
  returning * into rf;

  perform public.log_refund_event(rf.id, auth.uid(), case when auth.uid() is null then 'customer' else 'customer' end,
    'refund_requested', null, rf.status, chk->>'message', chk);

  return jsonb_build_object(
    'ok', true,
    'refund_id', rf.id,
    'refund_code', rf.refund_code,
    'status', rf.status,
    'amount', rf.amount,
    'eligibility', rf.eligibility,
    'support_ticket_code', rf.support_ticket_code,
    'auto_process', false,
    'message', coalesce(chk->>'message', 'Your refund request was submitted for admin review.')
  );
end;
$$;

create or replace function public.confirm_refund_request(p_refund_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rf public.refunds%rowtype;
  old_status text;
begin
  select * into rf from public.refunds where id = p_refund_id for update;
  if not found then
    raise exception 'Refund not found';
  end if;

  if rf.status not in ('requested', 'approved', 'under_review') then
    return jsonb_build_object('ok', true, 'refund', to_jsonb(rf), 'already', true);
  end if;

  old_status := rf.status;
  if rf.status in ('requested', 'under_review') then
    update public.refunds set status = 'under_review' where id = rf.id returning * into rf;
    perform public.log_refund_event(
      rf.id, auth.uid(), 'customer', 'customer_confirmed',
      old_status, 'under_review', 'Awaiting admin approval'
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'refund', to_jsonb(rf),
    'ready_to_process', false,
    'message', 'Your refund request was submitted. An administrator will review it before any money is returned.'
  );
end;
$$;

create or replace function public.admin_review_refund(
  p_refund_id uuid,
  p_action text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rf public.refunds%rowtype;
  new_status text;
  old_status text;
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;

  select * into rf from public.refunds where id = p_refund_id for update;
  if not found then
    raise exception 'Refund not found';
  end if;

  old_status := rf.status;

  if p_action = 'approve' then
    new_status := 'approved';
  elsif p_action = 'reject' then
    new_status := 'rejected';
  elsif p_action = 'request_info' then
    new_status := 'under_review';
  else
    raise exception 'Invalid action';
  end if;

  update public.refunds
    set status = new_status,
        reviewed_by = auth.uid(),
        admin_note = coalesce(nullif(trim(p_note), ''), admin_note)
    where id = rf.id
    returning * into rf;

  perform public.log_refund_event(rf.id, auth.uid(), 'admin', 'admin_' || p_action, old_status, new_status, p_note);

  return jsonb_build_object('ok', true, 'refund', to_jsonb(rf));
end;
$$;

create or replace function public.reverse_agent_store_profit(p_order public.orders, p_refund_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  store_rec public.agent_stores%rowtype;
  profit_amt numeric := 0;
begin
  if p_order.agent_store_id is null then
    return;
  end if;
  select * into store_rec from public.agent_stores where id = p_order.agent_store_id;
  if not found then
    return;
  end if;
  select coalesce(sum(wt.amount), 0) into profit_amt
  from public.wallet_transactions wt
  where wt.agent_id = store_rec.agent_id
    and wt.type = 'credit'
    and wt.reference = p_order.order_code;
  if profit_amt > 0 then
    perform public.debit_agent_wallet(
      store_rec.agent_id,
      profit_amt,
      p_refund_code,
      'Refund reversal · store profit · ' || p_order.order_code
    );
  end if;
end;
$$;

create or replace function public.process_refund(p_refund_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rf public.refunds%rowtype;
  ord public.orders%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('refund:' || p_refund_id::text));

  select * into rf from public.refunds where id = p_refund_id for update;
  if not found then
    raise exception 'Refund not found';
  end if;

  if rf.status = 'completed' then
    return jsonb_build_object('ok', true, 'refund', to_jsonb(rf), 'already', true);
  end if;

  if rf.status not in ('approved', 'processing') then
    raise exception 'Refund is not approved for processing';
  end if;

  select * into ord from public.orders where id = rf.order_id for update;
  if ord.payment_status = 'refunded' then
    update public.refunds set status = 'completed', completed_at = coalesce(completed_at, now()) where id = rf.id returning * into rf;
    return jsonb_build_object('ok', true, 'refund', to_jsonb(rf), 'already', true);
  end if;

  update public.refunds set status = 'processing' where id = rf.id returning * into rf;
  perform public.log_refund_event(rf.id, null, 'system', 'processing_started', rf.status, 'processing', null);

  -- Wallet-paid wholesale orders
  if lower(coalesce(ord.payment_method, '')) = 'wallet' and ord.buyer_id is not null then
    perform public.credit_agent_wallet(
      ord.buyer_id,
      rf.amount,
      rf.refund_code,
      'Refund · wallet purchase · ' || ord.order_code
    );
    perform public.reverse_agent_store_profit(ord, rf.refund_code);
    update public.orders set payment_status = 'refunded', refunded_at = now() where id = ord.id;
    update public.refunds set status = 'completed', completed_at = now() where id = rf.id returning * into rf;
    perform public.log_refund_event(rf.id, null, 'system', 'wallet_refund_completed', 'processing', 'completed', null);
    return jsonb_build_object('ok', true, 'refund', to_jsonb(rf), 'channel', 'wallet');
  end if;

  -- Paystack orders: edge function completes via complete_refund
  perform public.reverse_agent_store_profit(ord, rf.refund_code);
  return jsonb_build_object(
    'ok', true,
    'refund', to_jsonb(rf),
    'channel', 'paystack',
    'payment_reference', rf.payment_reference,
    'needs_paystack', true
  );
end;
$$;

create or replace function public.complete_refund(
  p_refund_id uuid,
  p_paystack_refund_id text default null,
  p_success boolean default true,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rf public.refunds%rowtype;
  ord public.orders%rowtype;
begin
  select * into rf from public.refunds where id = p_refund_id for update;
  if not found then
    raise exception 'Refund not found';
  end if;

  if rf.status = 'completed' then
    return jsonb_build_object('ok', true, 'refund', to_jsonb(rf), 'already', true);
  end if;

  if not p_success then
    update public.refunds
      set status = 'failed', failure_reason = coalesce(nullif(trim(p_error), ''), 'Paystack refund failed')
      where id = rf.id
      returning * into rf;
    perform public.log_refund_event(rf.id, null, 'system', 'refund_failed', rf.status, 'failed', p_error);
    return jsonb_build_object('ok', false, 'refund', to_jsonb(rf));
  end if;

  select * into ord from public.orders where id = rf.order_id;
  update public.orders set payment_status = 'refunded', refunded_at = now() where id = ord.id;
  update public.refunds
    set status = 'completed',
        completed_at = now(),
        paystack_refund_id = coalesce(p_paystack_refund_id, paystack_refund_id)
    where id = rf.id
    returning * into rf;
  perform public.log_refund_event(rf.id, null, 'system', 'refund_completed', 'processing', 'completed', null);
  return jsonb_build_object('ok', true, 'refund', to_jsonb(rf));
end;
$$;

create or replace function public.get_refund_detail(p_refund_code text, p_phone text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rf public.refunds%rowtype;
  ord public.orders%rowtype;
  events jsonb;
begin
  select * into rf from public.refunds where upper(refund_code) = upper(trim(p_refund_code));
  if not found then
    raise exception 'Refund not found';
  end if;
  select * into ord from public.orders where id = rf.order_id;
  if not public.order_accessible_for_refund(ord, p_phone) and not public.is_admin() then
    raise exception 'Not authorized';
  end if;
  select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at asc), '[]'::jsonb)
    into events
  from public.refund_events e
  where e.refund_id = rf.id;
  return jsonb_build_object('refund', to_jsonb(rf), 'order', to_jsonb(ord), 'events', events);
end;
$$;

create or replace function public.list_my_refunds(p_phone text default null)
returns setof public.refunds
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_admin() then
    return query select * from public.refunds order by created_at desc limit 100;
  end if;
  if auth.uid() is not null then
    return query
      select * from public.refunds r
      where r.buyer_id = auth.uid() or r.requested_by = auth.uid() or r.agent_id = auth.uid()
      order by r.created_at desc
      limit 50;
  end if;
  if p_phone is not null then
    return query
      select r.* from public.refunds r
      join public.orders o on o.id = r.order_id
      where public.phone_last9(o.recipient_number) = public.phone_last9(p_phone)
      order by r.created_at desc
      limit 20;
  end if;
  return;
end;
$$;

create or replace function public.admin_refund_stats()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'total_requests', (select count(*) from public.refunds),
    'pending', (select count(*) from public.refunds where status in ('requested', 'under_review', 'approved', 'processing')),
    'completed', (select count(*) from public.refunds where status = 'completed'),
    'failed', (select count(*) from public.refunds where status = 'failed'),
    'total_refunded', (select coalesce(sum(amount), 0) from public.refunds where status = 'completed'),
    'auto_completed', (select count(*) from public.refunds where status = 'completed' and eligibility = 'auto_eligible')
  )
  where public.is_admin();
$$;

grant execute on function public.check_refund_eligibility(text, text, text) to anon, authenticated;
grant execute on function public.create_refund_request(text, text, text, text) to anon, authenticated;
grant execute on function public.confirm_refund_request(uuid) to anon, authenticated;
grant execute on function public.get_refund_detail(text, text) to anon, authenticated;
grant execute on function public.list_my_refunds(text) to anon, authenticated;
grant execute on function public.admin_review_refund(uuid, text, text) to authenticated;
grant execute on function public.admin_refund_stats() to authenticated;
grant execute on function public.process_refund(uuid) to service_role;
grant execute on function public.complete_refund(uuid, text, boolean, text) to service_role;

create or replace function public.admin_list_refunds(p_status text default 'all')
returns table (
  id uuid,
  refund_code text,
  order_code text,
  amount numeric,
  reason text,
  status text,
  eligibility text,
  payment_method text,
  fraud_flag boolean,
  support_ticket_code text,
  customer_label text,
  agent_label text,
  created_at timestamptz,
  completed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;
  return query
  select
    r.id,
    r.refund_code,
    r.order_code,
    r.amount,
    r.reason,
    r.status,
    r.eligibility,
    r.payment_method,
    r.fraud_flag,
    r.support_ticket_code,
    coalesce(pr.full_name, pr.email, 'Guest') as customer_label,
    coalesce(ar.full_name, ar.email, '—') as agent_label,
    r.created_at,
    r.completed_at
  from public.refunds r
  left join public.profiles pr on pr.id = coalesce(r.buyer_id, r.requested_by)
  left join public.profiles ar on ar.id = r.agent_id
  where p_status = 'all' or r.status = p_status
  order by r.created_at desc
  limit 200;
end;
$$;

grant execute on function public.admin_list_refunds(text) to authenticated;

notify pgrst, 'reload schema';
