// Query handler: explorer -> hand-off -> answer step -> highlights on the page.



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

// Answers a query. Returns a Promise of { text, links } for the chat widget, after
// highlighting the cited elements on the page. links = [{ n, label }].
// onProgress (optional) gets short status lines while it works. With data-debug,
// the whole journey is printed to the browser console (trace.js); the chat shows
// only the reply.
function answerQuery(query, onProgress) {
  clearHighlights();
  return explore(query, onProgress).then(function (state) {
    return answerStep(state).then(function (answer) {
      state.answer = answer;
      if (config.debug) logQueryJourney(state);
      showHighlights(answer.highlights);
      return { text: answer.reply, links: answer.highlights.map(function (h) { return { n: h.n, label: h.label }; }) };
    });
  });
}
