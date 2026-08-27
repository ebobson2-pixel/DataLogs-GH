-- Accept order codes with/without DL- and with spaces/punctuation

create or replace function public.normalize_order_code(p_code text)
returns text
language plpgsql
immutable
as $$
declare
  code text := upper(regexp_replace(trim(coalesce(p_code, '')), '[^A-Z0-9]', '', 'g'));
begin
  if code = '' then
    return null;
  end if;
  if code ~ '^[0-9A-F]{8}$' then
    return 'DL-' || code;
  end if;
  if code ~ '^DL[0-9A-F]{8}$' then
    return 'DL-' || substr(code, 3);
  end if;
  if code like 'DL%' and length(code) > 2 then
    return 'DL-' || substr(code, 3);
  end if;
  return code;
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

grant execute on function public.normalize_order_code(text) to anon, authenticated;
grant execute on function public.track_order_by_code(text) to anon, authenticated;

notify pgrst, 'reload schema';
