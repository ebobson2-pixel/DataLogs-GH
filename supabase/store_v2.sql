-- Agent store v2: customization, catalog RPC, analytics, reviews

alter table public.agent_stores
  add column if not exists description text,
  add column if not exists logo_url text,
  add column if not exists banner_url text,
  add column if not exists promo_message text,
  add column if not exists location text,
  add column if not exists contact_email text,
  add column if not exists theme text not null default 'classic'
    check (theme in ('classic', 'premium', 'bold', 'minimal')),
  add column if not exists opening_hours jsonb not null default '{
    "mon": {"open": "08:00", "close": "20:00"},
    "tue": {"open": "08:00", "close": "20:00"},
    "wed": {"open": "08:00", "close": "20:00"},
    "thu": {"open": "08:00", "close": "20:00"},
    "fri": {"open": "08:00", "close": "20:00"},
    "sat": {"open": "08:00", "close": "20:00"},
    "sun": {"open": "12:00", "close": "20:00"}
  }'::jsonb,
  add column if not exists delivery_notes jsonb not null default '{
    "mtn": "Usually 30–40 minutes",
    "airteltigo": "Usually instant",
    "telecel": "Usually under 10 minutes"
  }'::jsonb,
  add column if not exists featured_package_ids uuid[] not null default '{}'::uuid[],
  add column if not exists view_count bigint not null default 0;

create table if not exists public.store_reviews (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.agent_stores(id) on delete cascade,
  order_id uuid not null unique references public.orders(id) on delete cascade,
  rating int not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now()
);

create index if not exists store_reviews_store_idx on public.store_reviews(store_id, created_at desc);

alter table public.store_reviews enable row level security;

drop policy if exists "store_reviews_public_read" on public.store_reviews;
create policy "store_reviews_public_read" on public.store_reviews
  for select using (
    exists (
      select 1 from public.agent_stores s
      where s.id = store_reviews.store_id and s.published = true
    )
  );

grant select on public.store_reviews to anon, authenticated;

create or replace function public.get_public_store_by_slug(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  store_rec public.agent_stores%rowtype;
  agent_phone text;
  agent_verified boolean;
  digits text;
  wa_digits text;
  tel_link text;
  wa_link text;
  review_avg numeric;
  review_count int;
  order_count bigint;
begin
  select * into store_rec
  from public.agent_stores
  where slug = lower(trim(p_slug))
    and published = true;

  if store_rec.id is null then
    return null;
  end if;

  select nullif(trim(p.phone), ''), coalesce(p.agent_activated, false)
    into agent_phone, agent_verified
  from public.profiles p
  where p.id = store_rec.agent_id;

  digits := regexp_replace(coalesce(agent_phone, ''), '\D', '', 'g');
  if length(digits) >= 9 then
    if digits ~ '^0[0-9]{9}$' then
      tel_link := 'tel:' || digits;
      wa_digits := '233' || substr(digits, 2);
    elsif digits ~ '^233[0-9]{9}$' then
      tel_link := 'tel:+' || digits;
      wa_digits := digits;
    else
      tel_link := 'tel:+' || digits;
      wa_digits := digits;
    end if;
    wa_link := 'https://wa.me/' || wa_digits
      || '?text=' || replace(replace(
        'Hi, I want to buy a data bundle from ' || store_rec.name || '.',
        ' ', '%20'), ',', '%2C');
  end if;

  select coalesce(avg(r.rating), 0), count(*)::int
    into review_avg, review_count
  from public.store_reviews r
  where r.store_id = store_rec.id;

  select count(*) into order_count
  from public.orders o
  where o.agent_store_id = store_rec.id
    and o.payment_status = 'paid';

  return jsonb_build_object(
    'id', store_rec.id,
    'agent_id', store_rec.agent_id,
    'name', store_rec.name,
    'slug', store_rec.slug,
    'tagline', store_rec.tagline,
    'description', store_rec.description,
    'logo_url', store_rec.logo_url,
    'banner_url', store_rec.banner_url,
    'promo_message', store_rec.promo_message,
    'location', store_rec.location,
    'contact_email', store_rec.contact_email,
    'accent_color', store_rec.accent_color,
    'theme', store_rec.theme,
    'networks', store_rec.networks,
    'published', store_rec.published,
    'opening_hours', store_rec.opening_hours,
    'delivery_notes', store_rec.delivery_notes,
    'featured_package_ids', store_rec.featured_package_ids,
    'view_count', store_rec.view_count,
    'verified_agent', agent_verified,
    'rating_avg', round(review_avg, 1),
    'rating_count', review_count,
    'order_count', order_count,
    'has_contact', tel_link is not null,
    'contact_tel', tel_link,
    'contact_wa', wa_link,
    'created_at', store_rec.created_at,
    'updated_at', store_rec.updated_at
  );
end;
$$;

create or replace function public.get_store_catalog(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  store_json jsonb;
  store_id uuid;
  agent_id uuid;
  networks text[];
  packages jsonb := '[]'::jsonb;
  best_sellers jsonb := '[]'::jsonb;
  reviews jsonb := '[]'::jsonb;
  pkg record;
  sell numeric;
  profit numeric;
  is_custom boolean;
begin
  store_json := public.get_public_store_by_slug(p_slug);
  if store_json is null then
    return null;
  end if;

  store_id := (store_json->>'id')::uuid;
  agent_id := (store_json->>'agent_id')::uuid;
  select coalesce(array_agg(n::text), array['mtn','airteltigo','telecel']::text[])
    into networks
  from jsonb_array_elements_text(coalesce(store_json->'networks', '[]'::jsonb)) as n;

  for pkg in
    select p.*
    from public.packages p
    where p.active = true
      and p.network = any(networks)
    order by p.sort_order asc, p.gb asc
  loop
    select r.sell_price, r.profit into sell, profit
    from public.resolve_agent_store_price(agent_id, pkg.id) r;
    if sell is null or sell <= 0 then
      continue;
    end if;
    select exists(
      select 1 from public.agent_store_prices asp
      where asp.agent_id = agent_id and asp.package_id = pkg.id
    ) into is_custom;
    packages := packages || jsonb_build_object(
      'id', pkg.id,
      'network', pkg.network,
      'gb', pkg.gb,
      'validity', coalesce(pkg.validity, 'Non expiry'),
      'sort_order', pkg.sort_order,
      'retail_price', pkg.retail_price,
      'price', sell,
      'profit', profit,
      'custom_priced', is_custom
    );
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'package_id', x.package_id,
    'order_count', x.cnt
  ) order by x.cnt desc), '[]'::jsonb)
  into best_sellers
  from (
    select o.package_id, count(*)::bigint as cnt
    from public.orders o
    where o.agent_store_id = store_id
      and o.payment_status = 'paid'
      and o.created_at >= now() - interval '30 days'
    group by o.package_id
    order by cnt desc
    limit 8
  ) x;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb)
  into reviews
  from (
    select id, rating, comment, created_at
    from public.store_reviews
    where store_id = store_id
    order by created_at desc
    limit 12
  ) r;

  return jsonb_build_object(
    'store', store_json,
    'packages', packages,
    'best_sellers', best_sellers,
    'reviews', reviews
  );
end;
$$;

create or replace function public.record_store_view(p_slug text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.agent_stores
  set view_count = view_count + 1
  where slug = lower(trim(p_slug))
    and published = true;
end;
$$;

create or replace function public.get_agent_store_analytics(p_agent_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  aid uuid := coalesce(p_agent_id, auth.uid());
  sid uuid;
  views bigint;
  orders bigint;
  sales numeric;
  profit numeric;
  views_7d bigint;
begin
  if aid is null or (aid <> auth.uid() and not public.is_admin()) then
    raise exception 'Not authorized';
  end if;

  select s.id, s.view_count into sid, views
  from public.agent_stores s
  where s.agent_id = aid;

  if sid is null then
    return jsonb_build_object('ok', false, 'message', 'No store');
  end if;

  select count(*), coalesce(sum(amount_paid), 0)
    into orders, sales
  from public.orders o
  where o.agent_store_id = sid
    and o.payment_status = 'paid'
    and o.pricing_tier = 'retail';

  select coalesce(sum(wt.amount), 0) into profit
  from public.wallet_transactions wt
  where wt.agent_id = aid
    and wt.type = 'credit'
    and wt.description ilike '%store%';

  return jsonb_build_object(
    'ok', true,
    'store_id', sid,
    'views', coalesce(views, 0),
    'orders', orders,
    'sales', sales,
    'profit', profit
  );
end;
$$;

grant execute on function public.get_store_catalog(text) to anon, authenticated;
grant execute on function public.record_store_view(text) to anon, authenticated;
grant execute on function public.get_agent_store_analytics(uuid) to authenticated;

notify pgrst, 'reload schema';
