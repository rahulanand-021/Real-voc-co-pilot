'use strict';
// Email sign-in (PRD Module H, J0): no password, no verification. The email only identifies the usage record.
const U = require('../lib/util');
const { send, readBody } = require('../lib/http');
const { getDb } = require('../lib/supabase');
const store = require('../lib/store');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST.' });
  const body = await readBody(req);
  const email = U.normalizeEmail(body.email);
  if (!email) return send(res, 400, { ok: false, error: 'Please enter a valid email address.' });
  try {
    const db = getDb();
    await store.upsertUser(db, email);
    return send(res, 200, { ok: true, email });
  } catch (e) {
    console.error('signin failed:', e && e.message ? e.message : e);
    return send(res, 500, { ok: false, error: 'The service is not available right now. Please try again later.' });
  }
};
