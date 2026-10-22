import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDue, describeSchedule } from '../src/insights.mjs';
import { openDb } from '../src/db.mjs';
import { Queue } from '../src/queue.mjs';

test('agents can run every N minutes', () => {
  const role = { schedule_kind: 'minutes', every_minutes: 10, last_run_at: '2026-10-06T10:00:00.000Z' };
  assert.equal(nextDue(role, new Date('2026-10-06T10:05:00Z')).toISOString(), '2026-10-06T10:10:00.000Z');
  assert.equal(nextDue({ ...role, last_run_at: null }, new Date('2026-10-06T10:05:00Z')).toISOString(), '2026-10-06T10:05:00.000Z');
  assert.equal(describeSchedule(role), 'Every 10 min');
});

test('agents can run once at a time, and not again after it', () => {
  const role = { schedule_kind: 'once', run_at: '2026-10-06T12:00:00.000Z', last_run_at: null };
  assert.equal(nextDue(role, new Date('2026-10-06T11:00:00Z')).toISOString(), '2026-10-06T12:00:00.000Z');
  assert.equal(nextDue({ ...role, last_run_at: '2026-10-06T12:00:30.000Z' }, new Date('2026-10-06T13:00:00Z')), null);
  assert.match(describeSchedule(role), /^Once at /);
  assert.match(describeSchedule({ ...role, last_run_at: '2026-10-06T12:00:30.000Z' }), /^Ran once/);
});

test('a queued job with a start time waits until then', () => {
  const store = openDb(':memory:');
  let now = new Date('2026-10-06T11:00:00Z');
  const started = [];
  const runner = { start: o => { started.push(o); return 's1'; }, get: () => null };
  const queue = new Queue({ store, runner, config: { dailyJobCap: 10, fiveHourMax: 0.6, weekMax: 0.8, maxAgeMin: 30 }, onChange: () => {}, requestReading: () => {}, now: () => now });
  store.set('rate', { capturedAt: now.toISOString(), unifiedWindows: { five_hour: { utilization: 0.1 }, seven_day: { utilization: 0.1 } } });
  store.addQueueItem({ title: 'Noon job', prompt: 'p', cwd: 'C:/x', startAt: '2026-10-06T12:00:00.000Z' });
  queue.tick();
  assert.equal(started.length, 0, 'not before its time');
  assert.match(queue.status().why, /start time/i);
  now = new Date('2026-10-06T12:00:05Z');
  store.set('rate', { capturedAt: now.toISOString(), unifiedWindows: { five_hour: { utilization: 0.1 }, seven_day: { utilization: 0.1 } } });
  queue.tick();
  assert.equal(started.length, 1);
});
