// Claude keeps the projects tidy: files sessions into descriptively named projects and
// maintains each project's checklist. One cheap, isolated, tool-less `claude -p` call per batch.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { childEnv } from './protocol.mjs';
import { killTree } from './runner.mjs';
import { CHECKLIST_STATES } from './db.mjs';
import { config } from './config.mjs';
import { callCodex } from './codex-exec.mjs';
import { helperModel, pickHelperModel, defaultEngine } from './engines.mjs';

export const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    new_projects: { type: 'array', items: { type: 'object', properties: {
      key: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } }, required: ['key', 'name', 'description'] } },
    project_updates: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, archive: { type: 'boolean' } }, required: ['id'] } },
    assignments: { type: 'array', items: { type: 'object', properties: {
      session: { type: 'string' }, project: { type: ['string', 'null'] } }, required: ['session', 'project'] } },
    checklist: { type: 'array', items: { type: 'object', properties: {
      project: { type: 'string' },
      add: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, state: { enum: CHECKLIST_STATES }, session: { type: 'string' } }, required: ['text', 'state'] } },
      update: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, state: { enum: CHECKLIST_STATES }, text: { type: 'string' } }, required: ['id'] } },
    }, required: ['project'] } },
  },
  required: ['new_projects', 'project_updates', 'assignments', 'checklist'],
};

const clip = (s, n) => (s ? String(s).replace(/\s+/g, ' ').trim().slice(0, n) : '');

export function buildPrompt(projects, sessions, user = config.user) {
  const projText = projects.length ? projects.map(p => {
    const items = p.checklist.map(c => `    - [#${c.id} ${c.state}${c.locked ? `, set by ${user.name}` : ''}] ${c.text}`).join('\n');
    return `- p${p.id}: "${p.name}"${p.name_locked ? ` (name set by ${user.name} — keep)` : ''}\n  ${clip(p.description, 200)}${items ? '\n  checklist:\n' + items : ''}`;
  }).join('\n') : '(none yet)';

  const sessText = sessions.map(s => [
    `- ${s.key}: current project ${s.projectId ? 'p' + s.projectId : 'none'}; folder ${s.folder}${s.branch ? ` @ ${s.branch}` : ''}`,
    s.title && `  title: ${clip(s.title, 120)}`,
    s.firstPrompt && `  first ask: ${clip(s.firstPrompt, 300)}`,
    s.lastPrompt && `  latest ask: ${clip(s.lastPrompt, 300)}`,
    s.summary && `  recap: ${clip(s.summary, 400)}`,
    s.lastAssistant && `  latest reply: ${clip(s.lastAssistant, 400)}`,
  ].filter(Boolean).join('\n')).join('\n');

  return `You organise ${user.name}'s Claude Code sessions into projects for ${user.their} dashboard, Pit Wall.
${user.name} ${user.about}

EXISTING PROJECTS
${projText}

SESSIONS TO FILE (changed since last time)
${sessText}

Do this:
1. assignments: give every session above exactly one entry. Put it in the existing project it belongs to, or a new
   project (by its key), or null if it is trivial/unclear (a greeting, a one-off question with no ongoing work).
   Keep a session in its current project unless the work clearly moved.
2. new_projects: only when no existing project fits. key like "n1". Name format "<Area>: <specific focus>", at most
   55 characters, specific enough to tell apart from siblings — e.g. "Checkout: saved cards & retry on decline",
   "Billing: invoice PDF export", "Marketing: newsletter signup & consent". Never a bare area like "Marketing".
   description: one sentence on the goal.
3. project_updates: rename or re-describe an existing project (id "p12") only if its scope has clearly changed;
   archive:true only if all its work is live and nothing is open. Never rename one whose name ${user.name} set.
4. checklist: per project, the concrete deliverables and where each stands, from what the sessions show.
   States: todo (not started) · doing (in progress) · blocked (waiting on something/someone) ·
   built (done locally or pushed but NOT deployed/live) · live (deployed and confirmed live).
   For each new item set session to the key (s1, s2…) of the session it came from, when there is one.
   Be conservative: only mark live when a session says it was deployed or verified live. Update existing items by id
   instead of adding duplicates; don't touch items set by ${user.name}. Short items, at most ~10 words, at most 8 per project.
Return only the JSON.`;
}

/**
 * One isolated, tool-less `claude -p` call (no MCP, nothing saved). Streams its output so the
 * rate-limit reading Claude Code reports comes along for free (onRate).
 * Resolves {ok, data?, text?, costUsd?, error?}.
 */
export function callModel({ claudeExe, cwd, model, prompt, schema = RESULT_SCHEMA, maxTurns = 3, timeoutMs = 240_000,
  effort = 'low', spawnFn = spawn, onSpawn = () => {}, onRate = () => {}, engine = 'claude', codexExe = null, codexModels = [] }) {
  // codexModels: the cached model list (kv codexModels), so an unverified helper model id falls back to one Codex offers.
  if (engine === 'codex') return callCodex({ exe: codexExe ?? config.codexExe, cwd, model: pickHelperModel(helperModel('codex', model, config.codex), codexModels), prompt, schema, timeoutMs, spawnFn, onSpawn });
  fs.mkdirSync(cwd, { recursive: true });
  const mcpFile = path.join(cwd, 'empty-mcp.json');
  if (!fs.existsSync(mcpFile)) fs.writeFileSync(mcpFile, '{"mcpServers":{}}');
  const args = ['-p', '--model', model, '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--effort', effort, '--tools', '', '--strict-mcp-config', '--mcp-config', mcpFile, '--max-turns', String(maxTurns)];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  return new Promise(resolve => {
    const proc = spawnFn(claudeExe, args, { cwd, env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    onSpawn(proc.pid);
    let buf = '', err = '', result = null;
    const timer = setTimeout(() => { killTree(proc.pid); resolve({ ok: false, error: 'Organiser timed out' }); }, timeoutMs);
    const line = l => {
      let e;
      try { e = JSON.parse(l); } catch { return; }
      if (e.type === 'rate_limit_event' && e.rate_limit_info) onRate(e.rate_limit_info);
      if (e.type === 'result') result = e;
    };
    proc.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    proc.stderr.on('data', d => { err = (err + d).slice(-2000); });
    proc.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    proc.on('exit', () => {
      clearTimeout(timer);
      if (buf.trim()) line(buf);
      const r = result;
      if (!r) return resolve({ ok: false, error: err.trim().slice(-300) || 'Organiser returned nothing' });
      if (r.is_error || (schema && !r.structured_output)) return resolve({ ok: false, costUsd: r.total_cost_usd, error: r.subtype ?? 'No structured output' });
      resolve({ ok: true, data: r.structured_output, text: r.result, costUsd: r.total_cost_usd });
    });
    proc.stdin.end(prompt);
  });
}

/** The cheapest possible call, only to read the current usage levels (Haiku, no tools, nothing saved). */
export function probeUsage({ claudeExe, cwd, onRate, spawnFn = spawn }) {
  return callModel({ claudeExe, cwd, model: 'haiku', prompt: 'Reply with the single word OK.', schema: null, maxTurns: 1,
    timeoutMs: 90_000, spawnFn, onRate });
}

/** Apply the model's answer to the store. Returns counts. Anything you set by hand is left alone. */
export function applyResult(store, data, keyToSession) {
  const newIds = new Map();
  const resolveProject = ref => {
    if (ref == null) return null;
    if (newIds.has(ref)) return newIds.get(ref);
    const m = /^p(\d+)$/.exec(ref);
    if (m && store.project(Number(m[1]))) return Number(m[1]);
    return undefined; // unknown reference — ignore
  };
  let created = 0, assigned = 0, items = 0;

  for (const p of data.new_projects ?? []) {
    const name = String(p.name ?? '').trim().slice(0, 80);
    if (!name || newIds.has(p.key)) continue;
    const existing = store.projects().find(x => x.name.toLowerCase() === name.toLowerCase());
    newIds.set(p.key, existing ? existing.id : store.createProject(name, String(p.description ?? '').slice(0, 300)));
    if (!existing) created++;
  }
  for (const u of data.project_updates ?? []) {
    const id = resolveProject(u.id);
    if (!id) continue;
    store.updateProject(id, { name: u.name?.slice(0, 80), description: u.description?.slice(0, 300), archived: u.archive ? true : undefined });
  }
  for (const a of data.assignments ?? []) {
    const sessionId = keyToSession.get(a.session);
    if (!sessionId) continue;
    const pid = resolveProject(a.project);
    if (pid === undefined) continue;
    if (store.assignByOrganiser(sessionId, pid)) {
      assigned++;
      if (pid) store.touchProject(pid);
    }
  }
  for (const c of data.checklist ?? []) {
    const pid = resolveProject(c.project);
    if (!pid) continue;
    const have = store.checklist(pid);
    for (const u of c.update ?? []) {
      if (have.some(h => h.id === u.id)) { store.updateChecklistItem(u.id, { state: u.state, text: u.text }); items++; }
    }
    for (const a of c.add ?? []) {
      const text = String(a.text ?? '').trim().slice(0, 140);
      if (!text || have.some(h => h.text.toLowerCase() === text.toLowerCase())) continue;
      store.addChecklistItem(pid, text, a.state, { sourceSession: keyToSession.get(a.session) ?? null });
      have.push({ text });
      items++;
    }
  }
  return { created, assigned, items };
}

export class Organiser {
  constructor({ store, config, claudeExe, cwd, callModelFn = callModel, onRate = () => {}, log = console }) {
    Object.assign(this, { store, config, claudeExe, cwd, callModelFn, onRate, log });
    this.running = false;
    this.lastRunAt = 0;
  }

  today() { return new Date().toISOString().slice(0, 10); }

  /** Stop an in-flight organiser call (used on shutdown). */
  async stop() { if (this.childPid) await killTree(this.childPid); }

  status() {
    return {
      running: this.running,
      callsToday: this.store.organiserCallsOn(this.today()),
      cap: this.config.dailyCallCap,
      lastRun: this.store.lastOrganiserRun(),
    };
  }

  /** Sessions whose transcript changed since they were last organised and have gone quiet for a minute. */
  pending(rows, now = Date.now()) {
    // New sessions are filed straight away; already-filed ones only after another hour's worth of activity,
    // so a busy session doesn't cost an organiser call every time it goes quiet.
    const refileAfter = this.config.refileAfterMs ?? 3_600_000;
    return rows.filter(r => {
      if (!r.transcript || r.projectLocked || !(r.firstPrompt || r.title) || r.status === 'busy') return false;
      if (now - Date.parse(r.lastActivity ?? 0) <= 60_000) return false;
      const last = this.store.sessionMeta(r.id)?.organised_mtime ?? 0;
      return last === 0 ? true : r.mtimeMs - last > refileAfter;
    });
  }

  /** Called on every board refresh; runs at most every debounceMs, within the daily cap. */
  async maybeRun(rows, { force = false } = {}) {
    if (this.running) return { skipped: 'already running' };
    const wait = this.lastFailed ? this.config.debounceMs * 4 : this.config.debounceMs;
    if (!force && Date.now() - this.lastRunAt < wait) return { skipped: 'debounce' };
    const todo = this.pending(rows);
    if (!todo.length) return { skipped: 'nothing to do' };
    if (this.store.organiserCallsOn(this.today()) >= this.config.dailyCallCap) return { skipped: 'daily cap reached' };
    return this.run(todo.slice(0, this.config.batchSize));
  }

  async run(batch) {
    this.running = true;
    this.lastRunAt = Date.now();
    try {
      const keyToSession = new Map();
      const sessions = batch.map((r, i) => {
        keyToSession.set(`s${i + 1}`, r.id);
        return { key: `s${i + 1}`, projectId: r.projectId, folder: r.cwd ? path.basename(r.cwd) : '?', branch: r.branch,
          title: r.title, firstPrompt: r.firstPrompt, lastPrompt: r.lastPrompt, summary: r.summary, lastAssistant: r.lastAssistant };
      });
      const projects = this.store.projects().map(p => ({ ...p, checklist: this.store.checklist(p.id) }));
      const res = await this.callModelFn({ engine: defaultEngine(this.store), codexModels: this.store.get('codexModels', []), claudeExe: this.claudeExe, cwd: this.cwd, model: this.config.model,
        prompt: buildPrompt(projects, sessions), onSpawn: pid => { this.childPid = pid; }, onRate: this.onRate });
      this.childPid = null;
      this.store.logOrganiserRun(this.today(), batch.length, res.ok, res.costUsd, res.error ?? null);
      this.lastFailed = !res.ok;
      if (!res.ok) { this.log.warn?.(`[organiser] ${res.error}`); return { ok: false, error: res.error }; }
      const counts = applyResult(this.store, res.data, keyToSession);
      for (const r of batch) this.store.upsertSession(r.id, { organised_mtime: r.mtimeMs, cwd: r.cwd });
      return { ok: true, ...counts };
    } finally {
      this.running = false;
    }
  }
}
