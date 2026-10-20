// Query handler: runs the explorer and turns its result into a chat reply.
// PREVIEW: there is no answer step or highlighting yet, so the reply says which
// node(s) the explorer chose and shows the hand-off the answer step will receive.

var ACTION_LABELS = {
  answer: 'The answer is in',
  highlight: 'I would point you to',
  maybe: 'Not listed on this page, but it might be under',
  abstain: 'Not found on this page.'
};

// One JSON object per line, for display.
function jsonLines(list) {
  return list.map(function (x) { return JSON.stringify(x); }).join('\n');
}

// One line per tool call, e.g. "2. search("delivery", within n4) → 3 results".
function stepLines(state) {
  var lines = [];
  state.steps.forEach(function (step) {
    step.calls.forEach(function (call) { lines.push(lines.length + 1 + '. ' + describeCall(call)); });
  });
  return lines;
}

function describeCall(call) {
  var a = call.args || {};
  var head = call.name === 'search'
    ? 'search(' + JSON.stringify(a.text) + (a.within ? ', within ' + a.within : '') + ')'
    : call.name === 'finish'
      ? 'finish(' + a.action + (a.match ? ' ' + a.match : '') + (a.targets && a.targets.length ? ', ' + a.targets.join(' ') : '') + ')'
      : call.name + (a.id ? '(' + a.id + ')' : '');
  if (call.error) return head + ' ✗ ' + call.error;
  var r = call.result || {};
  if (r.children) return head + ' → ' + r.children.length + ' children';
  if (r.text) return head + ' → ' + r.text.length + ' chars' + (r.truncated ? ' (truncated)' : '');
  if (r.results) return head + ' → ' + r.results.length + ' results';
  return head;
}

// The hand-off as the answer step will see it: sources first, then other read text.
function handoffLines(h) {
  var lines = ['Sources (cited and highlighted):'];
  h.sources.forEach(function (s) { lines.push('[' + s.id + '] ' + (s.path || '(top level)'), indentText(s.text)); });
  if (h.context.length) {
    lines.push('Other page text the explorer read:');
    h.context.forEach(function (s) { lines.push('[' + s.id + '] ' + (s.path || '(top level)'), indentText(s.text)); });
  }
  return lines;
}

function indentText(text) {
  return text.split('\n').map(function (line) { return '    ' + line; }).join('\n');
}

// Answers a query. Returns a Promise of { text, detail? } for the chat widget.
function answerQuery(query) {
  return explore(query).then(function (state) {
    if (config.debug) logQueryJourney(state);
    var r = state.result;
    var targets = r.targets.map(function (id) { return state.tree.byId.get(id); });
    var text = r.action === 'abstain'
      ? ACTION_LABELS.abstain
      : ACTION_LABELS[r.match === 'maybe' ? 'maybe' : r.action] + ': ' + targets.map(function (n) { return clean(nodeLabel(n), 60) + ' (' + n.id + ')'; }).join(', ') + '.';
    var detail = [];
    if (r.action !== 'abstain') detail = handoffLines(state.handoff).concat(['']);
    detail.push('Explorer (' + config.navigator + ', ' + state.ms + ' ms):');
    detail = detail.concat(stepLines(state));
    if (r.note) detail.push('Note: ' + r.note);
    return { text: text + ' (Preview: no answer text or highlighting yet.)', detail: detail.join('\n') };
  });
}
