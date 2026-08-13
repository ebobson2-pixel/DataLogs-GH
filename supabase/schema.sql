-- DataLogs GH schema
create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  phone text,
  email text,
  role text not null default 'customer' check (role in ('customer', 'agent', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.packages (
  id uuid primary key default gen_random_uuid(),
  network text not null check (network in ('mtn', 'airteltigo', 'telecel')),
  gb numeric(10,2) not null check (gb > 0),
  retail_price numeric(10,2) not null check (retail_price >= 0),
  agent_price numeric(10,2) not null check (agent_price >= 0),
  validity text not null default '30 days',
  tag text,
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_stores (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null unique references public.profiles(id) on delete cascade,
  name text not null,
  slug text not null unique,
  tagline text,
  networks text[] not null default array['mtn','airteltigo','telecel']::text[],
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_code text not null unique,
  buyer_id uuid references public.profiles(id) on delete set null,
  agent_store_id uuid references public.agent_stores(id) on delete set null,
  package_id uuid references public.packages(id) on delete set null,
  network text not null,
  gb numeric(10,2) not null,
  recipient_number text not null,
  amount_paid numeric(10,2) not null,
  retail_price numeric(10,2),
  pricing_tier text not null check (pricing_tier in ('retail', 'agent')),
  payment_method text not null default 'momo',
  payment_status text not null default 'paid' check (payment_status in ('pending', 'paid', 'failed', 'refunded')),
  delivery_status text not null default 'processing' check (delivery_status in ('pending', 'processing', 'delivered', 'failed')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists packages_network_idx on public.packages(network);
create index if not exists packages_active_idx on public.packages(active);
create index if not exists orders_buyer_idx on public.orders(buyer_id);
create index if not exists orders_created_idx on public.orders(created_at desc);
create index if not exists agent_stores_slug_idx on public.agent_stores(slug);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists packages_updated_at on public.packages;
create trigger packages_updated_at before update on public.packages
for each row execute function public.set_updated_at();

drop trigger if exists agent_stores_updated_at on public.agent_stores;
create trigger agent_stores_updated_at before update on public.agent_stores
for each row execute function public.set_updated_at();

drop trigger if exists orders_updated_at on public.orders;
create trigger orders_updated_at before update on public.orders
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_role text := coalesce(new.raw_user_meta_data->>'role', 'customer');
  safe_role text;
begin
  if requested_role in ('customer', 'agent') then
    safe_role := requested_role;
  else
    safe_role := 'customer';
  end if;

  insert into public.profiles (id, full_name, phone, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1), ''),
    new.raw_user_meta_data->>'phone',
    new.email,
    safe_role
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
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
    where p.id = auth.uid() and p.role in ('agent', 'admin')
  );
$$;

alter table public.profiles enable row level security;
alter table public.packages enable row level security;
alter table public.agent_stores enable row level security;
alter table public.orders enable row level security;

drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin" on public.profiles
  for select using (auth.uid() = id or public.is_admin());

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id or public.is_admin())
  with check (
    (auth.uid() = id and role = (select role from public.profiles where id = auth.uid()))
    or public.is_admin()
  );

drop policy if exists "packages_public_read_active" on public.packages;
create policy "packages_public_read_active" on public.packages
  for select using (active = true or public.is_admin());

drop policy if exists "packages_admin_all" on public.packages;
create policy "packages_admin_all" on public.packages
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "stores_public_read_published" on public.agent_stores;
create policy "stores_public_read_published" on public.agent_stores
  for select using (published = true or agent_id = auth.uid() or public.is_admin());

drop policy if exists "stores_agent_insert" on public.agent_stores;
create policy "stores_agent_insert" on public.agent_stores
  for insert with check (agent_id = auth.uid() and public.is_agent());

drop policy if exists "stores_agent_update" on public.agent_stores;
create policy "stores_agent_update" on public.agent_stores
  for update using (agent_id = auth.uid() or public.is_admin())
  with check (agent_id = auth.uid() or public.is_admin());

drop policy if exists "stores_admin_delete" on public.agent_stores;
create policy "stores_admin_delete" on public.agent_stores
  for delete using (public.is_admin() or agent_id = auth.uid());

drop policy if exists "orders_select_own_or_admin" on public.orders;
create policy "orders_select_own_or_admin" on public.orders
  for select using (buyer_id = auth.uid() or public.is_admin());

drop policy if exists "orders_insert_authenticated" on public.orders;
create policy "orders_insert_authenticated" on public.orders
  for insert with check (
    auth.uid() is not null
    and buyer_id = auth.uid()
    and (
      pricing_tier = 'retail'
      or (pricing_tier = 'agent' and public.is_agent())
    )
  );

drop policy if exists "orders_admin_update" on public.orders;
create policy "orders_admin_update" on public.orders
  for update using (public.is_admin()) with check (public.is_admin());

-- Allow guest checkout via anon insert of retail orders with null buyer
drop policy if exists "orders_insert_guest_retail" on public.orders;
create policy "orders_insert_guest_retail" on public.orders
  for insert with check (
    buyer_id is null
    and pricing_tier = 'retail'
    and agent_store_id is not null
  );

grant usage on schema public to anon, authenticated;
grant select on public.packages to anon, authenticated;
grant select on public.agent_stores to anon, authenticated;
grant select, insert on public.orders to anon, authenticated;
grant select, update on public.profiles to authenticated;
grant insert, update, delete on public.agent_stores to authenticated;
grant all on public.packages to authenticated;
grant update on public.orders to authenticated;

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

  return new_order;
end;
$$;

grant execute on function public.place_order(uuid, text, text, text, uuid) to anon, authenticated;
