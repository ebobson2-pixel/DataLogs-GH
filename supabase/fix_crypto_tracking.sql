-- Fix API key generation (pgcrypto lives in the extensions schema)
-- and re-apply public order tracking.

create extension if not exists pgcrypto with schema extensions;

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
  disabled boolean;
begin
  if auth.uid() is null or not public.is_agent() then
    raise exception 'Only agents can create API keys';
  end if;

  select coalesce(api_disabled, false) into disabled
  from public.profiles where id = auth.uid();
  if disabled then
    raise exception 'API access is disabled on this account. Contact DataLogs GH support.';
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

create or replace function public.admin_create_user_api_key(p_user_id uuid, p_name text default 'Website')
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  agent public.profiles%rowtype;
  raw_key text;
  hashed text;
  prefix text;
  row_id uuid;
  label text;
  key_count int;
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;

  select * into agent from public.profiles where id = p_user_id;
  if not found then
    raise exception 'User not found';
  end if;
  if coalesce(agent.blocked, false) then
    raise exception 'This account is blocked';
  end if;
  if agent.role not in ('agent', 'admin') then
    raise exception 'Only agents can have API keys. Promote the user first.';
  end if;
  if coalesce(agent.api_disabled, false) then
    raise exception 'API access is disabled for this user. Enable it first.';
  end if;

  select count(*) into key_count
  from public.agent_api_keys
  where agent_id = p_user_id and revoked_at is null;
  if key_count >= 5 then
    raise exception 'This user already has 5 active API keys. Revoke one first.';
  end if;

  label := coalesce(nullif(trim(p_name), ''), 'Website');
  raw_key := 'dlg_live_' || encode(gen_random_bytes(24), 'hex');
  hashed := encode(digest(convert_to(raw_key, 'UTF8'), 'sha256'), 'hex');
  prefix := substr(raw_key, 1, 16);

  insert into public.agent_api_keys (agent_id, name, key_prefix, key_hash)
  values (p_user_id, label, prefix, hashed)
  returning id into row_id;

  return jsonb_build_object(
    'id', row_id,
    'name', label,
    'key', raw_key,
    'prefix', prefix,
    'agent_id', p_user_id,
    'created_at', now()
  );
end;
$$;

create or replace function public.phone_last9(p_phone text)
returns text
language sql
immutable
as $$
  select case
    when length(digits) >= 9 then right(digits, 9)
    else null
  end
  from (
    select regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as digits
  ) s;
$$;

drop function if exists public.track_orders_by_phone(text);

create or replace function public.track_orders_by_phone(p_phone text)
returns table (
  order_code text,
  network text,
  gb numeric,
  recipient_number text,
  amount_paid numeric,
  delivery_status text,
  payment_status text,
  payment_method text,
  pricing_tier text,
  validity text,
  source text,
  store_name text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  key text := public.phone_last9(p_phone);
begin
  if key is null then
    raise exception 'Enter a valid Ghana number';
  end if;

  return query
  select
    ord.order_code,
    ord.network,
    ord.gb::numeric,
    ord.recipient_number,
    ord.amount_paid::numeric,
    case
      when ord.delivery_status in ('delivered', 'completed') then 'completed'::text
      else 'processing'::text
    end,
    case
      when ord.payment_status = 'paid' then 'paid'::text
      else 'processing'::text
    end,
    coalesce(ord.payment_method, 'momo')::text,
    ord.pricing_tier::text,
    coalesce(pkg.validity, 'Non expiry')::text,
    case
      when ord.agent_store_id is not null then 'Agent store'::text
      when ord.pricing_tier = 'agent' then 'Agent wholesale'::text
      else 'Main website'::text
    end,
    store.name::text,
    ord.created_at,
    ord.updated_at
  from public.orders ord
  left join public.agent_stores store on store.id = ord.agent_store_id
  left join public.packages pkg on pkg.id = ord.package_id
  left join public.profiles buyer on buyer.id = ord.buyer_id
  where
    public.phone_last9(ord.recipient_number) = key
    or public.phone_last9(buyer.phone) = key
  order by ord.created_at desc
  limit 25;
end;
$$;

grant execute on function public.create_agent_api_key(text) to authenticated;
grant execute on function public.admin_create_user_api_key(uuid, text) to authenticated;
grant execute on function public.phone_last9(text) to anon, authenticated;
grant execute on function public.track_orders_by_phone(text) to anon, authenticated;

notify pgrst, 'reload schema';
