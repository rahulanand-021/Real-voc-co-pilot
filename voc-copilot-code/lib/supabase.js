'use strict';
// Database connection. Keys come only from Vercel's environment variables, never from the code.
const { createClient } = require('@supabase/supabase-js');

class ConfigError extends Error {}

let client = null;
function getDb() {
  if (client) return client;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) { console.error('Missing environment variable: SUPABASE_URL'); throw new ConfigError('Database not configured'); }
  if (!key) { console.error('Missing environment variable: SUPABASE_SERVICE_ROLE_KEY'); throw new ConfigError('Database not configured'); }
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

module.exports = { getDb, ConfigError };
