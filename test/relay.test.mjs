// Chats survive a server restart: real relay processes, a fake claude, two Runners standing in for two servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../src/runner.mjs';
import { relaySpawn, findRelays } from '../src/relay-client.mjs';

const FAKE = path.join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pw-relay-'));
// The Runner passes claude's flags; run them through node + the fake instead (the relay finds the id in them).
const spawnIn = dir => (exe, args, opts) => relaySpawn(dir)(process.execPath, [FAKE, ...args], opts);
const runnerIn = dir => new Runner({ claudeExe: 'claude', spawnFn: spawnIn(dir), killFn: async () => {} });

function until(fn, ms = 10_000) {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => { const v = fn(); if (v) return resolve(v); if (Date.now() > end) return reject(new Error('timed out')); setTimeout(tick, 25); };
    tick();
  });
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function adoptAll(runner, dir) {
  return findRelays(dir).map(({ id, meta, proc }) => {
    const r = runner.adopt({ ...meta, sessionId: id, proc });
    proc.connect({ timeoutMs: 2000 });
    return r;
  });
}

test('a chat carries on after its server goes away: approvals already given stay given, open ones stay open', async () => {
  const dir = newDir();
  const one = runnerIn(dir);
  const id = one.start({ cwd: dir, name: 'Relay test', model: 'sonnet', disallowedTools: ['Bash(ssh:*)'], message: 'hi' });
  await until(() => one.get(id).status === 'needs_you');
  const claudePid = one.get(id).pid;
  assert.ok(claudePid, 'claude pid comes from the relay');
  one.answer(id, 'r1', { behavior: 'allow' });
  await until(() => one.get(id).status === 'your_turn');
  one.send(id, 'second');
  await until(() => one.get(id).pending.has('r2'));
  const firstTs = one.get(id).items.find(i => i.kind === 'user').ts;

  await one.shutdown(); // the server stops: the chat must not
  await new Promise(r => setTimeout(r, 200));
  assert.ok(alive(claudePid), 'claude still running');

  const two = runnerIn(dir);
  const events = [];
  two.on('item', () => events.push('item'));
  two.on('run', run => events.push(run.status));
  const [r] = adoptAll(two, dir);
  await until(() => events.length);
  assert.deepEqual(events, ['needs_you'], 'one quiet run event after the replay, no replayed items');
  assert.deepEqual([...r.pending.keys()], ['r2'], 'r1 was answered before the restart');
  assert.equal(r.pid, claudePid);
  assert.ok(r.startedAt <= r.items.find(i => i.kind === 'user').ts && r.startedAt < new Date(Date.now() - 100).toISOString(),
    'started when the relay did (not at adoption), so transcript history and the replay do not overlap');
  assert.equal(r.model, 'sonnet');
  assert.deepEqual(r.disallowedTools, ['Bash(ssh:*)'], 'hard blocks survive adoption');
  assert.ok(Math.abs(Date.parse(r.items.find(i => i.kind === 'user').ts) - Date.parse(firstTs)) < 2000, 'replayed items keep their original times, not now');

  two.answer(id, 'r2', { behavior: 'allow' });
  await until(() => r.status === 'your_turn');
  assert.ok(r.items.some(i => i.text === 'done r2'));
  await two.stop(id);
  await until(() => !r.proc);
  await until(() => !fs.readdirSync(dir).some(f => f.startsWith(id)));
});

test('claude exits while no server is connected: the next server finds it finished, not cut off', async () => {
  const dir = newDir();
  const one = runnerIn(dir);
  const id = one.start({ cwd: dir, message: 'hi' });
  await until(() => one.get(id).status === 'needs_you');
  one.answer(id, 'r1', { behavior: 'allow' });
  await until(() => one.get(id).status === 'your_turn');
  one.send(id, 'exit');
  await one.shutdown();
  await until(() => !fs.existsSync(path.join(dir, `${id}.state.json`)) || !alive(JSON.parse(fs.readFileSync(path.join(dir, `${id}.state.json`))).relayPid));

  const two = runnerIn(dir);
  const [r] = adoptAll(two, dir);
  await until(() => !r.proc);
  assert.equal(r.status, 'parked');
  assert.equal(r.lost, false);
  assert.deepEqual(fs.readdirSync(dir), [], 'relay files cleaned up');
});

test('a relay that was killed (or a PC restart) shows as cut off', async () => {
  const dir = newDir();
  const one = runnerIn(dir);
  const id = one.start({ cwd: dir, message: 'hi' });
  await until(() => one.get(id).status === 'needs_you');
  const relayPid = JSON.parse(fs.readFileSync(path.join(dir, `${id}.state.json`))).relayPid;
  await one.shutdown();
  await one.get(id).proc.killTree.call({ done: false, relayPid }); // what a reboot does
  await until(() => !alive(relayPid));

  const two = runnerIn(dir);
  const [r] = adoptAll(two, dir);
  await until(() => !r.proc);
  assert.equal(r.lost, true);
  assert.equal(two.publicRun(r).lost, true);
});

test('a relay still running but unreachable is ended before the chat counts as lost — never one from another folder', async () => {
  const { RelayProc } = await import('../src/relay-client.mjs');
  const dir = newDir();
  const one = runnerIn(dir);
  const id = one.start({ cwd: dir, message: 'hi' });
  await until(() => one.get(id).status === 'needs_you');
  const relayPid = JSON.parse(fs.readFileSync(path.join(dir, `${id}.state.json`))).relayPid;
  await one.shutdown();

  // A server on a copy of data/ (another folder) can't reach it — and must leave it running.
  const copy = newDir();
  for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(copy, f));
  const other = new RelayProc(copy, id, { relayPid });
  const otherExit = new Promise(r => other.once('exit', r));
  other.connect({ timeoutMs: 300 });
  await otherExit;
  assert.ok(alive(relayPid), 'the live relay was not touched');

  // Its own server, when the pipe doesn't answer in time: the relay is ended, then the chat is marked lost.
  const slow = new RelayProc(dir, id, { relayPid, pipe: '\\.\pipe\pitwall-relay-nobody-home' });
  const slowExit = new Promise(r => slow.once('exit', r));
  slow.connect({ timeoutMs: 300 });
  await slowExit;
  assert.equal(slow.lost, true);
  await until(() => !alive(relayPid));
});

// Stop / Finish ends the relay with taskkill /T /F, so its socket closes with no exit record: the log, already replayed
// over the socket, must not be played into the chat a second time (every item showed twice after "Session stopped.").
test('stopping a chat under a relay does not replay its log again (fresh and adopted)', async () => {
  const dir = newDir();
  const one = runnerIn(dir);
  const texts = r => r.items.map(i => `${i.kind}:${i.text}`);
  const ids = [one.start({ cwd: dir, message: 'hi' }), one.start({ cwd: dir, message: 'hello' })];
  for (const id of ids) {
    await until(() => one.get(id).status === 'needs_you');
    one.answer(id, 'r1', { behavior: 'allow' });
    await until(() => one.get(id).status === 'your_turn');
  }
  await one.stop(ids[0]);
  await until(() => !one.get(ids[0]).proc);
  assert.deepEqual(texts(one.get(ids[0])), ['user:hi', 'note:Approved: Bash', 'assistant:done r1', 'note:Session stopped.']);

  await one.shutdown(); // the second chat carries on under its relay; the next server adopts it, then it is stopped
  const two = runnerIn(dir);
  const [r] = adoptAll(two, dir);
  await until(() => !r.replaying && r.proc);
  await two.stop(ids[1]);
  await until(() => !r.proc);
  assert.deepEqual(texts(r), ['user:hello', 'assistant:done r1', 'note:Session stopped.']);
  await until(() => !fs.readdirSync(dir).some(f => f.startsWith(ids[1])));
});
