// Query handler, preview mode.
// TEMPORARY: until the LLM step exists, a query shows what the explorer would
// start from instead of calling a model.

// One JSON object per line, for display.
function jsonLines(list) {
  return list.map(function (x) { return JSON.stringify(x); }).join('\n');
}

// Answers a query. Returns a Promise of { text, detail? } for the chat widget.
// TEMPORARY (until the LLM step): shows what the explorer would start with.
function answerQuery(query) {
  var started = performance.now();
  buildTree();
  var treeMs = Math.round(performance.now() - started);
  var t = tree;
  var start = rootView();
  var journey = null;
  return tools.search(query, { quiet: true, onJourney: function (j) { journey = j; } }).then(function (hits) {
    if (config.debug) {
      logQueryJourney({
        query: query, tree: t, treeMs: treeMs, journey: journey, results: hits.results,
        rootView: start, totalMs: Math.round(performance.now() - started)
      });
    }
    var status = hits.retrieval === 'hybrid' ? 'keyword + meaning' : 'keywords only (' + denseStatus() + ')';
    return {
      text: 'Preview mode (no LLM yet). The explorer would start from this top level (' +
        start.children.length + ' of ' + t.byId.size + ' nodes) and call expand / read / search ' +
        'to go deeper (max depth ' + MAX_DEPTH + ').' + (config.debug ? ' Full journey in the console.' : ''),
      detail: 'Top level:\n' + jsonLines(start.children) +
        '\n\nsearch(' + JSON.stringify(query) + ') would return [' + status + ']:\n' +
        (hits.results.length ? jsonLines(hits.results) : '(no matches)')
    };
  });
}
