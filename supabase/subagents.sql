-- One-level subagents: parent agents recruit resellers, set cost prices, split wallet profits.
-- Example: platform base 4.50 → parent charges sub 5.00 → sub sells 5.50
--          parent wallet +0.50, subagent wallet +0.50, platform keeps 4.50 COGS.

alter table public.profiles
  add column if not exists subagents_enabled boolean not null default false;

alter table public.profiles
  add column if not exists parent_agent_id uuid references public.profiles(id) on delete set null;

create index if not exists profiles_parent_agent_idx on public.profiles(parent_agent_id);

create table if not exists public.subagent_package_prices (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references public.profiles(id) on delete cascade,
  package_id uuid not null references public.packages(id) on delete cascade,
  agent_price numeric(12,2) not null check (agent_price >= 0),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (parent_id, package_id)
);

create index if not exists subagent_package_prices_parent_idx on public.subagent_package_prices(parent_id);

drop trigger if exists subagent_package_prices_updated_at on public.subagent_package_prices;
create trigger subagent_package_prices_updated_at before update on public.subagent_package_prices
for each row execute function public.set_updated_at();

alter table public.subagent_package_prices enable row level security;

drop policy if exists "spp_select_parent_child_admin" on public.subagent_package_prices;
create policy "spp_select_parent_child_admin" on public.subagent_package_prices
  for select using (
    parent_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.parent_agent_id = subagent_package_prices.parent_id
    )
  );

drop policy if exists "spp_insert_parent" on public.subagent_package_prices;
create policy "spp_insert_parent" on public.subagent_package_prices
  for insert with check (
    parent_id = auth.uid()
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('agent', 'admin')
        and p.parent_agent_id is null
    )
  );

drop policy if exists "spp_update_parent" on public.subagent_package_prices;
create policy "spp_update_parent" on public.subagent_package_prices
  for update using (parent_id = auth.uid() or public.is_admin())
  with check (parent_id = auth.uid() or public.is_admin());

drop policy if exists "spp_delete_parent" on public.subagent_package_prices;
create policy "spp_delete_parent" on public.subagent_package_prices
  for delete using (parent_id = auth.uid() or public.is_admin());

grant select, insert, update, delete on public.subagent_package_prices to authenticated;
grant select on public.subagent_package_prices to anon;

-- Platform / parent wholesale base (admin custom or package agent_price)
create or replace function public.platform_agent_base(p_agent_id uuid, p_package_id uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  pkg public.packages%rowtype;
  custom_price numeric(12,2);
begin
  select * into pkg from public.packages where id = p_package_id and active = true;
  if not found then
    raise exception 'Package not found';
  end if;
  select ucp.agent_price into custom_price
  from public.user_custom_prices ucp
  where ucp.user_id = p_agent_id and ucp.package_id = p_package_id;
  return coalesce(custom_price, pkg.agent_price);
end;
$$;

grant execute on function public.platform_agent_base(uuid, uuid) to anon, authenticated, service_role;

create or replace function public.resolve_agent_store_price(
  p_agent_id uuid,
  p_package_id uuid,
  out base_price numeric,
  out profit numeric,
  out sell_price numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  pkg public.packages%rowtype;
  price_row public.agent_store_prices%rowtype;
  parent_id uuid;
  sub_cost numeric(12,2);
begin
  select * into pkg from public.packages where id = p_package_id and active = true;
  if not found then
    raise exception 'Package not found';
  end if;

  select p.parent_agent_id into parent_id from public.profiles p where p.id = p_agent_id;

  if parent_id is not null then
    select spp.agent_price into sub_cost
    from public.subagent_package_prices spp
    where spp.parent_id = parent_id and spp.package_id = p_package_id;
    base_price := coalesce(sub_cost, public.platform_agent_base(parent_id, p_package_id));
  else
    base_price := public.platform_agent_base(p_agent_id, p_package_id);
  end if;

  select * into price_row
  from public.agent_store_prices
  where agent_id = p_agent_id and package_id = p_package_id;

  if found then
    profit := coalesce(price_row.profit, 0);
  else
    profit := greatest(0, pkg.retail_price - base_price);
  end if;

  sell_price := base_price + profit;
end;
$$;

grant execute on function public.resolve_agent_store_price(uuid, uuid) to anon, authenticated, service_role;

-- Credit store owner (+ parent markup when seller is a subagent)
create or replace function public.credit_store_sale_profits(
  p_store_agent_id uuid,
  p_package_id uuid,
  p_sell_amount numeric,
  p_order_code text,
  p_gb numeric,
  p_network text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_id uuid;
  seller_base numeric(12,2);
  parent_base numeric(12,2);
  seller_profit numeric(12,2);
  parent_profit numeric(12,2);
  sell numeric(12,2) := round(coalesce(p_sell_amount, 0)::numeric, 2);
begin
  if p_store_agent_id is null or sell <= 0 then
    return;
  end if;

  select r.base_price into seller_base
  from public.resolve_agent_store_price(p_store_agent_id, p_package_id) r;

  select p.parent_agent_id into parent_id from public.profiles p where p.id = p_store_agent_id;

  seller_profit := round(greatest(0, sell - coalesce(seller_base, 0))::numeric, 2);

  if parent_id is null then
    if seller_profit > 0 then
      perform public.credit_agent_wallet(
        p_store_agent_id,
        seller_profit,
        p_order_code,
        'Store profit · ' || p_gb || 'GB ' || p_network || ' · sold at GH₵ ' || sell
      );
    end if;
    return;
  end if;

  parent_base := public.platform_agent_base(parent_id, p_package_id);
  parent_profit := round(greatest(0, coalesce(seller_base, 0) - coalesce(parent_base, 0))::numeric, 2);

  if seller_profit > 0 then
    perform public.credit_agent_wallet(
      p_store_agent_id,
      seller_profit,
      p_order_code,
      'Store profit · ' || p_gb || 'GB ' || p_network || ' · sold at GH₵ ' || sell
    );
  end if;

  if parent_profit > 0 then
    perform public.credit_agent_wallet(
      parent_id,
      parent_profit,
      p_order_code,
      'Subagent markup · ' || p_gb || 'GB ' || p_network || ' · cost GH₵ ' || seller_base
    );
  end if;
end;
$$;

grant execute on function public.credit_store_sale_profits(uuid, uuid, numeric, text, numeric, text) to service_role;

create or replace function public.set_agent_subagents_enabled(p_enabled boolean)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  row_out public.profiles%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  select * into row_out from public.profiles where id = auth.uid() for update;
  if not found or row_out.role not in ('agent', 'admin') then
    raise exception 'Only agents can change this setting';
  end if;
  if row_out.parent_agent_id is not null then
    raise exception 'Subagents cannot recruit further resellers';
  end if;

  update public.profiles
    set subagents_enabled = coalesce(p_enabled, false)
    where id = auth.uid()
    returning * into row_out;

  return row_out;
end;
$$;

grant execute on function public.set_agent_subagents_enabled(boolean) to authenticated;

create or replace function public.set_subagent_package_price(
  p_package_id uuid,
  p_agent_price numeric
)
returns public.subagent_package_prices
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.profiles%rowtype;
  parent_base numeric(12,2);
  row_out public.subagent_package_prices%rowtype;
  price numeric(12,2);
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  select * into me from public.profiles where id = auth.uid();
  if not found or me.role not in ('agent', 'admin') then
    raise exception 'Only agents can set subagent prices';
  end if;
  if me.parent_agent_id is not null then
    raise exception 'Subagents cannot set reseller cost prices';
  end if;
  if p_agent_price is null or p_agent_price < 0 then
    raise exception 'Price must be zero or more';
  end if;
  if not exists (select 1 from public.packages where id = p_package_id and active = true) then
    raise exception 'Package not found';
  end if;

  parent_base := public.platform_agent_base(auth.uid(), p_package_id);
  price := round(p_agent_price::numeric, 2);
  if price < parent_base then
    raise exception 'Subagent cost cannot be below your base price (GH₵ %)', parent_base;
  end if;

  insert into public.subagent_package_prices (parent_id, package_id, agent_price)
  values (auth.uid(), p_package_id, price)
  on conflict (parent_id, package_id)
  do update set agent_price = excluded.agent_price, updated_at = now()
  returning * into row_out;

  return row_out;
end;
$$;

grant execute on function public.set_subagent_package_price(uuid, numeric) to authenticated;

create or replace function public.list_my_subagents()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  return coalesce((
    select jsonb_agg(row_to_json(x)::jsonb order by x.created_at desc)
    from (
      select
        p.id,
        p.full_name,
        p.email,
        p.phone,
        p.created_at,
        s.name as store_name,
        s.slug as store_slug,
        s.published as store_published,
        coalesce(w.balance, 0) as wallet_balance
      from public.profiles p
      left join public.agent_stores s on s.agent_id = p.id
      left join public.wallets w on w.agent_id = p.id
      where p.parent_agent_id = auth.uid()
        and p.role = 'agent'
    ) x
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.list_my_subagents() to authenticated;

create or replace function public.resolve_subagent_invite(p_ref text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ref text := lower(trim(coalesce(p_ref, '')));
  parent public.profiles%rowtype;
  store_rec public.agent_stores%rowtype;
  parent_uuid uuid;
begin
  if ref = '' then
    return jsonb_build_object('ok', false, 'message', 'Missing invite code');
  end if;

  begin
    parent_uuid := ref::uuid;
  exception when others then
    parent_uuid := null;
  end;

  if parent_uuid is not null then
    select * into parent from public.profiles where id = parent_uuid and role in ('agent', 'admin');
  end if;

  if parent.id is null then
    select * into store_rec from public.agent_stores where lower(slug) = ref;
    if found then
      select * into parent from public.profiles where id = store_rec.agent_id;
    end if;
  end if;

  if parent.id is null then
    return jsonb_build_object('ok', false, 'message', 'Invite link is invalid');
  end if;
  if parent.parent_agent_id is not null then
    return jsonb_build_object('ok', false, 'message', 'This agent cannot recruit resellers');
  end if;
  if coalesce(parent.subagents_enabled, false) = false then
    return jsonb_build_object('ok', false, 'message', 'This agent is not accepting resellers right now');
  end if;
  if coalesce(parent.blocked, false) = true then
    return jsonb_build_object('ok', false, 'message', 'This invite is unavailable');
  end if;

  if store_rec.id is null then
    select * into store_rec from public.agent_stores where agent_id = parent.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'parent_agent_id', parent.id,
    'parent_name', coalesce(nullif(store_rec.name, ''), nullif(parent.full_name, ''), 'Agent'),
    'store_slug', store_rec.slug,
    'store_name', store_rec.name
  );
end;
$$;

grant execute on function public.resolve_subagent_invite(text) to anon, authenticated, service_role;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_role text := coalesce(new.raw_user_meta_data->>'role', 'customer');
  safe_role text;
  parent_raw text := nullif(trim(coalesce(new.raw_user_meta_data->>'parent_agent_id', '')), '');
  parent_id uuid;
  parent_ok boolean := false;
begin
  if requested_role in ('customer', 'agent') then
    safe_role := requested_role;
  else
    safe_role := 'customer';
  end if;

  if safe_role = 'agent' and parent_raw is not null then
    begin
      parent_id := parent_raw::uuid;
    exception when others then
      parent_id := null;
    end;
    if parent_id is not null then
      select exists (
        select 1 from public.profiles p
        where p.id = parent_id
          and p.role in ('agent', 'admin')
          and p.parent_agent_id is null
          and coalesce(p.subagents_enabled, false) = true
          and coalesce(p.blocked, false) = false
      ) into parent_ok;
      if not parent_ok then
        parent_id := null;
      end if;
    end if;
  else
    parent_id := null;
  end if;

  insert into public.profiles (id, full_name, phone, email, role, parent_agent_id, subagents_enabled)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1), ''),
    new.raw_user_meta_data->>'phone',
    new.email,
    safe_role,
    parent_id,
    false
  );
  return new;
end;
$$;

-- Agent-tier quote uses parent cost for subagents
create or replace function public.quote_order_amount(
  p_package_id uuid,
  p_pricing_tier text default 'retail',
  p_agent_store_id uuid default null,
  p_buyer_id uuid default null
)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  pkg public.packages%rowtype;
  store_rec public.agent_stores%rowtype;
  buyer uuid := coalesce(p_buyer_id, auth.uid());
  base_price numeric(12,2);
  profit numeric(12,2);
  sell_price numeric(12,2);
  parent_id uuid;
  sub_cost numeric(12,2);
begin
  if p_pricing_tier not in ('retail', 'agent') then
    raise exception 'Invalid pricing tier';
  end if;
  select * into pkg from public.packages where id = p_package_id and active = true;
  if not found then
    raise exception 'Package not found';
  end if;

  if p_agent_store_id is not null then
    select * into store_rec from public.agent_stores where id = p_agent_store_id and published = true;
    if not found then
      raise exception 'Store not available';
    end if;
    select r.base_price, r.profit, r.sell_price
      into base_price, profit, sell_price
    from public.resolve_agent_store_price(store_rec.agent_id, pkg.id) r;
    return sell_price;
  end if;

  if p_pricing_tier = 'agent' then
    if buyer is null then
      raise exception 'Agent pricing requires an agent account';
    end if;
    if not exists (
      select 1 from public.profiles p
      where p.id = buyer and p.role in ('agent', 'admin') and coalesce(p.blocked, false) = false
    ) then
      raise exception 'Agent pricing requires an agent account';
    end if;
    select p.parent_agent_id into parent_id from public.profiles p where p.id = buyer;
    if parent_id is not null then
      select spp.agent_price into sub_cost
      from public.subagent_package_prices spp
      where spp.parent_id = parent_id and spp.package_id = pkg.id;
      return coalesce(sub_cost, public.platform_agent_base(parent_id, pkg.id));
    end if;
    return public.platform_agent_base(buyer, pkg.id);
  end if;

  return pkg.retail_price;
end;
$$;

create or replace function public.place_order(
  p_package_id uuid,
  p_recipient_number text,
  p_payment_method text,
  p_pricing_tier text default 'retail',
  p_agent_store_id uuid default null
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  pkg public.packages%rowtype;
  amount numeric(10,2);
  new_order public.orders%rowtype;
  code text;
  store_rec public.agent_stores%rowtype;
  sell_amount numeric(12,2) := 0;
begin
  if p_pricing_tier not in ('retail', 'agent') then
    raise exception 'Invalid pricing tier';
  end if;

  if p_pricing_tier = 'agent' then
    if auth.uid() is null or not public.is_agent() then
      raise exception 'Agent pricing requires an agent account';
    end if;
  end if;

  select * into pkg from public.packages where id = p_package_id and active = true;
  if not found then
    raise exception 'Package not found';
  end if;

  if p_agent_store_id is not null then
    select * into store_rec from public.agent_stores where id = p_agent_store_id and published = true;
    if not found then
      raise exception 'Store not available';
    end if;
    select r.sell_price into amount
    from public.resolve_agent_store_price(store_rec.agent_id, pkg.id) r;
    sell_amount := amount;
  elsif p_pricing_tier = 'agent' then
    amount := public.quote_order_amount(pkg.id, 'agent', null, auth.uid());
  else
    amount := pkg.retail_price;
  end if;

  code := 'DL-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  insert into public.orders (
    order_code, buyer_id, agent_store_id, package_id, network, gb,
    recipient_number, amount_paid, retail_price, pricing_tier,
    payment_method, payment_status, delivery_status
  ) values (
    code,
    auth.uid(),
    p_agent_store_id,
    pkg.id,
    pkg.network,
    pkg.gb,
    p_recipient_number,
    amount,
    pkg.retail_price,
    case when p_agent_store_id is not null then 'retail' else p_pricing_tier end,
    coalesce(nullif(p_payment_method, ''), 'momo'),
    'paid',
    'processing'
  )
  returning * into new_order;

  if p_agent_store_id is not null then
    perform public.credit_store_sale_profits(
      store_rec.agent_id,
      pkg.id,
      sell_amount,
      new_order.order_code,
      pkg.gb,
      pkg.network
    );
  end if;

  return new_order;
end;
$$;

grant execute on function public.place_order(uuid, text, text, text, uuid) to anon, authenticated;

-- Keep Paystack fee behaviour; split store profits for subagents
create or replace function public.complete_confirmed_payment(p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pay public.payments%rowtype;
  pkg public.packages%rowtype;
  store_rec public.agent_stores%rowtype;
  amount numeric(12,2);
  sell_amount numeric(12,2) := 0;
  new_order public.orders%rowtype;
  code text;
  meta jsonb;
  package_id uuid;
  recipient text;
  pricing_tier text;
  store_id uuid;
  buyer uuid;
  fee numeric(12,2);
begin
  perform pg_advisory_xact_lock(hashtext(coalesce(p_reference, '')));

  select * into pay from public.payments where reference = p_reference for update;
  if not found then
    raise exception 'Payment not found';
  end if;
  if pay.status = 'success' then
    return jsonb_build_object('ok', true, 'payment', to_jsonb(pay), 'already', true);
  end if;
  if pay.status <> 'pending' then
    raise exception 'Payment is not pending';
  end if;

  meta := coalesce(pay.metadata, '{}'::jsonb);

  if pay.kind = 'wallet_topup' then
    buyer := coalesce(pay.user_id, (meta->>'agent_id')::uuid);
    if buyer is null then
      raise exception 'Missing agent for wallet top-up';
    end if;
    perform public.credit_agent_wallet(
      buyer,
      pay.amount,
      pay.reference,
      'Paystack wallet top-up'
    );
    update public.payments
      set status = 'success', paid_at = now()
      where id = pay.id
      returning * into pay;
    return jsonb_build_object('ok', true, 'payment', to_jsonb(pay), 'kind', 'wallet_topup');
  end if;

  if pay.kind = 'agent_activation' then
    buyer := coalesce(pay.user_id, (meta->>'agent_id')::uuid);
    if buyer is null then
      raise exception 'Missing agent for activation payment';
    end if;
    if not exists (
      select 1 from public.profiles p
      where p.id = buyer and p.role = 'agent' and coalesce(p.blocked, false) = false
    ) then
      raise exception 'Activation is only for agent accounts';
    end if;
    if not public.agent_activation_required() then
      update public.profiles set agent_activated = true where id = buyer;
      update public.payments
        set status = 'success', paid_at = now()
        where id = pay.id
        returning * into pay;
      return jsonb_build_object('ok', true, 'payment', to_jsonb(pay), 'kind', 'agent_activation', 'activated', true);
    end if;
    select coalesce(agent_activation_fee, 0) into fee from public.site_settings where id = 1;
    if abs(fee - pay.amount) > 0.05 then
      raise exception 'Paid amount does not match activation fee';
    end if;
    update public.profiles
      set agent_activated = true
      where id = buyer;
    update public.payments
      set status = 'success', paid_at = now()
      where id = pay.id
      returning * into pay;
    return jsonb_build_object('ok', true, 'payment', to_jsonb(pay), 'kind', 'agent_activation', 'activated', true);
  end if;

  package_id := (meta->>'package_id')::uuid;
  recipient := meta->>'recipient_number';
  pricing_tier := coalesce(meta->>'pricing_tier', 'retail');
  store_id := nullif(meta->>'agent_store_id', '')::uuid;
  buyer := coalesce(pay.user_id, nullif(meta->>'buyer_id', '')::uuid);

  if package_id is null or coalesce(recipient, '') = '' then
    raise exception 'Payment is missing order details';
  end if;

  select * into pkg from public.packages where id = package_id and active = true;
  if not found then
    raise exception 'Package not found';
  end if;

  if store_id is not null then
    select * into store_rec from public.agent_stores where id = store_id and published = true;
    if not found then
      raise exception 'Store not available';
    end if;
    select r.sell_price into amount
    from public.resolve_agent_store_price(store_rec.agent_id, pkg.id) r;
    sell_amount := amount;
    pricing_tier := 'retail';
  elsif pricing_tier = 'agent' then
    amount := public.quote_order_amount(pkg.id, 'agent', null, buyer);
  else
    amount := pkg.retail_price;
  end if;

  -- Buyers pay package price + 3% Paystack fee on MoMo/card charges.
  amount := round((amount * 1.03)::numeric, 2);

  if abs(amount - pay.amount) > 0.05 then
    raise exception 'Paid amount does not match package price';
  end if;

  code := 'DL-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  insert into public.orders (
    order_code, buyer_id, agent_store_id, package_id, network, gb,
    recipient_number, amount_paid, retail_price, pricing_tier,
    payment_method, payment_status, delivery_status, payment_reference
  ) values (
    code,
    buyer,
    store_id,
    pkg.id,
    pkg.network,
    pkg.gb,
    recipient,
    pay.amount,
    pkg.retail_price,
    pricing_tier,
    coalesce(pay.channel, 'paystack'),
    'paid',
    'processing',
    pay.reference
  )
  returning * into new_order;

  if store_id is not null then
    perform public.credit_store_sale_profits(
      store_rec.agent_id,
      pkg.id,
      sell_amount,
      new_order.order_code,
      pkg.gb,
      pkg.network
    );
  end if;

  update public.payments
    set status = 'success',
        paid_at = now(),
        order_id = new_order.id
    where id = pay.id
    returning * into pay;

  return jsonb_build_object(
    'ok', true,
    'payment', to_jsonb(pay),
    'order', to_jsonb(new_order),
    'kind', 'order'
  );
end;
$$;

-- Withdrawal minimum GH₵ 13
alter table public.site_settings
  alter column withdrawal_threshold set default 13;

update public.site_settings
  set withdrawal_threshold = 13
  where id = 1 and coalesce(withdrawal_threshold, 10) < 13;

notify pgrst, 'reload schema';
