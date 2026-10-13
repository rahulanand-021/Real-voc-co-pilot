'use strict';
// Calls Google's Gemini API with structured JSON output.
const U = require('./util');

class AiError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.kind = kind; // 'config', 'busy', 'bad_answer', 'network'
    this.status = status;
  }
}

async function callGemini({ apiKey, model, temperature, systemText, userText, schema, timeoutMs }) {
  if (!apiKey) throw new AiError('GEMINI_API_KEY is missing', 'config');

  // Ensure an active Gemini model is targeted
  const activeModel = (model && model.startsWith('gemini')) ? model : 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent`;

  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: typeof temperature === 'number' ? temperature : 0,
      responseMimeType: 'application/json'
    }
  };

  if (schema) {
    body.generationConfig.responseSchema = schema;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 40000);
  let res;
  let raw;

  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey.trim() },
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
    console.error('Gemini error', res.status, raw.slice(0, 300));
    throw new AiError('AI service error ' + res.status, kind, res.status);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new AiError('AI answer was not readable', 'bad_answer');
  }

  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  const text = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  if (!text) throw new AiError('AI returned no text', 'bad_answer');
  return text;
}

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
      if (e.kind === 'bad_answer' && attempt >= 1) throw e;
      if (e.kind === 'busy' || e.kind === 'network') await U.sleep(3000 * (attempt + 1));
    }
  }
  throw lastErr;
}

module.exports = { callGemini, askJson, AiError };
