// wire.mjs in a fake home: apply, doctor, Codex approval, remove, and the files it must never break.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyHost, removeHost, inspect, doctorRows, firstWin, codexTrusted, hookFile, hookCommand, SKILL_DIR } from '../scripts/wire.mjs';

// HOME only: CLAUDE_CONFIG_DIR, CODEX_HOME and HERMES_HOME are left out on purpose, or the test
// would wire the real hosts of whoever runs it.
function fakeHome({ codexHooks = null, claudeSettings = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wdym-wirehome-'));
  for (const d of ['.claude', '.codex', '.hermes/skills']) mkdirSync(join(home, d), { recursive: true });
  if (codexHooks) writeFileSync(join(home, '.codex', 'hooks.json'), codexHooks);
  if (claudeSettings) writeFileSync(join(home, '.claude', 'settings.json'), claudeSettings);
  const env = { HOME: home, PATH: process.env.PATH || '' };
  const cfgPath = join(home, 'cfg', 'config.json');
  mkdirSync(join(home, 'cfg'), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({ edition: 'public' }));
  const cfg = { path: cfgPath, raw: { edition: 'public' } };
  return { home, env, cfg };
}

const OTHER = { hooks: [{ type: 'command', command: 'deja-hook hook-prompt', timeout: 10 }] };

test('wire: apply links every host, appends the hook last, and keeps what was there', () => {
  const { home, env, cfg } = fakeHome({
    codexHooks: JSON.stringify({ hooks: { UserPromptSubmit: [OTHER], Stop: [OTHER] } }),
    claudeSettings: JSON.stringify({ model: 'x', hooks: { UserPromptSubmit: [OTHER] } }),
  });
  for (const h of ['claude', 'codex', 'hermes']) applyHost(h, cfg, { env, home });
  for (const h of ['claude', 'codex', 'hermes']) {
    const s = inspect(h, cfg, { env, home });
    assert.equal(s.linkState, 'ours', h);
    assert.equal(realpathSync(s.link), realpathSync(SKILL_DIR));
  }
  const codex = JSON.parse(readFileSync(hookFile('codex', env, home), 'utf8'));
  assert.equal(codex.hooks.UserPromptSubmit.length, 2);
  assert.deepEqual(codex.hooks.UserPromptSubmit[0], OTHER, 'the approved hook keeps index 0');
  assert.match(codex.hooks.UserPromptSubmit[1].hooks[0].command, /wdym\.mjs" hook --engine codex/);
  assert.deepEqual(codex.hooks.Stop, [OTHER]);
  const claude = JSON.parse(readFileSync(hookFile('claude', env, home), 'utf8'));
  assert.equal(claude.model, 'x');
  assert.doesNotMatch(claude.hooks.UserPromptSubmit[1].hooks[0].command, /--engine/);
  // idempotent
  for (const h of ['claude', 'codex']) applyHost(h, cfg, { env, home });
  assert.equal(JSON.parse(readFileSync(hookFile('codex', env, home), 'utf8')).hooks.UserPromptSubmit.length, 2);
});

test('wire: first win runs the exact host command and writes one read', () => {
  const { home, env, cfg } = fakeHome();
  for (const h of ['claude', 'codex']) {
    applyHost(h, cfg, { env, home });
    const w = firstWin(h, cfg, { env });
    assert.ok(w.ok, `${h}: ${w.detail}`);
  }
});

test('wire: doctor shows the Codex approval until config.toml records it', () => {
  const { home, env, cfg } = fakeHome({ codexHooks: JSON.stringify({ hooks: { UserPromptSubmit: [OTHER] } }) });
  applyHost('codex', cfg, { env, home });
  let row = doctorRows(cfg, { env, home, hosts: ['codex'] }).find(r => r.name === 'codex hook approved');
  assert.equal(row.ok, false); assert.match(row.fix, /approve/);
  const file = hookFile('codex', env, home);
  writeFileSync(join(home, '.codex', 'config.toml'), `[hooks.state."${file}:user_prompt_submit:1:0"]\ntrusted_hash = "sha256:abc"\n`);
  assert.equal(codexTrusted(env, home), true);
  row = doctorRows(cfg, { env, home, hosts: ['codex'] }).find(r => r.name === 'codex hook approved');
  assert.equal(row.ok, true);
  // approval for a different index is not ours
  writeFileSync(join(home, '.codex', 'config.toml'), `[hooks.state."${file}:user_prompt_submit:0:0"]\ntrusted_hash = "sha256:abc"\n`);
  assert.equal(codexTrusted(env, home), false);
});

test('wire: remove takes out only what apply added', () => {
  const { home, env, cfg } = fakeHome({ codexHooks: JSON.stringify({ hooks: { UserPromptSubmit: [OTHER] } }) });
  const mine = join(home, '.hermes', 'skills', 'other');
  mkdirSync(mine);
  for (const h of ['claude', 'codex', 'hermes']) applyHost(h, cfg, { env, home });
  for (const h of ['claude', 'codex', 'hermes']) removeHost(h, cfg, { env, home });
  assert.deepEqual(JSON.parse(readFileSync(hookFile('codex', env, home), 'utf8')).hooks.UserPromptSubmit, [OTHER]);
  for (const h of ['claude', 'codex', 'hermes']) assert.equal(inspect(h, cfg, { env, home }).linkState, 'missing');
  assert.ok(existsSync(mine));
});

test('wire: a host file that does not parse is never rewritten; a foreign skill dir is left alone', () => {
  const { home, env, cfg } = fakeHome({ codexHooks: '{ "hooks": { // a comment breaks strict JSON' });
  const before = readFileSync(hookFile('codex', env, home), 'utf8');
  const s = applyHost('codex', cfg, { env, home });
  assert.equal(s.hook, 'unreadable');
  assert.equal(readFileSync(hookFile('codex', env, home), 'utf8'), before);
  const row = doctorRows(cfg, { env, home, hosts: ['codex'] }).find(r => r.name === 'codex prompt hook');
  assert.equal(row.ok, false); assert.match(row.fix, /not valid JSON/);
  const other = join(home, '.claude', 'skills', 'wdym');
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  symlinkSync(home, other);
  applyHost('claude', cfg, { env, home });
  assert.equal(realpathSync(other), realpathSync(home));
  assert.ok(lstatSync(other).isSymbolicLink());
});

test('wire: pack glue means no second Claude hook, and doctor checks the glue', () => {
  const { home, env, cfg } = fakeHome();
  const glue = join(home, 'cfg', 'glue.py');
  writeFileSync(glue, 'WDYM = "/x/tools/wdym/core/scripts/wdym.mjs"\n');
  const pack = { ...cfg, raw: { wire: { claude: 'glue:glue.py', hermes_skills: '~/.hermes/skills/team' } } };
  const s = applyHost('claude', pack, { env, home });
  assert.equal(s.hook, 'glue');
  assert.equal(existsSync(hookFile('claude', env, home)), false, 'no settings.json written');
  assert.equal(doctorRows(pack, { env, home, hosts: ['claude'] }).find(r => r.name === 'claude prompt hook').ok, true);
  writeFileSync(glue, '# wdym taken out\n');
  assert.equal(doctorRows(pack, { env, home, hosts: ['claude'] }).find(r => r.name === 'claude prompt hook').ok, false);
  applyHost('hermes', pack, { env, home });
  assert.ok(existsSync(join(home, '.hermes', 'skills', 'team', 'wdym', 'SKILL.md')));
});

test('wire: a relative --config becomes absolute in the hook command', () => {
  const cmd = hookCommand('codex', { path: 'packs/team/config.json', raw: {} }, { explicitConfig: true });
  const m = cmd.match(/--config "([^"]+)"/);
  assert.ok(m && m[1].startsWith('/') || /^[A-Za-z]:\\/.test(m?.[1] || ''), cmd);
});
