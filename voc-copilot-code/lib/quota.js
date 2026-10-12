'use strict';

// Works out what a signed-in email may do right now (PRD Module H). Pure function.
function computeQuota(user, s, now) {
  const t = (now || new Date()).getTime();
  const windowMs = s.window_hours * 3600 * 1000;
  let used = (user && user.fetches_used) || 0;
  let windowStart = user && user.window_start ? new Date(user.window_start).getTime() : null;
  if (windowStart !== null && t >= windowStart + windowMs) {
    used = 0;
    windowStart = null;
  }
  const resetAt = windowStart !== null && used > 0 ? new Date(windowStart + windowMs).toISOString() : null;
  let wait = 0;
  if (user && user.last_fetch_at) {
    const until = new Date(user.last_fetch_at).getTime() + s.fetch_cooldown_seconds * 1000;
    wait = Math.max(0, Math.ceil((until - t) / 1000));
  }
  return {
    limit: s.fetch_limit_per_window,
    fetches_left: Math.max(0, s.fetch_limit_per_window - used),
    limit_reached: used >= s.fetch_limit_per_window,
    reset_at: resetAt,
    wait_seconds: wait
  };
}

module.exports = { computeQuota };
