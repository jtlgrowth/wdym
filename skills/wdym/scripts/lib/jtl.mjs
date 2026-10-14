// Shared helpers for JTL product skills (n8n, automate). Dependency-free, Node 18+.
// The same file ships inside every product skill; test/tests.mjs fails if the copies drift.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export const IS_WIN = process.platform === 'win32';

// True when this module is the script node was asked to run. Compared by real path: through a
// symlink (macOS /var, a linked skills folder) argv[1] and import.meta.url differ, and a plain
// string compare would make every command silently do nothing.
export function isMain(metaUrl) {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl)); } catch { return false; }
}

// ~/.jtl holds every product skill's local state: connections, playbook, setup record.
export function jtlHome(env = process.env, home = homedir()) {
  return env.JTL_HOME || join(home, '.jtl');
}

export function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

// Private file: dir 700, file 600, written through a temp file so a crash never leaves half a file.
export function writePrivate(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  try { chmodSync(dirname(path), 0o700); } catch {}
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch {}
}

// ------------------------------------------------------------------ hosts ----
export function hostDir(host, env = process.env, home = homedir()) {
  if (host === 'claude') return env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  if (host === 'codex') return env.CODEX_HOME || join(home, '.codex');
  throw new Error('--host must be claude or codex');
}

export function globalFile(host, env = process.env, home = homedir()) {
  return join(hostDir(host, env, home), host === 'claude' ? 'CLAUDE.md' : 'AGENTS.md');
}

// Which hosts to wire: the one this skill was installed under, else every host present.
export function detectHosts(scriptPath, env = process.env, home = homedir()) {
  const p = scriptPath.split(sep).join('/');
  if (p.includes('/.codex/skills/')) return ['codex'];
  if (p.includes('/.claude/skills/')) return ['claude'];
  const found = ['claude', 'codex'].filter(h => existsSync(hostDir(h, env, home)));
  return found.length ? found : ['claude'];
}

// ----------------------------------------------------------------- blocks ----
// One fenced block per skill in the host's global instruction file. Text outside the
// markers is never touched; re-running replaces the block in place.
export function fence(skill) {
  return { start: `<!-- jtl:${skill}:start, written by the ${skill} skill setup, re-run setup to replace -->`, end: `<!-- jtl:${skill}:end -->` };
}

export function mergeBlock(existing, block, skill) {
  const { start, end } = fence(skill);
  const body = `${start}\n${block.trim()}\n${end}\n`;
  if (existing == null || existing === '') return body;
  const s = existing.indexOf(start.split(',')[0]), e = existing.indexOf(end);
  if (s > -1 && e > s) return existing.slice(0, s) + body.trimEnd() + existing.slice(e + end.length);
  if (s > -1 || e > -1) throw new Error(`found one jtl:${skill} marker without the other; fix ${skill} block by hand`);
  return existing.replace(/\s*$/, '\n\n') + body;
}

export function removeBlock(existing, skill) {
  const { start, end } = fence(skill);
  if (!existing) return existing;
  const s = existing.indexOf(start.split(',')[0]), e = existing.indexOf(end);
  if (s < 0 || e < s) return existing;
  const before = existing.slice(0, s).replace(/\s*$/, ''), after = existing.slice(e + end.length).replace(/^\s*/, '');
  const rest = [before, after].filter(Boolean).join('\n\n');
  return rest ? rest.replace(/\s*$/, '\n') : '';
}

export function hasBlock(text, skill) {
  const { start, end } = fence(skill);
  return !!text && text.includes(start.split(',')[0]) && text.includes(end);
}

// ---------------------------------------------------------------- process ----
export function which(cmd, env = process.env) {
  const r = IS_WIN ? spawnSync('where', [cmd], { encoding: 'utf8', env }) : spawnSync('sh', ['-c', `command -v "${cmd}"`], { encoding: 'utf8', env });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

// On Windows, CLIs like claude, codex, npm and npx are .cmd files that need a shell; a shell
// joins arguments with spaces, so each one is quoted. An absolute .exe path runs without one.
export function spawnPortable(cmd, args, opts = {}, isWin = IS_WIN) {
  const shell = isWin && !/\.exe$/i.test(cmd);
  if (!shell) return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  const q = (s) => /[\s"&|<>^()%!]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s);
  return spawnSync([cmd, ...args].map(q).join(' '), { encoding: 'utf8', shell: true, ...opts });
}

export function run(cmd, args, opts = {}) {
  const r = spawnPortable(cmd, args, { timeout: 120000, ...opts });
  return { code: r.status ?? 1, out: (r.stdout || '').trim(), err: (r.stderr || r.error?.message || '').trim() };
}

// -------------------------------------------------------------- secrets ----
// A key reaches the skill from the clipboard or a hidden prompt, never from a command line,
// so the agent driving the setup never sees it.
export function readClipboard() {
  const tries = IS_WIN ? [['powershell', ['-NoProfile', '-Command', 'Get-Clipboard']]]
    : process.platform === 'darwin' ? [['pbpaste', []]]
    : [['wl-paste', ['-n']], ['xclip', ['-o', '-selection', 'clipboard']], ['xsel', ['-ob']]];
  for (const [c, a] of tries) {
    const r = spawnSync(c, a, { encoding: 'utf8' });
    if (r.status === 0) return (r.stdout || '').trim();
  }
  return '';
}

export function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new Error('no terminal for a hidden prompt'));
    stdout.write(question);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let v = '';
    const done = (err) => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', on); stdout.write('\n'); err ? reject(err) : resolve(v.trim()); };
    const on = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') return done();
        if (c === '\u0003') return done(new Error('cancelled'));
        if (c === '\u007f' || c === '\b') v = v.slice(0, -1); else v += c;
      }
    };
    stdin.on('data', on);
  });
}

export function promptLine(question, fallback = '') {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(fallback);
    process.stdout.write(question);
    process.stdin.resume(); process.stdin.setEncoding('utf8');
    process.stdin.once('data', d => { process.stdin.pause(); resolve(String(d).trim() || fallback); });
  });
}

// Never print a secret: show its shape only.
export function mask(s) {
  if (!s) return '(none)';
  return `${s.slice(0, 4)}...${s.length} chars`;
}

// ------------------------------------------------------------------ args ----
export function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

// --------------------------------------------------------------- doctor ----
// A doctor row: ok true/false/null (null = optional, not wired), plus the exact fix.
export function printRows(rows, json = false) {
  if (json) { console.log(JSON.stringify(rows, null, 2)); return; }
  for (const r of rows) {
    const mark = r.ok === true ? 'ok  ' : r.ok === false ? 'FIX ' : 'opt ';
    console.log(`  ${mark} ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
    if (r.ok !== true && r.fix) console.log(`        fix: ${r.fix}`);
  }
  const red = rows.filter(r => r.ok === false).length;
  console.log(red ? `\n${red} to fix.` : '\nAll required items are green.');
}
