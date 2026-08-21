-- Store accent colour (matches dashboard theme swatch ids: sea, gold, lime, ...)
alter table public.agent_stores
  add column if not exists accent_color text not null default 'green';

comment on column public.agent_stores.accent_color is 'Theme swatch id for public store accent (green, sea, gold, lime, etc.)';
