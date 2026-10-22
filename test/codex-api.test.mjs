// test/codex-api.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.mjs';
import { codexAccount, validModel, validEffort } from '../src/codex-exec.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex.mjs');

test('engine columns exist and default to claude', () => {
  const s = openDb(':memory:');
  const cols = t => s.db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  assert.ok(cols('session_meta').includes('engine'));
  assert.ok(cols('queue').includes('engine'));
  assert.ok(cols('roles').includes('engine'));
});

test('session meta, queue items and roles keep their engine', () => {
  const s = openDb(':memory:');
  s.upsertSession('a', { cwd: 'C:/x' });
  assert.equal(s.sessionMeta('a').engine, 'claude');
  s.upsertSession('b', { cwd: 'C:/x', engine: 'codex' });
  s.upsertSession('b', { display_name: 'later edit' }); // an unrelated update keeps it
  assert.equal(s.sessionMeta('b').engine, 'codex');
  s.upsertSession('c', { engine: 'gemini' }); // anything unknown is Claude
  assert.equal(s.sessionMeta('c').engine, 'claude');

  const q1 = s.addQueueItem({ title: 't', prompt: 'p', cwd: 'C:/x', engine: 'codex' });
  const q2 = s.addQueueItem({ title: 't', prompt: 'p', cwd: 'C:/x' });
  assert.equal(s.queueItem(q1).engine, 'codex');
  assert.equal(s.queueItem(q2).engine, null); // null = the default engine when it runs

  const r = s.addRole({ name: 'n', goal: 'g', cwd: 'C:/x', engine: 'codex' });
  assert.equal(s.role(r).engine, 'codex');
  s.updateRole(r, { engine: null });
  assert.equal(s.role(r).engine, null);
  s.updateRole(r, { engine: 'claude' });
  assert.equal(s.role(r).engine, 'claude');
});

test('model validation per engine', () => {
  assert.ok(validModel('claude', 'sonnet', []));
  assert.ok(!validModel('claude', 'gpt-6.1-sol', []));
  assert.ok(validModel('codex', 'gpt-6.1-sol', [{ id: 'gpt-6.1-sol' }]));
  assert.ok(!validModel('codex', 'sonnet', [{ id: 'gpt-6.1-sol' }]));
  assert.ok(validModel('codex', '', []));
  assert.ok(validModel('codex', 'gpt-6.1-sol', [])); // no list yet: any sane id
  assert.ok(!validModel('codex', 'Bad Model!', []));
});

test('effort validation per engine and Codex model', () => {
  const models = [{ id: 'gpt-6.1-sol', efforts: ['low', 'medium', 'high', 'ultra'] }, { id: 'gpt-6-luna', efforts: ['low'] }];
  assert.ok(validEffort('claude', 'max', '', models));
  assert.ok(!validEffort('claude', 'ultra', '', models));
  assert.ok(validEffort('codex', '', 'gpt-6-luna', models));
  assert.ok(validEffort('codex', 'ultra', 'gpt-6.1-sol', models));
  assert.ok(!validEffort('codex', 'high', 'gpt-6-luna', models)); // that model doesn't offer it
  assert.ok(validEffort('codex', 'high', '', models));           // default model: any effort some model offers
  assert.ok(!validEffort('codex', 'max', '', models));
  assert.ok(validEffort('codex', 'ultra', '', []));               // no list yet: the known Codex efforts
  assert.ok(!validEffort('codex', 'turbo', '', []));
});

test('codexAccount reads sign-in, plan, models and usage from a throwaway app-server', async () => {
  const a = await codexAccount({ exe: process.execPath, preArgs: [FAKE], env: { ...process.env, FAKE_CODEX: 'ok' } });
  assert.deepEqual([a.installed, a.signedIn, a.plan, a.email], [true, true, 'plus', 'r@x']);
  assert.deepEqual(a.models, [{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low'], isDefault: true }]);
  assert.equal(a.rate.unifiedWindows.five_hour.utilization, 0.05);
  const out = await codexAccount({ exe: process.execPath, preArgs: [FAKE], env: { ...process.env, FAKE_CODEX: 'signed-out' } });
  assert.deepEqual([out.installed, out.signedIn], [true, false]);
  assert.equal(a.sandbox, 'ready', 'the Windows sandbox state comes along (for the Codex panel)');
  const unset = await codexAccount({ exe: process.execPath, preArgs: [FAKE], env: { ...process.env, FAKE_CODEX: 'sandbox-unset' } });
  assert.equal(unset.sandbox, 'notConfigured');
  assert.deepEqual(await codexAccount({ exe: null }), { installed: false, signedIn: false, email: null, plan: null, rate: null, models: [], sandbox: null });
});

test('codexAccount gives up on an app-server that never answers', async () => {
  const silent = ['-e', 'setInterval(() => {}, 1000)'];
  const a = await codexAccount({ exe: process.execPath, preArgs: silent, timeoutMs: 300 });
  assert.deepEqual([a.installed, a.signedIn], [true, false]);
});
