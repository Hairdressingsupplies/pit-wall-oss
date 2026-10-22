// Pit Wall's own state: projects, which session belongs where, checklists, organiser ledger.
// Uses Node's built-in SQLite, so there is nothing to install.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isEngine } from './engines.mjs';

export const CHECKLIST_STATES = ['todo', 'doing', 'blocked', 'built', 'live'];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000; -- the server, the nightly review and the CronCreate hook all write this file
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      name_locked INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS session_meta (
      session_id TEXT PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      project_locked INTEGER NOT NULL DEFAULT 0,
      display_name TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      cwd TEXT,
      organised_mtime REAL NOT NULL DEFAULT 0,
      model TEXT,
      permission_mode TEXT
    );
    CREATE TABLE IF NOT EXISTS checklist (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'todo',
      locked INTEGER NOT NULL DEFAULT 0,
      source_session TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS organiser_runs (
      id INTEGER PRIMARY KEY,
      ran_at TEXT NOT NULL DEFAULT (datetime('now')),
      day TEXT NOT NULL,
      sessions INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      cost_usd REAL,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS queue (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      cwd TEXT NOT NULL,
      project_id INTEGER,
      model TEXT,
      status TEXT NOT NULL DEFAULT 'queued',   -- queued · running · needs_you · done · failed · cancelled
      session_id TEXT,
      role_id INTEGER,
      result TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      goal TEXT NOT NULL,
      instructions TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL,
      project_id INTEGER,
      every_hours REAL NOT NULL DEFAULT 24,
      enabled INTEGER NOT NULL DEFAULT 0,
      last_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      cwd TEXT,
      model TEXT,
      effort TEXT,
      permission_mode TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS followups (
      id INTEGER PRIMARY KEY,
      text TEXT NOT NULL,
      due_at TEXT NOT NULL,
      session_id TEXT,
      project_id INTEGER,
      done INTEGER NOT NULL DEFAULT 0,
      notified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS rate_history (
      at TEXT PRIMARY KEY,
      five REAL,
      week REAL,
      five_resets_at INTEGER
    );
    -- Every task status change, so the chat behind it (and the activity log) can be told.
    CREATE TABLE IF NOT EXISTS checklist_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      item_text TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      note TEXT,
      by TEXT NOT NULL,
      session_id TEXT,
      delivered_at TEXT,
      at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  migrate(db);
  return new Store(db);
}

/** Columns added after the first release — CREATE TABLE IF NOT EXISTS won't add them to an existing file. */
function migrate(db) {
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
  const add = (table, col, def) => { if (!has(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); };
  add('session_meta', 'effort', 'TEXT');
  add('session_meta', 'engine', "TEXT NOT NULL DEFAULT 'claude'"); // which engine runs the chat: claude · codex
  add('queue', 'engine', 'TEXT');  // null = the default engine when the job starts
  add('roles', 'engine', 'TEXT');  // null = the default engine when the agent runs
  add('rate_history', 'engine', "TEXT NOT NULL DEFAULT 'claude'");
  add('session_meta', 'snoozed_until', 'TEXT');
  add('session_meta', 'superseded_by', 'TEXT');
  add('projects', 'budget_pct', 'REAL');
  // Timetables for agents: 'interval' (every N hours) or 'daily' | 'weekdays' | 'weekly' at a time of day.
  add('roles', 'schedule_kind', "TEXT NOT NULL DEFAULT 'interval'");
  add('roles', 'schedule_days', 'INTEGER NOT NULL DEFAULT 0'); // bitmask Sun=1 … Sat=64 (weekly)
  add('roles', 'schedule_time', "TEXT NOT NULL DEFAULT '08:00'");
  add('roles', 'skill', 'TEXT');
  add('roles', 'model', 'TEXT');
  add('queue', 'off_peak', 'INTEGER NOT NULL DEFAULT 0');
  add('queue', 'start_at', 'TEXT');        // don't start before this (ISO); null = as soon as allowed
  add('roles', 'every_minutes', 'INTEGER'); // schedule_kind 'minutes'
  add('roles', 'run_at', 'TEXT');           // schedule_kind 'once' (ISO)
  add('session_meta', 'interrupted', 'INTEGER NOT NULL DEFAULT 0');
  add('session_meta', 'done_at', 'TEXT'); // you finished this chat; new activity after this reopens it
  add('session_meta', 'run_here', 'INTEGER NOT NULL DEFAULT 0'); // a chat Pit Wall runs: comes back resting after a restart
  add('session_meta', 'auto_title', 'TEXT'); // Haiku's name for a chat you started unnamed (headless chats get no ai-title)
  add('session_meta', 'color', 'TEXT'); // a colour you gave the chat on the board
  add('session_meta', 'rewind_cut', 'TEXT');
  add('session_meta', 'forked_from', 'TEXT');
  add('followups', 'queue_id', 'INTEGER'); // a scheduled check: the queued job this follow-up watches
  add('followups', 'state', 'TEXT');       // scheduled checks only: running · ran · missed (null = not settled yet) // a fork: resuming it must wait for Claude Code's 'ready' // the message last rewound to: hidden until a newer branch replaces it
}

export class Store {
  constructor(db) { this.db = db; }

  // ── projects ────────────────────────────────────────────────────────────
  projects({ includeArchived = false } = {}) {
    return this.db.prepare(`SELECT * FROM projects ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY updated_at DESC`).all();
  }
  project(id) { return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id); }
  createProject(name, description = '', { locked = false } = {}) {
    const r = this.db.prepare('INSERT INTO projects (name, description, name_locked) VALUES (?, ?, ?)').run(name, description, locked ? 1 : 0);
    return Number(r.lastInsertRowid);
  }
  /** by: 'user' locks the name so the organiser leaves it alone. */
  updateProject(id, { name, description, archived }, by = 'organiser') {
    const p = this.project(id);
    if (!p) return;
    if (by === 'organiser' && p.name_locked && (name !== undefined || description !== undefined)) { name = undefined; description = undefined; }
    this.db.prepare(`UPDATE projects SET
        name = COALESCE(?, name), description = COALESCE(?, description),
        archived = COALESCE(?, archived), name_locked = CASE WHEN ? THEN 1 ELSE name_locked END,
        updated_at = datetime('now') WHERE id = ?`)
      .run(name ?? null, description ?? null, archived === undefined ? null : (archived ? 1 : 0),
        by === 'user' && (name !== undefined || description !== undefined) ? 1 : 0, id);
  }
  touchProject(id) { this.db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(id); }
  deleteProject(id) {
    this.db.prepare('UPDATE session_meta SET project_id = NULL, project_locked = 0 WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM checklist WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  // ── sessions ────────────────────────────────────────────────────────────
  sessionMeta(id) { return this.db.prepare('SELECT * FROM session_meta WHERE session_id = ?').get(id); }
  allSessionMeta() { return this.db.prepare('SELECT * FROM session_meta').all(); }
  upsertSession(id, fields) {
    const cur = this.sessionMeta(id) ?? { session_id: id };
    const next = { ...cur, ...fields };
    const cols = {
      project_id: next.project_id ?? null, project_locked: next.project_locked ? 1 : 0, display_name: next.display_name ?? null,
      hidden: next.hidden ? 1 : 0, cwd: next.cwd ?? null, organised_mtime: next.organised_mtime ?? 0, model: next.model ?? null,
      permission_mode: next.permission_mode ?? null, effort: next.effort ?? null, interrupted: next.interrupted ? 1 : 0,
      snoozed_until: next.snoozed_until ?? null, superseded_by: next.superseded_by ?? null, done_at: next.done_at ?? null,
      run_here: next.run_here ? 1 : 0, auto_title: next.auto_title ?? null, color: next.color ?? null, rewind_cut: next.rewind_cut ?? null, forked_from: next.forked_from ?? null,
      engine: isEngine(next.engine) ? next.engine : 'claude',
    };
    const names = Object.keys(cols);
    this.db.prepare(`INSERT INTO session_meta (session_id, ${names.join(', ')}) VALUES (?, ${names.map(() => '?').join(', ')})
      ON CONFLICT(session_id) DO UPDATE SET ${names.map(n => `${n} = excluded.${n}`).join(', ')}`)
      .run(id, ...Object.values(cols));
  }
  interruptedSessions() { return this.db.prepare('SELECT * FROM session_meta WHERE interrupted = 1').all(); }

  // ── queue ───────────────────────────────────────────────────────────────
  queue({ limit = 100 } = {}) {
    return this.db.prepare(`SELECT * FROM queue ORDER BY
      CASE status WHEN 'running' THEN 0 WHEN 'needs_you' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END, id DESC LIMIT ?`).all(limit);
  }
  queueItem(id) { return this.db.prepare('SELECT * FROM queue WHERE id = ?').get(id); }
  nextQueued() { return this.db.prepare("SELECT * FROM queue WHERE status = 'queued' ORDER BY id LIMIT 1").get() ?? null; }
  queuedItems() { return this.db.prepare("SELECT * FROM queue WHERE status = 'queued' ORDER BY id").all(); }
  activeQueueItems() { return this.db.prepare("SELECT * FROM queue WHERE status IN ('running', 'needs_you')").all(); }
  addQueueItem({ title, prompt, cwd, projectId = null, model = null, roleId = null, offPeak = false, startAt = null, engine = null }) {
    const r = this.db.prepare('INSERT INTO queue (title, prompt, cwd, project_id, model, role_id, off_peak, start_at, engine) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(title, prompt, cwd, projectId, model, roleId, offPeak ? 1 : 0, startAt, isEngine(engine) ? engine : null);
    return Number(r.lastInsertRowid);
  }
  updateQueueItem(id, fields) {
    const cols = ['status', 'session_id', 'result', 'started_at', 'finished_at', 'title', 'prompt'];
    const set = Object.keys(fields).filter(k => cols.includes(k));
    if (!set.length) return;
    this.db.prepare(`UPDATE queue SET ${set.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...set.map(k => fields[k] ?? null), id);
  }
  queueStartedOn(day) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM queue WHERE started_at IS NOT NULL AND substr(started_at, 1, 10) = ?").get(day).n;
  }

  // ── role agents ─────────────────────────────────────────────────────────
  roles() { return this.db.prepare('SELECT * FROM roles ORDER BY id').all(); }
  role(id) { return this.db.prepare('SELECT * FROM roles WHERE id = ?').get(id); }
  addRole({ name, goal, instructions = '', cwd, projectId = null, everyHours = 24, scheduleKind = 'interval', scheduleDays = 0,
    scheduleTime = '08:00', skill = null, model = null, everyMinutes = null, runAt = null, engine = null }) {
    const r = this.db.prepare(`INSERT INTO roles (name, goal, instructions, cwd, project_id, every_hours, schedule_kind, schedule_days, schedule_time, skill, model, every_minutes, run_at, engine)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(name, goal, instructions, cwd, projectId, everyHours, scheduleKind, scheduleDays, scheduleTime, skill, model, everyMinutes, runAt, isEngine(engine) ? engine : null);
    return Number(r.lastInsertRowid);
  }
  updateRole(id, fields) {
    const cols = ['name', 'goal', 'instructions', 'cwd', 'project_id', 'every_hours', 'enabled', 'last_run_at',
      'schedule_kind', 'schedule_days', 'schedule_time', 'skill', 'model', 'every_minutes', 'run_at', 'engine'];
    const set = Object.keys(fields).filter(k => cols.includes(k));
    if (!set.length) return;
    this.db.prepare(`UPDATE roles SET ${set.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...set.map(k => fields[k] ?? null), id);
  }
  deleteRole(id) { this.db.prepare('DELETE FROM roles WHERE id = ?').run(id); }

  // ── templates ───────────────────────────────────────────────────────────
  templates() { return this.db.prepare('SELECT * FROM templates ORDER BY name').all(); }
  addTemplate({ name, prompt, cwd = null, model = null, effort = null, permissionMode = null }) {
    return Number(this.db.prepare('INSERT INTO templates (name, prompt, cwd, model, effort, permission_mode) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, prompt, cwd, model, effort, permissionMode).lastInsertRowid);
  }
  deleteTemplate(id) { this.db.prepare('DELETE FROM templates WHERE id = ?').run(id); }

  // ── follow-ups ──────────────────────────────────────────────────────────
  followups({ includeDone = false } = {}) {
    return this.db.prepare(`SELECT * FROM followups ${includeDone ? '' : 'WHERE done = 0'} ORDER BY due_at`).all();
  }
  addFollowup({ text, dueAt, sessionId = null, projectId = null }) {
    return Number(this.db.prepare('INSERT INTO followups (text, due_at, session_id, project_id) VALUES (?, ?, ?, ?)')
      .run(text, dueAt, sessionId, projectId).lastInsertRowid);
  }
  followup(id) { return this.db.prepare('SELECT * FROM followups WHERE id = ?').get(id) ?? null; }
  updateFollowup(id, fields) {
    const cols = ['text', 'due_at', 'done', 'notified', 'state', 'session_id'];
    const set = Object.keys(fields).filter(k => cols.includes(k));
    if (set.length) this.db.prepare(`UPDATE followups SET ${set.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...set.map(k => fields[k]), id);
  }
  deleteFollowup(id) { this.db.prepare('DELETE FROM followups WHERE id = ?').run(id); }
  /**
   * A check that must happen later even if the chat that asked for it is gone: a queued job that waits for
   * startAt, plus a follow-up (due followAt) that watches it — written together. withJob false: follow-up only.
   */
  scheduleCheck({ title, prompt, cwd, startAt, followAt, sessionId = null, projectId = null, model = null, withJob = true }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const queueId = withJob ? this.addQueueItem({ title, prompt, cwd, projectId, model, startAt }) : null;
      const r = this.db.prepare('INSERT INTO followups (text, due_at, session_id, project_id, queue_id) VALUES (?, ?, ?, ?, ?)')
        .run(withJob ? `Scheduled check: ${title}` : `Scheduled check (run it yourself): ${title}`, followAt, sessionId, projectId, queueId);
      this.db.exec('COMMIT');
      return { queueId, followupId: Number(r.lastInsertRowid) };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // ── usage readings (for burn rate) ──────────────────────────────────────
  addRateReading(at, five, week, fiveResetsAt, engine = 'claude') {
    this.db.prepare('INSERT OR REPLACE INTO rate_history (at, five, week, five_resets_at, engine) VALUES (?, ?, ?, ?, ?)').run(at, five, week, fiveResetsAt ?? null, engine);
    this.db.prepare("DELETE FROM rate_history WHERE at < datetime('now', '-8 days')").run();
  }
  rateReadingsSince(iso, engine = 'claude') { return this.db.prepare('SELECT * FROM rate_history WHERE at >= ? AND engine = ? ORDER BY at').all(iso, engine); }

  // ── project budgets ─────────────────────────────────────────────────────
  setProjectBudget(id, pct) { this.db.prepare('UPDATE projects SET budget_pct = ? WHERE id = ?').run(pct, id); }

  // ── backup ──────────────────────────────────────────────────────────────
  backupTo(file) { this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); }
  /** Organiser assignment — never overrides a project the user picked by hand. */
  assignByOrganiser(id, projectId) {
    const m = this.sessionMeta(id);
    if (m?.project_locked) return false;
    this.upsertSession(id, { project_id: projectId });
    return true;
  }

  // ── checklist ───────────────────────────────────────────────────────────
  checklist(projectId) {
    return this.db.prepare(`SELECT * FROM checklist WHERE project_id = ? ORDER BY
      CASE state WHEN 'blocked' THEN 0 WHEN 'doing' THEN 1 WHEN 'todo' THEN 2 WHEN 'built' THEN 3 ELSE 4 END, id`).all(projectId);
  }
  addChecklistItem(projectId, text, state = 'todo', { locked = false, sourceSession = null } = {}) {
    if (!CHECKLIST_STATES.includes(state)) state = 'todo';
    const r = this.db.prepare('INSERT INTO checklist (project_id, text, state, locked, source_session) VALUES (?, ?, ?, ?, ?)')
      .run(projectId, text, state, locked ? 1 : 0, sourceSession);
    return Number(r.lastInsertRowid);
  }
  /** Returns the recorded status-change event (or null when the state didn't change). */
  updateChecklistItem(id, { text, state }, by = 'organiser') {
    const item = this.db.prepare('SELECT * FROM checklist WHERE id = ?').get(id);
    if (!item) return null;
    if (by === 'organiser' && item.locked) return null;
    if (state && !CHECKLIST_STATES.includes(state)) state = undefined;
    this.db.prepare(`UPDATE checklist SET text = COALESCE(?, text), state = COALESCE(?, state),
        locked = CASE WHEN ? THEN 1 ELSE locked END, updated_at = datetime('now') WHERE id = ?`)
      .run(text ?? null, state ?? null, by === 'user' ? 1 : 0, id);
    if (!state || state === item.state) return null;
    const r = this.db.prepare(`INSERT INTO checklist_events (item_id, project_id, item_text, from_state, to_state, by)
        VALUES (?, ?, ?, ?, ?, ?)`).run(id, item.project_id, text ?? item.text, item.state, state, by);
    return this.checklistEvent(Number(r.lastInsertRowid));
  }

  // ── task status history ─────────────────────────────────────────────────
  checklistEvent(id) { return this.db.prepare('SELECT * FROM checklist_events WHERE id = ?').get(id) ?? null; }
  updateChecklistEvent(id, { note, sessionId, delivered }) {
    this.db.prepare(`UPDATE checklist_events SET note = COALESCE(?, note), session_id = COALESCE(?, session_id),
        delivered_at = CASE WHEN ? THEN datetime('now') ELSE delivered_at END WHERE id = ?`)
      .run(note ?? null, sessionId ?? null, delivered ? 1 : 0, id);
  }
  /** Latest events per item for the Projects view (newest first). */
  checklistHistory(itemIds) {
    if (!itemIds.length) return [];
    return this.db.prepare(`SELECT * FROM checklist_events WHERE item_id IN (${itemIds.map(() => '?').join(',')}) ORDER BY id DESC`).all(...itemIds);
  }
  /** Changes made by you that the chat hasn't been told about yet. */
  undeliveredEvents(sessionId = null) {
    return sessionId
      ? this.db.prepare("SELECT * FROM checklist_events WHERE by = 'user' AND session_id = ? AND delivered_at IS NULL ORDER BY id").all(sessionId)
      : this.db.prepare("SELECT * FROM checklist_events WHERE by = 'user' AND session_id IS NOT NULL AND delivered_at IS NULL ORDER BY id").all();
  }
  /** Status changes on a local day (at is UTC; the caller passes the day's UTC bounds). */
  checklistEventsBetween(since, until) {
    return this.db.prepare("SELECT e.*, p.name AS project FROM checklist_events e LEFT JOIN projects p ON p.id = e.project_id WHERE e.at >= ? AND e.at < ? ORDER BY e.id")
      .all(since, until);
  }
  checklistItem(id) { return this.db.prepare('SELECT * FROM checklist WHERE id = ?').get(id) ?? null; }
  deleteChecklistItem(id) { this.db.prepare('DELETE FROM checklist WHERE id = ?').run(id); }

  // ── organiser ledger + kv ───────────────────────────────────────────────
  organiserCallsOn(day) { return this.db.prepare('SELECT COUNT(*) AS n FROM organiser_runs WHERE day = ?').get(day).n; }
  logOrganiserRun(day, sessions, ok, costUsd, error = null) {
    this.db.prepare('INSERT INTO organiser_runs (day, sessions, ok, cost_usd, error) VALUES (?, ?, ?, ?, ?)').run(day, sessions, ok ? 1 : 0, costUsd ?? null, error);
  }
  lastOrganiserRun() { return this.db.prepare('SELECT * FROM organiser_runs ORDER BY id DESC LIMIT 1').get() ?? null; }
  get(k, fallback = null) {
    const r = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
    return r ? JSON.parse(r.v) : fallback;
  }
  set(k, v) { this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v)); }
}
