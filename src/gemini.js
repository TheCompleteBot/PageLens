// Gemini REST client — the provider adapter: text embeddings (used by search)
// and generation with function calling (used by the explorer).
// Docs: https://ai.google.dev/gemini-api/docs/embeddings
//       https://ai.google.dev/gemini-api/docs/function-calling

var EMBEDDING_MODEL = 'gemini-embedding-001'; // text-only; supports RETRIEVAL_* task types
var EMBEDDING_DIMENSIONS = 768;              // one of the recommended sizes (768 / 1536 / 3072)
var EMBEDDING_BATCH = 100;                   // texts per batchEmbedContents request

// Generation uses config.model (default gemini-3.5-flash-lite, ~1 s per call on the
// free tier when tested; set in init.js, changed with data-model). If it stays
// overloaded or rate-limited after retries, the request moves to the fallback.
var FALLBACK_MODEL = 'gemini-3.5-flash';
// Thinking per model: off for the fast default (choosing a tool needs no long
// reasoning), low for the fallback. Gemini 3 models take a level, not a token budget.
var THINKING_LEVELS = { 'gemini-3.5-flash-lite': 'minimal', 'gemini-3.5-flash': 'low' };

// Retries: exponential backoff with jitter, so retries from many visitors (or from
// several requests in one query) don't all hit the API again at the same moment.
// Wait before retry k (0-based): half of min(MAX, BASE * 2^k), plus a random part
// of the other half ("equal jitter"): ~0.5-1 s, ~1-2 s, ~2-4 s, ...
var RETRY_STATUSES = [429, 500, 503, 504];    // rate limit or overload: worth retrying
var RETRY_BASE_MS = 1000;
var RETRY_MAX_MS = 8000;
// If the API asks us to wait longer than this (e.g. a per-day quota), don't wait:
// fail now so the caller can use the fallback model, or keywords only.
var RETRY_MAX_SERVER_WAIT_MS = 15000;
var GENERATE_TRIES = 3;    // per model, before switching to the fallback model
var EMBEDDING_TRIES = 2;   // search falls back to keywords, so don't make it wait long
var BATCH_GAP_MS = [100, 400]; // random pause between embedding batches

// True when requests can be made: with a key, or through the proxy (which has it).
function hasApiAccess() {
  return !!(config.apiKey || config.proxy);
}

// True when this provider can produce embeddings with the configured key or proxy.
function canEmbed() {
  return config.provider === 'gemini' && hasApiAccess();
}

function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function backoffDelay(retry) {
  var cap = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, retry));
  return cap / 2 + Math.random() * cap / 2;
}

// The wait a 429 response asks for, from its RetryInfo detail ("retryDelay": "37s"), in ms.
function serverRetryDelay(detail) {
  var match = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(detail);
  return match ? parseFloat(match[1]) * 1000 : 0;
}

// POSTs to a Gemini model method and returns the parsed JSON. Rate-limit and
// overload errors are retried up to `tries - 1` times with backoff. Throws on
// other HTTP errors (and when retries run out), with the status on err.status so
// callers can tell a bad key (4xx) from a blip.
function geminiPost(model, method, body, tries) {
  tries = tries || 1;
  function attempt(k) {
    // Through the proxy, no key is sent: it adds the key on the server.
    var headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers['x-goog-api-key'] = config.apiKey;
    return fetch(config.apiBase + model + ':' + method, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    }).then(function (res) {
      if (res.ok) return res.json();
      return res.text().then(function (detail) {
        var serverWait = serverRetryDelay(detail);
        var retryable = RETRY_STATUSES.indexOf(res.status) !== -1 && serverWait <= RETRY_MAX_SERVER_WAIT_MS;
        if (retryable && k + 1 < tries) {
          var delay = Math.max(backoffDelay(k), serverWait + Math.random() * RETRY_BASE_MS);
          console.warn(LOG_PREFIX, model + ' ' + method + ': HTTP ' + res.status + ', retry ' + (k + 1) + ' of ' +
            (tries - 1) + ' in ' + (delay / 1000).toFixed(1) + ' s.');
          return wait(delay).then(function () { return attempt(k + 1); });
        }
        var err = new Error('Gemini ' + method + ' failed: HTTP ' + res.status + ' ' + detail.slice(0, 200));
        err.status = res.status;
        throw err;
      });
    });
  }
  return attempt(0);
}

// Unit length, so a dot product is the cosine similarity. Required for
// gemini-embedding-001 at sizes below 3072.
function normalizeVector(values) {
  var norm = Math.sqrt(values.reduce(function (sum, v) { return sum + v * v; }, 0)) || 1;
  return values.map(function (v) { return v / norm; });
}

// Embeds [{ text, taskType }] (taskType: 'RETRIEVAL_DOCUMENT' or 'RETRIEVAL_QUERY').
// Returns a Promise of normalized vectors in the same order. Batches go one at a
// time with a random pause between them, so a large page doesn't send a burst.
function embedTexts(inputs) {
  var batches = [];
  for (var i = 0; i < inputs.length; i += EMBEDDING_BATCH) batches.push(inputs.slice(i, i + EMBEDDING_BATCH));
  var vectors = [];
  return batches.reduce(function (chain, batch, n) {
    return chain.then(function () {
      if (n > 0) return wait(BATCH_GAP_MS[0] + Math.random() * (BATCH_GAP_MS[1] - BATCH_GAP_MS[0]));
    }).then(function () {
      return geminiPost(EMBEDDING_MODEL, 'batchEmbedContents', {
        requests: batch.map(function (input) {
          return {
            model: 'models/' + EMBEDDING_MODEL,
            content: { parts: [{ text: input.text }] },
            taskType: input.taskType,
            outputDimensionality: EMBEDDING_DIMENSIONS
          };
        })
      }, EMBEDDING_TRIES);
    }).then(function (json) {
      json.embeddings.forEach(function (e) { vectors.push(normalizeVector(e.values)); });
    });
  }, Promise.resolve()).then(function () { return vectors; });
}

// Calls generateContent with `body` (contents, tools, ...) on config.model, retrying
// with backoff; if it stays overloaded or rate-limited, does the same on
// FALLBACK_MODEL. Returns a Promise of { model, content, usage }: content is the
// model's reply, to append to the history as is.
function geminiGenerate(body) {
  var models = [config.model];
  if (config.model !== FALLBACK_MODEL) models.push(FALLBACK_MODEL);

  function attempt(i) {
    var model = models[i];
    var request = Object.assign({}, body);
    // Keep the caller's settings (e.g. a JSON response schema) and add the model's thinking level.
    request.generationConfig = Object.assign({}, body.generationConfig);
    if (THINKING_LEVELS[model]) request.generationConfig.thinkingConfig = { thinkingLevel: THINKING_LEVELS[model] };
    return geminiPost(model, 'generateContent', request, GENERATE_TRIES).then(function (json) {
      var candidate = (json.candidates || [])[0];
      if (!candidate || !candidate.content) {
        throw new Error('Gemini returned no answer' + (candidate ? ' (' + candidate.finishReason + ')' : '') + '.');
      }
      if (!candidate.content.parts) candidate.content.parts = [];
      return { model: model, content: candidate.content, usage: json.usageMetadata };
    }, function (err) {
      if (i + 1 < models.length && RETRY_STATUSES.indexOf(err.status) !== -1) {
        console.warn(LOG_PREFIX, model + ' still unavailable (HTTP ' + err.status + '); switching to ' + models[i + 1] + '.');
        return attempt(i + 1);
      }
      throw err;
    });
  }
  return attempt(0);
}
