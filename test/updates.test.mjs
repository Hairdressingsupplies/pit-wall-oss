import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCounts, checkUpdates } from '../src/updates.mjs';

const fakeGit = answers => async (root, args) => answers[args[0]] ?? { ok: true, out: '' };

test('counts parse', () => {
  assert.deepEqual(parseCounts('2\t5'), { ahead: 2, behind: 5 });
  assert.deepEqual(parseCounts(''), { ahead: 0, behind: 0 });
});

test('an update is offered only to a clean copy that is simply behind', async () => {
  const behind = await checkUpdates('C:/pw', fakeGit({ 'rev-list': { ok: true, out: '0\t3' }, log: { ok: true, out: 'feat: a\nfix: b\ndocs: c' } }));
  assert.equal(behind.canUpdate, true);
  assert.deepEqual(behind.subjects, ['feat: a', 'fix: b', 'docs: c']);
  const ahead = await checkUpdates('C:/pw', fakeGit({ 'rev-list': { ok: true, out: '4\t3' } }));
  assert.equal(ahead.canUpdate, false, 'has its own commits (a dev copy)');
  const dirty = await checkUpdates('C:/pw', fakeGit({ 'rev-list': { ok: true, out: '0\t3' }, status: { ok: true, out: ' M src/x.mjs' } }));
  assert.equal(dirty.canUpdate, false, 'has changed files');
  const offline = await checkUpdates('C:/pw', fakeGit({ fetch: { ok: false, err: 'fatal: unable to access' } }));
  assert.equal(offline.canUpdate, false);
  assert.match(offline.error, /Couldn't reach GitHub/);
  const current = await checkUpdates('C:/pw', fakeGit({ 'rev-list': { ok: true, out: '0\t0' } }));
  assert.equal(current.canUpdate, false);
  assert.equal(current.behind, 0);
});
