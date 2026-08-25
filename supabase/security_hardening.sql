-- Security hardening: stop free orders, wallet minting, and privileged profile self-edits.

-- 1) Never let clients call free "paid" place_order or mint wallet credits
revoke execute on function public.place_order(uuid, text, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.credit_agent_wallet(uuid, numeric, text, text) from public, anon, authenticated;
revoke execute on function public.ensure_wallet(uuid) from public, anon, authenticated;

-- Keep wallet top-up / store profit paths working inside security definer callers
grant execute on function public.credit_agent_wallet(uuid, numeric, text, text) to service_role;
grant execute on function public.ensure_wallet(uuid) to service_role;

-- 2) Orders: default pending; clients may only insert pending rows
alter table public.orders
  alter column payment_status set default 'pending';

drop policy if exists "orders_insert_authenticated" on public.orders;
create policy "orders_insert_authenticated" on public.orders
  for insert with check (
    auth.uid() is not null
    and buyer_id = auth.uid()
    and payment_status = 'pending'
    and (
      pricing_tier = 'retail'
      or (pricing_tier = 'agent' and public.is_agent())
    )
  );

drop policy if exists "orders_insert_guest_retail" on public.orders;
create policy "orders_insert_guest_retail" on public.orders
  for insert with check (
    buyer_id is null
    and pricing_tier = 'retail'
    and agent_store_id is not null
    and payment_status = 'pending'
  );

-- Block clients from flipping orders to paid/delivered
drop policy if exists "orders_admin_update" on public.orders;
create policy "orders_admin_update" on public.orders
  for update using (public.is_admin()) with check (public.is_admin());

revoke update on public.orders from authenticated;
grant update on public.orders to authenticated; -- kept for admin RLS path; non-admin denied by policy

-- 3) Lock privileged profile columns (activation, block, parent, recruiting, role)
create or replace function public.protect_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_admin() then
    return new;
  end if;

  -- SECURITY DEFINER RPCs run as postgres/supabase_admin — allow those paths
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.role is distinct from old.role then
      raise exception 'Cannot change account role';
    end if;
    if coalesce(new.blocked, false) is distinct from coalesce(old.blocked, false) then
      raise exception 'Cannot change blocked status';
    end if;
    if coalesce(new.agent_activated, false) is distinct from coalesce(old.agent_activated, false) then
      raise exception 'Cannot change activation status';
    end if;
    if new.parent_agent_id is distinct from old.parent_agent_id then
      raise exception 'Cannot change parent agent';
    end if;
    if coalesce(new.subagents_enabled, false) is distinct from coalesce(old.subagents_enabled, false) then
      raise exception 'Cannot change subagent recruiting here';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_protect_privileges on public.profiles;
create trigger profiles_protect_privileges
  before update on public.profiles
  for each row execute function public.protect_profile_privileges();

-- 4) Withdrawals only via request_withdrawal RPC
drop policy if exists "withdrawals_insert_own" on public.withdrawals;
revoke insert on public.withdrawals from authenticated;
revoke update on public.withdrawals from authenticated;
grant select on public.withdrawals to authenticated;

-- 5) Tighten quote_order_amount: ignore client-supplied buyer unless self/admin
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
  buyer uuid;
  base_price numeric(12,2);
  profit numeric(12,2);
  sell_price numeric(12,2);
  parent_id uuid;
  sub_cost numeric(12,2);
begin
  if p_pricing_tier not in ('retail', 'agent') then
    raise exception 'Invalid pricing tier';
  end if;

  -- Never allow quoting another agent's wholesale rates
  buyer := auth.uid();
  if buyer is null then
    buyer := null;
  elsif p_buyer_id is not null and p_buyer_id is distinct from buyer and not public.is_admin() then
    raise exception 'Not allowed';
  elsif public.is_admin() and p_buyer_id is not null then
    buyer := p_buyer_id;
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
    select p.parent_agent_id into parent_id from public.profiles p where p.id = buyer;
    if parent_id is not null then
      select spp.agent_price into sub_cost
      from public.subagent_package_prices spp
      where spp.parent_id = parent_id and spp.package_id = pkg.id;
      return coalesce(sub_cost, public.platform_agent_base(parent_id, pkg.id));
    end if;
    return public.platform_agent_base(buyer, pkg.id);
  end if;

  return pkg.retail_price;
end;
$$;

notify pgrst, 'reload schema';
