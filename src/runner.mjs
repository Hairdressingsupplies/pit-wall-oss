// Runs Claude Code sessions for Pit Wall: one `claude -p` stream-json child per open chat.
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { buildArgs, childEnv, classify, controlRequest, interruptRequest, isWork, permissionResponse, userMessage } from './protocol.mjs';
import { NO_FILE_UNDO } from './codex-translate.mjs';
import { nextCronTime } from './schedule.mjs';

const MAX_ITEMS = 600;
const MAX_SUBS = 1500;          // subagent steps are kept apart so a chatty agent can't push the conversation out
const SETTLE_MS = 8000;         // how long to wait for Claude's own reply after the last agent finishes
const AWAIT_CAP_MS = 30 * 60_000; // a timed-out command still running after this is treated as a server, not work
const READY_MS = 8000;          // a resumed chat waits at most this long for Claude Code's "ready" before Pit Wall writes
const CALL_MS = 120_000;        // how long a control request (side question, rewind …) may take

export function killTree(pid) {
  return new Promise(resolve => {
    if (!pid) return resolve();
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve());
    else { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } resolve(); }
  });
}

/**
 * Events: 'run' (publicRun) whenever a run's state changes · 'item' (sessionId, item) ·
 *         'delta' (sessionId, text) · 'progress' (sessionId, turn) · 'rate' (info) · 'commands' (cwd, slash command names)
 * A run's status: starting · busy · needs_you · agents_working (reply done, agents or an awaited command still running) · your_turn ·
 *         parked · stopped · error
 */
export class Runner extends EventEmitter {
  constructor({ claudeExe, bridgePath = null, maxRunning = 6, idleParkMinutes = 20, defaultPermissionMode = null, defaultEffort = null, chromeFn = () => false, dangerFn = () => [], settleMs = SETTLE_MS, awaitCapMs = AWAIT_CAP_MS, spawnFn = spawn, killFn = killTree, now = () => new Date().toISOString(), codexBlocked = () => null }) {
    super();
    this.claudeExe = claudeExe;
    this.bridgePath = bridgePath; // src/codex-bridge.mjs: a Codex chat runs it under node, speaking Claude's stream-json
    this.maxRunning = maxRunning;
    this.idleParkMs = idleParkMinutes == null ? Infinity : idleParkMinutes * 60_000; // null: never park for idleness
    this.spawnFn = spawnFn;
    this.killFn = killFn;
    this.defaultPermissionMode = defaultPermissionMode;
    this.defaultEffort = defaultEffort;
    this.chromeFn = chromeFn;
    this.dangerFn = dangerFn;
    this.settleMs = settleMs;
    this.awaitCapMs = awaitCapMs;
    this.now = now;
    // Why a Codex chat can't start right now (Codex is being installed: its exe is being replaced), else null.
    this.codexBlocked = codexBlocked;
    this.runs = new Map();
    this.reaper = setInterval(() => this.parkIdle(), 60_000);
    this.reaper.unref?.();
  }

  /** PIDs of every child Pit Wall is running (so the board doesn't list them as terminals). */
  childPids() {
    return new Set([...this.runs.values()].filter(r => r.proc).map(r => r.pid));
  }

  get(sessionId) { return this.runs.get(sessionId) ?? null; }

  /** Everything the chat view needs from a live run: the conversation, then subagent steps and workflow progress. */
  liveItems(r) {
    return [...r.items, ...r.subs, ...r.workflows.values()];
  }

  /**
   * Where a live run stands. A prompt can come from a background agent after the reply has ended, so answering
   * one goes back to whatever was true before it, not always to "working".
   */
  #statusNow(r) {
    if (r.pending.size) return 'needs_you';
    if (r.turnOpen) return 'busy';
    return this.#agentJobs(r).length ? 'agents_working' : 'your_turn';
  }

  #jobs(r) { return [...r.tasks.values()].filter(t => t.background); }
  #agentJobs(r) { return this.#jobs(r).filter(t => this.#working(t)); }

  /** A timed-out command that has run on for half an hour is most likely a server Claude started by mistake. */
  #working(t) {
    if (!isWork(t)) return false;
    return !t.awaited || !t.bgAt || Date.parse(this.now()) - Date.parse(t.bgAt) < this.awaitCapMs;
  }

  /** A command Claude was waiting on has gone to the background: count it as work, until the cap. */
  #backgrounded(r, t) {
    if (!t.awaited || t.bgAt) return;
    t.bgAt = this.#ts(r);
    const left = this.awaitCapMs - (Date.parse(this.now()) - Date.parse(t.bgAt));
    const timer = setTimeout(() => {
      if (r.status !== 'agents_working' || this.#agentJobs(r).length) return;
      r.status = this.#statusNow(r);
      this.#changed(r);
    }, Math.max(0, left) + 50);
    timer.unref?.();
  }

  publicRun(r) {
    return {
      sessionId: r.sessionId, cwd: r.cwd, name: r.name, engine: r.engine ?? 'claude', model: r.model, permissionMode: r.permissionMode, effort: r.effort,
      status: r.status, startedAt: r.startedAt, lastActivity: r.lastActivity, costUsd: r.costUsd,
      pending: [...r.pending.entries()].map(([requestId, { raw, ...p }]) => ({ requestId, ...p })),
      partial: r.partial, turn: this.#turnView(r), queued: [...r.queued.values()].map(({ uuid, text, ts }) => ({ uuid, text, ts })), error: r.error, running: !!r.proc, adopted: !!r.adopted, lost: !!r.lost,
      backgroundTasks: this.#jobs(r).length, agentsWorking: this.#agentJobs(r).length,
      jobs: this.#jobs(r).map(t => ({ id: t.id, type: t.type, description: t.description, working: this.#working(t), startedAt: t.startedAt ?? null, toolUseId: t.toolUseId ?? null })),
      // A Codex chat with a turn map (its bridge said so at init) can fork and rewind; Claude chats always can.
      codexBranching: r.engine === 'codex' ? !!r.codexBranching : undefined,
    };
  }

  /** New session. Returns its id immediately; the process starts now. */
  start({ cwd, name, engine = 'claude', model, permissionMode, effort, disallowedTools, message, images = [] }) {
    const sessionId = randomUUID();
    const r = this.#launch({ sessionId, cwd, name, engine, model, permissionMode, effort, disallowedTools, resume: false });
    if (message || images.length) this.#write(r, message ?? '', images);
    return sessionId;
  }

  /** Send a message, (re)starting the process with --resume if it isn't running. priority 'now' interrupts the turn. */
  send(sessionId, text, opts = {}) {
    this.#write(this.#ensureProc(sessionId, opts), text, opts.images ?? [], opts.context, { priority: opts.priority });
  }

  /** The run, its process (re)started with --resume if it isn't running. opts: what a chat Pit Wall hasn't run yet needs. */
  #ensureProc(sessionId, opts = {}, { idle = false } = {}) {
    const r = this.runs.get(sessionId);
    if (r?.proc) return r;
    if (!opts.cwd && !r?.cwd) throw new Error('Unknown session — open it from the board first.');
    const run = this.#launch({ sessionId, cwd: opts.cwd ?? r.cwd, name: opts.name ?? r?.name, engine: opts.engine ?? r?.engine ?? 'claude', model: opts.model ?? r?.model,
      permissionMode: opts.permissionMode ?? r?.permissionMode, effort: opts.effort ?? r?.effort,
      disallowedTools: opts.disallowedTools ?? r?.disallowedTools, resume: true, waitReady: !!opts.waitReady, carry: r });
    if (idle) {
      // Started only to ask it something (btw, rewind): no message, so no turn — it must not show as working.
      run.turnOpen = false;
      run.status = 'your_turn';
      this.#changed(run);
    }
    return run;
  }

  /**
   * A copy of a chat, up to and including the Claude reply atUuid (the whole chat if none), as a new chat that starts
   * with `message`. The original is untouched. Returns the new chat's id.
   */
  fork(sessionId, { atUuid = null, message = '', images = [], ...opts } = {}) {
    const src = this.runs.get(sessionId);
    const cwd = opts.cwd ?? src?.cwd;
    if (!cwd) throw new Error('Unknown session — open it from the board first.');
    const engine = opts.engine ?? src?.engine ?? 'claude';
    const newId = randomUUID();
    // A Codex fork of a job stays a job (--job: approvals declined, apps/plugins/MCP off).
    const r = this.#launch({ sessionId: newId, cwd, name: `Fork of ${opts.name ?? src?.name ?? 'chat'}`, engine,
      model: opts.model ?? src?.model, permissionMode: opts.permissionMode ?? src?.permissionMode, effort: opts.effort ?? src?.effort,
      disallowedTools: engine === 'codex' ? src?.disallowedTools : undefined, forkFrom: sessionId, resumeAt: atUuid });
    this.#write(r, message, images);
    return newId;
  }

  /** /btw: a question about the chat that Claude answers without tools and without adding it to the conversation. */
  sideQuestion(sessionId, question, history = [], opts = {}) {
    return this.#call(this.#ensureProc(sessionId, opts, { idle: true }), 'side_question', { question, history });
  }

  /** Take back a message still waiting for Claude. false if Claude had already picked it up. */
  async cancelQueued(sessionId, uuid) {
    const r = this.runs.get(sessionId);
    if (!r?.proc || !r.queued.has(uuid)) return false;
    const res = await this.#call(r, 'cancel_async_message', { message_uuid: uuid });
    if (!res?.cancelled) return false;
    this.#dropMessage(r, uuid);
    this.#emit(r, 'reload', r.sessionId);
    this.#changed(r);
    return true;
  }

  /** A queued message, sent at once instead: Claude stops what it is doing and starts on it. */
  async sendNow(sessionId, uuid) {
    const r = this.runs.get(sessionId);
    const q = r?.queued.get(uuid);
    if (!q || !(await this.cancelQueued(sessionId, uuid))) return false;
    this.#write(r, q.text, q.images ?? [], '', { priority: 'now' });
    return true;
  }

  /** Which files Claude changed from this message of yours on, and whether they can be put back. */
  rewindPreview(sessionId, uuid, opts = {}) {
    if (this.#isCodex(sessionId, opts)) return Promise.resolve({ canRewind: false, codex: true, error: NO_FILE_UNDO }); // history only
    return this.#call(this.#ensureProc(sessionId, opts, { idle: true }), 'rewind_files', { user_message_id: uuid, dry_run: true });
  }

  /** Back to before one of your messages: it and what followed leave the chat (files too, if asked). Returns {prefillText}. */
  async rewind(sessionId, uuid, { files = false, ...opts } = {}) {
    const r = this.#ensureProc(sessionId, opts, { idle: true });
    if (files && r.engine !== 'codex') await this.#call(r, 'rewind_files', { user_message_id: uuid });
    const res = await this.#call(r, 'rewind_conversation', { target_message_uuid: uuid, interrupt_if_running: true });
    this.#cutAt(r, uuid);
    this.#emit(r, 'reload', r.sessionId);
    this.#changed(r);
    return res;
  }

  /** Stop one background task (a command, agent or workflow) without ending the chat. */
  stopTask(sessionId, taskId) {
    this.#claudeOnly(sessionId);
    const r = this.runs.get(sessionId);
    if (!r?.proc) throw new Error('That chat is not running.');
    return this.#call(r, 'stop_task', { task_id: taskId });
  }

  answer(sessionId, requestId, decision) {
    const r = this.runs.get(sessionId);
    const p = r?.pending.get(requestId);
    if (!r?.proc || !p) throw new Error('That request is no longer waiting.');
    r.stdin(permissionResponse(requestId, p.raw, decision));
    r.pending.delete(requestId);
    const label = decision.behavior === 'allow'
      ? (decision.answers ? `Answered: ${Object.values(decision.answers).join(', ')}` : p.toolName === 'ExitPlanMode' ? `Approved the plan${decision.mode ? ` — ${({ auto: 'auto', acceptEdits: 'accept edits', manual: 'ask each time' })[decision.mode] ?? decision.mode}` : ''}` : `Approved${decision.always ? ' (always)' : ''}: ${p.toolName}`)
      : p.toolName === 'ExitPlanMode' ? 'Sent the plan back' : `Denied: ${p.toolName}`;
    this.#item(r, { kind: 'note', text: label, ts: this.#ts(r) });
    r.status = this.#statusNow(r);
    this.#changed(r);
  }

  interrupt(sessionId) {
    const r = this.runs.get(sessionId);
    if (!r?.proc) return;
    r.stdin(interruptRequest(`pw-int-${randomUUID()}`));
  }

  async stop(sessionId) {
    const r = this.runs.get(sessionId);
    if (!r?.proc) return;
    r.stopping = true;
    await this.#kill(r);
  }

  /** Change model / permission mode / effort: takes effect by restarting the process on the next message. */
  async reconfigure(sessionId, { model, permissionMode, effort }) {
    const r = this.runs.get(sessionId);
    if (!r) return;
    if (model !== undefined) r.model = model || null;
    if (permissionMode !== undefined) r.permissionMode = permissionMode || null;
    if (effort !== undefined) r.effort = effort || null;
    // Mode and model switch at once while Claude runs; effort (or a switch Claude Code refused) applies from the next start.
    // A Codex chat has no live switch (set_model / set_permission_mode are Claude Code's): it always restarts.
    let restart = effort !== undefined || r.engine === 'codex';
    if (r.proc && !restart) {
      try {
        if (permissionMode !== undefined) await this.#call(r, 'set_permission_mode', { mode: permissionMode || this.defaultPermissionMode || 'default' });
        if (model !== undefined) await this.#call(r, 'set_model', model ? { model } : {});
      } catch { restart = true; }
    }
    if (restart && r.proc && r.status !== 'busy' && !r.tasks.size) { r.parking = true; await this.#kill(r); }
    this.#changed(r);
  }

  /**
   * A CronCreate that went through lives only in this process: keep the chat from being parked until it has fired
   * (one-shot) or for good (recurring, e.g. /loop). Later one-shots never get here — src/hook-cron.mjs makes them lasting.
   */
  #cronScheduled(r, input, ok) {
    if (!ok) return;
    const fires = input.recurring === false ? nextCronTime(input.cron, new Date())?.getTime() : Infinity;
    r.keepUntil = Math.max(r.keepUntil, (fires ?? Date.now()) + 5 * 60_000);
  }

  parkIdle(now = Date.now()) {
    for (const r of this.runs.values()) {
      // Never park a session with background jobs still running, or with a cron still to fire — ending the process would kill them.
      if (r.proc && r.status === 'your_turn' && !r.pending.size && !r.tasks.size && r.keepUntil <= now && now - Date.parse(r.lastActivity) > this.idleParkMs) {
        r.parking = true;
        this.#kill(r);
      }
    }
  }

  async shutdown() {
    clearInterval(this.reaper);
    // A chat under a relay carries on without the server (it is picked up again at the next start); others end.
    await Promise.all([...this.runs.values()].filter(r => r.proc).map(r => {
      if (r.proc.detach) { r.proc.detach(); return null; }
      r.stopping = true;
      return this.killFn(r.pid);
    }));
  }

  // ── internals ──────────────────────────────────────────────────────────
  #isCodex(sessionId, opts = {}) { return (opts.engine ?? this.runs.get(sessionId)?.engine) === 'codex'; }

  /** Stopping a task is a Claude Code control request the bridge doesn't have. */
  #claudeOnly(sessionId, opts = {}) {
    if (this.#isCodex(sessionId, opts)) throw new Error('Not available in Codex chats.');
  }

  #ensureCapacity() {
    const live = [...this.runs.values()].filter(r => r.proc);
    if (live.length < this.maxRunning) return;
    const idle = live.filter(r => r.status === 'your_turn' && !r.pending.size && !r.tasks.size)
      .sort((a, b) => a.lastActivity.localeCompare(b.lastActivity));
    if (!idle.length) throw new Error(`All ${this.maxRunning} session slots are busy — wait for one to finish or stop one.`);
    idle[0].parking = true;
    this.#kill(idle[0]);
  }

  #launch({ sessionId, cwd, name, engine = 'claude', model, permissionMode, effort, disallowedTools, resume, forkFrom = null, resumeAt = null, waitReady = false, carry }) {
    const codex = engine === 'codex';
    // The one gate for every Codex start/resume (new chats, messages to a parked chat, queue jobs): refuse before
    // making room or spawning anything.
    const blocked = codex ? this.codexBlocked() : null;
    if (blocked) throw Object.assign(new Error(blocked), { status: 409 });
    this.#ensureCapacity();
    // A Codex chat runs the bridge under node with its own effort only (the default effort is a Claude setting);
    // a queue job (it always blocks some tools) tells the bridge so with --job.
    const exe = codex ? process.execPath : this.claudeExe;
    const args = codex
      ? [this.bridgePath, resume ? '--resume' : '--session-id', sessionId, '--replay-user-messages',
          ...(forkFrom ? ['--fork-from', forkFrom, ...(resumeAt ? ['--fork-at', resumeAt] : [])] : []), // a fork: new id, the relay keys on it
          ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), ...(disallowedTools?.length ? ['--job'] : [])]
      : buildArgs({ sessionId, resume, forkFrom, resumeAt, name, model, permissionMode: permissionMode ?? this.defaultPermissionMode,
        effort: effort ?? this.defaultEffort, chrome: this.chromeFn(), disallowedTools });
    // `pitwall` is ignored by a plain spawn; a relay keeps it so a restarted server can adopt the chat as it was.
    const meta = { sessionId, name, engine, model: model ?? null, permissionMode: permissionMode ?? null, effort: effort ?? null, disallowedTools: disallowedTools ?? null };
    // File checkpoints let Rewind put Claude's file edits back (Claude Code only keeps them when asked at launch).
    const env = codex ? childEnv() : { ...childEnv(), CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'true' };
    const proc = this.spawnFn(exe, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], pitwall: meta });
    const r = this.#newRun({ ...meta, cwd, proc, costUsd: carry?.costUsd ?? 0, turnOpen: true });
    r.freshFork = !!forkFrom; // reload the page once its first reply is in: the copied history only exists from then
    r.echoes = true; // launched with --replay-user-messages
    if (waitReady) {
      // Resuming a fork: it says when it is ready ('status'); a message written before that stalls it. (Ordinary resumes
      // send no 'status' before input, so they are not held.)
      r.ready = false;
      r.readyTimer = setTimeout(() => this.#flush(r), READY_MS);
      r.readyTimer.unref?.();
    }
    return this.#wire(r);
  }

  /**
   * Take over a chat still running under a relay that an earlier Pit Wall started. Its log is replayed first
   * (quietly — no items, notifications or 'run' events) so the run knows where it stands, then it carries on live.
   */
  adopt({ sessionId, cwd, name, engine = 'claude', model, permissionMode, effort, disallowedTools, proc, echoes = false }) {
    const r = this.#newRun({ sessionId, cwd, name, engine, model: model ?? null, permissionMode: permissionMode ?? null, effort: effort ?? null,
      disallowedTools: disallowedTools ?? null, proc, costUsd: 0, turnOpen: false });
    r.echoes = echoes;
    r.replaying = true;
    r.adopted = true;
    return this.#wire(r);
  }

  #newRun({ proc, turnOpen, costUsd, ...meta }) {
    return {
      ...meta, proc, pid: proc.pid, status: 'starting', startedAt: this.now(), lastActivity: this.now(),
      items: [], subs: [], workflows: new Map(), partial: '', pending: new Map(), tasks: new Map(), settle: null, turnOpen, costUsd, error: null, stderr: '',
      stopping: false, parking: false, replaying: false, clock: null, crons: new Map(), keepUntil: 0,
      calls: new Map(), queued: new Map(), awaiting: false, ready: true, outbox: [],
    };
  }

  #wire(r) {
    const proc = r.proc;
    const raw = obj => { try { proc.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* process gone */ } };
    r.stdin = obj => (r.ready ? raw(obj) : r.outbox.push(obj));
    r.rawStdin = raw;
    this.runs.set(r.sessionId, r);
    readline.createInterface({ input: proc.stdout }).on('line', line => {
      let e;
      try { e = JSON.parse(line); } catch { return; }
      if (e.type === 'pitwall_clock') { r.clock = new Date(e.t).toISOString(); r.firstClock ??= r.clock; return; }
      if (e.type === 'pitwall_input') { this.#replayInput(r, e.line); return; }
      if (e.type === 'pitwall_replayed') { this.#endReplay(r); return; }
      for (const a of classify(e, () => this.#ts(r))) this.#apply(r, a);
    });
    proc.stderr.on('data', d => { r.stderr = (r.stderr + d).slice(-4000); });
    proc.on('spawn', () => { r.pid = proc.pid; });
    proc.on('error', err => { r.error = `Could not start Claude Code: ${err.message}`; this.#exited(r, proc, null); });
    proc.on('exit', code => this.#exited(r, proc, code));
    this.#changed(r);
    return r;
  }

  /** Replaying: something Pit Wall wrote to claude earlier — a message (a turn began) or an answer (no longer pending). */
  #replayInput(r, line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === 'user') {
      const c = m.message?.content;
      const text = (typeof c === 'string' ? c : (c ?? []).filter(b => b?.type === 'text').map(b => b.text).join('\n'))
        .replace(/<bash-input>[\s\S]*?<\/bash-stderr>\s*/g, '').trim(); // "! command" context, shown separately
      const queued = r.awaiting && !m.priority && r.echoes;
      r.turnOpen = true;
      r.status = 'busy';
      if (!queued) this.#beginTurn(r);
      r.awaiting = true;
      if (queued && m.uuid) r.queued.set(m.uuid, { uuid: m.uuid, text, ts: this.#ts(r) });
      this.#item(r, { kind: 'user', text, uuid: m.uuid ?? null, images: [], ts: this.#ts(r) });
    } else if (m.type === 'control_request' && m.request?.subtype === 'rewind_conversation') {
      this.#cutAt(r, m.request.target_message_uuid);
    } else if (m.type === 'control_request' && m.request?.subtype === 'cancel_async_message') {
      this.#dropMessage(r, m.request.message_uuid);
    } else if (m.type === 'control_response') {
      r.pending.delete(m.response?.request_id);
      r.status = this.#statusNow(r);
    }
  }

  #endReplay(r) {
    // Cleared even for a fresh chat: its relay can send a clock line before "replayed", which would otherwise
    // stamp every later item and turn with that moment.
    r.clock = null;
    if (!r.replaying) return;
    r.replaying = false;
    // The process started when the relay did, not now: history before that comes from the transcript, after from the replay.
    if (r.firstClock) r.startedAt = r.firstClock;
    if (r.proc) r.status = this.#statusNow(r);
    this.#changed(r);
  }

  #exited(r, proc, code) {
    if (r.proc !== proc) return;
    r.replaying = false;
    r.clock = null;
    r.lost = !!proc.lost; // the relay vanished without claude's exit (killed, or the PC restarted): it was cut off
    r.proc = null;
    r.partial = '';
    r.pending.clear();
    r.queued.clear();
    r.awaiting = false;
    clearTimeout(r.readyTimer);
    for (const c of r.calls.values()) { clearTimeout(c.timer); c.reject(new Error('Claude Code stopped.')); }
    r.calls.clear();
    this.#endWorkflows(r);
    r.tasks.clear();
    r.crons.clear();
    r.keepUntil = 0; // its crons died with the process
    clearTimeout(r.settle);
    if (r.parking) r.status = 'parked';
    else if (r.stopping) { r.status = 'stopped'; this.#item(r, { kind: 'note', text: 'Session stopped.', ts: this.#ts(r) }); }
    else if (code !== 0 && code !== null) {
      r.status = 'error';
      r.error ??= (r.stderr.trim().split('\n').slice(-3).join(' ') || `Claude Code exited with code ${code}`);
    } else r.status = 'parked';
    r.parking = false;
    r.stopping = false;
    this.#changed(r);
  }

  /** context: sent to Claude ahead of the text but not shown as part of the message (e.g. "! command" output). */
  #write(r, text, images = [], context = '', { priority } = {}) {
    // Our own id for the message: Claude Code keeps it, so it can be rewound to or taken back while queued.
    const uuid = randomUUID();
    // Sent while Claude is still on an earlier message: it waits ("Queued") until Claude picks it up.
    const queued = r.awaiting && !priority && r.echoes; // a process that never echoes would leave it "Queued" for ever
    r.stdin(userMessage(context ? `${context}\n\n${text}` : text, images, { uuid, priority }));
    r.turnOpen = true;
    r.status = 'busy';
    r.error = null;
    if (!queued) this.#beginTurn(r); // a queued message must not restart the working line's timer
    r.awaiting = true;
    if (queued) r.queued.set(uuid, { uuid, text, images, ts: this.#ts(r) });
    this.#item(r, { kind: 'user', text, uuid, images: images.map(i => `data:${i.mediaType};base64,${i.data}`), ts: this.#ts(r) });
    this.#changed(r);
  }

  /** A control request to Claude Code; resolves with its answer, rejects on an error answer, a timeout or the process ending. */
  #call(r, subtype, body = {}, ms = CALL_MS) {
    return new Promise((resolve, reject) => {
      const id = `pw-${subtype}-${randomUUID()}`;
      const timer = setTimeout(() => { r.calls.delete(id); reject(new Error('Claude Code did not answer in time.')); }, ms);
      timer.unref?.();
      r.calls.set(id, { resolve, reject, timer });
      r.stdin(controlRequest(id, subtype, body));
    });
  }

  /** Claude Code is ready: write what was held back. */
  #flush(r) {
    if (r.ready) return;
    r.ready = true;
    clearTimeout(r.readyTimer);
    for (const o of r.outbox.splice(0)) r.rawStdin(o);
  }

  /** Rewound to before message uuid: it and everything after it leave the live chat. */
  #cutAt(r, uuid) {
    const i = r.items.findIndex(x => x.kind === 'user' && x.uuid === uuid);
    if (i >= 0) r.items.splice(i);
    else r.items = []; // it was before this process started: all the live items came after it
    r.queued.clear();
    r.partial = '';
  }

  #dropMessage(r, uuid) {
    r.queued.delete(uuid);
    r.items = r.items.filter(x => x.uuid !== uuid);
  }

  #item(r, item) {
    r.items.push(item);
    if (r.items.length > MAX_ITEMS) r.items.splice(0, r.items.length - MAX_ITEMS);
    r.lastActivity = item.ts ?? this.#ts(r);
    this.#emit(r, 'item', r.sessionId, item);
  }

  #apply(r, a) {
    switch (a.do) {
      case 'init':
        r.model = r.model ?? a.model ?? null;
        r.actualModel = a.model;
        if (r.engine === 'codex') r.codexBranching = !!a.branching;
        if (r.status === 'starting') r.status = 'busy';
        if (a.slashCommands) this.#emit(r, 'commands', r.cwd, a.slashCommands);
        break;
      case 'busy': {
        r.turnOpen = true;
        r.status = this.#statusNow(r);
        r.partial = '';
        // A new message within the turn: the last one's count is final.
        const t = r.turn ?? this.#beginTurn(r);
        t.done += t.real ?? Math.round(t.chars / 4);
        t.real = null;
        t.chars = 0;
        break;
      }
      case 'ready':
        this.#flush(r);
        return;
      case 'picked':
        if (r.queued.delete(a.uuid)) break;
        return;
      case 'control_response': {
        const c = r.calls.get(a.requestId);
        if (!c) return;
        r.calls.delete(a.requestId);
        clearTimeout(c.timer);
        if (a.ok) c.resolve(a.response); else c.reject(new Error(a.error || 'Claude Code refused that.'));
        return;
      }
      case 'delta':
        r.partial += a.text;
        r.lastActivity = this.#ts(r);
        this.#emit(r, 'delta', r.sessionId, a.text);
        this.#progress(r, { chars: a.text.length, activity: null });
        return;
      case 'activity':
        r.lastActivity = this.#ts(r);
        this.#progress(r, { chars: a.chars, activity: a.what });
        return;
      case 'tokens':
        if (r.turn) r.turn.real = a.n;
        this.#progress(r, {});
        return;
      case 'item':
        if (a.item.kind === 'assistant') r.partial = '';
        if (a.item.kind === 'tool') this.#progress(r, { activity: { tool: a.item.name, summary: String(a.item.summary ?? '').slice(0, 60) } });
        else if (a.item.kind === 'tool_result') this.#progress(r, { activity: null });
        if (a.item.kind === 'tool' && a.item.name === 'CronCreate') r.crons.set(a.item.id, a.item.input ?? {});
        if (a.item.kind === 'tool_result' && r.crons.has(a.item.id)) this.#cronScheduled(r, r.crons.get(a.item.id), !a.item.isError);
        if (a.item.kind === 'sub') { this.#sub(r, a.item); return; }
        this.#item(r, a.item);
        break;
      case 'workflow':
        r.workflows.set(a.item.parent, a.item);
        r.lastActivity = this.#ts(r);
        this.#emit(r, 'item', r.sessionId, a.item);
        return;
      case 'turn_end':
        // The reply is finished, but agents or a workflow it launched may still be working.
        clearTimeout(r.settle);
        r.turnOpen = false;
        r.status = this.#statusNow(r);
        r.partial = '';
        r.turn = null;
        r.awaiting = r.queued.size > 0; // a message still queued starts the next turn
        if (r.freshFork) { r.freshFork = false; this.#emit(r, 'reload', r.sessionId); }
        if (a.costUsd != null) r.costUsd = a.costUsd;
        if (a.isError && a.subtype !== 'error_during_execution') this.#item(r, { kind: 'note', text: `Turn ended with an error: ${a.text}`, ts: this.#ts(r) });
        break;
      case 'permission': {
        const q = a.request.tool_name === 'AskUserQuestion';
        r.pending.set(a.requestId, {
          kind: q ? 'question' : 'permission', toolName: a.request.tool_name, input: a.request.input,
          reason: a.request.decision_reason ?? null, canAlways: !!a.request.permission_suggestions?.length, raw: a.request,
          danger: this.dangerFn(a.request.tool_name, a.request.input),
        });
        r.status = 'needs_you';
        break;
      }
      case 'cancel':
        r.pending.delete(a.requestId);
        if (r.status === 'needs_you') r.status = this.#statusNow(r);
        this.#settle(r);
        break;
      case 'rate':
        this.#emit(r, 'rate', a.info);
        return;
      case 'rate_codex':
        this.#emit(r, 'rate_codex', a.info);
        break;
      case 'task_start': {
        // background_tasks_changed can arrive first; keep its "in the background" if so.
        const prev = r.tasks.get(a.task.id);
        r.tasks.set(a.task.id, { startedAt: this.#ts(r), ...prev, ...a.task, background: a.task.background || !!prev?.background });
        if (r.tasks.get(a.task.id).background) this.#backgrounded(r, r.tasks.get(a.task.id));
        break;
      }
      case 'task_progress':
        if (r.tasks.has(a.id)) r.lastActivity = this.#ts(r);
        return;
      case 'task_background': {
        const t = r.tasks.get(a.id);
        if (t) t.background = a.background;
        if (t?.background) this.#backgrounded(r, t);
        break;
      }
      case 'bg_tasks': {
        const ids = new Set(a.tasks.map(t => t.id));
        for (const t of a.tasks) {
          r.tasks.set(t.id, { toolUseId: null, startedAt: this.#ts(r), ...r.tasks.get(t.id), ...t, background: true });
          this.#backgrounded(r, r.tasks.get(t.id));
        }
        for (const [id, t] of r.tasks) if (t.background && !ids.has(id)) this.#taskEnd(r, id, 'completed');
        this.#settle(r);
        break;
      }
      case 'task_end':
        this.#taskEnd(r, a.id, a.status);
        this.#settle(r);
        break;
    }
    this.#changed(r);
  }

  #sub(r, item) {
    r.subs.push(item);
    if (r.subs.length > MAX_SUBS) r.subs.splice(0, r.subs.length - MAX_SUBS);
    r.lastActivity = item.ts ?? this.#ts(r);
    this.#emit(r, 'item', r.sessionId, item);
  }

  #taskEnd(r, id, status) {
    const t = r.tasks.get(id);
    if (!t) return;
    r.tasks.delete(id);
    const wf = t.toolUseId && r.workflows.get(t.toolUseId);
    if (wf && wf.status === 'running') {
      const next = { ...wf, status: status === 'completed' || !status ? 'completed' : 'failed' };
      r.workflows.set(t.toolUseId, next);
      this.#emit(r, 'item', r.sessionId, next);
    }
  }

  /** The process is gone, so anything still marked running was cut off with it. */
  #endWorkflows(r) {
    for (const [k, wf] of r.workflows) if (wf.status === 'running') r.workflows.set(k, { ...wf, status: 'stopped' });
  }

  /**
   * The last agent has finished. Claude is normally woken to write a reply, and that reply's end is "your turn" —
   * so wait for it rather than saying "your turn" twice. If no reply comes, say it after a short wait.
   */
  #settle(r) {
    if (r.status !== 'agents_working' || this.#agentJobs(r).length) return;
    clearTimeout(r.settle);
    r.settle = setTimeout(() => {
      if (r.status !== 'agents_working' || this.#agentJobs(r).length) return;
      r.status = this.#statusNow(r);
      this.#changed(r);
    }, this.settleMs);
    r.settle.unref?.();
  }

  /** One turn's progress for the working line: when it started, tokens written (live estimate until Claude's count arrives), what it is doing. */
  #beginTurn(r) {
    r.turn = { startedAt: this.#ts(r), done: 0, real: null, chars: 0, activity: null, sentAt: 0 };
    return r.turn;
  }

  #turnView(r) {
    const t = r.turn;
    return t ? { startedAt: t.startedAt, tokens: t.done + (t.real ?? Math.round(t.chars / 4)), activity: t.activity } : null;
  }

  /** Updates the turn and tells the page — at once when the activity changes, otherwise at most once a second. */
  #progress(r, { chars = 0, activity }) {
    const t = r.turn ?? this.#beginTurn(r);
    t.chars += chars;
    const changed = activity !== undefined && JSON.stringify(activity) !== JSON.stringify(t.activity);
    if (activity !== undefined) t.activity = activity;
    const now = Date.now();
    if (!changed && now - t.sentAt < 1000) return;
    t.sentAt = now;
    this.#emit(r, 'progress', r.sessionId, this.#turnView(r));
  }

  #changed(r) {
    if (r.replaying) return; // one 'run' when the replay ends, not one per replayed line
    this.emit('run', this.publicRun(r));
  }

  #emit(r, ...args) { if (!r.replaying) this.emit(...args); }

  /** Now — or, while replaying a relay's log, when the line being replayed happened. */
  #ts(r) { return r.clock ?? this.now(); }

  /** End a run's process: the relay and claude under it, or the claude child itself. */
  #kill(r) { return r.proc?.killTree ? r.proc.killTree() : this.killFn(r.pid); }
}
