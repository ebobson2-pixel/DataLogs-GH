-- Public order tracking by recipient (or buyer) phone number.
-- Public callers only receive completed / processing — never failed.

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

create or replace function public.track_orders_by_phone(p_phone text)
returns table (
  order_code text,
  network text,
  gb numeric,
  recipient_number text,
  amount_paid numeric,
  delivery_status text,
  payment_status text,
  source text,
  created_at timestamptz
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
      when ord.delivery_status = 'delivered' then 'completed'::text
      else 'processing'::text
    end,
    case
      when ord.payment_status = 'paid' then 'paid'::text
      else 'processing'::text
    end,
    case
      when ord.agent_store_id is not null then coalesce('Agent store · ' || store.name, 'Agent store')
      when ord.pricing_tier = 'agent' then 'Agent wholesale'
      else 'Main website'
    end,
    ord.created_at
  from public.orders ord
  left join public.agent_stores store on store.id = ord.agent_store_id
  left join public.profiles buyer on buyer.id = ord.buyer_id
  where
    public.phone_last9(ord.recipient_number) = key
    or public.phone_last9(buyer.phone) = key
  order by ord.created_at desc
  limit 25;
end;
$$;

grant execute on function public.phone_last9(text) to anon, authenticated;
grant execute on function public.track_orders_by_phone(text) to anon, authenticated;
