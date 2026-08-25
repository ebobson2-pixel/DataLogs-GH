-- Subagents pay parent-set wholesale cost via quote_order_amount
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

notify pgrst, 'reload schema';
