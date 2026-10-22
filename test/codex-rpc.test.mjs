import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Rpc } from '../src/codex-rpc.mjs';

const pair = () => { const toClient = new PassThrough(), fromClient = new PassThrough(); const sent = [];
  fromClient.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => sent.push(JSON.parse(l))));
  return { rpc: new Rpc(toClient, fromClient), toClient, sent }; };
const tick = () => new Promise(r => setImmediate(r));

test('request resolves with the matching reply and rejects on an error reply', async () => {
  const { rpc, toClient, sent } = pair();
  const p = rpc.request('model/list', {});
  const q = rpc.request('account/read', {});
  await tick();
  assert.deepEqual(sent.map(m => m.method), ['model/list', 'account/read']);
  assert.ok(sent.every(m => !('jsonrpc' in m)));
  toClient.write(JSON.stringify({ id: sent[1].id, error: { code: -1, message: 'nope' } }) + '\n');
  toClient.write(JSON.stringify({ id: sent[0].id, result: { data: [] } }) + '\n');
  assert.deepEqual(await p, { data: [] });
  await assert.rejects(q, /nope/);
});

test('notifications and server requests are emitted; respond answers by id', async () => {
  const { rpc, toClient, sent } = pair();
  const got = [];
  rpc.on('notification', (m, p) => got.push(['n', m, p]));
  rpc.on('request', (id, m, p) => got.push(['r', id, m, p]));
  toClient.write('{"method":"turn/started","params":{"threadId":"t"}}\n{"id":7,"method":"item/fileChange/requestApproval","params":{"itemId":"i"}}\nnot json\n');
  await tick();
  assert.deepEqual(got, [['n', 'turn/started', { threadId: 't' }], ['r', 7, 'item/fileChange/requestApproval', { itemId: 'i' }]]);
  rpc.respond(7, { decision: 'accept' });
  await tick();
  assert.deepEqual(sent.at(-1), { id: 7, result: { decision: 'accept' } });
});

test('respondError sends a JSON-RPC error reply by id', async () => {
  const { rpc, sent } = pair();
  rpc.respondError(9, -32601, 'Pit Wall does not handle x.');
  await tick();
  assert.deepEqual(sent.at(-1), { id: 9, error: { code: -32601, message: 'Pit Wall does not handle x.' } });
});

test('a request times out', async () => {
  const { rpc } = pair();
  await assert.rejects(rpc.request('thread/start', {}, 20), /did not answer/);
});

test('pending requests reject with "Codex stopped." when the input ends, and later requests fail fast', async () => {
  const { rpc, toClient } = pair();
  let closes = 0; rpc.on('close', () => closes++);
  const p = rpc.request('a', {}, 5000);
  toClient.end();
  await assert.rejects(p, /Codex stopped\./);
  const t = Date.now();
  await assert.rejects(rpc.request('b', {}, 5000), /Codex stopped\./);
  assert.ok(Date.now() - t < 500);
  assert.equal(closes, 1);
});

test('an error on the output stream does not throw', async () => {
  const { rpc } = pair();
  rpc.output.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  await tick();
  assert.ok(rpc);
});

test('an error on the input stream rejects pending requests and closes once', async () => {
  const { rpc, toClient } = pair();
  let closes = 0; rpc.on('close', () => closes++);
  const p = rpc.request('a', {}, 5000);
  toClient.destroy(new Error('boom'));
  await assert.rejects(p, /Codex stopped\./);
  await tick();
  assert.equal(closes, 1);
});
