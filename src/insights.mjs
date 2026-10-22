// Insights from transcripts and the workspace: how much each session costs, what it changed,
// what looks dangerous, which model fits, when schedules are due, how fast usage is burning.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { siteDangerRules } from './site.mjs';

function readRange(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function linesOf(text, dropFirst) {
  const out = [];
  const parts = text.split('\n');
  if (dropFirst) parts.shift();
  for (const l of parts) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* partial */ } }
  return out;
}

const GIT_COMMIT = /\bgit\b[^|;&]*\bcommit\b/;
const DEPLOY = /deploy\.sh|wrangler deploy|shopify theme push|git push/;

/** A transcript's entries since `sinceIso`, reading a growing tail only as far back as needed. */
function entriesSince(file, size, sinceIso) {
  let len = Math.min(size, 4 * 1024 * 1024);
  for (;;) {
    const start = size - len;
    const entries = linesOf(readRange(file, start, len), start > 0);
    const firstTs = entries.find(e => e.timestamp)?.timestamp;
    if (start > 0 && firstTs && firstTs >= sinceIso && len < size) { len = Math.min(size, len * 2); continue; }
    return entries;
  }
}

/**
 * Transcripts of a session's agents: <session>/subagents/agent-*.jsonl, and workflow agents in
 * <session>/subagents/workflows/<run>/agent-*.jsonl. Their turns are not in the main transcript.
 */
export function agentTranscripts(file) {
  const out = [];
  const walk = d => {
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/^agent-.*\.jsonl$/.test(e.name)) out.push(full);
    }
  };
  walk(path.join(file.replace(/\.jsonl$/, ''), 'subagents'));
  return out;
}

/**
 * What a session did since `sinceIso`, its agents and workflows included: token usage (deduplicated per API
 * message), last context size (main conversation only), files edited, commits, deploy-ish commands, Chrome
 * screenshots, and whether vault notes were touched. `agentCost` / `agentTurns` are the agents' part.
 */
export function analyseTranscript(file, sinceIso, untilIso = null) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const empty = { fresh: 0, out: 0, cacheRead: 0, cost: 0, cacheReadCost: 0, agentCost: 0, turns: 0, agentTurns: 0, context: 0, edits: [], commits: 0, deploys: [], screenshots: 0, vaultEdited: false, first: null, last: null };
  if (stat.mtimeMs < Date.parse(sinceIso)) return empty;
  const r = { ...empty, edits: [], deploys: [] };
  const seen = new Set(); // shared by the main and agent files, so one API message is never counted twice
  const edited = new Map();
  const take = (entries, agent) => { for (const e of entries) {
    if (!e.timestamp || e.timestamp < sinceIso || (untilIso && e.timestamp >= untilIso) || e.type !== 'assistant') continue;
    if (!agent) { r.first ??= e.timestamp; r.last = e.timestamp; }
    for (const b of e.message?.content ?? []) {
      if (b?.type !== 'tool_use') continue;
      const inp = b.input ?? {};
      if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(b.name) && inp.file_path) {
        edited.set(inp.file_path, e.timestamp);
        if (/[\\/]vault[\\/]/i.test(inp.file_path)) r.vaultEdited = true;
      }
      if ((b.name === 'Bash' || b.name === 'PowerShell') && typeof inp.command === 'string') {
        if (GIT_COMMIT.test(inp.command)) r.commits++;
        if (DEPLOY.test(inp.command)) r.deploys.push(inp.command.split(/\r?\n/)[0].slice(0, 120));
      }
      if (b.name === 'mcp__claude-in-chrome__computer' && inp.action === 'screenshot') r.screenshots++;
      if (b.name === 'mcp__claude-in-chrome__browser_batch') r.screenshots += (inp.actions ?? []).filter(a => a?.input?.action === 'screenshot').length;
    }
    const id = e.message?.id;
    const u = e.message?.usage;
    if (!u || (id && seen.has(id))) continue;
    if (id) seen.add(id);
    const cost = turnCost(u, e.message?.model);
    if (agent) { r.agentTurns++; r.agentCost += cost; } else r.turns++;
    r.fresh += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    r.out += u.output_tokens ?? 0;
    r.cacheRead += u.cache_read_input_tokens ?? 0;
    r.cost += cost;
    r.cacheReadCost += (u.cache_read_input_tokens ?? 0) * cacheReadRatio(e.message?.model);
    if (!agent && !e.isSidechain) r.context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  } };
  take(entriesSince(file, stat.size, sinceIso), false);
  for (const f of agentTranscripts(file)) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs >= Date.parse(sinceIso)) take(entriesSince(f, st.size, sinceIso), true);
  }
  r.edits = [...edited].map(([p, at]) => ({ path: p, at }));
  return r;
}

/**
 * Estimated cost of what Claude processed, in "new-input-token equivalents" at API list-price ratios:
 * output 5×, cache write 1.25× (5-min) / 2× (1-hour), cache read 0.05× on Opus 5.5 (0.025× Fable, 0.1× others).
 * Subscription limits aren't published per token type, so this is an estimate — but far closer than
 * counting a re-read token the same as a written one. This is what the "share" figures are based on.
 */
export const processed = a => (a ? a.cost ?? (a.fresh + a.out + a.cacheRead) : 0);

export function cacheReadRatio(model = '') {
  if (/opus-5-5/.test(model)) return 0.05;
  if (/fable|mythos/.test(model)) return 0.025;
  return 0.1;
}

export function turnCost(u, model) {
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens;
  const w1 = u.cache_creation?.ephemeral_1h_input_tokens;
  const writes = w5 != null || w1 != null ? (w5 ?? 0) * 1.25 + (w1 ?? 0) * 2 : (u.cache_creation_input_tokens ?? 0) * 2;
  return (u.input_tokens ?? 0) + writes + (u.output_tokens ?? 0) * 5 + (u.cache_read_input_tokens ?? 0) * cacheReadRatio(model); // ratios are model-agnostic: an unknown (GPT) model never yields NaN
}

/** Which repo (folder directly under the workspace root, or the root itself) a path belongs to. */
export function repoOf(p, workspaceRoot) {
  if (!p) return null;
  const norm = s => s.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const root = norm(workspaceRoot);
  const f = norm(p);
  if (!f.startsWith(root)) return null;
  const rest = f.slice(root.length).replace(/^\\/, '');
  const first = rest.split('\\')[0];
  if (!first || !rest.includes('\\')) return path.basename(workspaceRoot);
  return fs.existsSync(path.join(workspaceRoot, first, '.git')) ? first : path.basename(workspaceRoot);
}

// ── danger badges ─────────────────────────────────────────────────────────
/** Patterns for approvals that touch something live. Each: [label, regex tested against the tool name + input].
 *  site.json "dangerRules" adds your own servers, hosts and APIs ahead of these. */
export const DANGER_RULES = [
  ...siteDangerRules(),
  ['SSH / remote shell', /\b(ssh|scp|rsync)\s/i],
  ['Deploy', /deploy\.sh|wrangler\s+deploy|shopify\s+theme\s+(push|publish)|--publish/i],
  ['Remote D1 database', /wrangler\s+d1\s+execute(?![^"']*--local)/i],
  ['Push to git', /\bgit\s+push\b/i],
  ['Sends email / message', /Gmail__(send_message|reply|forward)|send_?email|sendmail|marketing:send/i],
  ['Deletes data', /\b(drop\s+table|truncate\s|delete\s+from|rm\s+-rf|Remove-Item\b.*-Recurse)/i],
];

export function dangerBadges(toolName, input) {
  // Only what actually runs or goes out: shell commands, the tool's own name (MCP tools like Gmail send),
  // and URLs being fetched. File edits are left alone, so everyday edits to API-client or migration code
  // don't turn red and teach you to ignore the badges.
  const inp = typeof input === 'object' && input ? input : {};
  const parts = [toolName];
  if (typeof inp.command === 'string') parts.push(inp.command);
  if (typeof inp.url === 'string') parts.push(inp.url, inp.method ?? '');
  if (/^mcp__/.test(toolName)) parts.push(JSON.stringify(inp).slice(0, 2000));
  const text = parts.join(' ');
  return DANGER_RULES.filter(([, re]) => re.test(text)).map(([label]) => label);
}

// ── model suggestion ──────────────────────────────────────────────────────
const HEAVY = /\b(fix|bug|refactor|implement|build|migrat|debug|laravel|php|worker|deploy|schema|architect|design|test|investigat|why)\w*/i;
const LIGHT = /\b(summar|draft|write (an?|the) (email|reply|copy|post)|copy|rewrite|translate|list|report|check|look up|lookup|find|count|headline|description|meta|proofread)\w*/i;

/** A gentle suggestion only — you always choose. */
export function suggestModel(prompt) {
  const t = String(prompt ?? '');
  if (t.trim().length < 8) return null;
  const heavy = HEAVY.test(t);
  const light = LIGHT.test(t);
  if (light && !heavy) return { model: 'sonnet', why: 'Looks like writing, a report or a lookup — Sonnet handles that well and uses less of your limit than Opus.' };
  if (heavy) return { model: '', why: 'Looks like code or investigation — your usual model (Opus) is the right fit.' };
  return null;
}

// ── schedules ─────────────────────────────────────────────────────────────
/** When a role next runs, given its schedule and last run. Local time. */
export function nextDue(role, now = new Date()) {
  if (role.schedule_kind === 'minutes') {
    if (!role.last_run_at) return now;
    return new Date(Date.parse(role.last_run_at) + Math.max(5, role.every_minutes || 5) * 60_000);
  }
  if (role.schedule_kind === 'once') {
    if (!role.run_at) return null;
    // Once only: done when it has run at or after its time.
    return role.last_run_at && Date.parse(role.last_run_at) >= Date.parse(role.run_at) - 60_000 ? null : new Date(role.run_at);
  }
  if ((role.schedule_kind ?? 'interval') === 'interval') {
    if (!role.last_run_at) return now;
    return new Date(Date.parse(role.last_run_at) + role.every_hours * 3_600_000);
  }
  const [hh, mm] = String(role.schedule_time ?? '08:00').split(':').map(Number);
  const last = role.last_run_at ? new Date(role.last_run_at) : null;
  const ok = d => role.schedule_kind === 'daily' || (role.schedule_kind === 'weekdays' ? d.getDay() >= 1 && d.getDay() <= 5 : (role.schedule_days & (1 << d.getDay())) !== 0);
  // Look at today and the next 8 days for the first slot after the last run.
  for (let i = -1; i < 9; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, hh, mm, 0, 0);
    if (!ok(d)) continue;
    if (last && d <= last) continue;
    if (!last && d < new Date(now.getTime() - 60_000) && i <= 0) continue; // don't fire a slot that passed before the agent existed
    return d;
  }
  return null;
}

export function describeSchedule(role) {
  const kind = role.schedule_kind ?? 'interval';
  const at = iso => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  if (kind === 'minutes') return `Every ${Math.max(5, role.every_minutes || 5)} min`;
  if (kind === 'once') return !role.run_at ? 'Once (no time set)' : nextDue(role) ? `Once at ${at(role.run_at)}` : `Ran once (${at(role.run_at)})`;
  if (kind === 'interval') return `Every ${role.every_hours} h`;
  if (kind === 'daily') return `Daily at ${role.schedule_time}`;
  if (kind === 'weekdays') return `Weekdays at ${role.schedule_time}`;
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].filter((_, i) => role.schedule_days & (1 << i));
  return `${names.join(', ') || 'No days picked'} at ${role.schedule_time}`;
}

/** What each engine processed this week, from rows carrying { engine, week } (anything not 'codex' counts as Claude). */
export function weekByEngine(rows) {
  const t = { claude: 0, codex: 0 };
  for (const r of rows) t[r.engine === 'codex' ? 'codex' : 'claude'] += processed(r.week);
  return t;
}

/** Raw tokens (fresh + written + re-read, the unit of `u.tokens`) per engine, from rows carrying { engine, week }. */
export function tokensByEngine(rows) {
  const t = { claude: 0, codex: 0 };
  for (const r of rows) if (r.week) t[r.engine === 'codex' ? 'codex' : 'claude'] += r.week.fresh + r.week.out + r.week.cacheRead;
  return t;
}

/** Re-read shares for the "Claude re-reads" tip: Claude rows only, so GPT never feeds it. */
export function claudeCacheShares(rows) {
  const cl = rows.filter(r => r.engine !== 'codex');
  const cost = cl.reduce((n, r) => n + processed(r.week), 0) || 1;
  const tokens = cl.reduce((n, r) => n + (r.week ? r.week.fresh + r.week.out + r.week.cacheRead : 0), 0) || 1;
  return { cacheShare: cl.reduce((n, r) => n + (r.week?.cacheReadCost ?? 0), 0) / cost,
    cacheTokenShare: cl.reduce((n, r) => n + (r.week?.cacheRead ?? 0), 0) / tokens };
}

/**
 * Week shares that keep GPT out of Claude's bars: a session's share is of its own engine's total; project shares are
 * the default engine's picture only (rows of the other engine add nothing). Rows: { id, projectId, engine, week }.
 */
export function weekShares(rows, shareEngine = 'claude') {
  const totals = weekByEngine(rows), tot = e => totals[e] || 1;
  const eng = r => (r.engine === 'codex' ? 'codex' : 'claude');
  const session = new Map(rows.map(r => [r.id, processed(r.week) / tot(eng(r))]));
  const project = new Map();
  for (const r of rows) if (r.projectId && eng(r) === shareEngine) project.set(r.projectId, (project.get(r.projectId) ?? 0) + processed(r.week) / tot(shareEngine));
  return { session, project };
}

/** The Usage tab's heaviest sessions: a row's share is of its own engine's total, so GPT tokens don't distort Claude's. */
export function usageTop(rows, now = Date.now(), limit = 15) {
  const totals = weekByEngine(rows);
  const top = [...rows].filter(r => processed(r.week) > 0).sort((x, y) => processed(y.week) - processed(x.week)).slice(0, limit).map(r => {
    const engine = r.engine === 'codex' ? 'codex' : 'claude';
    return { id: r.id, name: r.name, projectId: r.projectId, source: r.source, context: r.context, engine, share: processed(r.week) / (totals[engine] || 1),
      cacheRead: r.week.cacheRead, fresh: r.week.fresh, out: r.week.out, turns: r.week.turns, screenshots: r.week.screenshots,
      agentShare: (r.week.agentCost ?? 0) / (processed(r.week) || 1), agentTurns: r.week.agentTurns ?? 0,
      idleMin: r.lastActivity ? Math.round((now - Date.parse(r.lastActivity)) / 60_000) : null };
  });
  return { totals, top };
}

// ── burn rate ─────────────────────────────────────────────────────────────
/**
 * From recent 5-hour readings in the current window: percentage points per hour, and when the
 * window would be used up at that pace (only if before it resets).
 */
export function burnRate(readings, now = Date.now()) {
  const inWindow = readings.filter(r => r.five != null && now - Date.parse(r.at) < 90 * 60_000);
  if (inWindow.length < 2) return null;
  const a = inWindow[0], b = inWindow[inWindow.length - 1];
  if (a.five_resets_at && b.five_resets_at && a.five_resets_at !== b.five_resets_at) return null; // window rolled over
  const hours = (Date.parse(b.at) - Date.parse(a.at)) / 3_600_000;
  if (hours < 0.1) return null;
  const perHour = (b.five - a.five) / hours;
  if (perHour <= 0) return { perHour: 0, fullAt: null };
  const fullAt = new Date(now + ((1 - b.five) / perHour) * 3_600_000);
  const resets = b.five_resets_at ? new Date(b.five_resets_at * 1000) : null;
  return { perHour, fullAt: resets && fullAt > resets ? null : fullAt.toISOString(), resetsAt: resets?.toISOString() ?? null };
}

// ── memory staleness ──────────────────────────────────────────────────────
const STALE_WORDS = /not deployed|NOT deployed|pushed, not|uncommitted|not merged|not live|NOT live|on a branch/;

/** Memory entries that still say "not deployed / not merged…" but haven't been touched for 14+ days. */
export function staleMemories(memoryDir, now = Date.now(), days = 14) {
  let index;
  try { index = fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of index.split('\n')) {
    const m = /^- \[([^\]]+)\]\(([^)]+\.md)\)\s*[—-]\s*(.*)$/.exec(line.trim());
    if (!m || !STALE_WORDS.test(m[3])) continue;
    let mtime;
    try { mtime = fs.statSync(path.join(memoryDir, m[2])).mtimeMs; } catch { continue; }
    const age = (now - mtime) / 86_400_000;
    if (age >= days) out.push({ title: m[1], file: m[2], note: m[3].slice(0, 200), ageDays: Math.round(age) });
  }
  return out.sort((a, b) => b.ageDays - a.ageDays);
}

/** Memory lines that say something is waiting to go live (for the deploy tracker). */
export function waitingInMemory(memoryDir) {
  let index;
  try { index = fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8'); } catch { return []; }
  return index.split('\n')
    .map(l => /^- \[([^\]]+)\]\(([^)]+\.md)\)\s*[—-]\s*(.*)$/.exec(l.trim()))
    .filter(m => m && /not deployed|NOT deployed|pushed,? not|not live|NOT live|not merged/i.test(m[3]))
    .map(m => ({ title: m[1], file: m[2], note: m[3].slice(0, 220) }));
}

// ── repo health ───────────────────────────────────────────────────────────
function git(cwd, args, timeout = 15_000) {
  return new Promise(resolve => execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout) => resolve(err ? null : stdout)));
}

/** Parse `git status --porcelain=v1 -b`. */
export function parseStatus(out) {
  const lines = out.split('\n').filter(Boolean);
  const head = lines[0] ?? '';
  const m = /^## (No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.*)\])?/.exec(head);
  const counts = m?.[4] ?? '';
  const ahead = Number(/ahead (\d+)/.exec(counts)?.[1] ?? 0);
  const behind = Number(/behind (\d+)/.exec(counts)?.[1] ?? 0);
  const files = lines.slice(1);
  return {
    branch: m?.[2] ?? '?', upstream: m?.[3] ?? null, ahead, behind,
    changed: files.filter(f => !f.startsWith('??')).length, untracked: files.filter(f => f.startsWith('??')).length,
  };
}

export async function repoHealth(workspaceRoot) {
  const dirs = [workspaceRoot];
  try {
    for (const d of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
      if (d.isDirectory() && fs.existsSync(path.join(workspaceRoot, d.name, '.git'))) dirs.push(path.join(workspaceRoot, d.name));
    }
  } catch { /* missing root */ }
  const out = [];
  // A few at a time — git on 20 repos at once is slow on Windows.
  for (let i = 0; i < dirs.length; i += 5) {
    out.push(...await Promise.all(dirs.slice(i, i + 5).map(async dir => {
      const [status, last, unpushed] = await Promise.all([
        git(dir, ['status', '--porcelain=v1', '-b']),
        git(dir, ['log', '-1', '--format=%cI%x09%s']),
        git(dir, ['log', '@{u}..', '--format=%h%x09%s', '-n', '15']),
      ]);
      if (status == null) return { name: path.basename(dir), dir, error: 'Could not read git status' };
      const [lastAt, lastMsg] = (last ?? '').trim().split('\t');
      return {
        name: dir === workspaceRoot ? `${path.basename(dir)} (root)` : path.basename(dir), dir, key: dir === workspaceRoot ? path.basename(dir) : path.basename(dir),
        ...parseStatus(status), lastCommitAt: lastAt || null, lastCommit: lastMsg || null,
        unpushed: (unpushed ?? '').trim().split('\n').filter(Boolean).map(l => { const [h, ...s] = l.split('\t'); return { hash: h, subject: s.join('\t') }; }),
      };
    })));
  }
  return out;
}

/** Sessions that edited files in the same repo within the last `hours` while both still open. */
export function clashes(sessionEdits, workspaceRoot, { hours = 2, now = Date.now() } = {}) {
  const byRepo = new Map();
  for (const { sessionId, edits, live } of sessionEdits) {
    if (!live) continue;
    // The workspace root itself is left out: every session writes vault notes and docs there, so it would always "clash".
    const rootName = path.basename(workspaceRoot);
    const repos = new Set(edits.filter(e => now - Date.parse(e.at) < hours * 3_600_000).map(e => repoOf(e.path, workspaceRoot)).filter(r => r && r !== rootName));
    for (const r of repos) byRepo.set(r, [...(byRepo.get(r) ?? []), sessionId]);
  }
  return [...byRepo].filter(([, ids]) => ids.length > 1).map(([repo, sessions]) => ({ repo, sessions }));
}

/** The handoff between <handoff> tags (or the whole reply if the tags were left out). */
export function extractHandoff(text) {
  const m = /<handoff>([\s\S]*?)<\/handoff>/i.exec(text ?? '');
  return (m ? m[1] : text ?? '').trim();
}

// ── skills ────────────────────────────────────────────────────────────────
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Skills you can launch: user skills (~/.claude/skills) and the workspace's own (.claude/skills). */
export function listSkills(dirs) {
  const out = [];
  for (const { dir, scope } of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { continue; }
    for (const n of names) {
      try {
        const fm = frontmatter(fs.readFileSync(path.join(dir, n, 'SKILL.md'), 'utf8'));
        out.push({ name: fm.name || n, description: (fm.description || '').slice(0, 300), scope });
      } catch { /* not a skill */ }
    }
  }
  const seen = new Set();
  return out.filter(s => (seen.has(s.name) ? false : seen.add(s.name))).sort((a, b) => a.name.localeCompare(b.name));
}
