-- Run this once in Supabase's SQL editor, AFTER 01_tables.sql.
-- Two functions that keep the fetch limits and the "replace live data" step safe and in one piece.

create or replace function begin_fetch(
  p_email text,
  p_limit integer,
  p_window_hours integer,
  p_cooldown_seconds integer,
  p_lock_minutes integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  u users%rowtype;
  v_wait integer;
  v_reset timestamptz;
  v_run_id bigint;
  v_locked integer;
begin
  select * into u from users where email = p_email for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_user');
  end if;

  -- A finished 24-hour window starts over.
  if u.window_start is not null and now() >= u.window_start + make_interval(hours => p_window_hours) then
    update users set window_start = null, fetches_used = 0 where email = p_email;
    u.window_start := null;
    u.fetches_used := 0;
  end if;

  if u.fetches_used >= p_limit then
    v_reset := u.window_start + make_interval(hours => p_window_hours);
    insert into fetch_log (email, status, finished_at) values (p_email, 'rejected_limit', now());
    return jsonb_build_object('ok', false, 'reason', 'limit', 'reset_at', v_reset);
  end if;

  if u.last_fetch_at is not null and now() < u.last_fetch_at + make_interval(secs => p_cooldown_seconds) then
    v_wait := ceil(extract(epoch from (u.last_fetch_at + make_interval(secs => p_cooldown_seconds) - now())))::integer;
    insert into fetch_log (email, status, finished_at) values (p_email, 'rejected_cooldown', now());
    return jsonb_build_object('ok', false, 'reason', 'cooldown', 'wait_seconds', v_wait);
  end if;

  -- Only one fetch at a time: take the lock if nobody holds it (or it has expired).
  update app_state
     set value = (now() + make_interval(mins => p_lock_minutes))::text, updated_at = now()
   where key = 'fetch_lock_until'
     and (value is null or value::timestamptz <= now());
  get diagnostics v_locked = row_count;
  if v_locked = 0 then
    insert into fetch_log (email, status, finished_at) values (p_email, 'rejected_busy', now());
    return jsonb_build_object('ok', false, 'reason', 'busy');
  end if;

  update users set last_fetch_at = now() where email = p_email;
  insert into fetch_log (email, status) values (p_email, 'running') returning id into v_run_id;
  return jsonb_build_object('ok', true, 'run_id', v_run_id);
end;
$$;

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

  -- The live data switches in one step, and only when everything succeeded.
  if p_status = 'success' and p_live_ids is not null then
    update reviews set in_live_set = (review_id = any(p_live_ids));
    update app_state set value = p_run_id::text, updated_at = now() where key = 'live_run_id';
    update app_state set value = now()::text, updated_at = now() where key = 'last_fetched_at';
  end if;

  update app_state set value = null, updated_at = now() where key = 'fetch_lock_until';
end;
$$;

-- Only the app's backend (service role) may call these.
revoke all on function begin_fetch(text, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function end_fetch(bigint, text, text, boolean, text[], jsonb) from public, anon, authenticated;
grant execute on function begin_fetch(text, integer, integer, integer, integer) to service_role;
grant execute on function end_fetch(bigint, text, text, boolean, text[], jsonb) to service_role;
