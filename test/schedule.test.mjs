import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { nextCronTime, scheduleCheck, checkState, titleFrom, GRACE_MS } from '../src/schedule.mjs';
import { main as cronHook, MIN_AHEAD_MS } from '../src/hook-cron.mjs';

const local = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi);

test('cron: a one-shot is the next local time it comes round, not UTC', () => {
  // The lost Tier 1 check: "23 8 7 10 *" made at 15:58 on 6 Oct = 08:23 local on 7 Oct.
  assert.deepEqual(nextCronTime('23 8 7 10 *', local(2026, 10, 6, 15, 58)), local(2026, 10, 7, 8, 23));
  // Same expression after it has passed this year → next year.
  assert.deepEqual(nextCronTime('23 8 7 10 *', local(2026, 10, 7, 9, 0)), local(2027, 10, 7, 8, 23));
  // Strictly after `from`.
  assert.deepEqual(nextCronTime('23 8 * * *', local(2026, 10, 7, 8, 23)), local(2026, 10, 8, 8, 23));
});

test('cron: lists, ranges, steps, weekdays (Sunday is 0 or 7)', () => {
  assert.deepEqual(nextCronTime('*/15 * * * *', local(2026, 10, 7, 10, 1)), local(2026, 10, 7, 10, 15));
  assert.deepEqual(nextCronTime('0 9 * * 1-5', local(2026, 10, 9, 10, 0)), local(2026, 10, 12, 9, 0)); // Fri → Mon
  assert.deepEqual(nextCronTime('0 9 * * 7', local(2026, 10, 7, 10, 0)), local(2026, 10, 11, 9, 0)); // → Sun
  assert.deepEqual(nextCronTime('30 6,18 * * *', local(2026, 10, 7, 7, 0)), local(2026, 10, 7, 18, 30));
  assert.equal(nextCronTime('nonsense'), null);
  assert.equal(nextCronTime('61 * * * *'), null);
  assert.equal(nextCronTime('0 0 31 2 *', local(2026, 1, 1, 0, 0)), null, 'never fires');
});

test('titleFrom: first meaningful line, trimmed to a short title', () => {
  assert.equal(titleFrom('\n  Tier 1 morning check (plan: x)  \nmore'), 'Tier 1 morning check (plan: x)');
  assert.ok(titleFrom('word '.repeat(40)).length <= 80);
});

test('scheduleCheck writes a queued job with a start time plus a follow-up that watches it', () => {
  const store = openDb(':memory:');
  const at = new Date(Date.now() + 3_600_000);
  const r = scheduleCheck(store, { at, prompt: 'Check the sync log\nthen report', cwd: 'C:/x', sessionId: 'abc' });
  const job = store.queueItem(r.queueId);
  assert.equal(job.status, 'queued');
  assert.equal(job.start_at, at.toISOString());
  assert.equal(job.title, 'Check the sync log');
  assert.match(job.prompt, /by chat abc[\s\S]*do not try to work round it[\s\S]*Check the sync log\nthen report$/);
  const [f] = store.followups();
  assert.equal(f.queue_id, r.queueId);
  assert.equal(f.session_id, 'abc');
  assert.equal(Date.parse(f.due_at), at.getTime() + GRACE_MS);
  assert.equal(f.text, 'Scheduled check: Check the sync log');
});

test('scheduleCheck with the Queue off (team installs): a follow-up only, due at the time', () => {
  const store = openDb(':memory:');
  const at = new Date(Date.now() + 3_600_000);
  const r = scheduleCheck(store, { at, prompt: 'Look at X', cwd: 'C:/x', automation: false });
  assert.equal(r.queueId, null);
  assert.equal(store.queue().length, 0);
  assert.equal(Date.parse(store.followups()[0].due_at), at.getTime());
  assert.match(store.followups()[0].text, /run it yourself/);
});

test('checkState: waiting → running → ran; never-started, failed and removed jobs are missed', () => {
  const start = Date.parse('2026-10-07T07:23:00Z');
  const f = { text: 'Scheduled check: T1', due_at: new Date(start + GRACE_MS).toISOString(), session_id: 'origin' };
  const job = { title: 'T1', status: 'queued', start_at: new Date(start).toISOString(), session_id: null };
  assert.equal(checkState(f, job, { now: start + 60_000 }).state, null, 'waiting inside its grace');
  const late = checkState(f, job, { now: start + GRACE_MS + 1, why: 'Paused by you' });
  assert.equal(late.state, 'missed');
  assert.match(late.text, /^Missed: T1 — not started \(Paused by you\)/);
  assert.equal(late.sessionId, 'origin');
  assert.equal(checkState(f, { ...job, status: 'running', session_id: 'job' }).state, 'running');
  const ran = checkState(f, { ...job, status: 'done', session_id: 'job' });
  assert.deepEqual([ran.state, ran.sessionId], ['ran', 'job']);
  const failed = checkState(f, { ...job, status: 'failed', result: 'Interrupted — Pit Wall restarted during this job.\nmore' });
  assert.equal(failed.state, 'missed');
  assert.match(failed.text, /Interrupted — Pit Wall restarted during this job\.$/);
  assert.equal(checkState(f, undefined).state, 'missed');
});

test('CronCreate hook: a later one-shot is saved and the session-only cron denied', async () => {
  const now = local(2026, 10, 6, 15, 58);
  const calls = [];
  const schedule = async a => { calls.push(a); return { queueId: 7, at: a.at }; };
  const payload = { hook_event_name: 'PreToolUse', tool_name: 'CronCreate', session_id: 's1', cwd: 'C:/repo',
    tool_input: { cron: '23 8 7 10 *', recurring: false, prompt: 'Tier 1 morning check. READ-ONLY.' } };
  const out = JSON.parse(await cronHook(JSON.stringify(payload), { schedule, nextCronTime, now }));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /lasting scheduled job #7[\s\S]*Do NOT call CronCreate again/);
  assert.deepEqual(calls[0], { at: local(2026, 10, 7, 8, 23), prompt: 'Tier 1 morning check. READ-ONLY.', cwd: 'C:/repo', sessionId: 's1' });
});

test('CronCreate hook: recurring, near, unparseable and other tools pass through untouched', async () => {
  const now = local(2026, 10, 6, 15, 58);
  let called = 0;
  const deps = { schedule: async () => { called++; return { queueId: 1 }; }, nextCronTime, now };
  const base = { hook_event_name: 'PreToolUse', tool_name: 'CronCreate', session_id: 's1', cwd: 'C:/repo' };
  const run = input => cronHook(JSON.stringify({ ...base, tool_input: input }), deps);
  assert.equal(await run({ cron: '*/10 * * * *', prompt: '/babysit', recurring: true }), null, '/loop');
  assert.equal(await run({ cron: '*/10 * * * *', prompt: '/babysit' }), null, 'recurring by default');
  const soon = new Date(now.getTime() + MIN_AHEAD_MS - 60_000);
  assert.equal(await run({ cron: `${soon.getMinutes()} ${soon.getHours()} * * *`, prompt: 'x', recurring: false }), null, 'near one-shot');
  assert.equal(await run({ cron: 'bad', prompt: 'x', recurring: false }), null);
  assert.equal(await cronHook(JSON.stringify({ ...base, tool_name: 'Bash', tool_input: {} }), deps), null);
  assert.equal(await cronHook('not json', deps), null);
  assert.equal(called, 0);
});
