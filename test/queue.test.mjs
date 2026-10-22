import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDb } from '../src/db.mjs';
import { Queue, usageGate, JOB_BLOCKS, wrapJobPrompt } from '../src/queue.mjs';
import { userSettings } from '../src/config.mjs';

const CFG = { dailyJobCap: 2, fiveHourMax: 0.6, weekMax: 0.8, maxAgeMin: 30 };
const fresh = (five, week) => ({ capturedAt: new Date().toISOString(), unifiedWindows: { five_hour: { utilization: five }, seven_day: { utilization: week } } });

function fakeRunner() {
  const runs = new Map();
  let n = 0;
  return {
    started: [],
    start(opts) { const id = `s${++n}`; this.started.push(opts); runs.set(id, { status: 'busy', items: [], pending: [] }); return id; },
    get: id => runs.get(id) ?? null,
    publicRun: r => ({ status: r.status, pending: r.pending, error: r.error ?? null }),
    stop(id) { runs.get(id).status = 'stopped'; },
    runs,
  };
}

test('usage gate: needs a fresh reading and stays under both limits', () => {
  assert.equal(usageGate(null, CFG).needsReading, true);
  assert.equal(usageGate({ ...fresh(0.1, 0.1), capturedAt: new Date(Date.now() - 45 * 60_000).toISOString() }, CFG).needsReading, true);
  assert.match(usageGate(fresh(0.65, 0.1), CFG).why, /5-hour usage 65%/);
  assert.match(usageGate(fresh(0.1, 0.85), CFG).why, /weekly usage 85%/);
  assert.equal(usageGate(fresh(0.2, 0.3), CFG).ok, true);
});

test('queue starts one job at a time, with hard blocks, and records the result', () => {
  const store = openDb(':memory:');
  const runner = fakeRunner();
  let asked = 0;
  const q = new Queue({ store, runner, config: CFG, requestReading: () => { asked++; } });
  store.addQueueItem({ title: 'A', prompt: 'do a', cwd: 'C:/x' });
  store.addQueueItem({ title: 'B', prompt: 'do b', cwd: 'C:/x' });

  q.tick();
  assert.equal(runner.started.length, 0, 'no usage reading yet');
  assert.equal(asked, 1);

  store.set('rate', fresh(0.2, 0.3));
  q.tick();
  assert.equal(runner.started.length, 1);
  assert.deepEqual(runner.started[0].disallowedTools, JOB_BLOCKS);
  assert.equal(runner.started[0].permissionMode, 'auto');
  assert.match(runner.started[0].message, /Do not send emails[\s\S]*Task:\ndo a/);
  q.tick();
  assert.equal(runner.started.length, 1, 'waits for the running job');

  const run = runner.runs.get('s1');
  run.items.push({ kind: 'assistant', text: 'Report saved to analysis/x.md' });
  run.status = 'your_turn';
  q.tick();
  const a = store.queue().find(j => j.title === 'A');
  assert.equal(a.status, 'done');
  assert.equal(a.result, 'Report saved to analysis/x.md');
  assert.equal(runner.started.length, 2, 'next job started');
});

test('queue respects the daily cap, pausing, and a permission prompt shows as needs_you', () => {
  const store = openDb(':memory:');
  const runner = fakeRunner();
  const q = new Queue({ store, runner, config: { ...CFG, dailyJobCap: 1 } });
  store.set('rate', fresh(0.1, 0.1));
  store.addQueueItem({ title: 'A', prompt: 'a', cwd: 'C:/x' });
  store.addQueueItem({ title: 'B', prompt: 'b', cwd: 'C:/x' });
  q.tick();
  runner.runs.get('s1').pending = [{ toolName: 'Bash' }];
  q.tick();
  assert.equal(store.queue().find(j => j.title === 'A').status, 'needs_you');
  runner.runs.get('s1').pending = [];
  runner.runs.get('s1').status = 'your_turn';
  q.tick();
  assert.equal(runner.started.length, 1, 'daily cap of 1 reached');
  assert.match(q.status().why, /Daily limit/);
  store.set('queueEnabled', false);
  q.tick();
  assert.equal(q.status().why, 'Paused by you');
});

test('role agents are off by default and queue themselves when due', () => {
  const store = openDb(':memory:');
  const runner = fakeRunner();
  const q = new Queue({ store, runner, config: CFG });
  const id = store.addRole({ name: 'Ads watcher', goal: 'Check wasted spend', cwd: 'C:/x', everyHours: 24 });
  q.tick();
  assert.equal(store.queue().length, 0, 'disabled by default');
  store.updateRole(id, { enabled: 1 });
  q.tick();
  assert.equal(store.queue().filter(j => j.role_id === id).length, 1);
  q.tick();
  assert.equal(store.queue().filter(j => j.role_id === id).length, 1, 'not queued twice');
  assert.match(wrapJobPrompt('x', { roleName: 'Ads watcher', previous: 'last time: fine' }), /"Ads watcher" agent[\s\S]*last time: fine/);
});

test('job blocks cover Bash and PowerShell anywhere in the command, plus Chrome and search reindex', () => {
  for (const c of ['git push', 'ssh ', 'deploy.sh', 'wrangler deploy']) {
    assert.ok(JOB_BLOCKS.includes(`Bash(*${c}*)`), `Bash ${c}`);
    assert.ok(JOB_BLOCKS.includes(`PowerShell(*${c}*)`), `PowerShell ${c}`);
  }
  assert.ok(JOB_BLOCKS.includes('mcp__claude-in-chrome'));
  assert.ok(JOB_BLOCKS.includes('mcp__claude_ai_Gmail__send_message'));
});

test('job prompts: unchanged for the owner, named for a teammate', () => {
  const user = userSettings({}, {}, { owner: 'Sam' });
  const liveSystems = 'Shopify/Stripe';
  const owner = wrapJobPrompt('do x', { user, liveSystems }) + '\n=====\n' + wrapJobPrompt('do y', { roleName: 'Ads', previous: 'fine', user, liveSystems });
  assert.equal(owner, fs.readFileSync(new URL('./fixtures/job-prompt-owner.txt', import.meta.url), 'utf8'));
  const lee = wrapJobPrompt('do y', { roleName: 'Ads', user: { name: 'Lee' }, liveSystems: null }) + wrapJobPrompt('do x', { user: { name: 'Lee' }, liveSystems: null });
  assert.doesNotMatch(lee, /Sam|Shopify/);
  assert.match(lee, /Lee's "Ads" agent/);
  assert.match(lee, /live production account/);
});

test('a codex job is gated on the codex reading and starts with engine codex', () => {
  const store = openDb(':memory:');
  store.set('codexEnabled', true);
  const runner = fakeRunner();
  const asked = [];
  const q = new Queue({ store, runner, config: CFG, requestReading: e => asked.push(e) });
  store.set('defaultEngine', 'codex');
  store.set('rate', fresh(0.95, 0.1));       // Claude nearly out — must not matter
  store.addQueueItem({ title: 'A', prompt: 'do a', cwd: 'C:/x', model: 'sonnet' });
  q.tick();
  assert.equal(runner.started.length, 0, 'no codex reading yet');
  assert.deepEqual(asked, ['codex']);
  store.set('rate_codex', fresh(0.1, 0.1));
  q.tick();
  assert.equal(runner.started.length, 1);
  assert.equal(runner.started[0].engine, 'codex');
  assert.equal(runner.started[0].model, null, 'a Claude model is dropped for a Codex job');
  assert.deepEqual(runner.started[0].disallowedTools, JOB_BLOCKS);
});

test('a claude job is still gated on the claude reading when codex is the default', () => {
  const store = openDb(':memory:');
  store.set('codexEnabled', true);
  const runner = fakeRunner();
  const q = new Queue({ store, runner, config: CFG });
  store.set('defaultEngine', 'codex');
  store.set('rate', fresh(0.95, 0.1));
  store.set('rate_codex', fresh(0.1, 0.1));
  store.addQueueItem({ title: 'B', prompt: 'do b', cwd: 'C:/x', engine: 'claude' });
  q.tick();
  assert.equal(runner.started.length, 0);
  assert.match(q.status().why, /5-hour usage 95%/);
});

test('the job chat records its engine, and the config default model is Claude-only', () => {
  const store = openDb(':memory:');
  store.set('codexEnabled', true);
  const runner = fakeRunner();
  const q = new Queue({ store, runner, config: { ...CFG, defaultModel: 'sonnet' } });
  store.set('rate_codex', fresh(0.1, 0.1));
  store.addQueueItem({ title: 'A', prompt: 'a', cwd: 'C:/x', engine: 'codex' });
  q.tick();
  assert.equal(runner.started[0].model, null);
  assert.equal(store.sessionMeta('s1').engine, 'codex');
});

test('a codex model valid for codex is kept', () => {
  const store = openDb(':memory:');
  store.set('codexEnabled', true);
  const runner = fakeRunner();
  const q = new Queue({ store, runner, config: CFG });
  store.set('rate_codex', fresh(0.1, 0.1));
  store.set('codexModels', [{ id: 'gpt-6.1-sol' }]);
  store.addQueueItem({ title: 'A', prompt: 'a', cwd: 'C:/x', engine: 'codex', model: 'gpt-6.1-sol' });
  q.tick();
  assert.equal(runner.started[0].model, 'gpt-6.1-sol');
});

test('enqueueRole copies the role engine; NULL stays NULL', () => {
  const store = openDb(':memory:');
  const q = new Queue({ store, runner: fakeRunner(), config: CFG });
  for (const [name, engine] of [['cx', 'codex'], ['dflt', null]]) {
    const id = store.addRole({ name, goal: 'g', cwd: 'C:/x', engine });
    q.enqueueRole(store.role(id));
  }
  const items = store.queue({ limit: 10 });
  assert.deepEqual(items.map(i => i.engine).sort((a, b) => String(a).localeCompare(String(b))), ['codex', null]);
});

test('a signed-out codex reading is retried at most every 5 minutes, and the why says so', async () => {
  const store = openDb(':memory:');
  store.set('codexEnabled', true);
  const runner = fakeRunner();
  let t = Date.parse('2026-10-08T10:00:00Z');
  let asked = 0;
  const q = new Queue({ store, runner, config: CFG, now: () => new Date(t),
    requestReading: e => { asked++; return Promise.resolve({ signedIn: false, rate: null }); } });
  store.addQueueItem({ title: 'A', prompt: 'a', cwd: 'C:/x', engine: 'codex' });
  q.tick();
  await new Promise(r => setImmediate(r));
  assert.equal(asked, 1);
  q.tick();
  assert.equal(asked, 1, 'backed off');
  assert.match(q.status().why, /Codex is not signed in/);
  t += 4 * 60_000; q.tick();
  assert.equal(asked, 1);
  t += 2 * 60_000; q.tick();
  assert.equal(asked, 2, 'retried after 5 minutes');
});

test('Codex off: a codex job and a codex default both run on Claude, and no Codex reading is ever asked for', () => {
  const store = openDb(':memory:');
  const runner = fakeRunner();
  const asked = [];
  const q = new Queue({ store, runner, config: { ...CFG, defaultModel: 'sonnet' }, requestReading: e => asked.push(e) });
  store.set('defaultEngine', 'codex');
  store.set('rate', fresh(0.1, 0.1));
  store.set('rate_codex', fresh(0.1, 0.1));
  const role = store.addRole({ name: 'cx', goal: 'g', cwd: 'C:/x', engine: 'codex' });
  store.addQueueItem({ title: 'A', prompt: 'a', cwd: 'C:/x', engine: 'codex', model: 'gpt-6.1-sol', roleId: role });
  q.tick();
  assert.equal(runner.started.length, 1);
  assert.equal(runner.started[0].engine, 'claude');
  assert.equal(runner.started[0].model, 'sonnet', 'a GPT model is dropped for the Claude run');
  assert.ok(!asked.includes('codex'));
});

test('while Codex is being installed a codex job stays queued (not failed) and a Claude job can still run', () => {
  const store = openDb(':memory:');
  store.set('codexEnabled', true);
  const runner = fakeRunner();
  let blocked = 'Codex is being updated — try again in a minute.';
  runner.codexBlocked = () => blocked;
  const q = new Queue({ store, runner, config: CFG });
  store.set('rate', fresh(0.1, 0.1));
  store.set('rate_codex', fresh(0.1, 0.1));
  const cx = store.addQueueItem({ title: 'A', prompt: 'a', cwd: 'C:/x', engine: 'codex' });
  q.tick();
  assert.equal(runner.started.length, 0);
  assert.equal(store.queueItem(cx).status, 'queued');
  assert.equal(q.status().why, 'Waiting for the Codex install');
  store.addQueueItem({ title: 'B', prompt: 'b', cwd: 'C:/x', engine: 'claude' });
  q.tick();
  assert.equal(runner.started.length, 1);
  assert.equal(runner.started[0].engine, 'claude', 'the Claude job went ahead of the waiting Codex one');
  runner.runs.get('s1').status = 'stopped';
  blocked = null;
  q.tick(); q.tick();
  assert.ok(runner.started.some(s => s.engine === 'codex'), 'the Codex job runs once the install is over');
});
