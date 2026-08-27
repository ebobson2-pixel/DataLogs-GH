-- Public order tracking: expose retry metadata and clearer messages after admin/provider retries.

drop function if exists public.track_status_message(text, text, text);
drop function if exists public.track_status_message(text, text, text, int, timestamptz);

create or replace function public.track_status_message(
  p_delivery text,
  p_payment text,
  p_fail_reason text,
  p_retry_count int default 0,
  p_last_retry_at timestamptz default null
)
returns text
language sql
immutable
as $$
  select case
    when p_delivery in ('delivered', 'completed') and coalesce(p_retry_count, 0) > 0 then
      'Your bundle was retried and has been sent to the network.'
    when p_delivery in ('delivered', 'completed') then
      'Data has been sent to the network for this number.'
    when p_delivery = 'processing' and coalesce(p_retry_count, 0) > 0 then
      'We retried your order. Waiting for the network to confirm delivery.'
    when p_delivery = 'failed' and coalesce(p_retry_count, 0) > 0 then
      'We retried delivery but it still failed. Contact support with your order code.'
    when p_delivery = 'failed' and p_fail_reason = 'low_balance' then
      'Delivery is delayed because the provider balance is low. We are retrying automatically.'
    when p_delivery = 'failed' then
      'We could not complete delivery. Try again or contact support with your order code.'
    when lower(coalesce(p_payment, '')) = 'paid' then
      'Payment confirmed. We are sending the bundle to the network now.'
    else
      'We are confirming your payment.'
  end;
$$;

drop function if exists public.track_orders_by_phone(text);

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

drop function if exists public.track_order_by_code(text);

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

grant execute on function public.track_status_message(text, text, text, int, timestamptz) to anon, authenticated;
grant execute on function public.track_orders_by_phone(text) to anon, authenticated;
grant execute on function public.track_order_by_code(text) to anon, authenticated;

notify pgrst, 'reload schema';
