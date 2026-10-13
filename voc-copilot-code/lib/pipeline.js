'use strict';
// Pure steps of the fetch (no network, no database): selection, tagging results, scoring, recommendations.
const defaults = require('../settings');
const P = require('../prompts');
const U = require('./util');

// D20: keep only critical reviews (low rating, enough words). Text is masked first (D21).
function selectCritical(rawList, s) {
  s = s || defaults;
  const list = Array.isArray(rawList) ? rawList : [];
  const times = list.map((r) => (r && r.date ? new Date(r.date).getTime() : NaN)).filter((n) => !isNaN(n));
  const windowOldest = times.length ? new Date(Math.min(...times)).toISOString() : null;
  const windowNewest = times.length ? new Date(Math.max(...times)).toISOString() : null;
  const matching = [];

  for (const r of list) {
    if (!r || !r.id || typeof r.score !== 'number') continue;
    if (r.score > s.complaint_max_rating) continue;
    const text = U.maskText(r.text);
    if (U.wordCount(text) < s.min_words) continue;
    const d = r.date ? new Date(r.date) : null;
    matching.push({
      review_id: String(r.id),
      rating: r.score,
      review_text: text,
      review_date: d && !isNaN(d.getTime()) ? d.toISOString() : null,
      thumbs_up: Number(r.thumbsUp) || 0
    });
  }

  matching.sort((a, b) => (b.review_date || '').localeCompare(a.review_date || ''));
  return { fetched: list.length, windowOldest, windowNewest, matching };
}

// Exact duplicates (same text) are kept but not analyzed.
function markDuplicates(rows) {
  const seen = new Set();
  return rows.map((r) => {
    const key = U.normalizeForMatch(r.review_text);
    if (seen.has(key)) return { ...r, is_analyzable: false, exclusion_reason: 'duplicate' };
    seen.add(key);
    return { ...r, is_analyzable: true, exclusion_reason: null };
  });
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Token Saver: Truncates review text to 220 chars to prevent massive token burn on rants
function buildTaggingInput(rows) {
  return JSON.stringify(rows.map((r) => ({
    review_id: r.review_id,
    rating: r.rating,
    text: r.review_text.length > 220 ? r.review_text.slice(0, 220) + '...' : r.review_text
  })));
}

function unclassifiedTag(row, s) {
  return {
    review_id: row.review_id, taxonomy_version: s.taxonomy_version, prompt_version: s.prompt_version,
    category: 'unclassified', sub_issue: null, sentiment: null, severity: null,
    churn_signal: false, churn_type: null, confidence: 0, quote: null, quote_verified: false
  };
}

// Turns the AI's answer into tag rows (checks 10.7: category list, confidence, quote check).
function interpretTagging(rows, aiItems, s) {
  s = s || defaults;
  const byId = new Map();
  if (Array.isArray(aiItems)) {
    for (const it of aiItems) if (it && typeof it.review_id === 'string') byId.set(it.review_id, it);
  }

  const tags = [];
  const nonEnglish = [];
  let failed = 0;

  for (const row of rows) {
    const it = byId.get(row.review_id);
    if (!it || typeof it.analyzable !== 'boolean') { tags.push(unclassifiedTag(row, s)); failed++; continue; }
    if (it.analyzable === false) {
      if (it.skip_reason === 'non_english') nonEnglish.push(row.review_id);
      else { tags.push(unclassifiedTag(row, s)); failed++; }
      continue;
    }

    let category = P.AI_CATEGORY_IDS.includes(it.category) ? it.category : 'unclassified';
    let confidence = Number(it.confidence);
    if (isNaN(confidence)) confidence = 0;
    confidence = Math.min(1, Math.max(0, confidence));
    if (confidence < s.min_confidence) category = 'unclassified';

    const sev = Number(it.severity);
    const churnSignal = it.churn_signal === true;
    let churnType = P.CHURN_TYPES.includes(it.churn_type) ? it.churn_type : null;
    if (churnSignal && !churnType) churnType = 'other';
    if (!churnSignal) churnType = null;
    const quote = typeof it.quote === 'string' && it.quote.trim() ? it.quote.trim() : null;

    tags.push({
      review_id: row.review_id, taxonomy_version: s.taxonomy_version, prompt_version: s.prompt_version,
      category,
      sub_issue: typeof it.sub_issue === 'string' ? it.sub_issue.slice(0, 80) : null,
      sentiment: ['negative', 'neutral', 'positive'].includes(it.sentiment) ? it.sentiment : null,
      severity: [1, 2, 3].includes(sev) ? sev : null,
      churn_signal: churnSignal, churn_type: churnType,
      confidence: U.round2(confidence),
      quote,
      quote_verified: quote ? U.quoteIsVerified(quote, row.review_text) : false
    });
  }

  return { tags, nonEnglish, failed };
}

// Module E: counts, shares, score and rank. Rows: {review_id, category, severity, churn_signal, quote_verified, confidence, thumbs_up}
function aggregate(rows, s) {
  s = s || defaults;
  const total = rows.length;
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.category)) groups.set(r.category, []);
    groups.get(r.category).push(r);
  }

  const out = [];
  for (const [category, list] of groups) {
    const count = list.length;
    const sevs = list.filter((r) => r.severity != null).map((r) => r.severity);
    const sevAvg = sevs.length ? sevs.reduce((a, b) => a + b, 0) / sevs.length : null;
    const churnShare = list.filter((r) => r.churn_signal).length / count;
    const pct = total ? (count / total) * 100 : 0;
    const eligible = category !== 'unclassified' && category !== 'other' && count >= s.min_cluster_size && sevAvg !== null;
    const trend = 1.0;
    const score = eligible ? pct * sevAvg * trend * (1 + churnShare) : null;
    const topQuoteIds = list
      .filter((r) => r.quote_verified)
      .sort((a, b) => (b.severity || 0) - (a.severity || 0) || (b.confidence || 0) - (a.confidence || 0) || (b.thumbs_up || 0) - (a.thumbs_up || 0))
      .slice(0, 3) // Token saver: prioritize top 3 evidence quotes instead of 5
      .map((r) => r.review_id);

    out.push({
      category, review_count: count, pct_of_analyzable: U.round2(pct),
      severity_avg: sevAvg === null ? null : U.round2(sevAvg),
      churn_share: U.round3(churnShare), trend_multiplier: trend,
      score: score === null ? null : U.round2(score), rank: null, top_quote_ids: topQuoteIds,
      _score: score, _sev: sevAvg || 0
    });
  }

  const ranked = out.filter((i) => i._score !== null)
    .sort((a, b) => b._score - a._score || b._sev - a._sev || b.review_count - a.review_count);
  ranked.forEach((i, idx) => { i.rank = idx + 1; });

  return out.map(({ _score, _sev, ...rest }) => rest);
}

function labelOf(id) {
  const c = P.CATEGORIES.find((x) => x.id === id);
  return c ? c.label : id;
}

// 10.6 input: compacted to reduce input tokens to the recommendation call
function buildRecoInput(topInsights, totalAnalyzed, quoteMap) {
  return {
    issues: topInsights.map((i) => ({
      rank: i.rank,
      category: i.category,
      category_label: labelOf(i.category),
      review_count: i.review_count,
      total_analyzed: totalAnalyzed,
      percent: U.round1(i.pct_of_analyzable),
      severity_average: U.round1(i.severity_avg),
      churn_count: Math.round(i.churn_share * i.review_count),
      churn_share: U.round2(i.churn_share),
      score: U.round1(i.score),
      quotes: (i.top_quote_ids || []).map((id) => {
        const q = quoteMap.get(id);
        return {
          review_id: id,
          quote: q && q.length > 140 ? q.slice(0, 140) + '...' : q
        };
      }).filter((q) => q.quote)
    }))
  };
}

// 10.7 checks on recommendation text: structure, numbers, evidence ids.
function validateReco(items, input) {
  const problems = [];
  let invented = 0;
  const rows = [];
  if (!Array.isArray(items)) return { ok: false, problems: ['not a list'], invented: 0, rows };

  const allowedText = JSON.stringify(input, (k, v) => (k === 'review_id' ? undefined : v));

  for (const issue of input.issues) {
    const it = items.find((x) => x && Number(x.rank) === issue.rank && x.category === issue.category);
    if (!it) { problems.push('missing issue ' + issue.rank); continue; }

    const fields = ['rationale', 'suggested_action', 'metric_to_watch'];
    if (fields.some((f) => typeof it[f] !== 'string' || !it[f].trim())) {
      problems.push('missing text for ' + issue.rank);
      continue;
    }

    const bad = U.findInventedNumbers(fields.map((f) => it[f]), allowedText);
    if (bad.length) {
      invented += bad.length;
      problems.push('invented numbers for ' + issue.rank);
      continue;
    }

    const ids = Array.isArray(it.evidence_review_ids) ? it.evidence_review_ids.map(String) : [];
    const allowedIds = new Set(issue.quotes.map((q) => q.review_id));
    if (!ids.length || ids.some((id) => !allowedIds.has(id))) {
      problems.push('bad evidence for ' + issue.rank);
      continue;
    }

    rows.push({
      rank: issue.rank,
      category: issue.category,
      rationale: it.rationale.trim(),
      suggested_action: it.suggested_action.trim(),
      metric_to_watch: it.metric_to_watch.trim(),
      evidence_review_ids: ids.slice(0, 3)
    });
  }

  return { ok: problems.length === 0, problems, invented, rows };
}

module.exports = {
  selectCritical, markDuplicates, chunk, buildTaggingInput, interpretTagging,
  aggregate, buildRecoInput, validateReco, unclassifiedTag, labelOf
};
