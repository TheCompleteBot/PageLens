#!/usr/bin/env node
// Explorer test runner. Opens each site in headless Chrome, runs every case
// through PageLens.explore() several times, and reports pass rates and metrics.
// The model doesn't answer the same way every time, so one run per query isn't
// a reliable score.
//
// Two sets:
//   tests/cases.json    dev set: tune prompts and code against this one
//   tests/testset.json  test set: held out, only for measuring (--set test)
//   tests/freshset.json fresh sites never used for development (--set fresh)
//
//   node tests/run.mjs                    dev set, every case, 3 runs each
//   node tests/run.mjs --set test         the test set
//   node tests/run.mjs --runs 5           more runs per case
//   node tests/run.mjs --site dashboard   one site only
//   node tests/run.mjs --only "profit"    cases whose question (or id) contains this text
//   node tests/run.mjs --ids dev-10,dev-20   only these case ids
//   node tests/run.mjs --gap 10           seconds between one worker's queries (rate limits)
//   node tests/run.mjs --parallel 2       workers (default: one per API key)
//   node tests/run.mjs --keys GEMINI_API_KEY_3   only these .env keys (comma-separated names; any
//                                         variable name, e.g. --keys key1,key2)
//   node tests/run.mjs --answer           run the whole pipeline: retrieval, explorer, answer step
//                                         (one more LLM call per query), and score all three
//   node tests/run.mjs --set test --check checks the set itself, without the LLM: lists
//                                         the page nodes each evidence item matches
//
// API keys: every GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3... in .env.
// Each worker is its own headless Chrome with its own key: the runner swaps the
// key into the page's Gemini requests (DevTools Fetch interception), so the
// library and the page never see it. Only the last 4 characters are printed.
// Keys only add throughput if they belong to different quota (rate limits are per
// Google Cloud project, not per key).
//
// Needs: a development build (node build.js), the sites running (see README),
// Node 22+ and Google Chrome (or set CHROME=/path/to/chrome).
// Every run saves:
//   tests/reports/<time>-<set>.md    the readable report (committed: the history of scores)
//   tests/results/<time>-<set>.json  every run's details (git-ignored: large)
//   node tests/run.mjs --report tests/results/<file>.json   rebuilds the report of a saved run
//   node tests/run.mjs --retry-errors tests/results/<file>.json
//                             reruns only the runs that failed with an error (e.g. a 429)
//                             and saves a new report with them merged in

import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const RENDER_WAIT_MS = 3000; // framework apps render after the load event

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
}
const RUNS = Number(arg('runs', 3));
const GAP_S = Number(arg('gap', 10));
const SITE = arg('site', '');
const ONLY = arg('only', '').toLowerCase();
const IDS = arg('ids', '').split(',').filter(Boolean);
const SET = arg('set', 'dev');
const CHECK = process.argv.includes('--check');
const REPORT_FROM = arg('report', '');
const RETRY_FROM = arg('retry-errors', '');
const WITH_ANSWER = process.argv.includes('--answer');

// API keys from .env (values never printed): GEMINI_API_KEY, GEMINI_API_KEY_2, ...
// by default, or exactly the variables named with --keys.
const KEY_NAMES = arg('keys', '').split(',').filter(Boolean);
function readKeys() {
  let env = '';
  try { env = readFileSync(join(HERE, '..', '.env'), 'utf8'); } catch { return []; }
  const found = [...env.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']?([^"'\s#]+)/gm)]
    .map((m) => ({ name: m[1], value: m[2] }))
    .filter((k) => (KEY_NAMES.length ? KEY_NAMES.includes(k.name) : /^GEMINI_API_KEY(_\d+)?$/.test(k.name)));
  return found.filter((k, i) => found.findIndex((o) => o.value === k.value) === i); // drop duplicates
}
const KEYS = readKeys();
if (KEY_NAMES.length && KEYS.length < KEY_NAMES.length) {
  console.error('Not found in .env: ' + KEY_NAMES.filter((n) => !KEYS.some((k) => k.name === n)).join(', '));
  process.exit(1);
}
const PARALLEL = Math.max(1, Number(arg('parallel', KEYS.length || 1)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ');

// ---- A minimal Chrome DevTools Protocol client ----

// key (optional): sent instead of whatever key the page uses, on every Gemini request.
async function openChrome(key) {
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), 'pagelens-test-'));
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 50 && !targets; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { await sleep(200); }
  }
  if (!targets) throw new Error('Could not start Chrome at ' + CHROME + ' (set CHROME=...).');
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else listeners.forEach((fn) => fn(msg));
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  await send('Page.enable');
  let rekeyed = 0;
  if (key) {
    listeners.push((msg) => {
      if (msg.method !== 'Fetch.requestPaused') return;
      if ('x-goog-api-key' in msg.params.request.headers) rekeyed++;
      const headers = Object.entries(msg.params.request.headers)
        .map(([name, value]) => ({ name, value: name.toLowerCase() === 'x-goog-api-key' ? key : value }));
      send('Fetch.continueRequest', { requestId: msg.params.requestId, headers });
    });
    await send('Fetch.enable', { patterns: [{ urlPattern: 'https://generativelanguage.googleapis.com/*', requestStage: 'Request' }] });
  }
  return {
    rekeyed: () => rekeyed,
    send,
    on: (fn) => listeners.push(fn),
    async load(site) {
      const loaded = new Promise((r) => listeners.push((msg) => { if (msg.method === 'Page.loadEventFired') r(); }));
      await send('Page.navigate', { url: site.url });
      await loaded;
      await sleep(RENDER_WAIT_MS);
      if (site.scroll) {
        await send('Runtime.evaluate', { awaitPromise: true, expression: `(async () => {
          var h = document.documentElement.scrollHeight;
          for (var y = 0; y < h; y += 300) { window.scrollTo(0, y); await new Promise(function (r) { setTimeout(r, 250); }); }
          window.scrollTo(0, 0); await new Promise(function (r) { setTimeout(r, 1500); });
        })()` });
      }
    },
    async evaluate(expression) {
      const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (res.result.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description || 'evaluation failed');
      return res.result.result.value;
    },
    close() { ws.close(); proc.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {} }
  };
}

// ---- One explorer run, inside the page ----

// In-page helpers. A node's text is built from the page tree (what the explorer
// sees), not the element's innerText: a group's element can wrap more than the
// group (e.g. a wrapper holding both a product list and the nav). Context is the
// text of the record around a node, so "+$39.00" can be told apart by whose it is.
const PAGE_HELPERS = `
  function treeText(node) {
    var d = node.data || {};
    return [node.title, d.text, d.label].concat(node.children.map(treeText))
      .filter(function (x) { return x; }).join(' ');
  }
  function context(node) {
    for (var n = node.parent; n; n = n.parent) if (n.kind === 'record') return treeText(n);
    return '';
  }
  function describeNode(node) {
    return { id: node.id, parent: node.parent ? node.parent.id : null, tag: node.el.tagName.toLowerCase(),
      text: treeText(node), context: context(node) };
  }`;

// One query in the page. Records all three stages:
//   retrieval  the automatic first search's ranked hits
//   explorer   action, targets, hand-off context, cost
//   answer     (with --answer) reply, status, highlights, attempts
const EXPLORE = (q) => `(${WITH_ANSWER} ? PageLens.answer(${JSON.stringify(q)}).then(function (res) { return res.state; })
    : PageLens.explore(${JSON.stringify(q)})).then(function (s) {
  ${PAGE_HELPERS}
  var tokens = 0;
  s.steps.forEach(function (st) { tokens += (st.tokens && st.tokens.totalTokenCount) || 0; });
  var out = {
    action: s.result.action, match: s.result.match || '', note: s.result.note || '',
    targets: s.result.targets.map(function (id) { return describeNode(s.tree.byId.get(id)); }),
    // The rest of the hand-off to the answer step: other nodes the explorer read.
    context: s.handoff.context.map(function (c) { return describeNode(s.tree.byId.get(c.id)); }),
    retrieval: { mode: s.start.search.retrieval, hits: (s.start.search.results || []).map(function (h) {
      var d = describeNode(s.tree.byId.get(h.id)); d.via = h.via; return d; }) },
    toolCalls: s.toolCalls, turns: s.steps.length, tokens: tokens, ms: s.ms,
    // True if any search in this run fell back to keywords only (no key, rate limit,
    // API error): such runs explore with half of search missing.
    keywordOnly: s.start.search.retrieval !== 'hybrid' ||
      s.searchJourneys.some(function (j) { return !j.dense || j.dense.status !== 'used'; }),
    handoffChars: s.handoff.sources.concat(s.handoff.context).reduce(function (n, x) { return n + x.text.length; }, 0),
    models: Array.from(new Set(s.steps.map(function (st) { return st.model; }))),
    calls: [].concat.apply([], s.steps.map(function (st) { return st.calls.map(function (c) {
      return c.name + JSON.stringify(c.args || {}) + (c.error ? ' ✗ ' + c.error : ''); }); }))
  };
  if (s.answer) {
    var a = s.answer;
    var aTokens = 0;
    a.attempts.forEach(function (at) { aTokens += (at.tokens && at.tokens.totalTokenCount) || 0; });
    out.answer = { status: a.status, reply: a.reply, attempts: a.attempts.length, ms: a.ms, tokens: aTokens,
      firstPass: !!a.attempts.length && !a.attempts[0].problems.length,
      problems: [].concat.apply([], a.attempts.map(function (at) { return at.problems; })),
      highlights: a.highlights.map(function (h) { return describeNode(s.tree.byId.get(h.id)); }) };
  }
  return out;
})`;

// ---- Cases: both files in one shape ----
// { id, site, type, question, outcomes: [{ action, match?, evidence: [{ match, context?, tag?, exact? }] }] }

function loadSet(name) {
  const file = { test: 'testset.json', fresh: 'freshset.json' }[name] || 'cases.json';
  const data = JSON.parse(readFileSync(join(HERE, file), 'utf8'));
  // A site is a URL, or { url, scroll }: scroll = scroll through the page once after
  // loading, for pages whose content fades in on scroll (invisible until then).
  Object.keys(data.sites).forEach((k) => { if (typeof data.sites[k] === 'string') data.sites[k] = { url: data.sites[k] }; });
  const cases = data.cases.map((c, i) => c.question
    ? { id: c.id, site: c.site, type: c.type, question: c.question, note: c.note,
        outcomes: [c.expected].concat(c.alternatives || []) }
    : { id: 'dev-' + String(i + 1).padStart(2, '0'), site: c.site, type: 'dev', question: c.q, note: c.note,
        outcomes: c.expect.map((e) => ({ action: e.action, match: e.match, evidence: (e.has || []).map((m) => ({ match: m })) })) });
  return { file, sites: data.sites, cases };
}

// ---- Scoring ----

function covers(target, ev) {
  const text = norm(target.text).trim();
  if (ev.tag && target.tag !== ev.tag) return false;
  if (ev.exact ? text !== norm(ev.match).trim() : !text.includes(norm(ev.match))) return false;
  return !ev.context || text.includes(norm(ev.context)) || norm(target.context).includes(norm(ev.context));
}

// Scores one run against a case: the best of the acceptable outcomes.
//   recall / precision: the targets (what gets highlighted and cited)
//   contextRecall: the whole hand-off to the answer step (targets + other read text)
function score(r, c) {
  const none = { actionOk: false, recall: 0, precision: 0, contextRecall: 0, success: false, answerable: false };
  if (r.error) return none;
  let best = null;
  for (const o of c.outcomes) {
    if (r.action !== o.action || (o.action === 'highlight' && o.match && r.match !== o.match)) continue;
    const ev = o.evidence || [];
    const handoff = r.targets.concat(r.context || []);
    const share = (nodes) => (ev.length ? ev.filter((e) => nodes.some((t) => covers(t, e))).length / ev.length : 1);
    const recall = share(r.targets);
    const contextRecall = share(handoff);
    const precision = r.targets.length && ev.length ? r.targets.filter((t) => ev.some((e) => covers(t, e))).length / r.targets.length : 1;
    const s = { actionOk: true, recall, precision, contextRecall, success: recall === 1, answerable: contextRecall === 1 };
    if (!best || s.recall > best.recall || (s.recall === best.recall && s.contextRecall > best.contextRecall) ||
      (s.recall === best.recall && s.contextRecall === best.contextRecall && s.precision > best.precision)) best = s;
  }
  return best || none;
}

// ---- Stage 1: retrieval (the automatic first search, before any LLM call) ----
// Evidence recall in the top k hits, and the reciprocal rank of the first hit that
// covers any evidence. Only for cases with evidence (not abstain-only cases).
function retrievalScore(r, c) {
  if (r.error || !r.retrieval) return null;
  const withEvidence = c.outcomes.filter((o) => o.action !== 'abstain' && (o.evidence || []).length);
  if (!withEvidence.length) return null;
  let best = null;
  for (const o of withEvidence) {
    const at = (k) => o.evidence.filter((e) => r.retrieval.hits.slice(0, k).some((h) => covers(h, e))).length / o.evidence.length;
    const first = r.retrieval.hits.findIndex((h) => o.evidence.some((e) => covers(h, e)));
    const sc = { r1: at(1), r3: at(3), r8: at(8), rr: first === -1 ? 0 : 1 / (first + 1), hybrid: r.retrieval.mode === 'hybrid' };
    if (!best || sc.r8 > best.r8 || (sc.r8 === best.r8 && sc.rr > best.rr)) best = sc;
  }
  return best;
}

// ---- Stage 3: answer step ----

const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;
const numbersOf = (t) => (String(t || '').match(NUMBER_RE) || []).map((n) => parseFloat(n.replace(/,/g, ''))).filter((n) => !isNaN(n));
const normText = (t) => String(t || '').normalize('NFKC').toLowerCase().replace(/[–—−]/g, '-').replace(/[“”‘’"'`|·•:;,()]/g, ' ').replace(/\s+/g, ' ').trim();

// The facts a correct reply must state, for `answer` outcomes. For compute questions,
// the values in the reference answer (the result: "₹3,098", "+180.1%"); otherwise
// the evidence: its numbers if it has any ("+201 since last hour" -> 201), else its
// words ("Electronics").
function answerFacts(c, o) {
  if (o.action !== 'answer') return [];
  if (c.type === 'compute' && o.answer) {
    const values = o.answer.match(/[₹$]\s?\d[\d,]*(?:\.\d+)?|[+-]?\d[\d,]*(?:\.\d+)?%|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+/g) || [];
    const nums = [...new Set(values.flatMap(numbersOf))];
    if (nums.length) return nums.map((n) => ({ number: n }));
  }
  return (o.evidence || []).flatMap((e) => (/\d/.test(e.match) ? numbersOf(e.match).map((n) => ({ number: n })) : [{ text: e.match }]));
}

function factIn(reply, f) {
  return f.number !== undefined ? numbersOf(reply).some((n) => Math.abs(n - f.number) < 0.005) : normText(reply).includes(normText(f.text));
}

const isFinalAbstain = (a) => a && (a.status === 'abstain' || a.status === 'unconfirmed');

// End-to-end: is what the visitor sees right? gold abstain -> the reply abstains;
// answer -> reply ok, states every fact, highlights some evidence; highlight -> reply
// ok and the highlights cover the evidence.
function answerScore(r, c) {
  if (r.error || !r.answer) return null;
  const a = r.answer;
  let best = { correct: false, factRecall: NaN, hlRecall: NaN, hlPrecision: NaN };
  for (const o of c.outcomes) {
    if (o.action === 'abstain') {
      if (isFinalAbstain(a)) return { correct: true, factRecall: NaN, hlRecall: NaN, hlPrecision: NaN };
      continue;
    }
    const ev = o.evidence || [];
    const hl = a.highlights;
    const hlRecall = ev.length ? ev.filter((e) => hl.some((h) => covers(h, e))).length / ev.length : NaN;
    const hlPrecision = hl.length && ev.length ? hl.filter((h) => ev.some((e) => covers(h, e))).length / hl.length : NaN;
    const facts = answerFacts(c, o);
    const factRecall = facts.length ? facts.filter((f) => factIn(a.reply, f)).length / facts.length : NaN;
    const correct = a.status === 'ok' && (o.action === 'answer'
      ? (Number.isNaN(factRecall) || factRecall === 1) && (Number.isNaN(hlRecall) || hlRecall > 0)
      : (Number.isNaN(hlRecall) || hlRecall === 1));
    const sc = { correct, factRecall, hlRecall, hlPrecision };
    const rank = (x) => (x.correct ? 2 : 0) + (Number.isNaN(x.factRecall) ? 0 : x.factRecall) + (Number.isNaN(x.hlRecall) ? 0 : x.hlRecall);
    if (rank(sc) > rank(best)) best = sc;
  }
  return best;
}

// ---- Abstain as binary classification (positive = abstain) ----
// Gold: abstain if every acceptable outcome abstains, answer/highlight if none does;
// cases where both are acceptable are left out. Cohen's kappa corrects the agreement
// between predicted and gold for the agreement expected by chance.
function abstainStats(rows, predicted) {
  let tp = 0, fn = 0, tn = 0, fp = 0, skipped = 0;
  rows.forEach((x) => {
    const all = x.c.outcomes.every((o) => o.action === 'abstain');
    const none = x.c.outcomes.every((o) => o.action !== 'abstain');
    if (!all && !none) { skipped++; return; }
    const p = predicted(x);
    if (all) { if (p) tp++; else fn++; } else { if (p) fp++; else tn++; }
  });
  const n = tp + fn + tn + fp;
  const po = n ? (tp + tn) / n : NaN;
  const pe = n ? ((tp + fp) * (tp + fn) + (fn + tn) * (fp + tn)) / (n * n) : NaN;
  return { tp, fn, tn, fp, skipped, n,
    tpr: tp + fn ? tp / (tp + fn) : NaN, tnr: tn + fp ? tn / (tn + fp) : NaN,
    precision: tp + fp ? tp / (tp + fp) : NaN, accuracy: po,
    kappa: n && pe < 1 ? (po - pe) / (1 - pe) : NaN };
}

function describe(r) {
  if (r.error) return 'ERROR ' + r.error.split('\n')[0].slice(0, 100);
  const targets = r.targets.map((t) => t.id + ' "' + norm(t.text).trim().slice(0, 40) + '"').join(', ');
  return r.action + (r.action === 'highlight' ? ' ' + r.match : '') + (targets ? ' → ' + targets : '');
}

const pct = (x) => (100 * x).toFixed(0) + '%';
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

// Share of questions whose runs all have score[key].
function allRuns(rows, key) {
  const byCase = new Map();
  rows.forEach((x) => byCase.set(x.c.id, (byCase.get(x.c.id) || []).concat([x.s[key]])));
  return byCase.size ? [...byCase.values()].filter((v) => v.every(Boolean)).length / byCase.size : NaN;
}

// Metrics over a list of { c, r, s } (case, run result, score).
// Rates are over completed runs only: a run that failed with an error (e.g. a 429)
// says nothing about the explorer, so it's counted separately in `errors`.
function metrics(all) {
  const rows = all.filter((x) => !x.r.error);
  const ok = rows.filter((x) => x.s.actionOk);
  const abstained = rows.filter((x) => x.r.action === 'abstain');
  const abstainOk = (c) => c.outcomes.some((o) => o.action === 'abstain');
  const mustAbstain = rows.filter((x) => x.c.outcomes.every((o) => o.action === 'abstain'));
  return {
    runs: rows.length,
    success: mean(rows.map((x) => (x.s.success ? 1 : 0))),
    answerable: mean(rows.map((x) => (x.s.answerable ? 1 : 0))),
    action_accuracy: mean(rows.map((x) => (x.s.actionOk ? 1 : 0))),
    evidence_recall: mean(ok.map((x) => x.s.recall)),
    target_precision: mean(ok.map((x) => x.s.precision)),
    context_recall: mean(ok.map((x) => x.s.contextRecall)),
    abstain_precision: abstained.length ? mean(abstained.map((x) => (abstainOk(x.c) ? 1 : 0))) : NaN,
    abstain_recall: mustAbstain.length ? mean(mustAbstain.map((x) => (x.r.action === 'abstain' ? 1 : 0))) : NaN,
    // Per question: did every run pass? (Users see single runs; one flaky run is a real failure.)
    all_runs_answerable: allRuns(rows, 'answerable'),
    all_runs_success: allRuns(rows, 'success'),
    handoff_chars: mean(rows.filter((x) => !x.r.error).map((x) => x.r.handoffChars || 0)),
    tool_calls: mean(rows.map((x) => x.r.toolCalls || 0)),
    turns: mean(rows.map((x) => x.r.turns || 0)),
    tokens: mean(rows.map((x) => x.r.tokens || 0)),
    seconds: mean(rows.map((x) => (x.r.ms || 0) / 1000)),
    errors: all.length - rows.length,
    keyword_only: rows.filter((x) => x.r.keywordOnly).length
  };
}

const METRICS_HEADER = '             runs  err   kw  answ  all3  succ  acti  reca  prec  ctxr  ab-p  ab-r  calls  tokens  secs  chars';
function metricsLine(label, m) {
  const f = (x) => (Number.isNaN(x) ? '  - ' : pct(x).padStart(4));
  const n = (x) => (Number.isNaN(x) ? '-' : String(x));
  return `${label.padEnd(12)} ${String(m.runs).padStart(4)} ${n(m.errors).padStart(4)} ${n(m.keyword_only).padStart(4)}  ${f(m.answerable)}  ${f(m.all_runs_answerable)}  ${f(m.success)}  ` +
    `${f(m.action_accuracy)}  ${f(m.evidence_recall)}  ${f(m.target_precision)}  ${f(m.context_recall)}  ${f(m.abstain_precision)}  ${f(m.abstain_recall)}  ${m.tool_calls.toFixed(1).padStart(5)}  ` +
    `${Math.round(m.tokens).toString().padStart(6)}  ${m.seconds.toFixed(1).padStart(5)}  ` +
    `${Number.isNaN(m.handoff_chars) ? '    -' : Math.round(m.handoff_chars).toString().padStart(5)}`;
}

// Stage 1 and 3 metrics over completed runs.
function retrievalMetrics(all) {
  const rows = all.filter((x) => !x.r.error && x.r.rscore);
  return { runs: rows.length,
    r1: mean(rows.map((x) => x.r.rscore.r1)), r3: mean(rows.map((x) => x.r.rscore.r3)),
    r8: mean(rows.map((x) => x.r.rscore.r8)), mrr: mean(rows.map((x) => x.r.rscore.rr)),
    hybrid: mean(rows.map((x) => (x.r.rscore.hybrid ? 1 : 0))) };
}

function answerMetrics(all) {
  const rows = all.filter((x) => !x.r.error && x.r.answer);
  const st = (k) => mean(rows.map((x) => (x.r.answer.status === k ? 1 : 0)));
  const called = rows.filter((x) => x.r.answer.attempts);
  const facts = rows.filter((x) => x.r.ascore && !Number.isNaN(x.r.ascore.factRecall));
  const hls = rows.filter((x) => x.r.ascore && !Number.isNaN(x.r.ascore.hlRecall));
  const hlp = rows.filter((x) => x.r.ascore && !Number.isNaN(x.r.ascore.hlPrecision));
  const byCase = new Map();
  rows.forEach((x) => byCase.set(x.c.id, (byCase.get(x.c.id) || []).concat([!!(x.r.ascore && x.r.ascore.correct)])));
  return { runs: rows.length,
    correct: mean(rows.map((x) => (x.r.ascore && x.r.ascore.correct ? 1 : 0))),
    allRuns: byCase.size ? [...byCase.values()].filter((v) => v.every(Boolean)).length / byCase.size : NaN,
    ok: st('ok'), unconfirmed: st('unconfirmed'), abstain: st('abstain'),
    firstPass: mean(called.map((x) => (x.r.answer.firstPass ? 1 : 0))),
    factRecall: mean(facts.map((x) => x.r.ascore.factRecall)),
    allFacts: mean(facts.map((x) => (x.r.ascore.factRecall === 1 ? 1 : 0))),
    hlRecall: mean(hls.map((x) => x.r.ascore.hlRecall)), hlPrecision: mean(hlp.map((x) => x.r.ascore.hlPrecision)),
    ms: mean(rows.map((x) => (x.r.ms || 0) + (x.r.answer.ms || 0))),
    tokens: mean(rows.map((x) => (x.r.tokens || 0) + (x.r.answer.tokens || 0))) };
}

const fp = (x) => (Number.isNaN(x) ? '  - ' : pct(x).padStart(4));
const f2 = (x) => (Number.isNaN(x) ? '   -' : x.toFixed(2).padStart(4));

function stageTables(rows, selected) {
  const lines = [];
  const groups = [['overall', rows]]
    .concat([...new Set(selected.map((c) => c.site))].map((site) => [site, rows.filter((x) => x.c.site === site)]))
    .concat([['', null]])
    .concat([...new Set(selected.map((c) => c.type))].map((t) => [t, rows.filter((x) => x.c.type === t)]));
  const table = (header, fn) => {
    lines.push(header);
    groups.forEach(([label, g]) => { if (!g) lines.push(''); else { const l = fn(label, g); if (l) lines.push(l); } });
    lines.push('');
  };

  lines.push('## Stage 1: retrieval (automatic first search, top 8 shown to the explorer)', '');
  table('             runs  rec@1  rec@3  rec@8   MRR  hybrid', (label, g) => {
    const m = retrievalMetrics(g);
    return m.runs ? `${label.padEnd(12)} ${String(m.runs).padStart(4)}   ${fp(m.r1)}   ${fp(m.r3)}   ${fp(m.r8)}  ${f2(m.mrr)}   ${fp(m.hybrid)}` : null;
  });

  lines.push('## Stage 2: explorer', '');
  table(METRICS_HEADER, (label, g) => metricsLine(label, metrics(g)));

  if (rows.some((x) => x.r.answer)) {
    lines.push('## Stage 3: answer step (end to end: what the visitor sees)', '');
    table('             runs  corr  all3    ok  unco  abst  1st✓  fact  allf  hl-r  hl-p   secs  tokens', (label, g) => {
      const m = answerMetrics(g);
      return m.runs ? `${label.padEnd(12)} ${String(m.runs).padStart(4)}  ${fp(m.correct)}  ${fp(m.allRuns)}  ${fp(m.ok)}  ` +
        `${fp(m.unconfirmed)}  ${fp(m.abstain)}  ${fp(m.firstPass)}  ${fp(m.factRecall)}  ${fp(m.allFacts)}  ${fp(m.hlRecall)}  ` +
        `${fp(m.hlPrecision)}  ${(m.ms / 1000).toFixed(1).padStart(5)}  ${Math.round(m.tokens).toString().padStart(6)}` : null;
    });
  }

  lines.push('## Abstain (positive = abstain)', '');
  const done = rows.filter((x) => !x.r.error);
  const show = (name, st) => {
    lines.push(`${name}: TPR ${fp(st.tpr)}  TNR ${fp(st.tnr)}  precision ${fp(st.precision)}  accuracy ${fp(st.accuracy)}  ` +
      `Cohen's kappa ${f2(st.kappa)}   (TP ${st.tp}, FN ${st.fn}, TN ${st.tn}, FP ${st.fp}; ${st.skipped} run(s) of cases where both are acceptable left out)`);
  };
  show('Explorer decision', abstainStats(done, (x) => x.r.action === 'abstain'));
  if (done.some((x) => x.r.answer)) show('Final reply      ', abstainStats(done.filter((x) => x.r.answer), (x) => isFinalAbstain(x.r.answer)));
  lines.push('');
  return lines;
}

// ---- Report ----

function gitCommit() {
  try {
    const head = execSync('git rev-parse --short HEAD', { cwd: HERE }).toString().trim();
    const dirty = execSync('git status --porcelain', { cwd: HERE }).toString().trim() ? ' + uncommitted changes' : '';
    return head + dirty;
  } catch { return 'unknown'; }
}

// The report as lines of text: per-case results, then metrics overall / per site / per type.
function reportLines(selected, results) {
  const lines = [];
  for (const site of [...new Set(selected.map((c) => c.site))]) {
    lines.push(`== ${site}`);
    selected.forEach((c, ci) => {
      if (c.site !== site) return;
      const runs = results[ci];
      const ok = runs.filter((r) => r.score.answerable).length;
      const mark = ok === runs.length ? '✓' : ok ? '~' : '✗';
      const hl = runs.filter((r) => r.score.success).length;
      lines.push(`${mark} ${ok}/${runs.length} answerable, ${hl}/${runs.length} targets  ${c.id.padEnd(9)} ${c.question}`);
      runs.forEach((r) => {
        if (!r.score.success) lines.push('      ' + (r.score.answerable ? '~ ' : '✗ ') + describe(r));
        if (r.answer && r.ascore && !r.ascore.correct) {
          lines.push('      ✗ reply [' + r.answer.status + ']: ' + r.answer.reply.replace(/\s+/g, ' ').slice(0, 160));
        }
      });
    });
    lines.push('');
  }
  const rows = [];
  selected.forEach((c, ci) => results[ci].forEach((r) => rows.push({ c, r, s: r.score })));
  const summary = { overall: metrics(rows), bySite: {}, byType: {},
    retrieval: retrievalMetrics(rows), answer: answerMetrics(rows),
    abstain: { explorer: abstainStats(rows.filter((x) => !x.r.error), (x) => x.r.action === 'abstain'),
      final: abstainStats(rows.filter((x) => !x.r.error && x.r.answer), (x) => isFinalAbstain(x.r.answer)) } };
  for (const site of [...new Set(selected.map((c) => c.site))]) summary.bySite[site] = metrics(rows.filter((x) => x.c.site === site));
  for (const type of [...new Set(selected.map((c) => c.type))]) summary.byType[type] = metrics(rows.filter((x) => x.c.type === type));
  lines.push(...stageTables(rows, selected));
  lines.push('',
    'Retrieval: rec@k = share of the needed evidence in the first k hits of the automatic search; MRR = mean of',
    '1/rank of the first hit holding any evidence (1 = always first); hybrid = keyword + meaning (not keyword-only).',
    'Answer: corr = end-to-end correct (abstain cases: the reply abstains; answer: reply ok, states every key fact,',
    'highlights evidence; highlight: reply ok, highlights cover the evidence). all3 = questions correct in every run.',
    'ok / unco / abst = reply status: answered, checks failed twice ("couldn\'t confirm"), abstained. 1st✓ = passed',
    'the checks on the first try. fact = share of key facts of the reference answer stated in the reply; allf = all',
    'of them. hl-r / hl-p = highlight recall / precision against the evidence. secs, tokens: explorer + answer.',
    'Abstain: TPR = abstained when it should, TNR = answered when it should, kappa = agreement beyond chance',
    '(1 perfect, 0 chance). Final reply counts "couldn\'t confirm" as abstaining.',
    'Explorer columns:',
    'runs = completed runs (all rates are over these). err = runs that failed with an error (not counted).',
    'kw = completed runs where search fell back to keywords only (embeddings unavailable).',
    'answ = answerable: right action, and the hand-off (targets + other text given to the answer step) covers all evidence.',
    'all3 = share of questions answerable in every run. succ = right action and the targets alone cover all evidence.',
    'acti = action accuracy. reca / prec = target recall / precision. ctxr = context recall (hand-off).',
    'ab-p / ab-r = abstain precision / recall. Per query: tool calls, tokens, seconds, hand-off characters.',
    '✓ every run answerable, ~ some, ✗ none. In the per-run lines, ~ = answerable but the targets missed evidence.');
  if (summary.overall.errors) {
    lines.push(`${summary.overall.errors} run(s) failed with an error and are left out of the rates; rerun them with --retry-errors.`);
  }
  return { lines, summary };
}

// Prints the report and saves it: Markdown to tests/reports/ (committed), JSON to tests/results/.
function saveRun(run) {
  const { lines, summary } = reportLines(run.selected, run.results);
  console.log('\n' + lines.join('\n'));
  mkdirSync(join(HERE, 'results'), { recursive: true });
  mkdirSync(join(HERE, 'reports'), { recursive: true });
  const json = run.jsonFile || join(HERE, 'results', run.stamp + '-' + run.set + '.json');
  if (!run.jsonFile) {
    writeFileSync(json, JSON.stringify({ set: run.setFile, runs: run.runs, started: run.started, commit: run.commit,
      keys: run.keys, summary, cases: run.selected.map(({ saved, ...c }, ci) => ({ ...c, runs: run.results[ci] })) }, null, 2));
  }
  const md = join(HERE, 'reports', run.stamp + '-' + run.set + '.md');
  writeFileSync(md, [
    `# PageLens evaluation: ${run.setFile}${run.withAnswer ? ' (retrieval, explorer, answer)' : ' (retrieval, explorer)'}`,
    '',
    `- When: ${run.started}`,
    `- Code: ${run.commit}`,
    `- Cases: ${run.selected.length}, runs per case: ${run.runs}`,
    run.keys && run.keys.length ? `- Keys: ${run.keys.join(', ')}` : null,
    `- Details: ${json.replace(HERE + '/', 'tests/')}`,
    run.note ? `- Note: ${run.note}` : null,
    '',
    '```',
    ...lines,
    '```',
    ''
  ].filter((l) => l !== null).join('\n'));
  if (run.keys && run.keys.length) console.log('Keys used: ' + run.keys.join(', '));
  console.log('Report:  ' + md + '\nDetails: ' + json);
}

// --report: rebuild the report of a saved run, re-scored with the current scoring.
if (REPORT_FROM) {
  const data = JSON.parse(readFileSync(REPORT_FROM, 'utf8'));
  const setName = /testset/.test(data.set || '') ? 'test' : /freshset/.test(data.set || '') ? 'fresh' : 'dev';
  const fresh = loadSet(setName).cases;
  // Old files stored the dev-set format; match cases by question to today's definitions.
  const selected = data.cases.map((c) => fresh.find((f) => f.question === (c.question || c.q)))
    .filter(Boolean);
  const results = selected.map((c) => {
    const saved = data.cases.find((x) => (x.question || x.q) === c.question);
    return saved.runs.map((r) => { const x = { context: [], ...r }; return { ...r, score: score(x, c), rscore: retrievalScore(x, c), ascore: answerScore(x, c) }; });
  });
  const stamp = (REPORT_FROM.match(/(\d{4}-\d\d-\d\dT[\d-]+Z)/) || [])[1] || new Date().toISOString().replace(/[:.]/g, '-');
  saveRun({ set: setName, setFile: data.set || loadSet(setName).file, runs: data.runs, selected, results, keys: data.keys,
    stamp, commit: data.commit || 'unknown (saved before reports existed)', started: data.started || stamp,
    jsonFile: REPORT_FROM, note: 'rebuilt from the saved results with the current scoring' +
      (data.cases.some((c) => c.runs.some((r) => !r.error && !('context' in r)))
        ? '; saved before the hand-off existed, so "answerable" counts the targets only (no context)' : '') +
      (data.cases.length > selected.length ? `; ${data.cases.length - selected.length} case(s) no longer in the set` : '') });
  process.exit(0);
}

// ---- Main ----

const { file: setFile, sites, cases } = loadSet(SET);
const selected = cases.filter((c) => (!SITE || c.site === SITE) && (!IDS.length || IDS.includes(c.id)) &&
  (!ONLY || c.question.toLowerCase().includes(ONLY) || c.id.toLowerCase().includes(ONLY)));
if (!selected.length) { console.error('No cases match.'); process.exit(1); }

// --check: every node of the page tree, scored against each case's evidence. No LLM calls.
const ALL_NODES = `(function () {
  ${PAGE_HELPERS}
  console.log = function () {}; // PageLens.debug() logs the whole tree
  var out = [];
  PageLens.debug().byId.forEach(function (node) { out.push(describeNode(node)); });
  return out;
})()`;
if (CHECK) {
  const chrome = await openChrome(null);
  let problems = 0;
  try {
    for (const site of [...new Set(selected.map((c) => c.site))]) {
      await chrome.load(sites[site]);
      const nodes = await chrome.evaluate(ALL_NODES);
      console.log(`== ${site}: ${nodes.length} nodes`);
      for (const c of selected.filter((x) => x.site === site)) {
        c.outcomes.forEach((o, oi) => (o.evidence || []).forEach((e) => {
          // The deepest matching nodes: a parent always matches what its children match.
          const all = nodes.filter((n) => covers(n, e));
          const ids = new Set(all.map((n) => n.id));
          const parents = new Set(all.map((n) => n.parent).filter((id) => ids.has(id)));
          const hits = all.filter((n) => !parents.has(n.id));
          const flag = !hits.length ? '✗ NO MATCH' : hits.length > 1 ? '? ' + hits.length + ' matches' : '✓';
          if (!hits.length) problems++;
          console.log(`  ${flag.padEnd(12)} ${c.id}${oi ? ' (alt ' + oi + ')' : ''} "${e.match}"${e.context ? ' in "' + e.context + '"' : ''}` +
            (hits.length ? ' → ' + hits.slice(0, 4).map((h) => h.id + ' ' + h.tag + ' "' + norm(h.text).trim().slice(0, 30) + '"').join(', ') : ''));
        }));
      }
    }
  } finally {
    chrome.close();
  }
  console.log(problems ? `\n${problems} evidence item(s) match nothing on the page.` : '\nEvery evidence item matches a node.');
  process.exit(problems ? 1 : 0);
}

// One job per (case, run k), grouped by site so workers rarely reload pages.
// --retry-errors: the saved run's results, with jobs only for the runs that errored.
let jobs = [];
let results;
let runSet = SET, runSetFile = setFile, runCount = RUNS, retryNote = '';
if (RETRY_FROM) {
  const data = JSON.parse(readFileSync(RETRY_FROM, 'utf8'));
  runSet = /testset/.test(data.set || '') ? 'test' : /freshset/.test(data.set || '') ? 'fresh' : 'dev';
  const fresh = loadSet(runSet);
  runSetFile = fresh.file;
  runCount = data.runs;
  selected.length = 0;
  data.cases.forEach((saved) => {
    const c = fresh.cases.find((f) => f.question === (saved.question || saved.q));
    if (c) selected.push(Object.assign(c, { saved }));
  });
  results = selected.map((c) => c.saved.runs.map((r) => { const x = { context: [], ...r }; return { ...r, score: score(x, c), rscore: retrievalScore(x, c), ascore: answerScore(x, c) }; }));
  selected.forEach((c, ci) => results[ci].forEach((r, k) => { if (r.error) jobs.push({ c, ci, k }); }));
  retryNote = `retried ${jobs.length} errored run(s) of ${RETRY_FROM.replace(HERE + '/', 'tests/')}`;
  if (!jobs.length) { console.log('No errored runs in ' + RETRY_FROM); process.exit(0); }
} else {
  results = selected.map(() => new Array(RUNS));
  selected.forEach((c, ci) => { for (let k = 0; k < RUNS; k++) jobs.push({ c, ci, k }); });
}
const workers = Math.min(PARALLEL, jobs.length);
console.log(`${runSetFile}: ${RETRY_FROM ? retryNote : selected.length + ' cases × ' + RUNS + ' runs'} = ${jobs.length} queries, ` +
  `${workers} worker(s), ~${GAP_S} s apart per worker`);
console.log('Keys: ' + (KEYS.length ? KEYS.map((k) => k.name + ' …' + k.value.slice(-4)).join(', ') : 'none in .env (using the build\'s key)') + '\n');

let done = 0;
const rekeyStats = [];
async function worker(w) {
  const key = KEYS.length ? KEYS[w % KEYS.length] : null;
  const chrome = await openChrome(key && key.value);
  let site = null;
  let first = true;
  try {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      if (job.c.site !== site) {
        site = job.c.site;
        await chrome.load(sites[site]);
        if (!(await chrome.evaluate('!!window.PageLens'))) {
          throw new Error('PageLens did not load on ' + sites[site].url + '. Is the site running, and built with node build.js?');
        }
      }
      if (!first) await sleep(GAP_S * (0.8 + Math.random() * 0.4) * 1000); // jitter
      first = false;
      let r;
      try { r = await chrome.evaluate(EXPLORE(job.c.question)); } catch (err) { r = { error: err.message }; }
      r.score = score(r, job.c); r.rscore = retrievalScore(r, job.c); r.ascore = answerScore(r, job.c);
      r.worker = w + 1;
      results[job.ci][job.k] = r;
      done++;
      console.log(`  [${String(done).padStart(3)}/${done + jobs.length}] w${w + 1}${key ? ' …' + key.value.slice(-4) : ''} ` +
        `${r.score.success ? '✓' : '✗'} ${job.c.id} ${job.c.question}`);
    }
  } finally {
    if (key) rekeyStats.push(`w${w + 1} …${key.value.slice(-4)}: ${chrome.rekeyed()} Gemini requests`);
    chrome.close();
  }
}
await Promise.all(Array.from({ length: workers }, (_, w) => worker(w)));

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
saveRun({ set: runSet, setFile: runSetFile, runs: runCount, selected, results, keys: rekeyStats, stamp, note: retryNote || undefined,
  withAnswer: WITH_ANSWER,
  commit: gitCommit(), started: new Date().toISOString() });
