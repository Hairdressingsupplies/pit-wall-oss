// JSON-RPC to `codex app-server` over stdio: one JSON object per line, no "jsonrpc" field (as Codex 0.161 speaks it).
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

export class Rpc extends EventEmitter {
  constructor(input, output) {
    super();
    this.output = output;
    this.seq = 0;
    this.waiting = new Map();
    this.closed = false;
    output.on?.('error', () => { /* EPIPE etc: the input close/error path reports it */ });
    const rl = readline.createInterface({ input });
    rl.on('line', l => this.#line(l)).on('close', () => this.#shutdown());
    rl.on('error', () => this.#shutdown()); // readline re-emits input errors
    input.on?.('error', () => this.#shutdown());
  }

  #shutdown() {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiting.values()) { clearTimeout(w.timer); w.reject(new Error('Codex stopped.')); }
    this.waiting.clear();
    this.emit('close');
  }

  #write(obj) { try { this.output.write(JSON.stringify(obj) + '\n'); } catch { /* gone */ } }

  #line(l) {
    let m;
    try { m = JSON.parse(l); } catch { return; }
    if (m.id != null && m.method) return this.emit('request', m.id, m.method, m.params ?? {});
    if (m.id != null) {
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      clearTimeout(w.timer);
      return m.error ? w.reject(new Error(m.error.message ?? 'Codex error')) : w.resolve(m.result);
    }
    if (m.method) this.emit('notification', m.method, m.params ?? {});
  }

  request(method, params = {}, ms = 60_000) {
    if (this.closed || this.output.destroyed || this.output.writableEnded) return Promise.reject(new Error('Codex stopped.'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`Codex did not answer ${method} in time.`)); }, ms);
      timer.unref?.();
      this.waiting.set(id, { resolve, reject, timer });
      this.#write({ id, method, params });
    });
  }

  notify(method, params) { this.#write(params === undefined ? { method } : { method, params }); }
  respond(id, result) { this.#write({ id, result }); }
  /** A JSON-RPC error reply to a server request we can't (or won't) answer. -32601 = method not found. */
  respondError(id, code, message) { this.#write({ id, error: { code, message } }); }
}
