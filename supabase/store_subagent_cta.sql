-- Expose recruiting flag on public storefront JSON
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
  agent_parent uuid;
  recruiting boolean := false;
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

  select
    nullif(trim(p.phone), ''),
    coalesce(p.agent_activated, false),
    p.parent_agent_id,
    coalesce(p.subagents_enabled, false) and p.parent_agent_id is null
    into agent_phone, agent_verified, agent_parent, recruiting
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
    'subagents_enabled', recruiting,
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

grant execute on function public.get_public_store_by_slug(text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
