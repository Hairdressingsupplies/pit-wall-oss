// Builds the board: live terminal sessions + Pit Wall's own sessions + recently closed ones.
import fs from 'node:fs';
import path from 'node:path';
import { summariseTranscript, tokensToday } from './transcripts.mjs';
import { slugForCwd } from './config.mjs';
import { analyseTranscript } from './insights.mjs';
import { PLACEHOLDER, realName } from './titler.mjs';

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const RESTING_DAYS = 3; // after this long untouched, a chat from before a restart is filed under Closed

export class Scanner {
  constructor({ sessionsDir, projectsDir, projectsDirs = [projectsDir], recentDays, isExcludedProjectDir, pidAlive: alive = pidAlive }) {
    Object.assign(this, { sessionsDir, projectsDir, projectsDirs, recentDays, isExcludedProjectDir, alive });
    this.cache = new Map();   // file -> {key, meta}
    this.tokCache = new Map(); // file -> {key, day, tokens}
    this.weekCache = new Map(); // file -> {key, value}
  }

  /** Live interactive terminals from ~/.claude/sessions/*.json, minus Pit Wall's own children. */
  liveTerminals(excludePids = new Set()) {
    let files = [];
    try { files = fs.readdirSync(this.sessionsDir).filter(f => f.endsWith('.json')); } catch { return []; }
    const out = [];
    for (const f of files) {
      let s;
      try { s = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, f), 'utf8')); } catch { continue; }
      if (!s?.sessionId || excludePids.has(s.pid) || !this.alive(s.pid)) continue;
      if (s.cwd && this.isExcludedProjectDir(slugForCwd(s.cwd))) continue; // Pit Wall's organiser, temp scratch
      out.push({
        pid: s.pid, sessionId: s.sessionId, cwd: s.cwd, name: s.name, status: s.status ?? 'unknown',
        kind: s.kind, startedAt: s.startedAt, procStart: s.procStart ?? null, statusUpdatedAt: s.statusUpdatedAt ?? s.updatedAt,
      });
    }
    return out;
  }

  /** sessionId -> transcript path, for recent transcripts (plus any ids asked for explicitly). */
  transcriptIndex(wantIds = new Set()) {
    const cutoff = Date.now() - this.recentDays * 86_400_000;
    const out = new Map();
    for (const root of this.projectsDirs) {
      let dirs = [];
      try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { continue; }
      for (const d of dirs) {
        if (this.isExcludedProjectDir(d.name)) continue;
        const dir = path.join(root, d.name);
        let files = [];
        try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
        for (const f of files) {
          const id = f.slice(0, -6);
          const file = path.join(dir, f);
          let st;
          try { st = fs.statSync(file); } catch { continue; }
          if (st.mtimeMs >= cutoff || wantIds.has(id)) out.set(id, { file, size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    }
    return out;
  }

  summary(file, size, mtimeMs) {
    const key = `${size}:${mtimeMs}`;
    const c = this.cache.get(file);
    if (c?.key === key) return c.meta;
    const meta = summariseTranscript(file);
    this.cache.set(file, { key, meta });
    return meta;
  }

  /** Last 7 days of this session: usage, edits, commits… (see analyseTranscript). Cached per file version and hour. */
  week(file, size, mtimeMs) {
    const hour = new Date().toISOString().slice(0, 13);
    const key = `${size}:${mtimeMs}:${hour}`;
    const c = this.weekCache.get(file);
    if (c?.key === key) return c.value;
    // A busy session's transcript changes every few seconds and can be tens of MB — re-read it at most once
    // a minute, so the board refresh never stalls the server while sessions are working.
    if (c && c.hour === hour && Date.now() - c.at < 60_000) return c.value;
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const value = analyseTranscript(file, since);
    this.weekCache.set(file, { key, value, hour, at: Date.now() });
    return value;
  }

  tokens(file, size, mtimeMs) {
    const day = new Date().toDateString();
    const key = `${size}:${mtimeMs}`;
    const c = this.tokCache.get(file);
    if (c?.key === key && c.day === day) return c.tokens;
    const tokens = tokensToday(file);
    this.tokCache.set(file, { key, day, tokens });
    return tokens;
  }

  /**
   * One row per session. runs: Map of Pit Wall runs (publicRun shape); meta: Map sessionId -> session_meta row.
   */
  board({ runs, meta, excludePids, hookStatus = new Map() }) {
    const terminals = this.liveTerminals(excludePids);
    const liveIds = new Set(terminals.map(t => t.sessionId));
    const want = new Set([...liveIds, ...runs.keys(), ...[...meta.values()].filter(m => m.project_id).map(m => m.session_id)]);
    const index = this.transcriptIndex(want);
    const ids = new Set([...index.keys(), ...liveIds, ...runs.keys()]);
    const termById = new Map(terminals.map(t => [t.sessionId, t]));

    const rows = [];
    for (const id of ids) {
      const t = index.get(id);
      const m = t ? this.summary(t.file, t.size, t.mtimeMs) : null;
      const run = runs.get(id) ?? null;
      const term = termById.get(id) ?? null;
      const sm = meta.get(id) ?? null;
      if (sm?.hidden) continue;
      if (!m && !run && !term) continue;
      // Background runs through the Python Agent SDK (e.g. the security-guidance plugin's review after every commit)
      // aren't chats: they'd flood the board and use organiser calls. Pit Wall's own are sdk-cli, terminals cli.
      // Hidden while they run too: their process registers like a terminal for the minute or so a review takes.
      if (m?.entrypoint === 'sdk-py' && !run) continue;

      // A chat Pit Wall was running before a restart is still yours to carry on: it comes back resting, not closed.
      const lastSeen = Date.parse(m?.lastActivity ?? 0) || 0;
      const resting = !run && !term && !!sm?.run_here && !sm.superseded_by && Date.now() - lastSeen < RESTING_DAYS * 86_400_000;
      const source = run?.running ? 'pitwall' : term ? 'terminal' : run || resting ? 'pitwall' : 'closed';
      const row = {
        id,
        source,
        // "New session" written into older transcripts as a custom title is a placeholder, not a name.
        name: sm?.display_name || realName(run?.name) || realName(m?.customTitle) || m?.title || sm?.auto_title || term?.name || PLACEHOLDER,
        title: m?.title ?? sm?.auto_title ?? null,
        terminalName: term?.name ?? null,
        cwd: run?.cwd ?? m?.cwd ?? term?.cwd ?? sm?.cwd ?? null,
        branch: m?.gitBranch ?? null,
        firstPrompt: m?.firstPrompt ?? null,
        lastPrompt: m?.lastPrompt ?? null,
        lastAssistant: m?.lastAssistant ?? null,
        summary: m?.awaySummary ?? null,
        // When the chat began. Unlike lastActivity it never changes, so the board can order by it without jumping.
        startedAt: m?.startedAt ?? run?.startedAt ?? null,
        lastActivity: [run?.lastActivity, m?.lastActivity].filter(Boolean).sort().pop() ?? null,
        mtimeMs: t?.mtimeMs ?? 0,
        tokensToday: t ? this.tokens(t.file, t.size, t.mtimeMs) : 0,
        context: m?.context ?? 0,
        week: t ? this.week(t.file, t.size, t.mtimeMs) : null,
        supersededBy: sm?.superseded_by ?? null,
        color: sm?.color ?? null,
        projectId: sm?.project_id ?? null,
        projectLocked: !!sm?.project_locked,
        transcript: t?.file ?? null,
        status: 'closed',
        needsYou: null,
        pending: [],
        jobs: 0,
        run: run ?? null,
      };

      if (run && (run.running || !term)) {
        row.status = run.status;
        row.pending = run.pending;
        row.jobs = run.agentsWorking ?? 0;
        if (run.pending.length) row.needsYou = { exact: true, reason: run.pending[0].kind === 'question' ? 'Asked you a question' : run.pending[0].toolName === 'ExitPlanMode' ? 'Has a plan for you to approve' : `Wants to use ${run.pending[0].toolName}` };
        else if (run.status === 'your_turn') row.needsYou = { exact: true, reason: 'Finished — your turn', soft: true };
        else if (run.status === 'error') row.needsYou = { exact: true, reason: run.error ?? 'Stopped with an error' };
      } else if (term) {
        row.status = term.status === 'busy' ? 'busy' : term.status === 'shell' ? 'shell' : 'idle';
        row.pid = term.pid;
        row.procStart = term.procStart ?? null;
        const hook = hookStatus.get(id);
        // A hook event is only trusted while nothing newer has happened in the transcript.
        const hookCurrent = hook && (!t || t.mtimeMs <= Date.parse(hook.at) + 3000);
        const recent = Date.now() - Date.parse(row.lastActivity ?? 0) < 48 * 3600_000;
        if (hookCurrent && hook.state === 'permission') row.needsYou = { exact: true, reason: hook.message || 'Waiting on a permission prompt' };
        else if (hookCurrent && hook.state === 'question') row.needsYou = { exact: true, reason: hook.message || 'Asked you a question' };
        else if (hookCurrent && (hook.state === 'stopped' || hook.state === 'idle')) {
          row.needsYou = m?.endedWithQuestion ? { exact: true, reason: 'Asked you a question' } : { exact: true, reason: 'Finished — your turn', soft: true };
        } else if (hookCurrent && hook.state === 'busy') { /* working */ }
        else if (!recent) { /* a days-old idle terminal is parked, not waiting */ }
        else if (row.status === 'idle' && m?.pendingToolUse) row.needsYou = { exact: false, reason: 'Probably waiting on a permission prompt' };
        else if (row.status === 'idle' && m?.endedWithQuestion) row.needsYou = { exact: false, reason: 'Asked you a question' };
        // Agents or a workflow it launched are still running: the reply has ended but the work has not.
        // Only launches since this terminal process started count — anything older died with the last one.
        const since = Date.parse(typeof term.startedAt === 'number' ? new Date(term.startedAt).toISOString() : term.startedAt ?? 0) || 0;
        const open = (m?.openJobs ?? []).filter(j => !j.at || Date.parse(j.at) >= since);
        if (open.length && row.status === 'idle' && (!row.needsYou || row.needsYou.soft)) {
          row.status = 'agents_working';
          row.jobs = open.length;
          row.needsYou = null;
        }
      } else if (resting && !sm.interrupted) {
        row.status = 'parked';
      } else if (sm?.interrupted) {
        row.status = 'interrupted';
        row.needsYou = { exact: true, reason: 'Interrupted by a restart — open it and press Continue', interrupted: true };
      }
      // Finished by you: off the board and never "needs you" — until there is new activity after that moment.
      if (sm?.done_at && (!row.lastActivity || Date.parse(row.lastActivity) <= Date.parse(sm.done_at) + 5000)) {
        row.done = true;
        row.doneAt = sm.done_at;
        row.needsYou = null;
      }
      if (row.needsYou && sm?.snoozed_until && Date.parse(sm.snoozed_until) > Date.now()) {
        row.snoozedUntil = sm.snoozed_until;
        row.needsYou = null;
      }
      rows.push(row);
    }
    rows.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
    return rows;
  }
}
