import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canTakeOver, readHookStatus } from '../src/takeover.mjs';
import { stateFor } from '../src/hook-status.mjs';
import { describeTrigger, jobsFromTasks, describeResult } from '../src/jobs.mjs';
import { Search } from '../src/search.mjs';
import { openDb } from '../src/db.mjs';

test('Move here only ends an idle terminal whose process identity matches', () => {
  const term = { status: 'idle', procStart: '134351482989022227' };
  assert.equal(canTakeOver({ term, hook: null, actualStart: '134351482989022227' }).ok, true);
  assert.equal(canTakeOver({ term: null }).ok, false);
  assert.match(canTakeOver({ term: { ...term, status: 'busy' }, actualStart: term.procStart }).why, /busy/);
  assert.match(canTakeOver({ term, hook: { state: 'permission' }, actualStart: term.procStart }).why, /middle of something/);
  assert.match(canTakeOver({ term, actualStart: '134351482999999999' }).why, /belongs to something else/, 'reused PID');
  assert.match(canTakeOver({ term, actualStart: null }).why, /Could not confirm/);
});

test('status hook maps Claude Code events to states', () => {
  assert.deepEqual(stateFor({ hook_event_name: 'UserPromptSubmit' }), { state: 'busy', message: null });
  assert.deepEqual(stateFor({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }),
    { state: 'permission', message: 'Claude needs your permission to use Bash' });
  assert.equal(stateFor({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }).state, 'idle');
  assert.equal(stateFor({ hook_event_name: 'Stop' }).state, 'stopped');
  assert.equal(stateFor({ hook_event_name: 'SessionEnd' }), 'end');
  assert.equal(stateFor({ hook_event_name: 'PreToolUse' }), null);
});

test('readHookStatus reads the status folder and skips junk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-hook-'));
  fs.writeFileSync(path.join(dir, 'aaa.json'), JSON.stringify({ state: 'stopped', at: '2026-09-29T10:00:00Z' }));
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
  assert.deepEqual([...readHookStatus(dir, Date.parse('2026-09-29T11:00:00Z')).keys()], ['aaa']);
  assert.equal(readHookStatus(path.join(dir, 'missing')).size, 0);
});

test('scheduled jobs: only your automation, readable schedules and results', () => {
  const jobs = jobsFromTasks([
    { name: 'Claude Weekly Summary', path: '\\', state: 'Ready', actions: ['C:\\Users\\x\\.local\\bin\\claude.exe -p "hi"'], workingDir: [''], lastRun: '2026-09-24T16:30:00Z', lastResult: 0, nextRun: null, triggers: [{ kind: 'Weekly', days: 16, at: '16:30' }] },
    { name: 'Local DB Refresh', path: '\\', state: 'Ready', actions: ['bash.exe "C:\\Users\\x\\Documents\\GitHub\\ops\\refresh.sh"'], workingDir: [''], lastRun: '2026-09-27T07:00:00Z', lastResult: 1, nextRun: null, triggers: [{ kind: 'Weekly', days: 1, at: '07:00' }] },
    { name: 'Firefox update', path: '\\Mozilla\\', state: 'Ready', actions: ['firefox.exe'], workingDir: [''], lastRun: null, lastResult: 0, nextRun: null, triggers: [] },
  ]);
  assert.deepEqual(jobs.map(j => j.name), ['Claude Weekly Summary', 'Local DB Refresh']);
  assert.equal(jobs[0].schedule, 'Weekly on Thu at 16:30');
  assert.equal(jobs[1].ok, false);
  assert.equal(jobs[1].lastResult, 'Failed (exit code 1)');
  assert.equal(describeTrigger({ kind: 'Daily', every: 1, at: '08:00' }), 'Daily at 08:00');
  assert.equal(describeResult(267011), 'Never run');
});

test('search finds text in transcripts, newest first, with snippets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-search-'));
  const dir = path.join(root, 'C--repo');
  fs.mkdirSync(dir);
  const line = o => JSON.stringify(o) + '\n';
  fs.writeFileSync(path.join(dir, 'a1.jsonl'), line({ type: 'ai-title', aiTitle: 'Callback fix' })
    + line({ type: 'user', cwd: 'C:\\repo', message: { content: 'Please fix the Acme Gizmo margin report' } }));
  fs.writeFileSync(path.join(dir, 'b2.jsonl'), line({ type: 'user', message: { content: 'Nothing relevant here' } }));
  const s = new Search({ projectsDir: root, isExcludedProjectDir: () => false });
  const r = await s.run('gizmo');
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].sessionId, 'a1');
  assert.equal(r.results[0].title, 'Callback fix');
  assert.match(r.results[0].snippets[0].text, /Acme Gizmo margin/);
  await assert.rejects(s.run('ab'), /at least 3/);
});

test('database migrates old files and backs up', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-db-'));
  const store = openDb(path.join(dir, 'p.db'));
  store.upsertSession('x', { effort: 'high', interrupted: true });
  assert.equal(store.sessionMeta('x').effort, 'high');
  assert.equal(store.interruptedSessions().length, 1);
  store.backupTo(path.join(dir, 'backup.db'));
  assert.ok(fs.statSync(path.join(dir, 'backup.db')).size > 0);
});
