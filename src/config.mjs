import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findCodex, CODEX_HELPER_MODELS, setCodexDefault } from './engines.mjs';
import { SITE, DEFAULT_ABOUT } from './site.mjs';

const HOME = os.homedir();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findClaude() {
  if (process.env.PITWALL_CLAUDE_EXE) return process.env.PITWALL_CLAUDE_EXE;
  const candidates = [
    path.join(HOME, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
  ];
  return candidates.find(p => fs.existsSync(p)) ?? 'claude';
}

const DATA_DIR = process.env.PITWALL_DATA_DIR ?? path.join(ROOT, 'data');

/** This PC's own settings (git-ignored): data/local.json, e.g. { "workspace": "C:\\laragon\\www", "folders": ["D:\\Other"] } (JSON, so backslashes doubled). */
function localSettings() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'local.json'), 'utf8').replace(/^﻿/, '')); } catch { return {}; }
}
const LOCAL = localSettings();

export { DEFAULT_ABOUT };

/** Who this Pit Wall belongs to: data/local.json name/about/automation, else site.json's owner, else the Windows user. */
export function userSettings(local, env, site = {}) {
  const custom = String(env.PITWALL_USER_NAME ?? local.name ?? '').trim();
  const owner = String(site.owner ?? '').trim();
  const teamAbout = site.company ? `works at ${site.company}.` : DEFAULT_ABOUT;
  const about = local.about ? String(local.about).trim() : custom ? teamAbout : site.about ?? DEFAULT_ABOUT;
  const automation = env.PITWALL_AUTOMATION != null ? env.PITWALL_AUTOMATION !== '0' : local.automation !== false;
  const name = custom || owner || String(env.USERNAME ?? env.USER ?? '').trim() || 'User';
  return { name, their: !custom && owner ? site.ownerTheir ?? 'their' : 'their', about, automation };
}
const USER = userSettings(LOCAL, process.env, SITE);

/** Codex (GPT) is opt-in: data/local.json "codexEnabled": true, or PITWALL_CODEX=1/0. The page's switch (kv) overrides both. */
export function codexDefaultFrom(local, env) {
  if (env.PITWALL_CODEX != null) return env.PITWALL_CODEX === '1';
  return local.codexEnabled === true;
}

// Codex's exe, found again on every read until it exists (so installing it from the page works without a restart).
let codexExeFound = null;
/** After an install or update: forget the old answer and look again. */
export function refreshCodexExe() { codexExeFound = findCodex(process.env, HOME); return codexExeFound; }

export const config = {
  root: ROOT,
  host: '127.0.0.1',
  port: Number(process.env.PITWALL_PORT ?? 4040),
  claudeHome: process.env.PITWALL_CLAUDE_HOME ?? path.join(HOME, '.claude'),
  claudeExe: findClaude(),
  get codexExe() { return codexExeFound ??= findCodex(process.env, HOME); },
  // Whether Codex is on before anyone touches the switch in More › Codex (GPT)… (off unless local.json says so).
  codexDefault: codexDefaultFrom(LOCAL, process.env),
  // GPT models for Pit Wall's helper calls when Codex is the default engine. data/local.json "codex": {...} overrides.
  codex: { ...CODEX_HELPER_MODELS, ...(LOCAL.codex ?? {}) },
  dataDir: DATA_DIR,
  // Whose Pit Wall this is (prompts and page), and whether the Queue and Agents exist on this PC. data/local.json.
  user: { name: USER.name, their: USER.their, about: USER.about },
  automation: USER.automation,
  // Weekly roundup (Thursdays) to roundupTo — data/local.json, else site.json. Without a recipient there is no roundup.
  // On by default for team installs (local.json has a name), off on the owner's own PC. The Automation tab's switch overrides this.
  roundup: {
    to: LOCAL.roundupTo ?? SITE.roundupTo ?? null,
    // How the page names the recipient ("Send to Sam"), and how the writing prompt describes them.
    toName: LOCAL.roundupToName ?? SITE.roundupToName ?? null,
    toLabel: LOCAL.roundupToLabel ?? SITE.roundupToLabel ?? null,
    // Sent by itself from the person's Gmail (their Claude's Gmail connector); local.json "roundupAutoSend": false to review first.
    autoSend: LOCAL.roundupAutoSend !== false,
    defaultOn: process.env.PITWALL_ROUNDUP != null ? process.env.PITWALL_ROUNDUP !== '0' : LOCAL.roundup ?? !!LOCAL.name,
  },
  // Folders offered when starting a new session: the workspace and its git subfolders, plus any extra folders
  // (outside the workspace or without a .git). Set per PC in data/local.json, or PITWALL_WORKSPACE / PITWALL_FOLDERS (';'-separated).
  workspaceRoot: process.env.PITWALL_WORKSPACE ?? LOCAL.workspace ?? path.join(HOME, 'Documents', 'GitHub'),
  extraFolders: process.env.PITWALL_FOLDERS != null
    ? process.env.PITWALL_FOLDERS.split(';').map(s => s.trim()).filter(Boolean)
    : (Array.isArray(LOCAL.folders) ? LOCAL.folders : []),
  recentDays: 14,
  // Chats Pit Wall keeps running at once (each claude process is ~300 MB). When all are in use, a new one parks the
  // oldest idle chat (it stays on the board and resumes on your next message). data/local.json "maxRunning" overrides.
  maxRunning: Number(process.env.PITWALL_MAX_RUNNING ?? LOCAL.maxRunning ?? 16),
  // Your terminals run at medium effort (CLAUDE_EFFORT=medium); headless sessions need it passed.
  defaultEffort: process.env.PITWALL_EFFORT ?? 'medium',
  // Headless Claude Code ignores settings.json defaultMode, so Pit Wall passes it explicitly.
  // (Auto needs a model that supports it — on Haiku Claude Code falls back to asking.)
  defaultPermissionMode: process.env.PITWALL_PERMISSION_MODE ?? 'auto',
  // null = never park an idle chat: it runs until you Finish it, or until every maxRunning slot is in use and a new chat needs one.
  // Parking used to happen after 20 idle minutes, which silently killed anything the chat had scheduled (CronCreate).
  idleParkMinutes: null,
  // Background queue: one job at a time, only while usage is comfortably low.
  queue: {
    dailyJobCap: 10,
    fiveHourMax: 0.6,   // don't start a job at or above 60% of the 5-hour limit
    weekMax: 0.8,       // …or 80% of the weekly limit
    maxAgeMin: 30,      // a usage reading older than this is refreshed before starting a job
    defaultModel: 'sonnet', // background jobs and agents unless you pick another
  },
  // Context size (tokens Claude re-reads every turn) at which a session is flagged.
  context: { warn: 300_000, high: 600_000, coldMinutes: 60 },
  dangerRulesNote: 'Danger badges: src/insights.mjs DANGER_RULES',
  // Cheap Haiku call used only to refresh the usage gauge while the page is open and the reading is stale.
  usageProbe: { staleMin: 30, dailyCap: 40 },
  backups: { keep: 7 },
  organiser: {
    model: 'haiku',
    dailyCallCap: 40,
    refileAfterMs: 3_600_000, // re-file an already-filed session at most once per hour of activity
    debounceMs: 90_000,
    batchSize: 10,
  },
};

setCodexDefault(config.codexDefault);

export const paths = {
  sessionsDir: path.join(config.claudeHome, 'sessions'),
  projectsDir: path.join(config.claudeHome, 'projects'),
  db: path.join(config.dataDir, 'pitwall.db'),
  organiserCwd: path.join(config.dataDir, 'organiser'),
  hookStatusDir: path.join(config.claudeHome, 'pitwall-status'),
  backupsDir: path.join(config.dataDir, 'backups'),
  // One relay per running chat (src/relay.mjs), so chats outlive a server restart.
  relaysDir: path.join(config.dataDir, 'relays'),
  // Codex chats (src/codex-bridge.mjs): Claude-shaped transcripts + Pit Wall id → Codex thread id. Never under ~/.claude.
  codexDir: path.join(config.dataDir, 'codex'),
  codexProjectsDir: path.join(config.dataDir, 'codex', 'projects'),
  codexThreadsDir: path.join(config.dataDir, 'codex', 'threads'),
};

/** Mirrors Claude Code's "Claude in Chrome on by default" setting (terminals get it automatically, headless needs --chrome). */
export function chromeEnabled() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
    return j.claudeInChromeDefaultEnabled === true;
  } catch { return false; }
}

/** Claude Code's project-folder slug for a cwd (every non-alphanumeric char becomes '-'). */
export function slugForCwd(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** Transcript folders that must never show on the board (Pit Wall's own organiser, temp scratch). */
export function isExcludedProjectDir(dirName) {
  if (dirName === slugForCwd(paths.organiserCwd)) return true;
  return /-AppData-Local-Temp-/i.test(dirName);
}
