-- Reset platform earnings tracking (does not delete orders or payments)

create or replace function public.reset_platform_revenue()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cleared int;
  orders_reset int;
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;

  delete from public.platform_ledger;
  get diagnostics cleared = row_count;

  update public.orders set platform_margin = 0 where coalesce(platform_margin, 0) <> 0;
  get diagnostics orders_reset = row_count;

  return jsonb_build_object(
    'ok', true,
    'ledger_rows_cleared', cleared,
    'orders_reset', orders_reset
  );
end;
$$;

grant execute on function public.reset_platform_revenue() to authenticated;

delete from public.platform_ledger;

update public.orders
  set platform_margin = 0
  where coalesce(platform_margin, 0) <> 0;

notify pgrst, 'reload schema';
