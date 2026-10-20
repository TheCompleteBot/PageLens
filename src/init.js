// Step 1 — Config + init.
// Finds the start/end markers, reads config from the start tag, and returns the
// elements of the AI region (with a fallback if a re-render removes the markers).

var LOG_PREFIX = '[PageLens]';
var START_SELECTOR = 'script[data-start]';
var END_SELECTOR = 'script[data-pagelens-end]';

// document.currentScript is only set while this file is first executing,
// so it must be captured here at the top level, not inside a callback.
// The querySelector fallback covers async/dynamically injected script tags.
var startMarker = document.currentScript || document.querySelector(START_SELECTOR);

// Read from the start tag's data-* attributes. main.js stops if there is no start tag.
var config = {
  // A leftover placeholder like "YOUR_GEMINI_API_KEY" counts as no key. Without a
  // real one, development builds fall back to DEV_API_KEY (set by build.js from .env).
  apiKey: ((startMarker && startMarker.getAttribute('data-api-key')) || '').replace(/^YOUR_.*$/, '') || DEV_API_KEY,
  provider: ((startMarker && startMarker.getAttribute('data-provider')) || 'gemini').toLowerCase(),
  // The model the explorer uses (see gemini.js), and how it picks targets:
  // 'llm' (explore with tools) or 'search' (top search hit, no LLM; a baseline).
  model: (startMarker && startMarker.getAttribute('data-model')) || 'gemini-3.5-flash-lite',
  navigator: ((startMarker && startMarker.getAttribute('data-navigator')) || 'llm').toLowerCase(),
  // data-debug on the start tag adds a Tree view to the widget (developer tool).
  debug: !!startMarker && startMarker.hasAttribute('data-debug')
};

// Region state. end and commonParent are filled in once the DOM is parsed.
var region = {
  start: startMarker,
  end: null,
  // Lowest element containing both markers. Used as a fallback if a
  // framework re-render removes the markers from the DOM.
  commonParent: null
};

// Returns the lowest element that contains both a and b.
function findCommonParent(a, b) {
  var node = a.parentElement;
  while (node && !node.contains(b)) node = node.parentElement;
  return node || document.body;
}

// True if `el` sits strictly between the start and end markers.
// Ancestors of either marker (e.g. <body>) are excluded, because they are
// only partly inside the region.
function isBetweenMarkers(el, start, end) {
  var afterStart = start.compareDocumentPosition(el);
  if (!(afterStart & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
  if (afterStart & Node.DOCUMENT_POSITION_CONTAINS) return false;

  if (!end) return true; // No end marker: region runs to the end of the document.
  var beforeEnd = el.compareDocumentPosition(end);
  if (!(beforeEnd & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
  if (beforeEnd & Node.DOCUMENT_POSITION_CONTAINED_BY) return false;
  return true;
}

// Returns every element in the AI region, in document order.
// Called on each query, since the DOM may have changed since load.
function getRegionElements() {
  var start = region.start;
  var end = region.end;

  // Markers may have been removed and re-created by a framework re-render.
  if (!start.isConnected) start = document.querySelector(START_SELECTOR);
  if (end && !end.isConnected) end = document.querySelector(END_SELECTOR);

  // Normal case: everything between the two markers.
  if (start && start.isConnected) {
    var root = end ? findCommonParent(start, end) : document.body;
    return Array.prototype.filter.call(root.querySelectorAll('*'), function (el) {
      return isBetweenMarkers(el, start, end);
    });
  }

  // Fallback: markers are gone, so use everything inside the saved container.
  if (region.commonParent && region.commonParent.isConnected) {
    console.warn(LOG_PREFIX, 'Markers not found; falling back to their common parent container.');
    return Array.prototype.slice.call(region.commonParent.querySelectorAll('*'));
  }

  console.warn(LOG_PREFIX, 'AI region not found.');
  return [];
}

// The end marker and region content come after this script in the HTML, so
// they don't exist yet while this file runs. Finish setup once the DOM is parsed.
function init() {
  region.end = document.querySelector(END_SELECTOR);
  if (!region.end) {
    console.warn(LOG_PREFIX, 'No <script data-pagelens-end> found; the region runs to the end of the page.');
  }
  region.commonParent = region.end ? findCommonParent(region.start, region.end) : document.body;

  mountWidget();
}
