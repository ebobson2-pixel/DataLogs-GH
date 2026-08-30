-- Global packages kill switch + helper for order RPCs.

alter table public.site_settings
  add column if not exists packages_available boolean not null default true;

update public.site_settings
set packages_available = true
where id = 1 and packages_available is null;

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

drop function if exists public.update_site_settings(text, text, text, numeric, boolean, numeric);

create or replace function public.update_site_settings(
  p_whatsapp_channel_url text,
  p_support_contact text,
  p_support_label text default 'Support',
  p_withdrawal_threshold numeric default null,
  p_agent_activation_fee_enabled boolean default null,
  p_agent_activation_fee numeric default null,
  p_packages_available boolean default null
)
returns public.site_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  row_out public.site_settings%rowtype;
  threshold numeric(12,2);
  fee_enabled boolean;
  fee_amount numeric(12,2);
  packages_available boolean;
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;

  select
    coalesce(withdrawal_threshold, 10),
    coalesce(agent_activation_fee_enabled, false),
    coalesce(agent_activation_fee, 0),
    coalesce(ss.packages_available, true)
  into threshold, fee_enabled, fee_amount, packages_available
  from public.site_settings ss
  where ss.id = 1;

  if p_withdrawal_threshold is not null then
    if p_withdrawal_threshold < 0 then
      raise exception 'Withdrawal threshold cannot be negative';
    end if;
    threshold := p_withdrawal_threshold;
  end if;
  if threshold is null then
    threshold := 10;
  end if;

  if p_agent_activation_fee_enabled is not null then
    fee_enabled := p_agent_activation_fee_enabled;
  end if;
  if p_agent_activation_fee is not null then
    if p_agent_activation_fee < 0 then
      raise exception 'Activation fee cannot be negative';
    end if;
    fee_amount := p_agent_activation_fee;
  end if;
  if fee_amount is null then
    fee_amount := 0;
  end if;
  if fee_enabled and fee_amount <= 0 then
    raise exception 'Set an activation fee greater than 0, or turn the fee off';
  end if;

  if p_packages_available is not null then
    packages_available := p_packages_available;
  end if;

  insert into public.site_settings (
    id, whatsapp_channel_url, support_contact, support_label,
    withdrawal_threshold, agent_activation_fee_enabled, agent_activation_fee,
    packages_available, updated_by
  ) values (
    1,
    nullif(trim(p_whatsapp_channel_url), ''),
    nullif(trim(p_support_contact), ''),
    coalesce(nullif(trim(p_support_label), ''), 'Support'),
    threshold,
    fee_enabled,
    fee_amount,
    packages_available,
    auth.uid()
  )
  on conflict (id) do update set
    whatsapp_channel_url = excluded.whatsapp_channel_url,
    support_contact = excluded.support_contact,
    support_label = excluded.support_label,
    withdrawal_threshold = excluded.withdrawal_threshold,
    agent_activation_fee_enabled = excluded.agent_activation_fee_enabled,
    agent_activation_fee = excluded.agent_activation_fee,
    packages_available = excluded.packages_available,
    updated_by = excluded.updated_by,
    updated_at = now()
  returning * into row_out;

  if not coalesce(row_out.agent_activation_fee_enabled, false)
     or coalesce(row_out.agent_activation_fee, 0) <= 0 then
    update public.profiles
      set agent_activated = true
      where role = 'agent' and coalesce(agent_activated, false) = false;
  end if;

  return row_out;
end;
$$;

grant execute on function public.assert_packages_available() to anon, authenticated, service_role;
grant execute on function public.update_site_settings(text, text, text, numeric, boolean, numeric, boolean) to authenticated;

notify pgrst, 'reload schema';
