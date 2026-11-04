import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripCommonPrefix, splitId, doingLabel, sortRows } from '../public/agent-rows.js';

test('agents panel: the shared leading words go, each label keeps something', () => {
  assert.deepEqual(stripCommonPrefix(['Hunter h01: public analytics ingest', 'Hunter h03: provider webhooks']),
    ['h01: public analytics ingest', 'h03: provider webhooks']);
  assert.deepEqual(stripCommonPrefix(['Review task', 'Review task']), ['task', 'task'], 'never empties a label');
  assert.deepEqual(stripCommonPrefix(['Only one agent']), ['Only one agent']);
  assert.deepEqual(stripCommonPrefix(['Check a', 'Fix b']), ['Check a', 'Fix b']);
});

test('agents panel: a short "id:" moves to its own column', () => {
  assert.deepEqual(splitId('h01: public analytics ingest'), { id: 'h01', name: 'public analytics ingest' });
  assert.deepEqual(splitId('check:top'), { id: '', name: 'check:top' }, 'needs a space after the colon');
  assert.deepEqual(splitId('Reformat A4 email'), { id: '', name: 'Reformat A4 email' });
});

test('agents panel: what an agent is doing reads as words, not a raw command', () => {
  assert.equal(doingLabel('Bash', 'cd …/sandbox/src && grep -rn "x" app'), 'running grep -rn "x" app');
  assert.equal(doingLabel('Bash', 'cd a; cd b && ls'), 'running ls');
  assert.equal(doingLabel('Read', '…/Popup/EnsureShop.php'), 'reading …/Popup/EnsureShop.php');
  assert.equal(doingLabel('Grep'), 'searching');
  assert.equal(doingLabel('mcp__x__y', 'q'), 'mcp__x__y q');
  assert.equal(doingLabel('Read', 'x'.repeat(100), 20).length, 20);
  assert.equal(doingLabel(null), '');
});

test('agents panel: failed, then quiet, then running, then waiting, then done', () => {
  const rows = [
    { key: 'd', state: 'done', startedAt: 1 }, { key: 'r2', state: 'running', startedAt: 5 }, { key: 'q', state: 'queued' },
    { key: 'r1', state: 'running', startedAt: 2 }, { key: 'z', state: 'running', quiet: true, startedAt: 9 }, { key: 'f', state: 'failed', startedAt: 3 },
  ];
  assert.deepEqual(sortRows(rows).map(r => r.key), ['f', 'z', 'r1', 'r2', 'q', 'd']);
});
