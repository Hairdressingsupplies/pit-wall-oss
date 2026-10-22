// Windows notifications when a session needs you — sent by the server, so they work with the page closed.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'toast.ps1');

export function showToast({ title, body, url }) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(false);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
      env: { ...process.env, PW_TITLE: String(title).slice(0, 120), PW_BODY: String(body).slice(0, 240), PW_URL: url },
      windowsHide: true, timeout: 15_000,
    }, err => resolve(!err));
  });
}

/**
 * Terminal sessions: notify only when one is blocked on you (a permission prompt or a question) —
 * not when it merely finishes a reply; you're usually typing in that window, and 12 terminals would flood you.
 */
export function terminalNotifyState(row) {
  if (row.source !== 'terminal' || !row.needsYou?.exact || row.needsYou.soft) return 'other';
  return 'needs_you';
}

const WORTH_TELLING = {
  needs_you: s => s.reason ?? 'Needs you',
  error: s => s.reason ?? 'Stopped with an error',
  your_turn: () => 'Finished — your turn',
  interrupted: () => 'Interrupted by a restart',
};

/**
 * Decides when to notify: only on a *change into* a state that needs you, not while you are
 * looking at that chat, and not more than once per session per `quietMs`.
 */
export class Notifier {
  constructor({ send = showToast, enabled = () => true, baseUrl, quietMs = 20_000, now = () => Date.now() }) {
    Object.assign(this, { send, enabled, baseUrl, quietMs, now });
    this.last = new Map();     // sessionId -> last status seen
    this.sentAt = new Map();   // sessionId -> time of last notification
    this.viewing = { sessionId: null, until: 0 };
  }

  /** The page reports which chat is open and visible (a heartbeat; stale after 45 s). */
  setViewing(sessionId, visible) {
    this.viewing = { sessionId: visible ? sessionId : null, until: this.now() + 45_000 };
  }

  isViewing(sessionId) {
    return this.viewing.sessionId === sessionId && this.now() < this.viewing.until;
  }

  /** Call on every status update. Returns true if a notification was sent. */
  update(sessionId, status, { name, reason } = {}) {
    const prev = this.last.get(sessionId);
    this.last.set(sessionId, status);
    if (prev === status || !WORTH_TELLING[status]) return false;
    if (prev === undefined && status === 'your_turn') return false; // first sighting, nothing changed
    if (!this.enabled() || this.isViewing(sessionId)) return false;
    const t = this.now();
    if (t - (this.sentAt.get(sessionId) ?? 0) < this.quietMs) return false;
    this.sentAt.set(sessionId, t);
    this.send({ title: name || 'A session', body: WORTH_TELLING[status]({ reason }), url: `${this.baseUrl}/?s=${encodeURIComponent(sessionId)}` });
    return true;
  }
}
