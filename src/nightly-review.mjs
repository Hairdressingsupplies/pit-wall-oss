// Nightly review (Windows task "Pit Wall Nightly Review", 04:00): one isolated, tool-less Claude call reads every
// project and task next to the memory index, CLAUDE.md's pending list and the parked-work lines in the vault, then
// brings the board in line — statuses corrected, duplicates merged, parked work added — so nothing is done twice.
// Writes only to Pit Wall's own database, after a backup. Anything you set by hand is reported, never changed.
//
//   node src/nightly-review.mjs             review and apply
//   node src/nightly-review.mjs --dry-run   review, save the plan, change nothing
//   node src/nightly-review.mjs --apply <plan.json>   apply a saved plan (no model call)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, paths, slugForCwd } from './config.mjs';
import { openDb, CHECKLIST_STATES } from './db.mjs';
import { callModel } from './organiser.mjs';
import { defaultEngine } from './engines.mjs';

const BY = 'nightly review';
const CAPS = { newProjects: 3, newItems: 10, closeItems: 15 };
const IDLE_DAYS = 7;   // a project whose tasks are all live is finished after this long without activity
const STALE_DAYS = 14; // an open task untouched this long is shown to the model as stale
const DAY = 86_400_000;
const OWNER = config.user.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PARKED = new RegExp(String.raw`\b(parked|deferred|on hold|backlog|not built|not implemented|not started|not deployed|not merged|not pushed|unmerged|uncommitted|planned only|spec only|for later|phase 2|needs (you|${OWNER})|(your|${OWNER}'s) (call|decision)|todo)\b|- \[ \]`, 'i');

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    item_updates: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'integer' }, state: { enum: CHECKLIST_STATES }, text: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] } },
    close_items: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'integer' }, reason: { type: 'string' } }, required: ['id', 'reason'] } },
    duplicate_items: { type: 'array', items: { type: 'object', properties: {
      keep: { type: 'integer' }, remove: { type: 'integer' }, reason: { type: 'string' } }, required: ['keep', 'remove', 'reason'] } },
    duplicate_projects: { type: 'array', items: { type: 'object', properties: {
      keep: { type: 'string' }, merge: { type: 'string' }, reason: { type: 'string' } }, required: ['keep', 'merge', 'reason'] } },
    new_projects: { type: 'array', items: { type: 'object', properties: {
      key: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } }, required: ['key', 'name', 'description'] } },
    new_items: { type: 'array', items: { type: 'object', properties: {
      project: { type: 'string' }, text: { type: 'string' }, state: { enum: CHECKLIST_STATES }, source: { type: 'string' } }, required: ['project', 'text', 'state', 'source'] } },
    notes_for_owner: { type: 'array', items: { type: 'string' } },
  },
  required: ['item_updates', 'close_items', 'duplicate_items', 'duplicate_projects', 'new_projects', 'new_items', 'notes_for_owner'],
};

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

/** Lines in the vault that say something is parked, pending or not live yet — at most `perFile` per note. */
export function parkedLines(dir, { perFile = 6, maxChars = 60_000 } = {}) {
  const out = [];
  let size = 0;
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.md')) continue;
      const hits = read(full).split('\n').filter(l => PARKED.test(l)).slice(0, perFile).map(l => clip(l, 300));
      if (!hits.length || size > maxChars) continue;
      const block = `${path.relative(dir, full).replace(/\\/g, '/')}\n${hits.map(h => '  ' + h).join('\n')}`;
      size += block.length;
      out.push(block);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.join('\n');
}

const sqlMs = s => (s ? Date.parse(s.replace(' ', 'T') + 'Z') : 0); // SQLite datetime('now') is UTC without a zone

/**
 * When each project last saw real work: its chats' transcripts and task changes made by you or a chat.
 * Not projects.updated_at — the organiser and this review touch that themselves. Falls back to created_at.
 */
export function lastActivity(store, projectsDirs = [paths.projectsDir, paths.codexProjectsDir]) {
  const roots = [].concat(projectsDirs);
  const out = new Map(store.projects({ includeArchived: true }).map(p => [p.id, sqlMs(p.created_at)]));
  const bump = (pid, ms) => { if (out.has(pid) && ms > out.get(pid)) out.set(pid, ms); };
  for (const s of store.allSessionMeta()) {
    if (!s.project_id || !s.cwd) continue;
    for (const root of roots) {
      try { bump(s.project_id, fs.statSync(path.join(root, slugForCwd(s.cwd), `${s.session_id}.jsonl`)).mtimeMs); break; } catch { /* not under this root */ }
    }
  }
  for (const e of store.db.prepare('SELECT project_id, MAX(at) at FROM checklist_events WHERE by <> ? GROUP BY project_id').all(BY)) bump(e.project_id, sqlMs(e.at));
  return out;
}

export function gather(store, { workspace = config.workspaceRoot, claudeHome = config.claudeHome, codexProjectsDir = paths.codexProjectsDir, now = Date.now() } = {}) {
  const activity = lastActivity(store, [path.join(claudeHome, 'projects'), codexProjectsDir]);
  const projects = store.projects({ includeArchived: true }).map(p => ({ ...p, checklist: store.checklist(p.id),
    idleDays: Math.floor((now - (activity.get(p.id) ?? now)) / DAY) }));
  const memory = read(path.join(claudeHome, 'projects', slugForCwd(workspace), 'memory', 'MEMORY.md'));
  const claudeMd = read(path.join(workspace, 'CLAUDE.md'));
  const pending = /## Pending\n([\s\S]*?)\n---/.exec(claudeMd)?.[1].trim() ?? '';
  return { projects, memory, pending, vault: parkedLines(path.join(workspace, 'vault')), declined: store.get('nightlyAdded', []), now };
}

export function buildReviewPrompt({ projects, memory, pending, vault, declined, now = Date.now(), user = config.user }) {
  const who = user.name;
  const untouched = c => {
    const days = Math.floor((now - sqlMs(c.updated_at)) / DAY);
    return c.state !== 'live' && c.updated_at && days >= STALE_DAYS ? `, untouched ${days}d` : '';
  };
  const projText = projects.map(p => {
    const items = p.checklist.map(c => `    - [#${c.id} ${c.state}${c.locked ? `, set by ${who}` : ''}${untouched(c)}] ${c.text}`).join('\n');
    const idle = p.idleDays != null && !p.archived ? `, last activity ${p.idleDays}d ago` : '';
    return `- p${p.id}${p.archived ? ' (finished)' : ''}${p.name_locked ? ` (set by ${who})` : ''}${idle}: "${p.name}"\n  ${clip(p.description, 200)}${items ? '\n' + items : ''}`;
  }).join('\n');
  return `You keep ${who}'s project board (Pit Wall) accurate so that no work is done twice and nothing parked is forgotten.
${who} ${user.about} Below are the board, then three sources of truth about what is
actually done, live, parked or still to do.

BOARD (projects and their tasks; states: todo · doing · blocked · built = done but not live · live)
${projText}

MEMORY INDEX (one line per piece of work, with its verified status)
${memory}

PENDING LIST (CLAUDE.md)
${pending}

VAULT NOTES — lines that mention parked, pending or not-yet-live work (file, then its lines)
${vault}

ADDED BY EARLIER NIGHTLY REVIEWS (never add these again, even if they are no longer on the board — ${who} removed them)
${declined.length ? declined.map(t => '- ' + t).join('\n') : '(none)'}

Do this, conservatively — when the sources don't clearly say, leave it alone:
1. item_updates: a task whose state is wrong according to the sources (e.g. still todo but the memory index says LIVE).
   Only mark live when a source says deployed/LIVE/verified. Reword a task only if it is misleading. Give the reason
   with the source. Tasks set by ${who} may be included too: those are shown to them as one-click suggestions, never applied.
2. close_items: open tasks (todo · doing · blocked · built) that no longer need doing, so the board stays short —
   a source says the work was retired, abandoned, superseded, replaced, decided against, or done another way; or the
   task is untouched for weeks and NO source still mentions it as pending. Give the reason with the source. Never
   close a task just because it is old if a source still lists it as pending. Tasks set by ${who} may be included:
   they become one-click suggestions for them, never applied. At most ${CAPS.closeItems}, the clearest first.
3. duplicate_items: two tasks that are the same piece of work (same or different projects). keep the clearer or
   further-along one; remove the other. If either is set by ${who}, use notes_for_owner instead.
4. duplicate_projects: two open projects covering the same work. merge goes into keep. If merge is set by ${who}, use
   notes_for_owner instead.
5. new_items: work the sources show is parked, pending, built-but-not-live or waiting on a decision and that NO
   existing task covers (check finished projects too). project is an existing id ("p12") or a new_projects key.
   Parked or waiting on a decision = blocked; not started = todo; done but not deployed = built. Start parked ones
   with "Parked: ". Short, at most ~12 words. source = the memory line title or vault file it came from.
   At most ${CAPS.newItems}, the most valuable first. Skip trivia, things already live, and abandoned repos.
6. new_projects: only when no existing project fits a new item. key like "n1". Name "<Area>: <specific focus>",
   at most 55 characters. At most ${CAPS.newProjects}.
7. notes_for_owner: short plain-English lines for anything else they should decide themselves (possible duplicates among their
   own items, sources that contradict each other) — not status changes or closures, which go in 1 and 2. Name tasks by their text in quotes, never by #id. At most 10.
Return only the JSON.`;
}

/** Identifies a suggestion across nights, so a dismissed one stays dismissed. */
export const suggestionKey = s => `${s.kind}:${s.itemId ?? s.projectId}:${s.to ?? ''}`;

/** Apply a plan. With dryRun nothing is written; the returned lines say what would happen. */
export function applyReview(store, plan, { dryRun = false, activity = null, now = Date.now() } = {}) {
  const lines = { updated: [], closed: [], removed: [], merged: [], added: [], created: [], finished: [], skipped: [] };
  const added = store.get('nightlyAdded', []);
  // Changes to things you set by hand are never applied: they become suggestions you accept or dismisses in the
  // morning brief. A dismissed one is not suggested again.
  const dismissed = new Set(store.get('nightlyDismissed', []));
  const suggestions = [];
  const suggest = s => { const key = suggestionKey(s); if (!dismissed.has(key)) suggestions.push({ key, ...s }); };
  const goneIds = new Set(); // tasks closed or removed this run (still in the DB during a dry run)
  const item = id => store.checklistItem(Number(id));
  const newIds = new Map();
  const pname = id => store.project(id)?.name ?? `p${id}`;
  const resolve = ref => {
    if (newIds.has(ref)) return newIds.get(ref);
    const m = /^p(\d+)$/.exec(String(ref ?? ''));
    return m && store.project(Number(m[1])) ? Number(m[1]) : undefined;
  };

  for (const u of plan.item_updates ?? []) {
    const it = item(u.id);
    if (!it) continue;
    if (it.locked) {
      lines.skipped.push(`"${it.text}" is set by you — suggested: ${u.state ?? 'reword'} (${u.reason})`);
      if (u.state && u.state !== it.state) suggest({ kind: 'state', itemId: it.id, text: it.text, from: it.state, to: u.state, project: pname(it.project_id), reason: clip(u.reason, 300) });
      continue;
    }
    const state = u.state && u.state !== it.state ? u.state : undefined;
    const text = u.text && clip(u.text, 140) !== it.text ? clip(u.text, 140) : undefined;
    if (!state && !text) continue;
    if (!dryRun) {
      const e = store.updateChecklistItem(it.id, { state, text }, BY);
      if (e) store.updateChecklistEvent(e.id, { note: clip(u.reason, 200) });
    }
    lines.updated.push(`${pname(it.project_id)}: "${it.text}"${state ? ` ${it.state} → ${state}` : ''}${text ? ` → "${text}"` : ''} — ${u.reason}`);
  }

  // Closed tasks are deleted, and remembered with the ones this review added so a vault line can't bring them back.
  for (const c of (plan.close_items ?? []).slice(0, CAPS.closeItems)) {
    const it = item(c.id);
    if (!it || it.state === 'live') continue;
    if (it.locked) {
      lines.skipped.push(`"${it.text}" is set by you — may no longer be needed (${c.reason})`);
      suggest({ kind: 'close', itemId: it.id, text: it.text, from: it.state, project: pname(it.project_id), reason: clip(c.reason, 300) });
      continue;
    }
    if (!dryRun) store.deleteChecklistItem(it.id);
    added.push(it.text);
    goneIds.add(it.id);
    lines.closed.push(`${pname(it.project_id)}: "${it.text}" [${it.state}] — ${c.reason}`);
  }

  for (const d of plan.duplicate_items ?? []) {
    const keep = item(d.keep), gone = item(d.remove);
    if (!keep || !gone || keep.id === gone.id) continue;
    if (gone.locked) { lines.skipped.push(`Possible duplicate tasks: "${gone.text}" (yours) and "${keep.text}" — ${d.reason}`); continue; }
    if (!dryRun) store.deleteChecklistItem(gone.id);
    goneIds.add(gone.id);
    lines.removed.push(`${pname(gone.project_id)}: "${gone.text}" [${gone.state}] — same as "${keep.text}" in ${pname(keep.project_id)} (${d.reason})`);
  }

  for (const d of plan.duplicate_projects ?? []) {
    const keepId = resolve(d.keep), goneId = resolve(d.merge);
    if (!keepId || !goneId || keepId === goneId) continue;
    const gone = store.project(goneId);
    if (gone.archived) continue;
    const sessions = store.allSessionMeta().filter(s => s.project_id === goneId);
    const items = store.checklist(goneId);
    if (gone.name_locked || items.some(i => i.locked) || sessions.some(s => s.project_locked)) {
      lines.skipped.push(`Possible duplicate projects: "${gone.name}" and "${pname(keepId)}" — ${d.reason} (left alone: you set part of it by hand)`);
      continue;
    }
    if (!dryRun) {
      const have = new Set(store.checklist(keepId).map(i => i.text.toLowerCase()));
      for (const i of items) {
        if (have.has(i.text.toLowerCase())) store.deleteChecklistItem(i.id);
        else store.db.prepare("UPDATE checklist SET project_id = ?, updated_at = datetime('now') WHERE id = ?").run(keepId, i.id);
      }
      for (const s of sessions) store.upsertSession(s.session_id, { project_id: keepId });
      store.updateProject(goneId, { archived: true });
      store.touchProject(keepId);
    }
    lines.merged.push(`"${gone.name}" into "${pname(keepId)}" (${items.length} tasks, ${sessions.length} chats) — ${d.reason}`);
  }

  const seen = new Set(added.map(t => t.toLowerCase()));
  const wanted = (plan.new_items ?? []).slice(0, CAPS.newItems);
  let made = 0;
  for (const p of plan.new_projects ?? []) {
    const name = clip(p.name, 80);
    if (!name || newIds.has(p.key) || !wanted.some(i => i.project === p.key)) continue;
    const existing = store.projects({ includeArchived: true }).find(x => x.name.toLowerCase() === name.toLowerCase());
    if (existing) { newIds.set(p.key, existing.id); continue; }
    if (made >= CAPS.newProjects) continue;
    made++;
    // A dry run has no id to hand out, so new projects get a negative placeholder.
    newIds.set(p.key, dryRun ? -made : store.createProject(name, clip(p.description, 300)));
    lines.created.push(`${name} — ${clip(p.description, 300)}`);
  }
  const newName = key => clip((plan.new_projects ?? []).find(p => p.key === key)?.name, 80);
  for (const n of wanted) {
    const pid = resolve(n.project);
    const text = clip(n.text, 140);
    if (!pid || !text || seen.has(text.toLowerCase())) continue;
    if (pid > 0 && store.checklist(pid).some(i => i.text.toLowerCase() === text.toLowerCase())) continue;
    if (!dryRun) {
      if (store.project(pid).archived) store.updateProject(pid, { archived: false });
      store.addChecklistItem(pid, text, n.state);
      store.touchProject(pid);
    }
    seen.add(text.toLowerCase());
    added.push(text);
    lines.added.push(`${pid > 0 ? pname(pid) : newName(n.project)}: "${text}" [${n.state}] — from ${n.source}`);
  }

  // Finish projects with nothing left to do: every task live (or none left) and no activity for IDLE_DAYS.
  // A rule, not the model's call. A project you named, or with a chat you filed by hand, is only suggested.
  if (activity) {
    const sessions = store.allSessionMeta();
    for (const p of store.projects()) {
      if (lines.created.some(c => c.startsWith(p.name))) continue;
      const open = store.checklist(p.id).filter(i => i.state !== 'live' && !goneIds.has(i.id));
      const idle = Math.floor((now - (activity.get(p.id) ?? now)) / DAY);
      if (open.length || idle < IDLE_DAYS || lines.added.some(a => a.startsWith(`${p.name}: `))) continue;
      const chats = sessions.filter(s => s.project_id === p.id);
      if (p.name_locked || chats.some(s => s.project_locked)) {
        lines.skipped.push(`"${p.name}" has nothing left to do and no activity for ${idle} days — Finish project? (you named or filed it by hand)`);
        suggest({ kind: 'finish', projectId: p.id, text: p.name, reason: `Every task is live and nothing has happened for ${idle} days.` });
        continue;
      }
      if (!dryRun) {
        const at = new Date(now).toISOString();
        for (const s of chats) if (!s.done_at) store.upsertSession(s.session_id, { done_at: at });
        store.updateProject(p.id, { archived: true });
      }
      lines.finished.push(`"${p.name}" — every task live, no activity for ${idle} days (${chats.length} chats closed)`);
    }
  }
  if (!dryRun) {
    store.set('nightlyAdded', added.slice(-500));
    store.set('nightlySuggestions', suggestions);
    store.set('nightlyNotes', (plan.notes_for_owner ?? []).slice(0, 10).map(n => clip(n, 400)));
  }
  lines.suggestions = suggestions;
  return lines;
}

export function report(day, lines, notes, { dryRun = false, costUsd = null } = {}) {
  const section = (title, rows) => (rows.length ? [`## ${title}`, ...rows.map(r => `- ${r}`), ''] : []);
  const total = lines.updated.length + lines.closed.length + lines.removed.length + lines.merged.length + lines.added.length
    + lines.created.length + lines.finished.length;
  return [
    `# Pit Wall nightly review — ${day}${dryRun ? ' (dry run: nothing changed)' : ''}`, '',
    `${total} change${total === 1 ? '' : 's'}${costUsd != null ? `, one Claude call (~$${costUsd.toFixed(2)} notional)` : ''}.`, '',
    ...section('Statuses corrected', lines.updated),
    ...section('Tasks closed (no longer needed)', lines.closed),
    ...section('Duplicate tasks removed', lines.removed),
    ...section('Duplicate projects merged', lines.merged),
    ...section('New projects', lines.created),
    ...section('Tasks added', lines.added),
    ...section('Projects finished (nothing left to do)', lines.finished),
    ...section('Left for you (set by hand)', lines.skipped),
    ...section('Notes', notes ?? []),
  ].join('\n');
}

async function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const planFile = argv.includes('--apply') ? argv[argv.indexOf('--apply') + 1] : null;
  const day = new Date().toLocaleDateString('sv-SE'); // local YYYY-MM-DD
  const outDir = path.join(config.dataDir, 'nightly-review');
  fs.mkdirSync(outDir, { recursive: true });
  const log = msg => {
    const line = `${new Date().toISOString()} ${msg}`;
    console.log(line);
    fs.appendFileSync(path.join(outDir, 'nightly-review.log'), line + os.EOL);
  };

  const store = openDb(paths.db);
  const db = store.db;
  db.exec('PRAGMA busy_timeout = 15000'); // the server has the same file open

  let plan, costUsd = null;
  if (planFile) {
    plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    log(`applying saved plan ${planFile}`);
  } else {
    const input = gather(store);
    const prompt = buildReviewPrompt(input);
    log(`reviewing ${input.projects.length} projects, ${input.projects.reduce((n, p) => n + p.checklist.length, 0)} tasks (prompt ${prompt.length} chars)`);
    let res;
    for (let attempt = 1; attempt <= 2; attempt++) {
      res = await callModel({ engine: defaultEngine(store), codexModels: store.get('codexModels', []), claudeExe: config.claudeExe, cwd: paths.organiserCwd, model: 'sonnet', effort: 'medium',
        prompt, schema: REVIEW_SCHEMA, maxTurns: 4, timeoutMs: 900_000 });
      if (res.ok) break;
      log(`attempt ${attempt} failed: ${res.error}`);
      if (attempt === 1) await new Promise(r => setTimeout(r, 600_000)); // one retry, ten minutes later
    }
    if (!res.ok) throw new Error(`Claude call failed twice: ${res.error}`);
    plan = res.data;
    costUsd = res.costUsd ?? null;
    fs.writeFileSync(path.join(outDir, `plan-${day}.json`), JSON.stringify(plan, null, 2));
  }

  if (!dryRun) {
    fs.mkdirSync(paths.backupsDir, { recursive: true });
    const backup = path.join(paths.backupsDir, `pre-nightly-${day}.db`);
    if (!fs.existsSync(backup)) store.backupTo(backup); // a second run the same day keeps the first backup
    for (const f of fs.readdirSync(paths.backupsDir).filter(f => f.startsWith('pre-nightly-')).sort().slice(0, -config.backups.keep)) {
      fs.rmSync(path.join(paths.backupsDir, f), { force: true });
    }
    log(`backup ${backup}`);
  }

  db.exec('BEGIN IMMEDIATE');
  let lines;
  try {
    lines = applyReview(store, plan, { dryRun, activity: lastActivity(store) });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  const text = report(day, lines, plan.notes_for_owner, { dryRun, costUsd });
  const file = path.join(outDir, `${day}${dryRun ? '-dry-run' : ''}.md`);
  fs.appendFileSync(file, text + '\n\n'); // a second run the same day adds to the report
  console.log('\n' + text + '\n');
  log(`${dryRun ? 'dry run' : 'applied'}: ${lines.updated.length} updated, ${lines.closed.length} closed, ${lines.finished.length} projects finished, ${lines.removed.length} removed, ${lines.merged.length} merged, ${lines.created.length} projects, ${lines.added.length} tasks added → ${file}`);
  db.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main(process.argv.slice(2)).catch(e => {
    const line = `${new Date().toISOString()} FAILED: ${e.message}`;
    console.error(line);
    try { fs.appendFileSync(path.join(config.dataDir, 'nightly-review', 'nightly-review.log'), line + os.EOL); } catch {}
    process.exit(1);
  });
}
