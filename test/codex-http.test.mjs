// test/codex-http.test.mjs — the Codex opt-in routes and state, against a real server on a random port.
// Empty temp data/Claude-home/workspace, Codex and Claude pointed at files that don't exist (so nothing can start either),
// no relays, Queue/Agents off. Never port 4040; the server is killed in after().
// It never sends a valid POST /api/codex/install (that would run a real global npm install).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-codex-http-'));
let srv, base, cookie, log = '';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }).on('error', reject);
});

before(async () => {
  const port = await freePort();
  assert.notEqual(port, 4040);
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir);
  for (const d of ['claude-home', 'workspace']) fs.mkdirSync(path.join(tmp, d));
  // A Codex usage reading already stored (as on the owner's PC): with Codex off the page must not get it.
  const db = openDb(path.join(dataDir, 'pitwall.db'));
  db.set('rate_codex', { capturedAt: new Date().toISOString(), unifiedWindows: { five_hour: { utilization: 0.1 } } });
  db.set('defaultEngine', 'codex');
  // One chat per engine, for the fork route's reply-id check.
  db.upsertSession('cdx-chat', { cwd: path.join(tmp, 'workspace'), engine: 'codex' });
  db.upsertSession('cld-chat', { cwd: path.join(tmp, 'workspace'), engine: 'claude' });
  db.db.close();
  srv = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    PITWALL_PORT: String(port), PITWALL_DATA_DIR: dataDir, PITWALL_CLAUDE_HOME: path.join(tmp, 'claude-home'), PITWALL_WORKSPACE: path.join(tmp, 'workspace'),
    PITWALL_FOLDERS: '', PITWALL_CLAUDE_EXE: path.join(tmp, 'no-claude.exe'), PITWALL_CODEX_EXE: path.join(tmp, 'no-codex.exe'), APPDATA: path.join(tmp, 'appdata'),
    PITWALL_NO_RELAY: '1', PITWALL_AUTOMATION: '0', PITWALL_ROUNDUP: '0', PITWALL_CODEX: '' } });
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80 && !cookie; i++) {
    await new Promise(r => setTimeout(r, 250));
    try { const r = await fetch(base + '/'); if (r.ok) cookie = r.headers.get('set-cookie').split(';')[0]; } catch { /* not up yet */ }
  }
  assert.ok(cookie, `server did not start:\n${log}`);
});

after(() => {
  try { srv?.kill(); } catch { /* gone */ }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* db may still be closing */ }
});

const call = async (method, p, body, { origin = base } = {}) => {
  const headers = { cookie, 'content-type': 'application/json', ...(origin ? { origin } : {}) };
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('Codex off (the default): Claude only — no engines, no Codex gauge, no Codex update fields', async () => {
  const st = (await call('GET', '/api/state')).body;
  assert.deepEqual(st.options.engines, ['claude']);
  assert.equal(st.usage.rateCodex, null, 'the stored Codex reading is not sent');
  assert.equal(st.settings.codexEnabled, false);
  assert.equal(st.settings.defaultEngine, 'claude', 'a stored codex default is ignored while off');
  assert.equal(st.settings.codexInstalled, false, 'PITWALL_CODEX_EXE points at nothing');
  assert.ok(!st.update || (!('codexInstalled' in st.update) && !('codexLatest' in st.update)));
  const setup = (await call('GET', '/api/codex/setup')).body;
  assert.deepEqual([setup.enabled, setup.installed, setup.version], [false, false, null]);
});

test('not installed: sign-in, sandbox setup and the sandbox check answer 400', async () => {
  for (const p of ['/api/codex/login', '/api/codex/sandbox', '/api/codex/sandbox/check']) {
    const r = await call('POST', p, {});
    assert.equal(r.status, 400, p);
    assert.equal(r.body.error, "Codex isn't installed on this PC.");
  }
});

test('the new POSTs refuse a missing or foreign Origin (403)', async () => {
  for (const p of ['/api/codex/enable', '/api/codex/install', '/api/codex/sandbox', '/api/codex/sandbox/check', '/api/codex/login']) {
    for (const origin of [null, 'http://evil.example']) {
      const r = await call('POST', p, { enabled: true }, { origin });
      assert.equal(r.status, 403, `${p} origin=${origin}`);
      assert.equal(r.body.error, 'Bad origin');
    }
  }
  assert.equal((await call('GET', '/api/state')).body.settings.codexEnabled, false, 'nothing was switched on');
});

test('fork: a Codex chat takes a Codex item id as the reply, never a path; a Claude chat still needs a UUID', async () => {
  const fork = (id, atUuid) => call('POST', `/api/sessions/${id}/fork`, { message: 'again', atUuid });
  assert.equal((await fork('cdx-chat', '../x')).status, 400);
  assert.equal((await fork('cdx-chat', '--job')).status, 400, 'a leading dash would read as a bridge flag');
  assert.equal((await fork('cld-chat', 'm1')).status, 400);
  const ok = await fork('cdx-chat', 'm1');
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.match(ok.body.id, /^[0-9a-f-]{36}$/);
});

test('enable: 400 unless a boolean; true brings the engines back, false takes them away again', async () => {
  for (const bad of [{}, { enabled: 'yes' }, { enabled: 1 }, { enabled: null }]) assert.equal((await call('POST', '/api/codex/enable', bad)).status, 400, JSON.stringify(bad));
  assert.deepEqual((await call('POST', '/api/codex/enable', { enabled: true })).body, { enabled: true });
  let st = (await call('GET', '/api/state')).body;
  assert.deepEqual(st.options.engines, ['claude', 'codex']);
  assert.equal(st.settings.defaultEngine, 'codex', 'the stored default comes back');
  assert.ok(st.usage.rateCodex, 'the Codex gauge comes back');
  assert.deepEqual((await call('POST', '/api/codex/enable', { enabled: false })).body, { enabled: false });
  st = (await call('GET', '/api/state')).body;
  assert.deepEqual(st.options.engines, ['claude']);
  assert.equal(st.usage.rateCodex, null);
});

test('settings: groupByProject defaults on, takes only a boolean, and comes back in state', async () => {
  assert.equal((await call('GET', '/api/state')).body.settings.groupByProject, true, 'today’s project lanes stay the default');
  await call('POST', '/api/settings', { groupByProject: 'no' });
  assert.equal((await call('GET', '/api/state')).body.settings.groupByProject, true, 'a non-boolean is ignored');
  assert.equal((await call('POST', '/api/settings', { groupByProject: false })).status, 200);
  assert.equal((await call('GET', '/api/state')).body.settings.groupByProject, false);
  await call('POST', '/api/settings', { groupByProject: true });
  assert.equal((await call('GET', '/api/state')).body.settings.groupByProject, true);
});
