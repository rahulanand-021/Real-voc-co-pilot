'use strict';
// All database reads and writes (tables and functions from PRD section 5A and sql/02_functions.sql).

function check(result, what) {
  if (result.error) {
    console.error('Database error while ' + what + ':', result.error.message);
    const e = new Error('Database error: ' + what);
    e.kind = 'db';
    throw e;
  }
  return result.data;
}

async function upsertUser(db, email) {
  check(await db.from('users').upsert({ email, last_seen_at: new Date().toISOString() }, { onConflict: 'email' }), 'saving the email');
}

async function getUser(db, email) {
  return check(await db.from('users').select('*').eq('email', email).maybeSingle(), 'reading the email record');
}

async function getAppState(db) {
  const rows = check(await db.from('app_state').select('key,value'), 'reading app state') || [];
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

async function beginFetch(db, email, s) {
  return check(await db.rpc('begin_fetch', {
    p_email: email, p_limit: s.fetch_limit_per_window, p_window_hours: s.window_hours,
    p_cooldown_seconds: s.fetch_cooldown_seconds, p_lock_minutes: s.fetch_lock_minutes
  }), 'starting the fetch');
}

async function endFetch(db, { runId, email, status, counted, liveIds, stats }) {
  check(await db.rpc('end_fetch', {
    p_run_id: runId, p_email: email, p_status: status, p_counted: counted,
    p_live_ids: liveIds || null, p_stats: stats || {}
  }), 'finishing the fetch');
}

async function getExistingReviews(db, ids) {
  if (!ids.length) return [];
  return check(await db.from('reviews').select('review_id,is_analyzable,exclusion_reason').in('review_id', ids), 'checking saved reviews') || [];
}

async function upsertReviews(db, rows) {
  if (!rows.length) return;
  const payload = rows.map((r) => ({
    review_id: r.review_id, rating: r.rating, review_text: r.review_text, review_date: r.review_date,
    thumbs_up: r.thumbs_up, is_analyzable: r.is_analyzable, exclusion_reason: r.exclusion_reason
  }));
  check(await db.from('reviews').upsert(payload, { onConflict: 'review_id' }), 'saving reviews');
}

async function markNonEnglish(db, ids) {
  if (!ids.length) return;
  check(await db.from('reviews').update({ is_analyzable: false, exclusion_reason: 'non_english' }).in('review_id', ids), 'marking non-English reviews');
}

async function getTags(db, ids, s) {
  if (!ids.length) return [];
  return check(await db.from('tags').select('*').in('review_id', ids)
    .eq('taxonomy_version', s.taxonomy_version).eq('prompt_version', s.prompt_version), 'reading saved labels') || [];
}

async function saveTags(db, tags) {
  if (!tags.length) return;
  check(await db.from('tags').upsert(tags, { onConflict: 'review_id,taxonomy_version,prompt_version' }), 'saving labels');
}

async function saveInsights(db, runId, insights) {
  if (!insights.length) return;
  check(await db.from('insights').insert(insights.map((i) => ({ run_id: runId, ...i }))), 'saving insights');
}

async function saveRecommendations(db, runId, recos) {
  if (!recos.length) return;
  check(await db.from('recommendations').insert(recos.map((r) => ({ run_id: runId, ...r }))), 'saving recommendations');
}

async function getLiveRun(db, runId) {
  return check(await db.from('fetch_log').select('reviews_fetched,reviews_matching,reviews_selected,window_oldest,window_newest,finished_at').eq('id', runId).maybeSingle(), 'reading the last fetch');
}

async function getLiveReviews(db) {
  return check(await db.from('reviews').select('review_id,rating,review_text,review_date,thumbs_up,is_analyzable,exclusion_reason')
    .eq('in_live_set', true).order('review_date', { ascending: false }), 'reading reviews') || [];
}

async function getLiveIds(db) {
  const rows = check(await db.from('reviews').select('review_id').eq('in_live_set', true), 'reading the live reviews') || [];
  return rows.map((r) => r.review_id);
}

async function benchmarkIsEmpty(db) {
  const rows = check(await db.from('benchmark_set').select('review_id').limit(1), 'reading the benchmark set');
  return !rows || rows.length === 0;
}

async function saveBenchmark(db, ids) {
  if (!ids.length) return;
  check(await db.from('benchmark_set').upsert(ids.map((id) => ({ review_id: id })), { onConflict: 'review_id' }), 'saving the benchmark set');
}

async function getInsights(db, runId) {
  return check(await db.from('insights').select('*').eq('run_id', runId), 'reading insights') || [];
}

async function getRecommendations(db, runId) {
  return check(await db.from('recommendations').select('*').eq('run_id', runId).order('rank', { ascending: true }), 'reading recommendations') || [];
}

module.exports = {
  upsertUser, getUser, getAppState, beginFetch, endFetch, getExistingReviews, upsertReviews, markNonEnglish,
  getTags, saveTags, saveInsights, saveRecommendations, getLiveRun, getLiveReviews, getLiveIds, benchmarkIsEmpty, saveBenchmark, getInsights, getRecommendations
};
