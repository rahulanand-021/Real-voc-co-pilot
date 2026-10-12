'use strict';
// The "Fetch Play Store reviews" button (PRD J4, Modules A to F, H).
const S = require('../settings');
const P = require('../prompts');
const U = require('../lib/util');
const PL = require('../lib/pipeline');
const { send, readBody } = require('../lib/http');
const { getDb } = require('../lib/supabase');
const store = require('../lib/store');
const { fetchNewestReviews } = require('../lib/play');
const { askJson, AiError } = require('../lib/gemini');

function withKind(err, kind) { err.kind = kind; return err; }
const isArray = (x) => Array.isArray(x);

async function makeRecommendations({ apiKey, input, stats, deadline }) {
  const have = new Map();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (Date.now() > deadline) break;
    let items;
    try {
      items = await askJson({
        apiKey, model: S.ai_model, temperature: S.ai_temperature,
        systemText: P.RECOMMENDATION_INSTRUCTIONS, userText: 'Issues:\n' + JSON.stringify(input),
        schema: P.RECOMMENDATION_SCHEMA
      }, isArray);
    } catch (e) {
      console.error('Recommendation call failed:', e && e.message ? e.message : e);
      break;
    }
    const v = PL.validateReco(items, input);
    stats.invented_numbers_caught += v.invented;
    v.rows.forEach((r) => have.set(r.rank, r));
    if (v.ok) break;
  }
  // Anything that never passed the checks becomes "Recommendation text unavailable" on screen.
  return input.issues.map((i) => have.get(i.rank) ||
    { rank: i.rank, category: i.category, rationale: null, suggested_action: null, metric_to_watch: null, evidence_review_ids: [] });
}

async function runFetch({ db, runId, stats, deadline, markStarted }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('Missing environment variable: GEMINI_API_KEY');
    throw withKind(new Error('Analysis service not configured'), 'config');
  }

  // 1. Read the newest reviews and keep the critical ones (D20, D21).
  let raw;
  try { raw = await fetchNewestReviews(S); } catch (e) { throw withKind(new Error('Play Store fetch failed'), 'playstore'); }
  const sel = PL.selectCritical(raw, S);
  stats.reviews_fetched = sel.fetched;
  stats.reviews_matching = sel.matching.length;
  stats.reviews_selected = sel.matching.length;
  stats.window_oldest = sel.windowOldest;
  stats.window_newest = sel.windowNewest;

  // 2. Save them (the live switch happens only at the very end).
  let rows = PL.markDuplicates(sel.matching);
  const ids = rows.map((r) => r.review_id);
  const existing = await store.getExistingReviews(db, ids);
  const existingMap = new Map(existing.map((e) => [e.review_id, e]));
  // "New" means not in the data currently shown on the dashboard (a failed earlier fetch may have saved reviews already).
  const liveIds = new Set(await store.getLiveIds(db));
  const newCount = ids.filter((id) => !liveIds.has(id)).length;
  rows = rows.map((r) => {
    const ex = existingMap.get(r.review_id);
    return ex && ex.exclusion_reason === 'non_english' ? { ...r, is_analyzable: false, exclusion_reason: 'non_english' } : r;
  });
  await store.upsertReviews(db, rows);

  // 3. Label only reviews that have no saved label yet.
  const analyzable = rows.filter((r) => r.is_analyzable);
  const cachedTags = await store.getTags(db, analyzable.map((r) => r.review_id), S);
  const cachedIds = new Set(cachedTags.map((t) => t.review_id));
  const toTag = analyzable.filter((r) => !cachedIds.has(r.review_id));
  stats.new_reviews_analyzed = toTag.length;

  const system = P.buildTaggingSystem();
  const newTags = [];
  const nonEnglish = [];
  let quoteTotal = 0;
  let quoteOk = 0;
  for (const batch of PL.chunk(toTag, S.tag_batch_size)) {
    if (Date.now() > deadline) throw withKind(new Error('Fetch took too long'), 'timeout');
    let aiItems = null;
    try {
      aiItems = await askJson({
        apiKey, model: S.ai_model, temperature: S.ai_temperature, systemText: system,
        userText: 'Reviews to label:\n' + PL.buildTaggingInput(batch), schema: P.TAGGING_SCHEMA
      }, isArray);
    } catch (e) {
      if (e instanceof AiError && e.kind === 'bad_answer') aiItems = null; // those reviews become "unclassified"
      else throw withKind(e, e instanceof AiError && e.kind === 'config' ? 'config' : 'ai_busy');
    }
    markStarted();
    const r = PL.interpretTagging(batch, aiItems, S);
    for (const t of r.tags) {
      if (t.quote) { quoteTotal++; if (t.quote_verified) quoteOk++; }
      newTags.push(t);
    }
    nonEnglish.push(...r.nonEnglish);
  }
  markStarted(); // analysis counts as started even when every label was already saved
  await store.saveTags(db, newTags);
  await store.markNonEnglish(db, nonEnglish);
  stats.quote_pass_rate = quoteTotal ? U.round2((quoteOk / quoteTotal) * 100) : null;

  // 4. Count, score and rank (Module E).
  const nonEnglishSet = new Set(nonEnglish);
  const tagMap = new Map(cachedTags.concat(newTags).map((t) => [t.review_id, t]));
  const aggRows = [];
  for (const r of analyzable) {
    if (nonEnglishSet.has(r.review_id)) continue;
    const t = tagMap.get(r.review_id);
    if (!t) continue;
    aggRows.push({
      review_id: r.review_id, category: t.category, severity: t.severity, churn_signal: t.churn_signal === true,
      quote_verified: t.quote_verified === true, confidence: Number(t.confidence) || 0, thumbs_up: r.thumbs_up
    });
  }
  const insights = PL.aggregate(aggRows, S);
  const top = insights.filter((i) => i.rank !== null && i.rank <= 3).sort((a, b) => a.rank - b.rank);

  // 5. Recommendations for the top 3 (Module F).
  let recos = [];
  if (top.length) {
    const quoteMap = new Map(cachedTags.concat(newTags).filter((t) => t.quote && t.quote_verified).map((t) => [t.review_id, t.quote]));
    const input = PL.buildRecoInput(top, aggRows.length, quoteMap);
    recos = await makeRecommendations({ apiKey, input, stats, deadline });
  }
  await store.saveInsights(db, runId, insights);
  await store.saveRecommendations(db, runId, recos);

  let message;
  if (rows.length === 0) message = 'Only 0 critical reviews were found in the latest ' + S.fetch_window + '.';
  else if (newCount === 0) message = 'No new reviews since last fetch.';
  else message = 'Loaded ' + rows.length + ' reviews.';
  return { liveIds: ids, message, benchmarkIds: aggRows.map((r) => r.review_id) };
}

const MESSAGES = {
  config: 'Analysis service not configured.',
  playstore: 'Could not reach the Play Store. Please try again later.',
  timeout: 'The fetch took too long. Please try again.',
  ai_busy: 'The analysis service is busy. Please try again in a minute.',
  db: 'The database is not available. Please try again later.'
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST.' });
  const startedAt = Date.now();
  const deadline = startedAt + 50000; // stop safely before Vercel's 60 second limit
  const body = await readBody(req);
  const email = U.normalizeEmail(body.email);
  if (!email) return send(res, 400, { ok: false, error: 'Please enter a valid email address.' });

  let db;
  try { db = getDb(); } catch (e) { return send(res, 500, { ok: false, error: 'The service is not configured yet.' }); }

  // Server-side limits: 3 fetches per 24 hours, 10 seconds apart, one fetch at a time (Module H).
  let begin;
  try {
    const user = await store.getUser(db, email);
    if (!user) return send(res, 401, { ok: false, reason: 'not_signed_in', error: 'Please sign in with your email.' });
    begin = await store.beginFetch(db, email, S);
  } catch (e) {
    return send(res, 500, { ok: false, error: MESSAGES.db });
  }
  if (!begin || !begin.ok) {
    const reason = begin && begin.reason;
    if (reason === 'limit') return send(res, 429, { ok: false, reason, reset_at: begin.reset_at, error: "You've used all " + S.fetch_limit_per_window + ' fetches for today.' });
    if (reason === 'cooldown') return send(res, 429, { ok: false, reason, wait_seconds: begin.wait_seconds, error: 'Please wait ' + begin.wait_seconds + ' seconds before fetching again.' });
    if (reason === 'busy') return send(res, 429, { ok: false, reason, error: 'A fetch is already running. Please try again in a moment.' });
    return send(res, 500, { ok: false, error: 'Could not start the fetch.' });
  }

  const runId = begin.run_id;
  const stats = { invented_numbers_caught: 0, cost_estimate: null };
  let analysisStarted = false;
  try {
    const out = await runFetch({ db, runId, stats, deadline, markStarted: () => { analysisStarted = true; } });
    stats.duration_seconds = (Date.now() - startedAt) / 1000;
    await store.endFetch(db, { runId, email, status: 'success', counted: true, liveIds: out.liveIds, stats });
    // A7: the first successful fetch saves its analyzed reviews as the benchmark set (never changed by later fetches).
    try {
      if (await store.benchmarkIsEmpty(db)) await store.saveBenchmark(db, out.benchmarkIds);
    } catch (e) { console.error('Could not save the benchmark set:', e && e.message ? e.message : e); }
    return send(res, 200, { ok: true, message: out.message, loaded: out.liveIds.length });
  } catch (e) {
    const kind = e && e.kind ? e.kind : 'other';
    console.error('Fetch failed (' + kind + '):', e && e.message ? e.message : e);
    stats.duration_seconds = (Date.now() - startedAt) / 1000;
    stats.error_message = String(e && e.message ? e.message : e).slice(0, 300);
    // A fetch counts once analysis has started, except for configuration problems and time-outs.
    const counted = analysisStarted && kind !== 'config' && kind !== 'timeout';
    try {
      await store.endFetch(db, { runId, email, status: analysisStarted ? 'failed_after_analysis' : 'failed_before_analysis', counted, liveIds: null, stats });
    } catch (e2) { console.error('Could not close the fetch record:', e2 && e2.message ? e2.message : e2); }
    return send(res, 500, { ok: false, error: MESSAGES[kind] || 'Fetch failed. Please try again later.' });
  }
};
