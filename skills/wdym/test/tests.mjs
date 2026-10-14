// wdym core tests. Run: node --test test/
// Every test that writes uses its own temp config, so nothing touches the real ~/.jtl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  SKILL_DIR, loadConfig, loadRules, triage, clip, readRows, cardAnswer, shownReading, verdictOf,
  hook, render, isHeadless, codexExec, score, tune, coach, loadTerms, matchTerms, termsSheet, loadTargets, fillTarget,
  loadGolden, evaluate,
} from '../scripts/wdym.mjs';

const SCRIPT = join(SKILL_DIR, 'scripts', 'wdym.mjs');
const CLEAN = { HOME: process.env.HOME || '', PATH: process.env.PATH || '' };

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'wdym-test-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, '{}');
  return { dir, cfg: loadConfig({ config: path }, CLEAN) };
}
const rules = loadRules();
const tier = (p) => triage(p, rules).tier;

// A Claude Code transcript line with an AskUserQuestion card and his answer.
function transcriptWithCard(path, picked, ts = new Date(Date.now() + 1000).toISOString()) {
  const ask = { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'AskUserQuestion', input: { questions: [{ question: 'Is this it?', options: [{ label: 'Yes, go (Recommended)', preview: 'Goal: faster load' }, { label: 'Edit' }] }] } }] } };
  const ans = { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: `User has answered your questions: "Is this it?"="${picked}".` }] } };
  writeFileSync(path, JSON.stringify(ask) + '\n' + JSON.stringify(ans) + '\n');
}

// ---------------------------------------------------------------- triage ----
test('triage: vague build prompts get a card, anchored ones go', () => {
  assert.equal(tier('make it better'), 'CHECK');
  assert.equal(tier('can you make it pop more'), 'CHECK');
  assert.equal(tier('lets redo that thing from yesterday'), 'CHECK');
  assert.equal(tier('fix the typo on line 12 of src/app.js so the test passes'), 'GO');
});

test('triage: questions never get a card', () => {
  const w = triage('why is the build failing?', rules);
  assert.equal(w.type, 'wondering'); assert.equal(w.tier, 'GO');
  assert.equal(tier('wdym the tests pass?'), 'GO');
  assert.equal(tier('grill my plan'), 'GO');
  assert.equal(tier(''), 'GO');
});

test('triage: taste plus an outward send escalates to ASK, class design', () => {
  const t = triage('make the hero feel more premium like apple, and post it to linkedin', rules);
  assert.equal(t.tier, 'ASK');
  assert.equal(t.cls, 'design');
  assert.ok(t.cost.includes('outward'));
});

test('triage: unanchored reference lands in class reference', () => {
  assert.equal(triage('lets redo that thing from yesterday', rules).cls, 'reference');
});

test('triage: plan mode keeps the tier and adds the plan note', () => {
  const t = triage('make it better', rules, { mode: 'plan' });
  assert.equal(t.tier, 'CHECK'); assert.ok(t.notes.includes('plan'));
});

// ----------------------------------------------------------------- clip ----
test('clip masks keys and long tokens, and bounds length', () => {
  // Fake keys are assembled at run time so secret scanners never see a key-shaped literal.
  assert.match(clip('use ' + 'sk-' + 'abcdefghijklmnopqrstu please'), /<redacted>/);
  assert.match(clip('token ' + 'a'.repeat(40)), /<redacted>/);
  assert.ok(!clip('ghp' + '_ABCDEFGHIJKLMNOPQRST').includes('ABCDEFGH'));
  assert.equal(clip('word '.repeat(60), 50).length, 50);
});

// ---------------------------------------------------------------- verdict ----
test('verdictOf: corrections, breakage and a short yes', () => {
  assert.equal(verdictOf('no i meant the settings page, not the header', rules), 'miss');
  assert.equal(verdictOf('yes', rules), 'hit');
  assert.equal(verdictOf('', rules), null);
  assert.equal(verdictOf('add a footer too', rules), null);
});

// ---------------------------------------------------------------- codex ----
test('codex: the card goes in chat (no card tool), and codex exec runs headless', () => {
  const { cfg } = sandbox();
  const out = hook({ prompt: 'make it better', session_id: 'c1' }, cfg, { env: CLEAN, engine: 'codex', exec: () => false });
  assert.match(out, /^wdym: CHECK/); assert.match(out, /ask in chat and stop/); assert.doesNotMatch(out, /AskUserQuestion/);
  const row = readRows(cfg.ledger).at(-1);
  assert.equal(row.engine, 'codex'); assert.equal(row.shown, 'CHECK'); assert.equal(row.headless, false);
  const quiet = hook({ prompt: 'make it nicer', session_id: 'c2' }, cfg, { env: CLEAN, engine: 'codex', exec: () => true });
  assert.doesNotMatch(quiet, /ask in chat|AskUserQuestion/);
  assert.equal(readRows(cfg.ledger).at(-1).headless, true);
  // engine claude never walks the process tree
  assert.match(hook({ prompt: 'make it pop', session_id: 'c3' }, cfg, { env: CLEAN, exec: () => { throw new Error('walked'); } }), /AskUserQuestion/);
});

test('codex: codexExec reads the ancestors, exec only', () => {
  const table = (rows) => () => new Map(rows.map(([pid, ppid, args]) => [pid, { ppid, args }]));
  assert.equal(codexExec(30, table([[30, 20, '/bin/sh -c node wdym.mjs hook'], [20, 10, '/opt/homebrew/bin/codex exec --ephemeral "fix it"'], [10, 1, 'zsh']])), true);
  assert.equal(codexExec(30, table([[30, 20, '/bin/sh -c node wdym.mjs hook'], [20, 10, 'node /usr/lib/node_modules/@openai/codex/bin/codex.js -c x=1 exec hi'], [10, 1, 'zsh']])), true);
  assert.equal(codexExec(30, table([[30, 20, '/bin/sh -c node wdym.mjs hook'], [20, 10, '/opt/homebrew/bin/codex'], [10, 1, 'zsh']])), false);
  assert.equal(codexExec(30, table([[30, 20, 'sh'], [20, 1, 'codex resume']])), false);
  assert.equal(codexExec(30, table([[30, 20, 'git exec-path'], [20, 1, 'vim codex-notes.md']])), false);
  assert.equal(codexExec(30, table([])), false);
});

// ----------------------------------------------------------------- hook ----
test('hook: vague prompt prints a card instruction and logs one read', () => {
  const { cfg } = sandbox();
  const out = hook({ prompt: 'make it better', session_id: 's1' }, cfg, { env: CLEAN });
  assert.match(out, /^wdym: CHECK/);
  assert.match(out, /AskUserQuestion/);
  const rows = readRows(cfg.ledger);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'read'); assert.equal(rows[0].shown, 'CHECK');
  assert.ok(existsSync(join(cfg.stateDir, 's1.json')));
});

test('hook: a correction on the next prompt writes a miss and a receipt', () => {
  const { cfg } = sandbox();
  hook({ prompt: 'fix the header', session_id: 's2' }, cfg, { env: CLEAN });
  const out = hook({ prompt: 'no i meant the settings page, not the header', session_id: 's2' }, cfg, { env: CLEAN });
  assert.match(out, /noted rd-\S+ as a misread/);
  const miss = readRows(cfg.ledger).find(r => r.kind === 'verdict' && r.verdict === 'miss');
  assert.ok(miss); assert.equal(miss.source, 'next');
});

test('hook: silence is never a hit; every read gets exactly one verdict', () => {
  const { cfg } = sandbox();
  for (const p of ['make it better', 'add a footer with the address', 'also add the phone number', 'and a map link at the bottom'])
    hook({ prompt: p, session_id: 's3' }, cfg, { env: CLEAN });
  const rows = readRows(cfg.ledger);
  const v = rows.filter(r => r.kind === 'verdict');
  assert.equal(v.length, 3, 'three closed reads, the last one still open');
  assert.ok(v.every(r => r.verdict === 'unknown' && r.source === 'superseded'));
  const reads = rows.filter(r => r.kind === 'read').map(r => r.id);
  assert.deepEqual(v.map(r => r.ref), reads.slice(0, 3));
});

test('hook: questions keep the read open; a later correction is a late miss', () => {
  const { cfg } = sandbox();
  hook({ prompt: 'fix the header', session_id: 's8' }, cfg, { env: CLEAN });
  hook({ prompt: 'why is it taking so long?', session_id: 's8' }, cfg, { env: CLEAN });
  hook({ prompt: 'no i meant the settings page, not the header', session_id: 's8' }, cfg, { env: CLEAN });
  const rows = readRows(cfg.ledger);
  const first = rows.find(r => r.kind === 'read');
  const miss = rows.find(r => r.kind === 'verdict' && r.verdict === 'miss');
  assert.equal(miss.ref, first.id); assert.equal(miss.source, 'late');
});

test('hook: an open read with only questions after it expires as unknown', () => {
  const { cfg } = sandbox();
  for (const p of ['make it better', 'why is that?', 'what does it do?', 'how long will it take?'])
    hook({ prompt: p, session_id: 's9' }, cfg, { env: CLEAN });
  const v = readRows(cfg.ledger).filter(r => r.kind === 'verdict');
  assert.equal(v.length, 1); assert.equal(v[0].source, 'expired');
});

test('hook: slash commands and empty prompts are ignored', () => {
  const { cfg } = sandbox();
  assert.equal(hook({ prompt: '/clear', session_id: 's4' }, cfg, { env: CLEAN }), '');
  assert.equal(hook({ prompt: '   ', session_id: 's4' }, cfg, { env: CLEAN }), '');
  assert.equal(readRows(cfg.ledger).length, 0);
});

test('hook: off means silent and no ledger', () => {
  const { cfg } = sandbox();
  assert.equal(hook({ prompt: 'make it better', session_id: 's5' }, { ...cfg, off: true }, { env: CLEAN }), '');
  assert.equal(readRows(cfg.ledger).length, 0);
});

test('hook: budget blocks a second card in a row', () => {
  const { cfg } = sandbox();
  hook({ prompt: 'make it better', session_id: 's6' }, cfg, { env: CLEAN });
  const out = hook({ prompt: 'can you make it pop more', session_id: 's6' }, cfg, { env: CLEAN });
  assert.match(out, /card budget used/);
  const reads = readRows(cfg.ledger).filter(r => r.kind === 'read');
  assert.equal(reads[1].tier, 'CHECK'); assert.equal(reads[1].shown, 'GO');
});

test('hook: headless runs never ask (env flags and sdk entrypoint)', () => {
  for (const env of [{ ...CLEAN, WDYM_HEADLESS: '1' }, { ...CLEAN, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }]) {
    const { cfg } = sandbox();
    const out = hook({ prompt: 'make it better', session_id: 'h' }, cfg, { env });
    assert.match(out, /nobody to ask/);
    assert.equal(readRows(cfg.ledger)[0].shown, 'GO');
  }
  assert.equal(isHeadless({ prompt: 'x' }, rules, { ...CLEAN, CLAUDE_CODE_ENTRYPOINT: 'cli' }), false);
  // A pack names its own runner's flag; core alone does not know it.
  assert.equal(isHeadless({ prompt: 'x' }, rules, { ...CLEAN, TEAM_HEADLESS: '1' }), false);
  assert.equal(isHeadless({ prompt: 'x' }, { ...rules, headlessEnv: ['TEAM_HEADLESS'] }, { ...CLEAN, TEAM_HEADLESS: '1' }), true);
});

test('hook: a picked recommended card option is a hit and card-unneeded', () => {
  const { cfg, dir } = sandbox();
  const tp = join(dir, 't.jsonl');
  hook({ prompt: 'make it better', session_id: 's7', transcript_path: tp }, cfg, { env: CLEAN });
  transcriptWithCard(tp, 'Yes, go (Recommended)');
  hook({ prompt: 'add a footer with the address', session_id: 's7', transcript_path: tp }, cfg, { env: CLEAN });
  const v = readRows(cfg.ledger).filter(r => r.kind === 'verdict').map(r => r.verdict);
  assert.ok(v.includes('card-unneeded')); assert.ok(v.includes('hit'));
});

test('hook: a card answered early in a long session still counts (judged from the read, not the tail)', () => {
  const { cfg, dir } = sandbox();
  const tp = join(dir, 't.jsonl');
  const filler = (n) => Array.from({ length: n }, (_, i) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `x${i}`, content: 'y'.repeat(1000) }] } })).join('\n') + '\n';
  writeFileSync(tp, filler(100));
  hook({ prompt: 'make it better', session_id: 's9', transcript_path: tp }, cfg, { env: CLEAN });
  const ts = new Date(Date.now() + 1000).toISOString();
  const ask = { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu9', name: 'AskUserQuestion', input: { questions: [{ question: 'Is this it?', options: [{ label: 'Yes, go (Recommended)', preview: 'Goal: faster load' }, { label: 'Edit' }] }] } }] } };
  // the 2026-10-14 wording, then 700 KB of the work that followed
  const ans = { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu9', content: 'Your questions have been answered: "Is this it?"="Yes, go (Recommended)" selected preview:\nGoal: faster load' }] } };
  appendFileSync(tp, JSON.stringify(ask) + '\n' + JSON.stringify(ans) + '\n' + filler(700));
  hook({ prompt: 'add a footer with the address', session_id: 's9', transcript_path: tp }, cfg, { env: CLEAN });
  const v = readRows(cfg.ledger).filter(r => r.kind === 'verdict').map(r => r.verdict);
  assert.ok(v.includes('hit'), v.join(',')); assert.ok(!v.includes('unknown'), v.join(','));
});

test('cardAnswer: picking a non-first option is card-justified material', () => {
  const { dir } = sandbox();
  const tp = join(dir, 't.jsonl');
  transcriptWithCard(tp, 'Edit');
  const entries = readFileSync(tp, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const a = cardAnswer(entries, new Date(0).toISOString());
  assert.equal(a.picked, 'Edit'); assert.equal(a.recommended, false);
  assert.equal(shownReading(entries, new Date(0).toISOString()), 'Goal: faster load');
});

// ---------------------------------------------------------------- render ----
test('render: GO is silent, design class adds the terms step', () => {
  assert.equal(render(triage('fix the typo on line 12 of src/app.js', rules), rules), '');
  const out = render(triage('make the hero feel more premium like apple, and post it to linkedin', rules), rules);
  assert.match(out, /^wdym: ASK/); assert.match(out, /wdym terms/);
  assert.ok(out.length <= 600);
});

// ----------------------------------------------------------- score / tune ----
test('score and tune: card share over 20% moves the threshold up one step only', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ kind: 'read', id: `rd-${i}`, shown: i < 12 ? 'CHECK' : 'GO', ts: new Date().toISOString() });
  const s = score(rows);
  assert.equal(s.reads, 40); assert.equal(s.card_share, 0.3);
  const r = tune(s, rules.thresholds);
  assert.equal(r.next, Math.min(rules.thresholds.bounds?.check?.[1] ?? 4, rules.thresholds.check + (rules.thresholds.step || 0.5)));
  assert.match(tune({ ...s, reads: 5 }, rules.thresholds).why, /need 30/);
});

test('score: a verdict on a headless read is not his verdict; readRows skips non-object lines', () => {
  const now = new Date().toISOString();
  const s = score([
    { kind: 'read', id: 'rd-h', shown: 'GO', headless: true, ts: now },
    { kind: 'read', id: 'rd-o', shown: 'GO', ts: now },
    { kind: 'verdict', ref: 'rd-h', verdict: 'unknown', ts: now },
    { kind: 'verdict', ref: 'rd-o', verdict: 'miss', ts: now },
  ]);
  assert.equal(s.reads, 1); assert.equal(s.unknown, 0); assert.equal(s.miss, 1); assert.equal(s.miss_after_go, 1);
  const dir = mkdtempSync(join(tmpdir(), 'wdym-rows-'));
  const ledger = join(dir, 'reads.jsonl');
  writeFileSync(ledger, ['null', '[]', '42', '"x"', JSON.stringify({ kind: 'read', id: 'rd-1', ts: now })].join('\n') + '\n');
  assert.equal(readRows(ledger).length, 1);
  assert.doesNotThrow(() => score(readRows(ledger)));
});

test('coach: ranks tells by misses and offers a clearer phrasing', () => {
  const now = new Date().toISOString();
  const rows = [
    { kind: 'read', id: 'rd-a', tier: 'CHECK', tells: ['vague-goal', 'no-done'], excerpt: 'make it better', ts: now },
    { kind: 'verdict', ref: 'rd-a', verdict: 'miss' },
  ];
  const c = coach(rows, rules);
  assert.equal(c[0].tell, 'vague-goal'); assert.equal(c[0].misses, 1); assert.ok(c[0].clearer.length > 10);
  assert.ok(!c.some(x => x.tell === 'no-done'));
});

// ---------------------------------------------------------------- terms ----
test('terms: plain words find the named design term', () => {
  const { cfg } = sandbox();
  const terms = loadTerms(cfg);
  assert.ok(terms.length >= 70);
  assert.equal(matchTerms('background moves slower than the page', terms)[0].id, 'parallax');
  assert.equal(matchTerms('items show up one after another', terms)[0].id, 'stagger');
  assert.deepEqual(matchTerms('', terms), []);
  const html = termsSheet('it floats <b>', matchTerms('the card kind of floats', terms));
  assert.match(html, /&lt;b&gt;/); assert.match(html, /<svg/);
});

test('learn-term: a learned phrase wins outright', () => {
  const { cfg } = sandbox();
  const r = spawnSync(process.execPath, [SCRIPT, 'learn-term', 'the wiggly bit', 'marquee', '--config', cfg.path], { env: CLEAN, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(matchTerms('the wiggly bit', loadTerms(cfg))[0].id, 'marquee');
});

// --------------------------------------------------------------- target ----
test('target: every bundled target fills a brief and marks gaps', () => {
  const t = loadTargets(null);
  assert.ok(Object.keys(t).length >= 6);
  for (const tpl of Object.values(t)) assert.ok(tpl.includes('{{'), 'template has slots');
  const out = fillTarget('Goal: {{goal}}\nDone: {{done_when}}\n{{out}}', { goal: 'faster load', out: ['no new deps'] });
  assert.match(out, /Goal: faster load/); assert.match(out, /done when: not given/); assert.match(out, /- no new deps/);
});

// ----------------------------------------------------------------- eval ----
test('eval: the public golden set passes on both splits', () => {
  const g = loadGolden(join(SKILL_DIR, 'test', 'golden.public.json'));
  for (const split of ['dev', 'test']) {
    const r = evaluate(g, rules, split);
    assert.ok(r.pass, `${split}: ${JSON.stringify(r)}`);
    assert.ok(r.misreads > 0 && r.negatives > 0);
  }
});

// ------------------------------------------------------------------ cli ----
test('cli: off, status and on round-trip in a temp config', () => {
  const { cfg } = sandbox();
  const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a, '--config', cfg.path], { env: CLEAN, encoding: 'utf8' });
  assert.equal(run('off').status, 0);
  assert.match(run('status').stdout, /OFF/);
  const h = spawnSync(process.execPath, [SCRIPT, 'hook', '--config', cfg.path], { env: CLEAN, encoding: 'utf8', input: JSON.stringify({ prompt: 'make it better', session_id: 'c' }) });
  assert.equal(h.stdout, '');
  assert.equal(run('on').status, 0);
  assert.match(run('status').stdout, / on /);
});

test('cli: hook fails open on bad stdin', () => {
  const { cfg } = sandbox();
  const h = spawnSync(process.execPath, [SCRIPT, 'hook', '--config', cfg.path], { env: CLEAN, encoding: 'utf8', input: 'not json' });
  assert.equal(h.status, 0); assert.equal(h.stdout, '');
});

test('cli: nothing lands in the real home when a config is given', () => {
  const { cfg, dir } = sandbox();
  spawnSync(process.execPath, [SCRIPT, 'hook', '--config', cfg.path], { env: CLEAN, encoding: 'utf8', input: JSON.stringify({ prompt: 'make it better', session_id: 'z' }) });
  assert.ok(readdirSync(dir).includes('reads.jsonl'));
  assert.equal(cfg.ledger, join(dir, 'reads.jsonl'));
});

// --------------------------------------------------------- shared lib ----
test('lib/jtl.mjs matches the jtl automate copy when that repo is beside us', (t) => {
  const oss = resolve(SKILL_DIR, '..', '..', '..', 'oss', 'jtl', 'skills', 'automate', 'scripts', 'lib', 'jtl.mjs');
  if (!existsSync(oss)) return t.skip('jtl repo not present (public checkout)');
  assert.equal(readFileSync(join(SKILL_DIR, 'scripts', 'lib', 'jtl.mjs'), 'utf8'), readFileSync(oss, 'utf8'));
});
