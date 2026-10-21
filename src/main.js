// Entry point: public debugging API and startup. Runs last, after every other
// file has defined its functions and variables.

if (!startMarker) {
  console.error(LOG_PREFIX, 'Could not find the start <script data-start> tag. PageLens is disabled.');
} else {
  if (!config.apiKey) {
    console.warn(LOG_PREFIX, 'This build has no API key, so queries will fail. Add the key to .env and run node build.js --key NAME.');
  }
  // Small debugging surface. The API key is deliberately not exposed here.
  window.PageLens = {
    provider: config.provider,
    getRegionElements: getRegionElements,
    debug: debugTree,
    // Run the explorer's tools by hand, e.g. PageLens.tools.expand('n3').
    // Uses the tree from the latest query or PageLens.debug().
    tools: {
      root: function () { return (tree || buildTree()) && rootView(); },
      expand: function (id) { return (tree || buildTree()) && tools.expand(id); },
      read: function (id) { return (tree || buildTree()) && tools.read(id); },
      // Returns a Promise: await PageLens.tools.search('jacket'), or only inside
      // one subtree: await PageLens.tools.search('jacket', 'n4').
      search: function (text, within) { if (!tree) buildTree(); return tools.search(text, within); }
    },
    // Runs the explorer on a query without the chat, e.g.
    // (await PageLens.explore('is delivery free?')).result
    explore: function (query) {
      return explore(query).then(function (state) { if (config.debug) logQueryJourney(state); return state; });
    },
    // Explorer + answer step + highlights, without the chat, e.g.
    // (await PageLens.answer('is delivery free?')).reply
    answer: function (query) {
      clearHighlights();
      return explore(query).then(function (state) {
        return answerStep(state).then(function (a) {
          state.answer = a;
          if (config.debug) logQueryJourney(state);
          showHighlights(a.highlights);
          return { reply: a.reply, status: a.status, highlights: a.highlights.map(function (h) { return h.id; }), state: state };
        });
      });
    },
    // How keyword and meaning rankings placed each result, as a table.
    debugSearch: debugSearch,
    // DOM node for a tree ID from the latest tree, e.g. PageLens.nodeFor('n12').
    nodeFor: function (id) { var n = tree && tree.byId.get(id); return n ? n.el : null; }
  };

  // Start last, so every variable above is set even if the page has already loaded.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
