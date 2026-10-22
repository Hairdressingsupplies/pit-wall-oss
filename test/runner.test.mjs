import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Runner } from '../src/runner.mjs';

/** A fake `claude` child: records what Pit Wall writes, lets the test emit stdout events. */
function fakeSpawn(log) {
  return (exe, args, opts) => {
    const p = new EventEmitter();
    p.pid = 1000 + log.length;
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    p.written = [];
    p.stdin = { write: s => { p.written.push(JSON.parse(s)); return true; } };
    p.emitEvent = e => p.stdout.write(JSON.stringify(e) + '\n');
    log.push({ exe, args, opts, p });
    return p;
  };
}
const tick = () => new Promise(r => setTimeout(r, 10));

test('start → message → permission prompt → approve → your turn', async () => {
  const log = [];
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn(log) });
  const seen = [];
  runner.on('run', r => seen.push(r.status));
  const id = runner.start({ cwd: 'C:\\x', name: 'Test', message: 'hello' });
  const { p, args, opts } = log[0];
  assert.equal(opts.cwd, 'C:\\x');
  assert.ok(args.includes('--session-id') && args.includes(id));
  const { uuid, ...first } = p.written[0];
  assert.deepEqual(first, { type: 'user', message: { role: 'user', content: 'hello' } });
  assert.match(uuid, /^[0-9a-f-]{36}$/, 'each message carries its own id');

  p.emitEvent({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, permission_suggestions: [{}] } });
  await tick();
  const pub = runner.publicRun(runner.get(id));
  assert.equal(pub.status, 'needs_you');
  assert.equal(pub.pending[0].toolName, 'Bash');
  assert.equal(pub.pending[0].raw, undefined, 'raw request not exposed');

  runner.answer(id, 'r1', { behavior: 'allow' });
  assert.equal(p.written[1].response.response.behavior, 'allow');
  p.emitEvent({ type: 'result', is_error: false, total_cost_usd: 0.02 });
  await tick();
  assert.equal(runner.get(id).status, 'your_turn');
  assert.ok(seen.includes('needs_you'));
  await runner.shutdown();
});

test('a parked session is resumed with --resume on the next message', async () => {
  const log = [];
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn(log) });
  const id = runner.start({ cwd: 'C:\\x', message: 'one' });
  log[0].p.emitEvent({ type: 'result', is_error: false });
  await tick();
  runner.get(id).parking = true;
  log[0].p.emit('exit', 0);
  assert.equal(runner.get(id).status, 'parked');
  runner.send(id, 'two', { cwd: 'C:\\x' });
  assert.equal(log.length, 2);
  assert.equal(log[1].args[log[1].args.indexOf('--resume') + 1], id);
  log[1].p.emitEvent({ type: 'system', subtype: 'status' }); // ready: the held message goes now
  await tick();
  assert.equal(log[1].p.written[0].message.content, 'two');
  await runner.shutdown();
});

test('capacity: refuses when every slot is busy, parks the oldest idle one otherwise', async () => {
  const log = [];
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn(log), maxRunning: 1 });
  runner.start({ cwd: 'C:\\x', message: 'busy one' });
  assert.throws(() => runner.start({ cwd: 'C:\\x', message: 'two' }), /slots are busy/);
  await runner.shutdown();
});

test('sessions default to the configured permission mode unless one is picked', async () => {
  const log = [];
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn(log), defaultPermissionMode: 'auto' });
  runner.start({ cwd: 'C:\\x', message: 'a' });
  runner.start({ cwd: 'C:\\x', message: 'b', permissionMode: 'plan' });
  const mode = a => a[a.indexOf('--permission-mode') + 1];
  assert.equal(mode(log[0].args), 'auto');
  assert.equal(mode(log[1].args), 'plan');
  await runner.shutdown();
});

test('a session with background jobs running is never parked', async () => {
  const log = [];
  const killed = [];
  const runner = new Runner({ claudeExe: 'claude', killFn: async pid => { killed.push(pid); }, spawnFn: fakeSpawn(log), idleParkMinutes: 0 });
  const id = runner.start({ cwd: 'C:/x', message: 'start a dev server in the background' });
  const { p } = log[0];
  p.emitEvent({ type: 'system', subtype: 'task_started', task_id: 'bg1', is_backgrounded: true });
  p.emitEvent({ type: 'result', is_error: false });
  await tick();
  assert.equal(runner.publicRun(runner.get(id)).backgroundTasks, 1);
  runner.parkIdle(Date.now() + 60_000);
  assert.deepEqual(killed, [], 'not parked while the job runs');
  p.emitEvent({ type: 'system', subtype: 'task_notification', task_id: 'bg1', status: 'completed' });
  await tick();
  runner.parkIdle(Date.now() + 60_000);
  assert.deepEqual(killed, [p.pid], 'parked once the job finished');
  await runner.shutdown();
});

test('idleParkMinutes null (the default config): an idle chat is never parked, however long it waits', async () => {
  const log = [];
  const killed = [];
  const runner = new Runner({ claudeExe: 'claude', killFn: async pid => { killed.push(pid); }, spawnFn: fakeSpawn(log), idleParkMinutes: null });
  runner.start({ cwd: 'C:/x', message: 'hi' });
  log[0].p.emitEvent({ type: 'result', is_error: false });
  await tick();
  runner.parkIdle(Date.now() + 7 * 86_400_000);
  assert.deepEqual(killed, []);
  await runner.shutdown();
});

test('a session with a cron still to fire is not parked; a denied CronCreate does not count', async () => {
  const log = [];
  const killed = [];
  const runner = new Runner({ claudeExe: 'claude', killFn: async pid => { killed.push(pid); }, spawnFn: fakeSpawn(log), idleParkMinutes: 0 });
  const id = runner.start({ cwd: 'C:/x', message: '/loop 10m check the build' });
  const { p } = log[0];
  const cron = (tid, input, isError = false) => {
    p.emitEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: tid, name: 'CronCreate', input }] } });
    p.emitEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: tid, is_error: isError, content: 'ok' }] } });
  };
  cron('t1', { cron: '0 8 * * *', recurring: false, prompt: 'x' }, true); // denied by hook-cron: saved by Pit Wall instead
  p.emitEvent({ type: 'result', is_error: false });
  await tick();
  assert.equal(runner.get(id).keepUntil, 0);
  cron('t2', { cron: '*/10 * * * *', prompt: '/babysit' });
  p.emitEvent({ type: 'result', is_error: false });
  await tick();
  runner.parkIdle(Date.now() + 60_000);
  assert.deepEqual(killed, [], 'a recurring cron keeps it');
  await runner.shutdown();
});

test('passes effort and Chrome to every launch', async () => {
  const log = [];
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn(log), defaultEffort: 'medium', chromeFn: () => true });
  runner.start({ cwd: 'C:/x', message: 'a' });
  assert.ok(log[0].args.includes('--chrome'));
  assert.equal(log[0].args[log[0].args.indexOf('--effort') + 1], 'medium');
  await runner.shutdown();
});

test('images go to Claude as blocks and show in the chat', async () => {
  const log = [];
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn(log) });
  const items = [];
  runner.on('item', (_, it) => items.push(it));
  const id = runner.start({ cwd: 'C:/x', message: '', images: [{ mediaType: 'image/png', data: 'QUJD' }] });
  assert.equal(log[0].p.written[0].message.content[0].type, 'image');
  runner.send(id, 'and this', { images: [{ mediaType: 'image/jpeg', data: 'QUJD' }] });
  assert.equal(log[0].p.written[1].message.content[1].text, 'and this');
  assert.deepEqual(items.map(i => i.images), [['data:image/png;base64,QUJD'], ['data:image/jpeg;base64,QUJD']]);
  await runner.shutdown();
});

test('sending to an unknown session without a folder fails clearly', () => {
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn([]) });
  assert.throws(() => runner.send('nope', 'hi'), /Unknown session/);
  clearInterval(runner.reaper);
});

test('a turn reports elapsed start, live token estimate, real counts and what Claude is doing', async () => {
  const log = [];
  let clock = '2026-10-05T10:00:00.000Z';
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn(log), now: () => clock });
  const progress = [];
  runner.on('progress', (sid, turn) => progress.push(turn));
  const id = runner.start({ cwd: 'C:/x', name: 'T', message: 'hello' });
  const { p } = log[0];
  const turn = () => runner.publicRun(runner.get(id)).turn;
  assert.equal(turn().startedAt, '2026-10-05T10:00:00.000Z');
  assert.equal(turn().tokens, 0);

  p.emitEvent({ type: 'stream_event', event: { type: 'message_start' } });
  p.emitEvent({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } });
  p.emitEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x'.repeat(400) } } });
  await tick();
  assert.equal(turn().activity, 'thinking');
  assert.equal(turn().tokens, 100, 'estimated at 4 characters a token');
  assert.ok(progress.length >= 1);

  p.emitEvent({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 150 } } });
  p.emitEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } });
  await tick();
  assert.equal(turn().tokens, 150, 'real count replaces the estimate');
  assert.deepEqual(turn().activity, { tool: 'Bash', summary: 'npm test' });

  p.emitEvent({ type: 'stream_event', event: { type: 'message_start' } });
  p.emitEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'y'.repeat(40) } } });
  await tick();
  assert.equal(turn().tokens, 160, 'earlier messages add up');
  assert.equal(turn().activity, null, 'writing the reply');

  p.emitEvent({ type: 'result', subtype: 'success', is_error: false });
  await tick();
  assert.equal(turn(), null);
});

test('a fresh relay clock line does not freeze the time of everything after it', async () => {
  const log = [];
  let clock = '2026-10-05T10:00:00.000Z';
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn(log), now: () => clock });
  const id = runner.start({ cwd: 'C:/x', name: 'T', message: 'hello' });
  const { p } = log[0];
  p.emitEvent({ type: 'pitwall_clock', t: '2026-10-05T09:59:59.000Z' });
  p.emitEvent({ type: 'pitwall_replayed' });
  p.emitEvent({ type: 'result', subtype: 'success', is_error: false });
  await tick();
  clock = '2026-10-05T10:05:00.000Z';
  runner.send(id, 'again');
  assert.equal(runner.publicRun(runner.get(id)).turn.startedAt, '2026-10-05T10:05:00.000Z');
});
