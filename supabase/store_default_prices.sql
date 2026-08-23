-- Default agent store prices use admin retail until the agent saves custom profits.

create or replace function public.resolve_agent_store_price(
  p_agent_id uuid,
  p_package_id uuid,
  out base_price numeric,
  out profit numeric,
  out sell_price numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  pkg public.packages%rowtype;
  price_row public.agent_store_prices%rowtype;
  custom_price numeric(12,2);
begin
  select * into pkg from public.packages where id = p_package_id and active = true;
  if not found then
    raise exception 'Package not found';
  end if;

  select ucp.agent_price into custom_price
  from public.user_custom_prices ucp
  where ucp.user_id = p_agent_id and ucp.package_id = p_package_id;

  base_price := coalesce(custom_price, pkg.agent_price);

  select * into price_row
  from public.agent_store_prices
  where agent_id = p_agent_id and package_id = p_package_id;

  if found then
    profit := coalesce(price_row.profit, 0);
  else
    profit := greatest(0, pkg.retail_price - base_price);
  end if;

  sell_price := base_price + profit;
end;
$$;

grant execute on function public.resolve_agent_store_price(uuid, uuid) to anon, authenticated, service_role;

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
  custom_price numeric(12,2);
  buyer uuid := coalesce(p_buyer_id, auth.uid());
  base_price numeric(12,2);
  profit numeric(12,2);
  sell_price numeric(12,2);
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
    select r.base_price, r.profit, r.sell_price
      into base_price, profit, sell_price
    from public.resolve_agent_store_price(store_rec.agent_id, pkg.id) r;
    return sell_price;
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
