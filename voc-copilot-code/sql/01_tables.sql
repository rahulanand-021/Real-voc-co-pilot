-- PRD section 5A: run this once in Supabase's SQL editor (skip if you already did).
create table users (
  email text primary key,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  window_start timestamptz,
  fetches_used integer not null default 0,
  last_fetch_at timestamptz,
  total_fetches integer not null default 0
);

create table fetch_log (
  id bigint generated always as identity primary key,
  email text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('running','success','failed_before_analysis','failed_after_analysis','rejected_limit','rejected_cooldown','rejected_busy')),
  counted boolean not null default false,
  reviews_fetched integer,
  reviews_matching integer,
  reviews_selected integer,
  window_oldest timestamptz,
  window_newest timestamptz,
  new_reviews_analyzed integer,
  cost_estimate numeric(10,4),
  duration_seconds numeric(8,2),
  quote_pass_rate numeric(5,2),
  invented_numbers_caught integer,
  error_message text
);

create table app_state (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);
insert into app_state (key, value) values ('live_run_id', null), ('last_fetched_at', null), ('fetch_lock_until', null);

create table reviews (
  review_id text primary key,
  rating integer not null check (rating between 1 and 5),
  review_text text,
  review_date timestamptz,
  thumbs_up integer not null default 0,
  language text,
  is_analyzable boolean not null default true,
  exclusion_reason text check (exclusion_reason in ('empty','too_short','non_english','duplicate')),
  in_live_set boolean not null default false,
  fetched_at timestamptz not null default now()
);

create table tags (
  review_id text not null references reviews(review_id) on delete cascade,
  taxonomy_version text not null,
  prompt_version text not null,
  category text not null,
  sub_issue text,
  sentiment text check (sentiment in ('negative','neutral','positive')),
  severity integer check (severity between 1 and 3),
  churn_signal boolean not null default false,
  churn_type text check (churn_type in ('uninstall','competitor','refund_or_closure','last_chance','other')),
  confidence numeric(3,2) check (confidence between 0 and 1),
  quote text,
  quote_verified boolean not null default false,
  primary key (review_id, taxonomy_version, prompt_version)
);

create table insights (
  run_id bigint not null references fetch_log(id),
  category text not null,
  review_count integer not null,
  pct_of_analyzable numeric(5,2) not null,
  severity_avg numeric(3,2),
  churn_share numeric(4,3),
  trend_multiplier numeric(3,2) not null default 1.00,
  score numeric(8,2),
  rank integer,
  top_quote_ids text[],
  primary key (run_id, category)
);

create table recommendations (
  run_id bigint not null references fetch_log(id),
  rank integer not null check (rank between 1 and 3),
  category text not null,
  rationale text,
  suggested_action text,
  metric_to_watch text,
  evidence_review_ids text[],
  primary key (run_id, rank)
);

create table benchmark_set (
  review_id text primary key references reviews(review_id)
);

create table gold_labels (
  review_id text primary key references benchmark_set(review_id),
  category text not null,
  severity integer check (severity between 1 and 3),
  churn_signal boolean not null
);

-- Privacy: only the app's backend (service-role key) may read or write.
alter table users enable row level security;
alter table fetch_log enable row level security;
alter table app_state enable row level security;
alter table reviews enable row level security;
alter table tags enable row level security;
alter table insights enable row level security;
alter table recommendations enable row level security;
alter table benchmark_set enable row level security;
alter table gold_labels enable row level security;
