-- Agent API keys + server-side order placement for the public agent API

create table if not exists public.agent_api_keys (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.profiles(id) on delete cascade,
  name text not null default 'Website',
  key_prefix text not null,
  key_hash text not null unique,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists agent_api_keys_agent_idx on public.agent_api_keys(agent_id);
create index if not exists agent_api_keys_hash_idx on public.agent_api_keys(key_hash);

alter table public.agent_api_keys enable row level security;

drop policy if exists "api_keys_select_own" on public.agent_api_keys;
create policy "api_keys_select_own" on public.agent_api_keys
  for select using (agent_id = auth.uid() or public.is_admin());

grant select on public.agent_api_keys to authenticated;

create or replace function public.create_agent_api_key(p_name text default 'Website')
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  raw_key text;
  hashed text;
  prefix text;
  row_id uuid;
  label text;
  key_count int;
begin
  if auth.uid() is null or not public.is_agent() then
    raise exception 'Only agents can create API keys';
  end if;

  select count(*) into key_count
  from public.agent_api_keys
  where agent_id = auth.uid() and revoked_at is null;
  if key_count >= 5 then
    raise exception 'You can have at most 5 active API keys. Revoke one first.';
  end if;

  label := coalesce(nullif(trim(p_name), ''), 'Website');
  raw_key := 'dlg_live_' || encode(gen_random_bytes(24), 'hex');
  hashed := encode(digest(convert_to(raw_key, 'UTF8'), 'sha256'), 'hex');
  prefix := substr(raw_key, 1, 16);

  insert into public.agent_api_keys (agent_id, name, key_prefix, key_hash)
  values (auth.uid(), label, prefix, hashed)
  returning id into row_id;

  return jsonb_build_object(
    'id', row_id,
    'name', label,
    'key', raw_key,
    'prefix', prefix,
    'created_at', now()
  );
end;
$$;

create or replace function public.list_agent_api_keys()
returns table (
  id uuid,
  name text,
  key_prefix text,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select k.id, k.name, k.key_prefix, k.last_used_at, k.revoked_at, k.created_at
  from public.agent_api_keys k
  where k.agent_id = auth.uid()
  order by k.created_at desc;
$$;

create or replace function public.revoke_agent_api_key(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_agent() then
    raise exception 'Only agents can revoke API keys';
  end if;
  update public.agent_api_keys
    set revoked_at = now()
    where id = p_id and agent_id = auth.uid() and revoked_at is null;
  if not found then
    raise exception 'API key not found';
  end if;
  return true;
end;
$$;

grant execute on function public.create_agent_api_key(text) to authenticated;
grant execute on function public.list_agent_api_keys() to authenticated;
grant execute on function public.revoke_agent_api_key(uuid) to authenticated;

create or replace function public.api_place_agent_order(
  p_agent_id uuid,
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
  agent public.profiles%rowtype;
  amount numeric(10,2);
  custom_price numeric(12,2);
  new_order public.orders%rowtype;
  code text;
begin
  select * into agent from public.profiles where id = p_agent_id;
  if not found then
    raise exception 'Agent not found';
  end if;
  if coalesce(agent.blocked, false) then
    raise exception 'This account is blocked';
  end if;
  if agent.role not in ('agent', 'admin') then
    raise exception 'Only agents can place API orders';
  end if;

  select * into pkg from public.packages where id = p_package_id and active = true;
  if not found then
    raise exception 'Package not found';
  end if;

  select ucp.agent_price into custom_price
  from public.user_custom_prices ucp
  where ucp.user_id = p_agent_id and ucp.package_id = pkg.id;

  amount := coalesce(custom_price, pkg.agent_price);
  code := 'DL-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  insert into public.orders (
    order_code, buyer_id, agent_store_id, package_id, network, gb,
    recipient_number, amount_paid, retail_price, pricing_tier,
    payment_method, payment_status, delivery_status
  ) values (
    code,
    p_agent_id,
    null,
    pkg.id,
    pkg.network,
    pkg.gb,
    p_recipient_number,
    amount,
    pkg.retail_price,
    'agent',
    'api',
    'paid',
    'processing'
  )
  returning * into new_order;

  return new_order;
end;
$$;

grant execute on function public.api_place_agent_order(uuid, uuid, text) to service_role;
