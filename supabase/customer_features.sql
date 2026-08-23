-- Customer UX: order-code tracking, richer status, trending bundles.

drop function if exists public.track_orders_by_phone(text);
drop function if exists public.track_order_by_code(text);
drop function if exists public.trending_packages(int);

create or replace function public.track_status_public(
  p_delivery text,
  p_payment text,
  p_fail_reason text
)
returns text
language sql
immutable
as $$
  select case
    when p_delivery in ('delivered', 'completed') then 'completed'
    when p_delivery = 'failed' then 'failed'
    when lower(coalesce(p_payment, '')) = 'paid' then 'processing'
    else 'pending'
  end;
$$;

create or replace function public.track_status_message(
  p_delivery text,
  p_payment text,
  p_fail_reason text
)
returns text
language sql
immutable
as $$
  select case
    when p_delivery in ('delivered', 'completed') then
      'Data has been sent to the network for this number.'
    when p_delivery = 'failed' and p_fail_reason = 'low_balance' then
      'Delivery is delayed because the provider balance is low. We retry automatically.'
    when p_delivery = 'failed' then
      'We could not complete delivery. Try again or contact support with your order code.'
    when lower(coalesce(p_payment, '')) = 'paid' then
      'Payment confirmed. We are sending the bundle to the network now.'
    else
      'We are confirming your payment.'
  end;
$$;

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
    public.track_status_message(ord.delivery_status, ord.payment_status, ord.fail_reason),
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
  agent_store_id uuid,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  code text := upper(trim(coalesce(p_code, '')));
begin
  if code = '' or length(code) < 4 then
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
    public.track_status_message(ord.delivery_status, ord.payment_status, ord.fail_reason),
    ord.agent_store_id,
    ord.created_at,
    ord.updated_at
  from public.orders ord
  left join public.agent_stores store on store.id = ord.agent_store_id
  left join public.packages pkg on pkg.id = ord.package_id
  where upper(ord.order_code) = code
  limit 1;
end;
$$;

create or replace function public.trending_packages(p_limit int default 6)
returns table (
  package_id uuid,
  network text,
  gb numeric,
  retail_price numeric,
  validity text,
  order_count bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    pkg.id,
    pkg.network,
    pkg.gb::numeric,
    pkg.retail_price::numeric,
    coalesce(pkg.validity, 'Non expiry'),
    count(ord.id)::bigint as order_count
  from public.orders ord
  join public.packages pkg on pkg.id = ord.package_id
  where ord.payment_status = 'paid'
    and ord.created_at >= now() - interval '7 days'
    and pkg.active = true
  group by pkg.id, pkg.network, pkg.gb, pkg.retail_price, pkg.validity
  order by order_count desc, pkg.sort_order asc, pkg.gb asc
  limit greatest(1, least(coalesce(p_limit, 6), 12));
$$;

grant execute on function public.track_orders_by_phone(text) to anon, authenticated;
grant execute on function public.track_order_by_code(text) to anon, authenticated;
grant execute on function public.trending_packages(int) to anon, authenticated;

notify pgrst, 'reload schema';
