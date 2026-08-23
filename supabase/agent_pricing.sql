-- Agent-set store prices: base = packages.agent_price, sell = base + profit

create table if not exists public.agent_store_prices (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.profiles(id) on delete cascade,
  package_id uuid not null references public.packages(id) on delete cascade,
  profit numeric(12,2) not null default 0 check (profit >= 0),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (agent_id, package_id)
);

create index if not exists agent_store_prices_agent_idx on public.agent_store_prices(agent_id);

drop trigger if exists agent_store_prices_updated_at on public.agent_store_prices;
create trigger agent_store_prices_updated_at before update on public.agent_store_prices
for each row execute function public.set_updated_at();

alter table public.agent_store_prices enable row level security;

drop policy if exists "asp_select_own_or_admin_or_public_store" on public.agent_store_prices;
create policy "asp_select_own_or_admin_or_public_store" on public.agent_store_prices
  for select using (
    agent_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from public.agent_stores s
      where s.agent_id = agent_store_prices.agent_id and s.published = true
    )
  );

drop policy if exists "asp_upsert_own" on public.agent_store_prices;
create policy "asp_upsert_own" on public.agent_store_prices
  for insert with check (agent_id = auth.uid() and public.is_agent());

drop policy if exists "asp_update_own" on public.agent_store_prices;
create policy "asp_update_own" on public.agent_store_prices
  for update using (agent_id = auth.uid() or public.is_admin())
  with check (agent_id = auth.uid() or public.is_admin());

drop policy if exists "asp_delete_own" on public.agent_store_prices;
create policy "asp_delete_own" on public.agent_store_prices
  for delete using (agent_id = auth.uid() or public.is_admin());

grant select, insert, update, delete on public.agent_store_prices to authenticated;
grant select on public.agent_store_prices to anon;

create or replace function public.set_agent_package_profit(
  p_package_id uuid,
  p_profit numeric
)
returns public.agent_store_prices
language plpgsql
security definer
set search_path = public
as $$
declare
  row_out public.agent_store_prices%rowtype;
begin
  if auth.uid() is null or not public.is_agent() then
    raise exception 'Only agents can set store prices';
  end if;
  if p_profit is null or p_profit < 0 then
    raise exception 'Profit must be zero or more';
  end if;
  if not exists (select 1 from public.packages where id = p_package_id and active = true) then
    raise exception 'Package not found';
  end if;

  insert into public.agent_store_prices (agent_id, package_id, profit)
  values (auth.uid(), p_package_id, round(p_profit::numeric, 2))
  on conflict (agent_id, package_id)
  do update set profit = excluded.profit, updated_at = now()
  returning * into row_out;

  return row_out;
end;
$$;

grant execute on function public.set_agent_package_profit(uuid, numeric) to authenticated;

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
  profit numeric(12,2) := 0;
  price_row public.agent_store_prices%rowtype;
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

    select r.profit, r.sell_price
      into profit, amount
    from public.resolve_agent_store_price(store_rec.agent_id, pkg.id) r;
  elsif p_pricing_tier = 'agent' then
    amount := pkg.agent_price;
  else
    amount := pkg.retail_price;
  end if;

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
    case when p_agent_store_id is not null then 'retail' else p_pricing_tier end,
    coalesce(nullif(p_payment_method, ''), 'momo'),
    'paid',
    'processing'
  )
  returning * into new_order;

  if p_agent_store_id is not null and profit > 0 then
    perform public.credit_agent_wallet(
      store_rec.agent_id,
      profit,
      new_order.order_code,
      'Store profit · ' || pkg.gb || 'GB ' || pkg.network || ' · sold at GH₵ ' || amount
    );
  end if;

  return new_order;
end;
$$;

grant execute on function public.place_order(uuid, text, text, text, uuid) to anon, authenticated;
