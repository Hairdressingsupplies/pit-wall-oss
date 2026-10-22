// Terminal status (from the Pit Wall hook) and "Move here" — ending Claude in an idle terminal
// so the conversation can carry on in Pit Wall.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** sessionId -> {state, at, message} from ~/.claude/pitwall-status/*.json */
export function readHookStatus(dir, now = Date.now()) {
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    const file = path.join(dir, f);
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Headless runs (the organiser, one-off -p calls) don't always fire SessionEnd — tidy up after 2 days.
      if (s?.at && now - Date.parse(s.at) > 2 * 86_400_000) { fs.rmSync(file, { force: true }); continue; }
      if (s?.state && s.at) out.set(f.slice(0, -5), s);
    } catch { /* being rewritten */ }
  }
  return out;
}

/** Process start time as Claude Code records it (Windows FILETIME, 100 ns since 1601), or null. */
export function processStartFiletime(pid) {
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-Process -Id $env:PW_PID -ErrorAction Stop).StartTime.ToFileTimeUtc()'],
    { windowsHide: true, timeout: 15_000, env: { ...process.env, PW_PID: String(pid) } },
    (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

/**
 * Decide whether a terminal may be taken over. Pure, so it can be tested without real processes.
 * term: the live terminal row · hook: its hook status · actualStart: FILETIME string of the running PID.
 */
export function canTakeOver({ term, hook, actualStart }) {
  if (!term) return { ok: false, why: 'That session is not open in a terminal any more — just send a message.' };
  if (term.status !== 'idle') return { ok: false, why: 'The terminal is busy. Wait until it is idle, then try again.' };
  if (hook && (hook.state === 'busy' || hook.state === 'permission' || hook.state === 'question')) {
    return { ok: false, why: 'The terminal is in the middle of something. Answer it there, or wait until it has finished.' };
  }
  if (!term.procStart || !actualStart) return { ok: false, why: 'Could not confirm which process that terminal is, so nothing was closed.' };
  // procStart and the live start time must be the same process (allow 1 s of clock rounding) — never kill a reused PID.
  const diff = Math.abs(Number(BigInt(term.procStart) - BigInt(actualStart)));
  if (!(diff <= 10_000_000)) return { ok: false, why: 'That process ID now belongs to something else, so nothing was closed.' };
  return { ok: true };
}
