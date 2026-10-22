import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDb } from '../src/db.mjs';
import { applyResult, buildPrompt, Organiser } from '../src/organiser.mjs';
import { userSettings } from '../src/config.mjs';

test('applyResult creates, assigns and builds checklists, respecting Rob’s locks', () => {
  const store = openDb(':memory:');
  const mine = store.createProject('Pricing: my name', '', { locked: true });
  store.upsertSession('locked-s', { project_id: mine, project_locked: 1 });
  const keys = new Map([['s1', 'a'], ['s2', 'locked-s'], ['s3', 'c']]);
  const r = applyResult(store, {
    new_projects: [{ key: 'n1', name: 'Call list: callback fix', description: 'd' }],
    project_updates: [{ id: `p${mine}`, name: 'Renamed by model' }],
    assignments: [{ session: 's1', project: 'n1' }, { session: 's2', project: 'n1' }, { session: 's3', project: 'p999' }],
    checklist: [{ project: 'n1', add: [{ text: 'Deploy fix', state: 'built' }, { text: 'deploy fix', state: 'todo' }], update: [] }],
  }, keys);
  assert.equal(r.created, 1);
  assert.equal(store.project(mine).name, 'Pricing: my name', 'user-named project kept');
  const n1 = store.projects().find(p => p.name === 'Call list: callback fix').id;
  assert.equal(store.sessionMeta('a').project_id, n1);
  assert.equal(store.sessionMeta('locked-s').project_id, mine, 'hand-filed session not moved');
  assert.equal(store.sessionMeta('c'), undefined, 'unknown project ref ignored');
  assert.deepEqual(store.checklist(n1).map(c => [c.text, c.state]), [['Deploy fix', 'built']]);

  const item = store.checklist(n1)[0];
  store.updateChecklistItem(item.id, { state: 'live' }, 'user');
  applyResult(store, { new_projects: [], project_updates: [], assignments: [], checklist: [{ project: `p${n1}`, update: [{ id: item.id, state: 'todo' }] }] }, keys);
  assert.equal(store.checklist(n1)[0].state, 'live', 'user-set item not overwritten');
});

test('checklist items remember the session they came from, so the task can reopen that chat', () => {
  const store = openDb(':memory:');
  const pid = store.createProject('Ads: budget cap', '');
  const keys = new Map([['s1', 'sess-a']]);
  applyResult(store, { new_projects: [], project_updates: [], assignments: [],
    checklist: [{ project: `p${pid}`, add: [{ text: 'Check the cap', state: 'todo', session: 's1' }, { text: 'No source', state: 'todo', session: 's9' }] }] }, keys);
  const items = store.checklist(pid);
  assert.equal(items.find(c => c.text === 'Check the cap').source_session, 'sess-a');
  assert.equal(items.find(c => c.text === 'No source').source_session, null, 'unknown session key stored as none');
  assert.equal(store.checklistItem(items[0].id).text, items[0].text);
});

test('buildPrompt includes projects, checklist ids and sessions', () => {
  const p = buildPrompt([{ id: 3, name: 'X: y', description: 'd', name_locked: 1, checklist: [{ id: 9, state: 'todo', text: 'a', locked: 0 }] }],
    [{ key: 's1', projectId: null, folder: 'laravel', branch: 'main', title: 'T', firstPrompt: 'F' }], { name: 'Sam', their: 'her', about: 'runs Acme: a shop and a blog.' });
  assert.match(p, /p3: "X: y" \(name set by Sam/);
  assert.match(p, /#9 todo/);
  assert.match(p, /s1: current project none; folder laravel @ main/);
});

test('Organiser respects the daily cap and only picks quiet, changed sessions', async () => {
  const store = openDb(':memory:');
  let calls = 0;
  const org = new Organiser({ store, config: { dailyCallCap: 1, debounceMs: 0, batchSize: 10, model: 'haiku' }, claudeExe: 'x', cwd: 'x',
    callModelFn: async () => { calls++; return { ok: true, costUsd: 0.01, data: { new_projects: [], project_updates: [], assignments: [], checklist: [] } }; } });
  const old = new Date(Date.now() - 5 * 60_000).toISOString();
  const rows = [
    { id: 'quiet', transcript: 'f', mtimeMs: 10, title: 't', status: 'idle', lastActivity: old },
    { id: 'busy', transcript: 'f', mtimeMs: 10, title: 't', status: 'busy', lastActivity: old },
    { id: 'fresh', transcript: 'f', mtimeMs: 10, title: 't', status: 'idle', lastActivity: new Date().toISOString() },
  ];
  assert.deepEqual(org.pending(rows).map(r => r.id), ['quiet']);
  assert.equal((await org.maybeRun(rows)).ok, true);
  assert.equal(store.sessionMeta('quiet').organised_mtime, 10);
  assert.equal((await org.maybeRun([{ ...rows[0], id: 'other' }])).skipped, 'daily cap reached');
  assert.equal(calls, 1);
});

const GP = [{ id: 1, name: 'Mine', name_locked: 1, description: 'd', checklist: [{ id: 2, state: 'todo', locked: 1, text: 't' }] }];
const GS = [{ key: 's1', projectId: null, folder: 'C:/x', title: 'hello' }];

test('organiser prompt is unchanged', () => {
  assert.equal(buildPrompt(GP, GS, userSettings({}, {}, { owner: 'Sam', ownerTheir: 'her', about: 'runs Acme: a shop and a blog.' })), fs.readFileSync(new URL('./fixtures/organiser-prompt-owner.txt', import.meta.url), 'utf8'));
});

test('team organiser prompt uses their name', () => {
  const p = buildPrompt(GP, GS, { name: 'Lee', their: 'their', about: 'works at Acme on email.' });
  assert.match(p, /You organise Lee's Claude Code sessions into projects for their dashboard/);
  assert.match(p, /Lee works at Acme on email\./);
  assert.match(p, /set by Lee/);
  assert.doesNotMatch(p, /Sam/);
});
