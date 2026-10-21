// Step 5 — Chat widget.
// Rendered in Shadow DOM so host-page CSS can't affect it. With data-debug, it
// also has a Tree view showing the page tree the explorer AI walks. On phones
// (NARROW_SCREEN) the panel is a bottom sheet over the lower part of the screen,
// so highlights scrolled to the top stay visible above it.

var WIDGET_CSS = [
  ':host { all: initial; }',
  '* { box-sizing: border-box; }',
  '.launcher { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 56px; height: 56px;',
  '  border: 0; border-radius: 50%; background: #4f46e5; color: #fff; font-size: 24px; cursor: pointer;',
  '  box-shadow: 0 4px 14px rgba(0,0,0,.25); }',
  '.panel { position: fixed; right: 16px; bottom: 84px; z-index: 2147483647;',
  '  width: min(400px, calc(100vw - 32px)); height: min(560px, calc(100vh - 110px));',
  '  display: flex; flex-direction: column; overflow: hidden; background: #fff; border-radius: 12px;',
  '  box-shadow: 0 8px 30px rgba(0,0,0,.25); font: 14px/1.4 system-ui, -apple-system, sans-serif; color: #111827; }',
  '.panel[hidden] { display: none; }',
  '.head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px;',
  '  background: #4f46e5; color: #fff; font-weight: 600; }',
  '.close { border: 0; background: none; color: #fff; font-size: 20px; line-height: 1; cursor: pointer; }',
  '.messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; background: #f9fafb; }',
  '.msg { max-width: 85%; padding: 8px 10px; border-radius: 10px; white-space: pre-wrap; overflow-wrap: anywhere; }',
  '.user { align-self: flex-end; background: #4f46e5; color: #fff; }',
  '.bot { align-self: flex-start; background: #fff; border: 1px solid #e5e7eb; }',
  '.links { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }',
  '.link { border: 1px solid #f59e0b; background: #fffbeb; color: #92400e; border-radius: 12px; padding: 2px 9px;',
  '  font: 12px system-ui, sans-serif; cursor: pointer; }',
  '.link:hover { background: #fef3c7; }',
  '.loading { color: #6b7280; }',
  '.elapsed { margin-left: 6px; font-size: 12px; color: #9ca3af; }',
  '.loading::after { content: ""; animation: dots 1.2s steps(4, end) infinite; }',
  '@keyframes dots { 0% { content: ""; } 25% { content: "."; } 50% { content: ".."; } 75% { content: "..."; } }',
  'form { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #e5e7eb; }',
  'input { flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; font: inherit; }',
  '.send { padding: 8px 12px; border: 0; border-radius: 8px; background: #4f46e5; color: #fff; font: inherit; cursor: pointer; }',
  '.send:disabled { opacity: .5; cursor: default; }',
  // Debug tree view (data-debug only).
  '.actions { display: flex; align-items: center; gap: 8px; }',
  '.tool { border: 1px solid rgba(255,255,255,.5); background: none; color: #fff; border-radius: 6px;',
  '  padding: 2px 8px; font: 12px system-ui, sans-serif; cursor: pointer; }',
  '.tool[aria-pressed=true] { background: #fff; color: #4f46e5; }',
  '.panel.wide-mode { width: min(560px, calc(100vw - 32px)); }',
  '.tree { flex: 1; overflow: auto; padding: 8px 10px; background: #fff; font: 12px/1.5 ui-monospace, Menlo, monospace; }',
  '.tree[hidden], .messages[hidden], form[hidden] { display: none; }',
  '.tree-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;',
  '  font-family: system-ui, sans-serif; color: #6b7280; }',
  '.tree-bar button { border: 1px solid #d1d5db; background: #fff; border-radius: 6px; padding: 2px 8px; cursor: pointer; }',
  '.tree details > .kids { margin-left: 14px; border-left: 1px dashed #e5e7eb; padding-left: 6px; }',
  '.tree summary { cursor: pointer; }',
  '.line { white-space: nowrap; border-radius: 4px; padding: 0 3px; }',
  '.line:hover { background: #eef2ff; }',
  '.leaf { margin-left: 14px; }',
  '.nid { color: #9ca3af; }',
  '.ntag { color: #4f46e5; margin: 0 4px; }',
  '.ntag.group { color: #059669; }',
  '.nlabel { color: #111827; cursor: pointer; }',
  '.nlabel:hover { text-decoration: underline; }',
  '.ncount { color: #9ca3af; margin-left: 4px; }',
  '.overlay { position: fixed; z-index: 2147483646; pointer-events: none; display: none;',
  '  outline: 2px solid #f59e0b; background: rgba(245,158,11,.15); border-radius: 3px; }',
  // Phones: a bottom sheet, larger tap targets, and 16px input text (smaller makes iOS zoom in).
  '@media ' + NARROW_SCREEN + ' {',
  '  .launcher { right: 12px; bottom: calc(12px + env(safe-area-inset-bottom, 0px)); }',
  '  .launcher.open { display: none; }',
  '  .panel, .panel.wide-mode { left: 0; right: 0; bottom: 0; width: 100%; height: 55vh; height: 55dvh;',
  '    border-radius: 16px 16px 0 0; padding-bottom: env(safe-area-inset-bottom, 0px); font-size: 15px; }',
  '  .panel.wide-mode { height: 85vh; height: 85dvh; }',
  '  .head { padding: 6px 6px 6px 14px; }',
  '  .close { width: 44px; height: 44px; font-size: 26px; }',
  '  .msg { max-width: 90%; }',
  '  .link { padding: 6px 12px; font-size: 13px; }',
  '  input { font-size: 16px; padding: 10px 12px; }',
  '  .send { padding: 10px 14px; }',
  '}'
].join('\n');

// Static markup only. Page text and model output are inserted with textContent, never innerHTML.
var WIDGET_HTML =
  '<button class="launcher" type="button" aria-label="Open PageLens assistant">💬</button>' +
  '<div class="panel" role="dialog" aria-label="PageLens assistant" hidden>' +
  '  <div class="head"><span>PageLens</span><div class="actions">' +
  '    <button class="close" type="button" aria-label="Close">×</button></div></div>' +
  '  <div class="messages" aria-live="polite"></div>' +
  '  <div class="tree" hidden></div>' +
  '  <form><input type="text" placeholder="What are you looking for?" aria-label="Your question" />' +
  '    <button class="send" type="submit">Send</button></form>' +
  '</div>' +
  '<div class="overlay"></div>';

function mountWidget() {
  // The host lives outside the AI region (end of <body>) and carries WIDGET_ATTR,
  // so the extractor never reads it.
  var host = document.createElement('div');
  host.setAttribute(WIDGET_ATTR, '');
  document.body.appendChild(host);

  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>' + WIDGET_CSS + '</style>' + WIDGET_HTML;

  var launcher = root.querySelector('.launcher');
  var panel = root.querySelector('.panel');
  var messages = root.querySelector('.messages');
  var form = root.querySelector('form');
  var input = root.querySelector('input');
  var send = root.querySelector('.send');

  function setOpen(open) {
    panel.hidden = !open;
    launcher.classList.toggle('open', open);
    launcher.setAttribute('aria-expanded', String(open));
    if (open) input.focus();
  }
  launcher.addEventListener('click', function () { setOpen(panel.hidden); });
  root.querySelector('.close').addEventListener('click', function () { setOpen(false); });

  if (config.debug) mountTreeView(root, panel, messages, form);

  // Adds a chat bubble. `links` (optional): [{ n, label }] buttons that scroll to
  // highlight n.
  function addMessage(className, text, links) {
    var msg = document.createElement('div');
    msg.className = 'msg ' + className;
    msg.textContent = text;
    if (links && links.length) {
      var row = document.createElement('div');
      row.className = 'links';
      links.forEach(function (link) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'link';
        button.textContent = (links.length > 1 ? link.n + ' · ' : '') + (link.label || 'Show on page');
        button.addEventListener('click', function () { focusHighlight(link.n); });
        row.appendChild(button);
      });
      msg.appendChild(row);
    }
    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
    return msg;
  }

  // A status bubble while a question is being answered: what PageLens is doing right
  // now (from the explorer's real steps), and the seconds elapsed, so the visitor can
  // tell it's working. Text is set with textContent only.
  function showProgress() {
    var msg = addMessage('bot loading', '');
    var text = document.createElement('span');
    var elapsed = document.createElement('span');
    elapsed.className = 'elapsed';
    msg.appendChild(text);
    msg.appendChild(elapsed);
    var started = Date.now();
    var current = 'Thinking';
    function render() {
      var secs = Math.floor((Date.now() - started) / 1000);
      text.textContent = current;
      elapsed.textContent = secs >= 15 ? secs + ' s · still working' : secs >= 2 ? secs + ' s' : '';
    }
    render();
    var timer = setInterval(render, 1000);
    return {
      update: function (line) { current = line; render(); messages.scrollTop = messages.scrollHeight; },
      remove: function () { clearInterval(timer); msg.remove(); }
    };
  }

  addMessage('bot', "Hi! Tell me what you're looking for and I'll point you to it on this page.");

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var query = input.value.trim();
    if (!query || send.disabled) return;

    addMessage('user', query);
    input.value = '';
    send.disabled = true;
    // On phones, close the keyboard so the page (and the highlights) can be seen.
    if (isNarrowScreen()) input.blur();
    var status = showProgress();

    answerQuery(query, status.update)
      .then(function (reply) {
        status.remove();
        addMessage('bot', reply.text, reply.links);
      })
      .catch(function (err) {
        status.remove();
        console.error(LOG_PREFIX, err);
        addMessage('bot', 'Sorry, something went wrong. Please try again.');
      })
      .then(function () {
        send.disabled = false;
        if (!isNarrowScreen()) input.focus();
      });
  });
}


// Debug tree view: shows the page tree the explorer AI walks. Hover a node to
// outline its element on the page; click its label to scroll to it.
function mountTreeView(root, panel, messages, form) {
  var treeEl = root.querySelector('.tree');
  var overlay = root.querySelector('.overlay');
  var toggle = document.createElement('button');
  toggle.className = 'tool';
  toggle.type = 'button';
  toggle.textContent = 'Tree';
  toggle.setAttribute('aria-pressed', 'false');
  root.querySelector('.actions').insertBefore(toggle, root.querySelector('.close'));

  // The overlay lives in our shadow root, so outlining never touches the host page.
  var outlined = null;
  function placeOverlay() {
    if (!outlined || !outlined.isConnected) { overlay.style.display = 'none'; return; }
    var r = outlined.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.top = r.top + 'px';
    overlay.style.left = r.left + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
  }
  function outline(el) { outlined = el; placeOverlay(); }
  window.addEventListener('scroll', placeOverlay, true);
  window.addEventListener('resize', placeOverlay);

  // One row: "n27 section Electronics (17)".
  function line(node) {
    var row = document.createElement('span');
    row.className = 'line';
    var parts = [
      ['nid', node.id],
      ['ntag' + (node.kind === 'item' ? '' : ' group'), nodeTag(node)],
      ['nlabel', nodeLabel(node) || '(no text)']
    ];
    var below = countDescendants(node);
    if (below) parts.push(['ncount', '(' + below + ')']);
    parts.forEach(function (part) {
      var span = document.createElement('span');
      span.className = part[0];
      span.textContent = part[1];
      row.appendChild(span);
    });
    row.addEventListener('mouseenter', function () { outline(node.el); });
    row.addEventListener('mouseleave', function () { outline(null); });
    row.querySelector('.nlabel').addEventListener('click', function (event) {
      event.preventDefault(); // Don't also open/close the <details>.
      node.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      outline(node.el);
    });
    return row;
  }

  function renderNode(node) {
    if (!node.children.length) {
      var leaf = document.createElement('div');
      leaf.className = 'leaf';
      leaf.appendChild(line(node));
      return leaf;
    }
    var details = document.createElement('details');
    var summary = document.createElement('summary');
    summary.appendChild(line(node));
    details.appendChild(summary);
    var kids = document.createElement('div');
    kids.className = 'kids';
    node.children.forEach(function (child) { kids.appendChild(renderNode(child)); });
    details.appendChild(kids);
    return details;
  }

  function render() {
    buildTree(); // Fresh tree from the live DOM, same as a query would get.
    treeEl.textContent = '';
    var bar = document.createElement('div');
    bar.className = 'tree-bar';
    var info = document.createElement('span');
    info.textContent = tree.byId.size + ' nodes · top level: ' + tree.roots.length;
    var refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.textContent = 'Refresh';
    refresh.addEventListener('click', render);
    bar.appendChild(info);
    bar.appendChild(refresh);
    treeEl.appendChild(bar);
    tree.roots.forEach(function (node) { treeEl.appendChild(renderNode(node)); });
  }

  toggle.addEventListener('click', function () {
    var showTree = treeEl.hidden;
    treeEl.hidden = !showTree;
    messages.hidden = showTree;
    form.hidden = showTree;
    panel.classList.toggle('wide-mode', showTree);
    toggle.setAttribute('aria-pressed', String(showTree));
    if (showTree) render(); else outline(null);
  });
}
