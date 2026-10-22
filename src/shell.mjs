// "! command" in a chat, like the terminal's bash mode. Headless Claude Code has no bash mode (it would read
// "! docker ps" as an ordinary message), so Pit Wall runs the command itself in the session's folder and shows the
// output. As in the terminal, it costs no turn: Claude sees the command and its output with your next message.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { childEnv } from './protocol.mjs';
import { killTree } from './runner.mjs';

const MAX_OUT = 30_000;
// Long enough to finish a browser login (gh auth login and the like); Stop ends it sooner.
export const SHELL_TIMEOUT_MS = 10 * 60_000;

/** Git Bash, as Claude Code uses on Windows; PowerShell if it isn't installed. */
export function findBash(env = process.env) {
  if (process.platform !== 'win32') return '/bin/bash';
  return [env.CLAUDE_CODE_GIT_BASH_PATH, 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']
    .find(p => p && fs.existsSync(p)) ?? null;
}

/**
 * Runs one command. Never rejects: { stdout, stderr, code, timedOut, stopped }. No stdin, so a prompt can't hang it.
 * onOutput(text, 'stdout' | 'stderr') sees output as it arrives (a login prints its code and link, then waits);
 * aborting `signal` stops the command.
 */
export function runShell(command, { cwd, timeoutMs = SHELL_TIMEOUT_MS, bash = findBash(), spawnFn = spawn, onOutput = null, signal = null } = {}) {
  return new Promise(resolve => {
    const [exe, args] = bash ? [bash, ['-c', command]] : ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]];
    let stdout = '', stderr = '', timedOut = false, stopped = false, p;
    try { p = spawnFn(exe, args, { cwd, env: childEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ stdout: '', stderr: e.message, code: null, timedOut, stopped }); return; }
    p.stdout.on('data', d => { if (stdout.length < MAX_OUT) stdout += d; onOutput?.(String(d), 'stdout'); });
    p.stderr.on('data', d => { if (stderr.length < MAX_OUT) stderr += d; onOutput?.(String(d), 'stderr'); });
    const timer = setTimeout(() => { timedOut = true; killTree(p.pid); }, timeoutMs);
    const stop = () => { stopped = true; killTree(p.pid); };
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
    const done = (code, extra = '') => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve({ stdout: stdout.slice(0, MAX_OUT), stderr: (stderr + extra).slice(0, MAX_OUT), code, timedOut, stopped });
    };
    p.on('error', e => done(null, e.message));
    p.on('close', code => done(code));
  });
}

/** The chat item shown for a command. */
export function shellItem(command, r, ts = new Date().toISOString()) {
  return { kind: 'shell', command, stdout: r.stdout.trimEnd(), stderr: (r.stderr.trimEnd() + (r.timedOut ? `\n(stopped after ${SHELL_TIMEOUT_MS / 60_000} minutes)` : r.stopped ? '\n(stopped)' : '')).trim(),
    code: r.code, ts };
}

/** What Claude Code's terminal records for "! command", so Claude reads it the same way. */
export function shellContext(item) {
  return `<bash-input>${item.command}</bash-input>\n<bash-stdout>${item.stdout}</bash-stdout><bash-stderr>${item.stderr}</bash-stderr>`;
}

/**
 * Splits terminal-style bash-mode blocks out of a saved prompt: the commands with their output, and whatever
 * the user wrote after them. Returns null when the prompt has none.
 */
export function parseShellBlocks(text) {
  if (!/<bash-input>/.test(text ?? '')) return null;
  const items = [];
  const re = /<bash-input>([\s\S]*?)<\/bash-input>\s*(?:<bash-stdout>([\s\S]*?)<\/bash-stdout>)?\s*(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?/g;
  for (const m of text.matchAll(re)) items.push({ command: m[1].trim(), stdout: (m[2] ?? '').trimEnd(), stderr: (m[3] ?? '').trimEnd() });
  return { items, rest: text.replace(re, '').trim() };
}
