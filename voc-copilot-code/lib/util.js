'use strict';

// Email: trimmed, lowercase, one "@", a domain with a dot, no spaces, at most 254 characters.
function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (!e || e.length > 254 || /\s/.test(e)) return null;
  const parts = e.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const domain = parts[1];
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return null;
  return e;
}

// D21: mask email addresses and any run of 6 or more digits before saving or sending to the AI.
function maskText(text) {
  return String(text || '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\d{6,}/g, '[number]');
}

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function normalizeForMatch(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Quote must appear in the review text (case-insensitive, extra spaces ignored).
function quoteIsVerified(quote, text) {
  const q = normalizeForMatch(quote);
  return q.length > 0 && normalizeForMatch(text).includes(q);
}

function numbersIn(s) {
  return String(s || '').match(/\d+(?:\.\d+)?/g) || [];
}

// Numbers in the texts that do not appear in the allowed source text.
function findInventedNumbers(texts, allowedSource) {
  const allowed = new Set(numbersIn(allowedSource));
  const bad = [];
  for (const t of texts) {
    for (const n of numbersIn(t)) {
      if (!allowed.has(n)) bad.push(n);
    }
  }
  return bad;
}

function parseJsonLoose(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(t);
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  normalizeEmail, maskText, wordCount, normalizeForMatch, quoteIsVerified,
  numbersIn, findInventedNumbers, parseJsonLoose, round1, round2, round3, sleep
};
