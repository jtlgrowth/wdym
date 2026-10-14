#!/usr/bin/env node
// Setup phase for wdym: it wires itself into every agent host on this computer.
//   node wire.mjs plan   [--config F] [--host claude|codex|hermes|all]   what apply would do, changes nothing
//   node wire.mjs apply  [--config F] [--host ...]   skill links + the prompt hook per host, then a first-win test
//   node wire.mjs doctor [--config F] [--fix] [--json]   every wire green or the exact fix
//   node wire.mjs remove [--config F] [--host ...]   takes out only what apply added (ledger and state stay)
// Claude Code and Codex get the skill and a UserPromptSubmit hook; Hermes has no prompt hook, so it
// gets the skill only. A pack config may carry "wire": {"claude": "glue:<file>"} when the pack's own
// hook already calls wdym (no second hook), and "hermes_skills": "<dir>" for the Hermes skill group.
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, lstatSync, renameSync, realpathSync, symlinkSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readJson, hostDir, parseArgs, printRows, which, IS_WIN, isMain } from './lib/jtl.mjs';
import { loadConfig } from './wdym.mjs';

const SELF = fileURLToPath(import.meta.url);
export const SKILL_DIR = resolve(dirname(SELF), '..');
const WDYM = join(SKILL_DIR, 'scripts', 'wdym.mjs');
export const HOSTS = ['claude', 'codex', 'hermes'];
// Ours whether or not the path is quoted: "/x/wdym.mjs" hook, /x/wdym.mjs hook.
const MARK = /wdym\.mjs"?\s+hook(\s|$)/;

// ------------------------------------------------------------------ paths ----
const tilde = (p, home) => p.replace(/^~(?=[\\/]|$)/, home);
const fromConfig = (p, cfg, home) => { const t = tilde(p, home); return isAbsolute(t) ? t : resolve(dirname(resolve(cfg.path)), t); };

export function hostPresent(host, env = process.env, home = homedir()) {
  return existsSync(host === 'hermes' ? (env.HERMES_HOME || join(home, '.hermes')) : hostDir(host, env, home));
}

export function skillLink(host, cfg, env = process.env, home = homedir()) {
  const wire = cfg.raw?.wire || {};
  if (host === 'hermes') {
    const dir = wire.hermes_skills ? fromConfig(wire.hermes_skills, cfg, home) : join(env.HERMES_HOME || join(home, '.hermes'), 'skills');
    return join(dir, 'wdym');
  }
  return join(hostDir(host, env, home), 'skills', 'wdym');
}

export function hookFile(host, env = process.env, home = homedir()) {
  return join(hostDir(host, env, home), host === 'claude' ? 'settings.json' : 'hooks.json');
}

// The command a host runs on every prompt. A stable node path beats process.execPath, which on
// Homebrew is a versioned Cellar path that breaks on the next upgrade.
export function hookCommand(host, cfg, { env = process.env, explicitConfig = false } = {}) {
  const node = which('node', env) || process.execPath;
  const q = (s) => `"${s}"`;
  return [q(node), q(WDYM), 'hook', ...(host === 'codex' ? ['--engine', 'codex'] : []),
    // absolute: the host runs the hook from whatever folder the user is in
    ...(explicitConfig ? ['--config', q(resolve(cfg.path))] : [])].join(' ');
}

export function glueFile(cfg, home = homedir()) {
  const c = cfg.raw?.wire?.claude;
  return typeof c === 'string' && c.startsWith('glue:') ? fromConfig(c.slice(5), cfg, home) : null;
}

// ------------------------------------------------------------- json files ----
// Read strictly: a host file that does not parse is never rewritten (it would lose his settings).
function readHostJson(path) {
  if (!existsSync(path)) return { ok: true, data: {} };
  try { return { ok: true, data: JSON.parse(readFileSync(path, 'utf8')) }; } catch { return { ok: false, data: null }; }
}

// Atomic, keeps the file's mode, and writes through a symlink (dotfile setups) instead of replacing it.
function writeHostJson(path, data) {
  let target = path;
  try { if (lstatSync(path).isSymbolicLink()) target = realpathSync(path); } catch {}
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o644;
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.wdym-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  renameSync(tmp, target);
}

const promptHooks = (data) => data?.hooks?.UserPromptSubmit || [];
const isOurs = (group) => (group.hooks || []).some(h => MARK.test(String(h.command || '')));
export const findHook = (data) => promptHooks(data).findIndex(isOurs);

// Codex runs a new hook only after the user approves it once; the approval lands in config.toml.
export function codexTrusted(env = process.env, home = homedir()) {
  const file = hookFile('codex', env, home);
  const read = readHostJson(file);
  const i = read.ok ? findHook(read.data) : -1;
  if (i < 0) return false;
  let toml = '';
  try { toml = readFileSync(join(hostDir('codex', env, home), 'config.toml'), 'utf8'); } catch { return false; }
  const key = `[hooks.state."${file}:user_prompt_submit:${i}:0"]`;
  const at = toml.indexOf(key);
  return at >= 0 && /^\s*trusted_hash\s*=/m.test(toml.slice(at + key.length).split(/\n\[/)[0]);
}

// ------------------------------------------------------------------ state ----
function linkState(link) {
  let st;
  try { st = lstatSync(link); } catch { return 'missing'; }
  if (st.isSymbolicLink()) {
    try { return realpathSync(link) === realpathSync(SKILL_DIR) ? 'ours' : 'other'; } catch { return 'broken'; }
  }
  return existsSync(join(link, 'SKILL.md')) ? 'copy' : 'other';
}

export function inspect(host, cfg, { env = process.env, home = homedir() } = {}) {
  const present = hostPresent(host, env, home);
  const link = skillLink(host, cfg, env, home);
  const out = { host, present, link, linkState: present ? linkState(link) : 'missing' };
  if (host === 'hermes') return out;
  if (host === 'claude' && glueFile(cfg, home)) {
    const g = glueFile(cfg, home);
    let text = '';
    try { text = readFileSync(g, 'utf8'); } catch {}
    return { ...out, hook: 'glue', glue: g, glueOk: text.includes('wdym.mjs') };
  }
  const file = hookFile(host, env, home);
  const read = readHostJson(file);
  out.hookFile = file;
  out.hookParse = read.ok;
  out.hook = !read.ok ? 'unreadable' : findHook(read.data) >= 0 ? 'present' : 'missing';
  if (host === 'codex') out.trusted = out.hook === 'present' && codexTrusted(env, home);
  return out;
}

// ------------------------------------------------------------------ apply ----
export function applyHost(host, cfg, { env = process.env, home = homedir(), explicitConfig = false, log = () => {} } = {}) {
  const s = inspect(host, cfg, { env, home });
  if (!s.present) { log(`  ${host}: not installed here, skipped`); return s; }
  if (s.linkState === 'missing' || s.linkState === 'broken') {
    if (s.linkState === 'broken') unlinkSync(s.link);
    mkdirSync(dirname(s.link), { recursive: true });
    symlinkSync(SKILL_DIR, s.link, IS_WIN ? 'junction' : 'dir');
    log(`  ${host}: skill linked at ${s.link}`);
  } else if (s.linkState === 'other') log(`  ${host}: ${s.link} holds something else; left alone`);
  if (s.hook === 'missing') {
    const read = readHostJson(s.hookFile);
    const data = read.data;
    data.hooks ||= {};
    data.hooks.UserPromptSubmit ||= [];
    // Appended last: earlier entries keep their index, so Codex keeps their approval.
    data.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: hookCommand(host, cfg, { env, explicitConfig }), timeout: 5 }] });
    writeHostJson(s.hookFile, data);
    log(`  ${host}: prompt hook added to ${s.hookFile}`);
  } else if (s.hook === 'unreadable') log(`  ${host}: ${s.hookFile} is not valid JSON; fix it, then run apply again`);
  return inspect(host, cfg, { env, home });
}

export function removeHost(host, cfg, { env = process.env, home = homedir(), log = () => {} } = {}) {
  const s = inspect(host, cfg, { env, home });
  if (s.linkState === 'ours') { unlinkSync(s.link); log(`  ${host}: skill link removed`); }
  if (s.hook === 'present') {
    const data = readHostJson(s.hookFile).data;
    data.hooks.UserPromptSubmit = data.hooks.UserPromptSubmit.filter(g => !isOurs(g));
    writeHostJson(s.hookFile, data);
    log(`  ${host}: prompt hook removed`);
  }
  return inspect(host, cfg, { env, home });
}

// First win: the exact command the host will run, fed one vague prompt, writes one read row.
export function firstWin(host, cfg, { env = process.env, explicitConfig = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wdym-wire-'));
  try {
    const cmd = hookCommand(host, cfg, { env, explicitConfig });
    const r = spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: 8000,
      input: JSON.stringify({ prompt: 'make it better', session_id: `wire-${host}`, cwd: dir }),
      env: { ...env, WDYM_LEDGER: join(dir, 'reads.jsonl'), WDYM_STATE_DIR: join(dir, 'state') } });
    const rows = readFileSync(join(dir, 'reads.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const read = rows.find(x => x.kind === 'read');
    const engine = host === 'codex' ? 'codex' : 'claude';
    return { ok: r.status === 0 && !!read && read.tier !== 'GO' && (read.engine || 'claude') === engine,
      detail: `exit ${r.status}, ${read ? `read ${read.tier}/${read.shown}` : 'no read row'}` };
  } catch (e) {
    return { ok: false, detail: e.code === 'ENOENT' ? 'the hook wrote no ledger row' : String(e.message || e).slice(0, 120) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ----------------------------------------------------------------- doctor ----
export function doctorRows(cfg, { env = process.env, home = homedir(), hosts = HOSTS } = {}) {
  const rows = [];
  for (const h of hosts) {
    const s = inspect(h, cfg, { env, home });
    if (!s.present) { rows.push({ name: `${h}: not installed`, ok: null }); continue; }
    rows.push({ name: `${h} skill`, ok: ['ours', 'copy'].includes(s.linkState), detail: `${s.link} (${s.linkState})`, fix: 'node wire.mjs apply' });
    if (h === 'hermes') continue;
    if (s.hook === 'glue') {
      rows.push({ name: `${h} prompt hook`, ok: s.glueOk, detail: `through ${s.glue}`, fix: `the pack glue no longer calls wdym.mjs: restore it in ${s.glue}` });
      continue;
    }
    rows.push({ name: `${h} prompt hook`, ok: s.hook === 'present', detail: s.hookFile,
      fix: s.hook === 'unreadable' ? `${s.hookFile} is not valid JSON; fix it, then run apply` : 'node wire.mjs apply' });
    if (h === 'codex' && s.hook === 'present') rows.push({ name: 'codex hook approved', ok: s.trusted,
      detail: s.trusted ? 'trusted in config.toml' : 'Codex skips a hook until you approve it once',
      fix: 'open Codex; when it asks to review hooks, approve the one running wdym.mjs hook' });
  }
  return rows;
}

// ------------------------------------------------------------------- main ----
function hostsFrom(flags) {
  if (!flags.host || flags.host === 'all') return HOSTS;
  const hs = String(flags.host).split(',');
  for (const h of hs) if (!HOSTS.includes(h)) throw new Error(`--host must be ${HOSTS.join('|')}|all`);
  return hs;
}

function main(argv = process.argv.slice(2)) {
  const { pos, flags } = parseArgs(argv);
  const cmd = pos[0];
  const explicitConfig = !!(flags.config || process.env.WDYM_CONFIG);
  const cfg = loadConfig(flags);
  const hosts = hostsFrom(flags);
  const log = (s) => console.log(s);
  if (cmd === 'plan') {
    for (const h of hosts) {
      const s = inspect(h, cfg);
      if (!s.present) { log(`  ${h}: not installed, skip`); continue; }
      log(`  ${h}: skill ${s.linkState === 'missing' || s.linkState === 'broken' ? `would link ${s.link}` : `${s.linkState} at ${s.link}`}`);
      if (h !== 'hermes') log(`  ${h}: hook ${s.hook === 'missing' ? `would add to ${s.hookFile}: ${hookCommand(h, cfg, { explicitConfig })}` : s.hook}`);
    }
    return 0;
  }
  if (cmd === 'apply' || (cmd === 'doctor' && flags.fix)) {
    for (const h of hosts) applyHost(h, cfg, { explicitConfig, log });
    let bad = 0;
    for (const h of hosts) {
      const s = inspect(h, cfg);
      if (!s.present || h === 'hermes' || s.hook !== 'present') continue;
      const w = firstWin(h, cfg, { explicitConfig });
      log(`  ${h}: first win ${w.ok ? 'ok' : 'FAILED'} (${w.detail})`);
      bad += !w.ok;
    }
    if (cmd === 'apply') { printRows(doctorRows(cfg, { hosts })); return bad ? 1 : 0; }
  }
  if (cmd === 'doctor') {
    const rows = doctorRows(cfg, { hosts });
    printRows(rows, !!flags.json);
    return rows.some(r => r.ok === false) ? 1 : 0;
  }
  if (cmd === 'remove') {
    for (const h of hosts) removeHost(h, cfg, { log });
    return 0;
  }
  console.error('usage: node wire.mjs plan|apply|doctor [--fix] [--json]|remove [--config F] [--host claude|codex|hermes|all]');
  return 2;
}

if (isMain(import.meta.url)) process.exitCode = main();
