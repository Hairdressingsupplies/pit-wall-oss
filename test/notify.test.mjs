import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Notifier } from '../src/notify.mjs';

function setup(opts = {}) {
  const sent = [];
  let t = 1_000_000;
  const n = new Notifier({ baseUrl: 'http://127.0.0.1:4040', send: m => sent.push(m), now: () => t, ...opts });
  return { n, sent, advance: ms => { t += ms; } };
}

test('notifies on a change into needs-you, with a link to that chat', () => {
  const { n, sent } = setup();
  n.update('s1', 'other');
  assert.equal(n.update('s1', 'needs_you', { name: 'Callback fix', reason: 'Wants to use Bash' }), true);
  assert.deepEqual(sent, [{ title: 'Callback fix', body: 'Wants to use Bash', url: 'http://127.0.0.1:4040/?s=s1' }]);
  assert.equal(n.update('s1', 'needs_you'), false, 'no repeat while the state holds');
});

test('stays quiet while you are looking at that chat, or when switched off', () => {
  const { n, sent } = setup();
  n.update('s1', 'other');
  n.setViewing('s1', true);
  assert.equal(n.update('s1', 'your_turn'), false);
  const off = setup({ enabled: () => false });
  off.n.update('s2', 'other');
  assert.equal(off.n.update('s2', 'error'), false);
  assert.equal(sent.length + off.sent.length, 0);
});

test('debounces bursts per session and ignores a first sighting of your_turn', () => {
  const { n, sent, advance } = setup();
  assert.equal(n.update('s1', 'your_turn'), false, 'already finished when Pit Wall first saw it');
  n.update('s1', 'other');
  assert.equal(n.update('s1', 'needs_you'), true);
  n.update('s1', 'other');
  assert.equal(n.update('s1', 'your_turn'), false, 'within the quiet period');
  advance(25_000);
  n.update('s1', 'other');
  assert.equal(n.update('s1', 'your_turn'), true);
  assert.equal(sent.length, 2);
});

test('terminal sessions only notify when blocked on you, not after every reply', async () => {
  const { terminalNotifyState } = await import('../src/notify.mjs');
  assert.equal(terminalNotifyState({ source: 'terminal', needsYou: { exact: true, reason: 'Waiting on a permission prompt' } }), 'needs_you');
  assert.equal(terminalNotifyState({ source: 'terminal', needsYou: { exact: true, reason: 'Finished — your turn', soft: true } }), 'other');
  assert.equal(terminalNotifyState({ source: 'terminal', needsYou: { exact: false, reason: 'Probably waiting' } }), 'other', 'guesses never notify');
  assert.equal(terminalNotifyState({ source: 'terminal', needsYou: null }), 'other');
});
