-- Richer public order tracking details (still masks failed delivery).

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

grant execute on function public.track_orders_by_phone(text) to anon, authenticated;

notify pgrst, 'reload schema';
