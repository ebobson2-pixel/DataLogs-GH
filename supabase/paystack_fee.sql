-- Add 3% Paystack fee validation for package MoMo/card payments.
-- Run this in Supabase SQL Editor (keeps agent activation + wallet top-up logic).

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

  -- Buyers pay package price + 3% Paystack fee on MoMo/card charges.
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

notify pgrst, 'reload schema';
