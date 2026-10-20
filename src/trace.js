// Developer trace. With data-debug on the start tag, every query prints its
// whole journey to the console as one group: the tree, keyword ranking, meaning
// ranking, rank fusion, then each explorer turn and the result. Each step is an
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

// A whole chat query, from the explorer's state: tree, the automatic first
// search, every model turn with its tool calls, and the result.
function logQueryJourney(state) {
  var r = state.result;
  console.group(LOG_PREFIX + ' Query: ' + JSON.stringify(state.query) + ' → ' + r.action +
    (r.targets.length ? ' ' + r.targets.join(' ') : '') + ' · ' + state.ms + ' ms');
  logTreeStep(1, state.tree, state.treeMs);
  var n = logSearchSteps(2, state.start.journey);
  logReturnedStep(n++, state.start.search.results);

  var journeys = state.searchJourneys.slice();
  state.steps.forEach(function (step) {
    var tokens = step.tokens ? ' · ' + step.tokens.totalTokenCount + ' tokens' : '';
    traceStep(n++ + '. Explorer turn ' + step.n + ' · ' + (step.model || '?') + ' · ' + step.ms + ' ms' + tokens +
      (step.finishOnly ? ' · finish only' : ''), function () {
      step.calls.forEach(function (call) {
        console.log(describeCall(call));
        if (call.result && !call.error) console.log(call.result);
        // A search the model made: its keyword / meaning / fusion steps, collapsed.
        if (call.name === 'search' && call.result && call.result.results && journeys.length) {
          var j = journeys.shift();
          console.groupCollapsed('how search ranked ' + JSON.stringify(j.query));
          logSearchSteps(1, j);
          console.groupEnd();
        }
      });
    });
  });

  traceStep(n + '. Result: ' + r.action + (r.match === 'maybe' ? ' (maybe)' : '') + (r.targets.length ? ' ' + r.targets.join(' ') : ''), function () {
    r.targets.forEach(function (id) {
      var node = state.tree.byId.get(id);
      console.log(id + ' ' + nodeTag(node) + ': ' + nodeLabel(node) + '   (in: ' + (pathOf(node) || 'top level') + ')');
    });
    if (r.note) console.log('Note: ' + r.note);
    console.log(state.toolCalls + ' tool calls (' + state.searches + ' searches incl. the first), ' +
      state.steps.length + ' model turns, ' + state.rejections + ' rejected finish.');
  });
  if (state.answer) logAnswerStep(n + 2, state.answer);
  if (state.handoff && r.action !== 'abstain') {
    traceStep(n + 1 + '. Hand-off to the answer step: ' + state.handoff.sources.length + ' source(s), ' +
      state.handoff.context.length + ' other read node(s)', function () {
      console.log(handoffLines(state.handoff).join('\n'));
      console.log(state.handoff);
    });
  }
  console.groupEnd();
}

function logAnswerStep(number, a) {
  traceStep(number + '. Answer step: ' + a.status + ', ' + a.attempts.length + ' LLM call(s), ' + a.highlights.length +
    ' highlight(s) · ' + a.ms + ' ms', function () {
    console.log('Reply: ' + a.reply);
    a.attempts.forEach(function (at, i) {
      console.log('Attempt ' + (i + 1) + ' (' + at.model + ', ' + at.ms + ' ms' +
        (at.tokens ? ', ' + at.tokens.totalTokenCount + ' tokens' : '') + '):', at.output);
      at.problems.forEach(function (p) { console.log('  ✗ ' + p); });
    });
    a.highlights.forEach(function (h) { console.log('Highlight ' + h.n + ': ' + h.id + ' "' + h.label + '"', h.el); });
  });
}
