'use strict';
// Reads the newest reviews from the Google Play Store (unofficial package, see PRD section 4).
const U = require('./util');

async function fetchNewestReviews(s) {
  const mod = await import('google-play-scraper');
  const gplay = mod.default || mod;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await gplay.reviews({
        appId: s.app_id,
        lang: s.store_language,
        country: s.store_country,
        sort: gplay.sort.NEWEST,
        num: s.fetch_window
      });
      return Array.isArray(result) ? result : (result && result.data) || [];
    } catch (e) {
      lastErr = e;
      console.error('Play Store fetch failed (attempt ' + (attempt + 1) + '):', e && e.message ? e.message : e);
      await U.sleep(700 * (attempt + 1));
    }
  }
  throw lastErr;
}

module.exports = { fetchNewestReviews };
