#!/usr/bin/env node
// Lasting "check this later" jobs. Claude Code's CronCreate lives only inside one running session: it is gone when
// the chat ends, Pit Wall parks it to free a slot, or the PC restarts. A check scheduled here is a queued job
// (src/queue.mjs runs it at its time as a fresh, hard-blocked session) plus a follow-up that watches it, so if it
// can't run — queue paused, daily cap, usage, Pit Wall off — it shows in Needs you as missed instead of vanishing.
//
//   node src/schedule.mjs add --at 2026-10-08T08:23 --title "Tier 1 morning check" --prompt-file check.md [--cwd .] [--session <id>]
//   node src/schedule.mjs list
//   node src/schedule.mjs cancel <job id>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** A scheduled check counts as missed when its job hasn't started this long after its time. */
export const GRACE_MS = 15 * 60_000;

// ── cron ────────────────────────────────────────────────────────────────────
const FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]; // day of week: Sunday is 0 or 7

function parseField(text, [lo, hi], i) {
  const out = new Set();
  for (const part of text.split(',')) {
    const m = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) return null;
    let a = m[1] === '*' ? lo : Number(m[2]);
    let b = m[1] === '*' ? hi : m[3] !== undefined ? Number(m[3]) : m[4] ? hi : a;
    const step = m[4] ? Number(m[4]) : 1;
    if (a < lo || b > hi || a > b || step < 1) return null;
    for (let v = a; v <= b; v += step) out.add(i === 4 && v === 7 ? 0 : v);
  }
  return out;
}

/** Next local time a 5-field cron expression fires, strictly after `from` (within ~13 months), or null. */
export function nextCronTime(expr, from = new Date()) {
  const parts = String(expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((p, i) => parseField(p, FIELDS[i], i));
  if (sets.some(s => !s)) return null;
  const [min, hour, dom, mon, dow] = sets;
  const domAny = parts[2] === '*', dowAny = parts[4] === '*';
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const end = from.getTime() + 400 * 86_400_000;
  while (t.getTime() <= end) {
    // Standard cron: when both day fields are restricted, either one matching is enough.
    const dayOk = domAny || dowAny ? dom.has(t.getDate()) && dow.has(t.getDay()) : dom.has(t.getDate()) || dow.has(t.getDay());
    if (!mon.has(t.getMonth() + 1) || !dayOk) { t.setDate(t.getDate() + 1); t.setHours(0, 0, 0, 0); continue; }
    if (!hour.has(t.getHours())) { t.setHours(t.getHours() + 1, 0, 0, 0); continue; }
    if (!min.has(t.getMinutes())) { t.setMinutes(t.getMinutes() + 1); continue; }
    return t;
  }
  return null;
}

// ── scheduling ──────────────────────────────────────────────────────────────
/** A short title from the first meaningful line of a prompt. */
export function titleFrom(prompt) {
  const line = String(prompt ?? '').split('\n').map(s => s.trim()).find(Boolean) ?? 'Scheduled check';
  const words = line.replace(/\s+/g, ' ');
  return words.length > 80 ? `${words.slice(0, 77).replace(/\s+\S*$/, '')}…` : words;
}

/** The job's task: the prompt, plus where it came from (the queued run starts fresh, without that chat's history). */
export function jobPrompt(prompt, { sessionId = null, at, now = new Date() } = {}) {
  return [
    `Scheduled on ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC to run at ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`
      + (sessionId ? ` by chat ${sessionId}` : '') + '. You do not have that chat\'s history: everything you need is below.',
    'If a step needs something this job is blocked from doing (ssh, deploys, sending email, Chrome), do not try to work round it: '
      + 'say exactly which step could not run and what to run by hand.',
    '',
    String(prompt).trim(),
  ].join('\n');
}

/**
 * Write a lasting scheduled check. automation false (team installs: no Queue) → only the follow-up, due at the time.
 * Returns { queueId, followupId, at }.
 */
export function scheduleCheck(store, { at, prompt, title = null, cwd, sessionId = null, projectId = null, model = null, automation = true, now = new Date() }) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) throw new Error('Give a valid time.');
  if (!String(prompt ?? '').trim()) throw new Error('Say what the check should do.');
  const name = (title ?? titleFrom(prompt)).trim().slice(0, 120) || 'Scheduled check';
  const ids = store.scheduleCheck({
    title: name, prompt: jobPrompt(prompt, { sessionId, at: when, now }), cwd, startAt: when.toISOString(),
    followAt: new Date(when.getTime() + (automation ? GRACE_MS : 0)).toISOString(),
    sessionId, projectId, model, withJob: automation,
  });
  return { ...ids, at: when };
}

/**
 * Where a scheduled check stands, from its follow-up and job. Pure.
 * → { state: null|'running'|'ran'|'missed', text, sessionId } — null = nothing to show yet.
 */
export function checkState(f, job, { now = Date.now(), why = '' } = {}) {
  const title = String(f.text).replace(/^(Scheduled check[^:]*|Missed|Ran)[^:]*:\s*/, '');
  if (!job) return { state: 'missed', text: `Missed: ${title} — its queued job was removed`, sessionId: f.session_id };
  if (job.status === 'done') return { state: 'ran', text: `Scheduled check ran: ${job.title} — read what it found`, sessionId: job.session_id ?? f.session_id };
  if (job.status === 'running' || job.status === 'needs_you') return { state: 'running', text: f.text, sessionId: f.session_id };
  if (job.status === 'failed' || job.status === 'cancelled') {
    const reason = String(job.result ?? job.status).split('\n')[0].slice(0, 160);
    return { state: 'missed', text: `Missed: ${job.title} — ${reason}`, sessionId: job.session_id ?? f.session_id };
  }
  // Still queued: missed once its grace has run out.
  const late = job.start_at ? now - Date.parse(job.start_at) > GRACE_MS : now >= Date.parse(f.due_at);
  if (late) return { state: 'missed', text: `Missed: ${job.title} — not started${why ? ` (${why})` : ''}. It still runs when the queue allows.`, sessionId: f.session_id };
  return { state: null, text: f.text, sessionId: f.session_id };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function argsOf(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; } else out._.push(a);
  }
  return out;
}

const local = d => new Date(d).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

async function cli(argv) {
  const { config, paths } = await import('./config.mjs');
  const { openDb } = await import('./db.mjs');
  const store = openDb(paths.db);
  const a = argsOf(argv);
  const cmd = a._[0];
  if (cmd === 'add') {
    const prompt = a['prompt-file'] ? fs.readFileSync(String(a['prompt-file']), 'utf8') : a.prompt;
    const at = a.at && /^\d{1,2}:\d{2}$/.test(a.at) ? nextCronTime(`${Number(a.at.split(':')[1])} ${Number(a.at.split(':')[0])} * * *`) : new Date(a.at);
    if (!a.at || Number.isNaN(at?.getTime())) throw new Error('--at needs a time: 2026-10-08T08:23 (local) or 08:23 (next time it comes round).');
    if (at.getTime() <= Date.now()) throw new Error(`That time (${local(at)}) has already passed.`);
    const cwd = path.resolve(String(a.cwd ?? process.cwd()));
    const r = scheduleCheck(store, { at, prompt, title: a.title === true ? null : a.title ?? null, cwd, sessionId: a.session ?? null, automation: config.automation });
    console.log(r.queueId
      ? `Scheduled job #${r.queueId} for ${local(r.at)} in ${cwd}. Pit Wall's queue runs it then (with the usual hard blocks); if it can't, it shows in Needs you as missed.`
      : `Queue is off on this PC, so this is a follow-up only: it shows in Needs you at ${local(r.at)} for you to run by hand.`);
    return;
  }
  if (cmd === 'list') {
    const rows = store.followups().filter(f => f.queue_id || /^Scheduled check/.test(f.text));
    if (!rows.length) { console.log('No scheduled checks waiting.'); return; }
    for (const f of rows) {
      const job = f.queue_id ? store.queueItem(f.queue_id) : null;
      console.log(`#${f.queue_id ?? '-'}  ${job?.start_at ? local(job.start_at) : local(f.due_at)}  ${job?.status ?? 'follow-up'}  ${f.text}`);
    }
    return;
  }
  if (cmd === 'cancel') {
    const id = Number(a._[1]);
    const job = store.queueItem(id);
    if (!job) throw new Error(`No job #${id}.`);
    if (job.status !== 'queued') throw new Error(`Job #${id} is ${job.status}; only a waiting job can be cancelled here.`);
    store.updateQueueItem(id, { status: 'cancelled', finished_at: new Date().toISOString() });
    for (const f of store.followups().filter(f => f.queue_id === id)) store.updateFollowup(f.id, { done: 1 });
    console.log(`Cancelled job #${id}.`);
    return;
  }
  console.log('Usage:\n  node src/schedule.mjs add --at <2026-10-08T08:23 | 08:23> --title "…" (--prompt "…" | --prompt-file f) [--cwd dir] [--session id]\n  node src/schedule.mjs list\n  node src/schedule.mjs cancel <job id>');
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  cli(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1); });
}
