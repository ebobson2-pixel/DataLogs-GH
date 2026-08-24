-- Smart Notification System for DataLogs GH
-- Personal in-app notifications + preferences + platform announcements.
-- Hooked to orders, payments, wallet, refunds, and withdrawals via triggers.

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  category text not null check (category in (
    'order', 'payment', 'wallet', 'refund', 'dispute', 'security', 'system', 'promotion'
  )),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'important', 'urgent')),
  title text not null,
  body text not null,
  entity_type text,
  entity_id uuid,
  action_url text,
  dedupe_key text,
  meta jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists notifications_user_dedupe_uidx
  on public.notifications (user_id, dedupe_key)
  where dedupe_key is not null;

create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc)
  where archived_at is null;

create index if not exists notifications_user_unread_idx
  on public.notifications (user_id, created_at desc)
  where read_at is null and archived_at is null;

create table if not exists public.notification_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  order_updates boolean not null default true,
  payment_updates boolean not null default true,
  wallet_activity boolean not null default true,
  refund_updates boolean not null default true,
  dispute_updates boolean not null default true,
  promotional boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.platform_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  audience text not null default 'all' check (audience in ('all', 'agents', 'customers', 'admins')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'important', 'urgent')),
  action_url text,
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.announcement_reads (
  announcement_id uuid not null references public.platform_announcements(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (announcement_id, user_id)
);

alter table public.notifications enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.platform_announcements enable row level security;
alter table public.announcement_reads enable row level security;

drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own" on public.notifications
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists "notifications_update_own" on public.notifications;
create policy "notifications_update_own" on public.notifications
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "notif_prefs_own" on public.notification_preferences;
create policy "notif_prefs_own" on public.notification_preferences
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "announcements_select_active" on public.platform_announcements;
create policy "announcements_select_active" on public.platform_announcements
  for select using (active = true or public.is_admin());

drop policy if exists "announcement_reads_own" on public.announcement_reads;
create policy "announcement_reads_own" on public.announcement_reads
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, update on public.notifications to authenticated;
grant select, insert, update on public.notification_preferences to authenticated;
grant select on public.platform_announcements to authenticated;
grant select, insert, update on public.announcement_reads to authenticated;

create or replace function public.mask_phone(p_phone text)
returns text
language plpgsql
immutable
as $$
declare
  digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  if length(digits) < 6 then
    return coalesce(nullif(trim(p_phone), ''), '••••');
  end if;
  if length(digits) >= 10 then
    return substr(digits, 1, 3) || ' XXX ' || substr(digits, length(digits) - 3, 4);
  end if;
  return substr(digits, 1, 2) || '••' || substr(digits, length(digits) - 1, 2);
end;
$$;

create or replace function public.ensure_notification_preferences(p_user_id uuid)
returns public.notification_preferences
language plpgsql
security definer
set search_path = public
as $$
declare
  prefs public.notification_preferences%rowtype;
begin
  insert into public.notification_preferences (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;
  select * into prefs from public.notification_preferences where user_id = p_user_id;
  return prefs;
end;
$$;

create or replace function public.category_allowed(p_user_id uuid, p_category text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  prefs public.notification_preferences%rowtype;
begin
  if p_category in ('security', 'system') then
    return true;
  end if;
  prefs := public.ensure_notification_preferences(p_user_id);
  return case p_category
    when 'order' then prefs.order_updates
    when 'payment' then prefs.payment_updates
    when 'wallet' then prefs.wallet_activity
    when 'refund' then prefs.refund_updates
    when 'dispute' then prefs.dispute_updates
    when 'promotion' then prefs.promotional
    else true
  end;
end;
$$;

create or replace function public.notify_user(
  p_user_id uuid,
  p_category text,
  p_title text,
  p_body text,
  p_priority text default 'normal',
  p_entity_type text default null,
  p_entity_id uuid default null,
  p_action_url text default null,
  p_dedupe_key text default null,
  p_meta jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  nid uuid;
begin
  if p_user_id is null or coalesce(trim(p_title), '') = '' then
    return null;
  end if;
  if not public.category_allowed(p_user_id, p_category) then
    return null;
  end if;

  if p_dedupe_key is not null and length(trim(p_dedupe_key)) > 0 then
    update public.notifications
      set
        title = left(trim(p_title), 140),
        body = left(trim(p_body), 500),
        priority = coalesce(nullif(p_priority, ''), priority),
        action_url = coalesce(p_action_url, action_url),
        meta = coalesce(p_meta, meta),
        archived_at = null
      where user_id = p_user_id and dedupe_key = p_dedupe_key
      returning id into nid;
    if nid is not null then
      return nid;
    end if;
  end if;

  begin
    insert into public.notifications (
      user_id, category, priority, title, body, entity_type, entity_id, action_url, dedupe_key, meta
    ) values (
      p_user_id,
      p_category,
      coalesce(nullif(p_priority, ''), 'normal'),
      left(trim(p_title), 140),
      left(trim(p_body), 500),
      p_entity_type,
      p_entity_id,
      p_action_url,
      nullif(trim(p_dedupe_key), ''),
      coalesce(p_meta, '{}'::jsonb)
    )
    returning id into nid;
  exception
    when unique_violation then
      select id into nid
      from public.notifications
      where user_id = p_user_id and dedupe_key = nullif(trim(p_dedupe_key), '')
      limit 1;
  end;

  return nid;
end;
$$;

revoke execute on function public.notify_user(uuid, text, text, text, text, text, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.notify_user(uuid, text, text, text, text, text, uuid, text, text, jsonb) to service_role;

-- Fallback grant for security definer callers from other RPCs/triggers
grant execute on function public.notify_user(uuid, text, text, text, text, text, uuid, text, text, jsonb) to postgres;

create or replace function public.list_my_notifications(
  p_limit int default 30,
  p_offset int default 0,
  p_category text default null,
  p_unread_only boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  role text;
  items jsonb := '[]'::jsonb;
  unread int := 0;
begin
  if uid is null then
    raise exception 'Sign in required';
  end if;

  select p.role into role from public.profiles p where p.id = uid;

  select count(*)::int into unread
  from public.notifications n
  where n.user_id = uid and n.read_at is null and n.archived_at is null;

  select coalesce(unread, 0) + count(*)::int into unread
  from public.platform_announcements a
  where a.active = true
    and (a.audience = 'all' or a.audience = role || 's' or (role = 'admin' and a.audience = 'admins') or (role = 'agent' and a.audience = 'agents') or (role = 'customer' and a.audience = 'customers'))
    and not exists (
      select 1 from public.announcement_reads r
      where r.announcement_id = a.id and r.user_id = uid
    );

  with personal as (
    select
      n.id,
      'personal'::text as source,
      n.category,
      n.priority,
      n.title,
      n.body,
      n.entity_type,
      n.entity_id,
      n.action_url,
      n.meta,
      n.read_at,
      n.created_at,
      (n.read_at is null) as unread
    from public.notifications n
    where n.user_id = uid
      and n.archived_at is null
      and (p_category is null or n.category = p_category)
      and (not p_unread_only or n.read_at is null)
  ),
  announcements as (
    select
      a.id,
      'announcement'::text as source,
      'system'::text as category,
      a.priority,
      a.title,
      a.body,
      null::text as entity_type,
      null::uuid as entity_id,
      a.action_url,
      '{}'::jsonb as meta,
      r.read_at,
      a.created_at,
      (r.read_at is null) as unread
    from public.platform_announcements a
    left join public.announcement_reads r
      on r.announcement_id = a.id and r.user_id = uid
    where a.active = true
      and (
        a.audience = 'all'
        or (role = 'agent' and a.audience = 'agents')
        or (role = 'customer' and a.audience = 'customers')
        or (role = 'admin' and a.audience = 'admins')
      )
      and (p_category is null or p_category = 'system')
      and (not p_unread_only or r.read_at is null)
  ),
  combined as (
    select * from personal
    union all
    select * from announcements
  )
  select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at desc), '[]'::jsonb)
    into items
  from (
    select * from combined
    order by created_at desc
    limit greatest(1, least(coalesce(p_limit, 30), 100))
    offset greatest(0, coalesce(p_offset, 0))
  ) c;

  return jsonb_build_object(
    'ok', true,
    'unread', coalesce(unread, 0),
    'items', coalesce(items, '[]'::jsonb)
  );
end;
$$;

create or replace function public.unread_notification_count()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  role text;
  total int := 0;
begin
  if uid is null then
    return 0;
  end if;
  select p.role into role from public.profiles p where p.id = uid;
  select count(*)::int into total
  from public.notifications
  where user_id = uid and read_at is null and archived_at is null;
  select total + count(*)::int into total
  from public.platform_announcements a
  where a.active = true
    and (
      a.audience = 'all'
      or (role = 'agent' and a.audience = 'agents')
      or (role = 'customer' and a.audience = 'customers')
      or (role = 'admin' and a.audience = 'admins')
    )
    and not exists (
      select 1 from public.announcement_reads r
      where r.announcement_id = a.id and r.user_id = uid
    );
  return coalesce(total, 0);
end;
$$;

create or replace function public.mark_notification_read(p_id uuid, p_source text default 'personal')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Sign in required';
  end if;
  if coalesce(p_source, 'personal') = 'announcement' then
    insert into public.announcement_reads (announcement_id, user_id)
    values (p_id, uid)
    on conflict do nothing;
  else
    update public.notifications
      set read_at = coalesce(read_at, now())
      where id = p_id and user_id = uid;
  end if;
  return jsonb_build_object('ok', true, 'unread', public.unread_notification_count());
end;
$$;

create or replace function public.mark_all_notifications_read()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  role text;
begin
  if uid is null then
    raise exception 'Sign in required';
  end if;
  select p.role into role from public.profiles p where p.id = uid;
  update public.notifications
    set read_at = now()
    where user_id = uid and read_at is null and archived_at is null;
  insert into public.announcement_reads (announcement_id, user_id)
  select a.id, uid
  from public.platform_announcements a
  where a.active = true
    and (
      a.audience = 'all'
      or (role = 'agent' and a.audience = 'agents')
      or (role = 'customer' and a.audience = 'customers')
      or (role = 'admin' and a.audience = 'admins')
    )
  on conflict do nothing;
  return jsonb_build_object('ok', true, 'unread', 0);
end;
$$;

create or replace function public.archive_notification(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in required';
  end if;
  update public.notifications
    set archived_at = now(), read_at = coalesce(read_at, now())
    where id = p_id and user_id = auth.uid();
  return jsonb_build_object('ok', true, 'unread', public.unread_notification_count());
end;
$$;

create or replace function public.get_notification_preferences()
returns public.notification_preferences
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in required';
  end if;
  return public.ensure_notification_preferences(auth.uid());
end;
$$;

create or replace function public.update_notification_preferences(
  p_order_updates boolean default null,
  p_payment_updates boolean default null,
  p_wallet_activity boolean default null,
  p_refund_updates boolean default null,
  p_dispute_updates boolean default null,
  p_promotional boolean default null
)
returns public.notification_preferences
language plpgsql
security definer
set search_path = public
as $$
declare
  prefs public.notification_preferences%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in required';
  end if;
  perform public.ensure_notification_preferences(auth.uid());
  update public.notification_preferences
    set
      order_updates = coalesce(p_order_updates, order_updates),
      payment_updates = coalesce(p_payment_updates, payment_updates),
      wallet_activity = coalesce(p_wallet_activity, wallet_activity),
      refund_updates = coalesce(p_refund_updates, refund_updates),
      dispute_updates = coalesce(p_dispute_updates, dispute_updates),
      promotional = coalesce(p_promotional, promotional),
      updated_at = now()
    where user_id = auth.uid()
    returning * into prefs;
  return prefs;
end;
$$;

create or replace function public.admin_create_announcement(
  p_title text,
  p_body text,
  p_audience text default 'all',
  p_priority text default 'normal',
  p_action_url text default null
)
returns public.platform_announcements
language plpgsql
security definer
set search_path = public
as $$
declare
  row public.platform_announcements%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;
  insert into public.platform_announcements (title, body, audience, priority, action_url, created_by)
  values (
    left(trim(p_title), 120),
    left(trim(p_body), 800),
    coalesce(nullif(p_audience, ''), 'all'),
    coalesce(nullif(p_priority, ''), 'normal'),
    nullif(trim(p_action_url), ''),
    auth.uid()
  )
  returning * into row;
  return row;
end;
$$;

create or replace function public.admin_list_notifications(p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at desc)
    from (
      select
        n.id,
        n.user_id,
        p.full_name as customer_name,
        p.email as customer_email,
        n.category,
        n.priority,
        n.title,
        n.body,
        n.entity_type,
        n.entity_id,
        n.action_url,
        n.read_at,
        n.created_at
      from public.notifications n
      left join public.profiles p on p.id = n.user_id
      order by n.created_at desc
      limit greatest(1, least(coalesce(p_limit, 50), 200))
      offset greatest(0, coalesce(p_offset, 0))
    ) x
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.list_my_notifications(int, int, text, boolean) to authenticated;
grant execute on function public.unread_notification_count() to authenticated;
grant execute on function public.mark_notification_read(uuid, text) to authenticated;
grant execute on function public.mark_all_notifications_read() to authenticated;
grant execute on function public.archive_notification(uuid) to authenticated;
grant execute on function public.get_notification_preferences() to authenticated;
grant execute on function public.update_notification_preferences(boolean, boolean, boolean, boolean, boolean, boolean) to authenticated;
grant execute on function public.admin_create_announcement(text, text, text, text, text) to authenticated;
grant execute on function public.admin_list_notifications(int, int) to authenticated;

-- ===================== EVENT TRIGGERS =====================

create or replace function public.trg_notify_order_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  agent_id uuid;
  masked text;
  gb_label text;
  net_label text;
begin
  masked := public.mask_phone(new.recipient_number);
  gb_label := trim(to_char(new.gb, 'FM999990.##')) || 'GB';
  net_label := upper(coalesce(new.network, 'DATA'));

  if tg_op = 'INSERT' and new.payment_status in ('paid', 'success') and new.buyer_id is not null then
    perform public.notify_user(
      new.buyer_id,
      'order',
      'Order received',
      'Your ' || net_label || ' ' || gb_label || ' order is being processed for ' || masked || '.',
      'normal',
      'order',
      new.id,
      '../track.html?code=' || new.order_code,
      'order:' || new.id::text || ':created',
      jsonb_build_object('order_code', new.order_code)
    );
  end if;

  if tg_op = 'UPDATE' and new.delivery_status is distinct from old.delivery_status then
    if new.buyer_id is not null then
      if new.delivery_status = 'processing' then
        perform public.notify_user(
          new.buyer_id, 'order', 'Order processing',
          'Your ' || net_label || ' ' || gb_label || ' order for ' || masked || ' is currently being processed.',
          'normal', 'order', new.id,
          '../track.html?code=' || new.order_code,
          'order:' || new.id::text || ':processing',
          jsonb_build_object('order_code', new.order_code)
        );
      elsif new.delivery_status in ('delivered', 'completed') then
        perform public.notify_user(
          new.buyer_id, 'order', 'Data delivered',
          'Your ' || net_label || ' ' || gb_label || ' was successfully delivered to ' || masked || '.',
          'important', 'order', new.id,
          '../track.html?code=' || new.order_code,
          'order:' || new.id::text || ':delivered',
          jsonb_build_object('order_code', new.order_code)
        );
      elsif new.delivery_status = 'failed' then
        perform public.notify_user(
          new.buyer_id, 'order', 'Delivery failed',
          'Your ' || net_label || ' ' || gb_label || ' order for ' || masked || ' could not be completed.',
          'urgent', 'order', new.id,
          '../track.html?code=' || new.order_code,
          'order:' || new.id::text || ':failed',
          jsonb_build_object('order_code', new.order_code)
        );
      end if;
    end if;

    if new.agent_store_id is not null then
      select s.agent_id into agent_id from public.agent_stores s where s.id = new.agent_store_id;
      if agent_id is not null then
        if new.delivery_status in ('delivered', 'completed') then
          perform public.notify_user(
            agent_id, 'order', 'Store order completed',
            net_label || ' ' || gb_label || ' sold via your store was delivered.',
            'normal', 'order', new.id,
            'dashboard.html#orders',
            'agent-order:' || new.id::text || ':delivered',
            jsonb_build_object('order_code', new.order_code)
          );
        elsif new.delivery_status = 'failed' then
          perform public.notify_user(
            agent_id, 'order', 'Store order failed',
            'A store sale (' || net_label || ' ' || gb_label || ') needs attention.',
            'important', 'order', new.id,
            'dashboard.html#orders',
            'agent-order:' || new.id::text || ':failed',
            jsonb_build_object('order_code', new.order_code)
          );
        elsif tg_op = 'INSERT' or (old.payment_status is distinct from new.payment_status and new.payment_status in ('paid', 'success')) then
          perform public.notify_user(
            agent_id, 'order', 'New store order',
            'New ' || net_label || ' ' || gb_label || ' order received in your store.',
            'normal', 'order', new.id,
            'dashboard.html#orders',
            'agent-order:' || new.id::text || ':new',
            jsonb_build_object('order_code', new.order_code)
          );
        end if;
      end if;
    end if;
  end if;

  if tg_op = 'INSERT' and new.agent_store_id is not null and new.payment_status in ('paid', 'success') then
    select s.agent_id into agent_id from public.agent_stores s where s.id = new.agent_store_id;
    if agent_id is not null then
      perform public.notify_user(
        agent_id, 'order', 'New store order',
        'New ' || net_label || ' ' || gb_label || ' order received in your store.',
        'normal', 'order', new.id,
        'dashboard.html#orders',
        'agent-order:' || new.id::text || ':new',
        jsonb_build_object('order_code', new.order_code)
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists orders_notify_aiu on public.orders;
create trigger orders_notify_aiu
  after insert or update of delivery_status, payment_status
  on public.orders
  for each row execute function public.trg_notify_order_changes();

create or replace function public.trg_notify_wallet_tx()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  amt text;
begin
  amt := 'GH₵' || trim(to_char(new.amount, 'FM999999990.00'));
  if new.type = 'credit' then
    perform public.notify_user(
      new.agent_id, 'wallet', 'Wallet updated',
      amt || ' was added to your DataLogs wallet.',
      'normal', 'wallet', new.id,
      'dashboard.html#wallet',
      'wallet:' || coalesce(new.reference, new.id::text) || ':credit',
      jsonb_build_object('amount', new.amount, 'reference', new.reference)
    );
  elsif new.type = 'debit' and coalesce(new.description, '') not ilike 'Withdrawal%' then
    perform public.notify_user(
      new.agent_id, 'wallet', 'Wallet payment',
      amt || ' was used from your wallet.',
      'normal', 'wallet', new.id,
      'dashboard.html#wallet',
      'wallet:' || coalesce(new.reference, new.id::text) || ':debit',
      jsonb_build_object('amount', new.amount, 'reference', new.reference)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists wallet_tx_notify_ai on public.wallet_transactions;
create trigger wallet_tx_notify_ai
  after insert on public.wallet_transactions
  for each row execute function public.trg_notify_wallet_tx();

create or replace function public.trg_notify_refund_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  amt text := 'GH₵' || trim(to_char(new.amount, 'FM999999990.00'));
  target uuid;
begin
  target := coalesce(new.buyer_id, new.requested_by);
  if tg_op = 'INSERT' and target is not null then
    perform public.notify_user(
      target, 'refund', 'Refund request received',
      'Your refund request for order ' || new.order_code || ' has been received.',
      'normal', 'refund', new.id,
      '../customer/refunds.html',
      'refund:' || new.id::text || ':requested',
      jsonb_build_object('refund_code', new.refund_code, 'order_code', new.order_code)
    );
    if new.agent_id is not null then
      perform public.notify_user(
        new.agent_id, 'dispute', 'New store dispute',
        'A refund/dispute was opened for order ' || new.order_code || '.',
        'important', 'refund', new.id,
        'dashboard.html#orders',
        'agent-refund:' || new.id::text || ':opened',
        jsonb_build_object('refund_code', new.refund_code)
      );
    end if;
  end if;

  if tg_op = 'UPDATE' and new.status is distinct from old.status and target is not null then
    if new.status in ('under_review', 'approved', 'processing') then
      perform public.notify_user(
        target, 'refund', 'Refund update',
        'Your refund for ' || new.order_code || ' is now ' || replace(new.status, '_', ' ') || '.',
        'normal', 'refund', new.id,
        '../customer/refunds.html',
        'refund:' || new.id::text || ':' || new.status,
        jsonb_build_object('status', new.status)
      );
    elsif new.status = 'completed' then
      perform public.notify_user(
        target, 'refund', 'Refund completed',
        'Your ' || amt || ' refund for ' || new.order_code || ' has been completed.',
        'important', 'refund', new.id,
        '../customer/refunds.html',
        'refund:' || new.id::text || ':completed',
        jsonb_build_object('amount', new.amount)
      );
    elsif new.status in ('rejected', 'failed') then
      perform public.notify_user(
        target, 'refund', 'Refund ' || new.status,
        'Your refund request for ' || new.order_code || ' was ' || new.status || '.',
        'urgent', 'refund', new.id,
        '../customer/refunds.html',
        'refund:' || new.id::text || ':' || new.status,
        jsonb_build_object('status', new.status)
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists refunds_notify_aiu on public.refunds;
create trigger refunds_notify_aiu
  after insert or update of status
  on public.refunds
  for each row execute function public.trg_notify_refund_changes();

create or replace function public.trg_notify_withdrawal_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  amt text := 'GH₵' || trim(to_char(new.amount, 'FM999999990.00'));
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'approved' then
      perform public.notify_user(
        new.agent_id, 'wallet', 'Withdrawal approved',
        'Your ' || amt || ' withdrawal has been approved.',
        'important', 'withdrawal', new.id,
        'dashboard.html#withdrawal',
        'withdrawal:' || new.id::text || ':approved',
        jsonb_build_object('amount', new.amount)
      );
    elsif new.status = 'rejected' then
      perform public.notify_user(
        new.agent_id, 'wallet', 'Withdrawal rejected',
        'Your ' || amt || ' withdrawal was rejected.' || case when coalesce(new.note, '') <> '' then ' ' || new.note else '' end,
        'important', 'wallet', new.id,
        'dashboard.html#withdrawal',
        'withdrawal:' || new.id::text || ':rejected',
        jsonb_build_object('amount', new.amount)
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists withdrawals_notify_au on public.withdrawals;
create trigger withdrawals_notify_au
  after update of status
  on public.withdrawals
  for each row execute function public.trg_notify_withdrawal_changes();

create or replace function public.trg_notify_payment_success()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  amt text;
  uid uuid;
begin
  if tg_op = 'UPDATE'
     and new.status = 'success'
     and old.status is distinct from new.status then
    amt := 'GH₵' || trim(to_char(new.amount, 'FM999999990.00'));
    uid := new.user_id;
    if uid is null then
      return new;
    end if;
    if new.kind = 'wallet_topup' then
      perform public.notify_user(
        uid, 'payment', 'Payment successful',
        'Your payment of ' || amt || ' for wallet top-up was successful.',
        'normal', 'payment', new.id,
        'dashboard.html#wallet',
        'payment:' || new.reference || ':success',
        jsonb_build_object('reference', new.reference, 'kind', new.kind)
      );
    else
      perform public.notify_user(
        uid, 'payment', 'Payment successful',
        'Your payment of ' || amt || ' was successful.',
        'normal', 'payment', new.id,
        case when new.order_id is not null then '../track.html' else 'dashboard.html' end,
        'payment:' || new.reference || ':success',
        jsonb_build_object('reference', new.reference, 'kind', new.kind)
      );
    end if;
  elsif tg_op = 'UPDATE'
     and new.status = 'failed'
     and old.status is distinct from new.status
     and new.user_id is not null then
    amt := 'GH₵' || trim(to_char(new.amount, 'FM999999990.00'));
    perform public.notify_user(
      new.user_id, 'payment', 'Payment failed',
      'Your ' || amt || ' payment could not be completed.',
      'urgent', 'payment', new.id,
      null,
      'payment:' || new.reference || ':failed',
      jsonb_build_object('reference', new.reference)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists payments_notify_au on public.payments;
create trigger payments_notify_au
  after update of status
  on public.payments
  for each row execute function public.trg_notify_payment_success();

notify pgrst, 'reload schema';
