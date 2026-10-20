// Step 2b — Page tree + explorer tools.
// Turns the extracted items into a tree and provides the read-only tools the
// explorer AI uses to walk it: expand(id), read(id), search(text).

var MAX_DEPTH = 6;      // expand() refuses nodes deeper than this.
var MAX_READ = 1500;    // Characters returned by one read().
var MAX_SEARCH = 8;     // Results returned by one search().
var MAX_PREVIEW = 60;   // Characters in a group's preview label.
var MIN_RECORDS = 3;    // Repeated siblings needed to form a list of records.
var MAX_DETAILS = 100;  // Characters of a card's inner text shown in its summary.

// The latest tree: { roots: [node], byId: Map(id -> node), seen: Set(id) }.
// node = { id, el, kind, data, title, children: [node], parent, depth }, where kind is
//   'item'   an extracted element (link, heading, price...); data describes it
//   'group'  a wrapper that forms a unit: starts with a heading, or is a visual box
//   'list'   a run of repeated siblings, e.g. a product grid
//   'record' one entry of a list, e.g. one product card
// data is null for group/list, and for records that aren't extracted items themselves.
// Rebuilt on every query, so IDs are only valid for one query.
var tree = null;

function makeNode(el, kind, data, children, title) {
  return { el: el, kind: kind, data: data || null, children: children, title: title || '' };
}

// Builds the tree from the DOM. Plain wrappers are skipped; structure comes from
// three layers, because real apps rarely use semantic tags:
//   1. repeated siblings (MDR-style data records) -> list of records
//   2. headings, including "visual" ones (bold/larger short text)  -> group
//   3. visual boxes (own background, full border, or shadow)        -> group
function buildTree() {
  var items = extractItems();
  var dataByEl = new Map(items.map(function (i) { return [i.el, i.data]; }));
  var elements = getRegionElements();
  var inRegion = new Set(elements);

  // Returns the nodes for el's subtree, as a list (a skipped wrapper returns its children's nodes).
  function build(el) {
    var childEls = Array.prototype.slice.call(el.children);
    var kids = groupRecords(el, childEls, childEls.map(build), dataByEl);
    var data = dataByEl.get(el);

    if (data) {
      // A sole child group adds a level without adding meaning, so lift its children.
      if (kids.length === 1 && kids[0].kind === 'group') kids = kids[0].children;
      return [makeNode(el, 'item', data, kids)];
    }
    if (kids.length >= 2 && isVisible(el)) {
      // The heading must come first, so an outer wrapper doesn't take its name
      // from a heading halfway down the page.
      if (isHeadingLike(kids[0], kids)) {
        // A heading names what follows it, but not a nav/aside that comes later:
        // those stay siblings of the group.
        var end = kids.findIndex(function (k, n) { return n > 0 && k.data && /^(nav|aside)$/.test(k.data.tag); });
        if (end === -1) end = kids.length;
        var group = makeNode(el, 'group', null, kids.slice(0, end), nodeLabel(kids[0]));
        return [group].concat(kids.slice(end));
      }
      if (isVisualBox(el)) {
        var heading = kids.slice(0, 2).filter(function (k) { return isHeadingLike(k, kids); })[0];
        return [makeNode(el, 'group', null, kids, heading ? nodeLabel(heading) : '')];
      }
    }
    return kids; // Plain wrapper: pass its children through.
  }

  // Top-level region elements are those whose parent is outside the region.
  var roots = [];
  elements.forEach(function (el) {
    if (!inRegion.has(el.parentElement)) roots = roots.concat(build(el));
  });

  // Assign IDs in document order and record parent/depth.
  var byId = new Map();
  (function assign(nodes, parent, depth) {
    nodes.forEach(function (node) {
      node.id = 'n' + (byId.size + 1);
      node.parent = parent;
      node.depth = depth;
      byId.set(node.id, node);
      assign(node.children, node, depth + 1);
    });
  })(roots, null, 1);

  tree = { roots: roots, byId: byId, seen: new Set() };
  return tree;
}

// ---- Layer 1: repeated siblings (data records) ----

// Tag names inside an element, two levels deep: its "shape".
function shapeOf(el) {
  var tags = new Set();
  Array.prototype.forEach.call(el.children, function (child) {
    tags.add(child.tagName);
    Array.prototype.forEach.call(child.children, function (grandchild) { tags.add('>' + grandchild.tagName); });
  });
  return tags;
}

// Two siblings are entries of the same list if they share tag and classes and
// have a similar inner shape (at least half their inner tags in common).
function sameRecordShape(a, b) {
  if (a.tagName !== b.tagName || (a.getAttribute('class') || '') !== (b.getAttribute('class') || '')) return false;
  var sa = shapeOf(a);
  var sb = shapeOf(b);
  if (!sa.size && !sb.size) return true;
  var common = 0;
  sa.forEach(function (tag) { if (sb.has(tag)) common++; });
  return common / (sa.size + sb.size - common) >= 0.5;
}

function countNodes(nodes) {
  return nodes.reduce(function (n, node) { return n + 1 + countNodes(node.children); }, 0);
}

// Replaces runs of MIN_RECORDS+ look-alike siblings, each holding 2+ nodes, with
// one list node whose children are records. Single-node siblings (e.g. the links
// of a menu, or table rows) are left alone: they're already one node each.
function groupRecords(parentEl, childEls, results, dataByEl) {
  var out = [];
  var i = 0;
  while (i < childEls.length) {
    var j = i + 1;
    while (j < childEls.length && sameRecordShape(childEls[i], childEls[j])) j++;
    var run = results.slice(i, j);
    var isList = run.length >= MIN_RECORDS && run.every(function (nodes) { return countNodes(nodes) >= 2; });
    if (isList) {
      var records = run.map(function (nodes, k) {
        var el = childEls[i + k];
        // If the sibling already became one node (e.g. a clickable card), reuse it.
        if (nodes.length === 1 && nodes[0].el === el) {
          nodes[0].kind = 'record';
          return nodes[0];
        }
        return makeNode(el, 'record', dataByEl.get(el), nodes);
      });
      titleRecords(records);
      out.push(makeNode(parentEl, 'list', null, records));
    } else {
      run.forEach(function (nodes) { out = out.concat(nodes); });
    }
    i = j;
  }
  return out;
}

// Names each record. Prefers a real heading; otherwise the first text that is
// distinctive: not repeated across records (so "men's clothing" or "Add to cart"
// don't win), has letters (so prices don't win), and isn't a tiny badge like "OM".
function titleRecords(records) {
  function texts(node, out) {
    node.children.forEach(function (child) {
      if (child.data && child.data.text) out.push(child);
      texts(child, out);
    });
    return out;
  }
  var perRecord = records.map(function (r) { return texts(r, []); });
  var frequency = new Map();
  perRecord.forEach(function (nodes) {
    new Set(nodes.map(function (n) { return n.data.text; })).forEach(function (t) {
      frequency.set(t, (frequency.get(t) || 0) + 1);
    });
  });
  records.forEach(function (record, k) {
    var nodes = perRecord[k];
    var heading = nodes.filter(function (n) { return /^h[1-6]$/.test(n.data.tag) || n.data.role === 'heading'; })[0];
    var distinctive = nodes.filter(function (n) {
      var t = n.data.text;
      return t.length >= 3 && /\p{L}/u.test(t) && frequency.get(t) < 2 && n.data.tag !== 'input';
    })[0];
    var pick = heading || distinctive;
    if (pick) record.title = pick.data.text;
  });
}

// ---- Layers 2 + 3: headings and visual boxes ----

function isInteractiveNode(node) {
  var d = node.data;
  return !!d && (!!d.href || !!d.clickable || /^(button|input|select|textarea|summary)$/.test(d.tag) ||
    /^(button|link|tab|menuitem)$/.test(d.role || ''));
}

// A real heading, or short text that looks like one: bold, larger than what
// follows, or a label above a run of links/buttons (e.g. "General" in a sidebar).
function isHeadingLike(node, siblings) {
  var d = node.data;
  if (!d || node.children.length) return false;
  if (/^h[1-6]$/.test(d.tag) || d.role === 'heading') return true;
  if (isInteractiveNode(node)) return false;
  var text = d.text || '';
  if (text.length < 3 || text.length > 60 || !/\p{L}/u.test(text)) return false;

  var style = getComputedStyle(node.el);
  if (parseInt(style.fontWeight, 10) >= 600) return true;
  var next = siblings[1];
  if (next && parseFloat(style.fontSize) >= 1.15 * parseFloat(getComputedStyle(next.el).fontSize)) return true;
  var rest = siblings.slice(1);
  return rest.length >= 2 && rest.every(isInteractiveNode);
}

function isOpaque(color) {
  return !!color && color !== 'transparent' && !/rgba?\([^)]*,\s*0\)$/.test(color);
}

// The background color an element is drawn on (white if nothing sets one).
function effectiveBackground(el) {
  for (; el; el = el.parentElement) {
    var bg = getComputedStyle(el).backgroundColor;
    if (isOpaque(bg)) return bg;
  }
  return 'rgb(255, 255, 255)';
}

// Looks like a box on screen: a shadow, a border on all four sides, or a
// background different from what's behind it.
function isVisualBox(el) {
  var s = getComputedStyle(el);
  if (s.boxShadow && s.boxShadow !== 'none') return true;
  var bordered = ['Top', 'Right', 'Bottom', 'Left'].every(function (side) {
    return parseFloat(s['border' + side + 'Width']) > 0 && s['border' + side + 'Style'] !== 'none';
  });
  if (bordered) return true;
  return isOpaque(s.backgroundColor) && s.backgroundColor !== effectiveBackground(el.parentElement);
}

// ---- Labels and summaries ----

// What the AI sees as the node's kind: the HTML tag for items, else group/list/record.
function nodeTag(node) {
  return node.kind === 'item' ? node.data.tag : node.kind;
}

// Number of nodes under a node, so the AI knows whether expanding is worthwhile.
function countDescendants(node) {
  return countNodes(node.children);
}

function nodeLabel(node) {
  if (node.title) return node.title;
  if (node.kind === 'item' && (node.data.text || node.data.label || node.data.href || !node.children.length)) {
    return node.data.text || node.data.label || node.data.href || '';
  }
  // A box whose first part is a titled header (e.g. a card header) takes that title.
  var first = node.children[0];
  if (node.kind === 'group' && first && first.kind === 'group' && first.title) return first.title;
  var preview = clean(node.children.map(nodeLabel).join(' · '), MAX_PREVIEW);
  return node.kind === 'list' ? node.children.length + ' items: ' + preview : preview;
}

// A node's text as plain lines: its own text, then its subtree's, one line per
// node, without ids and without a line that repeats the one above (a card's title
// is usually also its heading). Subtrees of nodes in `exclude` (a Set) are left
// out, so text already given elsewhere isn't repeated.
function plainText(node, exclude) {
  var lines = [];
  (function walk(n) {
    if (exclude && exclude.has(n)) return;
    // Own text only: for groups and lists nodeLabel would be a preview of the children.
    var d = n.data || {};
    var line = n.title || d.text || d.label || (n.children.length ? '' : d.href || '');
    if (line && line !== lines[lines.length - 1]) lines.push(line);
    n.children.forEach(walk);
  })(node);
  var text = lines.join('\n'); // labels are already cleaned and PII-redacted by the extractor
  return text.length > MAX_READ ? text.slice(0, MAX_READ - 1) + '…' : text;
}

// The text inside a card, minus its title, on one line: what a summary shows as
// `details`, so prices and figures are visible without a read().
function cardDetails(node) {
  var title = nodeLabel(node);
  var inner = plainText(node).split('\n').filter(function (line) { return line !== title; }).join(' · ');
  return inner ? clean(inner, MAX_DETAILS) : '';
}

// One-line description of a node, as the AI sees it. section/near are left out:
// the tree position already says where a node is. Cards (product records, small
// titled groups) also get `details`: the text inside them.
function summarize(node) {
  var s = { id: node.id, tag: nodeTag(node) };
  var text = nodeLabel(node);
  if (text) s.text = text;
  if (node.data) {
    ['label', 'href', 'role', 'type', 'clickable'].forEach(function (key) {
      if (node.data[key] && node.data[key] !== text) s[key] = node.data[key];
    });
  }
  if (node.children.length && isCard(node)) {
    var details = cardDetails(node);
    if (details) s.details = details;
  }
  var below = countDescendants(node);
  if (below) s.contains = below;
  return s;
}

// "Electronics > list (4) > 20000mAh Power Bank, 22.5W fast charging".
// Lists show as "list (N)": their preview label would waste tokens here. Groups
// without a title are skipped: their label would only be a preview of their
// children ("Toggle Sidebar · Overview · …").
function pathOf(node) {
  var parts = [];
  for (var n = node.parent; n; n = n.parent) {
    if (n.kind === 'group' && !n.title) continue;
    parts.unshift(n.kind === 'list' ? 'list (' + n.children.length + ')' : clean(nodeLabel(n), 40));
  }
  return parts.join(' > ');
}

// Looks up a node for a tool call. Returns { node } or { error }.
function lookup(id) {
  var node = tree && tree.byId.get(String(id));
  if (!node) return { error: 'Unknown id "' + id + '". Use an id returned by a previous tool call.' };
  if (!node.el.isConnected) return { error: 'Node ' + id + ' is no longer on the page.' };
  return { node: node };
}

function markSeen(nodes) {
  nodes.forEach(function (node) { tree.seen.add(node.id); });
}

// The explorer's first view: the top level of the tree.
function rootView() {
  markSeen(tree.roots);
  return { children: tree.roots.map(summarize) };
}

var tools = {
  expand: function (id) {
    var found = lookup(id);
    if (found.error) return found;
    var node = found.node;
    if (!node.children.length) return { error: 'Node ' + id + ' has no children. Use read or finish.' };
    if (node.depth >= MAX_DEPTH) return { error: 'Depth limit (' + MAX_DEPTH + ') reached. Use read instead.' };
    markSeen(node.children);
    return { id: node.id, children: node.children.map(summarize) };
  },

  read: function (id) {
    var found = lookup(id);
    if (found.error) return found;
    // Every node in the subtree, one per line with its id, so the answer can cite the exact row.
    var lines = [];
    var length = 0;
    var truncated = false;
    (function walk(node, indent) {
      if (truncated) return;
      var line = indent + node.id + ' ' + nodeTag(node) + ': ' + nodeLabel(node);
      if (length + line.length > MAX_READ) { truncated = true; return; }
      lines.push(line);
      length += line.length + 1;
      tree.seen.add(node.id);
      node.children.forEach(function (child) { walk(child, indent + '  '); });
    })(found.node, '');
    return { id: found.node.id, text: lines.join('\n'), truncated: truncated };
  },

  // Hybrid search (see search.js). Async, because the meaning half calls the
  // embedding API. Each hit is reported once: a match inside a product card is
  // returned as the card's record.
  // within (optional): an id; only nodes inside that subtree are searched,
  //   e.g. search('snowboard jacket', 'n4') to look among one list of products.
  // options (optional): { quiet: true } skips the developer trace;
  //   onJourney(journey) receives the step-by-step record (used by the query trace).
  search: function (text, within, options) {
    options = options || {};
    var t = tree; // The tree this search ran on, even if a new query rebuilds it meanwhile.
    var scope = null;
    if (within) {
      var found = lookup(within);
      if (found.error) return Promise.resolve(found);
      scope = found.node;
    }
    return hybridSearch(t, text, MAX_SEARCH, scope).then(function (out) {
      out.hits.forEach(function (hit) { t.seen.add(hit.node.id); });
      var result = {
        retrieval: out.retrieval,
        results: out.hits.map(function (hit) {
          var s = summarize(hit.node);
          s.path = pathOf(hit.node);
          s.via = hit.via;
          return s;
        })
      };
      if (scope) result.within = scope.id;
      if (!result.results.length) {
        result.hint = 'No matches' + (scope ? ' inside ' + scope.id : '') +
          '. Try other words (synonyms, the page\'s likely wording), ' +
          (scope ? 'search the whole page, ' : '') + 'or expand from the top level.';
      }
      if (options.onJourney) options.onJourney(out.journey);
      if (config.debug && !options.quiet) logSearchJourney(out.journey, result.results);
      return result;
    });
  }
};

// The whole tree as indented text, for debugging.
function treeToText(nodes, indent) {
  return nodes.map(function (node) {
    return (indent || '') + node.id + ' ' + nodeTag(node) + ': ' + nodeLabel(node) + '\n' +
      treeToText(node.children, (indent || '') + '  ');
  }).join('');
}

// Logs the full tree. Run PageLens.debug() in the console.
function debugTree() {
  buildTree();
  console.log(LOG_PREFIX, tree.byId.size + ' nodes\n' + treeToText(tree.roots));
  return tree;
}
