-- Hard-stop package sales: block every order insert path when packages_available is off.
-- Keeps Paystack/wallet/API from creating paid orders while sales are disabled.

create or replace function public.assert_packages_available()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not coalesce((select packages_available from public.site_settings where id = 1 limit 1), true) then
    raise exception 'Packages unavailable';
  end if;
end;
$$;

create or replace function public.trg_orders_assert_packages_available()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_packages_available();
  return new;
end;
$$;

drop trigger if exists orders_assert_packages_available_bi on public.orders;
create trigger orders_assert_packages_available_bi
  before insert on public.orders
  for each row
  execute function public.trg_orders_assert_packages_available();

grant execute on function public.assert_packages_available() to anon, authenticated, service_role;
