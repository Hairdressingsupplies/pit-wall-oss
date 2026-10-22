// Names chats you start without a name. Claude Code only writes its own auto-title (`ai-title`) in an
// interactive terminal; headless chats Pit Wall runs never get one. So, like the terminal does, one tiny
// tool-less Haiku call per chat turns the first message into a short title. Your own name always wins.
import { callModel } from './organiser.mjs';
import { defaultEngine } from './engines.mjs';

export const PLACEHOLDER = 'New session';
export const SCHEMA = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };
const MAX_AGE_MS = 3 * 86_400_000; // backfill only chats touched recently, so a first boot can't fire dozens of calls

/** A real name, or null for nothing / the placeholder. */
export const realName = n => (n && n.trim() && n.trim() !== PLACEHOLDER ? n.trim() : null);

export function buildTitlePrompt(text) {
  return `Write a short title (3 to 7 words) for a chat that starts with the message below, like a tab title.
Name the task, not the person. Sentence case, no quotes, no full stop. Return only the JSON.

<message>
${String(text).slice(0, 2000)}
</message>`;
}

const GREETING_WORDS = new Set('hi hello hey hiya yo morning afternoon evening good there all thanks ok okay test'.split(' '));
/** A bare hello says nothing to title from; wait for a real message. */
export function isGreeting(text) {
  const words = String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 4 && words.every(w => GREETING_WORDS.has(w));
}

export function cleanTitle(t) {
  const s = String(t ?? '').replace(/\s+/g, ' ').replace(/^["'“‘\s]+|["'”’.\s]+$/g, '').trim().slice(0, 60);
  // "New session started" is the model echoing the placeholder; a word boundary lets a real "New sessions page…" through.
  return s && s !== PLACEHOLDER && !/^new (session|chat|conversation)\b/i.test(s) ? s : null;
}

export class Titler {
  constructor({ store, claudeExe, cwd, callModelFn = callModel, onRate = () => {}, onTitled = () => {}, log = console }) {
    Object.assign(this, { store, claudeExe, cwd, callModelFn, onRate, onTitled, log });
    this.queue = [];
    this.tried = new Set();
    this.running = false;
  }

  /** Name this chat from its first message (when it has no name yet). */
  request(sessionId, text) {
    // Return before `tried.add` so the chat can still be titled once it says something real.
    if (!text?.trim() || isGreeting(text) || this.tried.has(sessionId)) return;
    const sm = this.store.sessionMeta(sessionId);
    if (realName(sm?.display_name) || sm?.auto_title) return;
    this.tried.add(sessionId);
    this.queue.push({ sessionId, text });
    this.#drain();
  }

  /** Board rows still called "New session" that have a first message: name them, one call at a time. */
  backfill(rows, now = Date.now()) {
    for (const r of rows) {
      // Terminal chats get Claude's own title within seconds; only headless ones need ours.
      if (r.name !== PLACEHOLDER || r.source === 'terminal' || now - (Date.parse(r.lastActivity) || 0) > MAX_AGE_MS) continue;
      const text = isGreeting(r.firstPrompt) ? r.lastPrompt : r.firstPrompt;
      if (text) this.request(r.id, text);
    }
  }

  async #drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const { sessionId, text } = this.queue.shift();
        const res = await this.callModelFn({ engine: defaultEngine(this.store), codexModels: this.store.get('codexModels', []), claudeExe: this.claudeExe, cwd: this.cwd, model: 'haiku', prompt: buildTitlePrompt(text),
          schema: SCHEMA, maxTurns: 2, timeoutMs: 90_000, onRate: this.onRate }).catch(e => ({ ok: false, error: e.message }));
        const title = res.ok ? cleanTitle(res.data?.title) : null;
        if (!title) { this.log.warn?.(`[titler] ${sessionId}: ${res.error ?? 'no title'}`); continue; }
        this.store.upsertSession(sessionId, { auto_title: title });
        this.onTitled(sessionId, title);
      }
    } finally {
      this.running = false;
    }
  }
}
