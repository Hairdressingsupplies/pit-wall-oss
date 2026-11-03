import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/protocol.mjs';
import { openDb } from '../src/db.mjs';
import { rateEvent } from '../src/codex-translate.mjs';

test('codex_rate_event never lands in kv rate', () => {
  const a = classify(rateEvent({ primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1 } }));
  assert.deepEqual(a.map(x => x.do), ['rate_codex']);
  assert.ok(!classify({ type: 'rate_limit_event', rate_limit_info: {} }).some(x => x.do === 'rate_codex'));
});

test('rate history keeps engines apart', () => {
  const s = openDb(':memory:');
  const ago = mins => new Date(Date.now() - mins * 60_000).toISOString(); // recent: readings over 8 days old are purged
  s.addRateReading(ago(2), 0.1, 0.2, null);
  s.addRateReading(ago(1), 0.5, 0.6, null, 'codex');
  const claude = s.rateReadingsSince(ago(60));
  assert.equal(claude.length, 1);
  assert.equal(claude[0].five, 0.1);
  assert.equal(s.rateReadingsSince(ago(60), 'codex')[0].five, 0.5);
});
