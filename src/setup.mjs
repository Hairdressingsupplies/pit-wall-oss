// Sets Pit Wall up on this PC — safe to run again: data/local.json, the six Claude Code hooks in
// ~/.claude/settings.json (backed up first), a Startup-folder shortcut, then starts it and opens the page.
//
//   node src/setup.mjs [--name Sam] [--about "marketing and email"] [--workspace C:\…] [--automation]
//                      [--no-startup] [--no-start] [--check] [--uninstall] [--codex | --no-codex]
//
// --codex also adds OpenAI Codex (GPT) as a second engine: installs it with npm, opens its sign-in, and switches it on in
// data/local.json. Optional and off by default (double-clicked, it asks "Add Codex (GPT)? (y/N)").
//
// Double-click "Setup Pit Wall.cmd" to be asked for anything missing. Without a terminal (e.g. run by Claude)
// it never asks: pass --name, --about and --workspace. Uninstall removes the hooks and shortcut and stops
// Pit Wall; it never deletes data/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline/promises';
import { DatabaseSync } from 'node:sqlite';
import { SITE, DEFAULT_ABOUT } from './site.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_RE = /[\\/]pit-wall[\\/]src[\\/]hook-(status|inbox|cron)\.mjs$/i;
const STATUS_EVENTS = ['UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'];

/** True for a settings.json hook group that runs one of Pit Wall's hook scripts (from any clone path). */
export const isPitWallHook = group => (group?.hooks ?? []).some(h =>
  [h.command, ...(Array.isArray(h.args) ? h.args : [])].some(a => typeof a === 'string' && HOOK_RE.test(a.trim().replace(/^"|"$/g, ''))));

/** settings without any Pit Wall hook groups; events left empty are dropped. */
export function removeHooks(settings) {
  const s = structuredClone(settings ?? {});
  if (!s.hooks) return s;
  for (const ev of Object.keys(s.hooks)) {
    if (!Array.isArray(s.hooks[ev])) continue;
    s.hooks[ev] = s.hooks[ev].filter(g => !isPitWallHook(g));
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  return s;
}

/**
 * settings with exactly one copy of Pit Wall's six hooks: four background status hooks, one synchronous inbox hook,
 * and one synchronous PreToolUse hook that turns a later one-shot CronCreate into a lasting scheduled check.
 */
export function mergeHooks(settings, { nodePath, root }) {
  const s = removeHooks(settings);
  const fwd = p => p.replace(/\\/g, '/');
  const group = (file, async, matcher = null) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: fwd(nodePath),
    args: [fwd(path.win32.join(root, 'src', file))], timeout: matcher ? 10 : 5, ...(async ? { async: true } : {}) }] });
  s.hooks ??= {};
  for (const ev of STATUS_EVENTS) (s.hooks[ev] ??= []).push(group('hook-status.mjs', true));
  s.hooks.UserPromptSubmit.push(group('hook-inbox.mjs', false));
  (s.hooks.PreToolUse ??= []).push(group('hook-cron.mjs', false, 'CronCreate'));
  return s;
}

/** Existing local.json values win; answers only fill keys that are missing. Blank answers are skipped. */
export function mergeLocal(existing, answers) {
  const out = { ...existing };
  for (const [k, v] of Object.entries(answers)) if (out[k] === undefined && v !== undefined && v !== '') out[k] = v;
  return out;
}

/** "marketing and email" → "works at Acme on marketing and email." (read after the name; company from site.json). */
export function aboutLine(role, company = SITE.company) {
  const r = String(role ?? '').trim().replace(/\.+$/, '');
  if (!r) return company ? `works at ${company}.` : DEFAULT_ABOUT;
  if (/^(works|runs|manages|leads|looks after|handles)\b/i.test(r)) return `${r}.`;
  return `works${company ? ` at ${company}` : ''} on ${r}.`;
}

/** settings.json text → object. Missing or blank = {}; invalid JSON throws (we never overwrite a file we can't read). */
export function parseSettings(text) {
  if (text == null || !String(text).trim()) return {};
  return JSON.parse(String(text).replace(/^\uFEFF/, ''));
}

// ── command line ───────────────────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const f = { startup: true, start: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--name') f.name = val();
    else if (a === '--about') f.about = val();
    else if (a === '--workspace') f.workspace = val();
    else if (a === '--automation') f.automation = true;
    else if (a === '--no-startup') f.startup = false;
    else if (a === '--no-start') f.start = false;
    else if (a === '--check') f.check = true;
    else if (a === '--uninstall') f.uninstall = true;
    else if (a === '--yes' || a === '-y') f.yes = true;
    else if (a === '--codex') f.codex = true;
    else if (a === '--no-codex') f.codex = false;
    else throw new Error(`Unknown option ${a}`);
  }
  return f;
}

/** A typed answer to a yes/no question; blank is the default (No unless the question says (Y/n)). */
export function yesNo(answer, dflt = false) {
  const a = String(answer ?? '').trim().toLowerCase();
  return a ? /^y(es)?$/.test(a) : dflt;
}

let failed = false;
const ok = msg => console.log(`  ✓ ${msg}`);
const warn = (msg, fix) => console.log(`  ! ${msg}${fix ? `\n      → ${fix}` : ''}`);
const bad = (msg, fix) => { failed = true; console.log(`  ✗ ${msg}${fix ? `\n      → ${fix}` : ''}`); };

const ps = cmd => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true });
// PITWALL_STARTUP_DIR lets a test run use a scratch folder instead of the real Startup folder.
const startupLnk = () => path.join(process.env.PITWALL_STARTUP_DIR
  ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
  'Pit Wall.lnk');
const longPath = p => { try { return fs.realpathSync.native(p).toLowerCase(); } catch { return path.resolve(p).toLowerCase(); } };

/** Removes the Startup shortcut only if it starts *this* copy of Pit Wall — another clone's shortcut is left alone. */
function removeShortcut() {
  const lnk = startupLnk();
  if (!fs.existsSync(lnk)) { ok('No Startup shortcut to remove'); return; }
  const r = ps(`(New-Object -ComObject WScript.Shell).CreateShortcut(${psq(lnk)}).Arguments`);
  const target = String(r.stdout).match(/"([^"]+start-hidden\.vbs)"/i)?.[1];
  if (target && longPath(target) === longPath(path.join(ROOT, 'start-hidden.vbs'))) { fs.rmSync(lnk); ok('No longer starts at login'); }
  else warn('The Startup shortcut belongs to another copy of Pit Wall — left alone');
}
const psq = s => `'${String(s).replace(/'/g, "''")}'`;

async function answers(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); return r.ok || r.status < 500; } catch { return false; }
}

function checks(config) {
  console.log('\nChecking this PC');
  if (path.basename(ROOT).toLowerCase() === 'pit-wall') ok(`Pit Wall folder: ${ROOT}`);
  else bad(`The folder is called "${path.basename(ROOT)}"`, 'Rename it to pit-wall — the hooks look for that name.');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 24) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node} is too old`, 'Install Node 24 or newer: winget upgrade OpenJS.NodeJS');
  // Exactly what Pit Wall will spawn for every chat (no shell — an npm "claude.cmd" would not start).
  const v = spawnSync(config.claudeExe, ['--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (v.status === 0) ok(`Claude Code ${String(v.stdout).trim()} (${config.claudeExe})`);
  else bad(`Pit Wall can't start Claude Code (${config.claudeExe})`,
    'Install it with the native installer in PowerShell: irm https://claude.ai/install.ps1 | iex — then run setup again.');
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    if (j.oauthAccount) ok(`Logged in to Claude${j.oauthAccount.emailAddress ? ` as ${j.oauthAccount.emailAddress}` : ''}`);
    else bad('Claude Code is not logged in', 'Open a terminal, run: claude — and log in, then run setup again.');
  } catch { bad('Claude Code has not been run on this PC yet', 'Open a terminal, run: claude — and log in, then run setup again.'); }
  // Pit Wall checks GitHub for updates on its own: git must be able to sign in without asking.
  const f = spawnSync('git', ['-C', ROOT, 'fetch', '--dry-run', '--quiet', 'origin'], { encoding: 'utf8', timeout: 60_000, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
  if (f.status === 0) ok('Can check GitHub for Pit Wall updates');
  else warn('Pit Wall can’t check GitHub for updates on its own', 'Run: gh auth setup-git — then setup again with --check. Everything else works without it.');
}

async function writeLocal(f, config) {
  const file = path.join(config.dataDir, 'local.json');
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { /* none yet */ }
  const docs = path.join(os.homedir(), 'Documents', 'GitHub');
  const defaultWs = fs.existsSync(docs) ? docs : path.dirname(ROOT);
  const need = { name: existing.name == null && f.name == null, about: existing.about == null && f.about == null, workspace: existing.workspace == null && f.workspace == null };
  if (Object.values(need).some(Boolean)) {
    if (!process.stdin.isTTY) {
      const flags = Object.keys(need).filter(k => need[k]).map(k => `--${k}`).join(' ');
      bad(`Missing ${flags}`, `Run again with them, e.g. node src/setup.mjs --name "Sam" --about "marketing and email" --workspace "${f.workspace ?? existing.workspace ?? defaultWs}"`);
      return false;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (need.name) f.name = (await rl.question('  Your first name: ')).trim();
    if (need.about) f.about = (await rl.question('  What you work on, in a few words (e.g. "marketing and email"): ')).trim();
    if (need.workspace) f.workspace = (await rl.question(`  Folder you keep your work in [${defaultWs}]: `)).trim() || defaultWs;
    rl.close();
  }
  if (f.workspace && !fs.existsSync(f.workspace)) warn(`${f.workspace} does not exist yet`, 'Pit Wall will still start; create it or change "workspace" in data/local.json.');
  const next = mergeLocal(existing, {
    name: f.name?.trim(),
    about: f.about != null ? aboutLine(f.about) : undefined,
    workspace: f.workspace,
    automation: f.automation === true,
  });
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  ok(`Settings saved for ${next.name ?? 'you'} (${file})${next.automation ? '' : ' — Queue and Agents off'}`);
  return true;
}

// ── optional: Codex (GPT) ─────────────────────────────────────────────────────────────────────────────────────────

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(question); } finally { rl.close(); }
}

/** The Codex switch as Pit Wall's page left it (kv codexEnabled in data/pitwall.db, opened read-only): true/false, or null if never set. */
export function readKvCodexEnabled(dbFile) {
  if (!fs.existsSync(dbFile)) return null;
  let db;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const r = db.prepare("SELECT v FROM kv WHERE k = 'codexEnabled'").get();
    const v = r ? JSON.parse(r.v) : null;
    return typeof v === 'boolean' ? v : null;
  } catch { return null; } finally { try { db?.close(); } catch { /* closed */ } }
}
/** Is Codex on? The page's switch wins; otherwise data/local.json. */
export const codexOnForCheck = (localDefault, kv) => (typeof kv === 'boolean' ? kv : !!localDefault);

/**
 * Switch Codex on in a Pit Wall that is already running, through its own page API (cookie from the page + its Origin), so it
 * shows straight away without a restart. false if Pit Wall isn't running or is too old to know the route.
 */
export async function enableOnRunningServer(url, fetchFn = fetch) {
  try {
    const page = await fetchFn(url, { signal: AbortSignal.timeout(3000) });
    const cookie = String(page.headers.get('set-cookie') ?? '').split(';')[0];
    if (!page.ok || !cookie) return false;
    const origin = new URL(url).origin;
    const r = await fetchFn(`${origin}/api/codex/enable`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }), signal: AbortSignal.timeout(5000) });
    return !!r.ok;
  } catch { return false; }
}

/** Yes ⇒ install Codex (npm), open its sign-in, offer the sandbox setup (admin), and switch it on in local.json. Default: no. */
async function addCodex(f, config, url) {
  const cs = await import('./codex-setup.mjs');
  const { refreshCodexExe } = await import('./config.mjs');
  let want = f.codex;
  if (want === undefined) {
    if (config.codexDefault) { ok('Codex (GPT) is on (data/local.json) — manage it in Pit Wall: More › Codex (GPT)…'); return; }
    if (!process.stdin.isTTY) return; // run by Claude without --codex: no Codex
    want = yesNo(await ask('  Add Codex (GPT) as a second engine, next to Claude? It uses your ChatGPT plan. (y/N): '));
  }
  if (!want) return;
  console.log('\nAdding Codex (GPT)');
  if (!config.codexExe) {
    console.log('  Installing Codex with npm (a minute or two)…');
    // Whole-tree timeout, as in the page: a stuck npm is stopped with everything it started.
    const r = await cs.runTree(cs.installCommand(), { timeoutMs: 5 * 60_000 });
    refreshCodexExe();
    const problem = cs.installOutcome(r, !!config.codexExe);
    if (problem) { bad(problem, 'Or run in a terminal: npm i -g @openai/codex@latest — then setup again with --codex.'); return; }
  }
  const exe = config.codexExe;
  if (!exe) { bad('Codex did not install', 'Run in a terminal: npm i -g @openai/codex@latest — then setup again with --codex.'); return; }
  ok(`Codex ${(await cs.codexVersion(exe)) ?? ''} installed (${exe})`);
  const { codexAccount } = await import('./codex-exec.mjs');
  const acct = await codexAccount({ exe });
  if (acct.signedIn) ok(`Signed in to Codex as ${acct.email ?? 'your ChatGPT account'}`);
  else {
    const lc = cs.loginCommand(exe);
    spawn(lc.file, lc.args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: lc.verbatim }).on('error', () => {}).unref();
    ok('A Codex sign-in window has opened — finish signing in there');
  }
  if (acct.sandbox === 'ready') ok('Codex sandbox is set up');
  else if (process.stdin.isTTY && yesNo(await ask('  Set up the Codex sandbox now? Windows will ask you for admin approval once. (Y/n): '), true)) {
    const sc = cs.sandboxSetupCommand(exe);
    spawn(sc.file, sc.args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
    ok('The sandbox setup window has opened (accept the Windows prompt) — then use Check the sandbox in More › Codex (GPT)…');
  } else warn('Codex sandbox not set up yet — until it is, every file edit Codex makes asks you first',
    'In Pit Wall: More › Codex (GPT)… › Set up the sandbox (needs admin approval once).');
  const file = path.join(config.dataDir, 'local.json');
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { /* none yet */ }
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cs.enableCodexLocal(existing), null, 2) + '\n');
  ok('Codex (GPT) switched on in data/local.json ("codexEnabled": true)');
  // A Pit Wall that is already running read local.json when it started: switch it on there too, or say how.
  if (await answers(url)) {
    if (await enableOnRunningServer(url)) ok('Codex is on in the running Pit Wall too — no restart needed (turn it off any time in More › Codex (GPT)…)');
    else warn('The running Pit Wall doesn’t show Codex yet', 'Restart Pit Wall, or open More › Codex (GPT)… and press Turn Codex on.');
  } else ok('Pit Wall will show Codex when it starts — turn it off any time in More › Codex (GPT)…');
}

/** --check: Codex's state, when it's switched on (in the page, or in local.json). */
async function checkCodex(config) {
  const kv = readKvCodexEnabled(path.join(config.dataDir, 'pitwall.db'));
  if (!codexOnForCheck(config.codexDefault, kv)) return;
  ok(`Codex (GPT) is switched on (${typeof kv === 'boolean' ? 'in Pit Wall' : 'data/local.json'})`);
  const cs = await import('./codex-setup.mjs');
  if (!config.codexExe) { bad('Codex (GPT) is switched on but not installed', 'Pit Wall: More › Codex (GPT)… › Install Codex, or run setup again with --codex.'); return; }
  ok(`Codex ${(await cs.codexVersion(config.codexExe)) ?? ''} installed`);
  const { codexAccount } = await import('./codex-exec.mjs');
  const a = await codexAccount({ exe: config.codexExe });
  a.signedIn ? ok(`Signed in to Codex as ${a.email ?? 'your ChatGPT account'}`) : warn('Codex is not signed in', 'Pit Wall: More › Codex (GPT)… › Sign in.');
  a.sandbox === 'ready' ? ok('Codex sandbox is set up')
    : warn('Codex sandbox not set up — every file edit asks you first', 'Pit Wall: More › Codex (GPT)… › Set up the sandbox (admin once).');
}

function updateSettings(config, change, label) {
  const file = path.join(config.claudeHome, 'settings.json');
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* no settings yet */ }
  let s;
  try { s = parseSettings(text); } catch (e) {
    bad(`Can't read ${file} (${e.message})`, 'Fix or remove the broken JSON in that file, then run setup again. Nothing was changed.');
    return;
  }
  const next = change(s);
  if (JSON.stringify(next) === JSON.stringify(s)) { ok(`${label} (already done)`); return; }
  if (text != null) {
    const backup = `${file}.bak-pitwall-${new Date().toISOString().slice(0, 10)}`;
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  }
  fs.mkdirSync(config.claudeHome, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  ok(`${label} (${file})`);
}

function makeShortcut() {
  const lnk = startupLnk();
  const r = ps(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psq(lnk)}); `
    + `$s.TargetPath = ${psq(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe'))}; `
    + `$s.Arguments = ${psq(`//nologo "${path.join(ROOT, 'start-hidden.vbs')}" open`)}; $s.WorkingDirectory = ${psq(ROOT)}; $s.Save()`);
  if (r.status === 0 && fs.existsSync(lnk)) ok('Starts by itself when you log in');
  else warn('Could not add the Startup shortcut', `Start it by double-clicking "Pit Wall.cmd" instead. (${String(r.stderr).trim().slice(0, 200)})`);
}

async function start(config, url) {
  if (await answers(url)) { ok(`Pit Wall is running — ${url}`); return; }
  // Started without this process's Claude session variables, so chats it runs behave like a normal login.
  const { childEnv } = await import('./protocol.mjs');
  spawn('wscript.exe', ['//nologo', path.join(ROOT, 'start-hidden.vbs')], { cwd: ROOT, env: childEnv(), detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await answers(url)) {
      ok(`Pit Wall is running — ${url}`);
      spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
  }
  bad(`Pit Wall did not start on port ${config.port}`, `Look at ${path.join(config.dataDir, 'server.log')}. If another program uses port ${config.port}, close it.`);
}

/** Stops only the process listening on our port — never matched by command line (every Pit Wall looks the same). */
function stopServer(port) {
  const r = ps(`$p = Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; `
    + `if ($p) { $c = (Get-CimInstance Win32_Process -Filter "ProcessId=$p").CommandLine; if ($c -match 'server\\.mjs') { Stop-Process -Id $p -Force; 'stopped' } else { 'other' } } else { 'none' }`);
  const out = String(r.stdout).trim();
  if (out === 'stopped') ok('Pit Wall stopped');
  else if (out === 'none') ok('Pit Wall was not running');
  else warn(`Port ${port} is used by another program — left alone`);
}

async function main() {
  const f = parseArgs(process.argv.slice(2));
  // Import after argv parsing so PITWALL_* env vars set for tests apply.
  const { config } = await import('./config.mjs');
  const url = `http://127.0.0.1:${config.port}/`;
  console.log(`Pit Wall setup — ${ROOT}`);

  if (f.uninstall) {
    console.log('\nRemoving Pit Wall from this PC (your chats, history and data/ are kept)');
    updateSettings(config, removeHooks, 'Hooks removed from Claude Code settings');
    removeShortcut();
    stopServer(config.port);
    console.log('\nDone. Delete this folder too if you want it gone completely.');
    return;
  }

  checks(config);
  if (f.check) {
    const hooked = (() => { try { return JSON.stringify(parseSettings(fs.readFileSync(path.join(config.claudeHome, 'settings.json'), 'utf8'))).includes('pit-wall/src/hook-status.mjs'); } catch { return false; } })();
    hooked ? ok('Hooks are installed') : bad('Hooks are not installed', 'Run setup without --check.');
    (await answers(url)) ? ok(`Pit Wall is running — ${url}`) : warn('Pit Wall is not running', 'Double-click "Pit Wall.cmd".');
    await checkCodex(config);
    process.exitCode = failed ? 1 : 0;
    return;
  }
  if (failed) { console.log('\nFix the ✗ items above, then run setup again.'); process.exitCode = 1; return; }

  console.log('\nSetting up');
  if (!(await writeLocal(f, config))) { process.exitCode = 1; return; }
  updateSettings(config, s => mergeHooks(s, { nodePath: process.execPath, root: ROOT }), 'Claude Code hooks installed');
  await addCodex(f, config, url);
  if (f.startup) makeShortcut();
  if (f.start) await start(config, url);
  if (failed) { console.log('\nSome steps failed — see the ✗ items above.'); process.exitCode = 1; return; }
  console.log(`\nAll set. Open ${url}`
    + '\nClaude terminals that were already open show up properly once they are restarted.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => { console.error(`\n✗ ${e.message}`); process.exitCode = 1; });
}
