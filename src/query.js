// Query handler: explorer -> hand-off -> answer step -> highlights on the page.
// With data-debug, the chat message also shows the hand-off, the explorer's steps
// and the answer step's attempts.

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
    lines.push('Other page text (read = the explorer read it, search = a top search hit):');
    h.context.forEach(function (s) {
      lines.push('[' + s.id + '] (' + s.via + ') ' + (s.path || '(top level)'), indentText(s.text));
    });
  }
  return lines;
}

function indentText(text) {
  return text.split('\n').map(function (line) { return '    ' + line; }).join('\n');
}

// Answers a query. Returns a Promise of { text, links, detail? } for the chat widget,
// after highlighting the cited elements on the page. links = [{ n, label }].
function answerQuery(query) {
  clearHighlights();
  return explore(query).then(function (state) {
    return answerStep(state).then(function (answer) {
      state.answer = answer;
      if (config.debug) logQueryJourney(state);
      showHighlights(answer.highlights);
      var out = { text: answer.reply, links: answer.highlights.map(function (h) { return { n: h.n, label: h.label }; }) };
      if (config.debug) out.detail = debugDetail(state);
      return out;
    });
  });
}

function debugDetail(state) {
  var a = state.answer;
  var lines = ['Answer step: ' + a.status + (a.attempts.length ? ', ' + a.attempts.length + ' attempt(s), ' + a.ms + ' ms' : '')];
  a.attempts.forEach(function (at, i) {
    lines.push('  ' + (i + 1) + '. ' + at.model + ': ' + JSON.stringify(at.output.citations || []));
    at.problems.forEach(function (p) { lines.push('     ✗ ' + p); });
  });
  a.highlights.forEach(function (h) { lines.push('  highlight ' + h.n + ': ' + h.id + ' "' + h.label + '"'); });
  lines.push('');
  if (state.result.action !== 'abstain') lines = lines.concat(handoffLines(state.handoff), ['']);
  lines.push('Explorer (' + config.navigator + ', ' + state.ms + ' ms): ' + state.result.action +
    (state.result.match ? ' ' + state.result.match : ''));
  lines = lines.concat(stepLines(state));
  if (state.result.note) lines.push('Note: ' + state.result.note);
  return lines.join('\n');
}
