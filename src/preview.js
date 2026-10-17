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
  buildTree();
  var start = rootView();
  return tools.search(query).then(function (hits) {
    var status = hits.retrieval === 'hybrid' ? 'keyword + meaning' : 'keywords only (' + denseStatus() + ')';
    return {
      text: 'Preview mode (no LLM yet). The explorer would start from this top level (' +
        start.children.length + ' of ' + tree.byId.size + ' nodes) and call expand / read / search ' +
        'to go deeper (max depth ' + MAX_DEPTH + ').',
      detail: 'Top level:\n' + jsonLines(start.children) +
        '\n\nsearch(' + JSON.stringify(query) + ') would return [' + status + ']:\n' +
        (hits.results.length ? jsonLines(hits.results) : '(no matches)')
    };
  });
}
