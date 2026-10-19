// Entry point: public debugging API and startup. Runs last, after every other
// file has defined its functions and variables.

if (!startMarker) {
  console.error(LOG_PREFIX, 'Could not find the start <script data-start> tag. PageLens is disabled.');
} else {
  if (!config.apiKey) {
    console.warn(LOG_PREFIX, 'No data-api-key on the start tag. Queries will fail until one is set.');
  } else if (config.apiKey === DEV_API_KEY) {
    console.info(LOG_PREFIX, 'Using the development API key from .env (development build, not for release).');
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
