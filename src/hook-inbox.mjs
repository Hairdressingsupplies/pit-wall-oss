#!/usr/bin/env node
// Claude Code hook (UserPromptSubmit) installed by Pit Wall.
// When you change a task's status in Pit Wall, Pit Wall leaves a note for the chat that task came from in
// ~/.claude/pitwall-status/inbox/<session_id>.json. On your next message in that chat — terminal or Pit Wall —
// this hook hands the note to Claude as extra context, then marks it delivered. No note: prints nothing.
// It never blocks and always exits 0 — a problem here must never get in the way of a Claude session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const INBOX = path.join(os.homedir(), '.claude', 'pitwall-status', 'inbox');

/** Pure: hook payload + inbox dir → the JSON to print, or null. Moves the note aside as delivered. */
export function main(raw, dir = INBOX) {
  let p;
  try { p = JSON.parse(raw); } catch { return null; }
  if (p?.hook_event_name !== 'UserPromptSubmit' || !/^[0-9a-f-]{36}$/i.test(p?.session_id ?? '')) return null;
  const file = path.join(dir, `${p.session_id}.json`);
  let note;
  try { note = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!note?.message) return null;
  // Rename first: if two prompts race, only one of them delivers the note.
  const done = path.join(dir, `${p.session_id}.delivered.json`);
  try { fs.renameSync(file, done); } catch { return null; }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note.message } });
}

// Only run as a hook (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { raw += d; if (raw.length > 1_000_000) process.exit(0); });
  process.stdin.on('end', () => {
    try { const out = main(raw); if (out) process.stdout.write(out); } catch { /* never fail a Claude session */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2500).unref();
}
