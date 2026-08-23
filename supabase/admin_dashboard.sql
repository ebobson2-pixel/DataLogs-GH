-- One-shot admin dashboard payload (avoids nested PostgREST embeds / RLS stalls)

create or replace function public.admin_dashboard_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  payload jsonb;
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;

  select jsonb_build_object(
    'users', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.created_at desc)
      from public.profiles p
    ), '[]'::jsonb),
    'packages', coalesce((
      select jsonb_agg(to_jsonb(pkg) order by pkg.sort_order asc, pkg.created_at asc)
      from public.packages pkg
    ), '[]'::jsonb),
    'orders', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at desc)
      from (
        select
          o.*,
          jsonb_build_object(
            'full_name', pr.full_name,
            'email', pr.email,
            'phone', pr.phone
          ) as profiles,
          case
            when st.id is null then null
            else jsonb_build_object('name', st.name, 'slug', st.slug)
          end as agent_stores
        from public.orders o
        left join public.profiles pr on pr.id = o.buyer_id
        left join public.agent_stores st on st.id = o.agent_store_id
        order by o.created_at desc
        limit 400
      ) x
    ), '[]'::jsonb),
    'stores', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.updated_at desc)
      from (
        select
          s.*,
          jsonb_build_object(
            'full_name', pr.full_name,
            'email', pr.email,
            'phone', pr.phone
          ) as profiles
        from public.agent_stores s
        left join public.profiles pr on pr.id = s.agent_id
      ) x
    ), '[]'::jsonb)
  ) into payload;

  return payload;
end;
$$;

grant execute on function public.admin_dashboard_data() to authenticated;

notify pgrst, 'reload schema';
