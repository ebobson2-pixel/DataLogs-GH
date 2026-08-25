-- Paystack payments: orders and agent wallet top-ups. Only webhook/service role marks them paid.

alter table public.orders
  add column if not exists payment_reference text;

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  kind text not null check (kind in ('order', 'wallet_topup')),
  status text not null default 'pending' check (status in ('pending', 'success', 'failed', 'abandoned')),
  amount numeric(12,2) not null check (amount > 0),
  currency text not null default 'GHS',
  email text,
  channel text,
  user_id uuid references public.profiles(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  paystack_id text,
  metadata jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists payments_reference_idx on public.payments(reference);
create index if not exists payments_user_idx on public.payments(user_id, created_at desc);
create index if not exists orders_payment_reference_idx on public.orders(payment_reference);

alter table public.payments enable row level security;

drop policy if exists "payments_select_own_or_admin" on public.payments;
create policy "payments_select_own_or_admin" on public.payments
  for select using (user_id = auth.uid() or public.is_admin());

grant select on public.payments to anon, authenticated;

create or replace function public.quote_order_amount(
  p_package_id uuid,
  p_pricing_tier text default 'retail',
  p_agent_store_id uuid default null,
  p_buyer_id uuid default null
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
  price_row public.agent_store_prices%rowtype;
  custom_price numeric(12,2);
  base_price numeric(12,2);
  buyer uuid := coalesce(p_buyer_id, auth.uid());
begin
  if p_pricing_tier not in ('retail', 'agent') then
    raise exception 'Invalid pricing tier';
  end if;
  select * into pkg from public.packages where id = p_package_id and active = true;
  if not found then
    raise exception 'Package not found';
  end if;

  if p_agent_store_id is not null then
    select * into store_rec from public.agent_stores where id = p_agent_store_id and published = true;
    if not found then
      raise exception 'Store not available';
    end if;
    select * into price_row
    from public.agent_store_prices
    where agent_id = store_rec.agent_id and package_id = pkg.id;
    if not found then
      raise exception 'This package is not priced in the agent store yet';
    end if;
    select ucp.agent_price into custom_price
    from public.user_custom_prices ucp
    where ucp.user_id = store_rec.agent_id and ucp.package_id = pkg.id;
    base_price := coalesce(custom_price, pkg.agent_price);
    return base_price + coalesce(price_row.profit, 0);
  end if;

  if p_pricing_tier = 'agent' then
    if buyer is null then
      raise exception 'Agent pricing requires an agent account';
    end if;
    if not exists (
      select 1 from public.profiles p
      where p.id = buyer and p.role in ('agent', 'admin') and coalesce(p.blocked, false) = false
    ) then
      raise exception 'Agent pricing requires an agent account';
    end if;
    select ucp.agent_price into custom_price
    from public.user_custom_prices ucp
    where ucp.user_id = buyer and ucp.package_id = pkg.id;
    return coalesce(custom_price, pkg.agent_price);
  end if;

  return pkg.retail_price;
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
  custom_price numeric(12,2);
  w public.wallets%rowtype;
  new_order public.orders%rowtype;
  code text;
  ref text;
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

  select ucp.agent_price into custom_price
  from public.user_custom_prices ucp
  where ucp.user_id = auth.uid() and ucp.package_id = pkg.id;
  amount := coalesce(custom_price, pkg.agent_price);

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
    p_recipient_number,
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

grant execute on function public.quote_order_amount(uuid, text, uuid, uuid) to anon, authenticated;
revoke execute on function public.place_order_with_wallet(uuid, text) from public, anon;
grant execute on function public.place_order_with_wallet(uuid, text) to authenticated;
revoke execute on function public.complete_confirmed_payment(text) from public, anon, authenticated;
grant execute on function public.complete_confirmed_payment(text) to service_role;
revoke execute on function public.place_order(uuid, text, text, text, uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
