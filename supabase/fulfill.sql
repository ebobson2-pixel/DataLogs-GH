-- SwiftData provider fulfillment fields on orders

alter table public.orders
  add column if not exists provider_ref text,
  add column if not exists provider_status text,
  add column if not exists provider_network text,
  add column if not exists provider_error text,
  add column if not exists fail_reason text,
  add column if not exists retryable boolean not null default false,
  add column if not exists retry_count int not null default 0,
  add column if not exists last_retry_at timestamptz;

create index if not exists orders_retryable_idx
  on public.orders (retryable, fail_reason)
  where retryable = true;

create index if not exists orders_provider_ref_idx
  on public.orders (provider_ref)
  where provider_ref is not null;
