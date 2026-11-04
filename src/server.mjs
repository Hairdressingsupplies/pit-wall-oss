// Pit Wall — local mission control for Claude Code sessions. http://127.0.0.1:4040
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { config, paths, isExcludedProjectDir, chromeEnabled, refreshCodexExe } from './config.mjs';
import { openDb } from './db.mjs';
import { Runner } from './runner.mjs';
import { runShell, shellContext, shellItem } from './shell.mjs';
import { relaySpawn, findRelays } from './relay-client.mjs';
import { Scanner } from './scanner.mjs';
import { Organiser, probeUsage, callModel } from './organiser.mjs';
import { roundupDue, weekKey, weekDays, buildRoundupPrompt, ROUNDUP_SCHEMA, sendViaGmail } from './roundup.mjs';
import { checkUpdates, git } from './updates.mjs';
import { childEnv } from './protocol.mjs';
import { Titler, realName } from './titler.mjs';
import { agentDetail, readHistory, summariseTranscript } from './transcripts.mjs';
import { PERMISSION_MODES, EFFORTS, validateImages } from './protocol.mjs';
import { Notifier, showToast, terminalNotifyState } from './notify.mjs';
import { Search } from './search.mjs';
import { Jobs } from './jobs.mjs';
import { Queue } from './queue.mjs';
import { checkState } from './schedule.mjs';
import { readHookStatus, processStartFiletime, canTakeOver } from './takeover.mjs';
import { usageTop, tokensByEngine, claudeCacheShares, weekByEngine, weekShares, dangerBadges, processed, repoOf, suggestModel, nextDue, describeSchedule, burnRate, staleMemories, waitingInMemory,
  repoHealth, clashes, listSkills, analyseTranscript, extractHandoff } from './insights.mjs';
import os from 'node:os';
import { classify, loadRemote, AccessKeys } from './remote.mjs';
import { resolveDownload, downloadHeaders, transcriptFolders, transcriptPaths } from './files.mjs';
import { loadCommandCache, saveCommandCache, buildCommands, handoffText } from './commands.mjs';
import { ENGINES, isEngine, defaultEngine, engineFor, shouldPollCodex, codexPollBackoff, codexEnabled, keepStoredModel } from './engines.mjs';
import { codexAccount, validModel, validEffort } from './codex-exec.mjs';
import { voiceStatus, speakRequest, speakWav, installVoice, warmVoice } from './voice.mjs';
import { installCommand, loginCommand, sandboxSetupCommand, runTree, codexVersion, latestCodexVersion, isNewer, installBlocker, installOutcome, codexRouteGuard, sandboxCheck } from './codex-setup.mjs';

const PUBLIC = path.join(config.root, 'public');
const TOKEN = randomBytes(24).toString('hex');
const ALLOWED_HOSTS = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map(h => `http://${h}`));
const accessKeys = new AccessKeys();
const MODELS = ['', 'opus', 'sonnet', 'haiku', 'fable'];
const shellPending = new Map(); // sessionId -> "! command" results Claude hasn't seen yet (sent with the next message)
const shellRunning = new Map(); // shell item id -> { sessionId, item, ctrl } while a "! command" is still going
let shellSeq = 0;

const store = openDb(paths.db);
// Each chat runs under a detached relay so restarting the server doesn't cut it off (PITWALL_NO_RELAY=1: direct children).
const USE_RELAYS = process.env.PITWALL_NO_RELAY !== '1';
const runner = new Runner({ claudeExe: config.claudeExe, bridgePath: path.join(config.root, 'src', 'codex-bridge.mjs'), maxRunning: config.maxRunning, idleParkMinutes: config.idleParkMinutes, defaultPermissionMode: config.defaultPermissionMode,
  defaultEffort: config.defaultEffort, chromeFn: chromeEnabled, dangerFn: dangerBadges,
  // While Codex is being installed its exe is being replaced: no Codex chat or job may start (the runner refuses, the queue waits).
  codexBlocked: () => (codexSetup.install.running ? 'Codex is being updated — try again in a minute.' : null), ...(USE_RELAYS ? { spawnFn: relaySpawn(paths.relaysDir) } : {}) });
const scanner = new Scanner({ sessionsDir: paths.sessionsDir, projectsDir: paths.projectsDir, projectsDirs: [paths.projectsDir, paths.codexProjectsDir], recentDays: config.recentDays, isExcludedProjectDir });
const saveRate = info => {
  const at = new Date().toISOString();
  store.set('rate', { ...info, capturedAt: at });
  const w = info?.unifiedWindows;
  if (w) store.addRateReading(at, w.five_hour?.utilization ?? null, w.seven_day?.utilization ?? null, w.five_hour?.resetsAt ?? null);
  schedulePush();
};
const saveCodexRate = info => {
  const at = new Date().toISOString();
  store.set('rate_codex', { ...info, capturedAt: at });
  const w = info?.unifiedWindows;
  if (w) store.addRateReading(at, w.five_hour?.utilization ?? null, w.seven_day?.utilization ?? null, w.five_hour?.resetsAt ?? null, 'codex');
  schedulePush();
};
runner.on('rate_codex', saveCodexRate);
const MEMORY_DIR = path.join(config.claudeHome, 'projects', config.workspaceRoot.replace(/[^A-Za-z0-9]/g, '-'), 'memory');
const SKILL_DIRS = [
  { dir: path.join(config.claudeHome, 'skills'), scope: 'yours' },
  { dir: path.join(config.workspaceRoot, '.claude', 'skills'), scope: 'workspace' },
];
const organiser = new Organiser({ store, config: config.organiser, claudeExe: config.claudeExe, cwd: paths.organiserCwd, onRate: saveRate });
// Same isolated folder as the organiser, so its title calls never show up as sessions on the board.
const titler = new Titler({ store, claudeExe: config.claudeExe, cwd: paths.organiserCwd, onRate: saveRate, onTitled: () => schedulePush() });
const search = new Search({ projectsDir: paths.projectsDir, projectsDirs: [paths.projectsDir, paths.codexProjectsDir], isExcludedProjectDir });
const jobs = new Jobs();
const queue = new Queue({ store, runner, config: config.queue, onChange: () => schedulePush(), requestReading: engine => {
  if (engine === 'codex') return codexEnabled(store) ? codexStatus().then(a => ({ signedIn: a.signedIn, rate: a.rate })) : Promise.resolve(null);
  return maybeProbeUsage({ forQueue: true });
} });

// ── usage gauge freshness ─────────────────────────────────────────────────
// Readings arrive free whenever a Pit Wall session or the organiser talks to Claude. Only when the page
// is open (or the queue needs one) and the latest reading is stale does Pit Wall spend a tiny Haiku call.
let probing = false;
let codexSignedOutAt = 0; // poll back-off (signed out, or no usage came back); the page's own /api/codex/status re-checks keep the 3 s TTL
async function maybeProbeUsage({ forQueue = false } = {}) {
  const pageOpen = clients.size > 0 && notifier.viewing.until > Date.now();
  // Codex gauge: only when Codex is the default and the page is open. The cached account read carries the usage (no model call, no probe budget).
  if (pageOpen && codexEnabled(store) && defaultEngine(store) === 'codex' && shouldPollCodex({ rateCodex: store.get('rate_codex'), lastSignedOutAt: codexSignedOutAt, staleMin: config.usageProbe.staleMin })) {
    const a = await codexStatus().catch(() => null);
    codexSignedOutAt = codexPollBackoff(a);
  }
  if (probing) return;
  if (!pageOpen && !forQueue) return;
  const rate = store.get('rate');
  if (rate?.capturedAt && Date.now() - Date.parse(rate.capturedAt) < config.usageProbe.staleMin * 60_000) return;
  const day = new Date().toISOString().slice(0, 10);
  const used = store.get('probes', {});
  if ((used[day] ?? 0) >= config.usageProbe.dailyCap) return;
  probing = true;
  store.set('probes', { [day]: (used[day] ?? 0) + 1 });
  try { await probeUsage({ claudeExe: config.claudeExe, cwd: paths.organiserCwd, onRate: saveRate }); } finally { probing = false; }
}

// ── daily backup of Pit Wall's own data ───────────────────────────────────
function backupIfDue() {
  const day = new Date().toISOString().slice(0, 10);
  if (store.get('lastBackup') === day) return;
  try {
    fs.mkdirSync(paths.backupsDir, { recursive: true });
    const file = path.join(paths.backupsDir, `pitwall-${day}.db`);
    fs.rmSync(file, { force: true });
    store.backupTo(file);
    const old = fs.readdirSync(paths.backupsDir).filter(f => /^pitwall-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(config.backups.keep);
    for (const f of old) fs.rmSync(path.join(paths.backupsDir, f), { force: true });
    store.set('lastBackup', day);
  } catch (e) { console.error('[backup]', e.message); }
}
backupIfDue();
setInterval(backupIfDue, 3_600_000).unref();

// ── board state ───────────────────────────────────────────────────────────
let lastRows = [];
let lastEngines = new Map(); // session id -> engine for the usage figures (all 'claude' while Codex is off)
let hookStatus = new Map();

function runsMap() {
  return new Map([...runner.runs.values()].map(r => [r.sessionId, runner.publicRun(r)]));
}

function workspaces() {
  const out = [config.workspaceRoot];
  try {
    for (const d of fs.readdirSync(config.workspaceRoot, { withFileTypes: true })) {
      if (d.isDirectory() && fs.existsSync(path.join(config.workspaceRoot, d.name, '.git'))) out.push(path.join(config.workspaceRoot, d.name));
    }
  } catch { /* workspace root missing */ }
  for (const f of config.extraFolders) {
    const dir = path.resolve(f);
    if (fs.existsSync(dir) && !out.some(o => o.toLowerCase() === dir.toLowerCase())) out.push(dir);
  }
  return out;
}

function buildState() {
  const meta = new Map(store.allSessionMeta().map(m => [m.session_id, m]));
  hookStatus = readHookStatus(paths.hookStatusDir);
  const rows = scanner.board({ runs: runsMap(), meta, excludePids: runner.childPids(), hookStatus });
  lastRows = rows;
  const codexOn = codexEnabled(store);
  lastEngines = new Map(rows.map(r => [r.id, codexOn && (meta.get(r.id)?.engine ?? r.run?.engine) === 'codex' ? 'codex' : 'claude']));
  notifyTerminals(rows);
  // Share of everything Claude processed this week (tokens in + out + context re-read), per session and project.
  // GPT tokens must not distort Claude's bars: a session's share is of its own engine's total, and project shares are the default engine's picture (as the header rings are).
  const weekTotal = rows.reduce((n, r) => n + processed(r.week), 0) || 1;
  const engRows = rows.map(r => ({ id: r.id, projectId: r.projectId, engine: lastEngines.get(r.id), week: r.week }));
  const byEngine = weekByEngine(engRows);
  const { session: sessShare, project: projShare } = weekShares(engRows, defaultEngine(store));
  const projects = store.projects({ includeArchived: true }).map(p => {
    const share = projShare.get(p.id) ?? 0;
    const checklist = store.checklist(p.id);
    const history = store.checklistHistory(checklist.map(c => c.id));
    const withHistory = checklist.map(c => ({ ...c, history: history.filter(e => e.item_id === c.id).slice(0, 4) }));
    return { ...p, checklist: withHistory, weekShare: share, overBudget: p.budget_pct ? share * 100 > p.budget_pct : false };
  });
  const clash = clashes(rows.map(r => ({ sessionId: r.id, edits: r.week?.edits ?? [], live: r.source !== 'closed' })), config.workspaceRoot);
  const clashBy = new Map();
  for (const c of clash) for (const id of c.sessions) clashBy.set(id, [...(clashBy.get(id) ?? []), c.repo]);
  const sessions = rows.map(({ run, transcript, week, ...r }) => ({ ...r, model: meta.get(r.id)?.model ?? run?.model ?? null,
    permissionMode: meta.get(r.id)?.permission_mode ?? run?.permissionMode ?? null, effort: meta.get(r.id)?.effort ?? null,
    engine: meta.get(r.id)?.engine ?? run?.engine ?? 'claude',
    running: !!run?.running,
    weekShare: sessShare.get(r.id),
    repos: [...new Set((week?.edits ?? []).map(e => repoOf(e.path, config.workspaceRoot)).filter(Boolean))],
    clash: clashBy.get(r.id) ?? null,
    screenshots: week?.screenshots ?? 0 }));
  const now = new Date();
  // Codex off (the default): the page gets what it got before Codex existed — no engines, Codex gauge or Codex update.
  return {
    projects,
    sessions,
    usage: {
      rate: store.get('rate'), rateCodex: codexOn ? store.get('rate_codex') ?? null : null, tokensToday: rows.reduce((n, r) => n + (r.tokensToday || 0), 0),
      weekProcessed: weekTotal, weekByEngine: byEngine,
      burn: burnRate(store.rateReadingsSince(new Date(Date.now() - 2 * 3_600_000).toISOString())),
      burnCodex: codexOn ? burnRate(store.rateReadingsSince(new Date(Date.now() - 2 * 3_600_000).toISOString(), 'codex')) : null,
      engine: defaultEngine(store),
    },
    organiser: organiser.status(),
    // Queue and Agents can be switched off per PC (data/local.json "automation": false) — then nothing about them is sent.
    queue: config.automation ? { ...queue.status(), items: store.queue({ limit: 60 }) } : null,
    roles: !config.automation ? [] : store.roles().map(r => ({ ...r, scheduleText: describeSchedule(r), nextRun: r.enabled ? nextDue(r, now)?.toISOString() ?? null : null })),
    followups: store.followups(),
    templates: store.templates(),
    clashes: clash,
    update: withCodexUpdate(updateInfo, codexOn),
    roundup: { enabled: roundupOn(), to: config.roundup.to, toName: roundupToName(), autoSend: config.roundup.autoSend, sending: roundupSending, running: roundupRunning, latest: store.get('roundup', null), error: store.get('roundupError', null) },
    settings: { notify: store.get('notify', true), groupByProject: store.get('groupByProject', true), hooksInstalled: hooksInstalled(), inboxHook: inboxHookInstalled(), lastBriefDay: store.get('lastBriefDay'), today: localDay(),
      defaultEngine: defaultEngine(store), codexInstalled: !!config.codexExe, codexEnabled: codexOn },
    options: { models: MODELS, permissionModes: PERMISSION_MODES, efforts: EFFORTS, defaultEffort: config.defaultEffort,
      workspaces: workspaces(), maxRunning: config.maxRunning, context: config.context, queueDefaultModel: config.queue.defaultModel, dailyJobCap: config.queue.dailyJobCap,
      automation: config.automation, userName: config.user.name, engines: codexOn ? ENGINES : ['claude'], codexModels: store.get('codexModels', []) },
  };
}

// ── server-sent events ────────────────────────────────────────────────────
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

let lastStateJson = '';
let stateTimer = null;
function pushState(force = false) {
  let state;
  try { state = buildState(); } catch (e) { console.error('[state]', e); return; }
  const json = JSON.stringify(state);
  if (force || json !== lastStateJson) { lastStateJson = json; broadcast('state', state); }
}
function schedulePush() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => { stateTimer = null; pushState(); }, 400);
}

// ── notifications + restart recovery ──────────────────────────────────────
const notifier = new Notifier({ baseUrl: `http://127.0.0.1:${config.port}`, enabled: () => store.get('notify', true) });
const MID_TURN = new Set(['starting', 'busy', 'needs_you', 'agents_working']);
const midTurn = new Map(); // sessionId -> bool, so the DB is only written when it changes

const adoptQuiet = new Set(); // chats picked up from relays at start: their current state is not news

function trackRun(run) {
  // Remember which sessions are mid-turn: if Pit Wall stops now, those were cut off. A chat whose relay vanished
  // (killed, PC restarted) keeps the flag it had — it was cut off just the same.
  const mid = run.running && MID_TURN.has(run.status);
  if (!run.lost && midTurn.get(run.sessionId) !== mid) {
    midTurn.set(run.sessionId, mid);
    store.upsertSession(run.sessionId, { interrupted: mid, cwd: store.sessionMeta(run.sessionId)?.cwd ?? run.cwd, engine: store.sessionMeta(run.sessionId)?.engine ?? run.engine });
  }
  if (run.running && !store.sessionMeta(run.sessionId)?.run_here) store.upsertSession(run.sessionId, { run_here: true, cwd: store.sessionMeta(run.sessionId)?.cwd ?? run.cwd, engine: store.sessionMeta(run.sessionId)?.engine ?? run.engine });
  const name = chatName(run.sessionId) ?? realName(run.name);
  const reason = run.pending[0] ? (run.pending[0].kind === 'question' ? 'Asked you a question' : run.pending[0].toolName === 'ExitPlanMode' ? 'Has a plan for you to approve' : `Wants to use ${run.pending[0].toolName}`) : run.error;
  const state = run.status === 'needs_you' || run.status === 'error' || run.status === 'your_turn' ? run.status : 'other';
  if (adoptQuiet.delete(run.sessionId)) notifier.last.set(run.sessionId, state); // already told before the restart
  else notifier.update(run.sessionId, state, { name, reason });
}

/**
 * Pick up chats still running under relays from the previous server: replay each one's log, then carry on.
 * Waits (up to 8 s) so the restart notice below doesn't count them as cut off.
 */
async function adoptRelays() {
  const found = findRelays(paths.relaysDir);
  await Promise.all(found.map(({ id, meta, proc }) => new Promise(resolve => {
    adoptQuiet.add(id);
    runner.adopt({ ...meta, engine: meta.engine ?? 'claude', proc, sessionId: id, cwd: meta.cwd ?? store.sessionMeta(id)?.cwd, name: meta.name ?? chatName(id) });
    proc.once('replayed', resolve);
    proc.once('exit', resolve);
    setTimeout(resolve, 8000).unref();
    proc.connect({ timeoutMs: 2000 });
  })));
  const live = found.filter(f => runner.get(f.id)?.proc).length;
  if (found.length) console.log(`${new Date().toISOString()} Picked up ${live} running chat${live === 1 ? '' : 's'} from relays${found.length > live ? ` (${found.length - live} had ended)` : ''}.`);
}

function notifyTerminals(rows) {
  for (const r of rows) {
    if (r.source !== 'terminal') continue;
    notifier.update(r.id, terminalNotifyState(r), { name: r.name, reason: r.needsYou?.reason });
  }
}

function hooksInstalled() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(config.claudeHome, 'settings.json'), 'utf8'));
    return JSON.stringify(s.hooks ?? {}).includes('pit-wall/src/hook-status.mjs');
  } catch { return false; }
}

// ── Codex account ─────────────────────────────────────────────────────────
// Sign-in, plan, usage and models from a throwaway `codex app-server`, one check at a time. Signed in: kept 60 s.
// Not signed in: only a few seconds, so the page's re-checks while you sign in see the change straight away.
let codexStatusCache = null; // { at, ttl, promise }
let codexStatusReads = 0;     // app-servers started for a status read and not finished yet (an install waits for them)
const NOT_READ = () => ({ installed: !!config.codexExe, signedIn: false, email: null, plan: null, rate: null, models: [], sandbox: null });
function codexStatus() {
  // While Codex is being installed its exe is being replaced: start nothing from it (and don't cache this answer).
  if (codexSetup.install.running) return Promise.resolve({ ...NOT_READ(), installing: true });
  if (codexStatusCache && Date.now() - codexStatusCache.at < codexStatusCache.ttl) return codexStatusCache.promise;
  const entry = { at: Date.now(), ttl: 60_000 };
  codexStatusReads++;
  entry.promise = codexAccount({ exe: config.codexExe }).finally(() => { codexStatusReads--; }).then(a => {
    if (!a.signedIn) entry.ttl = 3_000;
    if (a.models.length) store.set('codexModels', a.models);
    if (a.rate) saveCodexRate(a.rate);
    return a;
  }, () => { if (codexStatusCache === entry) codexStatusCache = null; return NOT_READ(); });
  codexStatusCache = entry;
  return entry.promise;
}

// ── Codex setup (More › Codex (GPT)…) ─────────────────────────────────────
// Install/update, versions and the sandbox check. Nothing here runs in the background unless Codex is on (or the panel asks).
const codexSetup = { version: null, versionExe: null, versionAt: 0, versionPromise: null, latest: null, latestAt: 0, latestPromise: null, install: { running: false, error: null, finishedAt: null }, checking: null };
const LATEST_TTL = 6 * 3_600_000;
const VERSION_TTL = 10 * 60_000;
/** `codex --version`, kept 10 minutes per exe; callers at the same moment share one run. Never run during an install. */
function installedCodexVersion() {
  const exe = config.codexExe;
  if (!exe) return Promise.resolve(null);
  if (codexSetup.install.running) return Promise.resolve(codexSetup.version);
  if (codexSetup.versionExe === exe && Date.now() - codexSetup.versionAt < VERSION_TTL) return Promise.resolve(codexSetup.version);
  codexSetup.versionPromise ??= codexVersion(exe).then(v => { Object.assign(codexSetup, { version: v, versionExe: exe, versionAt: Date.now() }); return v; })
    .finally(() => { codexSetup.versionPromise = null; });
  return codexSetup.versionPromise;
}
/** Codex chats running right now (their exe is in use). */
const liveCodexChats = () => [...runner.runs.values()].filter(r => r.engine === 'codex' && r.proc).length;
/** The newest Codex on npm, cached 6 h. The page never waits for it: a stale value is refreshed in the background. */
function latestCodex({ wait = false } = {}) {
  if (Date.now() - codexSetup.latestAt > LATEST_TTL && !codexSetup.latestPromise) {
    codexSetup.latestPromise = latestCodexVersion().then(v => { if (v) codexSetup.latest = v; codexSetup.latestAt = Date.now(); })
      .catch(() => { codexSetup.latestAt = Date.now(); }).finally(() => { codexSetup.latestPromise = null; schedulePush(); });
  }
  return wait && codexSetup.latestPromise ? codexSetup.latestPromise.then(() => codexSetup.latest) : codexSetup.latest;
}
/** Pit Wall's update info plus { codexInstalled, codexLatest } when Codex is on and installed. Pit Wall's own fields are unchanged. */
function withCodexUpdate(u, on) {
  if (!on || !config.codexExe || !codexSetup.version) return u;
  return { ...(u ?? {}), codexInstalled: codexSetup.version, codexLatest: codexSetup.latest };
}
async function codexSetupState() {
  const version = await installedCodexVersion();
  const latest = latestCodex();
  return { enabled: codexEnabled(store), installed: !!config.codexExe, version, latest, latestChecking: !!codexSetup.latestPromise,
    updateAvailable: !!version && isNewer(latest, version), install: codexSetup.install, checking: !!codexSetup.checking,
    check: store.get('codexSandboxCheck', null) };
}
function runCodexInstall() {
  codexSetup.install = { running: true, error: null, finishedAt: null, startedAt: new Date().toISOString() };
  codexStatusCache = null;
  // runTree settles only once npm and everything it started have exited (on a timeout it kills the whole tree first),
  // so `running` stays true until then and no second install can start.
  // A tree that outlived the kill (stillRunning) keeps `running` true; its real exit clears it then.
  const onExit = () => {
    if (!codexSetup.install.running || !codexSetup.install.stillRunning) return;
    refreshCodexExe();
    Object.assign(codexSetup, { version: null, versionExe: null, versionAt: 0 });
    codexSetup.install = { ...codexSetup.install, running: false, stillRunning: false, finishedAt: new Date().toISOString() };
    pushState(true);
  };
  runTree(installCommand(), { timeoutMs: 5 * 60_000, onExit }).then(r => {
    refreshCodexExe();
    Object.assign(codexSetup, { version: null, versionExe: null, versionAt: 0 });
    codexStatusCache = null;
    codexSetup.install = { running: !!r.stillRunning, stillRunning: !!r.stillRunning, error: installOutcome(r, !!config.codexExe), finishedAt: r.stillRunning ? null : new Date().toISOString() };
    return installedCodexVersion();
  }).catch(e => { codexSetup.install = { running: false, error: e.message, finishedAt: new Date().toISOString() }; })
    .finally(() => pushState(true));
}

/** What the runner needs to (re)start a chat Pit Wall may not be running yet. */
function runOpts(id) {
  const sm = store.sessionMeta(id);
  return { cwd: sessionCwd(id), name: chatName(id), engine: sm?.engine ?? 'claude', model: sm?.model ?? undefined, permissionMode: sm?.permission_mode ?? undefined,
    effort: sm?.effort ?? undefined, waitReady: !!sm?.forked_from };
}
const CHAT_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'teal', 'cyan', 'brown', 'grey', 'black'];

const insideWorkspace = dir => !!dir && path.resolve(dir).toLowerCase().startsWith(path.resolve(config.workspaceRoot).toLowerCase());

/** Workspace skills (Documents\GitHub\.claude\skills) only exist for sessions working inside the workspace. */
function workspaceSkillOutside(skill, cwd) {
  if (!skill || insideWorkspace(cwd)) return null;
  const s = listSkills(SKILL_DIRS).find(x => x.name === skill);
  return s?.scope === 'workspace' ? `/${skill} is one of your workspace skills, so it only works in a folder inside ${config.workspaceRoot}.` : null;
}

/** Where a session runs — from the board, Pit Wall's notes, or (for older sessions) its transcript. */
function sessionCwd(id) {
  // A folder that has gone (a worktree removed after merging) can't start Claude, so the next one known is used —
  // the saved folder (session_meta.cwd) included, which the transcript's own folder would otherwise always hide.
  const isDir = d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
  const known = [runner.get(id)?.cwd, rowFor(id)?.cwd, store.sessionMeta(id)?.cwd].filter(Boolean);
  const found = known.find(isDir);
  if (found) return found;
  const file = scanner.transcriptIndex(new Set([id])).get(id)?.file;
  return (file ? summariseTranscript(file)?.cwd : null) ?? known[0] ?? null;
}

/** A session's transcript as text: its replies give paths relative to any folder it worked in, or just a file's name. */
function sessionTranscript(id) {
  const file = scanner.transcriptIndex(new Set([id])).get(id)?.file;
  try { return file ? fs.readFileSync(file, 'utf8') : ''; } catch { return ''; }
}

// ── fresh start ───────────────────────────────────────────────────────────
// A long conversation is re-read on every turn. Fresh start asks the session for a handoff, then opens a new
// session seeded with just that summary, so the next turns cost a fraction as much.
const HANDOFF_PROMPT = `We're going to continue this work in a fresh session so each turn stays fast and cheap.
Write a complete handoff for your successor and put it between <handoff> and </handoff>:
- the goal and why it matters
- what's done (files, branches, commits, anything deployed or not)
- what's in progress and the exact next step
- decisions, constraints and preferences ${config.user.name} gave in this conversation
- open questions and anything to watch out for
Be specific (paths, names, numbers). Don't do any other work.`;

const freshStarts = new Map(); // old sessionId -> {startedAt}

function finishFreshStart(run) {
  const job = freshStarts.get(run.sessionId);
  if (!job) return;
  if (run.status === 'error' || run.status === 'stopped') { freshStarts.delete(run.sessionId); broadcast('fresh', { from: run.sessionId, error: run.error ?? 'Stopped' }); return; }
  if (run.status !== 'your_turn') return;
  freshStarts.delete(run.sessionId);
  const r = runner.get(run.sessionId);
  const reply = [...(r?.items ?? [])].reverse().find(i => i.kind === 'assistant' && i.ts >= job.startedAt);
  const handoff = extractHandoff(reply?.text);
  if (handoff.length < 40) { broadcast('fresh', { from: run.sessionId, error: 'The handoff came back empty — try again.' }); return; }
  const sm = store.sessionMeta(run.sessionId) ?? {};
  const name = `${(chatName(run.sessionId) ?? realName(run.name) ?? 'Session').replace(/ \(fresh( \d+)?\)$/, '')} (fresh)`;
  const seed = `This is a fresh session continuing earlier work (previous session "${chatName(run.sessionId) ?? run.sessionId}").
Here is the handoff it wrote:

<handoff>
${handoff}
</handoff>

Read any files it points to that you need, then reply with a two-line summary of where things stand and wait for ${config.user.name}'s next instruction.`;
  const engine = sm.engine ?? run.engine ?? 'claude';
  let newId;
  // Runs inside a runner event: a refused start (e.g. Codex being installed) must come back as a message, not an uncaught throw.
  try { newId = runner.start({ cwd: run.cwd, name, engine, model: sm.model ?? null, permissionMode: sm.permission_mode ?? null, effort: sm.effort ?? null, message: seed }); }
  catch (e) { broadcast('fresh', { from: run.sessionId, error: e.message }); return; }
  store.upsertSession(newId, { cwd: run.cwd, display_name: name, project_id: sm.project_id ?? null, project_locked: sm.project_locked ?? 0,
    engine, model: sm.model ?? null, permission_mode: sm.permission_mode ?? null, effort: sm.effort ?? null });
  store.upsertSession(run.sessionId, { superseded_by: newId });
  runner.stop(run.sessionId);
  broadcast('fresh', { from: run.sessionId, to: newId });
  schedulePush();
}

runner.on('run', run => { trackRun(run); finishFreshStart(run); broadcast('run', run); schedulePush(); });
runner.on('item', (sessionId, item) => broadcast('item', { sessionId, item }));
runner.on('delta', (sessionId, text) => broadcast('delta', { sessionId, text }));
runner.on('progress', (sessionId, turn) => broadcast('progress', { sessionId, turn }));
// The live chat changed under the page (a rewind, a message taken back): it reloads that chat.
runner.on('reload', sessionId => broadcast('reload', { sessionId }));
const COMMANDS_FILE = path.join(config.dataDir, 'slash-commands.json');
const commandCache = loadCommandCache(COMMANDS_FILE);
runner.on('commands', (cwd, names) => saveCommandCache(COMMANDS_FILE, commandCache, cwd, names));
runner.on('rate', info => { store.set('rate', { ...info, capturedAt: new Date().toISOString() }); schedulePush(); });

setInterval(() => {
  pushState();
  // "One list" on the board (More menu) also stops Claude filing chats into projects; Organise projects now still works.
  if (store.get('groupByProject', true)) organiser.maybeRun(lastRows).then(r => { if (r?.ok) pushState(); }).catch(e => console.error('[organiser]', e));
  titler.backfill(lastRows);
}, 3000).unref();

// ── continuing project work ───────────────────────────────────────────────
const STATE_WORDS = { todo: 'to do', doing: 'in progress', blocked: 'blocked', built: 'built, not live', live: 'live' };

/**
 * A ready-to-edit opening message for a new session that picks up a project (or one task in it), built
 * from what Pit Wall already knows: the goal, the checklist, and what recent sessions last said.
 */
/** The nightly review's suggestions that still apply (the task is unchanged since, the project still open). */
function liveSuggestions() {
  return store.get('nightlySuggestions', []).filter(s => {
    if (s.kind === 'finish') return store.project(s.projectId)?.archived === 0;
    const it = store.checklistItem(s.itemId);
    return it && it.state === s.from;
  });
}

function buildBrief(project, item = null) {
  const sessions = lastRows.filter(r => r.projectId === project.id)
    .sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
  const linked = item?.source_session ? lastRows.find(r => r.id === item.source_session) : null;
  const cwd = linked?.cwd ?? sessions.find(s => s.cwd)?.cwd ?? config.workspaceRoot;
  const checklist = store.checklist(project.id);
  const said = sessions.slice(0, 3).map(s => {
    const what = (s.summary || s.lastAssistant || s.lastPrompt || '').replace(/\s+/g, ' ').slice(0, 450);
    return what ? `- "${s.name}" (${s.lastActivity ? s.lastActivity.slice(0, 10) : 'earlier'}): ${what}` : null;
  }).filter(Boolean);
  const lines = [
    item ? `Let's pick up a task on the "${project.name}" project.` : `Let's continue the "${project.name}" project.`,
    project.description ? `\nGoal: ${project.description}` : '',
    item ? `\nThe task to work on now: ${item.text} (currently ${STATE_WORDS[item.state] ?? item.state}).` : '',
    checklist.length ? `\nWhere things stand (Pit Wall's checklist for this project):\n${checklist.map(c => `- [${STATE_WORDS[c.state] ?? c.state}] ${c.text}`).join('\n')}` : '',
    said.length ? `\nWhat the most recent sessions on this project said:\n${said.join('\n')}` : '',
    '\nBefore changing anything: check the current state (git status and branch, the relevant files, and any vault or memory notes about this), then tell me where things stand and the next step you propose.',
  ];
  return {
    message: lines.filter(Boolean).join('\n'),
    cwd, projectId: project.id,
    name: item ? item.text.slice(0, 70) : project.name.slice(0, 70),
    linkedSession: linked ? { id: linked.id, name: linked.name, live: linked.source !== 'closed' } : null,
    latestSession: sessions[0] ? { id: sessions[0].id, name: sessions[0].name, live: sessions[0].source !== 'closed' } : null,
  };
}

// ── task status → the chat behind it ─────────────────────────────────────
// When you change a task's status, the chat it came from (or the project's latest chat) is told on your next
// message there, by the UserPromptSubmit hook in src/hook-inbox.mjs — terminal or Pit Wall, at no extra cost.
const INBOX_DIR = path.join(paths.hookStatusDir, 'inbox');
const STATE_LABEL = { todo: 'To do', doing: 'Doing', blocked: 'Blocked', built: 'Built', live: 'Done' };
const NOTE_MEANING = { deployed: 'it is deployed and live in production', finished: 'the work is finished (nothing to deploy)' };

/** The chat to tell about a task: the one it came from, else the project's most recent chat that is still in use. */
function chatForTask(item) {
  if (item.source_session) return item.source_session;
  const s = lastRows.filter(r => r.projectId === item.project_id && !r.supersededBy)
    .sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))[0];
  return s?.id ?? null;
}

function eventLine(e) {
  const when = new Date(`${e.at.replace(' ', 'T')}Z`).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const project = store.project(e.project_id)?.name;
  const note = e.note ? ` — ${NOTE_MEANING[e.note] ?? `${config.user.name}'s note: ${e.note}`}` : '';
  return `- "${e.item_text}"${project ? ` (project "${project}")` : ''}: ${STATE_LABEL[e.from_state] ?? e.from_state ?? '?'} → ${STATE_LABEL[e.to_state] ?? e.to_state}${note}. ${when}.`;
}

function taskUpdateMessage(events) {
  return [
    `Pit Wall (${config.user.name}'s project tracker) — ${config.user.name} changed the status of tasks linked to this chat:`,
    ...events.map(eventLine),
    '',
    `Treat these as facts from ${config.user.name}. "Done" with "deployed" means it is live in production. Where your memory notes, vault notes or`,
    'any status you keep describe these tasks, update them to match (follow the usual rules for those notes). Mention this only if it matters to the reply.',
  ].join('\n');
}

/** (Re)write the chat's inbox note from everything it hasn't been told yet; remove it when there's nothing left. */
function syncInbox(sessionId) {
  const events = store.undeliveredEvents(sessionId);
  const file = path.join(INBOX_DIR, `${sessionId}.json`);
  if (!events.length) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ids: events.map(e => e.id), message: taskUpdateMessage(events), at: new Date().toISOString() }));
  fs.renameSync(tmp, file);
}

/** The hook renames a note to <id>.delivered.json when it hands it over; record that and tidy up. */
function collectDelivered() {
  let files = [];
  try { files = fs.readdirSync(INBOX_DIR).filter(f => f.endsWith('.delivered.json')); } catch { return; }
  for (const f of files) {
    const full = path.join(INBOX_DIR, f);
    try {
      const note = JSON.parse(fs.readFileSync(full, 'utf8'));
      for (const id of note.ids ?? []) store.updateChecklistEvent(id, { delivered: true });
    } catch { /* unreadable: drop it */ }
    fs.rmSync(full, { force: true });
    syncInbox(f.slice(0, -'.delivered.json'.length)); // anything changed since the note was written
    schedulePush();
  }
}
setInterval(() => { try { collectDelivered(); } catch (e) { console.error('[inbox]', e.message); } }, 5_000).unref();

function inboxHookInstalled() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(config.claudeHome, 'settings.json'), 'utf8'));
    return JSON.stringify(s.hooks?.UserPromptSubmit ?? []).includes('pit-wall/src/hook-inbox.mjs');
  } catch { return false; }
}

/** Today's date on this PC's clock (not UTC — between midnight and 01:00 BST they differ). */
function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** What each session did on a (local) day: turns, files changed, commits, deploys, vault reminders. */
function activityFor(day) {
  const start = new Date(`${day}T00:00:00`);
  const since = start.toISOString(), until = new Date(start.getTime() + 86_400_000).toISOString();
  const out = [];
  for (const [id, t] of scanner.transcriptIndex(new Set())) {
    if (t.mtimeMs < start.getTime() || store.sessionMeta(id)?.hidden) continue;
    const a2 = analyseTranscript(t.file, since, until);
    if (!a2?.turns) continue;
    const row = rowFor(id);
    out.push({ id, name: chatName(id) ?? 'Session', projectId: row?.projectId ?? null,
      first: a2.first, last: a2.last, turns: a2.turns, edits: a2.edits.map(e => e.path), commits: a2.commits, deploys: a2.deploys,
      vaultEdited: a2.vaultEdited, vaultReminder: a2.commits > 0 && !a2.vaultEdited });
  }
  return out.sort((x, y) => (y.last ?? '').localeCompare(x.last ?? ''));
}

/**
 * Keep a plain-text copy of each day's activity in data/activity/YYYY-MM-DD.md, so the Thursday
 * weekly-summary skill (or anyone) can read what happened without re-reading transcripts.
 */
function writeActivityFiles() {
  const dir = path.join(config.dataDir, 'activity');
  fs.mkdirSync(dir, { recursive: true });
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  for (const day of [localDay(yesterday), localDay()]) {
    const file = path.join(dir, `${day}.md`);
    if (day !== localDay() && fs.existsSync(file)) continue; // past days are final once written
    const sessions = activityFor(day);
    const projectName = id => store.project(id)?.name ?? null;
    const lines = [`# Claude Code activity — ${day}`, '', `${sessions.length} sessions, ${sessions.reduce((n, s) => n + s.edits.length, 0)} files changed, ${sessions.reduce((n, s) => n + s.commits, 0)} commits.`, ''];
    const start = new Date(`${day}T00:00:00`);
    const sqlTime = d => d.toISOString().replace('T', ' ').slice(0, 19);
    const changes = store.checklistEventsBetween(sqlTime(start), sqlTime(new Date(start.getTime() + 86_400_000)));
    if (changes.length) {
      lines.push('## Task status changes', ...changes.map(e => `- ${e.project ?? 'Project'}: "${e.item_text}" ${STATE_LABEL[e.from_state] ?? e.from_state ?? '?'} → ${STATE_LABEL[e.to_state] ?? e.to_state}${e.note ? ` (${e.note})` : ''}, by ${e.by === 'user' ? config.user.name : e.by}`), '');
    }
    for (const s of sessions) {
      lines.push(`## ${s.name}${s.projectId ? ` (${projectName(s.projectId)})` : ''}`,
        `- ${s.first?.slice(11, 16)}–${s.last?.slice(11, 16)} UTC, ${s.turns} turns, ${s.commits} commits`);
      if (s.edits.length) lines.push(`- Files: ${s.edits.map(p => p.replace(config.workspaceRoot, '').replace(/^[\\/]/, '')).join(', ')}`);
      if (s.deploys.length) lines.push(`- Deploy/push commands: ${s.deploys.map(d => `\`${d}\``).join('; ')}`);
      if (s.vaultReminder) lines.push('- Committed code without updating the vault');
      lines.push('');
    }
    fs.writeFileSync(file, lines.join('\n'));
  }
}
setTimeout(() => { try { writeActivityFiles(); } catch (e) { console.error('[activity]', e.message); } }, 30_000).unref();

// ── weekly roundup ─────────────────────────────────────────────────────────
// No recipient (roundupTo in data/local.json or site.json) = no roundup, whatever the switch says.
const roundupOn = () => !!config.roundup.to && (store.get('roundupEnabled', null) ?? config.roundup.defaultOn);
const roundupToName = () => config.roundup.toName ?? config.roundup.to;
let roundupRunning = false;
/** Writes this week's roundup (one tool-less Sonnet call) and says so; sending it is a click in the page. */
async function writeRoundup(week = weekKey()) {
  if (roundupRunning) return;
  roundupRunning = true;
  schedulePush();
  try {
    const sqlTime = d => d.toISOString().replace('T', ' ').slice(0, 19);
    const days = weekDays().map(day => {
      const start = new Date(`${day}T00:00:00`);
      return { day,
        sessions: activityFor(day).map(s => ({ name: s.name, project: s.projectId ? store.project(s.projectId)?.name : null,
          turns: s.turns, edits: s.edits, commits: s.commits, deploys: s.deploys })),
        changes: store.checklistEventsBetween(sqlTime(start), sqlTime(new Date(start.getTime() + 86_400_000))) };
    });
    const projects = store.projects().map(p => ({ name: p.name, items: store.checklist(p.id).map(c => ({ text: c.text, state: c.state })) }));
    const r = await callModel({ engine: defaultEngine(store), codexModels: store.get('codexModels', []), claudeExe: config.claudeExe, cwd: paths.organiserCwd, model: 'sonnet', effort: 'low', schema: ROUNDUP_SCHEMA,
      prompt: buildRoundupPrompt({ name: config.user.name, to: config.roundup.to, toLabel: config.roundup.toLabel, week, days, projects }), onRate: saveRate });
    if (!r.ok) { console.error('[roundup]', r.error); store.set('roundupError', String(r.error).slice(0, 300)); return; }
    store.set('roundup', { week, createdAt: new Date().toISOString(), subject: String(r.data.subject).slice(0, 120),
      body: String(r.data.body).slice(0, 6000), sentAt: null, costUsd: r.costUsd ?? null });
    store.set('roundupError', null);
    if (config.roundup.autoSend) sendRoundup().catch(e => console.error('[roundup]', e.message));
    else if (store.get('notify', true)) showToast({ title: 'Your weekly roundup is ready', body: `Open Pit Wall to read it and send it to ${roundupToName()}.`, url: `http://127.0.0.1:${config.port}/` });
  } catch (e) { console.error('[roundup]', e.message); store.set('roundupError', e.message); }
  finally { roundupRunning = false; schedulePush(); }
}
let roundupSending = false;
const SEND_TRIES = 3;
/** Sends the latest roundup from the person's own Gmail; a failure is retried at the next ticks, then left to them. */
async function sendRoundup() {
  const r = store.get('roundup');
  if (!r || r.sentAt || roundupSending) return;
  roundupSending = true;
  schedulePush();
  try {
    const res = await sendViaGmail({ claudeExe: config.claudeExe, cwd: paths.organiserCwd, env: childEnv(), spawnFn: spawn,
      to: config.roundup.to, subject: r.subject, body: r.body });
    const now = new Date().toISOString();
    const tries = (r.tries ?? 0) + 1;
    if (res.ok) {
      store.set('roundup', { ...store.get('roundup'), sentAt: now, sentVia: 'gmail', tries, sendError: null });
      if (store.get('notify', true)) showToast({ title: `Weekly roundup sent to ${roundupToName()}`, body: r.subject, url: `http://127.0.0.1:${config.port}/` });
    } else {
      store.set('roundup', { ...store.get('roundup'), tries, lastTryAt: now, sendError: res.error });
      console.error('[roundup] send failed:', res.error);
      if (tries >= SEND_TRIES && store.get('notify', true)) showToast({ title: 'Your weekly roundup wasn’t sent', body: 'Open Pit Wall to send it — Gmail didn’t take it.', url: `http://127.0.0.1:${config.port}/` });
    }
  } finally { roundupSending = false; schedulePush(); }
}
const roundupTick = () => {
  if (!roundupOn()) return;
  const r = store.get('roundup');
  const week = roundupDue(new Date(), r?.week ?? null);
  if (week) { writeRoundup(week).catch(e => console.error('[roundup]', e.message)); return; }
  // Written but not sent (Gmail failed): try again, at most SEND_TRIES times, 30 min apart.
  if (config.roundup.autoSend && r && !r.sentAt && r.week === weekKey() && (r.tries ?? 0) < SEND_TRIES
    && Date.now() - Date.parse(r.lastTryAt ?? r.createdAt) > 25 * 60_000) sendRoundup().catch(e => console.error('[roundup]', e.message));
};
setTimeout(roundupTick, 120_000).unref();

// ── updates ────────────────────────────────────────────────────────────────
// Every 30 minutes (and soon after starting) ask GitHub whether a newer Pit Wall exists; the page offers it when this copy
// can simply fast-forward. Updating pulls, then restarts through restart.ps1 — chats keep running under their relays.
let updateInfo = null;
const updateTick = async () => {
  // Codex on and installed: the update info also says whether a newer Codex is out (npm, cached 6 h).
  if (codexEnabled(store) && config.codexExe) await Promise.all([installedCodexVersion(), latestCodex({ wait: true })]).catch(() => {});
  return checkUpdates(config.root).then(u => { updateInfo = u; schedulePush(); }).catch(e => console.error('[updates]', e.message));
};
setTimeout(updateTick, 60_000).unref();
setInterval(updateTick, 30 * 60_000).unref();
setInterval(roundupTick, 30 * 60_000).unref();
setInterval(() => { try { writeActivityFiles(); } catch (e) { console.error('[activity]', e.message); } }, 3_600_000).unref();

/** SQLite datetime('now') is UTC without a zone; ISO strings pass through. */
const sqlIso = s => (s && !s.includes('T') ? `${s.replace(' ', 'T')}Z` : s);

// Follow-ups that have come due: one notification each, then they sit in Needs you until done.
// A scheduled check (src/schedule.mjs) follows its queued job: hidden while it waits or runs, then in Needs you as
// "ran" (with the job's chat to read) or "missed" (never started in time, failed, removed) — it never just vanishes.
const CHECK_TOASTS = { ran: 'Scheduled check finished', missed: 'Scheduled check missed' };
function remindFollowups() {
  const why = config.automation ? queue.status().why : '';
  for (let f of store.followups()) {
    if (f.queue_id) {
      const s = checkState(f, store.queueItem(f.queue_id), { why });
      if (s.state !== f.state && s.state) {
        const settled = s.state !== 'running';
        store.updateFollowup(f.id, { state: s.state, text: s.text, session_id: s.sessionId ?? null,
          ...(settled ? { due_at: new Date().toISOString(), notified: 0 } : {}) });
        f = store.followup(f.id);
        schedulePush();
      }
      if (f.state === 'running' || !f.state) continue;
    }
    if (f.notified || Date.parse(f.due_at) > Date.now()) continue;
    store.updateFollowup(f.id, { notified: 1 });
    if (store.get('notify', true)) showToast({ title: CHECK_TOASTS[f.state] ?? 'Follow-up due', body: f.text, url: `http://127.0.0.1:${config.port}/${f.session_id ? `?s=${encodeURIComponent(f.session_id)}` : ''}` });
    schedulePush();
  }
}

setInterval(() => {
  // Not before running chats are picked up from relays: a job still running would look lost and the next would start.
  if (ready && config.automation) { try { queue.tick(); } catch (e) { console.error('[queue]', e); } }
  try { remindFollowups(); } catch (e) { console.error('[followups]', e); }
  maybeProbeUsage().catch(e => console.error('[usage]', e));
}, 20_000).unref();

// ── helpers ───────────────────────────────────────────────────────────────
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : headers['Content-Type'] ?? 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function cookieToken(req) {
  const m = /(?:^|;\s*)pw=([a-f0-9]+)/.exec(req.headers.cookie ?? '');
  return m?.[1] ?? '';
}
function tokenOk(req) {
  const a = Buffer.from(cookieToken(req));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const MAX_UPLOAD = 50_000_000;
/** Streams one uploaded file to data/uploads/<chat>/<time>-<name>; returns where it is. */
async function saveUpload(req, url) {
  const sid = String(url.searchParams.get('session') ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(sid)) throw Object.assign(new Error('Open a chat first.'), { status: 400 });
  const base = path.basename(String(url.searchParams.get('name') ?? 'file')).replace(/[^\w.\- ()]+/g, '_').slice(-120) || 'file';
  const dir = path.join(config.dataDir, 'uploads', sid);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(dir, `${stamp}-${base}`);
  let size = 0;
  const out = fs.createWriteStream(file);
  try {
    for await (const c of req) {
      size += c.length;
      if (size > MAX_UPLOAD) throw Object.assign(new Error('That file is over 50 MB.'), { status: 413 });
      if (!out.write(c)) await new Promise(r => out.once('drain', r));
    }
  } catch (e) { out.destroy(); fs.rmSync(file, { force: true }); throw e; }
  await new Promise(r => out.end(r));
  return { path: file, name: base, size };
}

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 45_000_000) throw Object.assign(new Error('That message is too large — send fewer or smaller images.'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Bad JSON'), { status: 400 }); }
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/markdown.js': ['markdown.js', 'text/javascript; charset=utf-8'],
  '/more.js': ['more.js', 'text/javascript; charset=utf-8'],
  '/chat-extras.js': ['chat-extras.js', 'text/javascript; charset=utf-8'],
  '/agent-rows.js': ['agent-rows.js', 'text/javascript; charset=utf-8'],
  '/engine-text.js': ['engine-text.js', 'text/javascript; charset=utf-8'],
  '/speech.js': ['speech.js', 'text/javascript; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/starfield.js': ['starfield.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function rowFor(id) {
  return lastRows.find(r => r.id === id) ?? null;
}

/** The name to hand Claude (`-n`) and show in messages: yours, else Haiku's, else the board's — never the placeholder. */
function chatName(id) {
  const sm = store.sessionMeta(id);
  return realName(sm?.display_name) ?? sm?.auto_title ?? realName(rowFor(id)?.name) ?? undefined;
}

/**
 * You're finished with a chat: end its Claude process if Pit Wall runs it (never a terminal's), and take it
 * off the board. It stays searchable under Closed, and any new activity reopens it.
 */
async function finishSession(id) {
  if (runner.get(id)?.proc) await runner.stop(id);
  store.upsertSession(id, { done_at: new Date().toISOString(), interrupted: false, snoozed_until: null,
    cwd: store.sessionMeta(id)?.cwd ?? rowFor(id)?.cwd ?? null });
}

function terminalGuard(id) {
  const t = scanner.liveTerminals(runner.childPids()).find(t => t.sessionId === id);
  if (t) throw Object.assign(new Error(`This session is still open in terminal "${t.name}". Close it there (type /exit) and it will carry on here.`), { status: 409 });
}

// ── routes ────────────────────────────────────────────────────────────────
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;
  const [, a, b, c, d] = parts;
  if (!ready) return send(res, 503, { error: 'Pit Wall is starting — picking up running chats. Try again in a moment.' });

  if (method === 'GET' && a === 'state') return send(res, 200, buildState());

  if (method === 'GET' && a === 'events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify(buildState())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  // One agent's full prompt, steps and result — loaded only when its panel is opened.
  if (a === 'sessions' && b && c === 'agents' && d && method === 'GET') {
    const file = rowFor(b)?.transcript ?? scanner.transcriptIndex(new Set([b])).get(b)?.file ?? null;
    const detail = file ? agentDetail(file.replace(/\.jsonl$/, ''), d) : null;
    return detail ? send(res, 200, detail) : send(res, 404, { error: 'That agent has not written anything yet.' });
  }
  if (a === 'codex' && b === 'status' && method === 'GET') return send(res, 200, await codexStatus());
  if (a === 'voice' && !b && method === 'GET') return send(res, 200, { ...voiceStatus(), remote: !!req.pw.remote });
  if (a === 'codex' && b === 'setup' && method === 'GET') return send(res, 200, { ...(await codexSetupState()), remote: !!req.pw.remote });
  if (a === 'sessions' && b && c === 'history' && method === 'GET') {
    const run = runner.get(b);
    const row = rowFor(b);
    const file = row?.transcript ?? scanner.transcriptIndex(new Set([b])).get(b)?.file ?? null;
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 400, 50), 5000);
    const hist = file ? readHistory(file, { limit, before: run?.startedAt ?? null, cutAt: store.sessionMeta(b)?.rewind_cut ?? null })
      : { items: [], truncated: false };
    return send(res, 200, { ...hist, live: [...(run ? runner.liveItems(run) : []), ...(shellPending.get(b) ?? []),
      ...[...shellRunning.values()].filter(s => s.sessionId === b).map(s => s.item)], run: run ? runner.publicRun(run) : null });
  }

  if (method !== 'GET') {
    const origin = req.headers.origin;
    const ok = req.pw.remote ? origin === req.pw.origin : ALLOWED_ORIGINS.has(origin);
    if (!origin || !ok) return send(res, 403, { error: 'Bad origin' });
  }
  // A file dropped into a chat that the page can't name by its path (or when used remotely): keep a copy Claude can read.
  if (a === 'uploads' && method === 'POST') return send(res, 201, await saveUpload(req, url));
  // A file a chat mentions, saved by the browser (the link in a reply). Relative paths are the chat's own folder.
  if (a === 'files' && method === 'GET') {
    const sid = String(url.searchParams.get('session') ?? '');
    const cwd = /^[0-9a-f-]{36}$/i.test(sid) ? sessionCwd(sid) : null;
    const text = cwd ? sessionTranscript(sid) : '';
    const f = resolveDownload(url.searchParams.get('path'), { cwd, seen: transcriptFolders(text), mentions: rel => transcriptPaths(text, rel), roots: [config.workspaceRoot, ...config.extraFolders], blocked: [config.dataDir] });
    // The page asks first, so a link that can't be served says why instead of saving a failed "files.json".
    if (url.searchParams.has('check')) return send(res, 200, { ok: true, name: f.name });
    res.writeHead(200, downloadHeaders(f));
    fs.createReadStream(f.file).on('error', () => res.destroy()).pipe(res);
    return;
  }
  // Codex signs in through its own browser flow: open it in a visible terminal on this PC.
  if (a === 'codex' && b === 'login' && method === 'POST') {
    // The sign-in terminal and browser open on this PC's desktop: from a phone nobody would see them.
    const no = codexRouteGuard({ remote: req.pw.remote, installed: !!config.codexExe, installing: codexSetup.install.running, what: 'Sign in to Codex' });
    if (no) return send(res, no.status, { error: no.error });
    codexSignedOutAt = 0; // signing in: the gauge poll shouldn't sit out its signed-out back-off
    const lc = loginCommand(config.codexExe);
    const p = spawn(lc.file, lc.args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: lc.verbatim });
    p.on('error', () => { /* no cmd.exe: nothing opens; the page's status re-checks show it */ });
    p.unref();
    codexStatusCache = null;
    return send(res, 202, { ok: true });
  }
  const data = method === 'GET' ? {} : await body(req);

  if (a === 'codex' && method === 'POST') {
    // On / off. Off: Pit Wall is Claude-only again; existing Codex chats still open and continue as Codex.
    if (b === 'enable') {
      if (typeof data.enabled !== 'boolean') return send(res, 400, { error: 'Say enabled: true or false.' });
      store.set('codexEnabled', data.enabled);
      pushState(true);
      return send(res, 200, { enabled: codexEnabled(store) });
    }
    // Install or update: npm i -g @openai/codex@latest (fixed arguments), up to 5 minutes; the panel watches /api/codex/setup.
    if (b === 'install') {
      // Not while Codex is in use: Windows can't replace an exe that is running (npm fails half-way), and never twice at once.
      const busy = installBlocker({ installing: codexSetup.install.running, codexChats: liveCodexChats(), checking: !!codexSetup.checking, statusReads: codexStatusReads });
      if (busy) return send(res, 409, { error: busy });
      runCodexInstall();
      return send(res, 202, { ok: true });
    }
    // The sandbox: an elevated PowerShell on this PC's desktop (you accept the Windows prompt), left open to show the result.
    if (b === 'sandbox' && !c) {
      const no = codexRouteGuard({ remote: req.pw.remote, installed: !!config.codexExe, installing: codexSetup.install.running, what: 'Set up the Codex sandbox' });
      if (no) return send(res, no.status, { error: no.error });
      const sc = sandboxSetupCommand(config.codexExe);
      const p = spawn(sc.file, sc.args, { detached: true, stdio: 'ignore', windowsHide: true });
      p.on('error', () => { /* no PowerShell: nothing opens; the panel's re-checks show it */ });
      p.unref();
      codexStatusCache = null;
      return send(res, 202, { ok: true });
    }
    // Zero-turn check that the sandbox a Codex chat would get really holds (no model turns). Kept as kv codexSandboxCheck.
    if (b === 'sandbox' && c === 'check') {
      const no = codexRouteGuard({ remote: req.pw.remote, installed: !!config.codexExe, installing: codexSetup.install.running, pcOnly: false });
      if (no) return send(res, no.status, { error: no.error });
      codexSetup.checking ??= sandboxCheck({ exe: config.codexExe }).then(r => { store.set('codexSandboxCheck', r); codexStatusCache = null; return r; })
        .finally(() => { codexSetup.checking = null; });
      return send(res, 200, await codexSetup.checking);
    }
  }

  // Read aloud's natural voice (src/voice.mjs): one piece of a reply → WAV, made on this PC. Phones use it too.
  if (a === 'voice' && b === 'speak' && method === 'POST') {
    const r = speakRequest(data);
    if (r.error) return send(res, 400, { error: r.error });
    let gone = false;
    res.on('close', () => { gone = true; }); // stopped or skipped on the page: don't make it if its turn hasn't come
    const wav = await speakWav(r.text, r.voice, () => gone);
    if (!wav || gone) return;
    return send(res, 200, wav, { 'Content-Type': 'audio/wav' });
  }
  if (a === 'voice' && b === 'warm' && method === 'POST') { warmVoice(); return send(res, 202, { ok: true }); }
  // Setting it up downloads ~720 MB onto this PC, so only from the PC itself; the More menu watches GET /api/voice.
  if (a === 'voice' && b === 'install' && method === 'POST') {
    if (req.pw.remote) return send(res, 403, { error: 'Set up the natural voice from Pit Wall on the PC itself.' });
    installVoice(() => pushState(true));
    return send(res, 202, { ok: true });
  }

  if (a === 'sessions' && !b && method === 'POST') {
    const cwd = String(data.cwd ?? '');
    if (!workspaces().includes(cwd) && !(data.cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory())) return send(res, 400, { error: 'Pick a folder that exists.' });
    if (data.permissionMode && !PERMISSION_MODES.includes(data.permissionMode)) return send(res, 400, { error: 'Permission mode not allowed.' });
    const engine = engineFor(store, data.engine);
    const codexModels = store.get('codexModels', []);
    if (data.model && !validModel(engine, data.model, codexModels)) return send(res, 400, { error: 'Unknown model.' });
    const message = String(data.message ?? '').trim();
    let images;
    try { images = validateImages(data.images); } catch (e) { return send(res, 400, { error: e.message }); }
    if (!message && !images.length) return send(res, 400, { error: 'Write the first message.' });
    if (data.effort && !validEffort(engine, data.effort, data.model || '', codexModels)) return send(res, 400, { error: 'Unknown effort level.' });
    const name = String(data.name ?? '').trim().slice(0, 80) || null;
    const id = runner.start({ cwd, name, engine, model: data.model || null, permissionMode: data.permissionMode || null,
      effort: data.effort || null, message, images });
    const projectId = data.projectId ? Number(data.projectId) : null;
    store.upsertSession(id, { cwd, display_name: name, project_id: projectId, project_locked: projectId ? 1 : 0,
      engine, model: data.model || null, permission_mode: data.permissionMode || null, effort: data.effort || null });
    if (!name && message) titler.request(id, message);
    schedulePush();
    return send(res, 201, { id });
  }

  if (a === 'sessions' && b) {
    const id = b;
    if (c === 'shell-stop' && method === 'POST') {
      const s = shellRunning.get(String(data.shellId ?? ''));
      if (!s || s.sessionId !== id) return send(res, 404, { error: 'That command has already finished.' });
      s.ctrl.abort();
      return send(res, 200, { ok: true });
    }
    if (c === 'message' && method === 'POST') {
      const text = String(data.text ?? '').trim();
      let images;
      try { images = validateImages(data.images); } catch (e) { return send(res, 400, { error: e.message }); }
      if (!text && !images.length) return send(res, 400, { error: 'Empty message.' });
      // "! command": run it here and show the output; Claude gets it with the next message (no turn, as in the terminal).
      if (text.startsWith('!') && !images.length) {
        const command = text.slice(1).trim();
        if (!command) return send(res, 400, { error: 'Type a command after the !' });
        // Shown straight away and updated as output arrives: a login prints its code and link, then waits for you.
        const item = { ...shellItem(command, { stdout: '', stderr: '', code: null }), id: `sh${++shellSeq}`, running: true };
        const ctrl = new AbortController();
        shellRunning.set(item.id, { sessionId: id, item, ctrl });
        broadcast('item', { sessionId: id, item });
        let timer = null;
        const flush = () => { timer = null; broadcast('shell', { sessionId: id, item }); };
        runShell(command, { cwd: sessionCwd(id), signal: ctrl.signal, onOutput: (text, stream) => {
          item[stream] = (item[stream] + text).slice(-30_000);
          timer ??= setTimeout(flush, 250);
        } }).then(r => {
          clearTimeout(timer);
          shellRunning.delete(item.id);
          Object.assign(item, shellItem(command, r, item.ts), { running: false });
          shellPending.set(id, [...(shellPending.get(id) ?? []), item]);
          broadcast('shell', { sessionId: id, item });
        });
        return send(res, 202, { ok: true, item });
      }
      const run = runner.get(id);
      if (!run?.proc) terminalGuard(id);
      const row = rowFor(id);
      const sm = store.sessionMeta(id);
      const shells = shellPending.get(id) ?? [];
      runner.send(id, text, { cwd: sessionCwd(id), name: chatName(id), engine: sm?.engine ?? 'claude',
        model: sm?.model ?? undefined, permissionMode: sm?.permission_mode ?? undefined, effort: sm?.effort ?? undefined, images,
        context: shells.map(shellContext).join('\n'), waitReady: !!sm?.forked_from });
      shellPending.delete(id);
      schedulePush();
      return send(res, 202, { ok: true });
    }
    if (c === 'continue' && method === 'POST') {
      // After a restart: pick the task back up — only when you ask, never automatically.
      terminalGuard(id);
      const row = rowFor(id);
      const sm = store.sessionMeta(id);
      runner.send(id, 'Pit Wall restarted while you were working, so your last step was cut off. Check where you got to and carry on from there.',
        { cwd: sessionCwd(id), name: chatName(id), engine: sm?.engine ?? 'claude', model: sm?.model ?? undefined,
          permissionMode: sm?.permission_mode ?? undefined, effort: sm?.effort ?? undefined });
      schedulePush();
      return send(res, 202, { ok: true });
    }
    if (c === 'take-over' && method === 'POST') {
      // "Move here": end Claude in an idle terminal (after checking it is really that process), then chat here.
      const term = scanner.liveTerminals(runner.childPids()).find(t => t.sessionId === id);
      const actualStart = term ? await processStartFiletime(term.pid) : null;
      const verdict = canTakeOver({ term, hook: hookStatus.get(id), actualStart });
      if (!verdict.ok) return send(res, 409, { error: verdict.why });
      // Ending the terminal's process would end the agents it is still running.
      if (rowFor(id)?.status === 'agents_working') return send(res, 409, { error: 'That terminal still has agents or a workflow running. Wait for them to finish, then try again.' });
      await new Promise(resolve => execFile('taskkill', ['/PID', String(term.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
      store.upsertSession(id, { cwd: term.cwd ?? sessionCwd(id) });
      pushState(true);
      return send(res, 200, { ok: true });
    }
    if (c === 'fresh-start' && method === 'POST') {
      terminalGuard(id);
      const run = runner.get(id);
      if (run?.proc && run.status !== 'your_turn') return send(res, 409, { error: 'Wait until it has finished its current step.' });
      if (freshStarts.has(id)) return send(res, 409, { error: 'Already writing a handoff.' });
      const sm = store.sessionMeta(id);
      freshStarts.set(id, { startedAt: new Date().toISOString() });
      try {
        runner.send(id, HANDOFF_PROMPT, { cwd: sessionCwd(id), name: chatName(id), engine: sm?.engine ?? 'claude', model: sm?.model ?? undefined,
          permissionMode: 'plan', effort: sm?.effort ?? undefined });
      } catch (e) { freshStarts.delete(id); throw e; }
      schedulePush();
      return send(res, 202, { ok: true });
    }
    if (c === 'snooze' && method === 'POST') {
      const minutes = Number(data.minutes);
      store.upsertSession(id, { snoozed_until: data.clear || !minutes ? null : new Date(Date.now() + minutes * 60_000).toISOString() });
      pushState(true);
      return send(res, 200, { ok: true });
    }
    if (c === 'handoff' && method === 'POST') {
      // Uses your /handoff skill to write a paste-ready prompt for another PC or a teammate's Claude.
      terminalGuard(id);
      const sm = store.sessionMeta(id);
      const cwd = sessionCwd(id);
      // /handoff is a workspace skill: only Claude sessions working inside Documents\GitHub have it.
      const text = handoffText(sm?.engine ?? 'claude', insideWorkspace(cwd));
      runner.send(id, text, { cwd, name: chatName(id), engine: sm?.engine ?? 'claude', model: sm?.model ?? undefined,
        permissionMode: sm?.permission_mode ?? undefined, effort: sm?.effort ?? undefined });
      schedulePush();
      return send(res, 202, { ok: true });
    }
    if (c === 'dismiss' && method === 'POST') {
      store.upsertSession(id, { interrupted: false });
      schedulePush();
      return send(res, 200, { ok: true });
    }
    if (c === 'answer' && method === 'POST') {
      runner.answer(id, String(data.requestId), {
        behavior: data.behavior === 'allow' ? 'allow' : 'deny', always: !!data.always,
        answers: data.answers && typeof data.answers === 'object' ? data.answers : undefined,
        message: data.message ? String(data.message).slice(0, 500) : undefined,
        mode: PERMISSION_MODES.includes(data.mode) ? data.mode : undefined,
      });
      // Approving a plan: carry on in the mode you picked.
      if (data.mode && PERMISSION_MODES.includes(data.mode)) {
        store.upsertSession(id, { permission_mode: data.mode });
        await runner.reconfigure(id, { permissionMode: data.mode }).catch(() => {});
      }
      return send(res, 200, { ok: true });
    }
    if (c === 'interrupt' && method === 'POST') { runner.interrupt(id); return send(res, 200, { ok: true }); }
    if (c === 'stop' && method === 'POST') { await runner.stop(id); return send(res, 200, { ok: true }); }
    if (c === 'finish' && method === 'POST') { await finishSession(id); pushState(true); return send(res, 200, { ok: true }); }
    if (c === 'reopen' && method === 'POST') { store.upsertSession(id, { done_at: null }); pushState(true); return send(res, 200, { ok: true }); }
    // ── terminal parity: /btw, fork, rewind, queued messages, background tasks ──
    if (c === 'btw' && method === 'POST') {
      const question = String(data.question ?? '').trim().slice(0, 4000);
      if (!question) return send(res, 400, { error: 'Ask a question.' });
      terminalGuard(id);
      const history = (Array.isArray(data.history) ? data.history : []).slice(-20)
        .map(h => ({ question: String(h?.question ?? '').slice(0, 4000), response: String(h?.response ?? '').slice(0, 20_000) }));
      try { return send(res, 200, await runner.sideQuestion(id, question, history, runOpts(id))); }
      catch (e) { return send(res, 502, { error: e.message }); }
    }
    if (c === 'fork' && method === 'POST') {
      terminalGuard(id);
      const message = String(data.message ?? '').trim();
      let images;
      try { images = validateImages(data.images); } catch (e) { return send(res, 400, { error: e.message }); }
      if (!message && !images.length) return send(res, 400, { error: 'Write the first message for the fork.' });
      const atUuid = data.atUuid ? String(data.atUuid) : null;
      const opts = runOpts(id);
      // Codex item ids (a reply's uuid in a Codex chat) are not UUIDs; they are still never a path.
      const okId = opts.engine === 'codex' ? /^\w[\w-]{0,79}$/ : /^[0-9a-f-]{36}$/i;
      if (atUuid && !okId.test(atUuid)) return send(res, 400, { error: 'That reply cannot be forked from.' });
      const newId = runner.fork(id, { atUuid, message, images, ...opts });
      const sm = store.sessionMeta(id);
      store.upsertSession(newId, { cwd: opts.cwd, display_name: `Fork of ${opts.name ?? 'chat'}`.slice(0, 80), project_id: sm?.project_id ?? null,
        project_locked: sm?.project_id ? 1 : 0, engine: opts.engine, model: sm?.model ?? null, permission_mode: sm?.permission_mode ?? null, effort: sm?.effort ?? null,
        color: sm?.color ?? null, run_here: true, forked_from: id });
      schedulePush();
      return send(res, 201, { id: newId });
    }
    if (c === 'rewind-preview' && method === 'POST') {
      terminalGuard(id);
      try { return send(res, 200, await runner.rewindPreview(id, String(data.uuid ?? ''), runOpts(id))); }
      catch (e) { return send(res, 200, { canRewind: false, error: e.message }); }
    }
    if (c === 'rewind' && method === 'POST') {
      terminalGuard(id);
      const uuid = String(data.uuid ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(uuid)) return send(res, 400, { error: 'Pick one of your messages.' });
      try {
        const r = await runner.rewind(id, uuid, { files: !!data.files, ...runOpts(id) });
        store.upsertSession(id, { rewind_cut: uuid }); // until a new message makes the new branch the current one
        return send(res, 200, { prefillText: r?.prefillText ?? '' });
      } catch (e) { return send(res, 502, { error: e.message }); }
    }
    if (c === 'queued' && d && method === 'POST') {
      const what = url.searchParams.get('do');
      const ok = what === 'now' ? await runner.sendNow(id, d) : await runner.cancelQueued(id, d);
      return ok ? send(res, 200, { ok: true }) : send(res, 409, { error: 'Claude has already picked that message up.' });
    }
    if (c === 'tasks' && d && method === 'POST') {
      try { await runner.stopTask(id, d); return send(res, 200, { ok: true }); }
      catch (e) { return send(res, 409, { error: e.message }); }
    }
    if (!c && method === 'PATCH') {
      const fields = {};
      if ('color' in data) fields.color = CHAT_COLORS.includes(data.color) ? data.color : null;
      if ('displayName' in data) fields.display_name = String(data.displayName ?? '').trim().slice(0, 80) || null;
      if ('projectId' in data) { fields.project_id = data.projectId ? Number(data.projectId) : null; fields.project_locked = 1; }
      if ('hidden' in data) fields.hidden = !!data.hidden;
      const sm0 = store.sessionMeta(id);
      const engine = sm0?.engine ?? runner.get(id)?.engine ?? 'claude';
      const codexModels = store.get('codexModels', []);
      if ('model' in data) { if (data.model && !validModel(engine, data.model, codexModels)) return send(res, 400, { error: 'Unknown model.' }); fields.model = data.model || null; }
      if ('permissionMode' in data) {
        if (data.permissionMode && !PERMISSION_MODES.includes(data.permissionMode)) return send(res, 400, { error: 'Permission mode not allowed.' });
        fields.permission_mode = data.permissionMode || null;
      }
      if ('effort' in data) {
        if (data.effort && !validEffort(engine, data.effort, ('model' in fields ? fields.model : sm0?.model) || '', codexModels)) return send(res, 400, { error: 'Unknown effort level.' });
        fields.effort = data.effort || null;
      }
      const row = rowFor(id);
      if (row?.cwd && !store.sessionMeta(id)?.cwd) fields.cwd = row.cwd;
      store.upsertSession(id, fields);
      if ('displayName' in data && runner.get(id)) runner.get(id).name = fields.display_name;
      if ('model' in fields || 'permission_mode' in fields || 'effort' in fields) {
        await runner.reconfigure(id, { model: fields.model, permissionMode: fields.permission_mode, effort: fields.effort });
      }
      schedulePush();
      return send(res, 200, { ok: true });
    }
  }

  if (a === 'update' && method === 'POST') {
    if (b === 'check') { await updateTick(); return send(res, 200, withCodexUpdate(updateInfo, codexEnabled(store)) ?? {}); }
    const u = await checkUpdates(config.root);
    updateInfo = u;
    if (!u.canUpdate) return send(res, 409, { error: u.error ?? (u.behind ? 'This copy has its own changes, so it is not updated automatically.' : 'Already up to date.') });
    const pull = await git(config.root, ['pull', '--ff-only', '--quiet'], { timeout: 120_000 });
    if (!pull.ok) return send(res, 502, { error: `The update failed: ${pull.err.split('\n')[0]}` });
    // Pulled: stop offering it now, not only once the restart lands — until then this server would keep showing the button.
    updateInfo = { ...u, behind: 0, subjects: [], canUpdate: false };
    schedulePush();
    // Restart from a separate process (it stops this one); chats under relays carry on and are picked up again.
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(config.root, 'restart.ps1')],
      { cwd: config.root, env: childEnv(), detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return send(res, 202, { ok: true });
  }

  if (a === 'roundup' && method === 'POST') {
    if (!config.roundup.to) return send(res, 409, { error: 'No roundup recipient: set "roundupTo" in data/local.json.' });
    if (!b) { store.set('roundupEnabled', !!data.enabled); pushState(true); return send(res, 200, { ok: true }); }
    if (b === 'now') { writeRoundup().catch(() => {}); return send(res, 202, { ok: true }); }
    if (b === 'sent') { const r = store.get('roundup'); if (r) store.set('roundup', { ...r, sentAt: new Date().toISOString(), sentVia: 'email app' }); pushState(true); return send(res, 200, { ok: true }); }
    if (b === 'send') {
      // Send now from Gmail, with any edits made in the dialog.
      const r = store.get('roundup');
      if (!r) return send(res, 404, { error: 'No roundup written yet.' });
      if (r.sentAt) return send(res, 409, { error: 'Already sent.' });
      store.set('roundup', { ...r, subject: String(data.subject ?? r.subject).slice(0, 120), body: String(data.body ?? r.body).slice(0, 6000) });
      await sendRoundup();
      const after = store.get('roundup');
      return after.sentAt ? send(res, 200, { ok: true }) : send(res, 502, { error: after.sendError ?? 'Not sent.' });
    }
  }

  if (a === 'projects') {
    if (!b && method === 'POST') {
      const name = String(data.name ?? '').trim().slice(0, 80);
      if (!name) return send(res, 400, { error: 'Name the project.' });
      const id = store.createProject(name, String(data.description ?? '').slice(0, 300), { locked: true });
      schedulePush();
      return send(res, 201, { id });
    }
    const pid = Number(b);
    if (!store.project(pid)) return send(res, 404, { error: 'No such project.' });
    if (!c && method === 'PATCH') {
      store.updateProject(pid, { name: data.name?.trim().slice(0, 80) || undefined, description: data.description?.slice(0, 300), archived: data.archived }, 'user');
      if ('budgetPct' in data) store.setProjectBudget(pid, Number(data.budgetPct) > 0 ? Math.min(100, Number(data.budgetPct)) : null);
      schedulePush();
      return send(res, 200, { ok: true });
    }
    if (!c && method === 'DELETE') { store.deleteProject(pid); schedulePush(); return send(res, 200, { ok: true }); }
    if (c === 'finish' && method === 'POST') {
      // Finished with the whole project: file it away and close every chat in it.
      const ids = lastRows.filter(r => r.projectId === pid && !r.done).map(r => r.id);
      for (const sid of ids) await finishSession(sid);
      store.updateProject(pid, { archived: true }, 'user');
      pushState(true);
      return send(res, 200, { ok: true, chats: ids.length });
    }
    if (c === 'brief' && method === 'POST') return send(res, 200, buildBrief(store.project(pid)));
    if (c === 'checklist' && method === 'POST') {
      const text = String(data.text ?? '').trim().slice(0, 140);
      if (!text) return send(res, 400, { error: 'Empty item.' });
      store.addChecklistItem(pid, text, data.state ?? 'todo', { locked: true });
      schedulePush();
      return send(res, 201, { ok: true });
    }
  }

  if (a === 'task-events' && b) {
    const e = store.checklistEvent(Number(b));
    if (!e) return send(res, 404, { error: 'No such change.' });
    if (!c && method === 'PATCH') {
      store.updateChecklistEvent(e.id, { note: String(data.note ?? '').trim().slice(0, 200) || null });
      if (e.session_id && !e.delivered_at) syncInbox(e.session_id);
      schedulePush();
      return send(res, 200, { ok: true });
    }
    if (c === 'tell' && method === 'POST') {
      // Tell the chat right now (one turn of usage) — only where Pit Wall can send to it.
      if (!e.session_id) return send(res, 400, { error: 'This task has no chat to tell.' });
      terminalGuard(e.session_id);
      const events = store.undeliveredEvents(e.session_id);
      if (!events.length) return send(res, 200, { ok: true, already: true });
      const sm = store.sessionMeta(e.session_id);
      const text = `${taskUpdateMessage(events)}\n\nPlease update those notes now, then reply in one line saying what you changed.`;
      // Sent first: if the chat can't start (e.g. Codex being installed → 409) the updates stay undelivered for next time.
      runner.send(e.session_id, text, { cwd: sessionCwd(e.session_id), name: chatName(e.session_id), engine: sm?.engine ?? 'claude',
        model: sm?.model ?? undefined, permissionMode: sm?.permission_mode ?? undefined, effort: sm?.effort ?? undefined });
      for (const x of events) store.updateChecklistEvent(x.id, { delivered: true });
      syncInbox(e.session_id); // nothing left, so the hook won't repeat it
      schedulePush();
      return send(res, 202, { ok: true });
    }
  }
  if (a === 'checklist' && b && c === 'brief' && method === 'POST') {
    const item = store.checklistItem(Number(b));
    if (!item) return send(res, 404, { error: 'No such checklist item.' });
    return send(res, 200, buildBrief(store.project(item.project_id), item));
  }
  if (a === 'checklist' && b) {
    if (method === 'PATCH') {
      const event = store.updateChecklistItem(Number(b), { text: data.text, state: data.state }, 'user');
      let tell = null;
      if (event) {
        const sessionId = chatForTask(store.checklistItem(Number(b)));
        if (sessionId) {
          store.updateChecklistEvent(event.id, { sessionId });
          syncInbox(sessionId);
          const row = rowFor(sessionId);
          tell = { sessionId, name: chatName(sessionId) ?? 'the chat', source: row?.source ?? 'closed' };
        }
      }
      schedulePush();
      return send(res, 200, { ok: true, event: event ? store.checklistEvent(event.id) : null, tell });
    }
    if (method === 'DELETE') { store.deleteChecklistItem(Number(b)); schedulePush(); return send(res, 200, { ok: true }); }
  }

  // ── usage breakdown ──
  if (a === 'usage' && method === 'POST') {
    const total = lastRows.reduce((n, r) => n + processed(r.week), 0) || 1;
    const engRows = lastRows.map(r => ({ ...r, engine: lastEngines.get(r.id) }));
    const { totals, top } = usageTop(engRows);
    const tokensEngine = tokensByEngine(engRows), { cacheShare, cacheTokenShare } = claudeCacheShares(engRows);
    const models = {};
    const since7 = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const readings = store.rateReadingsSince(since7);
    const readingsCodex = codexEnabled(store) ? store.rateReadingsSince(since7, 'codex') : [];
    const tokens = lastRows.reduce((n, r) => n + (r.week ? r.week.fresh + r.week.out + r.week.cacheRead : 0), 0) || 1;
    return send(res, 200, { total, tokens, agentShare: lastRows.reduce((n, r) => n + (r.week?.agentCost ?? 0), 0) / total,
      cacheShare, cacheTokenShare, top, totals, tokensEngine, models, readings, readingsCodex,
      browserHeavy: top.filter(t => t.screenshots >= 15) });
  }

  // ── repos, deploys waiting, stale memory ──
  if (a === 'repos' && method === 'POST') {
    const repos = await repoHealth(config.workspaceRoot);
    const byRepo = new Map();
    for (const r of lastRows) {
      if (r.source === 'closed') continue;
      for (const repo of new Set((r.week?.edits ?? []).map(e => repoOf(e.path, config.workspaceRoot)).filter(Boolean))) {
        byRepo.set(repo, [...(byRepo.get(repo) ?? []), { id: r.id, name: r.name }]);
      }
    }
    const built = store.projects().flatMap(p => store.checklist(p.id).filter(c => c.state === 'built').map(c => ({ id: c.id, text: c.text, project: p.name, projectId: p.id })));
    return send(res, 200, {
      repos: repos.map(r => ({ ...r, sessions: byRepo.get(r.key) ?? [] })),
      waiting: { checklist: built, memory: waitingInMemory(MEMORY_DIR) },
      staleMemory: staleMemories(MEMORY_DIR),
    });
  }

  // ── activity log for a day (what sessions changed) ──
  if (a === 'activity' && method === 'POST') {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(data.day)) ? data.day : localDay();
    return send(res, 200, { day, sessions: activityFor(day) });
  }

  // ── nightly review suggestions (changes to things you set by hand): accept or dismiss ──
  if (a === 'suggestions' && b && method === 'POST') {
    const s = liveSuggestions().find(x => x.key === b);
    if (!s) return send(res, 404, { error: 'That suggestion no longer applies.' });
    if (data.accept) {
      if (s.kind === 'state') store.updateChecklistItem(s.itemId, { state: s.to }, 'user');
      else if (s.kind === 'close') store.deleteChecklistItem(s.itemId);
      else if (s.kind === 'finish') {
        for (const sid of lastRows.filter(r => r.projectId === s.projectId && !r.done).map(r => r.id)) await finishSession(sid);
        store.updateProject(s.projectId, { archived: true }, 'user');
      }
    } else store.set('nightlyDismissed', [...store.get('nightlyDismissed', []), s.key].slice(-500));
    store.set('nightlySuggestions', store.get('nightlySuggestions', []).filter(x => x.key !== s.key));
    pushState(true);
    return send(res, 200, { ok: true });
  }

  // ── morning brief ──
  const briefRate = () => (codexEnabled(store) && defaultEngine(store) === 'codex' && store.get('rate_codex')?.unifiedWindows
    ? { rate: store.get('rate_codex'), rateEngine: 'codex' } : { rate: store.get('rate'), rateEngine: 'claude' });
  if (a === 'brief' && method === 'POST') {
    const since = store.get('lastBriefAt') ?? new Date(Date.now() - 86_400_000).toISOString();
    const finished = !config.automation ? [] : store.queue({ limit: 200 }).filter(q => q.finished_at && sqlIso(q.finished_at) >= since);
    let failedJobs = [];
    try { failedJobs = (await jobs.list()).filter(j => j.enabled && !j.ok && !j.neverRun); } catch { /* scheduler unavailable */ }
    const today = new Date(); today.setHours(23, 59, 59, 999);
    const brief = {
      since, finished,
      failedJobs,
      needsYou: lastRows.filter(r => r.needsYou && !r.needsYou.soft).map(r => ({ id: r.id, name: r.name, reason: r.needsYou.reason })),
      followupsDue: store.followups().filter(f => Date.parse(f.due_at) <= today.getTime() && f.state !== 'running'),
      waitingToGoLive: store.projects().reduce((n, p) => n + store.checklist(p.id).filter(c => c.state === 'built').length, 0),
      staleMemory: staleMemories(MEMORY_DIR).length,
      ...briefRate(),
      suggestions: liveSuggestions(),
      nightlyNotes: store.get('nightlyNotes', []),
    };
    if (data.markSeen) { store.set('lastBriefAt', new Date().toISOString()); store.set('lastBriefDay', localDay()); }
    return send(res, 200, brief);
  }

  // ── follow-ups ──
  if (a === 'followups') {
    if (!b && method === 'POST') {
      const text = String(data.text ?? '').trim().slice(0, 300);
      const due = Date.parse(data.dueAt);
      if (!text || !Number.isFinite(due)) return send(res, 400, { error: 'Say what to follow up and when.' });
      store.addFollowup({ text, dueAt: new Date(due).toISOString(), sessionId: data.sessionId ?? null, projectId: data.projectId ?? null });
      pushState(true);
      return send(res, 201, { ok: true });
    }
    if (b && method === 'PATCH') {
      store.updateFollowup(Number(b), { ...(data.done !== undefined ? { done: data.done ? 1 : 0 } : {}),
        ...(data.dueAt ? { due_at: new Date(data.dueAt).toISOString(), notified: 0 } : {}) });
      pushState(true);
      return send(res, 200, { ok: true });
    }
    if (b && method === 'DELETE') { store.deleteFollowup(Number(b)); pushState(true); return send(res, 200, { ok: true }); }
  }

  // ── templates ──
  if (a === 'templates') {
    if (!b && method === 'POST') {
      const name = String(data.name ?? '').trim().slice(0, 80);
      const prompt = String(data.prompt ?? '').trim().slice(0, 20_000);
      if (!name || !prompt) return send(res, 400, { error: 'Name the template and write the message.' });
      store.addTemplate({ name, prompt, cwd: data.cwd || null, model: data.model || null, effort: data.effort || null, permissionMode: data.permissionMode || null });
      pushState(true);
      return send(res, 201, { ok: true });
    }
    if (b && method === 'DELETE') { store.deleteTemplate(Number(b)); pushState(true); return send(res, 200, { ok: true }); }
  }

  // ── skills + model suggestion ──
  if (a === 'skills' && method === 'POST') return send(res, 200, { skills: listSkills(SKILL_DIRS) });
  if (a === 'commands' && method === 'POST') {
    const names = commandCache.byCwd[String(data.cwd ?? '').toLowerCase()] ?? commandCache.latest;
    return send(res, 200, { commands: buildCommands(names, listSkills(SKILL_DIRS)) });
  }
  if (a === 'suggest' && method === 'POST') return send(res, 200, { suggestion: suggestModel(data.text) });

  // ── set up a new Windows scheduled script (done by Claude in a chat) ──
  if (a === 'jobs' && b === 'setup' && method === 'POST') {
    const what = String(data.what ?? '').trim().slice(0, 2000);
    const engine = engineFor(store, data.engine);
    const id = runner.start({ cwd: config.workspaceRoot, name: 'New scheduled script', engine, message: `Set up a new Windows scheduled task for me${what ? `: ${what}` : ''}.

Work through this checklist with me:
1. Ask me anything you need: what it runs, when, and what should happen if it fails.
2. Check the script exists and runs by hand first (show me the output). Use the right interpreter and working folder.
3. If it needs credentials, check where they live without printing them.
4. Create the task with PowerShell's Register-ScheduledTask (not schtasks). Give it a clear name and description.
5. Do one test run with Start-ScheduledTask and check Get-ScheduledTaskInfo shows success.
6. Tell me the task name, schedule and how to switch it off. It will then appear in Pit Wall's Scheduled jobs tab.
Don't schedule anything that emails customers or changes live systems without asking me first.` });
    store.upsertSession(id, { cwd: config.workspaceRoot, display_name: 'New scheduled script', engine });
    schedulePush();
    return send(res, 201, { id });
  }

  // ── search ──
  if (a === 'search' && method === 'POST') {
    const found = await search.run(data.q);
    const meta = new Map(store.allSessionMeta().map(m => [m.session_id, m]));
    const hidden = new Set([...meta.values()].filter(m => m.hidden).map(m => m.session_id));
    found.results = found.results.filter(r => !hidden.has(r.sessionId)).map(r => ({
      ...r, name: realName(meta.get(r.sessionId)?.display_name) ?? meta.get(r.sessionId)?.auto_title ?? realName(r.title) ?? 'Untitled session', projectId: meta.get(r.sessionId)?.project_id ?? null,
      live: !!rowFor(r.sessionId) && rowFor(r.sessionId).source !== 'closed',
    }));
    return send(res, 200, found);
  }

  // ── scheduled jobs (Windows Task Scheduler) ──
  if (a === 'jobs' && !b && method === 'POST') return send(res, 200, { jobs: await jobs.list({ fresh: !!data.fresh }) });
  if (a === 'jobs' && b === 'act' && method === 'POST') {
    await jobs.act(String(data.id ?? ''), String(data.action ?? ''));
    return send(res, 200, { jobs: await jobs.list({ fresh: true }) });
  }

  // ── queue ──
  if ((a === 'queue' || a === 'roles') && !config.automation) return send(res, 404, { error: 'Queue and agents are switched off on this PC' });
  if (a === 'queue') {
    if (!b && method === 'POST') {
      const title = String(data.title ?? '').trim().slice(0, 120);
      const prompt = String(data.prompt ?? '').trim().slice(0, 20_000);
      const cwd = String(data.cwd ?? '');
      if (!title || !prompt) return send(res, 400, { error: 'Give the job a title and say what to do.' });
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return send(res, 400, { error: 'Pick a folder that exists.' });
      const engine = isEngine(data.engine) ? data.engine : null; // null = the Default engine when it starts
      if (data.model && !validModel(engineFor(store, engine), data.model, store.get('codexModels', []))) return send(res, 400, { error: 'Unknown model.' });
      const startAt = data.startAt && !Number.isNaN(Date.parse(data.startAt)) ? new Date(data.startAt).toISOString() : null;
      const id = store.addQueueItem({ title, prompt, cwd, projectId: data.projectId ? Number(data.projectId) : null, model: data.model || null, offPeak: !!data.offPeak, startAt, engine });
      queue.tick();
      schedulePush();
      return send(res, 201, { id });
    }
    if (b === 'toggle' && method === 'POST') { store.set('queueEnabled', !!data.enabled); queue.tick(); pushState(true); return send(res, 200, { ok: true }); }
    if (b && c === 'cancel' && method === 'POST') {
      queue.cancel(Number(b));
      // You cancelled it: its scheduled-check follow-up is done, not "missed".
      for (const f of store.followups().filter(f => f.queue_id === Number(b))) store.updateFollowup(f.id, { done: 1 });
      pushState(true);
      return send(res, 200, { ok: true });
    }
    if (b && c === 'retry' && method === 'POST') {
      const job = store.queueItem(Number(b));
      if (!job) return send(res, 404, { error: 'No such job.' });
      store.addQueueItem({ title: job.title, prompt: job.prompt, cwd: job.cwd, projectId: job.project_id, model: job.model, roleId: job.role_id, engine: job.engine });
      queue.tick();
      schedulePush();
      return send(res, 201, { ok: true });
    }
  }

  // ── role agents ──
  if (a === 'roles') {
    const clean = d => {
      const engine = isEngine(d.engine) ? d.engine : null; // null = the Default engine when it runs
      return {
      name: String(d.name ?? '').trim().slice(0, 60), goal: String(d.goal ?? '').trim().slice(0, 4000),
      instructions: String(d.instructions ?? '').trim().slice(0, 8000), cwd: String(d.cwd ?? ''),
      project_id: d.projectId ? Number(d.projectId) : null, every_hours: Math.min(Math.max(Number(d.everyHours) || 24, 1), 24 * 30),
      schedule_kind: ['interval', 'minutes', 'once', 'daily', 'weekdays', 'weekly'].includes(d.scheduleKind) ? d.scheduleKind : 'interval',
      every_minutes: Math.min(Math.max(Math.round(Number(d.everyMinutes) || 30), 5), 24 * 60),
      run_at: d.runAt && !Number.isNaN(Date.parse(d.runAt)) ? new Date(d.runAt).toISOString() : null,
      schedule_days: Math.max(0, Math.min(127, Number(d.scheduleDays) || 0)),
      schedule_time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(d.scheduleTime)) ? d.scheduleTime : '08:00',
      skill: d.skill ? String(d.skill).replace(/[^\w:.-]/g, '').slice(0, 80) || null : null,
      model: d.model && validModel(engineFor(store, engine), d.model, store.get('codexModels', [])) ? d.model : null,
      engine,
    }; };
    if (!b && method === 'POST') {
      const r = clean(data);
      if (!r.name || !r.goal) return send(res, 400, { error: 'Name the agent and give it a goal.' });
      const skillProblem = workspaceSkillOutside(r.skill, r.cwd);
      if (skillProblem) return send(res, 400, { error: skillProblem });
      if (!fs.existsSync(r.cwd)) return send(res, 400, { error: 'Pick a folder that exists.' });
      const id = store.addRole({ name: r.name, goal: r.goal, instructions: r.instructions, cwd: r.cwd, projectId: r.project_id, everyHours: r.every_hours,
        scheduleKind: r.schedule_kind, scheduleDays: r.schedule_days, scheduleTime: r.schedule_time, skill: r.skill, model: r.model,
        everyMinutes: r.every_minutes, runAt: r.run_at, engine: r.engine });
      schedulePush();
      return send(res, 201, { id });
    }
    const role = store.role(Number(b));
    if (!role) return send(res, 404, { error: 'No such agent.' });
    if (!c && method === 'PATCH') {
      const fields = {};
      if ('enabled' in data) fields.enabled = data.enabled ? 1 : 0;
      for (const [k, v] of Object.entries(clean({ ...role, projectId: role.project_id, everyHours: role.every_hours,
        scheduleKind: role.schedule_kind, scheduleDays: role.schedule_days, scheduleTime: role.schedule_time,
        everyMinutes: role.every_minutes, runAt: role.run_at, ...data }))) {
        // With Codex off a GPT model no longer validates: an unrelated edit, or the Claude-only form's blank model, must not
        // wipe it (see keepStoredModel). The queue picks a Claude model at run time.
        if (k === 'model' && keepStoredModel(role, data, codexEnabled(store))) continue;
        if (k !== 'cwd' || fs.existsSync(v)) fields[k] = v;
      }
      const skillProblem = workspaceSkillOutside(fields.skill ?? role.skill, fields.cwd ?? role.cwd);
      if (skillProblem) return send(res, 400, { error: skillProblem });
      store.updateRole(role.id, fields);
      queue.tick();
      pushState(true);
      return send(res, 200, { ok: true });
    }
    if (!c && method === 'DELETE') { store.deleteRole(role.id); pushState(true); return send(res, 200, { ok: true }); }
    if (c === 'run' && method === 'POST') { queue.enqueueRole(role); queue.tick(); pushState(true); return send(res, 200, { ok: true }); }
  }

  if (a === 'viewing' && method === 'POST') {
    notifier.setViewing(data.sessionId ? String(data.sessionId) : null, !!data.visible);
    return send(res, 200, { ok: true });
  }

  if (a === 'settings' && method === 'POST') {
    if ('notify' in data) store.set('notify', !!data.notify);
    if (typeof data.groupByProject === 'boolean') store.set('groupByProject', data.groupByProject);
    if ('defaultEngine' in data && isEngine(data.defaultEngine)) store.set('defaultEngine', data.defaultEngine);
    if (data.testNotification) {
      const ok = await showToast({ title: 'Pit Wall', body: 'Notifications are on — this is what they look like.', url: `http://127.0.0.1:${config.port}/` });
      if (!ok) return send(res, 500, { error: 'Windows would not show the notification. Check Focus assist / Do not disturb.' });
    }
    pushState(true);
    return send(res, 200, { ok: true });
  }

  if (a === 'organise' && method === 'POST') {
    const result = await organiser.maybeRun(lastRows, { force: true });
    pushState(true);
    return send(res, 200, result);
  }

  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    req.pw = await classify(req, ALLOWED_HOSTS, loadRemote(config.dataDir), accessKeys);
    if (!req.pw.ok) return send(res, 421, 'Wrong host');
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith('/api/')) {
      if (!tokenOk(req)) return send(res, 401, { error: 'Reload Pit Wall — the server restarted.' });
      return await api(req, res, url);
    }
    const s = STATIC[url.pathname];
    if (req.method !== 'GET' || !s) return send(res, 404, 'Not found');
    const headers = { 'Content-Type': s[1], 'Content-Security-Policy': CSP };
    if (url.pathname === '/') headers['Set-Cookie'] = `pw=${TOKEN}; HttpOnly; SameSite=Strict; Path=/${req.pw.remote ? '; Secure' : ''}`;
    return send(res, 200, fs.readFileSync(path.join(PUBLIC, s[0])), headers);
  } catch (e) {
    const status = e.status ?? 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e.message });
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log(`${new Date().toISOString()} Pit Wall is already running on port ${config.port} — nothing to do.`);
    process.exit(0);
  }
  throw e;
});

// Only once the port is ours (a second copy exits above without touching anything) are running chats picked up
// from their relays. The API answers 503 until then, so nothing can start a second claude on a chat still running.
let ready = !USE_RELAYS;
server.listen(config.port, config.host, async () => {
  await (USE_RELAYS ? adoptRelays() : Promise.resolve()).catch(e => console.log(`relay pickup failed: ${e.message}`));
  ready = true;
  console.log(`${new Date().toISOString()} Pit Wall is up: http://${config.host}:${config.port}`);
  console.log(`Claude Code: ${config.claudeExe}${USE_RELAYS ? ' (chats run under relays and survive restarts)' : ''}`);
  // restart.ps1 reads this: a server that writes it keeps chats running through a restart, so there's no need to wait.
  if (USE_RELAYS) { fs.mkdirSync(paths.relaysDir, { recursive: true }); fs.writeFileSync(path.join(paths.relaysDir, 'supported.txt'), String(process.pid)); }
  // One notification after a restart if anything was cut off mid-step (chats still running under relays weren't).
  const cut = store.interruptedSessions().filter(m => !m.hidden && !runner.get(m.session_id)?.proc);
  if (cut.length && store.get('notify', true)) {
    showToast({ title: 'Pit Wall restarted', body: `${cut.length} session${cut.length === 1 ? ' was' : 's were'} cut off mid-step — open Pit Wall and press Continue.`,
      url: cut.length === 1 ? `http://127.0.0.1:${config.port}/?s=${encodeURIComponent(cut[0].session_id)}` : `http://127.0.0.1:${config.port}/` });
  }
});

async function shutdown() {
  console.log(USE_RELAYS ? 'Pit Wall shutting down — chats keep running under their relays.' : 'Pit Wall shutting down — stopping its sessions (they can be resumed).');
  await Promise.all([runner.shutdown(), organiser.stop()]);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
