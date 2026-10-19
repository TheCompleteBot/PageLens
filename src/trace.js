// Developer trace. With data-debug on the start tag, every query prints its
// whole journey to the console as one group: the tree, keyword ranking, meaning
// ranking, rank fusion, and what the explorer receives. Each step is an
// expanded sub-group (click its title to collapse it) with a table.

function round(x, digits) {
  var f = Math.pow(10, digits);
  return Math.round(x * f) / f;
}

// The id / kind / text columns every table starts with.
function nodeRow(node) {
  return { id: node.id, kind: nodeTag(node), text: clean(nodeLabel(node), 50) };
}

function withColumns(base, extra) {
  Object.keys(extra).forEach(function (key) { base[key] = extra[key]; });
  return base;
}

// Prints `title`, then calls body() inside a console group.
function traceStep(title, body) {
  console.group(title);
  body();
  console.groupEnd();
}

function logTreeStep(number, t, ms) {
  traceStep(number + '. Tree: ' + t.byId.size + ' nodes, ' + t.roots.length + ' at the top level (' + ms + ' ms)', function () {
    console.log('Built from the live DOM between the markers. IDs are valid for this query only.');
    console.table(t.roots.map(function (node) {
      return withColumns(nodeRow(node), { contains: countDescendants(node) });
    }));
  });
}

// The four search steps, numbered from `first`. Returns the next step number.
function logSearchSteps(first, j) {
  var n = first;

  traceStep(n++ + '. Query words: ' + JSON.stringify(j.queryWords) + ' (searching ' + j.docs + ' nodes' +
    (j.within ? ' inside ' + j.within : '') + ')', function () {
    console.log('From ' + JSON.stringify(j.query) + ': lowercased, split into words, stopwords removed, crude stemming.');
    console.log('Each product card counts as one searchable node, with its contents.');
  });

  traceStep(n++ + '. Keyword ranking (BM25F): ' + (j.keyword.length ? j.keyword.length + ' matches' : 'no matches'), function () {
    console.log('Exact and prefix word matches. Rare words score higher; a match in a node\'s own text counts 3×, ' +
      'in the heading above it 2×, in its section/contents 1×.');
    if (j.keyword.length) {
      console.table(j.keyword.map(function (hit, i) {
        return withColumns({ rank: i + 1 }, withColumns(nodeRow(hit.doc.node), { score: round(hit.score, 3) }));
      }));
    }
  });

  var d = j.dense;
  var denseTitle = d.status === 'used'
    ? 'Meaning ranking (embeddings): kept ' + d.ranked.filter(function (r) { return r.kept; }).length +
      ' (cutoff ' + round(d.cutoff, 3) + ')'
    : 'Meaning ranking (embeddings): ' + d.status + ' (' + d.reason + ')';
  traceStep(n++ + '. ' + denseTitle, function () {
    if (d.status !== 'used') {
      console.log('Search used keywords only.');
      return;
    }
    console.log('Embedded ' + d.embeddedNew + ' new page text(s) + the query in ' + d.ms + ' ms; ' +
      d.cached + ' page texts came from the cache.');
    console.log('Similarity across the page: top ' + d.stats.top + ', p90 ' + d.stats.p90 + ', median ' + d.stats.median +
      '. Kept: within ' + DENSE_TOP_WINDOW + ' of the top and ' + DENSE_MEDIAN_MARGIN + ' above the median, max ' +
      MAX_MEANING_HITS + '.');
    console.table(d.ranked.map(function (hit, i) {
      return withColumns({ rank: i + 1 }, withColumns(nodeRow(hit.doc.node), {
        similarity: round(hit.score, 3), kept: hit.kept ? 'yes' : 'cut'
      }));
    }));
  });

  traceStep(n++ + '. Rank fusion (RRF): ' + j.fused.length + ' candidates, top ' + Math.min(j.limit, j.fused.length) + ' returned', function () {
    console.log('rrf = sum over rankings of 1 / (' + RRF_K + ' + rank). Uses positions only, so keyword scores and ' +
      'similarities never have to be compared.');
    if (j.fused.length) {
      console.table(j.fused.map(function (hit, i) {
        return withColumns({ rank: i + 1 }, withColumns(nodeRow(hit.node), {
          keyword: hit.ranks.keyword ? '#' + hit.ranks.keyword + ' (' + hit.scores.keyword + ')' : '',
          meaning: hit.ranks.meaning ? '#' + hit.ranks.meaning + ' (' + hit.scores.meaning + ')' : '',
          rrf: round(hit.rrf, 4),
          returned: i < j.limit ? 'yes' : ''
        }));
      }));
    }
  });

  return n;
}

// Just the search part, as its own group (e.g. a search() call from the console).
function logSearchJourney(j, results) {
  console.group(LOG_PREFIX + ' search(' + JSON.stringify(j.query) + (j.within ? ', within ' + j.within : '') + ') · ' + j.ms + ' ms');
  var n = logSearchSteps(1, j);
  if (results) logReturnedStep(n, results);
  console.groupEnd();
}

function logReturnedStep(number, results) {
  traceStep(number + '. Returned to the explorer: ' + results.length + ' result(s)', function () {
    console.log('Exactly what the search() tool returns:');
    console.log(results);
  });
}

// A whole chat query: tree, search steps, and what the explorer would start with.
// `parts` = { query, tree, treeMs, journey, results, rootView, totalMs }.
function logQueryJourney(parts) {
  console.group(LOG_PREFIX + ' Query: ' + JSON.stringify(parts.query) + ' · ' + parts.totalMs + ' ms');
  logTreeStep(1, parts.tree, parts.treeMs);
  var n = logSearchSteps(2, parts.journey);
  logReturnedStep(n++, parts.results);
  traceStep(n + '. Explorer would start with: the top level + these search results (preview mode, no LLM yet)', function () {
    console.log({ topLevel: parts.rootView.children, search: parts.results });
  });
  console.groupEnd();
}
