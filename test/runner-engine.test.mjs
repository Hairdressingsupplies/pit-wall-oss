import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Runner } from '../src/runner.mjs';

/** Same fake child as test/runner.test.mjs: records what Pit Wall writes, lets the test emit stdout events. */
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
const BRIDGE = 'C:\\pw\\src\\codex-bridge.mjs';
const newRunner = (log, extra = {}) => new Runner({ claudeExe: 'claude.exe', bridgePath: BRIDGE, killFn: async () => {}, spawnFn: fakeSpawn(log), idleParkMinutes: null, ...extra });

test('a codex chat launches the bridge under node; a claude chat is unchanged', async () => {
  const log = [];
  const r = newRunner(log, { defaultEffort: 'high', defaultPermissionMode: 'auto' });
  const id = r.start({ cwd: 'C:\\r', engine: 'codex', model: 'gpt-6.1-sol', message: 'hi' });
  r.start({ cwd: 'C:\\r', message: 'hi' });
  const [codex, claude] = log;
  assert.equal(codex.exe, process.execPath);
  assert.deepEqual(codex.args, [BRIDGE, '--session-id', id, '--replay-user-messages', '--model', 'gpt-6.1-sol']);
  assert.ok(!codex.args.includes('--effort'), 'the Claude default effort is not passed to Codex');
  assert.equal(codex.opts.pitwall.engine, 'codex');
  assert.equal(codex.opts.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING, process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING, 'not forced on for Codex');
  assert.equal(codex.p.written[0].message.content, 'hi');
  assert.equal(r.publicRun(r.get(id)).engine, 'codex');
  assert.equal(claude.exe, 'claude.exe');
  assert.ok(!claude.args.includes(BRIDGE));
  assert.ok(claude.args.includes('--effort'), 'Claude still gets its default effort');
  assert.equal(claude.opts.pitwall.engine, 'claude');
  assert.equal(claude.opts.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING, 'true');
  await r.shutdown();
});

test('a codex chat passes its own effort', async () => {
  const log = [];
  const r = newRunner(log);
  r.start({ cwd: 'C:\\r', engine: 'codex', effort: 'low', message: 'x' });
  assert.equal(log[0].args[log[0].args.indexOf('--effort') + 1], 'low');
  assert.ok(!log[0].args.includes('--model'));
  await r.shutdown();
});

test('a codex job gets --job; resume keeps the engine', async () => {
  const log = [];
  const r = newRunner(log);
  const id = r.start({ cwd: 'C:\\r', engine: 'codex', disallowedTools: ['Bash(*git push*)'], message: 'x' });
  assert.ok(log[0].args.includes('--job'));
  log[0].p.emitEvent({ type: 'result', is_error: false });
  await tick();
  r.get(id).parking = true;
  log[0].p.emit('exit', 0);
  r.send(id, 'again');
  assert.equal(log[1].exe, process.execPath);
  assert.deepEqual(log[1].args.slice(0, 4), [BRIDGE, '--resume', id, '--replay-user-messages']);
  assert.ok(log[1].args.includes('--job'));
  assert.equal(log[1].opts.pitwall.engine, 'codex');
  await r.shutdown();
});

test('send can launch a chat Pit Wall has not run yet on codex', async () => {
  const log = [];
  const r = newRunner(log);
  r.send('abc', 'hello', { cwd: 'C:\\r', engine: 'codex' });
  assert.equal(log[0].exe, process.execPath);
  assert.ok(log[0].args.includes('--resume'));
  await r.shutdown();
});

test('adopt keeps the codex engine; adopt defaults to claude', async () => {
  const log = [];
  const r = newRunner(log);
  const mk = pid => { const p = new EventEmitter(); p.stdin = new PassThrough(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.pid = pid; return p; };
  r.adopt({ sessionId: 'x', cwd: 'C:\\r', engine: 'codex', proc: mk(1) });
  r.adopt({ sessionId: 'y', cwd: 'C:\\r', proc: mk(2) });
  assert.equal(r.publicRun(r.get('x')).engine, 'codex');
  assert.equal(r.publicRun(r.get('y')).engine, 'claude');
  await r.shutdown();
});

test('stopping a task stays Claude-only in a codex chat', async () => {
  const log = [];
  const r = newRunner(log);
  const id = r.start({ cwd: 'C:\\r', engine: 'codex', message: 'x' });
  await assert.rejects(async () => r.stopTask(id, 't'), /Not available in Codex chats/);
  assert.equal(log.length, 1, 'nothing new was launched');
  assert.deepEqual(log[0].p.written.filter(w => w.type === 'control_request'), [], 'no control request reached the bridge');
  await r.shutdown();
});

test('a codex fork launches the bridge with the new id, --fork-from and --fork-at; a job fork keeps --job', async () => {
  const log = [];
  const r = newRunner(log);
  const id = r.start({ cwd: 'C:\\r', engine: 'codex', model: 'gpt-6.1-sol', disallowedTools: ['Bash(*git push*)'], message: 'x' });
  const nid = r.fork(id, { atUuid: 'm1', message: 'try another way' });
  const f = log[1];
  assert.equal(f.exe, process.execPath);
  assert.deepEqual(f.args.slice(0, 8), [BRIDGE, '--session-id', nid, '--replay-user-messages', '--fork-from', id, '--fork-at', 'm1']);
  assert.ok(f.args.includes('--job'), 'a fork of a job stays a job');
  assert.equal(f.opts.pitwall.engine, 'codex');
  assert.equal(f.p.written[0].message.content, 'try another way');
  r.fork(id, { message: 'whole' });
  assert.ok(!log[2].args.includes('--fork-at'), 'no reply: the whole chat');
  await r.shutdown();
});

test('codex /btw and rewind reach the bridge; rewind never asks for a file undo; the preview says why', async () => {
  const { NO_FILE_UNDO } = await import('../src/codex-translate.mjs');
  const log = [];
  const r = newRunner(log);
  const id = r.start({ cwd: 'C:\\r', engine: 'codex', message: 'x' });
  const p = log[0].p;
  p.emitEvent({ type: 'result', is_error: false });
  await tick();
  const answer = (subtype, response) => {
    const req = p.written.filter(w => w.type === 'control_request').at(-1);
    assert.equal(req.request.subtype, subtype);
    p.emitEvent({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response } });
    return req;
  };
  const side = r.sideQuestion(id, 'q', []);
  await tick();
  answer('side_question', { response: 'a' });
  assert.deepEqual(await side, { response: 'a' });
  assert.deepEqual(await r.rewindPreview(id, 'u1'), { canRewind: false, codex: true, error: NO_FILE_UNDO });
  const rw = r.rewind(id, 'u1', { files: true });
  await tick();
  const req = answer('rewind_conversation', {});
  assert.equal(req.request.target_message_uuid, 'u1');
  await rw;
  assert.ok(!p.written.some(w => w.request?.subtype === 'rewind_files'), 'no rewind_files for Codex');
  assert.equal(log.length, 1, 'all on the running bridge');
  await r.shutdown();
});

test('publicRun carries codexBranching from the bridge init; Claude runs have none', async () => {
  const log = [];
  const r = newRunner(log);
  const id = r.start({ cwd: 'C:\\r', engine: 'codex', message: 'x' });
  const cid = r.start({ cwd: 'C:\\r', message: 'x' });
  assert.equal(r.publicRun(r.get(id)).codexBranching, false, 'before init: not yet');
  log[0].p.emitEvent({ type: 'system', subtype: 'init', session_id: id, model: 'gpt-6.1-sol', slash_commands: [], branching: true });
  log[1].p.emitEvent({ type: 'system', subtype: 'init', session_id: cid, model: 'opus', slash_commands: [] });
  await tick();
  assert.equal(r.publicRun(r.get(id)).codexBranching, true);
  assert.equal(r.publicRun(r.get(cid)).codexBranching, undefined);
  await r.shutdown();
});

test('changing model or permission mode in a codex chat restarts it instead of a live switch', async () => {
  const log = [];
  const r = newRunner(log);
  const id = r.start({ cwd: 'C:\\r', engine: 'codex', message: 'x' });
  log[0].p.emitEvent({ type: 'result', is_error: false });
  await tick();
  await r.reconfigure(id, { model: 'gpt-6.1-mini', permissionMode: 'acceptEdits' });
  assert.deepEqual(log[0].p.written.filter(w => w.type === 'control_request'), [], 'no set_model / set_permission_mode sent');
  assert.equal(r.get(id).parking, true, 'parked so the next message relaunches with the new model');
  assert.equal(r.get(id).model, 'gpt-6.1-mini');
  await r.shutdown();
});

test('a Claude chat still switches model live', async () => {
  const log = [];
  const r = newRunner(log);
  const id = r.start({ cwd: 'C:\\r', message: 'x' });
  log[0].p.emitEvent({ type: 'result', is_error: false });
  await tick();
  const done = r.reconfigure(id, { model: 'sonnet' });
  await tick();
  const req = log[0].p.written.find(w => w.type === 'control_request');
  assert.equal(req.request.subtype, 'set_model');
  log[0].p.emitEvent({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: {} } });
  await done;
  assert.equal(r.get(id).parking, false);
  await r.shutdown();
});

test('while Codex is being installed a codex launch is refused with a readable error and nothing spawns; claude is unaffected', async () => {
  const log = [];
  let blocked = 'Codex is being updated — try again in a minute.';
  const r = newRunner(log, { codexBlocked: () => blocked });
  assert.throws(() => r.start({ cwd: 'C:\r', engine: 'codex', message: 'hi' }), e => e.message === blocked && e.status === 409);
  assert.equal(log.length, 0, 'no bridge was started');
  assert.equal(r.runs.size, 0);
  r.start({ cwd: 'C:\r', message: 'hi' });
  assert.equal(log.length, 1, 'a Claude chat still starts');
  blocked = null;
  r.start({ cwd: 'C:\r', engine: 'codex', message: 'hi' });
  assert.equal(log.length, 2, 'once the install is over, Codex starts again');
  assert.equal(log[1].exe, process.execPath);
});
