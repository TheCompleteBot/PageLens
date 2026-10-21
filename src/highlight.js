// Step 5 — Execute: scrolls to and highlights the elements the reply cites.
// Highlights fade out after HIGHLIGHT_VISIBLE_MS, or at once when the visitor clicks
// anywhere on the page (clicks inside the PageLens chat don't count, so its
// highlight buttons can bring one back).
// Only draws boxes over the page: the host page's DOM and styles are never changed.
// The boxes live in their own Shadow DOM layer, marked with WIDGET_ATTR so the
// extractor ignores it.

var HIGHLIGHT_CSS = [
  ':host { all: initial; }',
  '.box { position: fixed; z-index: 2147483645; pointer-events: none; box-sizing: border-box;',
  '  border: 3px solid #f59e0b; border-radius: 6px; background: rgba(245,158,11,.12);',
  '  box-shadow: 0 0 0 4px rgba(245,158,11,.25); transition: opacity .6s; }',
  '.box.gone { opacity: 0; }',
  '.box.flash { animation: flash 1s ease-out 2; }',
  '@keyframes flash { 50% { box-shadow: 0 0 0 10px rgba(245,158,11,.45); } }',
  '.badge { position: absolute; top: -12px; left: -12px; min-width: 22px; height: 22px; padding: 0 5px;',
  '  border-radius: 11px; background: #f59e0b; color: #fff; font: 600 12px/22px system-ui, sans-serif;',
  '  text-align: center; box-sizing: border-box; }'
].join('\n');

var HIGHLIGHT_VISIBLE_MS = 5000;

// Phones and narrow windows: the chat is a bottom sheet (widget.js), so highlights
// are scrolled to the top of the screen instead of the middle.
var NARROW_SCREEN = '(max-width: 600px)';

function isNarrowScreen() {
  return window.matchMedia(NARROW_SCREEN).matches;
}

var highlightLayer = null; // { root, boxes: [{ el, box }] }
var fadeTimer = null;

function ensureHighlightLayer() {
  if (highlightLayer && highlightLayer.host.isConnected) return highlightLayer;
  var host = document.createElement('div');
  host.setAttribute(WIDGET_ATTR, '');
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>' + HIGHLIGHT_CSS + '</style>';
  highlightLayer = { host: host, root: root, boxes: [] };
  var queued = false;
  function update() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; placeBoxes(); });
  }
  window.addEventListener('scroll', update, true);
  window.addEventListener('resize', update);
  // A click on the page (not on PageLens itself) dismisses the highlights.
  document.addEventListener('pointerdown', function (event) {
    var inside = event.composedPath().some(function (el) { return el.hasAttribute && el.hasAttribute(WIDGET_ATTR); });
    if (!inside) fadeHighlights();
  }, true);
  return highlightLayer;
}

function placeBoxes() {
  if (!highlightLayer) return;
  highlightLayer.boxes.forEach(function (b) {
    if (!b.el.isConnected) { b.box.style.display = 'none'; return; }
    var r = b.el.getBoundingClientRect();
    var pad = 4;
    b.box.style.display = 'block';
    b.box.style.top = r.top - pad + 'px';
    b.box.style.left = r.left - pad + 'px';
    b.box.style.width = r.width + 2 * pad + 'px';
    b.box.style.height = r.height + 2 * pad + 'px';
  });
}

function fadeHighlights() {
  clearTimeout(fadeTimer);
  if (highlightLayer) highlightLayer.boxes.forEach(function (b) { b.box.classList.add('gone'); });
}

// Starts (or restarts) the countdown after which the highlights fade.
function scheduleFade() {
  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(fadeHighlights, HIGHLIGHT_VISIBLE_MS);
}

function clearHighlights() {
  clearTimeout(fadeTimer);
  if (!highlightLayer) return;
  highlightLayer.boxes.forEach(function (b) { b.box.remove(); });
  highlightLayer.boxes = [];
}

// highlights: [{ n, el }] from the answer step. Draws a numbered box on each and
// scrolls the first into view.
function showHighlights(highlights) {
  clearHighlights();
  if (!highlights.length) return;
  var layer = ensureHighlightLayer();
  highlights.forEach(function (h) {
    var box = document.createElement('div');
    box.className = 'box';
    if (highlights.length > 1) {
      var badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = String(h.n);
      box.appendChild(badge);
    }
    layer.root.appendChild(box);
    layer.boxes.push({ el: h.el, box: box, n: h.n });
  });
  placeBoxes();
  focusHighlight(highlights[0].n);
}

// Scrolls highlight n into view and makes it pulse (also used by the chat's links).
function focusHighlight(n) {
  if (!highlightLayer) return;
  var b = highlightLayer.boxes.filter(function (x) { return x.n === n; })[0];
  if (!b || !b.el.isConnected) return;
  b.box.classList.remove('gone');
  scheduleFade();
  b.el.scrollIntoView({ block: isNarrowScreen() ? 'start' : 'center', behavior: 'smooth' });
  b.box.classList.remove('flash');
  void b.box.offsetWidth; // restart the animation
  b.box.classList.add('flash');
}
