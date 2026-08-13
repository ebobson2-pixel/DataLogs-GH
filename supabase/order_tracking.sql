-- Public order tracking by recipient phone number

create or replace function public.normalize_gh_phone(p_phone text)
returns text
language plpgsql
immutable
as $$
declare
  digits text;
  local text;
begin
  digits := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  local := digits;
  if local like '233%' and length(local) = 12 then
    local := '0' || substr(local, 4);
  elsif length(local) = 9 then
    local := '0' || local;
  end if;
  if local !~ '^0\d{9}$' then
    return null;
  end if;
  return substr(local, 1, 3) || ' ' || substr(local, 4, 3) || ' ' || substr(local, 7, 4);
end;
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
  pretty text := public.normalize_gh_phone(p_phone);
  digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  if pretty is null and length(digits) < 9 then
    raise exception 'Enter a valid Ghana number';
  end if;

  return query
  select
    o.order_code,
    o.network,
    o.gb,
    o.recipient_number,
    o.amount_paid,
    o.delivery_status,
    o.payment_status,
    case
      when o.agent_store_id is not null then coalesce('Agent store · ' || s.name, 'Agent store')
      when o.pricing_tier = 'agent' then 'Agent wholesale'
      else 'Main website'
    end as source,
    o.created_at
  from public.orders o
  left join public.agent_stores s on s.id = o.agent_store_id
  where
    regexp_replace(o.recipient_number, '\D', '', 'g') = regexp_replace(coalesce(pretty, p_phone), '\D', '', 'g')
    or (
      length(digits) >= 9
      and regexp_replace(o.recipient_number, '\D', '', 'g') like '%' || right(digits, 9)
    )
  order by o.created_at desc
  limit 25;
end;
$$;

grant execute on function public.normalize_gh_phone(text) to anon, authenticated;
grant execute on function public.track_orders_by_phone(text) to anon, authenticated;
