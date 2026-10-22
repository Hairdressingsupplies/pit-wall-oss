// test/codex-setup.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCommand, npmViewCommand, sandboxSetupCommand, loginCommand, parseCodexVersion, isNewer, enableCodexLocal, sandboxCheck }
  from '../src/codex-setup.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex.mjs');
const decode = b64 => Buffer.from(b64, 'base64').toString('utf16le');

test('install runs npm through cmd.exe with fixed arguments on Windows', () => {
  assert.deepEqual(installCommand('win32'), { file: 'cmd.exe', args: ['/d', '/s', '/c', 'npm i -g @openai/codex@latest'] });
  assert.deepEqual(installCommand('linux'), { file: 'npm', args: ['i', '-g', '@openai/codex@latest'] });
  assert.deepEqual(npmViewCommand('win32'), { file: 'cmd.exe', args: ['/d', '/s', '/c', 'npm view @openai/codex version'] });
});

test('sandbox setup opens an elevated PowerShell that stays open and runs codex sandbox setup', () => {
  const exe = "C:\\Users\\O'Neil\\App Data\\codex.exe";
  const c = sandboxSetupCommand(exe);
  assert.equal(c.file, 'powershell.exe');
  const outer = c.args[c.args.indexOf('-Command') + 1];
  assert.match(outer, /^Start-Process powershell\.exe -Verb RunAs -ArgumentList '-NoProfile','-NoExit','-EncodedCommand','[A-Za-z0-9+/=]+'$/);
  const inner = decode(outer.match(/'-EncodedCommand','([^']+)'/)[1]);
  assert.ok(inner.startsWith("& 'C:\\Users\\O''Neil\\App Data\\codex.exe' sandbox setup --elevated --current-user"), inner);
});

test('sign-in opens codex login in its own window', () => {
  const c = loginCommand('C:\\x\\codex.exe');
  assert.deepEqual(c, { file: 'cmd.exe', args: ['/c', 'start', '"Sign in to Codex"', '"C:\\x\\codex.exe"', 'login'], verbatim: true });
});

test('versions: read from `codex --version`, compared numerically', () => {
  assert.equal(parseCodexVersion('codex-cli 0.161.0\n'), '0.161.0');
  assert.equal(parseCodexVersion('0.162.1-alpha.2'), '0.162.1-alpha.2');
  assert.equal(parseCodexVersion('nope'), null);
  assert.equal(isNewer('0.162.0', '0.161.0'), true);
  assert.equal(isNewer('0.161.10', '0.161.9'), true);
  assert.equal(isNewer('0.161.0', '0.161.0'), false);
  assert.equal(isNewer('0.160.0', '0.161.0'), false);
  assert.equal(isNewer(null, '0.161.0'), false);
  assert.equal(isNewer('0.162.0', null), false);
});

test('local.json: yes to Codex sets codexEnabled true even over an old false, keeping everything else', () => {
  assert.deepEqual(enableCodexLocal({ name: 'Lee', codexEnabled: false }), { name: 'Lee', codexEnabled: true });
  assert.deepEqual(enableCodexLocal({}), { codexEnabled: true });
});

const tmpBase = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-sbx-')), 'check');
const run = (mode, base = tmpBase()) => ({ base, p: sandboxCheck({ exe: process.execPath, preArgs: [FAKE], env: { ...process.env, FAKE_CODEX: mode }, base, timeoutMs: 5000 }) });

test('sandbox check: a ready sandbox that enforces workspace-write passes all three probes, and cleans up', async () => {
  const { base, p } = run('ok');
  const r = await p;
  assert.equal(r.readiness, 'ready');
  assert.equal(r.mode, 'workspace-write');
  assert.deepEqual([r.writesInside, r.writesOutsideBlocked, r.networkBlocked, r.ok], [true, true, true, true]);
  assert.ok(!fs.existsSync(base), 'probe folder removed');
});

test('sandbox check: not set up → checked under the unelevated read-only sandbox the bridge would use', async () => {
  const r = await run('sandbox-unset').p;
  assert.equal(r.readiness, 'notConfigured');
  assert.equal(r.mode, 'read-only');
  // The fake only enforces anything when started with -c windows.sandbox="unelevated", as Codex 0.161 does.
  assert.deepEqual([r.writesInside, r.writesOutsideBlocked, r.networkBlocked, r.ok], [false, true, true, false]);
});

test('sandbox check: a "ready" sandbox that lets writes and network through is reported, not ok', async () => {
  const r = await run('sandbox-leaky').p;
  assert.equal(r.mode, 'workspace-write');
  assert.deepEqual([r.writesInside, r.writesOutsideBlocked, r.networkBlocked, r.ok], [true, false, false, false]);
});

test('sandbox check: not installed, or an app-server that never answers', async () => {
  const none = await sandboxCheck({ exe: null });
  assert.equal(none.ok, false);
  assert.match(none.error, /isn.t installed/);
  const silent = await sandboxCheck({ exe: process.execPath, preArgs: ['-e', 'setInterval(() => {}, 1000)'], base: tmpBase(), timeoutMs: 300 });
  assert.equal(silent.ok, false);
  assert.ok(silent.error);
});

test('the write probe really writes when nothing stops it', async () => {
  const { writeProbe } = await import('../src/codex-setup.mjs');
  const { spawnSync } = await import('node:child_process');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-probe-')), 'a b.txt');
  const [cmd, ...args] = writeProbe(file);
  assert.equal(spawnSync(cmd, args).status, 0);
  assert.ok(fs.existsSync(file));
});

test('runTree: a timeout kills the whole process tree and only resolves once it is gone', async () => {
  const { runTree } = await import('../src/codex-setup.mjs');
  // A parent that starts a grandchild (both sleep forever); the grandchild prints its pid. Killing only the parent would leave it.
  const grand = "console.log(process.pid); setInterval(() => {}, 1000)";
  const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grand)}], { stdio: ['ignore', 'inherit', 'inherit'] }); setInterval(() => {}, 1000)`;
  const t = Date.now();
  const r = await runTree({ file: process.execPath, args: ['-e', parent] }, { timeoutMs: 1500 });
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t >= 1500);
  const pid = Number(r.out.trim().split(/\s+/)[0]);
  assert.ok(pid > 0, `grandchild pid printed: ${r.out}`);
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the grandchild was killed too');
});

test('runTree: a command that finishes in time reports its output', async () => {
  const { runTree } = await import('../src/codex-setup.mjs');
  const r = await runTree({ file: process.execPath, args: ['-e', "console.log('hi'); console.error('warn')"] }, { timeoutMs: 10_000 });
  assert.deepEqual([r.ok, r.timedOut, r.out, r.err], [true, false, 'hi', 'warn']);
  const bad = await runTree({ file: process.execPath, args: ['-e', 'process.exit(3)'] }, { timeoutMs: 10_000 });
  assert.deepEqual([bad.ok, bad.code], [false, 3]);
});

test('install is refused while Codex is in use, with a plain-English reason', async () => {
  const { installBlocker } = await import('../src/codex-setup.mjs');
  assert.equal(installBlocker({}), null);
  assert.match(installBlocker({ installing: true }), /already being installed/);
  assert.match(installBlocker({ codexChats: 2 }), /2 Codex chats are running/);
  assert.match(installBlocker({ codexChats: 1 }), /a Codex chat is running/i);
  assert.match(installBlocker({ checking: true }), /sandbox check/);
  assert.match(installBlocker({ statusReads: 1 }), /checking Codex.*moment/i);
});

test('after an install: npm failed, or it worked but codex.exe still can\'t be found', async () => {
  const { installOutcome } = await import('../src/codex-setup.mjs');
  assert.equal(installOutcome({ ok: true, out: '', err: '' }, true), null);
  assert.match(installOutcome({ ok: true, out: '', err: '' }, false), /Installed, but Pit Wall can.t find codex\.exe — set PITWALL_CODEX_EXE/);
  assert.match(installOutcome({ ok: false, timedOut: true, out: '', err: '' }, false), /took longer than 5 minutes/);
  assert.match(installOutcome({ ok: false, out: '', err: 'npm ERR! code EBUSY' }, true), /in use/);
});

test('PC-only and installed guards for the sign-in / sandbox routes', async () => {
  const { codexRouteGuard } = await import('../src/codex-setup.mjs');
  assert.deepEqual(codexRouteGuard({ remote: true, installed: true, pcOnly: true, what: 'Set up the Codex sandbox' }), { status: 403, error: 'Set up the Codex sandbox at the PC.' });
  assert.deepEqual(codexRouteGuard({ remote: false, installed: false }), { status: 400, error: "Codex isn't installed on this PC." });
  assert.deepEqual(codexRouteGuard({ remote: true, installed: false, pcOnly: false }), { status: 400, error: "Codex isn't installed on this PC." });
  assert.equal(codexRouteGuard({ remote: true, installed: true, pcOnly: false }), null, 'the check may run from a phone');
  assert.deepEqual(codexRouteGuard({ remote: false, installed: true, installing: true }), { status: 409, error: 'Codex is being installed — try again when it has finished.' });
  assert.equal(codexRouteGuard({ remote: false, installed: true }), null);
});

test('runTree: after the fallback reported stillRunning, the real exit is still reported (so "installing" can clear)', async () => {
  const { runTree } = await import('../src/codex-setup.mjs');
  let exited = null;
  const t = Date.now();
  // A kill that fails (killFn does nothing), a process that ends by itself 1.5 s later.
  const r = await runTree({ file: process.execPath, args: ['-e', 'setTimeout(() => {}, 1500)'] },
    { timeoutMs: 200, fallbackMs: 300, killFn: () => {}, onExit: code => { exited = { code, at: Date.now() - t }; } });
  assert.equal(r.stillRunning, true);
  assert.equal(exited, null, 'not exited yet when the fallback answered');
  for (let i = 0; i < 50 && !exited; i++) await new Promise(res => setTimeout(res, 100));
  assert.ok(exited, 'onExit called when the process really ended');
  assert.ok(exited.at >= 1400);
  let once = 0;
  await runTree({ file: process.execPath, args: ['-e', ''] }, { onExit: () => { once++; } });
  assert.equal(once, 1, 'a normal run reports its exit once too');
});
