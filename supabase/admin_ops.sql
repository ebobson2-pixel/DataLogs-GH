-- Site settings, blocked accounts, per-user custom prices, admin wallet credit

alter table public.profiles
  add column if not exists blocked boolean not null default false;

create table if not exists public.site_settings (
  id int primary key default 1 check (id = 1),
  whatsapp_channel_url text,
  support_contact text,
  support_label text not null default 'Support',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

insert into public.site_settings (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.user_custom_prices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  package_id uuid not null references public.packages(id) on delete cascade,
  agent_price numeric(12,2) not null check (agent_price >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, package_id)
);

create index if not exists user_custom_prices_user_idx on public.user_custom_prices(user_id);

drop trigger if exists site_settings_updated_at on public.site_settings;
create trigger site_settings_updated_at before update on public.site_settings
for each row execute function public.set_updated_at();

drop trigger if exists user_custom_prices_updated_at on public.user_custom_prices;
create trigger user_custom_prices_updated_at before update on public.user_custom_prices
for each row execute function public.set_updated_at();

alter table public.site_settings enable row level security;
alter table public.user_custom_prices enable row level security;

drop policy if exists "site_settings_public_read" on public.site_settings;
create policy "site_settings_public_read" on public.site_settings
  for select using (true);

drop policy if exists "site_settings_admin_update" on public.site_settings;
create policy "site_settings_admin_update" on public.site_settings
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists "ucp_select_own_or_admin" on public.user_custom_prices;
create policy "ucp_select_own_or_admin" on public.user_custom_prices
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists "ucp_admin_insert" on public.user_custom_prices;
create policy "ucp_admin_insert" on public.user_custom_prices
  for insert with check (public.is_admin());

drop policy if exists "ucp_admin_update" on public.user_custom_prices;
create policy "ucp_admin_update" on public.user_custom_prices
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists "ucp_admin_delete" on public.user_custom_prices;
create policy "ucp_admin_delete" on public.user_custom_prices
  for delete using (public.is_admin());

grant select on public.site_settings to anon, authenticated;
grant update on public.site_settings to authenticated;
grant select, insert, update, delete on public.user_custom_prices to authenticated;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
      and coalesce(p.blocked, false) = false
  );
$$;

create or replace function public.is_agent()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role in ('agent', 'admin')
      and coalesce(p.blocked, false) = false
  );
$$;

grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.is_agent() to anon, authenticated;

create or replace function public.admin_credit_wallet(
  p_user_id uuid,
  p_amount numeric,
  p_note text default null
)
returns public.wallets
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;
  if p_user_id is null then
    raise exception 'User is required';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter an amount greater than zero';
  end if;
  perform public.credit_agent_wallet(
    p_user_id,
    round(p_amount::numeric, 2),
    'admin-credit',
    coalesce(nullif(trim(p_note), ''), 'Admin wallet credit')
  );
  w := public.ensure_wallet(p_user_id);
  return w;
end;
$$;

grant execute on function public.admin_credit_wallet(uuid, numeric, text) to authenticated;

create or replace function public.admin_set_blocked(
  p_user_id uuid,
  p_blocked boolean
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  row_out public.profiles%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'You cannot block your own account';
  end if;
  update public.profiles
    set blocked = coalesce(p_blocked, false)
    where id = p_user_id
    returning * into row_out;
  if not found then
    raise exception 'User not found';
  end if;
  return row_out;
end;
$$;

grant execute on function public.admin_set_blocked(uuid, boolean) to authenticated;

create or replace function public.admin_set_custom_price(
  p_user_id uuid,
  p_package_id uuid,
  p_agent_price numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;
  if p_agent_price is null then
    delete from public.user_custom_prices
      where user_id = p_user_id and package_id = p_package_id;
    return jsonb_build_object('ok', true, 'cleared', true);
  end if;
  if p_agent_price < 0 then
    raise exception 'Price cannot be negative';
  end if;
  insert into public.user_custom_prices (user_id, package_id, agent_price)
  values (p_user_id, p_package_id, round(p_agent_price::numeric, 2))
  on conflict (user_id, package_id)
  do update set agent_price = excluded.agent_price, updated_at = now();
  return jsonb_build_object('ok', true, 'cleared', false);
end;
$$;

grant execute on function public.admin_set_custom_price(uuid, uuid, numeric) to authenticated;

create or replace function public.update_site_settings(
  p_whatsapp_channel_url text,
  p_support_contact text,
  p_support_label text default 'Support'
)
returns public.site_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  row_out public.site_settings%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;
  insert into public.site_settings (id, whatsapp_channel_url, support_contact, support_label, updated_by)
  values (
    1,
    nullif(trim(p_whatsapp_channel_url), ''),
    nullif(trim(p_support_contact), ''),
    coalesce(nullif(trim(p_support_label), ''), 'Support'),
    auth.uid()
  )
  on conflict (id) do update set
    whatsapp_channel_url = excluded.whatsapp_channel_url,
    support_contact = excluded.support_contact,
    support_label = excluded.support_label,
    updated_by = excluded.updated_by,
    updated_at = now()
  returning * into row_out;
  return row_out;
end;
$$;

grant execute on function public.update_site_settings(text, text, text) to authenticated;

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
  custom_price numeric(12,2);
  base_price numeric(12,2);
begin
  if auth.uid() is not null and exists (
    select 1 from public.profiles p where p.id = auth.uid() and coalesce(p.blocked, false)
  ) then
    raise exception 'This account is blocked';
  end if;

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
    profit := price_row.profit;
    amount := base_price + profit;
  elsif p_pricing_tier = 'agent' then
    select ucp.agent_price into custom_price
    from public.user_custom_prices ucp
    where ucp.user_id = auth.uid() and ucp.package_id = pkg.id;
    amount := coalesce(custom_price, pkg.agent_price);
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
