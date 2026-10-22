import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { Titler, cleanTitle, isGreeting, realName, PLACEHOLDER } from '../src/titler.mjs';

const settle = () => new Promise(r => setTimeout(r, 10));

function make(reply = { ok: true, data: { title: 'Fix the callback queue' } }) {
  const store = openDb(':memory:');
  const calls = [];
  const titled = [];
  const titler = new Titler({ store, claudeExe: 'claude', cwd: '.', log: { warn() {} },
    callModelFn: async opts => { calls.push(opts); return typeof reply === 'function' ? reply(opts) : reply; },
    onTitled: (id, t) => titled.push([id, t]) });
  return { store, calls, titled, titler };
}

test('an unnamed chat gets a Haiku title from its first message, once', async () => {
  const { store, calls, titled, titler } = make();
  store.upsertSession('a', { cwd: 'x', model: 'opus' });
  titler.request('a', 'Can you fix the callback outcome gap in the call list?');
  titler.request('a', 'again');
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'haiku');
  assert.deepEqual(calls[0].codexModels, [], 'the cached Codex model list goes along (none cached here)');
  assert.match(calls[0].prompt, /callback outcome gap/);
  assert.equal(store.sessionMeta('a').auto_title, 'Fix the callback queue');
  assert.equal(store.sessionMeta('a').model, 'opus', 'other fields kept');
  assert.deepEqual(titled, [['a', 'Fix the callback queue']]);
  store.upsertSession('a', { organised_mtime: 5 });
  assert.equal(store.sessionMeta('a').auto_title, 'Fix the callback queue', 'a partial upsert keeps the title');
});

test('a chat you named is never retitled', async () => {
  const { store, calls, titler } = make();
  store.upsertSession('b', { display_name: 'My name' });
  titler.request('b', 'hello');
  await settle();
  assert.equal(calls.length, 0);
});

test('backfill only names recent headless placeholder rows with a first message', async () => {
  const { calls, titler } = make();
  const now = Date.parse('2026-10-01T12:00:00Z');
  const recent = '2026-10-01T11:00:00Z';
  titler.backfill([
    { id: 'p1', name: PLACEHOLDER, source: 'pitwall', firstPrompt: 'do a thing', lastActivity: recent },
    { id: 'p2', name: 'Has a name', source: 'pitwall', firstPrompt: 'x', lastActivity: recent },
    { id: 'p3', name: PLACEHOLDER, source: 'terminal', firstPrompt: 'x', lastActivity: recent },
    { id: 'p4', name: PLACEHOLDER, source: 'closed', firstPrompt: 'x', lastActivity: '2026-09-01T00:00:00Z' },
    { id: 'p5', name: PLACEHOLDER, source: 'pitwall', firstPrompt: null, lastActivity: recent },
  ], now);
  await settle();
  assert.deepEqual(calls.map(c => c.prompt.includes('do a thing')), [true]);
});

test('a failed call stores nothing and is not retried in a loop', async () => {
  const { store, calls, titler } = make({ ok: false, error: 'boom' });
  titler.request('c', 'fix the login bug');
  await settle();
  titler.request('c', 'fix the login bug');
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(store.sessionMeta('c')?.auto_title ?? null, null);
});

test('cleanTitle and realName drop quotes, full stops and the placeholder', () => {
  assert.equal(cleanTitle('"Sales forecast review."'), 'Sales forecast review');
  assert.equal(cleanTitle('New session'), null);
  assert.equal(cleanTitle(''), null);
  assert.equal(realName('New session'), null);
  assert.equal(realName('  Real  '), 'Real');
});

test('cleanTitle rejects placeholder look-alikes', () => {
  for (const t of ['New session started', 'New chat', 'new conversation begun']) assert.equal(cleanTitle(t), null);
  assert.equal(cleanTitle('New sessions page layout fix'), 'New sessions page layout fix');
});

test('isGreeting', () => {
  for (const t of ['hi', 'Hello!', 'hey there', 'morning', 'yo']) assert.equal(isGreeting(t), true);
  for (const t of ['hi, fix the login bug', 'deploy the worker', 'hello world app in node', '', null]) assert.equal(isGreeting(t), false);
});

test('request skips a greeting without burning the one try; backfill uses the last prompt', async () => {
  const { store, calls, titler } = make();
  store.upsertSession('g', { cwd: 'x' });
  titler.request('g', 'hi');
  await settle();
  assert.equal(calls.length, 0);
  titler.backfill([{ id: 'g', name: PLACEHOLDER, firstPrompt: 'hi', lastPrompt: 'fix the login bug', lastActivity: new Date().toISOString() }]);
  await settle();
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /fix the login bug/);
  titler.backfill([{ id: 'h', name: PLACEHOLDER, firstPrompt: 'hi', lastPrompt: 'hello', lastActivity: new Date().toISOString() }]);
  await settle();
  assert.equal(calls.length, 1, 'greeting-only chat is left alone');
});
