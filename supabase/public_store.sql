-- Public store lookup: agent phone/name stay server-side; clients get contact links only.
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
  digits text;
  wa_digits text;
  tel_link text;
  wa_link text;
begin
  select * into store_rec
  from public.agent_stores
  where slug = lower(trim(p_slug))
    and published = true;

  if store_rec.id is null then
    return null;
  end if;

  select nullif(trim(p.phone), '') into agent_phone
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
      || '?text=Hi%2C%20I%20want%20to%20buy%20a%20data%20bundle%20from%20your%20store.';
  end if;

  return jsonb_build_object(
    'id', store_rec.id,
    'agent_id', store_rec.agent_id,
    'name', store_rec.name,
    'slug', store_rec.slug,
    'tagline', store_rec.tagline,
    'accent_color', store_rec.accent_color,
    'networks', store_rec.networks,
    'published', store_rec.published,
    'created_at', store_rec.created_at,
    'updated_at', store_rec.updated_at,
    'has_contact', tel_link is not null,
    'contact_tel', tel_link,
    'contact_wa', wa_link
  );
end;
$$;

revoke all on function public.get_public_store_by_slug(text) from public;
grant execute on function public.get_public_store_by_slug(text) to anon, authenticated;
