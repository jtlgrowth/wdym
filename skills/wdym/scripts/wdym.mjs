#!/usr/bin/env node
// wdym: read what the user means before the agent works. Dependency-free, Node 18+.
//
//   node wdym.mjs hook [--config F] [--engine claude|codex]   UserPromptSubmit: judge, triage, log, print (stdin = hook JSON)
//   node wdym.mjs triage "<prompt>" [--json]  tier for one prompt, nothing logged
//   node wdym.mjs mark <rd-id> hit|miss [words]  your own verdict on a read
//   node wdym.mjs lean [class] [--json]       past misses, newest first (one class or all)
//   node wdym.mjs score [--days N] [--json]   hit rate, card share, over-asking meter
//   node wdym.mjs tune [--days N] [--apply]   move the card threshold one step inside its bounds
//   node wdym.mjs coach [--days 7]            your top vague phrases and a clearer way to say each
//   node wdym.mjs terms "<your words>" [--html out.html] [--json]   design words -> named terms
//   node wdym.mjs learn-term "<your words>" <term-id>             remember your phrase for a term
//   node wdym.mjs recent [--hours 48] [--dir .] [--json]            "which one?" candidates
//   node wdym.mjs target <chatgpt|claude|codex|gemini|image|video|...> [--brief JSON]  brief -> prompt for another AI
//   node wdym.mjs eval <golden.jsonl|.json> [--split test|dev|all] [--json]           the benchmark
//   node wdym.mjs off | on | status
// State lives in ~/.jtl/wdym/ (config.json, reads.jsonl, state/) unless --config or WDYM_CONFIG says otherwise.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { jtlHome, readJson, writePrivate, parseArgs, isMain, IS_WIN } from './lib/jtl.mjs';

const SELF = fileURLToPath(import.meta.url);
export const SKILL_DIR = resolve(dirname(SELF), '..');
export const VERSION = '1.0.0';
const REF = join(SKILL_DIR, 'references');
const CARD = new Set(['CHECK', 'ASK']);
const HEADLESS_ENTRY = /^sdk/i;            // claude -p and the SDKs set CLAUDE_CODE_ENTRYPOINT=sdk-*
const OPEN_PROMPTS = 3, OPEN_MINUTES = 60; // an open read waits this long for a verdict

// ----------------------------------------------------------------- config ----
export function homeDir(env = process.env) { return join(jtlHome(env), 'wdym'); }

export function loadConfig(flags = {}, env = process.env) {
  const path = flags.config || env.WDYM_CONFIG || join(homeDir(env), 'config.json');
  const base = dirname(path);
  const cfg = readJson(path, {}) || {};
  const tilde = (p) => p.replace(/^~(?=\/|$)/, env.HOME || env.USERPROFILE || '~');
  const abs = (p, d) => p ? (isAbsolute(tilde(p)) ? tilde(p) : resolve(base, tilde(p))) : d;
  return {
    path, raw: cfg,
    off: !!cfg.off,
    edition: cfg.edition || 'public',
    pack: cfg.pack ? abs(cfg.pack) : null,
    // Ledger and state sit beside the config unless it names them, so a test config never
    // writes into the real ~/.jtl.
    ledger: env.WDYM_LEDGER || abs(cfg.ledger, join(base, 'reads.jsonl')),
    stateDir: env.WDYM_STATE_DIR || abs(cfg.state_dir, join(base, 'state')),
    thresholds: cfg.thresholds || null,
  };
}

function saveConfig(cfg, patch) {
  const next = { ...cfg.raw, ...patch };
  writePrivate(cfg.path, next);
  return next;
}

// ------------------------------------------------------------------ rules ----
const rx = (s) => s ? new RegExp(s, 'i') : null;
const rxg = (s) => s ? new RegExp(s, 'gi') : null;

// Core tells plus an optional pack. A pack adds; it never deletes a core rule.
export function loadRules(cfg = { pack: null, thresholds: null }) {
  const core = JSON.parse(readFileSync(join(REF, 'tells.json'), 'utf8'));
  const pack = cfg.pack ? readJson(join(cfg.pack, 'pack.json'), null) : null;
  const gen = cfg.pack ? readJson(join(cfg.pack, 'verdict.generated.json'), null) : null;
  // A named pack that will not parse is an error, never a silent fall back to core rules.
  for (const [f, v] of [['pack.json', pack], ['verdict.generated.json', gen]])
    if (cfg.pack && v === null && existsSync(join(cfg.pack, f))) throw new Error(`${f} in ${cfg.pack} is not valid JSON`);
  const merged = {
    thresholds: { ...core.thresholds, ...(pack?.thresholds || {}), ...(cfg.thresholds || {}) },
    budget: { ...core.budget, ...(pack?.budget || {}) },
    type: Object.fromEntries(Object.entries(core.type).map(([k, v]) => [k, rx(join2(v, pack?.type?.[k]))])),
    tells: [...core.tells, ...(pack?.tells || [])].map(t => ({ ...t, rx: t.re ? rx(t.re) : null })),
    anchors: [...core.anchors, ...(pack?.anchors || [])].map(a => ({ ...a, rx: rx(a.re) })),
    cost: [...core.cost, ...(pack?.cost || [])].map(c => ({ ...c, rx: rx(c.re) })),
    askCosts: new Set([...(core.ask_costs || []), ...(pack?.ask_costs || [])]),
    delegate: rx(join2(core.delegate, pack?.delegate)),
    verdict: {
      miss: rx(join2(core.verdict.miss, pack?.verdict?.miss, gen?.miss)),
      broken: rx(join2(core.verdict.broken, pack?.verdict?.broken, gen?.broken)),
      yes: rx(join2(core.verdict.yes, pack?.verdict?.yes)),
    },
    classes: Object.entries({ ...core.classes, ...(pack?.classes || {}) }).map(([k, v]) => [k, rx(v)]),
    readings: (pack?.readings || []).map(r => ({ ...r, rx: rx(r.re) })),
    coach: { ...core.coach, ...(pack?.coach || {}) },
    bot: rx(join2(pack?.bot, gen?.bot)),
    card: { question: 'Is this it?', yes: 'Yes, go', edit: 'Edit', ...(pack?.card || {}) },
    because: pack?.because || null,
    headlessEnv: pack?.headless_env || [],
    pack,
  };
  return merged;
}

function join2(...parts) {
  const p = parts.filter(Boolean);
  return p.length ? p.map(s => `(?:${s})`).join('|') : null;
}

// ----------------------------------------------------------------- triage ----
const words = (s) => (s.match(/[\p{L}\p{N}'’]+/gu) || []);

export function triage(text, rules, { mode = null } = {}) {
  const prompt = String(text || '').trim();
  const lower = prompt.toLowerCase();
  const out = { tier: 'GO', type: 'building', score: 0, tells: [], anchors: [], cost: [], cls: 'general', notes: [], reading: null };
  if (!prompt) return out;
  if (rules.type.explain?.test(prompt)) { out.type = 'explain'; out.notes.push('explain'); return out; }

  // A question that only names a build word ("why is the build failing?") is still a question;
  // a question that asks for work ("can you fix it?") is a request.
  const request = /\b(can you|could you|would you|please|i want|i need|we need|let'?s|lets|go ahead)\b/i.test(prompt);
  const building = rules.type.building?.test(prompt);
  const asks = rules.type.wondering?.test(prompt);
  if (asks && (!building || !request)) out.type = 'wondering';
  else if (rules.type.deciding?.test(prompt)) out.type = 'deciding';
  else out.type = 'building';

  const w = words(prompt);
  let score = 0;
  const hasAnchor = rules.anchors.some(a => a.rx.test(prompt));
  for (const t of rules.tells) {
    let hit = false;
    if (t.rx) hit = t.rx.test(prompt);
    else if (t.id === 'short-vague') hit = out.type === 'building' && w.length <= 6 && !hasAnchor && /\b(it|this|that|them|those|these|iyan|yan|ito|yun)\b/i.test(prompt) && !/\b(file|page|button|test|function|bug|error|line|repo|branch|commit)\b/i.test(prompt);
    else if (t.id === 'dump') hit = w.length > 120 && (lower.match(/\b(also|and also|plus|then|another thing|tapos|pati)\b/g) || []).length >= 3;
    else if (t.id === 'no-done') hit = out.type === 'building' && !hasAnchor;
    if (hit) { score += t.w; out.tells.push(t.id); }
  }
  for (const a of rules.anchors) if (a.rx.test(prompt)) { score += a.w; out.anchors.push(a.id); }
  for (const c of rules.cost) if (c.rx.test(prompt)) out.cost.push(c.id);
  out.score = Math.round(score * 10) / 10;

  // The most specific class wins: a tell's own class first, then the class patterns in order.
  const tellCls = rules.tells.find(t => t.cls && out.tells.includes(t.id) && t.id !== 'described-look')?.cls;
  out.cls = tellCls || (rules.classes.find(([, r]) => r.test(prompt)) || ['general'])[0];
  const rd = rules.readings.find(r => r.rx.test(prompt));
  if (rd) { out.reading = rd.reading; if (rd.cls) out.cls = rd.cls; }

  const th = rules.thresholds;
  // Pure wondering never gets a card; nothing to build means nothing to misread yet.
  // Signal-only tells (described-look, no-done) cannot raise a card on their own.
  const strong = out.tells.some(id => !['described-look', 'no-done', 'i-mean'].includes(id));
  if (out.type === 'wondering') return out;
  if (rules.delegate?.test(prompt)) { out.notes.push('delegated'); if (out.score < th.ask) return out; }
  if (!strong) return out;
  if (out.score >= th.ask && out.cost.some(c => rules.askCosts.has(c))) out.tier = 'ASK';
  else if (out.score >= th.check) out.tier = 'CHECK';
  if (out.type === 'deciding' && out.tier === 'CHECK') out.tier = 'GO';   // a "which one" question gets a pick, not a card
  if (mode === 'plan' && out.tier !== 'GO') out.notes.push('plan');
  return out;
}

// --------------------------------------------------------------- ledger ----
const MASK = /\b(?:sk|pk|rk|ghp|gho|xox[abp]|AKIA|AIza)[A-Za-z0-9_\-]{8,}\b|\b[A-Za-z0-9_\-]{32,}\b/g;
export function clip(s, n = 160) {
  const t = String(s || '').replace(MASK, '<redacted>').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function newId(prefix) { return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; }

export function appendRow(ledger, row) {
  // Owner-only: the ledger holds excerpts of the user's prompts.
  mkdirSync(dirname(ledger), { recursive: true, mode: 0o700 });
  appendFileSync(ledger, JSON.stringify({ v: 1, ts: new Date().toISOString(), ...row }) + '\n', { mode: 0o600 });
}

export function readRows(ledger, { days = null } = {}) {
  if (!existsSync(ledger)) return [];
  const since = days ? Date.now() - days * 864e5 : 0;
  const rows = [];
  for (const l of readFileSync(ledger, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      if (r && typeof r === 'object' && !Array.isArray(r) && (!since || Date.parse(r.ts) >= since)) rows.push(r);
    } catch {}
  }
  return rows;
}

// ---------------------------------------------------------------- state ----
const sid = (s) => String(s || 'nosession').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'nosession';
function statePath(cfg, session) { return join(cfg.stateDir, `${sid(session)}.json`); }
function loadState(cfg, session) { return readJson(statePath(cfg, session), null) || { open: null, recent: [] }; }
function saveState(cfg, session, st) {
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(statePath(cfg, session), JSON.stringify(st), { mode: 0o600 });
}

export function transcriptSize(path) {
  try { return path ? statSync(path).size : null; } catch { return null; }
}

// The transcript from where a read opened, forward. The card comes before any tool, so the ask
// and its answer sit right after that point however long the session runs on; a tail window
// lost them once the work after the card passed 512 KB (a real card, 1.8 MB back, 2026-10-14).
// Only lines that can hold a card, its answer or a "You want:" line are parsed.
export function transcriptFrom(path, from, bytes = 2097152) {
  if (!path || !existsSync(path) || !Number.isInteger(from) || from < 0) return null;
  let fd;
  try {
    const size = statSync(path).size;
    if (from > size) return null;
    const buf = Buffer.alloc(Math.min(bytes, size - from));
    fd = openSync(path, 'r'); readSync(fd, buf, 0, buf.length, from);
    return buf.toString('utf8').split('\n')
      .filter(l => l.includes('AskUserQuestion') || l.includes('answered') || l.includes('You want'))
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}

// Tail of a transcript, newest last. Only the last ~512 KB is read so the hook stays fast.
export function transcriptTail(path, bytes = 524288) {
  if (!path || !existsSync(path)) return [];
  let fd;
  try {
    const size = statSync(path).size, start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fd = openSync(path, 'r'); readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}

// The card answer comes back as an AskUserQuestion tool result, never as a prompt, so the
// verdict on a card is read from the transcript: the option he picked against the first option.
export function cardAnswer(entries, sinceIso) {
  const since = sinceIso ? Date.parse(sinceIso) : 0;
  const asks = new Map();
  let found = null;
  for (const e of entries) {
    const ts = Date.parse(e.timestamp || '') || 0;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type === 'tool_use' && c.name === 'AskUserQuestion' && ts >= since) asks.set(c.id, c.input || {});
      if (c.type === 'tool_result' && asks.has(c.tool_use_id)) {
        const input = asks.get(c.tool_use_id);
        const text = typeof c.content === 'string' ? c.content : (c.content || []).map(x => x.text || '').join(' ');
        const q = (input.questions || [])[0] || {};
        const first = String(q.options?.[0]?.label || '');
        const m = /"[^"]*"="([^"]*)"/.exec(text);
        const picked = m ? m[1] : '';
        if (!picked) continue;
        const norm = (s) => s.toLowerCase().replace(/\(recommended\)/g, '').trim();
        found = { question: clip(q.question, 120), first: clip(first, 80), picked: clip(picked, 120), recommended: !!picked && norm(picked) === norm(first) };
      }
    }
  }
  return found;
}

// The reading the agent showed: the card's first option, else a "You want:" line in its reply.
export function shownReading(entries, sinceIso) {
  const since = sinceIso ? Date.parse(sinceIso) : 0;
  let reading = null;
  for (const e of entries) {
    if ((Date.parse(e.timestamp || '') || 0) < since || e.message?.role !== 'assistant') continue;
    for (const c of e.message.content || []) {
      if (c.type === 'tool_use' && c.name === 'AskUserQuestion') {
        const o = c.input?.questions?.[0]?.options?.[0];
        if (o) reading = clip(o.preview || o.description || o.label, 160);
      }
      if (c.type === 'text') { const m = /\*{0,2}You want:\*{0,2}\s*(.+)/i.exec(c.text || ''); if (m) reading = clip(m[1], 160); }
    }
  }
  return reading;
}

// ---------------------------------------------------------------- judge ----
export function verdictOf(text, rules) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (rules.verdict.miss?.test(t)) return 'miss';
  if (rules.verdict.broken?.test(t)) return 'correction';
  if (words(t).length <= 8 && rules.verdict.yes?.test(t)) return 'hit';
  return null;
}

// Judge the session's open read from this prompt (and any card answer since it was logged).
// Silence is never a hit: an open read with no signal expires as unknown.
function judge(cfg, rules, st, payload, prompt, now = Date.now()) {
  const out = [];
  const open = st.open;
  if (!open) return out;
  const entries = transcriptFrom(payload.transcript_path, open.offset) || transcriptTail(payload.transcript_path);
  if (CARD.has(open.tier) && !open.answered) {
    const ans = cardAnswer(entries, open.ts);
    if (ans) {
      open.answered = true;
      if (ans.recommended) open.hit = true;
      const v = ans.recommended ? (open.tier === 'ASK' ? 'ask-unneeded' : 'card-unneeded') : (open.tier === 'ASK' ? 'ask-justified' : 'card-justified');
      out.push({ kind: 'verdict', id: newId('rv'), ref: open.id, verdict: v, source: 'card-answer', words: ans.picked, reading: ans.first, cls: open.cls });
      if (ans.recommended) out.push({ kind: 'verdict', id: newId('rv'), ref: open.id, verdict: 'hit', source: 'card-answer', words: ans.picked, reading: ans.first, cls: open.cls });
    }
  }
  const v = verdictOf(prompt, rules);
  const reading = open.reading || shownReading(entries, open.ts);
  if (v) {
    out.push({ kind: 'verdict', id: newId('rv'), ref: open.id, verdict: v, source: open.n === 0 ? 'next' : 'late', words: clip(prompt), reading, cls: open.cls });
    st.open = null;
    return out;
  }
  open.n = (open.n || 0) + 1;
  if (open.n >= OPEN_PROMPTS || now - Date.parse(open.ts) > OPEN_MINUTES * 6e4) {
    if (!open.hit) out.push({ kind: 'verdict', id: newId('rv'), ref: open.id, verdict: 'unknown', source: 'expired', words: '', reading, cls: open.cls });
    st.open = null;
  }
  return out;
}

// --------------------------------------------------------------- print ----
export function leanLines(cfg, cls, max = 3) {
  const rows = readRows(cfg.ledger);
  const misses = rows.filter(r => r.kind === 'verdict' && r.verdict === 'miss' && r.words && (!cls || r.cls === cls));
  return misses.slice(-max).reverse().map(r => `"${clip(r.words, 90)}"${r.reading ? ` (I had read: ${clip(r.reading, 60)})` : ''}`);
}

export function render(t, rules, { lean = [], headless = false, budget = false, engine = 'claude' } = {}) {
  if (t.tier === 'GO') {
    const go = [];
    if (t.notes.includes('delegated')) go.push('wdym: delegated. Pick the cheapest path that meets the ask and state it in one line before you start.');
    // A pack reading is how this user means a phrase; it rides even when no card is needed.
    if (t.reading) go.push(`${go.length ? '' : 'wdym: '}Known reading: ${t.reading}.`);
    return go.join(' ');
  }
  const why = `${t.tells.join(', ')}${t.cost.length ? `; cost: ${t.cost.join(', ')}` : ''}; class ${t.cls}`;
  const parts = [];
  if (headless || budget) {
    parts.push(`wdym: vague (${why}) but no card (${headless ? 'nobody to ask' : 'card budget used'}). Mirror first: You want / Because / I'd add, then proceed and log the assumption.`);
  } else if (engine === 'codex' && t.tier === 'CHECK') {
    // Codex has no card tool: the question goes in chat and his next message is the answer.
    parts.push(`wdym: CHECK (${why}). Before any tool, ask in chat and stop for the answer: "${rules.card.question}" then your rewrite (Goal / Done when / In / Out), and offer "${rules.card.yes}" or "${rules.card.edit}". Facts you can look up are not questions.`);
  } else if (engine === 'codex') {
    parts.push(`wdym: ASK (${why}). Before any tool, ask in chat and stop for the answer: your rewrite first, then each open decision as a numbered list of concrete options, recommendation first.`);
  } else if (t.tier === 'CHECK') {
    parts.push(`wdym: CHECK (${why}). Before any tool, one AskUserQuestion card: question "${rules.card.question}", first option "${rules.card.yes} (Recommended)" with your rewrite as its preview (Goal / Done when / In / Out), then "${rules.card.edit}". Facts you can look up are not questions.`);
  } else {
    parts.push(`wdym: ASK (${why}). Before any tool, one AskUserQuestion batch of up to 4: the rewrite card first ("${rules.card.yes} (Recommended)" with the brief as preview), then each open decision with concrete options, recommendation first.`);
  }
  if ((t.cls === 'design' || t.tells.includes('described-look')) && !headless && !budget) parts.push('Design words: run `wdym terms "<their words>"` and offer the top 3 named terms as options.');
  if (t.cls === 'reference' && !headless && !budget) parts.push('Unanchored reference: run `wdym recent` and offer the likely candidates as options.');
  if (t.reading) parts.push(`Known reading: ${t.reading}.`);
  if (rules.because) parts.push(rules.because);
  if (t.notes.includes('plan')) parts.push('Plan mode: the confirmed brief opens the plan; name no file paths in it.');
  if (lean.length) parts.push(`Past misses here: ${lean.join('; ')}`);
  let s = parts.join(' ');
  if (s.length > 600) s = s.slice(0, 599) + '…';
  return s;
}

// ----------------------------------------------------------------- hook ----
export function isHeadless(payload, rules, env = process.env, { engine = 'claude', exec = codexExec } = {}) {
  if (['WDYM_HEADLESS', ...(rules.headlessEnv || [])].some(k => env[k] === '1')) return true;
  if (HEADLESS_ENTRY.test(env.CLAUDE_CODE_ENTRYPOINT || '')) return true;
  if (rules.bot && rules.bot.test(String(payload.prompt || ''))) return true;
  if (engine === 'codex' && exec()) return true;
  return false;
}

// `codex exec` is a machine run with nobody at the prompt, and Codex sets no env that says so
// (checked on codex-cli 0.162: the hook sees the same env as in the TUI). The hook's ancestors
// name the command, so walk them. Windows has no ps: never headless there by this rule.
export function codexExec(pid = process.ppid, table = psTable) {
  if (IS_WIN) return false;
  const rows = table();
  for (let i = 0, p = pid; i < 8 && p > 1; i++) {
    const row = rows.get(p);
    if (!row) break;
    if (/(^|[\/\s])codex[\w.-]*(\s|$)/.test(row.args) && /(^|\s)exec(\s|$)/.test(row.args)) return true;
    p = row.ppid;
  }
  return false;
}

function psTable() {
  const rows = new Map();
  try {
    const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 400 }).stdout || '';
    for (const l of out.split('\n')) {
      const m = l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), args: m[3] });
    }
  } catch {}
  return rows;
}

export function hook(payload, cfg, { env = process.env, now = Date.now(), engine = 'claude', exec } = {}) {
  if (cfg.off) return '';
  const prompt = String(payload.prompt || '').trim();
  if (!prompt || prompt.startsWith('/')) return '';
  const rules = loadRules(cfg);
  // Machine-typed prompts (task notifications, handoff resumes, watchers) are not the user:
  // they never open a read, never close his open one, and never land in the ledger.
  if (rules.bot?.test(prompt)) return '';
  const session = payload.session_id || 'nosession';
  const st = loadState(cfg, session);
  const rows = judge(cfg, rules, st, payload, prompt, now);

  const headless = isHeadless(payload, rules, env, { engine, ...(exec ? { exec } : {}) });
  const t = triage(prompt, rules, { mode: payload.permission_mode || null });
  // Budget: never two cards in a row, at most max_cards in the last window prompts.
  const recent = st.recent.slice(-(rules.budget.window - 1));
  const budget = CARD.has(t.tier) && (CARD.has(st.recent.at(-1)) || recent.filter(x => CARD.has(x)).length >= rules.budget.max_cards);
  const shown = CARD.has(t.tier) && !headless && !budget ? t.tier : 'GO';

  // A correction that arrives after a GO read means triage missed it: that read is the miss.
  // A question keeps the open read waiting; a new build prompt closes it, so every read gets
  // exactly one verdict and silence is never counted as a hit.
  const id = newId('rd');
  const opens = t.type !== 'wondering' && t.type !== 'explain';
  if (opens && st.open && !st.open.hit) rows.push({ kind: 'verdict', id: newId('rv'), ref: st.open.id, verdict: 'unknown', source: 'superseded', words: '', reading: st.open.reading, cls: st.open.cls });
  rows.push({ kind: 'read', id, session: sid(session).slice(0, 8), tier: t.tier, shown, type: t.type, cls: t.cls, tells: t.tells, cost: t.cost, score: t.score, excerpt: clip(prompt), plan_mode: payload.permission_mode === 'plan', headless, edition: cfg.edition, engine });
  for (const r of rows) appendRow(cfg.ledger, r);

  if (opens) st.open = { id, ts: new Date(now).toISOString(), tier: shown, cls: t.cls, n: 0, reading: null, offset: transcriptSize(payload.transcript_path) };
  st.recent = [...st.recent, shown].slice(-6);
  saveState(cfg, session, st);

  const miss = rows.find(r => r.kind === 'verdict' && r.verdict === 'miss');
  const receipt = miss ? `wdym: noted ${miss.ref} as a misread (${miss.cls}); read this prompt as the correction.` : '';
  const body = render(t, rules, { lean: CARD.has(t.tier) ? leanLines(cfg, t.cls) : [], headless, budget, engine });
  return [receipt, body].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------- score ----
export function score(rows) {
  // Headless reads could never show a card, so they never count toward card share,
  // and a verdict on one is not his verdict either.
  const reads = rows.filter(r => r.kind === 'read' && !r.headless);
  const headlessIds = new Set(rows.filter(r => r.kind === 'read' && r.headless).map(r => r.id));
  const verdicts = rows.filter(r => r.kind === 'verdict' && !headlessIds.has(r.ref));
  const count = (f) => verdicts.filter(f).length;
  const cards = reads.filter(r => CARD.has(r.shown)).length;
  const byCls = {};
  for (const v of verdicts) {
    const c = (byCls[v.cls || 'general'] ||= { hit: 0, miss: 0, correction: 0, unknown: 0 });
    if (c[v.verdict] !== undefined) c[v.verdict]++;
  }
  const hit = count(v => v.verdict === 'hit'), miss = count(v => v.verdict === 'miss');
  const cardAns = count(v => /^(card|ask)-(justified|unneeded)$/.test(v.verdict));
  const unneeded = count(v => /-unneeded$/.test(v.verdict));
  const goIds = new Set(reads.filter(r => r.shown === 'GO').map(r => r.id));
  return {
    reads: reads.length, cards, card_share: reads.length ? +(cards / reads.length).toFixed(3) : 0,
    hit, miss, correction: count(v => v.verdict === 'correction'), unknown: count(v => v.verdict === 'unknown'),
    hit_rate: hit + miss ? +(hit / (hit + miss)).toFixed(3) : null,
    miss_after_go: goIds.size ? +(count(v => v.verdict === 'miss' && goIds.has(v.ref)) / goIds.size).toFixed(3) : 0,
    card_answers: cardAns, unneeded_share: cardAns ? +(unneeded / cardAns).toFixed(3) : null,
    by_class: byCls,
  };
}

// Small, bounded change only: the CHECK threshold moves one step. ASK is never auto-moved,
// because asking on the user's own calls (money, outward, delete, taste) is not a tuning knob.
export function tune(s, th) {
  const step = th.step || 0.5, [lo, hi] = th.bounds?.check || [1.5, 4];
  let next = th.check, why = 'inside targets, no change';
  if (s.reads < 30) return { next, why: `only ${s.reads} reads, need 30 before tuning`, structural: [] };
  if (s.card_share > 0.20 || (s.unneeded_share ?? 0) > 0.40) { next = Math.min(hi, th.check + step); why = `cards ${s.card_share}, unneeded ${s.unneeded_share}: ask less`; }
  else if (s.miss_after_go > 0.05 && s.card_share < 0.15) { next = Math.max(lo, th.check - step); why = `misses after GO ${s.miss_after_go}: ask a little more`; }
  const structural = [];
  if (next === th.check && (s.card_share > 0.30 || s.miss_after_go > 0.10)) structural.push('threshold is at its bound and targets still miss: review the tells, not the threshold');
  if ((s.unneeded_share ?? 0) > 0.60) structural.push('most cards confirm the first reading: the rewrite is good, consider mirroring instead of asking for those classes');
  return { next, why, structural };
}

// ---------------------------------------------------------------- coach ----
export function coach(rows, rules, days = 7) {
  const since = Date.now() - days * 864e5;
  const reads = rows.filter(r => r.kind === 'read' && Date.parse(r.ts) >= since);
  const missed = new Set(rows.filter(r => r.kind === 'verdict' && ['miss', 'card-justified', 'ask-justified'].includes(r.verdict)).map(r => r.ref));
  const tally = {};
  for (const r of reads) {
    if (!(CARD.has(r.tier) || missed.has(r.id))) continue;
    for (const t of r.tells || []) {
      if (['no-done', 'described-look'].includes(t)) continue;
      (tally[t] ||= { n: 0, misses: 0, example: r.excerpt });
      tally[t].n++; if (missed.has(r.id)) tally[t].misses++;
    }
  }
  return Object.entries(tally).sort((a, b) => (b[1].misses - a[1].misses) || (b[1].n - a[1].n)).slice(0, 3)
    .map(([id, v]) => ({ tell: id, times: v.n, misses: v.misses, example: v.example, clearer: rules.coach[id] || 'Name the result you want and how you will know it is done.' }));
}

// ---------------------------------------------------------------- terms ----
const STOP = new Set('a an the and or of to in on at is it its this that with for my our your me i we you be like kind kinda sort so just make want look looks thing when than then as into while by from too very really there their them they what how'.split(' '));
const stem = (w) => w.length > 5 ? w.replace(/(ings?|ed|es|ers?|ly|s)$/, '') : w.length > 3 ? w.replace(/s$/, '') : w;
const toks = (s, stop = STOP) => [...new Set(words(String(s).toLowerCase()).filter(w => w.length > 1 && !stop.has(w)).map(stem))];

export function loadTerms(cfg) {
  const base = readJson(join(REF, 'design-terms.json'), { terms: [] }).terms;
  const packTerms = cfg?.pack ? readJson(join(cfg.pack, 'terms.json'), null) || {} : {};
  const extra = packTerms.says || {};
  const learned = {};
  for (const r of readRows(cfg.ledger)) if (r.kind === 'term') (learned[r.term] ||= []).push(r.phrase);
  const out = base.map(t => ({ ...t, says: [...(t.says || []), ...(extra[t.id] || [])], learned: learned[t.id] || [] }));
  // A pack in another language adds its filler words, so they never decide a match.
  out.stop = packTerms.stop || [];
  return out;
}

// Rare words decide: "scroll" appears in a dozen terms, "slower" in one. Each phrase is scored
// as an idf-weighted cosine against the query; the best phrase wins, the name adds a little.
export function matchTerms(query, terms, n = 3) {
  const stop = terms.stop?.length ? new Set([...STOP, ...terms.stop]) : STOP;
  const tk = (s) => toks(s, stop);
  const q = tk(query), qs = String(query).toLowerCase().trim();
  if (!q.length) return [];
  const df = {};
  for (const t of terms) for (const w of new Set(tk([t.term, t.id, ...t.says].join(' ')))) df[w] = (df[w] || 0) + 1;
  const idf = (w) => Math.log(1 + terms.length / (df[w] || 0.5));
  const mass = (ws) => Math.sqrt(ws.reduce((a, w) => a + idf(w) ** 2, 0)) || 1;
  const qm = mass(q);
  const scored = terms.map(t => {
    if (t.learned.some(p => p.toLowerCase().trim() === qs)) return { t, s: 100 };
    let s = 0;
    for (const say of [...t.says, ...t.learned]) {
      const st = tk(say); if (!st.length) continue;
      const dot = st.filter(w => q.includes(w)).reduce((a, w) => a + idf(w) ** 2, 0);
      s = Math.max(s, dot / (mass(st) * qm));
    }
    const name = tk(`${t.term} ${t.id}`);
    s += 0.15 * name.filter(w => q.includes(w)).reduce((a, w) => a + idf(w), 0) / (mass(name) || 1);
    return { t, s };
  }).filter(x => x.s > 0.12).sort((a, b) => b.s - a.s);
  return scored.slice(0, n).map(x => ({ id: x.t.id, term: x.t.term, category: x.t.category, one_line: x.t.one_line, score: +x.s.toFixed(2), svg: x.t.svg }));
}

export function termsSheet(query, hits) {
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cards = hits.map((h, i) => `<figure><div class="pv">${h.svg || ''}</div><figcaption><b>${String.fromCharCode(65 + i)}. ${esc(h.term)}</b><span>${esc(h.one_line)}</span></figcaption></figure>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>wdym terms</title>
<style>:root{--bg:#fff;--fg:#111;--mut:#666;--line:#ddd}@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#f2f2f2;--mut:#aaa;--line:#333}.pv svg{filter:invert(1)}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:16px/1.5 ui-rounded,system-ui,sans-serif}h1{font-size:18px;font-weight:600;margin:0 0 4px}p{color:var(--mut);margin:0 0 20px}
main{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));max-width:900px}figure{margin:0;border:1px solid var(--line);border-radius:14px;padding:14px}
.pv svg{width:100%;height:auto;display:block}figcaption{display:grid;gap:4px;margin-top:10px}figcaption span{color:var(--mut);font-size:15px}</style></head>
<body><h1>You said: "${esc(query)}"</h1><p>Tap the letter that matches what you picture.</p><main>${cards}</main></body></html>`;
}

// --------------------------------------------------------------- recent ----
export function recent({ dir = '.', hours = 48, extra = [], max = 10 } = {}) {
  const since = Date.now() - hours * 3600e3, out = [];
  const skip = /(^|\/)(node_modules|\.git|dist|build|\.next|__pycache__|\.venv)(\/|$)/;
  const walk = (d, depth) => {
    if (depth < 0) return;
    let ents = []; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') && depth < 3) continue;
      const p = join(d, e.name);
      if (skip.test(p)) continue;
      if (e.isDirectory()) walk(p, depth - 1);
      else { try { const m = statSync(p).mtimeMs; if (m >= since) out.push({ path: p, mtime: m }); } catch {} }
    }
  };
  for (const d of [dir, ...extra]) walk(resolve(d), 3);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, max)
    .map(x => ({ path: x.path, rel: relative(resolve(dir), x.path), when: new Date(x.mtime).toISOString() }));
}

// --------------------------------------------------------------- target ----
export function loadTargets(cfg) {
  const md = readFileSync(join(REF, 'targets.md'), 'utf8');
  const out = {};
  for (const sec of md.split(/^## /m).slice(1)) {
    const id = sec.split('\n')[0].trim().toLowerCase();
    const m = /```text\n([\s\S]*?)```/.exec(sec);
    if (id && m) out[id] = m[1].trim();
  }
  for (const [id, tpl] of Object.entries(readJson(cfg?.pack ? join(cfg.pack, 'pack.json') : '', {})?.targets || {})) out[id] = tpl;
  return out;
}

export function fillTarget(tpl, brief = {}) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = brief[k];
    return Array.isArray(v) ? v.map(x => `- ${x}`).join('\n') : (v ? String(v) : `(${k.replace('_', ' ')}: not given)`);
  }).replace(/\n{3,}/g, '\n\n');
}

// ----------------------------------------------------------------- eval ----
export function loadGolden(path) {
  const txt = readFileSync(path, 'utf8').trim();
  return txt.startsWith('[') ? JSON.parse(txt) : txt.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

export function evaluate(rows, rules, split = 'test') {
  const use = rows.filter(r => split === 'all' || r.split === split || (split === 'dev' && r.split === 'dev-live'));
  const mis = use.filter(r => r.label === 'misread'), neg = use.filter(r => r.label === 'none');
  const tierOf = (r) => triage(r.prompt, rules).tier;
  const caught = mis.filter(r => tierOf(r) !== 'GO').length;
  // A pack reading answers the misread without a card ("up to you" = you do it); counted apart, never in the gate.
  const read = mis.filter(r => { const t = triage(r.prompt, rules); return t.tier !== 'GO' || t.reading; }).length;
  const negT = neg.map(tierOf);
  const judgeHit = mis.filter(r => r.fired_at != null && r.next?.[r.fired_at] && verdictOf(r.next[r.fired_at], rules) !== null).length;
  const judgeN = mis.filter(r => r.fired_at != null && r.next?.[r.fired_at]).length;
  const falseMiss = neg.filter(r => (r.next || []).some(n => verdictOf(n, rules) === 'miss')).length;
  const pct = (a, b) => b ? +(a / b).toFixed(3) : null;
  const res = {
    split, misreads: mis.length, negatives: neg.length,
    misread_caught: pct(caught, mis.length),
    misread_caught_or_read: pct(read, mis.length),
    ask_on_negatives: pct(negT.filter(t => t === 'ASK').length, neg.length),
    check_on_negatives: pct(negT.filter(t => t === 'CHECK').length, neg.length),
    judge_catches_correction: pct(judgeHit, judgeN),
    judge_false_miss: pct(falseMiss, neg.length),
  };
  res.gates = {
    misread_caught: res.misread_caught !== null && res.misread_caught >= 0.70,
    ask_on_negatives: res.ask_on_negatives !== null && res.ask_on_negatives <= 0.03,
    check_on_negatives: res.check_on_negatives !== null && res.check_on_negatives <= 0.15,
  };
  res.pass = Object.values(res.gates).every(Boolean);
  return res;
}

// ----------------------------------------------------------------- main ----
function readStdin() { try { return readFileSync(0, 'utf8'); } catch { return ''; } }

async function main(argv) {
  const { pos, flags } = parseArgs(argv);
  const cmd = pos[0] || 'status';
  const cfg = loadConfig(flags);
  const json = (o) => console.log(JSON.stringify(o, null, 2));

  if (cmd === 'hook') {
    let payload = {};
    try { payload = JSON.parse(readStdin() || '{}'); } catch { return; }
    const s = hook(payload, cfg, { engine: flags.engine === 'codex' ? 'codex' : 'claude' });
    if (s) console.log(s);
    return;
  }
  if (cmd === 'triage') {
    const t = triage(pos.slice(1).join(' ') || readStdin(), loadRules(cfg), { mode: flags.mode || null });
    if (flags.json) return json(t);
    console.log(`${t.tier}  type=${t.type} score=${t.score} class=${t.cls}${t.tells.length ? ` tells=${t.tells.join(',')}` : ''}${t.anchors.length ? ` anchors=${t.anchors.join(',')}` : ''}${t.cost.length ? ` cost=${t.cost.join(',')}` : ''}${t.reading ? `\n  known reading: ${t.reading}` : ''}`);
    return;
  }
  if (cmd === 'mark') {
    const [, ref, verdict, ...rest] = pos;
    if (!/^rd-/.test(ref || '') || !['hit', 'miss'].includes(verdict)) { console.error('usage: wdym mark <rd-id> hit|miss [what you meant]'); process.exitCode = 2; return; }
    const read = readRows(cfg.ledger).find(r => r.id === ref && r.kind === 'read');
    if (!read) { console.error(`no read ${ref} in ${cfg.ledger}`); process.exitCode = 1; return; }
    appendRow(cfg.ledger, { kind: 'verdict', id: newId('rv'), ref, verdict, source: 'manual', words: clip(rest.join(' ')), reading: null, cls: read.cls });
    console.log(`marked ${ref} ${verdict}`);
    return;
  }
  if (cmd === 'lean') {
    const lines = leanLines(cfg, pos[1] || null, Number(flags.n || 5));
    if (flags.json) return json(lines);
    console.log(lines.length ? lines.map(l => `- ${l}`).join('\n') : 'no misses recorded yet');
    return;
  }
  if (cmd === 'score') {
    const s = score(readRows(cfg.ledger, { days: flags.days ? Number(flags.days) : null }));
    if (flags.json) return json(s);
    console.log(`reads ${s.reads}, cards ${s.cards} (${(s.card_share * 100).toFixed(1)}%), hit ${s.hit}, miss ${s.miss}, correction ${s.correction}, unknown ${s.unknown}`);
    console.log(`hit rate ${s.hit_rate ?? 'n/a'}, misses after GO ${s.miss_after_go}, card answers ${s.card_answers} (unneeded ${s.unneeded_share ?? 'n/a'})`);
    for (const [c, v] of Object.entries(s.by_class)) console.log(`  ${c.padEnd(16)} hit ${v.hit}  miss ${v.miss}  correction ${v.correction}  unknown ${v.unknown}`);
    return;
  }
  if (cmd === 'tune') {
    const rules = loadRules(cfg);
    const s = score(readRows(cfg.ledger, { days: Number(flags.days || 14) }));
    const r = tune(s, rules.thresholds);
    if (flags.apply && r.next !== rules.thresholds.check) saveConfig(cfg, { thresholds: { ...(cfg.raw.thresholds || {}), check: r.next } });
    if (flags.json) return json({ ...r, from: rules.thresholds.check, applied: !!flags.apply && r.next !== rules.thresholds.check, score: s });
    console.log(`check threshold ${rules.thresholds.check} -> ${r.next}${flags.apply ? '' : ' (dry run)'}: ${r.why}`);
    for (const x of r.structural) console.log(`STRUCTURAL: ${x}`);
    return;
  }
  if (cmd === 'coach') {
    const c = coach(readRows(cfg.ledger), loadRules(cfg), Number(flags.days || 7));
    if (flags.json) return json(c);
    if (!c.length) { console.log('nothing to coach this week: no vague prompts caught'); return; }
    console.log(`Your top vague habits, last ${flags.days || 7} days:`);
    c.forEach((x, i) => console.log(`${i + 1}. ${x.tell} (${x.times}x, ${x.misses} misread)\n   you wrote: "${x.example}"\n   clearer: ${x.clearer}`));
    return;
  }
  if (cmd === 'terms') {
    const q = pos.slice(1).join(' ');
    const hits = matchTerms(q, loadTerms(cfg), Number(flags.n || 3));
    if (flags.html) { const p = resolve(String(flags.html)); writeFileSync(p, termsSheet(q, hits)); if (!flags.json) console.log(`sheet: ${p}`); }
    if (flags.json) return json(hits.map(({ svg, ...h }) => h));
    if (!hits.length) { console.log('no close term; describe what moves, where, and when'); return; }
    hits.forEach((h, i) => console.log(`${String.fromCharCode(65 + i)}. ${h.term} [${h.id}] ${h.one_line}`));
    return;
  }
  if (cmd === 'learn-term') {
    const [, phrase, term] = pos;
    if (!phrase || !term || !loadTerms(cfg).some(t => t.id === term)) { console.error('usage: wdym learn-term "<your words>" <term-id>'); process.exitCode = 2; return; }
    appendRow(cfg.ledger, { kind: 'term', id: newId('tm'), phrase: clip(phrase, 120), term });
    console.log(`learned: "${phrase}" = ${term}`);
    return;
  }
  if (cmd === 'recent') {
    const pack = cfg.pack ? readJson(join(cfg.pack, 'pack.json'), {}) : {};
    const extra = (pack.recent_dirs || []).map(d => d.replace(/^~(?=\/)/, process.env.HOME || ''));
    const r = recent({ dir: flags.dir || process.cwd(), hours: Number(flags.hours || 48), extra });
    if (flags.json) return json(r);
    console.log(r.length ? r.map((x, i) => `${String.fromCharCode(65 + i)}. ${x.rel.startsWith('..') ? x.path : x.rel}  (${x.when.slice(0, 16).replace('T', ' ')})`).join('\n') : 'nothing changed in that window');
    return;
  }
  if (cmd === 'target') {
    const targets = loadTargets(cfg), id = String(pos[1] || '').toLowerCase();
    if (!targets[id]) { console.error(`targets: ${Object.keys(targets).join(', ')}`); process.exitCode = 2; return; }
    let brief = {};
    try { brief = JSON.parse(flags.brief || readStdin() || '{}'); } catch { console.error('--brief must be JSON: {"goal": "...", "done_when": "..."}'); process.exitCode = 2; return; }
    console.log(fillTarget(targets[id], brief));
    return;
  }
  if (cmd === 'eval') {
    const file = pos[1] || join(SKILL_DIR, 'test', 'golden.public.json');
    const res = evaluate(loadGolden(file), loadRules(cfg), flags.split || 'test');
    if (flags.json) return json(res);
    console.log(`${res.pass ? 'PASS' : 'FAIL'}  split=${res.split} misreads=${res.misreads} negatives=${res.negatives}`);
    for (const k of ['misread_caught', 'misread_caught_or_read', 'ask_on_negatives', 'check_on_negatives', 'judge_catches_correction', 'judge_false_miss']) console.log(`  ${k.padEnd(26)} ${res[k]}${res.gates[k] === undefined ? '' : res.gates[k] ? '  ok' : '  FAIL'}`);
    if (!res.pass) process.exitCode = 1;
    return;
  }
  if (cmd === 'off' || cmd === 'on') { saveConfig(cfg, { off: cmd === 'off' }); console.log(`wdym ${cmd} (${cfg.path})`); return; }
  if (cmd === 'status') {
    const s = score(readRows(cfg.ledger, { days: 7 }));
    console.log(`wdym ${VERSION} ${cfg.off ? 'OFF' : 'on'}  edition=${cfg.edition}  config=${cfg.path}`);
    console.log(`ledger ${cfg.ledger}  last 7 days: ${s.reads} reads, ${s.cards} cards, ${s.miss} misses`);
    return;
  }
  console.error('usage: wdym hook|triage|mark|lean|score|tune|coach|terms|learn-term|recent|target|eval|off|on|status');
  process.exitCode = 2;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(`wdym: ${e.message}`); process.exit(1); });
}
