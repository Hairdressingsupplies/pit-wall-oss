#!/usr/bin/env node
// Claude Code hook (PreToolUse, matcher CronCreate) installed by Pit Wall.
// CronCreate jobs live only inside the running session: they vanish when the chat ends, when Pit Wall parks it to
// free a slot for another chat, or when the PC restarts — silently. So a one-shot CronCreate due 15+ minutes from now is
// saved as a lasting Pit Wall scheduled check instead (src/schedule.mjs: queued job + follow-up), and CronCreate
// itself is denied with a note telling Claude it's done. Recurring crons (/loop) and near ones pass through.
// Any problem here lets CronCreate through unchanged — this hook must never get in the way of a Claude session.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** One-shots due sooner than this stay in the session: the chat is almost certainly still alive then. */
export const MIN_AHEAD_MS = 15 * 60_000;

/**
 * Hook payload → the JSON to print (a deny that explains where the check went), or null to let CronCreate run.
 * `schedule(args)` does the writing and returns { queueId, at }.
 */
export async function main(raw, { schedule, nextCronTime, now = new Date() }) {
  let p;
  try { p = JSON.parse(raw); } catch { return null; }
  if (p?.hook_event_name !== 'PreToolUse' || p.tool_name !== 'CronCreate') return null;
  const input = p.tool_input ?? {};
  if (input.recurring !== false || !String(input.prompt ?? '').trim()) return null;
  const at = nextCronTime(input.cron, now);
  if (!at || at.getTime() - now.getTime() < MIN_AHEAD_MS) return null;
  const r = await schedule({ at, prompt: input.prompt, cwd: p.cwd || process.cwd(), sessionId: p.session_id ?? null });
  const when = at.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const reason = r.queueId
    ? `Not scheduled in this session: CronCreate jobs are lost when the chat ends or is parked. Pit Wall saved it instead as `
      + `lasting scheduled job #${r.queueId} for ${when} (local). Its queue runs the prompt then as a fresh session in ${p.cwd} — `
      + `without this chat's history, and with the queue's hard blocks (no ssh, deploys, git push, sending email or Chrome), so a step `
      + `that needs those will be reported for the user to run by hand. If the job can't start on time it shows in Pit Wall's Needs you `
      + `as missed. Do NOT call CronCreate again for this. Tell the user it is scheduled with Pit Wall (job #${r.queueId}, ${when}); `
      + `they can cancel it on the Queue tab or with: node "${path.join(ROOT, 'src', 'schedule.mjs')}" cancel ${r.queueId}`
    : `Not scheduled in this session: CronCreate jobs are lost when the chat ends. Pit Wall's queue is off on this PC, so it saved a `
      + `follow-up instead: it shows in Pit Wall's Needs you at ${when} for the user to run the check. Do NOT call CronCreate again `
      + `for this. Tell the user it will appear in Needs you then.`;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

// Only run as a hook (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { raw += d; if (raw.length > 1_000_000) process.exit(0); });
  process.stdin.on('end', async () => {
    try {
      const { nextCronTime, scheduleCheck } = await import('./schedule.mjs');
      const out = await main(raw, {
        nextCronTime,
        schedule: async args => {
          const { config, paths } = await import('./config.mjs');
          const { openDb } = await import('./db.mjs');
          return scheduleCheck(openDb(paths.db), { ...args, automation: config.automation });
        },
      });
      if (out) process.stdout.write(out);
    } catch { /* never fail a Claude session: CronCreate goes ahead as before */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 8000).unref();
}
