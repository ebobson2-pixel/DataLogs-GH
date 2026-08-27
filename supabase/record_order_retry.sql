-- Let admins record a manual provider resend so customers can track the retry.

create or replace function public.admin_record_order_retry(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ord public.orders%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;

  update public.orders
  set
    delivery_status = 'processing',
    fail_reason = null,
    retryable = false,
    provider_error = null,
    retry_count = coalesce(retry_count, 0) + 1,
    last_retry_at = now(),
    updated_at = now()
  where id = p_order_id
    and payment_status = 'paid'
    and delivery_status = 'failed'
  returning * into ord;

  if ord.id is null then
    raise exception 'Only failed paid orders can be marked as retried';
  end if;

  return jsonb_build_object(
    'ok', true,
    'order_code', ord.order_code,
    'retry_count', ord.retry_count,
    'last_retry_at', ord.last_retry_at
  );
end;
$$;

grant execute on function public.admin_record_order_retry(uuid) to authenticated;

drop function if exists public.track_orders_by_phone(text);
drop function if exists public.track_order_by_code(text);

create or replace function public.track_orders_by_phone(p_phone text)
returns table (
  order_code text,
  package_id uuid,
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
  status_message text,
  retry_count int,
  last_retry_at timestamptz,
  retry_pending boolean,
  is_retried boolean,
  agent_store_id uuid,
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
    ord.package_id,
    ord.network,
    ord.gb::numeric,
    ord.recipient_number,
    ord.amount_paid::numeric,
    public.track_status_public(ord.delivery_status, ord.payment_status, ord.fail_reason),
    case when ord.payment_status = 'paid' then 'paid'::text else 'processing'::text end,
    coalesce(ord.payment_method, 'momo')::text,
    ord.pricing_tier::text,
    coalesce(pkg.validity, 'Non expiry')::text,
    case
      when ord.agent_store_id is not null then 'Agent store'::text
      when ord.pricing_tier = 'agent' then 'Agent wholesale'::text
      else 'Main website'::text
    end,
    store.name::text,
    public.track_status_message(
      ord.delivery_status,
      ord.payment_status,
      ord.fail_reason,
      coalesce(ord.retry_count, 0),
      ord.last_retry_at
    ),
    coalesce(ord.retry_count, 0)::int,
    ord.last_retry_at,
    (
      coalesce(ord.retryable, false)
      and ord.delivery_status = 'failed'
      and ord.fail_reason = 'low_balance'
    )::boolean,
    (
      coalesce(ord.retry_count, 0) > 0
      or ord.last_retry_at is not null
    )::boolean,
    ord.agent_store_id,
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

create or replace function public.track_order_by_code(p_code text)
returns table (
  order_code text,
  package_id uuid,
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
  status_message text,
  retry_count int,
  last_retry_at timestamptz,
  retry_pending boolean,
  is_retried boolean,
  agent_store_id uuid,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  code text := public.normalize_order_code(p_code);
begin
  if code is null or length(code) < 4 then
    raise exception 'Enter a valid order code like DL-ABC12345';
  end if;

  return query
  select
    ord.order_code,
    ord.package_id,
    ord.network,
    ord.gb::numeric,
    ord.recipient_number,
    ord.amount_paid::numeric,
    public.track_status_public(ord.delivery_status, ord.payment_status, ord.fail_reason),
    case when ord.payment_status = 'paid' then 'paid'::text else 'processing'::text end,
    coalesce(ord.payment_method, 'momo')::text,
    ord.pricing_tier::text,
    coalesce(pkg.validity, 'Non expiry')::text,
    case
      when ord.agent_store_id is not null then 'Agent store'::text
      when ord.pricing_tier = 'agent' then 'Agent wholesale'::text
      else 'Main website'::text
    end,
    store.name::text,
    public.track_status_message(
      ord.delivery_status,
      ord.payment_status,
      ord.fail_reason,
      coalesce(ord.retry_count, 0),
      ord.last_retry_at
    ),
    coalesce(ord.retry_count, 0)::int,
    ord.last_retry_at,
    (
      coalesce(ord.retryable, false)
      and ord.delivery_status = 'failed'
      and ord.fail_reason = 'low_balance'
    )::boolean,
    (
      coalesce(ord.retry_count, 0) > 0
      or ord.last_retry_at is not null
    )::boolean,
    ord.agent_store_id,
    ord.created_at,
    ord.updated_at
  from public.orders ord
  left join public.agent_stores store on store.id = ord.agent_store_id
  left join public.packages pkg on pkg.id = ord.package_id
  where upper(ord.order_code) = code
     or public.normalize_order_code(ord.order_code) = code
  limit 1;
end;
$$;

grant execute on function public.track_orders_by_phone(text) to anon, authenticated;
grant execute on function public.track_order_by_code(text) to anon, authenticated;

notify pgrst, 'reload schema';
