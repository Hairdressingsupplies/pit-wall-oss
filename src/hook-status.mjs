#!/usr/bin/env node
// Claude Code hook (UserPromptSubmit · Notification · Stop · SessionEnd) installed by Pit Wall.
// Records each session's exact state in ~/.claude/pitwall-status/<session_id>.json so Pit Wall knows
// when a *terminal* session is waiting on you. It prints nothing, never blocks, and always exits 0 —
// a problem here must never get in the way of a Claude session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(os.homedir(), '.claude', 'pitwall-status');

/** Pure: hook payload → {state, message} or null (ignore) or 'end' (delete). */
export function stateFor(p) {
  switch (p?.hook_event_name) {
    case 'UserPromptSubmit': return { state: 'busy', message: null };
    case 'Stop': return { state: 'stopped', message: null };
    case 'SessionEnd': return 'end';
    case 'Notification': {
      const type = String(p.notification_type ?? p.matcher ?? '');
      const msg = String(p.message ?? '');
      if (type === 'permission_prompt' || /permission/i.test(msg)) return { state: 'permission', message: msg.slice(0, 200) || null };
      if (type === 'idle_prompt' || /waiting for your input/i.test(msg)) return { state: 'idle', message: null };
      if (/elicitation|needs_input|question/i.test(type)) return { state: 'question', message: msg.slice(0, 200) || null };
      return null;
    }
    default: return null;
  }
}

export function main(raw) {
  let p;
  try { p = JSON.parse(raw); } catch { return; }
  if (!p?.session_id || !/^[0-9a-f-]{36}$/i.test(p.session_id)) return;
  const s = stateFor(p);
  if (!s) return;
  const file = path.join(DIR, `${p.session_id}.json`);
  if (s === 'end') { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...s, at: new Date().toISOString(), event: p.hook_event_name, type: p.notification_type ?? null, cwd: p.cwd ?? null }));
  fs.renameSync(tmp, file);
}

// Only run as a hook (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { raw += d; if (raw.length > 1_000_000) process.exit(0); });
  process.stdin.on('end', () => { try { main(raw); } catch { /* never fail a Claude session */ } process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
