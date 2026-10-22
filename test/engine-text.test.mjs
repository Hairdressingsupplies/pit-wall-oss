// test/engine-text.test.mjs — engine-dependent page wording; Claude's must stay exactly as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { permissionText, newMessagePlaceholder } from '../public/engine-text.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('permission card: Claude wording unchanged, Codex says it is Codex and that "always" runs outside the sandbox', () => {
  assert.deepEqual(permissionText('Bash'), { heading: 'Claude wants to use Bash', alwaysTitle: 'Adds an allow rule to this folder’s local Claude settings' });
  assert.deepEqual(permissionText('Bash', true), { heading: 'Codex wants to use Bash', alwaysTitle: 'Allow this for the rest of this chat (runs outside the sandbox)' });
});

test('New session placeholder names the engine picked; the Claude one is index.html\'s own', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const claude = /name="message"[^>]*placeholder="([^"]*)"/.exec(html)[1];
  assert.match(claude, /^What should Claude work on\?/);
  assert.equal(newMessagePlaceholder(claude, false), claude);
  assert.equal(newMessagePlaceholder(claude, true), claude.replace('Claude', 'Codex'));
});

test('every module the page imports is served (server.mjs STATIC)', () => {
  const server = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');
  const served = new Set([...server.matchAll(/'\/([\w-]+\.js)': \['/g)].map(m => m[1]));
  for (const f of fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.js'))) {
    for (const m of fs.readFileSync(path.join(ROOT, 'public', f), 'utf8').matchAll(/from '\.\/([\w-]+\.js)'/g)) assert.ok(served.has(m[1]), `${f} imports ${m[1]}, which the server doesn't serve`);
  }
});

test('engine-text.js is soft-loaded (a server from before it existed 404s it until restart), the fallback is the Claude wording', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.doesNotMatch(app, /^import[^;]*from '\.\/engine-text\.js'/m, 'no static import: a 404 would stop the whole page');
  assert.match(app, /await import\('\.\/engine-text\.js'\)\.catch\(/);
  const claude = permissionText('X');
  assert.ok(app.includes("heading: `Claude wants to use ${toolName}`"), 'fallback heading = Claude wording');
  assert.ok(app.includes(`alwaysTitle: '${claude.alwaysTitle}'`), 'fallback tooltip = Claude wording');
  assert.match(app, /newMessagePlaceholder: claudePlaceholder => claudePlaceholder,/);
  // dynamic imports must be served too
  const server = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');
  for (const m of app.matchAll(/import\('\.\/([\w-]+\.js)'\)/g)) assert.ok(server.includes(`'/${m[1]}': ['${m[1]}'`), `${m[1]} not served`);
});

test('Codex panel steps: nothing installed → only Install offered; Turn on is always there', async () => {
  const { codexSteps } = await import('../public/engine-text.js');
  const steps = codexSteps({ enabled: false, installed: false, install: { running: false } }, null);
  assert.deepEqual(steps.map(s => s.id), ['install', 'signin', 'sandbox', 'check', 'enable']);
  assert.deepEqual(steps.map(s => s.done), [false, false, false, false, false]);
  assert.equal(steps[0].action.id, 'install');
  assert.equal(steps[0].action.label, 'Install Codex');
  assert.deepEqual(steps.slice(1, 4).map(s => s.action), [null, null, null], 'nothing to sign in to before installing');
  assert.equal(steps[4].action.label, 'Turn Codex on');
  assert.match(steps[4].detail, /Claude only/);
});

test('Codex panel steps: installed, signed in, read-only sandbox, newer Codex out', async () => {
  const { codexSteps } = await import('../public/engine-text.js');
  const setup = { enabled: true, installed: true, version: '0.161.0', latest: '0.162.0', updateAvailable: true, install: { running: false }, check: null };
  const [install, signin, sandbox, check, enable] = codexSteps(setup, { installed: true, signedIn: true, email: 'r@x', plan: 'plus', sandbox: 'notConfigured' });
  assert.equal(install.done, true);
  assert.match(install.detail, /0\.161\.0.*0\.162\.0/);
  assert.equal(install.action.label, 'Update Codex');
  assert.deepEqual([signin.done, signin.detail, signin.action], [true, 'Signed in as r@x (Plus)', null]);
  assert.equal(sandbox.done, false);
  assert.match(sandbox.detail, /read-only mode — every file edit asks you/i);
  assert.equal(sandbox.action.id, 'sandbox');
  assert.equal(check.action.label, 'Check now');
  assert.equal(enable.action.label, 'Turn Codex off');
});

test('Codex panel steps: sandbox ready and checked; a failed check says what leaked; remote hides PC-only buttons', async () => {
  const { codexSteps } = await import('../public/engine-text.js');
  const good = { ok: true, mode: 'workspace-write', writesInside: true, writesOutsideBlocked: true, networkBlocked: true, at: '2026-10-08T10:00:00Z' };
  const setup = { enabled: true, installed: true, version: '0.161.0', latest: '0.161.0', install: { running: false }, check: good };
  const status = { installed: true, signedIn: false, sandbox: 'ready' };
  let [, signin, sandbox, check] = codexSteps(setup, status);
  assert.equal(sandbox.done, true);
  assert.match(sandbox.detail, /sandbox ready/i);
  assert.equal(check.done, true);
  assert.equal(signin.action.id, 'login');
  [, signin] = codexSteps({ ...setup, remote: true }, status);
  assert.equal(signin.action, null);
  assert.match(signin.detail, /at the PC/);
  const leaky = { ...good, ok: false, writesOutsideBlocked: false, networkBlocked: false };
  [, , , check] = codexSteps({ ...setup, check: leaky }, status);
  assert.equal(check.done, false);
  assert.match(check.detail, /outside the chat.s folder/);
  assert.match(check.detail, /internet/);
  [, , sandbox] = codexSteps(setup, { ...status, sandbox: 'updateRequired' });
  assert.match(sandbox.detail, /set up again/);
});

test('Codex update line: only when the installed Codex is older than the latest', async () => {
  const { codexUpdateText } = await import('../public/engine-text.js');
  assert.equal(codexUpdateText(null), null);
  assert.equal(codexUpdateText({ codexInstalled: '0.161.0', codexLatest: '0.161.0' }), null);
  assert.equal(codexUpdateText({ codexInstalled: '0.161.0', codexLatest: null }), null);
  assert.match(codexUpdateText({ codexInstalled: '0.161.0', codexLatest: '0.162.0' }), /Codex 0\.162\.0 is out \(you have 0\.161\.0\)/);
});

test('Codex panel steps: while an install runs, sign-in and sandbox wait for it; a found-nothing install says so', async () => {
  const { codexSteps } = await import('../public/engine-text.js');
  const setup = { enabled: false, installed: true, version: '0.161.0', install: { running: true } };
  const [install, signin, sandbox, check] = codexSteps(setup, { installed: true, signedIn: false, sandbox: null, installing: true });
  assert.equal(install.busy, true);
  assert.equal(install.action, null);
  assert.deepEqual([signin.detail, signin.action, sandbox.detail, sandbox.action, check.action], ['After installing.', null, 'After installing.', null, null]);
  const lost = codexSteps({ installed: false, install: { running: false, error: "Installed, but Pit Wall can't find codex.exe — set PITWALL_CODEX_EXE to its full path." } }, null)[0];
  assert.match(lost.detail, /can't find codex\.exe/);
});

test('branchState: Claude always "claude"; Codex branches only with a live run that says so', async () => {
  const { branchState } = await import('../public/engine-text.js');
  assert.equal(branchState({ engine: 'claude' }, { codexBranching: undefined }), 'claude');
  assert.equal(branchState({}, null), 'claude');
  assert.equal(branchState({ engine: 'codex' }, { codexBranching: true }), 'codex');
  assert.equal(branchState({ engine: 'codex' }, { codexBranching: false }), 'codex-nobranch');
  assert.equal(branchState({ engine: 'codex' }, null), 'codex-nobranch');
  assert.equal(branchState(undefined, { engine: 'codex', codexBranching: true }), 'codex');
});

test('page: nobranch CSS hides rewind/fork, Codex stays tidy; Rewind row not hidden for branching Codex', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
  assert.match(css, /#chat\.codex-nobranch \.msg\.user:not\(\.queued\) \.msg-actions/);
  assert.match(css, /#chat\.engine-codex #tasks \.task \.link/);
  assert.doesNotMatch(css, /#chat\.engine-codex \.msg/);
});
