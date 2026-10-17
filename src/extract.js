// Step 2 — Extractor.
// Describes each visible, meaningful element in the region: links, buttons,
// headings, sections, and content blocks (paragraphs, prices, table rows).
// Redacts emails/phone numbers and never reads input values.

// The chat widget's host element carries this attribute so we never extract it.
var WIDGET_ATTR = 'data-pagelens-widget';
var MAX_TEXT = 80;     // Characters per label field, to keep token usage small.
var MAX_CONTENT = 200; // Characters per content block (paragraph, table row...), so answers have enough to go on.

// Things a user can act on.
var INTERACTIVE_SELECTOR = 'a[href], button, input:not([type=hidden]), select, textarea, summary, ' +
  '[role=button], [role=link], [role=tab], [role=menuitem]';
var HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
// Things that describe page structure.
var LANDMARK_SELECTOR = HEADING_SELECTOR + ', nav, section, article, aside, form, table, ' +
  '[role=region], [role=navigation], [role=search]';
var CANDIDATE_SELECTOR = INTERACTIVE_SELECTOR + ', ' + LANDMARK_SELECTOR;
// Containers whose label we report as an element's "section".
var CONTAINER_SELECTOR = 'section, article, aside, nav, form, table, [role=region], [role=navigation], [role=search]';
// Text inside these is never treated as content: it's either covered by a candidate
// above, not page text at all (scripts), possibly user-typed (textarea), or
// graphics (svg: chart axis labels like "Jan" or "$1500" are noise).
var NOT_CONTENT_SELECTOR = INTERACTIVE_SELECTOR + ', ' + HEADING_SELECTOR +
  ', caption, script, style, noscript, template, option, svg, [' + WIDGET_ATTR + ']';

// Rendered and not hidden by CSS. Off-screen elements still count, since we can scroll to them.
function isVisible(el) {
  if (typeof el.checkVisibility === 'function') {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  } else {
    // Older browsers: no rendered boxes means display:none somewhere up the tree.
    var style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.opacity === '0' || !el.getClientRects().length) return false;
  }
  var rect = el.getBoundingClientRect();
  // 1px boxes are screen-reader-only text (the "sr-only" pattern): not visible to users.
  return rect.width > 1 && rect.height > 1;
}

// Strip obvious PII before anything leaves the browser. Addresses are not detected.
var EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
var PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;
function redactPII(text) {
  return text
    .replace(EMAIL_RE, '[email]')
    .replace(PHONE_RE, function (m) {
      // Only treat it as a phone number if it has 9+ digits (skips dates like 2026-10-14).
      return m.replace(/\D/g, '').length >= 9 ? '[phone]' : m;
    });
}

// Collapse whitespace, redact PII, and truncate to `max` characters (default MAX_TEXT).
function clean(text, max) {
  max = max || MAX_TEXT;
  text = redactPII(String(text || '').replace(/\s+/g, ' ').trim());
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// Text of the elements referenced by aria-labelledby.
function labelledByText(el) {
  var ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
  return ids.map(function (id) {
    var ref = document.getElementById(id);
    return ref ? ref.textContent : '';
  }).join(' ');
}

// Short label for a container: its aria label, a table's caption, else its first heading.
function containerLabel(el) {
  var label = el.getAttribute('aria-label') || labelledByText(el);
  if (label) return label;
  if (el.tagName === 'TABLE') return el.caption ? el.caption.textContent : '';
  var heading = el.querySelector(HEADING_SELECTOR);
  return heading ? heading.textContent : '';
}

// Finds content text (paragraphs, prices, list items, table rows...) that isn't
// already part of a candidate element. Each piece of text is attributed to its
// nearest block-level ancestor, so inline tags like <b> or <span> don't split it.
// Returns Map: block element -> its own text (excluding text of nested blocks).
function collectTextBlocks(elements) {
  var inRegion = new Set(elements);
  var blockCache = new Map();
  var blocks = new Map();

  function isBlock(el) {
    if (!blockCache.has(el)) {
      var display = getComputedStyle(el).display;
      blockCache.set(el, display !== 'inline' && display !== 'contents');
    }
    return blockCache.get(el);
  }

  // The block a text node belongs to, or null if it isn't content.
  function ownerBlock(textNode) {
    var el = textNode.parentElement;
    if (!el || el.closest(NOT_CONTENT_SELECTOR)) return null;
    while (el && !isBlock(el)) el = el.parentElement;
    // Table cells are grouped into one entry per row.
    if (el && el.matches('td, th')) el = el.closest('tr');
    return el && inRegion.has(el) ? el : null;
  }

  // Pass 1: find which elements own any content text.
  elements.forEach(function (el) {
    el.childNodes.forEach(function (node) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) return;
      var block = ownerBlock(node);
      if (block) blocks.set(block, '');
    });
  });

  // Pass 2: read each block's own text in reading order, skipping text that
  // belongs to nested blocks (they get their own entry).
  blocks.forEach(function (_text, block) {
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    var parts = [];
    while (walker.nextNode()) {
      if (ownerBlock(walker.currentNode) === block) parts.push(walker.currentNode.textContent);
    }
    blocks.set(block, parts.join(''));
  });

  blocks.forEach(function (text, block) {
    // Skip decoration such as emoji-only image placeholders.
    if (!/[\p{L}\p{N}]/u.test(text)) blocks.delete(block);
    // Rows read better as "cell | cell | cell".
    else if (block.tagName === 'TR') {
      blocks.set(block, Array.prototype.map.call(block.cells, function (cell) {
        return cell.innerText.replace(/\s+/g, ' ').trim();
      }).join(' | '));
    }
  });
  return blocks;
}

// A div/span made clickable by script (e.g. React onClick). Handlers can't be seen
// in the DOM, so the signal is the pointer cursor. cursor is inherited, so only the
// outermost element with it counts, and not inside a real link or button.
function isClickable(el) {
  if (el.matches(INTERACTIVE_SELECTOR) || (el.parentElement && el.parentElement.closest(INTERACTIVE_SELECTOR))) return false;
  if (getComputedStyle(el).cursor !== 'pointer') return false;
  return !el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer';
}

// A chart or illustration drawn as one large <svg>. Its inner text (axis labels)
// is skipped, but the graphic itself is a node, so its card still has content.
function isGraphic(el) {
  if (el.tagName.toLowerCase() !== 'svg' || (el.parentElement && el.parentElement.closest('svg, ' + INTERACTIVE_SELECTOR))) return false;
  var rect = el.getBoundingClientRect();
  return rect.width >= 100 && rect.height >= 60;
}

function graphicLabel(el) {
  var title = el.querySelector('title');
  return el.getAttribute('aria-label') || (title && title.textContent) || 'chart or graphic';
}

// The visible text that best describes an element. Never reads input values.
function textOf(el) {
  if (el.matches('input, select, textarea')) {
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'reset') return el.value;
    var labels = el.labels ? Array.prototype.map.call(el.labels, function (l) { return l.textContent; }).join(' ') : '';
    return labels || el.getAttribute('placeholder') || el.getAttribute('name') || '';
  }
  if (el.matches(CONTAINER_SELECTOR)) return containerLabel(el);
  var text = el.innerText;
  if (!text.trim()) {
    // Icon-only links/buttons: fall back to image alt text or title.
    var img = el.querySelector('img[alt]');
    text = (img && img.getAttribute('alt')) || el.getAttribute('title') || '';
  }
  return text;
}

// Only the path and #hash, never the query string (it can carry personal data).
function cleanHref(el) {
  var raw = el.getAttribute('href');
  if (!raw || /^javascript:/i.test(raw)) return '';
  if (raw.charAt(0) === '#') return raw;
  try {
    var url = new URL(raw, location.href);
    return (url.origin === location.origin ? '' : url.origin) + url.pathname + url.hash;
  } catch (e) {
    return '';
  }
}

// Finds every describable element in the region: candidates (links, buttons,
// headings, sections...) and content blocks (paragraphs, prices, table rows...).
// Returns [{ el, data }] in document order, where data is
// { tag, text, label, href, role, type, section, near } with empty fields omitted.
function extractItems() {
  var items = [];
  var lastHeading = ''; // Most recent visible heading in document order.
  var elements = getRegionElements();
  var textBlocks = collectTextBlocks(elements);

  elements.forEach(function (el) {
    var blockText = textBlocks.get(el);
    var isCandidate = el.matches(CANDIDATE_SELECTOR);
    var clickable = !isCandidate && isClickable(el);
    var graphic = isGraphic(el);
    if (!isCandidate && !clickable && !graphic && blockText === undefined) return;
    if (el.closest('[' + WIDGET_ATTR + ']')) return;
    if (!isVisible(el)) return;

    var isHeading = el.matches(HEADING_SELECTOR);
    var isContainer = el.matches(CONTAINER_SELECTOR);
    var text = graphic ? clean(graphicLabel(el)) : isCandidate || clickable ? clean(textOf(el)) : '';
    // Content blocks (and unlabelled containers with their own text) use their content.
    if (!text && blockText) text = clean(blockText, MAX_CONTENT);
    var ariaLabel = clean(el.getAttribute('aria-label') || labelledByText(el));
    var href = el.matches('a[href]') ? cleanHref(el) : '';
    // Nothing to describe it by. Landmarks (nav, section...) are kept anyway: the
    // tree labels them by their contents.
    if (!text && !ariaLabel && !href && !isContainer) return;

    // Nearest ancestor container that has a label (skips e.g. an unlabelled <form>).
    var container = el.parentElement && el.parentElement.closest(CONTAINER_SELECTOR);
    while (container && !clean(containerLabel(container))) {
      container = container.parentElement && container.parentElement.closest(CONTAINER_SELECTOR);
    }
    var section = container ? clean(containerLabel(container)) : '';

    // A heading that only names its container (e.g. <section><h2>Electronics</h2>)
    // duplicates the container's entry, so drop it.
    if (isHeading && text === section && container.querySelector(HEADING_SELECTOR) === el) {
      lastHeading = text;
      return;
    }

    var data = { tag: el.tagName.toLowerCase() };
    if (text) data.text = text;
    if (ariaLabel && ariaLabel !== text) data.label = ariaLabel;
    if (href) data.href = href;
    if (el.getAttribute('role')) data.role = el.getAttribute('role');
    if (el.matches('input')) data.type = el.type;
    if (clickable) data.clickable = true;
    if (section && section !== text) data.section = section;
    // Nearest heading above the element, e.g. the product name above "Add to cart".
    // Not for containers: the heading above a section belongs to the previous section.
    if (!isHeading && !isContainer && lastHeading && lastHeading !== section && lastHeading !== text) {
      data.near = lastHeading;
    }

    if (isHeading) lastHeading = text;
    items.push({ el: el, data: data });
  });

  return items;
}
