// src/codex-setup.mjs
// Getting Codex (GPT) onto a PC: install/update, sign-in, the Windows sandbox, and a check that the sandbox really holds.
// Used by the server (More › Codex (GPT)…) and by setup.mjs. No config.mjs import: setup loads config late on purpose.
import { spawn, spawnSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Rpc } from './codex-rpc.mjs';
import { sandboxChoice } from './codex-translate.mjs';

export const CODEX_PACKAGE = '@openai/codex';

/** `npm i -g @openai/codex@latest` — fixed arguments, nothing from the user. npm is a .cmd on Windows, so through cmd.exe. */
export function installCommand(platform = process.platform) {
  return platform === 'win32' ? { file: 'cmd.exe', args: ['/d', '/s', '/c', `npm i -g ${CODEX_PACKAGE}@latest`] }
    : { file: 'npm', args: ['i', '-g', `${CODEX_PACKAGE}@latest`] };
}

/** `npm view @openai/codex version`: the newest Codex on npm. */
export function npmViewCommand(platform = process.platform) {
  return platform === 'win32' ? { file: 'cmd.exe', args: ['/d', '/s', '/c', `npm view ${CODEX_PACKAGE} version`] }
    : { file: 'npm', args: ['view', CODEX_PACKAGE, 'version'] };
}

/** `codex login` in a visible window on this PC. Verbatim and quoted by hand: Node's quoting would make the title \"…\", which start misreads. */
export function loginCommand(exe) {
  return { file: 'cmd.exe', args: ['/c', 'start', '"Sign in to Codex"', `"${exe}"`, 'login'], verbatim: true };
}

const psq = s => `'${String(s).replace(/'/g, "''")}'`;
const encoded = script => Buffer.from(script, 'utf16le').toString('base64');

/**
 * An elevated PowerShell (Windows asks you to allow it) running `codex sandbox setup --elevated --current-user`, left open
 * so you can read the result. The inner script goes base64-encoded, so no path can break the quoting on its way through.
 */
export function sandboxSetupCommand(exe) {
  const inner = `& ${psq(exe)} sandbox setup --elevated --current-user; `
    + "Write-Host ''; Write-Host 'Finished. Close this window, then press Check the sandbox in Pit Wall.'";
  const outer = `Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile','-NoExit','-EncodedCommand','${encoded(inner)}'`;
  return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', outer] };
}

/** "codex-cli 0.161.0" → "0.161.0" (null when there's no version in it). */
export function parseCodexVersion(out) {
  return String(out ?? '').match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0] ?? null;
}

/** Is `latest` a newer release than `installed`? (Major.minor.patch only; anything unreadable is "no".) */
export function isNewer(latest, installed) {
  const parts = v => String(v ?? '').match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const a = parts(latest), b = parts(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** local.json with Codex switched on (an earlier "false" is replaced — you just said yes). */
export function enableCodexLocal(existing) {
  return { ...existing, codexEnabled: true };
}

/** Runs a command to the end: { ok, code, out, err } (never throws). */
export function runCapture({ file, args }, { timeoutMs = 60_000, env = process.env } = {}) {
  return new Promise(resolve => {
    execFile(file, args, { timeout: timeoutMs, env, windowsHide: true, maxBuffer: 4 << 20 }, (e, stdout, stderr) =>
      resolve({ ok: !e, code: e?.code ?? 0, out: String(stdout ?? '').trim(), err: String(stderr || e?.message || '').trim() }));
  });
}

/** Ends a process and everything it started (on Windows execFile's timeout only kills cmd.exe, leaving npm running). */
export function killTree(pid, platform = process.platform) {
  if (!pid) return;
  if (platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

/**
 * Runs a command to the end: { ok, code, out, err, timedOut } (never throws). On timeout the whole tree is killed, and the
 * promise settles only once the process and its children have let go of the output (i.e. have exited).
 * onExit(code) is called when it really ends — also after a stillRunning answer, so a caller can clear its "busy" then.
 */
export function runTree({ file, args }, { timeoutMs = 60_000, env = process.env, cwd, spawnFn = spawn, killFn = killTree, fallbackMs = 60_000, onExit = () => {} } = {}) {
  return new Promise(resolve => {
    let out = '', err = '', timedOut = false, settled = false;
    const done = r => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(lastResort); resolve(r); };
    let p, lastResort = null;
    try { p = spawnFn(file, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ ok: false, code: null, out: '', err: e.message, timedOut: false }); }
    p.stdout.on('data', d => { out = (out + d).slice(-200_000); });
    p.stderr.on('data', d => { err = (err + d).slice(-200_000); });
    const timer = setTimeout(() => {
      timedOut = true;
      killFn(p.pid);
      // If the tree somehow survives, don't wait forever: report it as still running so nothing starts a second one meanwhile.
      lastResort = setTimeout(() => done({ ok: false, code: null, out: out.trim(), err: err.trim(), timedOut, stillRunning: true }), fallbackMs);
    }, timeoutMs);
    p.on('error', e => done({ ok: false, code: null, out: out.trim(), err: e.message, timedOut }));
    p.on('close', code => { done({ ok: !timedOut && code === 0, code, out: out.trim(), err: err.trim(), timedOut }); try { onExit(code); } catch { /* caller's */ } });
  });
}

/** Why Codex can't be installed or updated right now (its exe would be in use, or another install is running), else null. */
export function installBlocker({ installing = false, codexChats = 0, checking = false, statusReads = 0 } = {}) {
  if (installing) return 'Codex is already being installed.';
  if (codexChats) return `${codexChats === 1 ? 'A Codex chat is running' : `${codexChats} Codex chats are running`}, so Codex can’t be replaced now. Finish ${codexChats === 1 ? 'it' : 'them'} (or wait until ${codexChats === 1 ? 'it stops' : 'they stop'}), then try again.`;
  if (checking) return 'A sandbox check is running — try again in a few seconds.';
  if (statusReads) return 'Pit Wall is checking Codex right now — try again in a moment.';
  return null;
}

/** The panel's message after an install: null when it worked and Pit Wall can find Codex. */
export function installOutcome(r, exeFound) {
  if (r.ok) return exeFound ? null : "Installed, but Pit Wall can't find codex.exe — set PITWALL_CODEX_EXE to its full path.";
  if (r.timedOut) return 'The install took longer than 5 minutes and was stopped. Check your internet connection, then try again.';
  return installError(r);
}

/** Guards for the Codex routes: installed (400), PC-only actions from a phone (403), nothing while an install runs (409). */
export function codexRouteGuard({ remote = false, installed = true, pcOnly = true, installing = false, what = 'Do that' }) {
  if (!installed) return { status: 400, error: "Codex isn't installed on this PC." };
  if (pcOnly && remote) return { status: 403, error: `${what} at the PC.` };
  if (installing) return { status: 409, error: 'Codex is being installed — try again when it has finished.' };
  return null;
}

/** The installed Codex's version, or null. */
export async function codexVersion(exe, { run = runCapture } = {}) {
  if (!exe) return null;
  const r = await run({ file: exe, args: ['--version'] }, { timeoutMs: 15_000 });
  return r.ok ? parseCodexVersion(r.out) : null;
}

/** The newest Codex on npm, or null (offline, npm missing). */
export async function latestCodexVersion({ run = runCapture } = {}) {
  const r = await run(npmViewCommand(), { timeoutMs: 30_000 });
  return r.ok ? parseCodexVersion(r.out) : null;
}

/** The last useful line of npm's output, for a failed install. */
export function installError(r) {
  const text = `${r.err}\n${r.out}`;
  if (/EBUSY|EPERM|resource busy|operation not permitted/i.test(text)) {
    return 'Codex is in use (an open Codex chat, or a Codex window), so it could not be replaced. Finish or close those, then try again.';
  }
  if (/not recognized|ENOENT/i.test(text) && !/npm ERR/i.test(text)) return 'npm was not found. Install Node.js (it includes npm), then try again.';
  const line = text.split('\n').map(l => l.trim()).filter(l => /npm (ERR|error)/i.test(l)).pop() ?? text.trim().split('\n').pop() ?? '';
  return `The install did not work${line ? `: ${line.slice(0, 200)}` : '.'}`;
}

// ── the zero-turn sandbox check ──────────────────────────────────────────────────────────────────────────────────────
// A throwaway `codex app-server` (no model turns, no usage): the same readiness and config reads the bridge does
// (src/codex-bridge.mjs), the same sandboxChoice, then three `command/exec` probes under that sandbox.

/** Writes `target` (the probe commands: plain argv, no shell quoting). */
export function writeProbe(target, writer = process.execPath) {
  return [writer, '-e', "require('fs').writeFileSync(process.argv[1], 'Pit Wall sandbox check')", target];
}
/** Prints the HTTP status of a request to example.com (000 when it can't connect). */
export function networkProbe(platform = process.platform) {
  return [platform === 'win32' ? 'curl.exe' : 'curl', '-s', '-o', platform === 'win32' ? 'NUL' : '/dev/null', '-w', '%{http_code}', '--max-time', '8', 'https://example.com'];
}

async function withAppServer({ exe, args, env, spawnFn, timeoutMs }, fn) {
  const p = spawnFn(exe, args, { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  p.on?.('error', () => { /* couldn't start: the requests below fail and say so */ });
  const rpc = new Rpc(p.stdout, p.stdin);
  try {
    await rpc.request('initialize', { clientInfo: { name: 'pitwall', title: 'Pit Wall', version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } }, timeoutMs);
    rpc.notify('initialized');
    return await fn(rpc);
  } finally { try { p.kill(); } catch { /* gone */ } }
}

/**
 * { at, installed, readiness, mode, writesInside, writesOutsideBlocked, networkBlocked, ok, error, details }.
 * mode is the sandbox a Codex chat would get right now: 'workspace-write' (sandbox set up) or 'read-only' (every edit asks).
 * ok = workspace-write and all three probes behaved. The probe folder sits outside %TEMP% (workspace-write keeps TEMP
 * writable, so a target there would look "not blocked") and is removed afterwards.
 */
export async function sandboxCheck({ exe, preArgs = [], env = process.env, spawnFn = spawn, timeoutMs = 20_000, platform = process.platform,
  base = path.join(os.homedir(), `.pitwall-sandbox-check-${randomUUID().slice(0, 8)}`) } = {}) {
  const result = { at: new Date().toISOString(), installed: !!exe, readiness: null, mode: null, writesInside: null, writesOutsideBlocked: null,
    networkBlocked: null, ok: false, error: null, details: {} };
  if (!exe) return { ...result, error: "Codex isn't installed on this PC." };
  const inside = path.join(base, 'workspace');
  const insideFile = path.join(inside, 'inside.txt');
  const outsideFile = path.join(base, 'outside.txt');
  try {
    fs.mkdirSync(inside, { recursive: true });
    const first = await withAppServer({ exe, args: [...preArgs, 'app-server'], env, spawnFn, timeoutMs }, async rpc => {
      const ready = await rpc.request('windowsSandbox/readiness', {}, timeoutMs).catch(() => null);
      const cfg = ready?.status === 'ready' ? await rpc.request('config/read', { cwd: inside }, timeoutMs).catch(() => null) : null;
      return { readiness: ready?.status ?? null, cfg: cfg?.config ?? null };
    });
    result.readiness = first.readiness;
    const box = sandboxChoice(first.readiness, first.cfg, platform);
    result.mode = box.sandbox;
    // The bridge passes these as thread config; command/exec has none, so they go on the app-server's command line.
    const overrides = { 'sandbox_workspace_write.network_access': false, ...box.config };
    const cfgArgs = Object.entries(overrides).flatMap(([k, v]) => ['-c', `${k}=${JSON.stringify(v)}`]);
    const sandboxPolicy = box.sandbox === 'workspace-write'
      ? { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
      : { type: 'readOnly', networkAccess: false };
    await withAppServer({ exe, args: [...preArgs, ...cfgArgs, 'app-server'], env, spawnFn, timeoutMs }, async rpc => {
      const exec = command => rpc.request('command/exec', { command, cwd: inside, sandboxPolicy, timeoutMs: 15_000 }, timeoutMs + 15_000)
        .then(r => ({ exitCode: r?.exitCode ?? null, stdout: String(r?.stdout ?? '').trim().slice(0, 300), stderr: String(r?.stderr ?? '').trim().slice(0, 300) }),
          e => ({ error: String(e.message).split(/\r?\n/).filter(l => l.trim()).slice(0, 1).concat(String(e.message).match(/Error: [^\r\n]*/)?.[0] ?? []).join(' — ').slice(0, 300) }));
      result.details.inside = await exec(writeProbe(insideFile));
      result.writesInside = fs.existsSync(insideFile);
      result.details.outside = await exec(writeProbe(outsideFile));
      result.writesOutsideBlocked = !fs.existsSync(outsideFile);
      const net = await exec(networkProbe(platform));
      result.details.network = net;
      result.networkBlocked = net.error ? null : !/^[23]\d\d$/.test(net.stdout);
    });
    result.ok = result.mode === 'workspace-write' && result.writesInside && result.writesOutsideBlocked && result.networkBlocked === true;
  } catch (e) {
    result.error = `The check could not finish: ${e.message}`;
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
  }
  return result;
}
