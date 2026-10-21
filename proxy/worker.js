// PageLens proxy — a Cloudflare Worker that keeps the Gemini API key off the page.
// lib.js (built with: node build.js --proxy <this worker's URL>) sends its Gemini
// requests here without a key; the worker checks them, adds the key (a Cloudflare
// secret) and forwards them to Gemini, passing the reply back unchanged.
//
// Checks, in order:
//   1. the request comes from an allowed site (ALLOWED_ORIGINS, the page's Origin header;
//      an entry ending in ":*" allows every port, e.g. http://localhost:*);
//   2. it is one of the calls PageLens makes (ALLOWED_CALLS: model + method), POST only;
//   3. the body is small enough (MAX_BODY_BYTES);
//   4. this visitor (IP address) is under the rate limit (the LIMITER binding, wrangler.toml).
// The key's own quota or budget in Google Cloud is the last limit.
//
// Setup: see proxy/README.md.

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

// The only model + method pairs PageLens uses (src/gemini.js).
const ALLOWED_CALLS = new Set([
  'gemini-3.5-flash-lite:generateContent',
  'gemini-3.5-flash:generateContent',
  'gemini-embedding-001:batchEmbedContents'
]);

// An explorer turn is ~15 KB; a batch of 100 page texts to embed is usually < 100 KB.
const MAX_BODY_BYTES = 256 * 1024;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const originOk = isAllowedOrigin(origin, allowedOrigins(env));
    const cors = originOk ? corsHeaders(origin) : {};

    // 1. Allowed sites only. Browsers send Origin on these cross-site requests.
    if (!originOk) return error(403, 'This site is not allowed to use the PageLens proxy.', cors);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // 2. Only PageLens's calls.
    const url = new URL(request.url);
    const call = url.pathname.startsWith('/v1beta/models/') ? url.pathname.slice('/v1beta/models/'.length) : '';
    if (request.method !== 'POST' || !ALLOWED_CALLS.has(call)) return error(404, 'Not a PageLens request.', cors);

    // 3. Size cap (Content-Length can be missing or wrong, so the body is measured too).
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return error(413, 'Request too large.', cors);

    // 4. Rate limit per visitor. Answered as a Gemini-style 429, so lib.js backs off as usual.
    if (env.LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.LIMITER.limit({ key: ip });
      if (!success) return error(429, 'Too many requests from this visitor; try again in a minute.', cors);
    }

    if (!env.GEMINI_KEY) return error(500, 'The proxy has no GEMINI_KEY secret.', cors);
    const upstream = await fetch(GEMINI_BASE + call, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY },
      body
    });
    // Status and body passed through, so lib.js's retries and fallbacks work as before.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json', ...cors }
    });
  }
};

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Exact origins ("https://thecompletebot.github.io"), any port ("http://localhost:*"),
// or "*" for every site.
function isAllowedOrigin(origin, allowed) {
  if (!origin) return false;
  return allowed.some((entry) => {
    if (entry === '*') return true;
    if (entry.endsWith(':*')) {
      const base = entry.slice(0, -2);
      return origin === base || (origin.startsWith(base + ':') && /^\d+$/.test(origin.slice(base.length + 1)));
    }
    return origin === entry;
  });
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

// Same shape as Gemini's errors: { error: { code, message } }.
function error(status, message, headers) {
  return new Response(JSON.stringify({ error: { code: status, message } }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}
