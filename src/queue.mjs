import { nextDue } from './insights.mjs';
import { config } from './config.mjs';
import { SITE } from './site.mjs';
import { engineFor, defaultEngine } from './engines.mjs';
import { validModel, CLAUDE_ALIASES } from './codex-exec.mjs';
// Background task queue + role agents. One job at a time, only while your usage is comfortably low,
// with hard blocks on anything that sends, publishes, deploys or touches live servers.

// Command fragments a queued job may never run, in Bash or PowerShell, anywhere in the command line
// (verified 2026-09-29: "*x*" rules match mid-command, and PowerShell rules are enforced like Bash ones).
// site.json "jobBlockedCommands" adds your own (e.g. a command that writes a live index).
const SITE_BLOCKED = Array.isArray(SITE.jobBlockedCommands) ? SITE.jobBlockedCommands.map(String) : [];
const BLOCKED_COMMANDS = ['ssh ', 'scp ', 'rsync ', 'git push', 'wrangler deploy', 'wrangler d1 execute', 'deploy.sh', ...SITE_BLOCKED];

/** Enforced by Claude Code itself for every queued job (not just asked for in the prompt). */
export const JOB_BLOCKS = [
  'mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__reply', 'mcp__claude_ai_Gmail__forward',
  'mcp__claude_ai_Gmail__trash_message', 'mcp__claude_ai_Gmail__trash_thread', 'mcp__claude_ai_Gmail__delete_draft',
  'mcp__claude_ai_Gmail__mark_message_spam', 'mcp__claude_ai_Gmail__mark_thread_spam',
  'mcp__claude_ai_Google_Drive__share_file', 'mcp__claude_ai_Google_Drive__trash_file',
  'mcp__claude-in-chrome', // no driving the real browser (web Gmail, Shopify admin…) unattended
  ...BLOCKED_COMMANDS.flatMap(c => [`Bash(*${c}*)`, `PowerShell(*${c}*)`]),
  'PushNotification', 'RemoteTrigger',
];

/** Plain-English list for the page. */
export const BLOCKED_SUMMARY = 'sending, replying to, forwarding or deleting email; sharing or deleting Drive files; using Chrome; '
  + `ssh, scp, rsync, git push, wrangler deploy / d1 execute${SITE_BLOCKED.length ? ', ' : ' and '}deploy.sh`
  + (SITE_BLOCKED.length ? ` and ${SITE_BLOCKED.join(', ')}` : '');

export function wrapJobPrompt(prompt, { roleName = null, previous = null, user = config.user, liveSystems = SITE.liveSystems } = {}) {
  return [
    roleName ? `You are running as ${user.name}'s "${roleName}" agent, started automatically by Pit Wall.` : `This is an unattended job from ${user.name}'s Pit Wall queue.`,
    'Rules for this job:',
    `- Work only with local files, drafts and reports. Do not send emails or messages, publish, deploy, push to git, or change anything on a live server or live ${liveSystems ?? 'production'} account.`,
    `- If something needs ${user.name}'s decision, stop and say so clearly in your final message instead of guessing.`,
    `- Finish with a short summary: what you did, where the output is, and anything ${user.name} needs to look at.`,
    previous ? `\nYour previous run ended with:\n${previous.slice(0, 1500)}` : '',
    `\nTask:\n${prompt}`,
  ].filter(Boolean).join('\n');
}

/** Usage gate: only start work when the latest reading is fresh and comfortably under the limits. */
export function usageGate(rate, { fiveHourMax, weekMax, maxAgeMin }, now = Date.now()) {
  if (!rate?.unifiedWindows || !rate.capturedAt) return { ok: false, why: 'Waiting for a usage reading', needsReading: true };
  const age = (now - Date.parse(rate.capturedAt)) / 60_000;
  if (age > maxAgeMin) return { ok: false, why: `Usage reading is ${Math.round(age)} min old — refreshing`, needsReading: true };
  const five = rate.unifiedWindows.five_hour?.utilization ?? 0;
  const week = rate.unifiedWindows.seven_day?.utilization ?? 0;
  if (five >= fiveHourMax) return { ok: false, why: `Paused: 5-hour usage ${Math.round(five * 100)}% (limit for background work ${Math.round(fiveHourMax * 100)}%)` };
  if (week >= weekMax) return { ok: false, why: `Paused: weekly usage ${Math.round(week * 100)}% (limit for background work ${Math.round(weekMax * 100)}%)` };
  return { ok: true, why: 'Ready' };
}

/** Spare capacity: within 45 min of the 5-hour window resetting (unused allowance about to vanish), or under 20% used. */
export function offPeakWindow(rate, now = Date.now()) {
  const five = rate?.unifiedWindows?.five_hour;
  if (!five) return false;
  if ((five.utilization ?? 1) < 0.2) return true;
  return !!five.resetsAt && five.resetsAt * 1000 - now < 45 * 60_000;
}

export class Queue {
  constructor({ store, runner, config, today = () => new Date().toISOString().slice(0, 10), now = () => new Date(), onChange = () => {}, requestReading = () => {} }) {
    Object.assign(this, { store, runner, config, today, now, onChange, requestReading });
    this.lastWhy = 'Ready';
    this.noReading = {}; // engine -> { at, signedIn }: last ask that produced no usage reading
  }

  status() {
    const gate = usageGate(this.#rate(defaultEngine(this.store)), this.config, this.now().getTime());
    return {
      enabled: this.store.get('queueEnabled', true),
      why: this.store.get('queueEnabled', true) ? (this.lastWhy ?? gate.why) : 'Paused by you',
      startedToday: this.store.queueStartedOn(this.today()),
      dailyCap: this.config.dailyJobCap,
      limits: { fiveHour: this.config.fiveHourMax, week: this.config.weekMax },
      blocked: BLOCKED_SUMMARY,
    };
  }

  /** Ask for a missing reading. One that came back empty (e.g. Codex signed out) is not retried for 5 minutes. */
  #ask(engine) {
    const miss = this.noReading[engine];
    if (miss && this.now().getTime() - miss.at < 5 * 60_000) {
      if (miss.signedIn === false) this.lastWhy = `${engine === 'codex' ? 'Codex' : 'Claude'} is not signed in`;
      return;
    }
    delete this.noReading[engine];
    const at = this.now().getTime();
    const r = this.requestReading(engine);
    if (r && typeof r.then === 'function') {
      r.then(a => { if (a && !a.rate) { this.noReading[engine] = { at, signedIn: a.signedIn }; this.onChange(); } }, () => { this.noReading[engine] = { at, signedIn: null }; });
    }
  }

  #rate(engine) { return this.store.get(engine === 'codex' ? 'rate_codex' : 'rate'); }

  /** The engine a job runs on: its own, else its role's, else the Default engine (resolved at run time). */
  #engineOf(job) {
    const role = job.role_id ? this.store.role(job.role_id) : null;
    return engineFor(this.store, job.engine ?? role?.engine);
  }

  /** A model only counts if the resolved engine knows it; otherwise the engine's own default (null). */
  #modelFor(job, engine) {
    const m = job.model || (engine === 'claude' ? this.config.defaultModel : null) || null;
    if (!m) return null;
    if (engine === 'codex' && CLAUDE_ALIASES.includes(m)) return null;
    if (validModel(engine, m, this.store.get('codexModels', []))) return m;
    // A GPT model on a job that now runs on Claude (Codex switched off): Claude's background default, not Claude Code's own.
    return engine === 'claude' ? this.config.defaultModel ?? null : null;
  }

  /** Sync running jobs with their sessions, schedule due role agents, then maybe start the next job. */
  tick() {
    let changed = false;
    for (const job of this.store.activeQueueItems()) changed = this.#sync(job) || changed;
    changed = this.#scheduleRoles() || changed;
    if (!this.store.get('queueEnabled', true)) { this.lastWhy = 'Paused by you'; if (changed) this.onChange(); return; }
    if (this.store.activeQueueItems().length) { this.lastWhy = 'Working on a job'; if (changed) this.onChange(); return; }
    const queued = this.store.queuedItems();
    if (!queued.length) { this.lastWhy = 'Nothing queued'; if (changed) this.onChange(); return; }
    // "Off-peak" jobs wait for spare capacity: just before the 5-hour window resets, or when it's barely used.
    // A job with a start time waits for it; off-peak jobs wait for spare capacity (on the engine it will run on).
    const offPeakFor = j => offPeakWindow(this.#rate(this.#engineOf(j)), this.now().getTime());
    const timeOk = j => !j.start_at || Date.parse(j.start_at) <= this.now().getTime();
    // Codex being installed (runner.codexBlocked): Codex jobs wait in the queue — not failed — and Claude jobs go ahead.
    const codexWaits = !!this.runner.codexBlocked?.();
    const waitsForInstall = j => codexWaits && this.#engineOf(j) === 'codex';
    const next = queued.find(j => timeOk(j) && !waitsForInstall(j) && (!j.off_peak || offPeakFor(j)));
    if (!next && queued.some(j => timeOk(j) && waitsForInstall(j))) {
      this.lastWhy = 'Waiting for the Codex install';
      if (changed) this.onChange();
      return;
    }
    if (!next) {
      const later = queued.filter(j => !timeOk(j)).sort((x, y) => x.start_at.localeCompare(y.start_at))[0];
      this.lastWhy = later && queued.every(j => !timeOk(j))
        ? `Waiting for a start time (next: ${new Date(later.start_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })})`
        : 'Waiting for a quiet time (off-peak jobs only)';
      if (changed) this.onChange();
      return;
    }
    if (this.store.queueStartedOn(this.today()) >= this.config.dailyJobCap) {
      this.lastWhy = `Daily limit of ${this.config.dailyJobCap} jobs reached — resumes tomorrow`;
      if (changed) this.onChange();
      return;
    }
    const engine = this.#engineOf(next);
    const gate = usageGate(this.#rate(engine), this.config, this.now().getTime());
    this.lastWhy = gate.why;
    if (!gate.ok) { if (gate.needsReading) this.#ask(engine); if (changed) this.onChange(); return; }
    this.#start(next);
    this.onChange();
  }

  #start(job) {
    const role = job.role_id ? this.store.role(job.role_id) : null;
    const previous = role ? this.store.queue({ limit: 200 }).find(q => q.role_id === role.id && q.status === 'done')?.result : null;
    const engine = this.#engineOf(job);
    // Background Claude work defaults to Sonnet (lighter on your limits) unless a model was picked for the job.
    const model = this.#modelFor(job, engine);
    try {
      const sessionId = this.runner.start({
        cwd: job.cwd, name: role ? `${role.name} (agent)` : `Queue: ${job.title}`, model, engine,
        permissionMode: 'auto', disallowedTools: JOB_BLOCKS,
        message: wrapJobPrompt(job.prompt, { roleName: role?.name, previous }),
      });
      this.store.upsertSession(sessionId, { cwd: job.cwd, display_name: role ? `${role.name}: ${job.title}` : job.title,
        project_id: job.project_id ?? null, project_locked: job.project_id ? 1 : 0, model, engine });
      this.store.updateQueueItem(job.id, { status: 'running', session_id: sessionId, started_at: this.now().toISOString() });
    } catch (e) {
      this.store.updateQueueItem(job.id, { status: 'failed', result: `Could not start: ${e.message}`, finished_at: this.now().toISOString() });
    }
  }

  #sync(job) {
    const run = this.runner.get(job.session_id);
    if (!run) {
      // Pit Wall restarted mid-job: the session keeps its history; mark it so you can pick it up.
      this.store.updateQueueItem(job.id, { status: 'failed', result: 'Interrupted — Pit Wall restarted during this job. Open the session and press Continue.', finished_at: this.now().toISOString() });
      return true;
    }
    const pub = this.runner.publicRun(run);
    if (pub.pending.length && job.status !== 'needs_you') { this.store.updateQueueItem(job.id, { status: 'needs_you' }); return true; }
    if (!pub.pending.length && job.status === 'needs_you' && pub.status === 'busy') { this.store.updateQueueItem(job.id, { status: 'running' }); return true; }
    if (pub.status === 'your_turn' || pub.status === 'parked') {
      const last = [...run.items].reverse().find(i => i.kind === 'assistant');
      this.store.updateQueueItem(job.id, { status: 'done', result: last?.text?.slice(0, 4000) ?? '(no summary)', finished_at: this.now().toISOString() });
      return true;
    }
    if (pub.status === 'error' || pub.status === 'stopped') {
      this.store.updateQueueItem(job.id, { status: pub.status === 'stopped' ? 'cancelled' : 'failed', result: pub.error ?? 'Stopped', finished_at: this.now().toISOString() });
      return true;
    }
    return false;
  }

  #scheduleRoles() {
    let changed = false;
    const now = this.now();
    for (const role of this.store.roles()) {
      if (!role.enabled) continue;
      const when = nextDue(role, now);
      const due = when && when <= now;
      const waiting = this.store.queue({ limit: 500 }).some(q => q.role_id === role.id && ['queued', 'running', 'needs_you'].includes(q.status));
      if (!due || waiting) continue;
      this.enqueueRole(role);
      changed = true;
    }
    return changed;
  }

  enqueueRole(role) {
    // A skill runs as its slash command, with the goal as its arguments.
    const task = role.skill ? `/${role.skill} ${role.goal}` : role.goal;
    this.store.addQueueItem({ title: `Scheduled run`, prompt: `${task}${role.instructions ? `\n\nStanding instructions:\n${role.instructions}` : ''}`,
      cwd: role.cwd, projectId: role.project_id, roleId: role.id, model: role.model ?? null, engine: role.engine ?? null });
    this.store.updateRole(role.id, { last_run_at: this.now().toISOString() });
  }

  cancel(id) {
    const job = this.store.queueItem(id);
    if (!job) throw Object.assign(new Error('No such job.'), { status: 404 });
    if (job.status === 'queued') this.store.updateQueueItem(id, { status: 'cancelled', finished_at: this.now().toISOString() });
    else if (['running', 'needs_you'].includes(job.status)) this.runner.stop(job.session_id);
    this.onChange();
  }
}
