create table if not exists ai_response_cache (
  cache_key text primary key,
  endpoint text not null,
  model text not null,
  request_body jsonb not null,
  response_body jsonb not null,
  usage jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  hit_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ai_response_cache_expires_at on ai_response_cache(expires_at);
create index if not exists idx_ai_response_cache_endpoint_model on ai_response_cache(endpoint, model);

drop trigger if exists set_ai_response_cache_updated_at on ai_response_cache;
create trigger set_ai_response_cache_updated_at
before update on ai_response_cache
for each row execute function set_updated_at();
