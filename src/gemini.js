// Gemini REST client — the provider adapter. For now it only does text
// embeddings (used by search); the explorer step will add generation here.
// Docs: https://ai.google.dev/gemini-api/docs/embeddings

var GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
var EMBEDDING_MODEL = 'gemini-embedding-001'; // text-only; supports RETRIEVAL_* task types
var EMBEDDING_DIMENSIONS = 768;              // one of the recommended sizes (768 / 1536 / 3072)
var EMBEDDING_BATCH = 100;                   // texts per batchEmbedContents request

// True when this provider can produce embeddings with the configured key.
function canEmbed() {
  return config.provider === 'gemini' && !!config.apiKey;
}

// POSTs to a Gemini model method and returns the parsed JSON. Throws on HTTP errors,
// with the status on err.status so callers can tell a bad key (4xx) from a blip.
function geminiPost(model, method, body) {
  return fetch(GEMINI_BASE + model + ':' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
    body: JSON.stringify(body)
  }).then(function (res) {
    if (res.ok) return res.json();
    return res.text().then(function (detail) {
      var err = new Error('Gemini ' + method + ' failed: HTTP ' + res.status + ' ' + detail.slice(0, 200));
      err.status = res.status;
      throw err;
    });
  });
}

// Unit length, so a dot product is the cosine similarity. Required for
// gemini-embedding-001 at sizes below 3072.
function normalizeVector(values) {
  var norm = Math.sqrt(values.reduce(function (sum, v) { return sum + v * v; }, 0)) || 1;
  return values.map(function (v) { return v / norm; });
}

// Embeds [{ text, taskType }] (taskType: 'RETRIEVAL_DOCUMENT' or 'RETRIEVAL_QUERY').
// Returns a Promise of normalized vectors in the same order.
function embedTexts(inputs) {
  var batches = [];
  for (var i = 0; i < inputs.length; i += EMBEDDING_BATCH) batches.push(inputs.slice(i, i + EMBEDDING_BATCH));
  return Promise.all(batches.map(function (batch) {
    return geminiPost(EMBEDDING_MODEL, 'batchEmbedContents', {
      requests: batch.map(function (input) {
        return {
          model: 'models/' + EMBEDDING_MODEL,
          content: { parts: [{ text: input.text }] },
          taskType: input.taskType,
          outputDimensionality: EMBEDDING_DIMENSIONS
        };
      })
    }).then(function (json) {
      return json.embeddings.map(function (e) { return normalizeVector(e.values); });
    });
  })).then(function (parts) { return [].concat.apply([], parts); });
}
