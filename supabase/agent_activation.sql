-- Agent activation fee: admin can require Paystack payment before dashboard access.

alter table public.profiles
  add column if not exists agent_activated boolean not null default false;

alter table public.site_settings
  add column if not exists agent_activation_fee_enabled boolean not null default false;

alter table public.site_settings
  add column if not exists agent_activation_fee numeric(12,2) not null default 0
    check (agent_activation_fee >= 0);

-- Existing agents keep access.
update public.profiles
set agent_activated = true
where role in ('agent', 'admin') and coalesce(agent_activated, false) = false;

alter table public.payments drop constraint if exists payments_kind_check;
alter table public.payments
  add constraint payments_kind_check
  check (kind in ('order', 'wallet_topup', 'agent_activation'));

create or replace function public.agent_activation_required()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  enabled boolean;
  fee numeric(12,2);
begin
  select
    coalesce(agent_activation_fee_enabled, false),
    coalesce(agent_activation_fee, 0)
  into enabled, fee
  from public.site_settings
  where id = 1;
  return coalesce(enabled, false) and coalesce(fee, 0) > 0;
end;
$$;

create or replace function public.sync_agent_activation(p_user_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := coalesce(p_user_id, auth.uid());
  prof public.profiles%rowtype;
  required boolean;
  fee numeric(12,2);
begin
  if uid is null then
    raise exception 'Sign in required';
  end if;
  if p_user_id is not null and p_user_id <> auth.uid() and not public.is_admin() then
    raise exception 'Not allowed';
  end if;

  select * into prof from public.profiles where id = uid;
  if not found then
    raise exception 'Profile not found';
  end if;

  select coalesce(agent_activation_fee, 0) into fee from public.site_settings where id = 1;
  required := public.agent_activation_required();

  if prof.role = 'admin' then
    update public.profiles set agent_activated = true where id = uid and agent_activated = false;
    return jsonb_build_object('ok', true, 'required', false, 'activated', true, 'fee', 0, 'role', prof.role);
  end if;

  if prof.role <> 'agent' then
    return jsonb_build_object('ok', true, 'required', false, 'activated', true, 'fee', 0, 'role', prof.role);
  end if;

  if not required then
    update public.profiles set agent_activated = true where id = uid and agent_activated = false;
    return jsonb_build_object('ok', true, 'required', false, 'activated', true, 'fee', 0, 'role', 'agent');
  end if;

  select * into prof from public.profiles where id = uid;
  return jsonb_build_object(
    'ok', true,
    'required', true,
    'activated', coalesce(prof.agent_activated, false),
    'fee', fee,
    'role', 'agent'
  );
end;
$$;

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
  price_row public.agent_store_prices%rowtype;
  custom_price numeric(12,2);
  base_price numeric(12,2);
  profit numeric(12,2) := 0;
  amount numeric(12,2);
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

  if store_id is not null then
    select * into store_rec from public.agent_stores where id = store_id and published = true;
    if not found then
      raise exception 'Store not available';
    end if;
    select r.base_price, r.profit, r.sell_price
      into base_price, profit, amount
    from public.resolve_agent_store_price(store_rec.agent_id, pkg.id) r;
    pricing_tier := 'retail';
  elsif pricing_tier = 'agent' then
    select ucp.agent_price into custom_price
    from public.user_custom_prices ucp
    where ucp.user_id = buyer and ucp.package_id = pkg.id;
    amount := coalesce(custom_price, pkg.agent_price);
  else
    amount := pkg.retail_price;
  end if;

  if abs(amount - pay.amount) > 0.05 then
    raise exception 'Paid amount does not match package price';
  end if;

  code := 'DL-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  insert into public.orders (
    order_code, buyer_id, agent_store_id, package_id, network, gb,
    recipient_number, amount_paid, retail_price, pricing_tier,
    payment_method, payment_status, delivery_status, payment_reference
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
    pay.reference
  )
  returning * into new_order;

  if store_id is not null and profit > 0 then
    perform public.credit_agent_wallet(
      store_rec.agent_id,
      profit,
      new_order.order_code,
      'Store profit · ' || pkg.gb || 'GB ' || pkg.network || ' · sold at GH₵ ' || pay.amount
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

drop function if exists public.update_site_settings(text, text, text, numeric);

create or replace function public.update_site_settings(
  p_whatsapp_channel_url text,
  p_support_contact text,
  p_support_label text default 'Support',
  p_withdrawal_threshold numeric default null,
  p_agent_activation_fee_enabled boolean default null,
  p_agent_activation_fee numeric default null
)
returns public.site_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  row_out public.site_settings%rowtype;
  threshold numeric(12,2);
  fee_enabled boolean;
  fee_amount numeric(12,2);
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;

  select
    coalesce(withdrawal_threshold, 10),
    coalesce(agent_activation_fee_enabled, false),
    coalesce(agent_activation_fee, 0)
  into threshold, fee_enabled, fee_amount
  from public.site_settings
  where id = 1;

  if p_withdrawal_threshold is not null then
    if p_withdrawal_threshold < 0 then
      raise exception 'Withdrawal threshold cannot be negative';
    end if;
    threshold := p_withdrawal_threshold;
  end if;
  if threshold is null then
    threshold := 10;
  end if;

  if p_agent_activation_fee_enabled is not null then
    fee_enabled := p_agent_activation_fee_enabled;
  end if;
  if p_agent_activation_fee is not null then
    if p_agent_activation_fee < 0 then
      raise exception 'Activation fee cannot be negative';
    end if;
    fee_amount := p_agent_activation_fee;
  end if;
  if fee_amount is null then
    fee_amount := 0;
  end if;
  if fee_enabled and fee_amount <= 0 then
    raise exception 'Set an activation fee greater than 0, or turn the fee off';
  end if;

  insert into public.site_settings (
    id, whatsapp_channel_url, support_contact, support_label,
    withdrawal_threshold, agent_activation_fee_enabled, agent_activation_fee, updated_by
  ) values (
    1,
    nullif(trim(p_whatsapp_channel_url), ''),
    nullif(trim(p_support_contact), ''),
    coalesce(nullif(trim(p_support_label), ''), 'Support'),
    threshold,
    fee_enabled,
    fee_amount,
    auth.uid()
  )
  on conflict (id) do update set
    whatsapp_channel_url = excluded.whatsapp_channel_url,
    support_contact = excluded.support_contact,
    support_label = excluded.support_label,
    withdrawal_threshold = excluded.withdrawal_threshold,
    agent_activation_fee_enabled = excluded.agent_activation_fee_enabled,
    agent_activation_fee = excluded.agent_activation_fee,
    updated_by = excluded.updated_by,
    updated_at = now()
  returning * into row_out;

  -- If fee is turned off, unlock any agents waiting to pay.
  if not coalesce(row_out.agent_activation_fee_enabled, false)
     or coalesce(row_out.agent_activation_fee, 0) <= 0 then
    update public.profiles
      set agent_activated = true
      where role = 'agent' and coalesce(agent_activated, false) = false;
  end if;

  return row_out;
end;
$$;

grant execute on function public.agent_activation_required() to anon, authenticated;
grant execute on function public.sync_agent_activation(uuid) to authenticated;
grant execute on function public.complete_confirmed_payment(text) to service_role;
grant execute on function public.update_site_settings(text, text, text, numeric, boolean, numeric) to authenticated;

notify pgrst, 'reload schema';
