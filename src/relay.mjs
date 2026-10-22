// Relay: keeps one chat's `claude -p` running when the Pit Wall server restarts.
//
// The server starts this detached (no console, own process group, no stdio tied to the server), and it starts
// claude. It owns claude's stdin/stdout, so ending the server no longer ends the chat. Everything is appended to
// <dir>/<id>.log — claude's output lines, what was written to claude, its pid and exit — so a server that
// (re)connects can replay the log and know exactly where the chat stands, including which approvals were already
// answered. The server talks to it over a named pipe, one connection at a time: on connect it gets the whole log,
// then live records. Lines from the server are written to claude's stdin.
//
//   node src/relay.mjs <dir> <sessionId>     (reads <dir>/<id>.spec.json: { exe, args, cwd })
//
// Kept deliberately small and versioned (RELAY_VERSION): a relay outlives server updates, so a newer server
// will often be talking to an older relay.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export const RELAY_VERSION = 1;

// The pipe name includes the relay folder, so a test server running on a copy of data/ can never reach (and take
// over) the live server's chats: it finds no pipe and treats those relays as gone.
const dirTag = dir => createHash('sha1').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 10);

export const relayPaths = (dir, id) => ({
  spec: path.join(dir, `${id}.spec.json`),
  state: path.join(dir, `${id}.state.json`),
  log: path.join(dir, `${id}.log`),
  pipe: process.platform === 'win32' ? `\\\\.\\pipe\\pitwall-relay-${dirTag(dir)}-${id}` : path.join(dir, `${id}.sock`),
});

/** Claude's streaming deltas are not kept (they'd make the log huge); a turn starting again is. */
export function worthLogging(line) {
  if (!line.startsWith('{"type":"stream_event"')) return true;
  return line.includes('"type":"message_start"');
}

function main(dir, id) {
  const p = relayPaths(dir, id);
  const spec = JSON.parse(fs.readFileSync(p.spec, 'utf8'));
  const logFd = fs.openSync(p.log, 'w'); // one relay = one claude process: a relaunch starts a fresh log
  let client = null;
  let exited = false, closed = false;

  const record = (rec, { log = true } = {}) => {
    const line = JSON.stringify({ t: Date.now(), ...rec });
    if (log && !closed) fs.writeSync(logFd, line + '\n');
    if (client && !client.destroyed) client.write(line + '\n');
  };

  const child = spawn(spec.exe, spec.args, { cwd: spec.cwd, env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  fs.writeFileSync(p.state, JSON.stringify({ version: RELAY_VERSION, relayPid: process.pid, claudePid: child.pid ?? null, pipe: p.pipe,
    startedAt: new Date().toISOString() }));
  record({ s: child.pid ?? null });

  let buf = '';
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line) record({ o: line }, { log: worthLogging(line) });
    }
  });
  child.stderr.on('data', d => record({ e: String(d) }));
  child.stdin.on('error', () => {});

  const finish = code => {
    if (exited) return;
    exited = true;
    record({ x: code });
    closed = true;
    fs.closeSync(logFd);
    // Give a connected server a moment to read the exit; an unconnected one finds it in the log at its next start.
    setTimeout(() => process.exit(0), 300);
  };
  child.on('exit', code => finish(code));
  child.on('error', err => { record({ e: `Could not start Claude Code: ${err.message}\n` }); finish(null); });

  const server = net.createServer(sock => {
    // One server at a time, and the first keeps it: a second Pit Wall can't take a chat from the one running it.
    if (client && !client.destroyed) { sock.destroy(); return; }
    client = sock;
    sock.on('error', () => {});
    sock.write(fs.readFileSync(p.log, 'utf8')); // everything so far, then live records (single-threaded: nothing in between)
    sock.write(JSON.stringify({ t: Date.now(), replayed: true }) + '\n');
    let inBuf = '';
    sock.on('data', d => {
      inBuf += d;
      let i;
      while ((i = inBuf.indexOf('\n')) >= 0) {
        const line = inBuf.slice(0, i);
        inBuf = inBuf.slice(i + 1);
        if (!line || closed) continue;
        fs.writeSync(logFd, JSON.stringify({ t: Date.now(), i: line }) + '\n');
        try { child.stdin.write(line + '\n'); } catch { /* claude gone */ }
      }
    });
  });
  server.on('error', err => { record({ e: `Relay pipe failed: ${err.message}\n` }); try { child.kill(); } catch {} });
  server.listen(p.pipe);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main(process.argv[2], process.argv[3]);
