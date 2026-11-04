// Subagents and workflows. The fixture is a real `claude -p` stream captured on 2026-09-30 (strings trimmed):
// one foreground agent, one background agent, then a two-agent workflow, and the turns Claude is woken for afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { classify, workflowItem } from '../src/protocol.mjs';
import { Runner } from '../src/runner.mjs';
import { Scanner } from '../src/scanner.mjs';
import { readHistory, summariseTranscript } from '../src/transcripts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const capture = fs.readFileSync(path.join(here, 'fixtures', 'subagents-capture.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l));

function fakeSpawn(log) {
  return () => {
    const p = new EventEmitter();
    p.pid = 1000 + log.length;
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    p.stdin = { write: () => true };
    p.emitEvent = e => p.stdout.write(JSON.stringify(e) + '\n');
    log.push({ p });
    return p;
  };
}
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

test('classify: tasks carry their type, a workflow reports progress, an agent hands back a report', () => {
  const actions = capture.flatMap(e => classify(e));
  const starts = actions.filter(a => a.do === 'task_start').map(a => [a.task.type, a.task.background]);
  assert.deepEqual(starts, [['local_agent', false], ['local_agent', true], ['local_workflow', true]]);
  const wf = actions.filter(a => a.do === 'workflow').pop().item;
  assert.deepEqual(wf.phases, ['Probe']);
  assert.deepEqual(wf.agents.map(a => [a.label, a.state]), [['red', 'done'], ['blue', 'done']]);
  const reports = actions.filter(a => a.do === 'item' && a.item.report != null).map(a => a.item.report);
  assert.deepEqual(reports, ['alpha', 'a.txt\nerr.txt']);
  assert.ok(!actions.some(a => a.do === 'item' && a.item.tool === 'SubagentHandback'), 'the hand-back is the report, not a step');
});

test('runner: "your turn" waits until the agents and the workflow have finished', async () => {
  const log = [];
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn(log) });
  const seen = [];
  runner.on('run', r => { if (seen.at(-1)?.status !== r.status) seen.push({ status: r.status, agents: r.agentsWorking }); });
  const id = runner.start({ cwd: 'C:/x', message: 'go' });
  for (const e of capture) log[0].p.emitEvent(e);
  await tick(50);
  const statuses = seen.map(s => s.status);
  assert.equal(statuses.at(-1), 'your_turn');
  assert.equal(statuses.filter(s => s === 'your_turn').length, 1, `said "your turn" once: ${statuses.join(' → ')}`);
  assert.ok(statuses.indexOf('agents_working') > 0 && statuses.indexOf('agents_working') < statuses.indexOf('your_turn'));
  assert.ok(seen.find(s => s.status === 'agents_working').agents >= 1);

  const r = runner.get(id);
  const live = runner.liveItems(r);
  assert.ok(live.some(i => i.kind === 'sub' && i.report === 'alpha'), 'the agent’s report is kept');
  const wf = live.find(i => i.kind === 'workflow');
  assert.equal(wf.status, 'completed');
  assert.equal(wf.agents.length, 2);
  assert.ok(!r.items.some(i => i.kind === 'sub'), 'agent steps do not take up conversation slots');
  assert.deepEqual(runner.publicRun(r).jobs, []);
  await runner.shutdown();
});

test('runner: a background shell command does not hold up "your turn"; a finished agent with no reply still ends', async () => {
  const log = [];
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn(log), settleMs: 20 });
  const id = runner.start({ cwd: 'C:/x', message: 'start the dev server' });
  const { p } = log[0];
  p.emitEvent({ type: 'system', subtype: 'task_started', task_id: 'b1', task_type: 'local_bash', is_backgrounded: true, description: 'npm run dev' });
  p.emitEvent({ type: 'result', is_error: false });
  await tick();
  assert.equal(runner.get(id).status, 'your_turn');
  assert.equal(runner.publicRun(runner.get(id)).jobs[0].description, 'npm run dev');

  runner.send(id, 'now review it');
  p.emitEvent({ type: 'system', subtype: 'task_started', task_id: 'a1', task_type: 'local_agent', is_backgrounded: true, description: 'Review' });
  p.emitEvent({ type: 'result', is_error: false });
  await tick();
  assert.equal(runner.get(id).status, 'agents_working');
  p.emitEvent({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed' });
  await tick();
  assert.equal(runner.get(id).status, 'agents_working', 'waits for Claude’s reply to the finished agent');
  await tick(60);
  assert.equal(runner.get(id).status, 'your_turn', 'no reply came, so it is your turn anyway');
  await runner.shutdown();
});

// The 2026-10-01 email triage chat (relay log 3212e1fe): a fetch Claude was waiting on hit the 2-minute tool
// timeout and went to the background. Claude ended its reply ("I'll pick up once it finishes") and the board said
// "your turn" for three minutes while it was still working.
test('runner: a command Claude was waiting on that timed out into the background still counts as working', async () => {
  const log = [];
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn(log), settleMs: 20 });
  const id = runner.start({ cwd: 'C:/x', message: '/email-triage for Sam@ only' });
  const { p } = log[0];
  p.emitEvent({ type: 'system', subtype: 'task_started', task_id: 'bgr', tool_use_id: 'tu1', description: 'Fetch inboxes', is_backgrounded: false, task_type: 'local_bash' });
  p.emitEvent({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bgr', task_type: 'local_bash', description: 'Fetch inboxes' }] });
  p.emitEvent({ type: 'system', subtype: 'task_updated', task_id: 'bgr', patch: { is_backgrounded: true } });
  p.emitEvent({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'moved to the background' }] } });
  p.emitEvent({ type: 'result', is_error: false });
  await tick();
  const r = runner.get(id);
  assert.equal(r.status, 'agents_working');
  assert.deepEqual(runner.publicRun(r).jobs.map(({ startedAt, ...j }) => j), [{ id: 'bgr', type: 'local_bash', description: 'Fetch inboxes', working: true, toolUseId: 'tu1' }]);
  assert.equal(runner.publicRun(r).agentsWorking, 1);

  // It finished (as "failed" — the shell's exit), and Claude is woken without a message from Pit Wall.
  p.emitEvent({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  p.emitEvent({ type: 'system', subtype: 'task_updated', task_id: 'bgr', patch: { status: 'failed' } });
  p.emitEvent({ type: 'system', subtype: 'task_notification', task_id: 'bgr', tool_use_id: 'tu1', status: 'failed' });
  p.emitEvent({ type: 'stream_event', event: { type: 'message_start', message: {} } });
  await tick();
  assert.equal(r.status, 'busy');
  p.emitEvent({ type: 'result', is_error: false });
  await tick();
  assert.equal(r.status, 'your_turn');
  await runner.shutdown();
});

test('runner: a waited-on command still going after the cap is treated as a server, so "your turn" comes back', async () => {
  const log = [];
  let clock = Date.parse('2026-10-01T14:00:00Z');
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn(log), settleMs: 20,
    awaitCapMs: 60, now: () => new Date(clock).toISOString() });
  const id = runner.start({ cwd: 'C:/x', message: 'start it' });
  const { p } = log[0];
  p.emitEvent({ type: 'system', subtype: 'task_started', task_id: 'b1', is_backgrounded: false, task_type: 'local_bash', description: 'npm run dev' });
  p.emitEvent({ type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { is_backgrounded: true } });
  p.emitEvent({ type: 'result', is_error: false });
  await tick();
  assert.equal(runner.get(id).status, 'agents_working');
  clock += 1000;
  await tick(120);
  assert.equal(runner.get(id).status, 'your_turn');
  assert.equal(runner.publicRun(runner.get(id)).jobs[0].working, false, 'still listed as running in the background');
  await runner.shutdown();
});

test('runner: the cap is for commands only — a foreground agent moved to the background keeps working', async () => {
  const log = [];
  let clock = Date.parse('2026-10-01T14:00:00Z');
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn(log), settleMs: 20,
    awaitCapMs: 60, now: () => new Date(clock).toISOString() });
  const id = runner.start({ cwd: 'C:/x', message: 'review' });
  const { p } = log[0];
  p.emitEvent({ type: 'system', subtype: 'task_started', task_id: 'a1', is_backgrounded: false, task_type: 'local_agent', description: 'Review' });
  p.emitEvent({ type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { is_backgrounded: true } });
  p.emitEvent({ type: 'result', is_error: false });
  clock += 1000;
  await tick(120);
  assert.equal(runner.get(id).status, 'agents_working');
  await runner.shutdown();
});

test('runner: run_in_background as Claude Code sends it (list first, then task_started) is not work', async () => {
  const log = [];
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn(log), settleMs: 20 });
  const id = runner.start({ cwd: 'C:/x', message: 'sleep in the background' });
  const { p } = log[0];
  p.emitEvent({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'Sleep' }] });
  p.emitEvent({ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'tu1', description: 'Sleep', is_backgrounded: true, task_type: 'local_bash' });
  p.emitEvent({ type: 'result', is_error: false });
  await tick();
  assert.equal(runner.get(id).status, 'your_turn');
  assert.equal(runner.publicRun(runner.get(id)).jobs[0].working, false);
  await runner.shutdown();
});

test('runner: answering a background agent’s permission prompt goes back to "agents working", then "your turn"', async () => {
  const log = [];
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn: fakeSpawn(log), settleMs: 20 });
  const id = runner.start({ cwd: 'C:/x', message: 'review in the background' });
  const { p } = log[0];
  p.emitEvent({ type: 'system', subtype: 'task_started', task_id: 'a1', task_type: 'local_agent', is_backgrounded: true });
  p.emitEvent({ type: 'result', is_error: false });
  p.emitEvent({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
  await tick();
  assert.equal(runner.get(id).status, 'needs_you');
  runner.answer(id, 'r1', { behavior: 'allow' });
  assert.equal(runner.get(id).status, 'agents_working');
  p.emitEvent({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed' });
  await tick(60);
  assert.equal(runner.get(id).status, 'your_turn');
  await runner.shutdown();
});

// ── history from disk ─────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-sub-'));
const ts = n => new Date(Date.now() - (60 - n) * 60_000).toISOString();
const jsonl = (file, entries) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n'); };
const notice = (id, summary) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`;

function session(name, { finished }) {
  const file = path.join(dir, `${name}.jsonl`);
  const sdir = path.join(dir, name);
  const wfDir = path.join(sdir, 'subagents', 'workflows', 'wf_abc-123');
  const entries = [
    { type: 'user', sessionId: name, timestamp: ts(1), message: { content: 'Review the branch with agents' } },
    { type: 'assistant', sessionId: name, timestamp: ts(2), message: { content: [
      { type: 'tool_use', id: 'tA', name: 'Agent', input: { description: 'Review task 2', prompt: 'x', run_in_background: true } },
      { type: 'tool_use', id: 'tW', name: 'Workflow', input: { script: 'export const meta = {}' } }] } },
    { type: 'user', sessionId: name, timestamp: ts(3), message: { content: [
      { type: 'tool_result', tool_use_id: 'tA', content: [{ type: 'text', text: 'Async agent launched successfully. (internal)\nagentId: a111 (internal ID)' }] },
      { type: 'tool_result', tool_use_id: 'tW', content: `Workflow launched in background. Task ID: w222\nSummary: Probe\nTranscript dir: ${wfDir}` }] } },
    { type: 'assistant', sessionId: name, timestamp: ts(4), message: { content: [{ type: 'text', text: 'Launched both.' }] } },
  ];
  if (finished) entries.push(
    { type: 'user', sessionId: name, timestamp: ts(5), origin: { kind: 'task-notification' }, message: { content: notice('a111', 'Agent "Review task 2" finished') } },
    { type: 'queue-operation', operation: 'enqueue', timestamp: ts(6), content: notice('w222', 'Workflow done') },
    { type: 'assistant', sessionId: name, timestamp: ts(7), message: { content: [{ type: 'text', text: 'All done.' }] } });
  jsonl(file, entries);
  fs.mkdirSync(path.join(sdir, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(sdir, 'subagents', 'agent-a111.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'tA' }));
  jsonl(path.join(sdir, 'subagents', 'agent-a111.jsonl'), [
    { type: 'user', isSidechain: true, timestamp: ts(3), message: { content: 'x' } },
    { type: 'assistant', isSidechain: true, timestamp: ts(3), message: { content: [{ type: 'tool_use', id: 's1', name: 'Grep', input: { pattern: 'TODO' } }] } },
    { type: 'assistant', isSidechain: true, timestamp: ts(4), message: { content: [{ type: 'tool_use', id: 's2', name: 'SubagentHandback', input: { message: '**Two** problems found.' } }] } },
  ]);
  jsonl(path.join(wfDir, 'journal.jsonl'), [
    { type: 'launched' },
    { type: 'started', agentId: 'r1', label: 'red', phase: 'Probe' },
    { type: 'started', agentId: 'b1', label: 'blue', phase: 'Probe' },
    { type: 'result', agentId: 'r1', result: 'RED' },
  ]);
  if (finished) {
    fs.mkdirSync(path.join(sdir, 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(sdir, 'workflows', 'wf_abc-123.json'), JSON.stringify({ workflowName: 'probe', status: 'completed', workflowProgress: [
      { type: 'workflow_phase', index: 1, title: 'Probe' },
      { type: 'workflow_agent', label: 'red', phaseTitle: 'Probe', state: 'done', resultPreview: 'RED' },
      { type: 'workflow_agent', label: 'blue', phaseTitle: 'Probe', state: 'done', resultPreview: 'BLUE' }] }));
  }
  return file;
}

test('history: agent steps, the agent’s report and workflow progress come back from disk', () => {
  const { items } = readHistory(session('done', { finished: true }));
  assert.deepEqual(items.filter(i => i.kind === 'sub' && i.parent === 'tA').map(i => i.tool ?? i.report), ['Grep', '**Two** problems found.']);
  const wf = items.find(i => i.kind === 'workflow');
  assert.equal(wf.parent, 'tW');
  assert.equal(wf.status, 'completed');
  assert.deepEqual(wf.agents.map(a => a.state), ['done', 'done']);
  // A "job finished" notice is a note, never a message from you.
  assert.deepEqual(items.filter(i => i.kind === 'user').map(i => i.text), ['Review the branch with agents']);
  assert.ok(items.some(i => i.kind === 'note' && i.text === 'Agent "Review task 2" finished'));
});

test('history: a workflow with no finished record is rebuilt from its journal', () => {
  const wf = readHistory(session('open', { finished: false })).items.find(i => i.kind === 'workflow');
  assert.deepEqual(wf.agents.map(a => [a.label, a.state]), [['red', 'done'], ['blue', 'running']]);
  assert.equal(wf.status, 'unknown');
});

test('summary: launched jobs stay open until their notice arrives, and a notice is not your prompt', () => {
  assert.deepEqual(summariseTranscript(path.join(dir, 'open.jsonl')).openJobs.map(j => [j.id, j.type]), [['a111', 'agent'], ['w222', 'workflow']]);
  const done = summariseTranscript(path.join(dir, 'done.jsonl'));
  assert.deepEqual(done.openJobs, []);
  assert.equal(done.lastAssistant, 'All done.');
});

test('board: a terminal whose agents are still running is working, not "your turn"', () => {
  const projects = path.join(dir, 'projects'), sessions = path.join(dir, 'sessions');
  fs.mkdirSync(path.join(projects, 'C--repo'), { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  for (const n of ['open', 'done']) {
    fs.cpSync(path.join(dir, `${n}.jsonl`), path.join(projects, 'C--repo', `${n}.jsonl`));
    fs.writeFileSync(path.join(sessions, `${n}.json`), JSON.stringify({ pid: n === 'open' ? 11 : 12, sessionId: n, cwd: 'C:\\repo', name: n, status: 'idle', startedAt: Date.now() - 3 * 3600_000 }));
  }
  const scanner = new Scanner({ sessionsDir: sessions, projectsDir: projects, recentDays: 7, isExcludedProjectDir: () => false, pidAlive: () => true });
  const hook = at => ({ state: 'stopped', at: new Date(at).toISOString() });
  const rows = scanner.board({ runs: new Map(), meta: new Map(), excludePids: new Set(),
    hookStatus: new Map([['open', hook(Date.now() + 1000)], ['done', hook(Date.now() + 1000)]]) });
  const open = rows.find(r => r.id === 'open'), done = rows.find(r => r.id === 'done');
  assert.equal(open.status, 'agents_working');
  assert.equal(open.jobs, 2);
  assert.equal(open.needsYou, null);
  assert.equal(done.status, 'idle');
  assert.equal(done.needsYou.reason, 'Finished — your turn');

  // The same launches from before this terminal process started died with the old one.
  fs.writeFileSync(path.join(sessions, 'open.json'), JSON.stringify({ pid: 11, sessionId: 'open', cwd: 'C:\\repo', name: 'open', status: 'idle', startedAt: Date.now() }));
  const again = scanner.board({ runs: new Map(), meta: new Map(), excludePids: new Set(), hookStatus: new Map() }).find(r => r.id === 'open');
  assert.equal(again.status, 'idle');
});

test('workflowItem: unknown agent states pass through, phases come from agents when not listed', () => {
  const w = workflowItem('t', { progress: [{ type: 'workflow_agent', label: 'a', phaseTitle: 'Late', state: 'retrying' }] });
  assert.deepEqual(w.phases, ['Late']);
  assert.equal(w.agents[0].state, 'retrying');
});

test('board: a chat Pit Wall was running comes back resting after a restart, not closed', () => {
  const projects = path.join(dir, 'projects2');
  fs.mkdirSync(path.join(projects, 'C--repo'), { recursive: true });
  for (const n of ['mine', 'other', 'old']) fs.cpSync(path.join(dir, 'done.jsonl'), path.join(projects, 'C--repo', `${n}.jsonl`));
  const scanner = new Scanner({ sessionsDir: path.join(dir, 'none'), projectsDir: projects, recentDays: 7, isExcludedProjectDir: () => false });
  const meta = new Map([
    ['mine', { session_id: 'mine', run_here: 1 }],
    ['old', { session_id: 'old', run_here: 1, superseded_by: 'mine' }],
  ]);
  const rows = scanner.board({ runs: new Map(), meta, excludePids: new Set() });
  const by = id => rows.find(r => r.id === id);
  assert.deepEqual([by('mine').source, by('mine').status], ['pitwall', 'parked']);
  assert.equal(by('other').source, 'closed');
  assert.equal(by('old').source, 'closed', 'replaced by a fresh start');
});
