-- Platform earnings: log only margin/fee the platform keeps (not customer gross or agent share)

alter table public.orders
  add column if not exists platform_margin numeric(12,2) not null default 0;

create table if not exists public.platform_ledger (
  id uuid primary key default gen_random_uuid(),
  entry_kind text not null check (entry_kind in ('order_margin', 'activation_fee', 'refund_adjustment')),
  amount numeric(12,2) not null,
  order_id uuid references public.orders(id) on delete set null,
  payment_id uuid references public.payments(id) on delete set null,
  reference text,
  description text,
  created_at timestamptz not null default now()
);

create unique index if not exists platform_ledger_order_margin_uidx
  on public.platform_ledger (order_id)
  where entry_kind = 'order_margin' and order_id is not null;

create unique index if not exists platform_ledger_activation_uidx
  on public.platform_ledger (payment_id)
  where entry_kind = 'activation_fee' and payment_id is not null;

create index if not exists platform_ledger_created_idx
  on public.platform_ledger (created_at desc);

alter table public.platform_ledger enable row level security;

drop policy if exists "platform_ledger_admin" on public.platform_ledger;
create policy "platform_ledger_admin" on public.platform_ledger
  for select using (public.is_admin());

grant select on public.platform_ledger to authenticated;

create or replace function public.compute_order_platform_margin(
  p_package_id uuid,
  p_buyer_id uuid,
  p_agent_store_id uuid,
  p_pricing_tier text,
  p_amount_paid numeric
)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  pkg public.packages%rowtype;
  store_rec public.agent_stores%rowtype;
  parent_id uuid;
  base_price numeric(12,2);
  parent_base numeric(12,2);
  cogs numeric(12,2);
begin
  select * into pkg from public.packages where id = p_package_id;
  if not found then
    return 0;
  end if;
  cogs := coalesce(pkg.agent_price, 0);

  if p_agent_store_id is not null then
    select * into store_rec from public.agent_stores where id = p_agent_store_id;
    if not found then
      return 0;
    end if;
    select r.base_price into base_price
    from public.resolve_agent_store_price(store_rec.agent_id, p_package_id) r;
    select p.parent_agent_id into parent_id from public.profiles p where p.id = store_rec.agent_id;
    if parent_id is not null then
      parent_base := public.platform_agent_base(parent_id, p_package_id);
      return round(greatest(0, coalesce(parent_base, 0) - cogs)::numeric, 2);
    end if;
    return round(greatest(0, coalesce(base_price, 0) - cogs)::numeric, 2);
  end if;

  if coalesce(p_pricing_tier, 'retail') = 'agent' then
    if p_buyer_id is not null then
      select p.parent_agent_id into parent_id from public.profiles p where p.id = p_buyer_id;
      if parent_id is not null then
        parent_base := public.platform_agent_base(parent_id, p_package_id);
        return round(greatest(0, coalesce(parent_base, 0) - cogs)::numeric, 2);
      end if;
    end if;
    return round(greatest(0, coalesce(p_amount_paid, 0) - cogs)::numeric, 2);
  end if;

  return round(greatest(0, coalesce(pkg.retail_price, 0) - cogs)::numeric, 2);
end;
$$;

grant execute on function public.compute_order_platform_margin(uuid, uuid, uuid, text, numeric)
  to anon, authenticated, service_role;

create or replace function public.log_platform_ledger(
  p_kind text,
  p_amount numeric,
  p_order_id uuid default null,
  p_payment_id uuid default null,
  p_reference text default null,
  p_description text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(p_amount, 0) = 0 then
    return;
  end if;

  if p_order_id is not null and p_kind = 'order_margin' then
    if exists (
      select 1 from public.platform_ledger pl
      where pl.order_id = p_order_id and pl.entry_kind = 'order_margin'
    ) then
      return;
    end if;
  end if;

  if p_payment_id is not null and p_kind = 'activation_fee' then
    if exists (
      select 1 from public.platform_ledger pl
      where pl.payment_id = p_payment_id and pl.entry_kind = 'activation_fee'
    ) then
      return;
    end if;
  end if;

  insert into public.platform_ledger (entry_kind, amount, order_id, payment_id, reference, description)
  values (p_kind, round(p_amount::numeric, 2), p_order_id, p_payment_id, p_reference, p_description);
end;
$$;

grant execute on function public.log_platform_ledger(text, numeric, uuid, uuid, text, text) to service_role;

create or replace function public.admin_platform_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  order_margins numeric(12,2) := 0;
  activation_fees numeric(12,2) := 0;
  refund_total numeric(12,2) := 0;
  gross_paid numeric(12,2) := 0;
  paid_orders int := 0;
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;

  select
    coalesce(sum(case when entry_kind = 'order_margin' then amount else 0 end), 0),
    coalesce(sum(case when entry_kind = 'activation_fee' then amount else 0 end), 0),
    coalesce(sum(case when entry_kind = 'refund_adjustment' then amount else 0 end), 0)
  into order_margins, activation_fees, refund_total
  from public.platform_ledger;

  select coalesce(sum(amount_paid), 0), count(*)
  into gross_paid, paid_orders
  from public.orders
  where payment_status = 'paid';

  return jsonb_build_object(
    'platform_earnings', round((order_margins + activation_fees + refund_total)::numeric, 2),
    'order_margins', round(order_margins, 2),
    'activation_fees', round(activation_fees, 2),
    'refunds', round(refund_total, 2),
    'gross_customer_payments', round(gross_paid, 2),
    'paid_orders', paid_orders
  );
end;
$$;

grant execute on function public.admin_platform_stats() to authenticated;

create or replace function public.reset_platform_revenue()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cleared int;
  orders_reset int;
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;

  delete from public.platform_ledger;
  get diagnostics cleared = row_count;

  update public.orders set platform_margin = 0 where coalesce(platform_margin, 0) <> 0;
  get diagnostics orders_reset = row_count;

  return jsonb_build_object(
    'ok', true,
    'ledger_rows_cleared', cleared,
    'orders_reset', orders_reset
  );
end;
$$;

grant execute on function public.reset_platform_revenue() to authenticated;

-- Log margin + activation on payment completion
create or replace function public.complete_confirmed_payment(p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pay public.payments%rowtype;
  pkg public.packages%rowtype;
  store_rec public.agent_stores%rowtype;
  amount numeric(12,2);
  sell_amount numeric(12,2) := 0;
  margin numeric(12,2) := 0;
  new_order public.orders%rowtype;
  code text;
  meta jsonb;
  package_id uuid;
  recipient text;
  pricing_tier text;
  store_id uuid;
  buyer uuid;
  fee numeric(12,2);
begin
  perform pg_advisory_xact_lock(hashtext(coalesce(p_reference, '')));

  select * into pay from public.payments where reference = p_reference for update;
  if not found then
    raise exception 'Payment not found';
  end if;
  if pay.status = 'success' then
    return jsonb_build_object('ok', true, 'payment', to_jsonb(pay), 'already', true);
  end if;
  if pay.status <> 'pending' then
    raise exception 'Payment is not pending';
  end if;

  meta := coalesce(pay.metadata, '{}'::jsonb);

  if pay.kind = 'wallet_topup' then
    buyer := coalesce(pay.user_id, (meta->>'agent_id')::uuid);
    if buyer is null then
      raise exception 'Missing agent for wallet top-up';
    end if;
    perform public.credit_agent_wallet(
      buyer,
      pay.amount,
      pay.reference,
      'Paystack wallet top-up'
    );
    update public.payments
      set status = 'success', paid_at = now()
      where id = pay.id
      returning * into pay;
    return jsonb_build_object('ok', true, 'payment', to_jsonb(pay), 'kind', 'wallet_topup');
  end if;

  if pay.kind = 'agent_activation' then
    buyer := coalesce(pay.user_id, (meta->>'agent_id')::uuid);
    if buyer is null then
      raise exception 'Missing agent for activation payment';
    end if;
    if not exists (
      select 1 from public.profiles p
      where p.id = buyer and p.role = 'agent' and coalesce(p.blocked, false) = false
    ) then
      raise exception 'Activation is only for agent accounts';
    end if;
    if not public.agent_activation_required() then
      update public.profiles set agent_activated = true where id = buyer;
      update public.payments
        set status = 'success', paid_at = now()
        where id = pay.id
        returning * into pay;
      return jsonb_build_object('ok', true, 'payment', to_jsonb(pay), 'kind', 'agent_activation', 'activated', true);
    end if;
    select coalesce(agent_activation_fee, 0) into fee from public.site_settings where id = 1;
    if abs(fee - pay.amount) > 0.05 then
      raise exception 'Paid amount does not match activation fee';
    end if;
    update public.profiles
      set agent_activated = true
      where id = buyer;
    update public.payments
      set status = 'success', paid_at = now()
      where id = pay.id
      returning * into pay;
    perform public.log_platform_ledger(
      'activation_fee',
      pay.amount,
      null,
      pay.id,
      pay.reference,
      'Agent activation fee'
    );
    return jsonb_build_object('ok', true, 'payment', to_jsonb(pay), 'kind', 'agent_activation', 'activated', true);
  end if;

  package_id := (meta->>'package_id')::uuid;
  recipient := meta->>'recipient_number';
  pricing_tier := coalesce(meta->>'pricing_tier', 'retail');
  store_id := nullif(meta->>'agent_store_id', '')::uuid;
  buyer := coalesce(pay.user_id, nullif(meta->>'buyer_id', '')::uuid);

  if package_id is null or coalesce(recipient, '') = '' then
    raise exception 'Payment is missing order details';
  end if;

  select * into pkg from public.packages where id = package_id and active = true;
  if not found then
    raise exception 'Package not found';
  end if;

  recipient := public.assert_recipient_matches_package(recipient, pkg.id);

  if store_id is not null then
    select * into store_rec from public.agent_stores where id = store_id and published = true;
    if not found then
      raise exception 'Store not available';
    end if;
    select r.sell_price into amount
    from public.resolve_agent_store_price(store_rec.agent_id, pkg.id) r;
    sell_amount := amount;
    pricing_tier := 'retail';
  elsif pricing_tier = 'agent' then
    amount := public.quote_order_amount(pkg.id, 'agent', null, buyer);
  else
    amount := pkg.retail_price;
  end if;

  margin := public.compute_order_platform_margin(
    pkg.id,
    buyer,
    store_id,
    pricing_tier,
    amount
  );

  amount := round((amount * 1.03)::numeric, 2);

  if abs(amount - pay.amount) > 0.05 then
    raise exception 'Paid amount does not match package price';
  end if;

  code := 'DL-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  insert into public.orders (
    order_code, buyer_id, agent_store_id, package_id, network, gb,
    recipient_number, amount_paid, retail_price, pricing_tier,
    payment_method, payment_status, delivery_status, payment_reference,
    platform_margin
  ) values (
    code,
    buyer,
    store_id,
    pkg.id,
    pkg.network,
    pkg.gb,
    recipient,
    pay.amount,
    pkg.retail_price,
    pricing_tier,
    coalesce(pay.channel, 'paystack'),
    'paid',
    'processing',
    pay.reference,
    margin
  )
  returning * into new_order;

  perform public.log_platform_ledger(
    'order_margin',
    margin,
    new_order.id,
    pay.id,
    new_order.order_code,
    'Data margin · ' || pkg.network || ' ' || pkg.gb || 'GB'
  );

  if store_id is not null then
    perform public.credit_store_sale_profits(
      store_rec.agent_id,
      pkg.id,
      sell_amount,
      new_order.order_code,
      pkg.gb,
      pkg.network
    );
  end if;

  update public.payments
    set status = 'success',
        paid_at = now(),
        order_id = new_order.id
    where id = pay.id
    returning * into pay;

  return jsonb_build_object(
    'ok', true,
    'payment', to_jsonb(pay),
    'order', to_jsonb(new_order),
    'kind', 'order'
  );
end;
$$;

create or replace function public.place_order_with_wallet(
  p_package_id uuid,
  p_recipient_number text
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  pkg public.packages%rowtype;
  amount numeric(12,2);
  margin numeric(12,2) := 0;
  w public.wallets%rowtype;
  new_order public.orders%rowtype;
  code text;
  ref text;
  recipient text;
begin
  if auth.uid() is null or not public.is_agent() then
    raise exception 'Sign in as an agent to pay with wallet';
  end if;
  if exists (select 1 from public.profiles p where p.id = auth.uid() and coalesce(p.blocked, false)) then
    raise exception 'This account is blocked';
  end if;

  select * into pkg from public.packages where id = p_package_id and active = true;
  if not found then
    raise exception 'Package not found';
  end if;

  recipient := public.assert_recipient_matches_package(p_recipient_number, pkg.id);
  amount := public.quote_order_amount(pkg.id, 'agent', null, auth.uid());
  margin := public.compute_order_platform_margin(
    pkg.id,
    auth.uid(),
    null,
    'agent',
    amount
  );

  w := public.ensure_wallet(auth.uid());
  update public.wallets
    set balance = balance - amount
    where agent_id = auth.uid() and balance >= amount
    returning * into w;
  if not found then
    raise exception 'Insufficient wallet balance. Top up first.';
  end if;

  code := 'DL-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  ref := 'WALLET-' || code;

  insert into public.wallet_transactions (agent_id, type, amount, balance_after, reference, description)
  values (
    auth.uid(),
    'debit',
    amount,
    w.balance,
    ref,
    'Wholesale data · ' || pkg.gb || 'GB ' || pkg.network
  );

  insert into public.orders (
    order_code, buyer_id, package_id, network, gb,
    recipient_number, amount_paid, retail_price, pricing_tier,
    payment_method, payment_status, delivery_status, payment_reference,
    platform_margin
  ) values (
    code,
    auth.uid(),
    pkg.id,
    pkg.network,
    pkg.gb,
    recipient,
    amount,
    pkg.retail_price,
    'agent',
    'wallet',
    'paid',
    'processing',
    ref,
    margin
  )
  returning * into new_order;

  perform public.log_platform_ledger(
    'order_margin',
    margin,
    new_order.id,
    null,
    new_order.order_code,
    'Wholesale margin · ' || pkg.network || ' ' || pkg.gb || 'GB'
  );

  return new_order;
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
  reversal numeric(12,2) := 0;
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

  reversal := coalesce(ord.platform_margin, 0);
  if reversal > 0 then
    perform public.log_platform_ledger(
      'refund_adjustment',
      -reversal,
      ord.id,
      null,
      rf.refund_code,
      'Refund reversal · ' || ord.order_code
    );
  end if;

  return jsonb_build_object('ok', true, 'refund', to_jsonb(rf));
end;
$$;

notify pgrst, 'reload schema';
