-- Wallet + withdrawals + agent store order visibility

create table if not exists public.wallets (
  agent_id uuid primary key references public.profiles(id) on delete cascade,
  balance numeric(12,2) not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type in ('credit', 'debit')),
  amount numeric(12,2) not null check (amount > 0),
  balance_after numeric(12,2) not null,
  reference text,
  description text,
  created_at timestamptz not null default now()
);

create table if not exists public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  method text not null default 'momo',
  momo_number text not null,
  account_name text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'paid', 'rejected')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists wallet_tx_agent_idx on public.wallet_transactions(agent_id, created_at desc);
create index if not exists withdrawals_agent_idx on public.withdrawals(agent_id, created_at desc);

drop trigger if exists wallets_updated_at on public.wallets;
create trigger wallets_updated_at before update on public.wallets
for each row execute function public.set_updated_at();

drop trigger if exists withdrawals_updated_at on public.withdrawals;
create trigger withdrawals_updated_at before update on public.withdrawals
for each row execute function public.set_updated_at();

alter table public.wallets enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.withdrawals enable row level security;

drop policy if exists "wallets_select_own_or_admin" on public.wallets;
create policy "wallets_select_own_or_admin" on public.wallets
  for select using (agent_id = auth.uid() or public.is_admin());

drop policy if exists "wallet_tx_select_own_or_admin" on public.wallet_transactions;
create policy "wallet_tx_select_own_or_admin" on public.wallet_transactions
  for select using (agent_id = auth.uid() or public.is_admin());

drop policy if exists "withdrawals_select_own_or_admin" on public.withdrawals;
create policy "withdrawals_select_own_or_admin" on public.withdrawals
  for select using (agent_id = auth.uid() or public.is_admin());

drop policy if exists "withdrawals_insert_own" on public.withdrawals;
create policy "withdrawals_insert_own" on public.withdrawals
  for insert with check (agent_id = auth.uid() and public.is_agent());

drop policy if exists "withdrawals_admin_update" on public.withdrawals;
create policy "withdrawals_admin_update" on public.withdrawals
  for update using (public.is_admin()) with check (public.is_admin());

grant select on public.wallets to authenticated;
grant select on public.wallet_transactions to authenticated;
grant select, insert on public.withdrawals to authenticated;
grant update on public.withdrawals to authenticated;

-- Agents can see orders for their store OR their own wholesale buys
drop policy if exists "orders_select_own_or_admin" on public.orders;
create policy "orders_select_own_or_admin" on public.orders
  for select using (
    buyer_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from public.agent_stores s
      where s.id = orders.agent_store_id and s.agent_id = auth.uid()
    )
  );

create or replace function public.ensure_wallet(p_agent_id uuid)
returns public.wallets
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets%rowtype;
begin
  insert into public.wallets (agent_id, balance)
  values (p_agent_id, 0)
  on conflict (agent_id) do nothing;
  select * into w from public.wallets where agent_id = p_agent_id;
  return w;
end;
$$;

create or replace function public.credit_agent_wallet(
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
    set balance = balance + p_amount
    where agent_id = p_agent_id
    returning * into w;
  insert into public.wallet_transactions (agent_id, type, amount, balance_after, reference, description)
  values (p_agent_id, 'credit', p_amount, w.balance, p_reference, p_description);
end;
$$;

create or replace function public.request_withdrawal(
  p_amount numeric,
  p_momo_number text,
  p_account_name text default null,
  p_method text default 'momo'
)
returns public.withdrawals
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets%rowtype;
  wd public.withdrawals%rowtype;
begin
  if auth.uid() is null or not public.is_agent() then
    raise exception 'Only agents can withdraw';
  end if;
  if p_amount is null or p_amount < 10 then
    raise exception 'Minimum withdrawal is GH₵ 10';
  end if;
  if coalesce(trim(p_momo_number), '') = '' then
    raise exception 'Enter a MoMo number';
  end if;

  w := public.ensure_wallet(auth.uid());
  if w.balance < p_amount then
    raise exception 'Insufficient wallet balance';
  end if;

  update public.wallets
    set balance = balance - p_amount
    where agent_id = auth.uid() and balance >= p_amount
    returning * into w;
  if not found then
    raise exception 'Insufficient wallet balance';
  end if;

  insert into public.wallet_transactions (agent_id, type, amount, balance_after, reference, description)
  values (auth.uid(), 'debit', p_amount, w.balance, 'withdrawal', 'Withdrawal request');

  insert into public.withdrawals (agent_id, amount, method, momo_number, account_name, status)
  values (auth.uid(), p_amount, coalesce(nullif(p_method, ''), 'momo'), trim(p_momo_number), nullif(trim(p_account_name), ''), 'pending')
  returning * into wd;

  return wd;
end;
$$;

grant execute on function public.request_withdrawal(numeric, text, text, text) to authenticated;

create or replace function public.place_order(
  p_package_id uuid,
  p_recipient_number text,
  p_payment_method text,
  p_pricing_tier text default 'retail',
  p_agent_store_id uuid default null
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  pkg public.packages%rowtype;
  amount numeric(10,2);
  new_order public.orders%rowtype;
  code text;
  store_rec public.agent_stores%rowtype;
  profit numeric(12,2);
begin
  if p_pricing_tier not in ('retail', 'agent') then
    raise exception 'Invalid pricing tier';
  end if;

  if p_pricing_tier = 'agent' then
    if auth.uid() is null or not public.is_agent() then
      raise exception 'Agent pricing requires an agent account';
    end if;
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
  end if;

  amount := case when p_pricing_tier = 'agent' then pkg.agent_price else pkg.retail_price end;
  code := 'DL-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  insert into public.orders (
    order_code, buyer_id, agent_store_id, package_id, network, gb,
    recipient_number, amount_paid, retail_price, pricing_tier,
    payment_method, payment_status, delivery_status
  ) values (
    code,
    auth.uid(),
    p_agent_store_id,
    pkg.id,
    pkg.network,
    pkg.gb,
    p_recipient_number,
    amount,
    pkg.retail_price,
    p_pricing_tier,
    coalesce(nullif(p_payment_method, ''), 'momo'),
    'paid',
    'processing'
  )
  returning * into new_order;

  -- Credit agent commission when a customer buys via their mini store
  if p_agent_store_id is not null and p_pricing_tier = 'retail' then
    profit := greatest(pkg.retail_price - pkg.agent_price, 0);
    perform public.credit_agent_wallet(
      store_rec.agent_id,
      profit,
      new_order.order_code,
      'Store sale commission · ' || pkg.gb || 'GB ' || pkg.network
    );
  end if;

  return new_order;
end;
$$;

grant execute on function public.place_order(uuid, text, text, text, uuid) to anon, authenticated;
