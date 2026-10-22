import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.mjs';
import { main as inboxHook } from '../src/hook-inbox.mjs';

const SID = '11111111-2222-3333-4444-555555555555';

test('a status change you make is recorded; the organiser can’t touch your items', () => {
  const store = openDb(':memory:');
  const pid = store.createProject('Call List', '');
  const id = store.addChecklistItem(pid, 'Deploy callback fix', 'blocked');
  assert.equal(store.updateChecklistItem(id, { state: 'blocked' }, 'user'), null, 'no event when nothing changed');
  const e = store.updateChecklistItem(id, { state: 'live' }, 'user');
  assert.deepEqual([e.from_state, e.to_state, e.by, e.item_text], ['blocked', 'live', 'user', 'Deploy callback fix']);
  assert.equal(store.updateChecklistItem(id, { state: 'todo' }, 'organiser'), null, 'locked by you');
  assert.equal(store.checklistItem(id).state, 'live');
  assert.equal(store.checklistHistory([id]).length, 1);
});

test('only your undelivered changes that name a chat are waiting to be told', () => {
  const store = openDb(':memory:');
  const pid = store.createProject('P', '');
  const a = store.addChecklistItem(pid, 'A');
  const b = store.addChecklistItem(pid, 'B');
  const ea = store.updateChecklistItem(a, { state: 'live' }, 'user');
  const eb = store.updateChecklistItem(b, { state: 'doing' }, 'user');
  store.updateChecklistEvent(ea.id, { sessionId: SID, note: 'deployed' });
  assert.deepEqual(store.undeliveredEvents(SID).map(e => e.item_text), ['A'], 'B has no chat');
  store.updateChecklistEvent(ea.id, { delivered: true });
  assert.equal(store.undeliveredEvents(SID).length, 0);
  assert.equal(store.checklistEvent(ea.id).note, 'deployed');
  assert.ok(eb);
});

test('the inbox hook hands a waiting note to the chat once, then marks it delivered', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-inbox-'));
  const payload = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: SID, prompt: 'hi' });
  assert.equal(inboxHook(payload, dir), null, 'no note, no output');
  fs.writeFileSync(path.join(dir, `${SID}.json`), JSON.stringify({ ids: [7], message: 'Sam marked "A" as Done (deployed).' }));
  const out = JSON.parse(inboxHook(payload, dir));
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /Done \(deployed\)/);
  assert.ok(fs.existsSync(path.join(dir, `${SID}.delivered.json`)), 'moved aside for Pit Wall to record');
  assert.equal(inboxHook(payload, dir), null, 'not repeated on the next prompt');
  assert.equal(inboxHook(JSON.stringify({ hook_event_name: 'Stop', session_id: SID }), dir), null, 'other events ignored');
  assert.equal(inboxHook('not json', dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── finishing a chat ─────────────────────────────────────────────────────
import { Scanner } from '../src/scanner.mjs';

test('a finished chat leaves the board and stops needing you, until something new happens in it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-done-'));
  const projects = path.join(home, 'projects', 'C--work');
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const at = '2026-09-30T09:00:00.000Z';
  const line = o => JSON.stringify({ sessionId: SID, cwd: 'C:/work', timestamp: at, ...o });
  fs.writeFileSync(path.join(projects, `${SID}.jsonl`), [
    line({ type: 'user', message: { role: 'user', content: 'do the thing' } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done. Shall I deploy?' }] } }),
  ].join('\n'));
  const scanner = new Scanner({ sessionsDir: path.join(home, 'sessions'), projectsDir: path.join(home, 'projects'), recentDays: 99999, isExcludedProjectDir: () => false });
  const board = meta => scanner.board({ runs: new Map(), meta: new Map([[SID, { session_id: SID, ...meta }]]), excludePids: new Set() }).find(r => r.id === SID);

  assert.ok(!board({}).done, 'not finished by default');
  const finished = board({ done_at: '2026-09-30T10:00:00.000Z', interrupted: 1 });
  assert.equal(finished.done, true);
  assert.equal(finished.needsYou, null, 'a finished chat never needs you');
  assert.ok(!board({ done_at: '2026-09-30T08:00:00.000Z' }).done, 'activity after you finished it reopens it');

  const store = openDb(':memory:');
  store.upsertSession(SID, { done_at: '2026-09-30T10:00:00.000Z' });
  assert.equal(store.sessionMeta(SID).done_at, '2026-09-30T10:00:00.000Z');
  store.upsertSession(SID, { done_at: null });
  assert.equal(store.sessionMeta(SID).done_at, null, 'reopen clears it');
  fs.rmSync(home, { recursive: true, force: true });
});

test('automated SDK runs (security reviews and the like) stay off the board', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-sdk-'));
  const projects = path.join(home, 'projects', 'C--work');
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const REVIEW = '99999999-2222-3333-4444-555555555555';
  const write = (id, entrypoint) => fs.writeFileSync(path.join(projects, `${id}.jsonl`), [
    { type: 'user', sessionId: id, cwd: 'C:/work', entrypoint, timestamp: '2026-09-30T09:00:00.000Z', message: { role: 'user', content: 'Review this change for security vulnerabilities.' } },
    { type: 'assistant', sessionId: id, cwd: 'C:/work', entrypoint, timestamp: '2026-09-30T09:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'No findings.' }] } },
  ].map(e => JSON.stringify(e)).join('\n'));
  write(SID, 'cli');
  write(REVIEW, 'sdk-py');
  const scanner = new Scanner({ sessionsDir: path.join(home, 'sessions'), projectsDir: path.join(home, 'projects'), recentDays: 99999, isExcludedProjectDir: () => false });
  const ids = scanner.board({ runs: new Map(), meta: new Map(), excludePids: new Set() }).map(r => r.id);
  assert.ok(ids.includes(SID), 'your own chat is listed');
  assert.ok(!ids.includes(REVIEW), 'the automated review is not');
});
