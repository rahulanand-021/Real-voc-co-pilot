-- ONLY for a database you already created with the earlier files (01 and 02).
-- Run this once in Supabase's SQL editor. It makes every email keep its own fetch results.
-- (A brand-new database does not need this file: 01_tables.sql and 02_functions.sql already include it.)

alter table users add column if not exists live_run_id bigint references fetch_log(id);

create table if not exists run_reviews (
  run_id bigint not null references fetch_log(id),
  review_id text not null references reviews(review_id),
  primary key (run_id, review_id)
);
alter table run_reviews enable row level security;

create or replace function end_fetch(
  p_run_id bigint,
  p_email text,
  p_status text,
  p_counted boolean,
  p_live_ids text[],
  p_stats jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update fetch_log set
    status = p_status,
    counted = p_counted,
    finished_at = now(),
    reviews_fetched = (p_stats->>'reviews_fetched')::integer,
    reviews_matching = (p_stats->>'reviews_matching')::integer,
    reviews_selected = (p_stats->>'reviews_selected')::integer,
    window_oldest = (p_stats->>'window_oldest')::timestamptz,
    window_newest = (p_stats->>'window_newest')::timestamptz,
    new_reviews_analyzed = (p_stats->>'new_reviews_analyzed')::integer,
    cost_estimate = (p_stats->>'cost_estimate')::numeric,
    duration_seconds = (p_stats->>'duration_seconds')::numeric,
    quote_pass_rate = (p_stats->>'quote_pass_rate')::numeric,
    invented_numbers_caught = (p_stats->>'invented_numbers_caught')::integer,
    error_message = p_stats->>'error_message'
  where id = p_run_id;

  -- A counted fetch uses one of the 3 and starts the 24-hour window if none is running.
  if p_counted and p_email is not null then
    update users set
      window_start = coalesce(window_start, now()),
      fetches_used = fetches_used + 1,
      total_fetches = total_fetches + 1
    where email = p_email;
  end if;

  -- Each email keeps its own data: link this fetch's reviews to the fetch, and make it
  -- this email's live fetch. This happens in one step, and only when everything succeeded.
  if p_status = 'success' and p_live_ids is not null and p_email is not null then
    insert into run_reviews (run_id, review_id)
      select p_run_id, unnest(p_live_ids)
      on conflict do nothing;
    update users set live_run_id = p_run_id where email = p_email;
  end if;

  update app_state set value = null, updated_at = now() where key = 'fetch_lock_until';
end;
$$;

-- Only the app's backend (service role) may call these.
revoke all on function begin_fetch(text, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function end_fetch(bigint, text, text, boolean, text[], jsonb) from public, anon, authenticated;
grant execute on function begin_fetch(text, integer, integer, integer, integer) to service_role;
grant execute on function end_fetch(bigint, text, text, boolean, text[], jsonb) to service_role;

-- Keep the data from the fetch that is already on screen: give it to the email that made it.
insert into run_reviews (run_id, review_id)
select (select value::bigint from app_state where key = 'live_run_id'), review_id
from reviews
where in_live_set = true
  and (select value from app_state where key = 'live_run_id') is not null
on conflict do nothing;

update users
   set live_run_id = (select value::bigint from app_state where key = 'live_run_id')
 where email = (select email from fetch_log where id = (select value::bigint from app_state where key = 'live_run_id'));
