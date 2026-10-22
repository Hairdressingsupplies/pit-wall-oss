// The server's side of src/relay.mjs: starts a relay per chat and talks to it as if it were the claude child
// process itself (stdin / stdout / stderr / pid / 'exit'), so the Runner works the same either way.
//
// On (re)connecting, the relay sends its whole log first. That replay is passed to the Runner as stdout lines plus
// three Pit Wall markers it understands: pitwall_clock (when the next line happened), pitwall_input (something the
// server wrote to claude — a message, an approval) and pitwall_replayed (caught up, live from here).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { relayPaths } from './relay.mjs';

const RELAY = path.join(import.meta.dirname, 'relay.mjs');

export class RelayProc extends EventEmitter {
  constructor(dir, id, { relayPid = null, pipe = null } = {}) {
    super();
    this.id = id;
    this.dir = dir;
    this.paths = relayPaths(dir, id);
    if (pipe) this.paths.pipe = pipe; // tests only
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.pid = undefined;      // claude's pid, once the relay has started it
    this.relayPid = relayPid;
    this.sock = null;
    this.queue = [];
    this.done = false;
    this.replaying = true;
    this.piped = 0;            // log lines the relay has sent over the pipe so far (its replay of the log file)
    this.caughtUp = false;     // that replay ended: from then on every record came live, so the log has nothing new
    this.stdin = { write: s => { if (this.sock) this.sock.write(s); else this.queue.push(s); return true; } };
  }

  /** Connect to the relay's pipe, retrying while it starts. If it can't be reached, play its log from disk. */
  connect({ timeoutMs = 15_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const sock = net.connect(this.paths.pipe);
      sock.once('connect', () => {
        this.sock = sock;
        sock.on('error', () => {});
        for (const s of this.queue) sock.write(s);
        this.queue = [];
        let buf = '';
        sock.on('data', d => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) { this.#record(buf.slice(0, i), true); buf = buf.slice(i + 1); }
        });
        // The relay went away without saying claude exited: it was killed (or the PC restarted).
        sock.on('close', () => { if (!this.done && !this.detached) this.#lost(); });
      });
      sock.once('error', () => {
        if (this.sock || this.done) return;
        if (Date.now() < deadline) setTimeout(attempt, 100);
        else this.#lost();
      });
    };
    attempt();
    return this;
  }

  /** End the chat: the relay and claude under it. */
  killTree() {
    if (this.done) return Promise.resolve();
    const pid = this.relayPid ?? this.pid;
    return new Promise(resolve => {
      if (!pid) return resolve(); // not started yet
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      else { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} } resolve(); }
    });
  }

  /** Let go without ending anything: the server is shutting down and the chat carries on. */
  detach() {
    this.detached = true;
    this.sock?.destroy();
  }

  #out(obj) { this.stdout.write(JSON.stringify(obj) + '\n'); }

  #record(line, fromPipe = false) {
    let rec;
    try { rec = JSON.parse(line); } catch { return; }
    if (fromPipe && !this.caughtUp) { if (rec.replayed) this.caughtUp = true; else this.piped++; }
    if (this.replaying && rec.t) this.#out({ type: 'pitwall_clock', t: rec.t });
    if ('s' in rec) { this.pid = rec.s ?? undefined; this.emit('spawn'); }
    else if ('o' in rec) this.stdout.write(rec.o + '\n');
    else if ('i' in rec) { if (this.replaying) this.#out({ type: 'pitwall_input', line: rec.i }); }
    else if ('e' in rec) this.stderr.write(rec.e);
    else if (rec.replayed) { this.replaying = false; this.#out({ type: 'pitwall_replayed' }); this.emit('replayed'); }
    else if ('x' in rec) this.#exit(rec.x);
  }

  /**
   * The relay can't be reached: replay whatever its log holds; if claude's exit isn't in it, the chat was cut off.
   * Only what the pipe hasn't already delivered: Stop ends the relay (taskkill /T /F) before it can log claude's exit,
   * so its pipe closes and we land here after the whole log was played — playing it again showed every item twice.
   * If the relay is in fact still running (it was too slow to answer), end it first — otherwise a hidden claude
   * would carry on working while the next message resumes the same session beside it. Only a process whose
   * command line is this relay (relay.mjs + this folder + this session) is ever ended: after a PC restart the
   * old pid may belong to anything, and a test server on a copy of data/ must never touch the live relays.
   */
  async #lost() {
    if (this.done || this.losing) return;
    this.losing = true;
    if (this.relayPid && await isOurRelay(this.relayPid, this.dir, this.id)) await this.killTree();
    if (this.done) return;
    let text = '';
    try { text = fs.readFileSync(this.paths.log, 'utf8'); } catch { /* nothing logged */ }
    this.replaying = true;
    // The pipe's replay is the log file's first lines, in order; after it, records came live (the log adds only our own input).
    const unseen = this.caughtUp ? [] : text.split('\n').filter(Boolean).slice(this.piped);
    for (const line of unseen) if (!this.done) this.#record(line);
    if (!this.done) { this.lost = true; this.#exit(null); }
  }

  #exit(code) {
    if (this.done) return;
    this.done = true;
    if (this.replaying) { this.replaying = false; this.#out({ type: 'pitwall_replayed' }); this.emit('replayed'); }
    this.sock?.destroy();
    this.stdout.end();
    this.stderr.end();
    for (const f of [this.paths.spec, this.paths.state, this.paths.log]) fs.rmSync(f, { force: true });
    // Let the last stdout lines reach the Runner before it hears the process ended.
    setImmediate(() => this.emit('exit', code));
  }
}

/** Is `pid` the relay for this folder and session (checked by its command line)? */
export function isOurRelay(pid, dir, id) {
  const matches = cmd => {
    const c = String(cmd ?? '').toLowerCase().replace(/\//g, '\\');
    return c.includes('relay.mjs') && c.includes(id.toLowerCase()) && c.includes(path.resolve(dir).toLowerCase());
  };
  return new Promise(resolve => {
    if (process.platform !== 'win32') {
      try { resolve(matches(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '))); } catch { resolve(false); }
      return;
    }
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
      { windowsHide: true, timeout: 15_000 }, (err, out) => resolve(!err && matches(out)));
  });
}

/** A spawnFn for the Runner: each claude runs under a detached relay in `dir`. */
export function relaySpawn(dir) {
  return (exe, args, opts = {}) => {
    const flag = args.includes('--session-id') ? '--session-id' : '--resume';
    const id = args[args.indexOf(flag) + 1];
    fs.mkdirSync(dir, { recursive: true });
    const p = relayPaths(dir, id);
    for (const f of [p.state, p.log]) fs.rmSync(f, { force: true });
    fs.writeFileSync(p.spec, JSON.stringify({ exe, args, cwd: opts.cwd, pitwall: opts.pitwall ?? null }));
    const child = spawn(process.execPath, [RELAY, dir, id], { cwd: opts.cwd, env: opts.env, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    const proc = new RelayProc(dir, id, { relayPid: child.pid });
    child.on('error', err => { proc.stderr.write(`Could not start the relay: ${err.message}\n`); });
    return proc.connect();
  };
}

/** Relays left running by an earlier server: [{ id, meta (what the Runner needs), proc }]. */
export function findRelays(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.spec.json')); } catch { return []; }
  return names.map(f => {
    const id = f.slice(0, -'.spec.json'.length);
    const p = relayPaths(dir, id);
    let spec = {}, state = {};
    try { spec = JSON.parse(fs.readFileSync(p.spec, 'utf8')); } catch {}
    try { state = JSON.parse(fs.readFileSync(p.state, 'utf8')); } catch {}
    // echoes: started with --replay-user-messages, so a queued message is reported when Claude picks it up.
    return { id, meta: { cwd: spec.cwd, ...(spec.pitwall ?? {}), echoes: (spec.args ?? []).includes('--replay-user-messages') },
      proc: new RelayProc(dir, id, { relayPid: state.relayPid ?? null }) };
  });
}
