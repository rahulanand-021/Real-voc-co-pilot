'use strict';
// Calls Groq API with structured JSON output. Only review text goes in: never emails.
const U = require('./util');

class AiError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.kind = kind; // 'config', 'busy', 'bad_answer', 'network'
    this.status = status;
  }
}

async function callGemini({ apiKey, model, temperature, systemText, userText, schema, timeoutMs }) {
  if (!apiKey) throw new AiError('API key is missing (set GEMINI_API_KEY or GROQ_API_KEY)', 'config');

  // If settings.js still has a Gemini model name, fall back to Groq's high-performance model
  const effectiveModel = 'llama-3.1-8b-instant';

  const url = 'https://api.groq.com/openai/v1/chat/completions';

  // Instruct Groq to return JSON strictly matching the schema instructions
  const enhancedSystemText = `${systemText || ''}\nYou must return valid JSON only. Do not wrap output in markdown code blocks or backticks.`;

  const messages = [
    { role: 'system', content: enhancedSystemText },
    { role: 'user', content: userText }
  ];

  const body = {
    model: effectiveModel,
    messages: messages,
    temperature: typeof temperature === 'number' ? temperature : 0,
    response_format: { type: 'json_object' }
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 40000);
  let res;
  let raw;

  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey.trim()}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    raw = await res.text();
  } catch (e) {
    throw new AiError('AI request failed: ' + (e && e.message ? e.message : e), 'network');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const kind = res.status === 400 || res.status === 401 || res.status === 403 ? 'config' : 'busy';
    console.error('Groq error', res.status, raw.slice(0, 300));
    throw new AiError('AI service error ' + res.status, kind, res.status);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new AiError('AI answer was not readable', 'bad_answer');
  }

  const text = (((data.choices || [])[0] || {}).message || {}).content;
  if (!text) throw new AiError('AI returned no text', 'bad_answer');

  return text;
}

// Asks, parses the JSON, and retries (busy: wait and retry; unreadable answer: retry once).
async function askJson(opts, validate) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = await callGemini(opts);
      let parsed;
      try {
        parsed = U.parseJsonLoose(text);
      } catch (e) {
        throw new AiError('AI answer was not valid JSON', 'bad_answer');
      }
      if (validate && !validate(parsed)) {
        throw new AiError('AI answer had the wrong shape', 'bad_answer');
      }
      return parsed;
    } catch (e) {
      lastErr = e;
      if (e.kind === 'config') throw e;
      if (e.kind === 'bad_answer' && attempt >= 1) throw e; // one retry for unreadable answers
      if (e.kind === 'busy' || e.kind === 'network') await U.sleep(3000 * (attempt + 1));
    }
  }
  throw lastErr;
}

module.exports = { callGemini, askJson, AiError };
