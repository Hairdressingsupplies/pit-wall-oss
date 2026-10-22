// A Codex chat's history, written in Claude Code's transcript shape so the board, history, search and insights read it as is.
// Lives under Pit Wall's data folder — never ~/.claude/projects, where Claude's own /resume would find it.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { slugForCwd } from './config.mjs';

export const transcriptFile = (projectsDir, cwd, id) => path.join(projectsDir, slugForCwd(cwd), `${id}.jsonl`);

const promptText = c => (typeof c === 'string' ? c : (c ?? []).filter(b => b?.type === 'text').map(b => b.text).join('\n'));
const isConvo = e => e?.type === 'user' || e?.type === 'assistant';

/** The uuid of the last user/assistant entry already in the file (a resumed chat continues its chain), else null. */
function lastUuid(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (isConvo(e) && e.uuid) return e.uuid;
  }
  return null;
}

export class Transcript {
  constructor(file, { sessionId, cwd, now = () => new Date().toISOString(), parent } = {}) {
    Object.assign(this, { file, sessionId, cwd, now });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.parent = parent !== undefined ? parent : lastUuid(file);
  }

  /** Rewind: the next entry hangs off `uuid`. */
  setParent(uuid) { this.parent = uuid ?? null; }

  /** The parentUuid entry `uuid` was written with (null for the first), or undefined if it isn't in the file. */
  parentOf(uuid) {
    let text;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return undefined; }
    for (const line of text.split('\n')) {
      if (!line.includes(uuid)) continue;
      try { const e = JSON.parse(line); if (e.uuid === uuid) return e.parentUuid ?? null; } catch { /* skip junk */ }
    }
    return undefined;
  }

  #write(entry) { fs.appendFileSync(this.file, JSON.stringify(entry) + '\n'); }

  /** Saves user/assistant events (what readHistory shows) and returns the uuid written; everything else is live-only (null). */
  append(e) {
    if (!isConvo(e) || e.isReplay) return null;
    const timestamp = this.now();
    const { isReplay, priority, ...rest } = e;
    const uuid = e.uuid ?? randomUUID();
    // parentUuid chains the conversation the way Claude Code does, so rewoundEntries works on Codex chats too.
    this.#write({ ...rest, uuid, parentUuid: this.parent, sessionId: this.sessionId, cwd: this.cwd, entrypoint: 'pitwall-codex', timestamp });
    this.parent = uuid;
    const c = e.message?.content;
    const isPrompt = e.type === 'user' && !(Array.isArray(c) && c.some(b => b?.type === 'tool_result'));
    const text = isPrompt ? promptText(c) : '';
    // The bridge's "stopped" marker is not something you typed: the board keeps showing your real last message.
    if (text && !text.startsWith('[Request interrupted')) this.#write({ type: 'last-prompt', lastPrompt: text, sessionId: this.sessionId, timestamp });
    return uuid;
  }
}

const isPromptEntry = e => e.type === 'user' && !(Array.isArray(e.message?.content) && e.message.content.some(b => b?.type === 'tool_result'))
  && !promptText(e.message?.content).startsWith('[Request interrupted');

/**
 * A fork's history: the entries of `src` whose uuid is in `keep` (the turns up to the fork point), each under `sessionId`.
 * Tool results and "stopped" markers hanging off a kept entry come too (they are in the chain but not in the turn map);
 * a later prompt never does, so a rewound branch or a turn after the cut stays behind. So do last-prompt lines after the cut.
 * Writes nothing when the source is missing.
 */
export function copyTranscript(src, dst, keep, sessionId) {
  let text;
  try { text = fs.readFileSync(src, 'utf8'); } catch { return; }
  const kept = new Set(keep);
  const out = [];
  let cut = -1;
  for (const line of text.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const take = kept.has(e.uuid) || (isConvo(e) && e.uuid && kept.has(e.parentUuid) && !isPromptEntry(e));
    if (take) { kept.add(e.uuid); cut = out.length; }
    if (take || e.type === 'last-prompt') out.push(JSON.stringify({ ...e, sessionId }));
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, out.slice(0, cut + 1).map(l => l + '\n').join(''));
}

/**
 * A chat's Codex thread and its turn map: turns[] = {turnId, userUuid, itemUuids} (fork/rewind find their cut points here).
 * turns null = a file from before the map existed (`{threadId}` only): those chats can't fork or rewind.
 */
export function saveThreadState(threadsDir, id, { threadId, turns, job, attach }) {
  fs.mkdirSync(threadsDir, { recursive: true });
  // job: an unattended job's thread. Its resumes and forks stay locked down whatever flags they are started with.
  // attach: after a rewind, the uuid the next message hangs off (null = the start), until that message is written.
  fs.writeFileSync(path.join(threadsDir, `${id}.json`), JSON.stringify({ threadId, turns, ...(job ? { job: true } : {}),
    ...(attach !== undefined ? { attach } : {}) }));
}

export function loadThreadState(threadsDir, id) {
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(threadsDir, `${id}.json`), 'utf8')); } catch { return null; }
  if (!s?.threadId) return null;
  return { threadId: s.threadId, turns: Array.isArray(s.turns) ? s.turns : null, ...(s.job ? { job: true } : {}),
    ...('attach' in s ? { attach: s.attach ?? null } : {}) };
}

export const saveThread = (threadsDir, id, threadId) => saveThreadState(threadsDir, id, { threadId, turns: [] });
export const loadThread = (threadsDir, id) => loadThreadState(threadsDir, id)?.threadId ?? null;
