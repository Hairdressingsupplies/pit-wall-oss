import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Runner } from '../src/runner.mjs';

// Terminal-parity features of the runner: message ids and queueing, side questions, live mode switching,
// rewind, forks, stopping tasks, and the resume readiness gate.

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
const tick = () => new Promise(r => setTimeout(r, 20));

/** Answers every control_request Pit Wall writes with a canned success, as Claude Code would. */
function answerCalls(p) {
  const canned = {
    side_question: { response: 'It is PINEAPPLE.', synthetic: false },
    cancel_async_message: { cancelled: true },
    rewind_conversation: { rewound: true, prefillText: 'first ask', precedingAssistantUuid: 'a0' },
    set_permission_mode: { mode: 'plan' },
    rewind_files: { canRewind: true, filesChanged: ['C:/x/a.txt'], insertions: 1, deletions: 1 },
    stop_task: {},
  };
  const seen = new Set();
  return setInterval(() => {
    for (const m of p.written) {
      if (m.type !== 'control_request' || seen.has(m.request_id)) continue;
      seen.add(m.request_id);
      p.emitEvent({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: canned[m.request.subtype] ?? {} } });
    }
  }, 5);
}

test('messages carry ids; one sent mid-turn is queued until picked up, can be taken back, and keeps the turn timer', async () => {
  const log = [];
  let clock = '2026-10-06T10:00:00.000Z';
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn(log), now: () => clock });
  const id = runner.start({ cwd: 'C:/x', name: 'T', message: 'first' });
  const { p } = log[0];
  const t = answerCalls(p);
  assert.ok(p.written[0].uuid, 'first message has an id');
  assert.equal(log[0].opts.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING, 'true', 'file checkpoints on');
  clock = '2026-10-06T10:00:30.000Z';
  runner.send(id, 'second');
  const q = runner.publicRun(runner.get(id));
  assert.equal(q.turn.startedAt, '2026-10-06T10:00:00.000Z', 'a queued message does not restart the timer');
  assert.deepEqual(q.queued.map(m => m.text), ['second']);
  const u2 = q.queued[0].uuid;
  assert.equal(p.written.at(-1).uuid, u2);
  p.emitEvent({ type: 'user', isReplay: true, uuid: u2, message: { content: 'second' } });
  await tick();
  assert.deepEqual(runner.publicRun(runner.get(id)).queued, [], 'picked up');
  runner.send(id, 'third');
  const u3 = runner.publicRun(runner.get(id)).queued[0].uuid;
  assert.equal(await runner.cancelQueued(id, u3), true);
  assert.equal(p.written.find(m => m.request?.subtype === 'cancel_async_message').request.message_uuid, u3);
  assert.deepEqual(runner.publicRun(runner.get(id)).queued, []);
  assert.ok(!runner.get(id).items.some(i => i.uuid === u3), 'a taken-back message leaves the chat');
  clearInterval(t);
});

test('side questions, live mode switch, rewind and stopping a task go through control requests', async () => {
  const log = [];
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => { throw new Error('should not restart'); }, spawnFn: fakeSpawn(log) });
  const id = runner.start({ cwd: 'C:/x', name: 'T', message: 'first ask' });
  const { p } = log[0];
  const t = answerCalls(p);
  p.emitEvent({ type: 'result', subtype: 'success', is_error: false });
  await tick();
  assert.equal((await runner.sideQuestion(id, 'codeword?', [])).response, 'It is PINEAPPLE.');
  await runner.reconfigure(id, { permissionMode: 'plan' });
  assert.equal(p.written.find(m => m.request?.subtype === 'set_permission_mode').request.mode, 'plan');
  assert.equal(runner.get(id).proc, p, 'switched without a restart');
  const target = runner.get(id).items.find(i => i.kind === 'user').uuid;
  assert.deepEqual(await runner.rewindPreview(id, target), { canRewind: true, filesChanged: ['C:/x/a.txt'], insertions: 1, deletions: 1 });
  const r = await runner.rewind(id, target, { files: true });
  assert.equal(r.prefillText, 'first ask');
  assert.ok(p.written.some(m => m.request?.subtype === 'rewind_files' && !m.request.dry_run));
  assert.equal(runner.get(id).items.filter(i => i.kind === 'user').length, 0, 'the message and what followed are gone');
  await runner.stopTask(id, 'task9');
  assert.equal(p.written.find(m => m.request?.subtype === 'stop_task').request.task_id, 'task9');
  clearInterval(t);
});

test('a resumed fork holds what it writes until Claude Code says it is ready; an ordinary resume does not wait', async () => {
  const log = [];
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn(log) });
  const id = runner.start({ cwd: 'C:/x', name: 'T', message: 'a' });
  log[0].p.emit('exit', 0);
  await tick();
  runner.send(id, 'again', { waitReady: true });
  const p2 = log[1].p;
  assert.ok(log[1].args.includes('--resume'));
  assert.equal(p2.written.length, 0, 'held');
  assert.equal(runner.get(id).items.at(-1).text, 'again', 'shown at once');
  p2.emitEvent({ type: 'system', subtype: 'status' });
  await tick();
  assert.equal(p2.written[0].message.content, 'again');
});

test('fork starts a copy of the chat from a reply, under a new id, with the first message', async () => {
  const log = [];
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn(log) });
  const id = runner.start({ cwd: 'C:/x', name: 'Pricing', message: 'a', model: 'sonnet' });
  const nid = runner.fork(id, { atUuid: 'a1', message: 'try another way' });
  const { args } = log[1];
  assert.notEqual(nid, id);
  const i = args.indexOf('--resume');
  assert.deepEqual(args.slice(i, i + 7), ['--resume', id, '--fork-session', '--resume-session-at', 'a1', '--session-id', nid]);
  assert.ok(args.includes('sonnet'));
  assert.equal(runner.get(nid).name, 'Fork of Pricing');
  assert.equal(runner.get(nid).items.at(-1).text, 'try another way');
});

test('replaying a relay log applies a rewind and a taken-back message', async () => {
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn([]) });
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = { write: () => true };
  proc.pid = 7;
  runner.adopt({ sessionId: 's1', cwd: 'C:/x', proc });
  const line = o => proc.stdout.write(JSON.stringify(o) + '\n');
  const input = o => line({ type: 'pitwall_input', line: JSON.stringify(o) });
  input({ type: 'user', uuid: 'u1', message: { content: 'one' } });
  line({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'reply one' }] } });
  line({ type: 'result', subtype: 'success', is_error: false });
  input({ type: 'user', uuid: 'u2', message: { content: 'two' } });
  input({ type: 'control_request', request_id: 'w', request: { subtype: 'rewind_conversation', target_message_uuid: 'u2' } });
  input({ type: 'user', uuid: 'u3', message: { content: 'three' } });
  input({ type: 'control_request', request_id: 'c', request: { subtype: 'cancel_async_message', message_uuid: 'u3' } });
  line({ type: 'pitwall_replayed' });
  await tick();
  assert.deepEqual(runner.get('s1').items.map(i => i.text), ['one', 'reply one']);
});

test('an ordinary resume writes at once; btw on a parked chat starts it idle, not working', async () => {
  const log = [];
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn(log) });
  const id = runner.start({ cwd: 'C:/x', name: 'T', message: 'a' });
  log[0].p.emit('exit', 0);
  await tick();
  runner.send(id, 'again');
  assert.equal(log[1].p.written[0].message.content, 'again', 'not held');
  log[1].p.emit('exit', 0);
  await tick();
  const ask = runner.sideQuestion(id, 'q?');
  const p3 = log[2].p;
  assert.equal(runner.publicRun(runner.get(id)).status, 'your_turn', 'no turn was started');
  const t3 = answerCalls(p3);
  assert.equal((await ask).response, 'It is PINEAPPLE.');
  clearInterval(t3);
});

test('a chat adopted from a relay started without echoes never marks messages queued', async () => {
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn([]) });
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.written = [];
  proc.stdin = { write: s => { proc.written.push(JSON.parse(s)); return true; } };
  proc.pid = 8;
  runner.adopt({ sessionId: 's2', cwd: 'C:/x', proc, echoes: false });
  proc.stdout.write(JSON.stringify({ type: 'pitwall_replayed' }) + '\n');
  await tick();
  runner.send('s2', 'one');
  runner.send('s2', 'two'); // mid-turn
  assert.deepEqual(runner.publicRun(runner.get('s2')).queued, []);
});
