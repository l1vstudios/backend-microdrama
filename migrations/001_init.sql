create extension if not exists pgcrypto;

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  email text unique,
  password_hash text not null,
  display_name text,
  role text not null default 'user' check (role in ('owner', 'admin', 'user')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  token_hash text not null unique,
  user_agent text,
  ip_address inet,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references app_users(id) on delete set null,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'admin', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null default '',
  genre text,
  premise text,
  region_mode text not null default 'Indonesia',
  country text not null default 'Indonesia',
  language text not null default 'Bahasa Indonesia',
  visual_style text,
  story_rules text,
  episode_count integer not null default 10 check (episode_count > 0),
  episode_duration integer not null default 120 check (episode_duration > 0),
  cast_count integer not null default 4 check (cast_count >= 0),
  location_count integer not null default 4 check (location_count >= 0),
  prop_count integer not null default 3 check (prop_count >= 0),
  aspect_ratio text not null default '9:16',
  settings jsonb not null default '{}'::jsonb,
  schema_version integer not null default 1,
  created_by uuid references app_users(id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists project_snapshots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid references app_users(id) on delete set null,
  snapshot jsonb not null,
  schema_version integer not null default 1,
  created_at timestamptz not null default now()
);

create table if not exists characters (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  code text not null,
  name text not null default '',
  identity text,
  character_role text,
  personality text,
  background text,
  costume jsonb not null default '{}'::jsonb,
  reference_image text,
  locked boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, code)
);

create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  code text not null,
  name text not null default '',
  description text,
  architecture text,
  furniture text,
  lighting text,
  colors text,
  reference_image text,
  locked boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, code)
);

create table if not exists props (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  code text not null,
  name text not null default '',
  appearance text,
  rules text,
  reference_image text,
  locked boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, code)
);

create table if not exists episodes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  episode_number integer not null,
  title text not null default '',
  synopsis text,
  manifest jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, episode_number)
);

create table if not exists scripts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  episode_id uuid references episodes(id) on delete cascade,
  scene_code text,
  scene_number integer,
  location_code text,
  content jsonb not null default '{}'::jsonb,
  raw_text text,
  status text not null default 'draft' check (status in ('draft', 'locked', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, scene_code)
);

create table if not exists shots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  episode_id uuid references episodes(id) on delete cascade,
  script_id uuid references scripts(id) on delete set null,
  shot_code text not null,
  shot_number integer not null default 0,
  manifest jsonb not null default '{}'::jsonb,
  video_prompt text,
  anchor_image text,
  video_url text,
  video_remote_uri text,
  qa jsonb not null default '{}'::jsonb,
  status text not null default 'idle' check (status in ('idle', 'generating', 'ready', 'error', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, shot_code)
);

create table if not exists generated_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  asset_type text not null check (asset_type in ('character', 'location', 'prop', 'anchor', 'video', 'other')),
  entity_table text,
  entity_id uuid,
  label text,
  mime_type text,
  data_url text,
  storage_url text,
  prompt text,
  model text,
  provider text not null default 'openrouter',
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references app_users(id) on delete set null,
  workspace_id uuid references workspaces(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  provider text not null default 'openrouter',
  model text,
  task_type text,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  total_tokens integer not null default 0,
  cached_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  cache_status text,
  cost_usd numeric(12, 6),
  request_id text,
  duration_ms integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_sessions_user_id on user_sessions(user_id);
create index if not exists idx_user_sessions_token_hash on user_sessions(token_hash);
create index if not exists idx_workspaces_owner_id on workspaces(owner_id);
create index if not exists idx_workspace_members_user_id on workspace_members(user_id);
create index if not exists idx_projects_workspace_id on projects(workspace_id);
create index if not exists idx_project_snapshots_project_id_created_at on project_snapshots(project_id, created_at desc);
create index if not exists idx_characters_project_id on characters(project_id);
create index if not exists idx_locations_project_id on locations(project_id);
create index if not exists idx_props_project_id on props(project_id);
create index if not exists idx_episodes_project_id on episodes(project_id);
create index if not exists idx_scripts_project_id on scripts(project_id);
create index if not exists idx_shots_project_id on shots(project_id);
create index if not exists idx_generated_assets_project_id on generated_assets(project_id);
create index if not exists idx_ai_usage_events_project_id_created_at on ai_usage_events(project_id, created_at desc);
create index if not exists idx_ai_usage_events_user_id_created_at on ai_usage_events(user_id, created_at desc);

drop trigger if exists set_app_users_updated_at on app_users;
create trigger set_app_users_updated_at before update on app_users for each row execute function set_updated_at();

drop trigger if exists set_workspaces_updated_at on workspaces;
create trigger set_workspaces_updated_at before update on workspaces for each row execute function set_updated_at();

drop trigger if exists set_projects_updated_at on projects;
create trigger set_projects_updated_at before update on projects for each row execute function set_updated_at();

drop trigger if exists set_characters_updated_at on characters;
create trigger set_characters_updated_at before update on characters for each row execute function set_updated_at();

drop trigger if exists set_locations_updated_at on locations;
create trigger set_locations_updated_at before update on locations for each row execute function set_updated_at();

drop trigger if exists set_props_updated_at on props;
create trigger set_props_updated_at before update on props for each row execute function set_updated_at();

drop trigger if exists set_episodes_updated_at on episodes;
create trigger set_episodes_updated_at before update on episodes for each row execute function set_updated_at();

drop trigger if exists set_scripts_updated_at on scripts;
create trigger set_scripts_updated_at before update on scripts for each row execute function set_updated_at();

drop trigger if exists set_shots_updated_at on shots;
create trigger set_shots_updated_at before update on shots for each row execute function set_updated_at();
