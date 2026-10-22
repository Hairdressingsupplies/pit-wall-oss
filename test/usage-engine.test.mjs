// test/usage-engine.test.mjs — gauges, Usage tab and brief follow the default engine; Claude's figures stay as they were.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.mjs';
import { usageTop, weekByEngine, weekShares, tokensByEngine, claudeCacheShares } from '../src/insights.mjs';
import { gaugeView } from '../public/engine-text.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = (five, week) => ({ unifiedWindows: { five_hour: { utilization: five }, seven_day: { utilization: week } } });
const CL = { ...win(0.4, 0.2), capturedAt: 'c' }, GP = { ...win(0.1, 0.05), capturedAt: 'g' };

test('gaugeView: Codex default with a Codex reading shows GPT and puts Claude in other', () => {
  const v = gaugeView({ rate: CL, rateCodex: GP, burn: { n: 1 }, burnCodex: { n: 2 } }, 'codex');
  assert.deepEqual(v, { label: 'GPT', rate: GP, burn: { n: 2 }, other: { label: 'Claude', rate: CL } });
});

test('gaugeView: Claude default (or Codex without a reading yet) shows Claude and puts GPT in other', () => {
  assert.deepEqual(gaugeView({ rate: CL, rateCodex: GP, burn: { n: 1 } }, 'claude'), { label: '', rate: CL, burn: { n: 1 }, other: { label: 'GPT', rate: GP } });
  assert.deepEqual(gaugeView({ rate: CL, rateCodex: null, burn: null }, 'codex'), { label: '', rate: CL, burn: null, other: { label: 'GPT', rate: null } });
  assert.equal(gaugeView({}, 'codex').rate, null);
});

const row = (id, engine, fresh) => ({ id, name: id, engine, week: { fresh, out: 0, cacheRead: 0, turns: 1, screenshots: 0 }, source: 'closed', context: 0 });

test('usageTop: each row\'s share is of its own engine\'s total; totals split by engine', () => {
  const rows = [row('a', 'claude', 300), row('b', 'claude', 100), row('c', 'codex', 50), row('d', 'codex', 50), row('e', undefined, 100)];
  const { totals, top } = usageTop(rows);
  assert.deepEqual(totals, { claude: 500, codex: 100 });
  assert.deepEqual(weekByEngine(rows), totals);
  const by = Object.fromEntries(top.map(t => [t.id, t]));
  assert.equal(by.c.engine, 'codex');
  assert.equal(by.c.share, 0.5);
  assert.equal(by.a.share, 0.6);
  assert.equal(by.e.engine, 'claude');
});

test('usageTop: all-Claude rows share exactly as before (of the grand total)', () => {
  const { top } = usageTop([row('a', 'claude', 3), row('b', 'claude', 1)]);
  assert.deepEqual(top.map(t => t.share), [0.75, 0.25]);
});

test('weekShares: GPT never shrinks the Claude session or project bars; projects follow the default engine', () => {
  const rows = [{ ...row('a', 'claude', 300), projectId: 1 }, { ...row('b', 'claude', 100), projectId: 2 }, { ...row('c', 'codex', 900), projectId: 1 }];
  const cl = weekShares(rows, 'claude');
  assert.equal(cl.session.get('a'), 0.75);
  assert.equal(cl.session.get('c'), 1);
  assert.deepEqual([...cl.project], [[1, 0.75], [2, 0.25]]);
  assert.deepEqual([...weekShares(rows, 'codex').project], [[1, 1]]);
  const only = weekShares(rows.slice(0, 2), 'claude');
  assert.deepEqual([only.session.get('a'), only.project.get(1)], [0.75, 0.75], 'Claude-only is unchanged');
});

// ── server: the brief and state ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-usage-engine-'));
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
  const db = openDb(path.join(dataDir, 'pitwall.db'));
  db.set('rate', CL);
  db.set('rate_codex', GP);
  db.set('defaultEngine', 'codex');
  const iso = m => new Date(Date.now() - m * 60_000).toISOString();
  db.addRateReading(iso(30), 0.1, 0.1, 9e9, 'codex');
  db.addRateReading(iso(5), 0.3, 0.1, 9e9, 'codex');
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
const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { cookie, 'content-type': 'application/json', origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('Codex off: brief and state are Claude\'s, whatever default is stored', async () => {
  const b = (await call('POST', '/api/brief', {})).body;
  assert.equal(b.rate.capturedAt, 'c');
  assert.equal(b.rateEngine, 'claude');
  const st = (await call('GET', '/api/state')).body;
  assert.equal(st.usage.burnCodex, null);
  assert.equal(st.usage.engine, 'claude');
  assert.deepEqual(st.usage.weekByEngine, { claude: 0, codex: 0 });
  const u = (await call('POST', '/api/usage', {})).body;
  assert.deepEqual(u.totals, { claude: 0, codex: 0 });
  assert.deepEqual(u.tokensEngine, { claude: 0, codex: 0 });
  assert.deepEqual(u.readingsCodex, []);
});

test('Codex on with Codex default: the brief carries GPT\'s reading and says so; state has burnCodex', async () => {
  await call('POST', '/api/codex/enable', { enabled: true });
  const b = (await call('POST', '/api/brief', {})).body;
  assert.equal(b.rateEngine, 'codex');
  assert.equal(b.rate.capturedAt, 'g');
  const st = (await call('GET', '/api/state')).body;
  assert.equal(st.usage.engine, 'codex');
  assert.ok(st.usage.burnCodex, 'burn comes from the Codex readings');
  assert.equal(st.usage.burn, null, 'Claude has no readings');
  assert.equal((await call('POST', '/api/usage', {})).body.readingsCodex.length, 2);
  await call('POST', '/api/settings', { defaultEngine: 'claude' });
  const b2 = (await call('POST', '/api/brief', {})).body;
  assert.equal(b2.rateEngine, 'claude');
  assert.equal(b2.rate.capturedAt, 'c');
});

test('tokensByEngine: raw tokens (fresh + written + re-read) per engine, the unit of the headline total', () => {
  const r = (engine, fresh, out, cacheRead, cost) => ({ id: engine + fresh, engine, week: { fresh, out, cacheRead, cost, turns: 1 } });
  const rows = [r('claude', 10, 5, 100, 999), r(undefined, 1, 1, 1, 50), r('codex', 20, 10, 200, 7)];
  assert.deepEqual(tokensByEngine(rows), { claude: 118, codex: 230 });
  assert.equal(tokensByEngine(rows).claude + tokensByEngine(rows).codex, 348, 'adds up to the headline tokens');
  assert.deepEqual(weekByEngine(rows), { claude: 1049, codex: 7 }, 'cost-weighted totals stay separate');
});

test('claudeCacheShares: the re-read tip is Claude-only; GPT rows never feed it; Claude-only is unchanged', () => {
  const r = (engine, fresh, cacheRead, cacheReadCost, cost) => ({ id: engine + cacheRead, engine, week: { fresh, out: 0, cacheRead, cacheReadCost, cost, turns: 1 } });
  const cl = [r('claude', 50, 50, 10, 100), r('claude', 0, 100, 20, 100)];
  assert.deepEqual(claudeCacheShares(cl), { cacheShare: 30 / 200, cacheTokenShare: 150 / 200 });
  assert.deepEqual(claudeCacheShares([...cl, r('codex', 0, 100000, 5000, 6000)]), claudeCacheShares(cl));
});
