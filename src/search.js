// Hybrid search behind the search() tool:
//   1. BM25F keyword ranking   (exact words: "CHG90", "express")
//   2. embedding ranking       (meaning: "television" ~ "TV"), via Gemini
//   3. Reciprocal Rank Fusion  merges the two rankings by position
// If embeddings are unavailable (no key, other provider, API error), search
// falls back to keyword ranking alone.

var BM25_K1 = 1.2;       // how quickly repeated words stop adding score
var BM25_B = 0.75;       // how much longer fields are penalized
var FIELD_WEIGHTS = { own: 3, near: 2, context: 1 }; // BM25F: a word in a node's own text counts most
var RRF_K = 60;          // standard RRF constant: score = sum of 1 / (RRF_K + rank)
var CANDIDATES = 20;     // hits taken from each ranking before fusion
var MAX_DOC_TEXT = 300;  // characters embedded per search document
// Which embedding hits to keep. Measured on our three test pages with
// gemini-embedding-001: relevant top hits scored 0.61-0.74 and irrelevant ones
// 0.60-0.64, so no fixed cutoff separates them. Embeddings therefore only rank
// candidates; deciding "not on this page" is the explorer LLM's job. A hit is
// kept if it's close to this query's best hit AND clearly above this query's
// typical similarity, which trims the long tail of unrelated nodes.
var DENSE_TOP_WINDOW = 0.04;     // keep hits within this of the best similarity...
var DENSE_MEDIAN_MARGIN = 0.03;  // ...and at least this far above the median
var MAX_MEANING_HITS = 5;        // at most this many meaning hits go into fusion
var RATE_LIMIT_PAUSE_MS = 60000; // after a 429, use keywords only for this long

var embeddingCache = new Map(); // document text -> vector; kept across queries on this page
var lastDenseStats = null;      // similarity spread of the latest query, for debugSearch()

// Top, median and 90th-percentile similarity of hits sorted best first.
function similarityStats(sorted) {
  function at(fraction) { return sorted.length ? Math.round(sorted[Math.floor(fraction * (sorted.length - 1))].score * 1000) / 1000 : 0; }
  return { top: at(0), p90: at(0.1), median: at(0.5) };
}
var denseDisabled = '';         // set after a key/permission error, so we stop retrying
var densePausedUntil = 0;       // set after a 429 (rate limit), which is temporary

// ---- Words ----

// Words that say nothing about what the user is looking for.
var STOPWORDS = new Set(('a an and any are be buy can do does find for from get have how i in is it ' +
  'looking me much my need of on or please show some the there this to want what where which with you').split(' '));

// Crude stemming so "charges" matches "charge" and "bulbs" matches "bulb".
function stem(word) {
  return word.length > 4 ? word.replace(/(ing|es|ed|s)$/, '') : word;
}

// Lowercase word stems, without stopwords.
function words(text) {
  return (String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter(function (w) { return !STOPWORDS.has(w); })
    .map(stem);
}

// Equal, or for longer words a prefix match: "deliver" ~ "delivery", "trim" ~ "trimmer".
function wordsMatch(queryWord, word) {
  return word === queryWord ||
    (queryWord.length >= 4 && word.length >= 4 && (word.indexOf(queryWord) === 0 || queryWord.indexOf(word) === 0));
}

// ---- Search documents ----

// A hit inside a card is reported as the card, so a product appears once (with
// its price etc. under it) rather than as both card and title. A card is a
// record, or a small titled group whose children are all leaves.
function isCard(node) {
  return node.kind === 'record' ||
    (node.kind === 'group' && !!node.title && node.children.every(function (c) { return !c.children.length; }));
}

function resultUnit(node) {
  for (var n = node; n; n = n.parent) if (isCard(n)) return n;
  return node;
}

// One document per searchable unit: every card, and every item not inside a card.
// Fields: own (its label), near (heading just above it), context (its section,
// and for cards the text of everything inside).
function searchDocs(t) {
  var docs = [];
  t.byId.forEach(function (node) {
    var isUnit = isCard(node) || (node.kind === 'item' && resultUnit(node) === node);
    if (!isUnit) return;
    var own = nodeLabel(node);
    var near = node.data && node.data.near || '';
    var context = (node.data && node.data.section) || '';
    if (isCard(node)) {
      var inner = [];
      (function collect(n) {
        n.children.forEach(function (child) {
          if (child.data && child.data.text && child.data.text !== own) inner.push(child.data.text);
          collect(child);
        });
      })(node);
      context = (context + ' ' + inner.join(' ')).trim();
    }
    if (!own && !context) return;
    docs.push({
      node: node,
      fields: { own: words(own), near: words(near), context: words(context) },
      // What gets embedded: the label, then its section / contents. Not `near`: the
      // heading above a loose link can be a neighbouring product, which would make
      // "See all electronics" look like a TV.
      text: clean([own, context].filter(Boolean).join(' — '), MAX_DOC_TEXT)
    });
  });
  return docs;
}

// ---- 1. BM25F ----

// Returns [{ doc, score }] sorted best first, only docs that match at least one query word.
function bm25Rank(docs, query) {
  var queryWords = Array.from(new Set(words(query)));
  var n = docs.length;
  var avgLength = {};
  Object.keys(FIELD_WEIGHTS).forEach(function (field) {
    avgLength[field] = docs.reduce(function (sum, d) { return sum + d.fields[field].length; }, 0) / (n || 1) || 1;
  });

  var scores = docs.map(function () { return 0; });
  queryWords.forEach(function (qw) {
    // Weighted, length-normalized term frequency per doc (BM25F), summed over fields.
    var tf = docs.map(function (doc) {
      return Object.keys(FIELD_WEIGHTS).reduce(function (sum, field) {
        var tokens = doc.fields[field];
        var count = tokens.filter(function (w) { return wordsMatch(qw, w); }).length;
        if (!count) return sum;
        var norm = 1 - BM25_B + BM25_B * tokens.length / avgLength[field];
        return sum + FIELD_WEIGHTS[field] * count / norm;
      }, 0);
    });
    var df = tf.filter(function (x) { return x > 0; }).length;
    if (!df) return;
    // Rare words count more: a word in 1 of 80 docs outweighs one in 20 of 80.
    var idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    tf.forEach(function (x, i) { if (x > 0) scores[i] += idf * x / (BM25_K1 + x); });
  });

  return docs.map(function (doc, i) { return { doc: doc, score: scores[i] }; })
    .filter(function (hit) { return hit.score > 0; })
    .sort(function (a, b) { return b.score - a.score; });
}

// ---- 2. Embeddings ----

// Returns a Promise of [{ doc, score }] sorted by cosine similarity, or null when
// embeddings aren't available (the reason is in denseStatus()).
function denseRank(docs, query) {
  if (!canEmbed() || denseDisabled || Date.now() < densePausedUntil) return Promise.resolve(null);
  var missing = Array.from(new Set(docs.map(function (d) { return d.text; })
    .filter(function (text) { return !embeddingCache.has(text); })));
  // New documents and the query go in the same request(s).
  var inputs = missing.map(function (text) { return { text: text, taskType: 'RETRIEVAL_DOCUMENT' }; });
  inputs.push({ text: query, taskType: 'RETRIEVAL_QUERY' });

  return embedTexts(inputs).then(function (vectors) {
    missing.forEach(function (text, i) { embeddingCache.set(text, vectors[i]); });
    var queryVector = vectors[vectors.length - 1];
    var all = docs.map(function (doc) {
      var v = embeddingCache.get(doc.text);
      var dot = 0;
      for (var i = 0; i < v.length; i++) dot += v[i] * queryVector[i];
      return { doc: doc, score: dot };
    }).sort(function (a, b) { return b.score - a.score; });
    lastDenseStats = similarityStats(all);
    var cutoff = Math.max(lastDenseStats.top - DENSE_TOP_WINDOW, lastDenseStats.median + DENSE_MEDIAN_MARGIN);
    return all.filter(function (hit) { return hit.score >= cutoff; }).slice(0, MAX_MEANING_HITS);
  }).catch(function (err) {
    if (err.status === 429) {
      // Rate limit / quota: temporary. Pause, then try again.
      densePausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
      console.warn(LOG_PREFIX, 'Embedding rate limit hit; keywords only for ' + RATE_LIMIT_PAUSE_MS / 1000 + ' s.');
    } else if (err.status >= 400 && err.status < 500) {
      // Bad key, no access, or a rejected request: retrying won't help.
      denseDisabled = err.message;
      console.warn(LOG_PREFIX, 'Embedding search unavailable, using keywords only.', err.message);
    } else {
      console.warn(LOG_PREFIX, 'Embedding request failed, keywords only for this search.', err.message);
    }
    return null;
  });
}

function denseStatus() {
  if (config.provider !== 'gemini') return 'provider "' + config.provider + '" has no embeddings';
  if (!config.apiKey) return 'no API key';
  if (denseDisabled) return denseDisabled;
  if (Date.now() < densePausedUntil) return 'rate limited, retrying in ' + Math.ceil((densePausedUntil - Date.now()) / 1000) + ' s';
  return '';
}

// ---- 3. Fusion ----

// Searches tree t. Returns a Promise of
//   { retrieval: 'hybrid' | 'keyword-only', hits: [{ node, via, ranks, rrf }] }
// where via says which rankings found it ("keyword", "meaning", or both).
function hybridSearch(t, query, limit) {
  var docs = searchDocs(t);
  var keyword = bm25Rank(docs, query).slice(0, CANDIDATES);
  return denseRank(docs, query).then(function (dense) {
    var fused = new Map();
    function add(list, name) {
      list.forEach(function (hit, i) {
        var entry = fused.get(hit.doc) || { node: hit.doc.node, rrf: 0, ranks: {}, scores: {} };
        entry.rrf += 1 / (RRF_K + i + 1);
        entry.ranks[name] = i + 1;
        entry.scores[name] = Math.round(hit.score * 1000) / 1000;
        fused.set(hit.doc, entry);
      });
    }
    add(keyword, 'keyword');
    if (dense) add(dense.slice(0, CANDIDATES), 'meaning');

    var hits = Array.from(fused.values())
      .sort(function (a, b) { return b.rrf - a.rrf; })
      .slice(0, limit);
    hits.forEach(function (hit) { hit.via = Object.keys(hit.ranks).join('+'); });
    return { retrieval: dense ? 'hybrid' : 'keyword-only', hits: hits };
  });
}

// Logs how each ranking placed the results. Run PageLens.debugSearch('query').
function debugSearch(query) {
  var t = tree || buildTree();
  return hybridSearch(t, query, CANDIDATES).then(function (out) {
    var status = denseStatus();
    var spread = out.retrieval === 'hybrid' && lastDenseStats ?
      ' · similarity top ' + lastDenseStats.top + ', p90 ' + lastDenseStats.p90 + ', median ' + lastDenseStats.median : '';
    console.log(LOG_PREFIX, 'search(' + JSON.stringify(query) + '): ' + out.retrieval + (status ? ' (' + status + ')' : '') + spread);
    console.table(out.hits.map(function (hit) {
      return {
        id: hit.node.id, kind: nodeTag(hit.node), text: clean(nodeLabel(hit.node), 50),
        keywordRank: hit.ranks.keyword || '', keywordScore: hit.scores.keyword || '',
        meaningRank: hit.ranks.meaning || '', similarity: hit.scores.meaning || '',
        rrf: Math.round(hit.rrf * 10000) / 10000
      };
    }));
    return out;
  });
}
