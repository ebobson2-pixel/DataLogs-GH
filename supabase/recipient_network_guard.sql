-- Reject checkout when recipient SIM network != package network

create or replace function public.normalize_ghana_msisdn(p_raw text)
returns text
language plpgsql
immutable
as $$
declare
  digits text := regexp_replace(coalesce(p_raw, ''), '\D', '', 'g');
begin
  if digits ~ '^233[0-9]{9}$' then
    return '0' || substr(digits, 4);
  end if;
  if digits ~ '^[0-9]{9}$' then
    return '0' || digits;
  end if;
  if digits ~ '^0[0-9]{9}$' then
    return digits;
  end if;
  return null;
end;
$$;

create or replace function public.network_from_msisdn(p_raw text)
returns text
language plpgsql
immutable
as $$
declare
  local text := public.normalize_ghana_msisdn(p_raw);
  prefix text;
begin
  if local is null then
    return null;
  end if;
  prefix := substr(local, 1, 3);
  if prefix in ('024', '025', '053', '054', '055', '059') then
    return 'mtn';
  end if;
  if prefix in ('026', '027', '056', '057') then
    return 'airteltigo';
  end if;
  if prefix in ('020', '050') then
    return 'telecel';
  end if;
  return null;
end;
$$;

create or replace function public.assert_recipient_matches_package(
  p_recipient text,
  p_package_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  pkg public.packages%rowtype;
  detected text;
  local text;
  pretty text;
begin
  select * into pkg from public.packages where id = p_package_id and active = true;
  if not found then
    raise exception 'Package not found';
  end if;

  local := public.normalize_ghana_msisdn(p_recipient);
  if local is null then
    raise exception 'Enter a valid Ghana number, like 024 123 4567';
  end if;

  detected := public.network_from_msisdn(local);
  if detected is null then
    raise exception 'That prefix is not recognised for MTN, AirtelTigo or Telecel';
  end if;

  if detected is distinct from pkg.network then
    raise exception
      'Recipient number is % but this package is for %. Use a matching number or pick the correct network package.',
      upper(detected),
      upper(pkg.network);
  end if;

  pretty := substr(local, 1, 3) || ' ' || substr(local, 4, 3) || ' ' || substr(local, 7);
  return pretty;
end;
$$;

grant execute on function public.normalize_ghana_msisdn(text) to anon, authenticated, service_role;
grant execute on function public.network_from_msisdn(text) to anon, authenticated, service_role;
grant execute on function public.assert_recipient_matches_package(text, uuid) to anon, authenticated, service_role;

-- Wallet wholesale must enforce network match
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
    payment_method, payment_status, delivery_status, payment_reference
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
    ref
  )
  returning * into new_order;

  return new_order;
end;
$$;

-- Patch payment completion to reject mismatched recipients before creating orders
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

  amount := round((amount * 1.03)::numeric, 2);

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

notify pgrst, 'reload schema';
