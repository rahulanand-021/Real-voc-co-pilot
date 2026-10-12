'use strict';
// Everything the dashboard shows: the last successful fetch (shared by everyone) and this email's fetch allowance.
const S = require('../settings');
const P = require('../prompts');
const U = require('../lib/util');
const { computeQuota } = require('../lib/quota');
const { send } = require('../lib/http');
const { getDb } = require('../lib/supabase');
const store = require('../lib/store');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Use GET.' });
  const url = new URL(req.url, 'http://localhost');
  const email = U.normalizeEmail(url.searchParams.get('email') || '');
  if (!email) return send(res, 401, { ok: false, reason: 'not_signed_in', error: 'Please enter a valid email address.' });
  try {
    const db = getDb();
    const user = await store.getUser(db, email);
    if (!user) return send(res, 401, { ok: false, reason: 'not_signed_in', error: 'Please sign in with your email.' });
    const quota = computeQuota(user, S);
    const state = await store.getAppState(db);
    const liveRunId = state.live_run_id ? Number(state.live_run_id) : null;

    let run = null;
    let reviews = [];
    let insights = [];
    let recommendations = [];
    if (liveRunId) {
      run = await store.getLiveRun(db, liveRunId);
      const revRows = await store.getLiveReviews(db);
      const tags = await store.getTags(db, revRows.map((r) => r.review_id), S);
      const tagMap = new Map(tags.map((t) => [t.review_id, t]));
      reviews = revRows.map((r) => {
        const t = tagMap.get(r.review_id) || {};
        return {
          review_id: r.review_id, rating: r.rating, text: r.review_text, date: r.review_date,
          thumbs_up: r.thumbs_up, is_analyzable: r.is_analyzable, exclusion_reason: r.exclusion_reason,
          category: t.category || null, sub_issue: t.sub_issue || null, severity: t.severity || null,
          churn_signal: t.churn_signal === true, churn_type: t.churn_type || null,
          confidence: t.confidence == null ? null : Number(t.confidence),
          quote: t.quote_verified ? t.quote : null
        };
      });
      insights = await store.getInsights(db, liveRunId);
      recommendations = await store.getRecommendations(db, liveRunId);
    }

    return send(res, 200, {
      ok: true,
      has_data: !!liveRunId,
      last_fetched_at: state.last_fetched_at || null,
      run,
      user: { email, ...quota },
      settings: {
        fetch_window: S.fetch_window, complaint_max_rating: S.complaint_max_rating, min_words: S.min_words,
        min_cluster_size: S.min_cluster_size, excluded_warning_pct: S.excluded_warning_pct,
        quote_max_chars_on_card: S.quote_max_chars_on_card, fetch_cooldown_seconds: S.fetch_cooldown_seconds,
        fetch_limit_per_window: S.fetch_limit_per_window, window_hours: S.window_hours
      },
      categories: P.CATEGORIES.map((c) => ({ id: c.id, label: c.label })),
      reviews, insights, recommendations
    });
  } catch (e) {
    console.error('dashboard failed:', e && e.message ? e.message : e);
    return send(res, 500, { ok: false, error: 'The service is not available right now. Please try again later.' });
  }
};
