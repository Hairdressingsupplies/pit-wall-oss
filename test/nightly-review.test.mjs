import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { applyReview, buildReviewPrompt, report } from '../src/nightly-review.mjs';

function board() {
  const store = openDb(':memory:');
  const a = store.createProject('Pricing: price push', 'push prices');
  const b = store.createProject('Pricing: price push', 'same thing');
  const mine = store.createProject('Offers: admin', 'offers', { locked: true });
  const todo = store.addChecklistItem(a, 'Deploy price push', 'todo');
  const dup = store.addChecklistItem(b, 'Put price push live', 'todo');
  const locked = store.addChecklistItem(mine, 'Offer import', 'todo', { locked: true });
  store.upsertSession('s-b', { project_id: b });
  return { store, a, b, mine, todo, dup, locked };
}

test('corrects a status, records who and why, and leaves tasks set by hand alone', () => {
  const { store, todo, locked } = board();
  const lines = applyReview(store, { item_updates: [
    { id: todo, state: 'live', reason: 'memory says LIVE' }, { id: locked, state: 'live', reason: 'memory says LIVE' }] });
  assert.equal(store.checklistItem(todo).state, 'live');
  assert.equal(store.checklistItem(locked).state, 'todo');
  assert.equal(lines.updated.length, 1);
  assert.equal(lines.skipped.length, 1);
  const [event] = store.checklistHistory([todo]);
  assert.equal(event.by, 'nightly review');
  assert.equal(event.note, 'memory says LIVE');
  assert.equal(store.undeliveredEvents().length, 0); // no chat is told about a nightly change
});

test('removes a duplicate task but only reports one that is set by hand', () => {
  const { store, todo, dup, locked } = board();
  const lines = applyReview(store, { duplicate_items: [
    { keep: todo, remove: dup, reason: 'same work' }, { keep: todo, remove: locked, reason: 'same work' }] });
  assert.equal(store.checklistItem(dup), null);
  assert.ok(store.checklistItem(locked));
  assert.equal(lines.removed.length, 1);
  assert.equal(lines.skipped.length, 1);
});

test('merges a duplicate project: tasks and chats move, the duplicate is filed away', () => {
  const { store, a, b, mine } = board();
  const lines = applyReview(store, { duplicate_projects: [
    { keep: `p${a}`, merge: `p${b}`, reason: 'same work' }, { keep: `p${a}`, merge: `p${mine}`, reason: 'same work' }] });
  assert.equal(store.checklist(a).length, 2);
  assert.equal(store.sessionMeta('s-b').project_id, a);
  assert.equal(store.project(b).archived, 1);
  assert.equal(store.project(mine).archived, 0);
  assert.equal(lines.merged.length, 1);
  assert.equal(lines.skipped.length, 1);
});

test('adds parked work once, never again after it is removed, and makes only projects that get a task', () => {
  const { store, a } = board();
  const plan = {
    new_projects: [{ key: 'n1', name: 'Search: storefront finishing', description: 'd' }, { key: 'n2', name: 'Unused: nothing', description: 'd' }],
    new_items: [{ project: 'n1', text: 'Parked: remove predictive search', state: 'blocked', source: 'CLAUDE.md' },
      { project: `p${a}`, text: 'Deploy price push', state: 'todo', source: 'memory' }],
  };
  const lines = applyReview(store, plan);
  assert.equal(lines.created.length, 1);
  assert.equal(lines.added.length, 1);
  const made = store.projects().find(p => p.name === 'Search: storefront finishing');
  const [item] = store.checklist(made.id);
  assert.equal(item.locked, 0);
  store.deleteChecklistItem(item.id);
  assert.equal(applyReview(store, plan).added.length, 0);
});

test('a dry run changes nothing but reports the same lines', () => {
  const { store, a, todo, dup } = board();
  const lines = applyReview(store, {
    item_updates: [{ id: todo, state: 'live', reason: 'r' }],
    duplicate_items: [{ keep: todo, remove: dup, reason: 'r' }],
    new_projects: [{ key: 'n1', name: 'Search: storefront finishing', description: 'd' }],
    new_items: [{ project: 'n1', text: 'New thing', state: 'todo', source: 's' }, { project: `p${a}`, text: 'Other thing', state: 'todo', source: 's' }],
  }, { dryRun: true });
  assert.equal(store.checklistItem(todo).state, 'todo');
  assert.ok(store.checklistItem(dup));
  assert.equal(store.projects().length, 3);
  assert.equal(store.get('nightlyAdded', []).length, 0);
  assert.match(report('2026-09-30', lines, ['note'], { dryRun: true }), /5 changes[\s\S]*Search: storefront finishing: "New thing"/);
});

test('the prompt marks what is set by hand and what is finished', () => {
  const { store } = board();
  const projects = store.projects({ includeArchived: true }).map(p => ({ ...p, checklist: store.checklist(p.id) }));
  const prompt = buildReviewPrompt({ projects, memory: 'MEM', pending: 'PEND', vault: 'VAULT', declined: ['Old item'], user: { name: 'Sam', about: 'runs Acme.' } });
  assert.match(prompt, /\(set by Sam\): "Offers: admin"/);
  assert.match(prompt, /todo, set by Sam\] Offer import/);
  assert.match(prompt, /^Sam runs Acme\. Below are the board/m);
  assert.match(prompt, /- Old item/);
});

test('closes tasks that are no longer needed, remembers them, and leaves tasks set by hand and live ones alone', () => {
  const { store, todo, locked } = board();
  const done = store.addChecklistItem(store.createProject('X: y', ''), 'Already live', 'live');
  const lines = applyReview(store, { close_items: [
    { id: todo, reason: 'memory: RETIRED' }, { id: locked, reason: 'superseded' }, { id: done, reason: 'old' }] });
  assert.equal(store.checklistItem(todo), null);
  assert.ok(store.checklistItem(locked));
  assert.ok(store.checklistItem(done));
  assert.equal(lines.closed.length, 1);
  assert.equal(lines.skipped.length, 1);
  assert.ok(store.get('nightlyAdded', []).includes('Deploy price push'), 'never re-added from the same vault line');
  assert.match(report('2026-10-02', lines, []), /Tasks closed/);
});

test('finishes a project once every task is live and it has been idle a week — by rule, not by the model', () => {
  const store = openDb(':memory:');
  const now = Date.parse('2026-10-20T04:00:00Z');
  const old = store.createProject('Old: all live', '');
  store.addChecklistItem(old, 'Shipped', 'live');
  const t = store.addChecklistItem(old, 'Leftover', 'todo');
  store.upsertSession('s-old', { project_id: old });
  const recent = store.createProject('Recent: all live', '');
  store.addChecklistItem(recent, 'Shipped', 'live');
  const named = store.createProject('Named: all live', '', { locked: true });
  store.addChecklistItem(named, 'Shipped', 'live');
  const activity = new Map([[old, now - 10 * 86_400_000], [recent, now - 2 * 86_400_000], [named, now - 30 * 86_400_000]]);

  const dry = applyReview(store, { close_items: [{ id: t, reason: 'abandoned' }] }, { dryRun: true, activity, now });
  assert.equal(dry.finished.length, 1, 'a dry run counts the task it would close');
  assert.equal(store.project(old).archived, 0);

  const lines = applyReview(store, { close_items: [{ id: t, reason: 'abandoned' }] }, { activity, now });
  assert.equal(store.project(old).archived, 1);
  assert.ok(store.sessionMeta('s-old').done_at);
  assert.equal(store.project(recent).archived, 0);
  assert.equal(store.project(named).archived, 0);
  assert.equal(lines.finished.length, 1);
  assert.match(lines.skipped.join('\n'), /Named: all live/);
});

test('the prompt shows idle days and stale tasks', () => {
  const now = Date.parse('2026-10-20T04:00:00Z');
  const prompt = buildReviewPrompt({ projects: [{ id: 1, name: 'P', description: '', idleDays: 9, checklist: [
    { id: 5, state: 'todo', text: 'Old task', updated_at: '2026-09-01 10:00:00' }] }], memory: '', pending: '', vault: '', declined: [], now, user: { name: 'Sam', about: 'runs Acme.' } });
  assert.match(prompt, /last activity 9d ago/);
  assert.match(prompt, /#5 todo, untouched 48d/);
  assert.match(prompt, /close_items/);
});

test('changes to tasks set by hand become suggestions for the brief; a dismissed one is not suggested again', () => {
  const { store, locked } = board();
  applyReview(store, { item_updates: [{ id: locked, state: 'live', reason: 'memory says LIVE' }], close_items: [{ id: locked, reason: 'superseded' }] });
  const s = store.get('nightlySuggestions', []);
  assert.deepEqual(s.map(x => x.kind).sort(), ['close', 'state']);
  assert.equal(store.checklistItem(locked).state, 'todo', 'never applied');
  store.set('nightlyDismissed', [s.find(x => x.kind === 'close').key]);
  applyReview(store, { item_updates: [{ id: locked, state: 'live', reason: 'x' }], close_items: [{ id: locked, reason: 'x' }], notes_for_owner: ['n'] });
  assert.deepEqual(store.get('nightlySuggestions', []).map(x => x.kind), ['state']);
  assert.deepEqual(store.get('nightlyNotes'), ['n']);
});

test('gather counts a Codex-root transcript as project activity', async t => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { gather } = await import('../src/nightly-review.mjs');
  const { transcriptFile } = await import('../src/codex-transcript.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-home-'));
  const cx = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-cx-'));
  t.after(() => { for (const d of [home, cx]) try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ } });
  const cwd = String.raw`C:\repo`;
  const f = transcriptFile(cx, cwd, 'cx-9');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{}\n');
  const touched = new Date(Date.now() + 10 * 86_400_000);
  fs.utimesSync(f, touched, touched);
  const store = openDb(':memory:');
  const p = store.createProject('Codex: work', '');
  store.upsertSession('cx-9', { project_id: p, cwd });
  const now = Date.now() + 30 * 86_400_000;
  const g = gather(store, { workspace: home, claudeHome: home, codexProjectsDir: cx, now });
  const proj = g.projects.find(x => x.id === p);
  assert.equal(proj.idleDays, 20); // transcript touched 10 days after creation; the created_at fallback would say 30
});
