-- Admin API console: request log, issue/revoke keys, disable a user's API

alter table public.profiles
  add column if not exists api_disabled boolean not null default false;

create table if not exists public.agent_api_requests (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.profiles(id) on delete set null,
  key_id uuid references public.agent_api_keys(id) on delete set null,
  method text not null,
  path text not null,
  status_code int not null,
  ok boolean not null default false,
  error_message text,
  ip text,
  order_code text,
  duration_ms int,
  created_at timestamptz not null default now()
);

create index if not exists agent_api_requests_created_idx
  on public.agent_api_requests (created_at desc);

create index if not exists agent_api_requests_agent_idx
  on public.agent_api_requests (agent_id, created_at desc);

alter table public.agent_api_requests enable row level security;

drop policy if exists "api_requests_admin_read" on public.agent_api_requests;
create policy "api_requests_admin_read" on public.agent_api_requests
  for select using (public.is_admin());

grant select on public.agent_api_requests to authenticated;
grant select, insert on public.agent_api_requests to service_role;

create or replace function public.admin_api_console()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;

  return jsonb_build_object(
    'stats', jsonb_build_object(
      'active_keys', (select count(*) from public.agent_api_keys where revoked_at is null),
      'revoked_keys', (select count(*) from public.agent_api_keys where revoked_at is not null),
      'users_with_keys', (
        select count(distinct agent_id) from public.agent_api_keys where revoked_at is null
      ),
      'disabled_users', (
        select count(*) from public.profiles where api_disabled = true
      ),
      'requests_24h', (
        select count(*) from public.agent_api_requests
        where created_at > now() - interval '24 hours'
      ),
      'errors_24h', (
        select count(*) from public.agent_api_requests
        where created_at > now() - interval '24 hours' and ok = false
      ),
      'api_orders', (
        select count(*) from public.orders where payment_method = 'api'
      )
    ),
    'agents', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.full_name)
      from (
        select id, full_name, email, phone, role, api_disabled, blocked
        from public.profiles
        where role in ('agent', 'admin')
        order by full_name nulls last, email
      ) a
    ), '[]'::jsonb),
    'keys', coalesce((
      select jsonb_agg(to_jsonb(k) order by k.created_at desc)
      from (
        select
          keys.id,
          keys.agent_id,
          keys.name,
          keys.key_prefix,
          keys.last_used_at,
          keys.revoked_at,
          keys.created_at,
          pr.full_name,
          pr.email,
          pr.phone,
          pr.role,
          coalesce(pr.api_disabled, false) as api_disabled,
          coalesce(pr.blocked, false) as blocked
        from public.agent_api_keys keys
        left join public.profiles pr on pr.id = keys.agent_id
        order by keys.created_at desc
        limit 400
      ) k
    ), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at desc)
      from (
        select
          req.id,
          req.agent_id,
          req.key_id,
          req.method,
          req.path,
          req.status_code,
          req.ok,
          req.error_message,
          req.ip,
          req.order_code,
          req.duration_ms,
          req.created_at,
          pr.full_name,
          pr.email
        from public.agent_api_requests req
        left join public.profiles pr on pr.id = req.agent_id
        order by req.created_at desc
        limit 200
      ) r
    ), '[]'::jsonb)
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

create or replace function public.admin_revoke_api_key(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;
  update public.agent_api_keys
    set revoked_at = now()
    where id = p_id and revoked_at is null;
  if not found then
    raise exception 'API key not found or already revoked';
  end if;
  return true;
end;
$$;

create or replace function public.admin_set_api_disabled(p_user_id uuid, p_disabled boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;
  update public.profiles
    set api_disabled = coalesce(p_disabled, true)
    where id = p_user_id;
  if not found then
    raise exception 'User not found';
  end if;
  if coalesce(p_disabled, true) then
    update public.agent_api_keys
      set revoked_at = now()
      where agent_id = p_user_id and revoked_at is null;
  end if;
  return true;
end;
$$;

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

grant execute on function public.admin_api_console() to authenticated;
grant execute on function public.admin_create_user_api_key(uuid, text) to authenticated;
grant execute on function public.admin_revoke_api_key(uuid) to authenticated;
grant execute on function public.admin_set_api_disabled(uuid, boolean) to authenticated;
grant execute on function public.create_agent_api_key(text) to authenticated;

notify pgrst, 'reload schema';
