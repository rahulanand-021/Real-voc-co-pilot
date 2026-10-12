// All settings live here (PRD section 5B). Secrets are NOT here: they are set in Vercel.
// GEMINI_API_KEY, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come from Vercel's settings page.
module.exports = {
  app_id: 'com.nextbillion.groww',
  store_country: 'in',
  store_language: 'en',
  fetch_window: 100,
  complaint_max_rating: 3,
  min_words: 4,
  excluded_warning_pct: 40,
  ai_model: 'gemini-3.5-flash',
  ai_temperature: 0,
  tag_batch_size: 30,
  min_confidence: 0.6,
  taxonomy_version: 'v1',
  prompt_version: 'v1',
  min_cluster_size: 3,
  trend_enabled: false,
  fetch_limit_per_window: 3,
  window_hours: 24,
  fetch_cooldown_seconds: 10,
  fetch_lock_minutes: 5,
  quote_max_chars_on_card: 200
};
