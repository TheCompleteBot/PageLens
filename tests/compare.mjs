#!/usr/bin/env node
// Compares the explorer stage of two saved runs (tests/results/*.json), e.g. before
// and after a change:
//   node tests/compare.mjs <baseline.json> <new.json> [--out report.md]
// Uses each run's saved scores, so the answer step need not have run. Errored runs
// are left out on both sides; the fresh set's no-scroll cases are left out (they
// measure a known limitation, not the explorer).

import { readFileSync, writeFileSync } from 'node:fs';

const [baseFile, newFile] = process.argv.slice(2);
const outIdx = process.argv.indexOf('--out');
const outFile = outIdx === -1 ? '' : process.argv[outIdx + 1];
const load = (f) => JSON.parse(readFileSync(f, 'utf8'));

function rows(data) {
  const out = [];
  data.cases.forEach((c) => {
    if (c.type === 'noscroll') return;
    c.runs.forEach((r) => { if (!r.error) out.push({ c, r }); });
  });
  return out;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (x) => (Number.isNaN(x) ? '-' : Math.round(100 * x) + '%');

function stats(list) {
  let tp = 0, fn = 0, tn = 0, fp = 0;
  list.forEach(({ c, r }) => {
    const all = c.outcomes.every((o) => o.action === 'abstain');
    const none = c.outcomes.every((o) => o.action !== 'abstain');
    if (!all && !none) return;
    const p = r.action === 'abstain';
    if (all) { if (p) tp++; else fn++; } else { if (p) fp++; else tn++; }
  });
  const n = tp + fn + tn + fp;
  const po = (tp + tn) / n;
  const pe = ((tp + fp) * (tp + fn) + (fn + tn) * (fp + tn)) / (n * n);
  return {
    runs: list.length,
    answerable: mean(list.map((x) => (x.r.score.answerable ? 1 : 0))),
    success: mean(list.map((x) => (x.r.score.success ? 1 : 0))),
    action: mean(list.map((x) => (x.r.score.actionOk ? 1 : 0))),
    tpr: tp + fn ? tp / (tp + fn) : NaN,
    tnr: tn + fp ? tn / (tn + fp) : NaN,
    kappa: n && pe < 1 ? (po - pe) / (1 - pe) : NaN,
    calls: mean(list.map((x) => x.r.toolCalls || 0)),
    turns: mean(list.map((x) => x.r.turns || 0)),
    tokens: mean(list.map((x) => x.r.tokens || 0)),
    secs: mean(list.map((x) => (x.r.ms || 0) / 1000))
  };
}

const A = load(baseFile), B = load(newFile);
// Compare the same questions on both sides: only those present in both runs.
const both = new Set(B.cases.map((c) => c.id).filter((id) => A.cases.some((c) => c.id === id)));
A.cases = A.cases.filter((c) => both.has(c.id));
B.cases = B.cases.filter((c) => both.has(c.id));
const ra = rows(A), rb = rows(B);
const sa = stats(ra), sb = stats(rb);
const lines = [];
const diff = (a, b, f, lowerBetter) => {
  const d = b - a;
  const sign = d > 0 ? '+' : '';
  return f === 'pct' ? `${pct(a)} → ${pct(b)} (${sign}${Math.round(100 * d)} pts)`
    : `${a.toFixed(f)} → ${b.toFixed(f)} (${sign}${(100 * d / a).toFixed(0)}%)`;
};
lines.push(`Baseline: ${baseFile} (${sa.runs} completed runs)`, `New:      ${newFile} (${sb.runs} completed runs)`, `Questions compared: ${both.size}`, '');
lines.push('| Metric | Baseline → New |', '|---|---|');
lines.push(`| Answerable (hand-off has all evidence) | ${diff(sa.answerable, sb.answerable, 'pct')} |`);
lines.push(`| Success (targets have all evidence) | ${diff(sa.success, sb.success, 'pct')} |`);
lines.push(`| Action accuracy | ${diff(sa.action, sb.action, 'pct')} |`);
lines.push(`| Abstain TPR / TNR | ${pct(sa.tpr)} / ${pct(sa.tnr)} → ${pct(sb.tpr)} / ${pct(sb.tnr)} |`);
lines.push(`| Abstain κ | ${sa.kappa.toFixed(2)} → ${sb.kappa.toFixed(2)} |`);
lines.push(`| Tokens per question | ${diff(sa.tokens, sb.tokens, 0)} |`);
lines.push(`| Tool calls / turns | ${sa.calls.toFixed(1)} / ${sa.turns.toFixed(1)} → ${sb.calls.toFixed(1)} / ${sb.turns.toFixed(1)} |`);
lines.push(`| Seconds per question | ${diff(sa.secs, sb.secs, 1)} |`);
lines.push('', 'Questions whose answerable rate changed (completed runs, baseline → new):', '');
B.cases.forEach((c) => {
  const a = A.cases.find((x) => x.id === c.id);
  if (!a || c.type === 'noscroll') return;
  const f = (rs) => { const ok = rs.filter((r) => !r.error); return [ok.filter((r) => r.score.answerable).length, ok.length]; };
  const [x, nx] = f(a.runs), [y, ny] = f(c.runs);
  if (!nx || !ny || x / nx === y / ny) return;
  const worse = y / ny < x / nx;
  lines.push(`- ${worse ? '▼' : '▲'} ${c.id} ${x}/${nx} → ${y}/${ny}  ${c.question}`);
  if (worse) {
    c.runs.filter((r) => !r.error && !r.score.answerable).forEach((r) => {
      lines.push(`    - ${r.action}${r.match ? ' ' + r.match : ''} → ${r.targets.map((t) => '"' + t.text.replace(/\s+/g, ' ').slice(0, 40) + '"').join(', ') || '(none)'}; calls: ${r.calls.map((x) => x.slice(0, 50)).join(' → ')}`);
    });
  }
});
const text = lines.join('\n');
console.log(text);
if (outFile) writeFileSync(outFile, text + '\n');
