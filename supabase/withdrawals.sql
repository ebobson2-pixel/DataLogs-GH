-- Withdrawals: request stays pending until admin approves (then wallet is debited).
-- Admin can set the minimum withdrawal threshold in site_settings.

alter table public.site_settings
  add column if not exists withdrawal_threshold numeric(12,2) not null default 13
    check (withdrawal_threshold >= 0);

alter table public.withdrawals
  add column if not exists network text;

alter table public.withdrawals
  add column if not exists debited boolean not null default false;

-- Existing pending rows were deducted under the old request flow.
update public.withdrawals
set debited = true
where status = 'pending' and debited = false and network is null;

drop function if exists public.request_withdrawal(numeric, text, text, text);
drop function if exists public.request_withdrawal(numeric, text, text, text, text);

create or replace function public.request_withdrawal(
  p_amount numeric,
  p_momo_number text,
  p_account_name text,
  p_network text,
  p_method text default 'momo'
)
returns public.withdrawals
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets%rowtype;
  wd public.withdrawals%rowtype;
  threshold numeric(12,2);
  network_id text;
begin
  if auth.uid() is null or not public.is_agent() then
    raise exception 'Only agents can withdraw';
  end if;
  if exists (select 1 from public.profiles p where p.id = auth.uid() and coalesce(p.blocked, false)) then
    raise exception 'This account is blocked';
  end if;

  select coalesce(withdrawal_threshold, 13) into threshold from public.site_settings where id = 1;
  if threshold is null then
    threshold := 10;
  end if;

  if p_amount is null or p_amount < threshold then
    raise exception 'Minimum withdrawal is GH₵ %', threshold;
  end if;
  if coalesce(trim(p_momo_number), '') = '' then
    raise exception 'Enter a MoMo number';
  end if;
  if coalesce(trim(p_account_name), '') = '' then
    raise exception 'Enter the name on the MoMo number';
  end if;

  network_id := lower(trim(coalesce(p_network, '')));
  if network_id not in ('mtn', 'telecel', 'airteltigo') then
    raise exception 'Choose MTN, Telecel or AirtelTigo';
  end if;

  w := public.ensure_wallet(auth.uid());
  if w.balance < p_amount then
    raise exception 'Insufficient wallet balance';
  end if;

  if exists (
    select 1 from public.withdrawals wd2
    where wd2.agent_id = auth.uid() and wd2.status = 'pending'
  ) then
    raise exception 'You already have a pending withdrawal. Wait for admin review.';
  end if;

  insert into public.withdrawals (
    agent_id, amount, method, network, momo_number, account_name, status, debited
  ) values (
    auth.uid(),
    p_amount,
    coalesce(nullif(trim(p_method), ''), 'momo'),
    network_id,
    trim(p_momo_number),
    trim(p_account_name),
    'pending',
    false
  )
  returning * into wd;

  return wd;
end;
$$;

create or replace function public.review_withdrawal(
  p_withdrawal_id uuid,
  p_decision text,
  p_note text default null
)
returns public.withdrawals
language plpgsql
security definer
set search_path = public
as $$
declare
  wd public.withdrawals%rowtype;
  w public.wallets%rowtype;
  decision text := lower(trim(coalesce(p_decision, '')));
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;
  if decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected';
  end if;

  select * into wd from public.withdrawals where id = p_withdrawal_id for update;
  if not found then
    raise exception 'Withdrawal not found';
  end if;
  if wd.status <> 'pending' then
    raise exception 'This withdrawal was already reviewed';
  end if;

  if decision = 'approved' then
    if not coalesce(wd.debited, false) then
      w := public.ensure_wallet(wd.agent_id);
      update public.wallets
        set balance = balance - wd.amount
        where agent_id = wd.agent_id and balance >= wd.amount
        returning * into w;
      if not found then
        raise exception 'Agent no longer has enough wallet balance';
      end if;
      insert into public.wallet_transactions (agent_id, type, amount, balance_after, reference, description)
      values (
        wd.agent_id,
        'debit',
        wd.amount,
        w.balance,
        wd.id::text,
        'Withdrawal approved · ' || wd.momo_number
      );
      wd.debited := true;
    end if;
  elsif coalesce(wd.debited, false) then
    -- Old pending rows that already held funds: put money back on decline.
    w := public.ensure_wallet(wd.agent_id);
    update public.wallets
      set balance = balance + wd.amount
      where agent_id = wd.agent_id
      returning * into w;
    insert into public.wallet_transactions (agent_id, type, amount, balance_after, reference, description)
    values (
      wd.agent_id,
      'credit',
      wd.amount,
      w.balance,
      wd.id::text,
      'Withdrawal declined · funds returned'
    );
    wd.debited := false;
  end if;

  update public.withdrawals
    set status = decision,
        debited = wd.debited,
        note = nullif(trim(coalesce(p_note, '')), ''),
        updated_at = now()
    where id = wd.id
    returning * into wd;

  return wd;
end;
$$;

create or replace function public.update_site_settings(
  p_whatsapp_channel_url text,
  p_support_contact text,
  p_support_label text default 'Support',
  p_withdrawal_threshold numeric default null
)
returns public.site_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  row_out public.site_settings%rowtype;
  threshold numeric(12,2);
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;

  select coalesce(withdrawal_threshold, 13) into threshold from public.site_settings where id = 1;
  if p_withdrawal_threshold is not null then
    if p_withdrawal_threshold < 0 then
      raise exception 'Withdrawal threshold cannot be negative';
    end if;
    threshold := p_withdrawal_threshold;
  end if;
  if threshold is null then
    threshold := 10;
  end if;

  insert into public.site_settings (
    id, whatsapp_channel_url, support_contact, support_label, withdrawal_threshold, updated_by
  ) values (
    1,
    nullif(trim(p_whatsapp_channel_url), ''),
    nullif(trim(p_support_contact), ''),
    coalesce(nullif(trim(p_support_label), ''), 'Support'),
    threshold,
    auth.uid()
  )
  on conflict (id) do update set
    whatsapp_channel_url = excluded.whatsapp_channel_url,
    support_contact = excluded.support_contact,
    support_label = excluded.support_label,
    withdrawal_threshold = excluded.withdrawal_threshold,
    updated_by = excluded.updated_by,
    updated_at = now()
  returning * into row_out;
  return row_out;
end;
$$;

drop function if exists public.update_site_settings(text, text, text);

grant execute on function public.request_withdrawal(numeric, text, text, text, text) to authenticated;
grant execute on function public.review_withdrawal(uuid, text, text) to authenticated;
grant execute on function public.update_site_settings(text, text, text, numeric) to authenticated;

notify pgrst, 'reload schema';
