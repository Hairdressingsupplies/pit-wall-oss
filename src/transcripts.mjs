// Reading Claude Code transcripts (~/.claude/projects/<slug>/<sessionId>.jsonl).
// Files run to many MB, so the board only ever reads the head and tail.
import fs from 'node:fs';
import path from 'node:path';
import { HANDBACK, REPORT_MAX, workflowItem } from './protocol.mjs';
import { agentTranscripts } from './insights.mjs';
import { parseShellBlocks } from './shell.mjs';

const TAIL_BYTES = 768 * 1024;
const HEAD_BYTES = 96 * 1024;

function readRange(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text, { dropFirst = false, dropLast = false } = {}) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* partial or corrupt line */ }
  }
  return out;
}

/** Plain text of a user/assistant message's content (string or block array). */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b?.type === 'text').map(b => b.text).join('\n');
}

/** Strip Claude Code's wrapper tags so a prompt reads like what the user typed. */
export function cleanPrompt(text) {
  if (!text) return '';
  const cmd = text.match(/<command-name>([^<]*)<\/command-name>/);
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  if (cmd) return `${cmd[1].trim()}${args && args[1].trim() ? ' ' + args[1].trim() : ''}`;
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-[a-z]+>[\s\S]*?<\/local-command-[a-z]+>/g, '')
    .replace(/<(pasted_content|task-notification)[^>]*>[\s\S]*?<\/\1>/g, '[…]')
    .trim();
}

/** Recaps end with a Claude Code UI hint that means nothing on the board. */
export function cleanRecap(text) {
  return String(text ?? '').replace(/\s*\(disable recaps in \/config\)\s*$/i, '').trim();
}

/** A "background job finished" notice Claude Code writes as a user turn — not something you typed. */
function isTaskNotice(e) {
  if (e.origin?.kind === 'task-notification') return true;
  const c = e.message?.content;
  return typeof c === 'string' && c.trimStart().startsWith('<task-notification>');
}

/** {id, status, summary} from a <task-notification> block. */
export function parseTaskNotice(text) {
  const tag = name => String(text ?? '').match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? null;
  return { id: tag('task-id'), status: tag('status'), summary: tag('summary') };
}

// What a tool result says when it has started something that keeps running after the reply ends.
const LAUNCHES = [
  { type: 'agent', re: /^Async agent launched successfully[\s\S]*?agentId: (\w+)/ },
  { type: 'workflow', re: /^Workflow launched in background\. Task ID: (\w+)/ },
];
function launchOf(text) {
  for (const l of LAUNCHES) { const m = l.re.exec(text); if (m) return { id: m[1], type: l.type }; }
  return null;
}

function isRealUserPrompt(e) {
  if (e.type !== 'user' || e.isSidechain || e.isMeta || e.isCompactSummary || isTaskNotice(e)) return false;
  const c = e.message?.content;
  if (Array.isArray(c) && c.some(b => b?.type === 'tool_result')) return false;
  const t = cleanPrompt(contentText(c));
  return t.length > 0 && !t.startsWith('[Request interrupted');
}

/**
 * Summary of one transcript for the board. Reads the first and last few hundred KB only.
 * Returns null for empty/unreadable files.
 */
export function summariseTranscript(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  if (stat.size === 0) return null;

  const headLen = Math.min(HEAD_BYTES, stat.size);
  const head = parseLines(readRange(file, 0, headLen), { dropLast: headLen < stat.size });
  const tailStart = Math.max(0, stat.size - TAIL_BYTES);
  const tail = tailStart === 0 ? head : parseLines(readRange(file, tailStart, stat.size - tailStart), { dropFirst: true });

  const meta = {
    sessionId: null, cwd: null, gitBranch: null, title: null, customTitle: null,
    firstPrompt: null, lastPrompt: null, lastAssistant: null, awaySummary: null,
    startedAt: null, lastActivity: null, entrypoint: null, pendingToolUse: false, endedWithQuestion: false, context: 0, openJobs: [],
    size: stat.size, mtimeMs: stat.mtimeMs,
  };

  for (const e of head) {
    meta.sessionId ??= e.sessionId ?? null;
    meta.startedAt ??= e.timestamp ?? null;
    if (!meta.firstPrompt && isRealUserPrompt(e)) meta.firstPrompt = cleanPrompt(contentText(e.message.content)).slice(0, 400);
  }

  let lastConversational = null;
  const resolvedToolIds = new Set();
  const launched = new Map(); // background agents and workflows with no "finished" notice yet
  for (const e of tail) {
    if (e.type === 'queue-operation' && typeof e.content === 'string') launched.delete(parseTaskNotice(e.content).id);
    meta.sessionId ??= e.sessionId ?? null;
    if (e.cwd) meta.cwd = e.cwd;
    if (e.gitBranch) meta.gitBranch = e.gitBranch;
    if (e.entrypoint) meta.entrypoint = e.entrypoint;
    if (e.timestamp) meta.lastActivity = e.timestamp;
    if (e.type === 'ai-title' && e.aiTitle) meta.title = e.aiTitle;
    if (e.type === 'custom-title' && e.customTitle) meta.customTitle = e.customTitle;
    if (e.type === 'last-prompt' && e.lastPrompt) meta.lastPrompt = cleanPrompt(e.lastPrompt).slice(0, 400);
    if (e.type === 'system' && e.subtype === 'away_summary' && e.content) meta.awaySummary = cleanRecap(e.content).slice(0, 600);
    if (e.isSidechain) continue;
    if (e.type === 'assistant') {
      const t = contentText(e.message?.content).trim();
      if (t) meta.lastAssistant = t.slice(-600);
      const u = e.message?.usage;
      // How much Claude re-reads on every turn: the whole conversation so far.
      if (u) meta.context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      // A Codex usage entry (no content) follows the reply it counts: it must not hide a question or a pending tool call.
      if (e.message?.content?.length) lastConversational = e;
    } else if (e.type === 'user') {
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b?.type !== 'tool_result') continue;
        resolvedToolIds.add(b.tool_use_id);
        const job = launchOf(resultText(b.content));
        if (job) launched.set(job.id, { ...job, at: e.timestamp ?? null });
      }
      if (isTaskNotice(e)) launched.delete(parseTaskNotice(contentText(e.message?.content)).id);
      if (isRealUserPrompt(e)) lastConversational = e;
    }
  }

  if (lastConversational?.type === 'assistant') {
    const blocks = lastConversational.message?.content ?? [];
    meta.pendingToolUse = blocks.some(b => b?.type === 'tool_use' && !resolvedToolIds.has(b.id));
    const t = contentText(blocks).trim();
    meta.endedWithQuestion = /\?\s*(\*\*)?\s*$/.test(t);
  }
  if (!meta.lastActivity) meta.lastActivity = new Date(stat.mtimeMs).toISOString();
  meta.openJobs = [...launched.values()];
  return meta;
}

/** Images you sent in a message, as data URLs for the chat view (base64 blocks only, capped). */
function imagesOf(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(b => b?.type === 'image' && b.source?.type === 'base64' && /^image\/(png|jpeg|gif|webp)$/.test(b.source.media_type ?? '')
      && typeof b.source.data === 'string' && b.source.data.length <= 7_000_000)
    .slice(0, 6)
    .map(b => `data:${b.source.media_type};base64,${b.source.data}`);
}

function toolSummary(name, input = {}) {
  const pick = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query
    ?? input.description ?? input.prompt ?? input.skill ?? '';
  return String(pick).replace(/\s+/g, ' ').slice(0, 160);
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

/**
 * Conversation as display items, oldest first, for the chat view.
 * Items: {kind:'user'|'assistant'|'tool'|'tool_result'|'note', ...}.
 * `before` (ISO string) keeps only entries strictly older — used to join history with a live run.
 */
/**
 * Entries to leave out because a rewind abandoned them. A rewind keeps the old turns in the file and hangs the next
 * message off an earlier entry, so the conversation is the chain of parents back from the newest message. Only a real
 * prompt of yours off that chain marks a rewound branch (other entries can sit off the chain harmlessly — parallel
 * tool results, hook summaries); its whole subtree goes. cutAt: a message just rewound to (nothing newer written yet).
 */
export function rewoundEntries(entries, cutAt = null) {
  const byId = new Map();
  const children = new Map();
  for (const e of entries) {
    if (!e.uuid || e.isSidechain) continue;
    byId.set(e.uuid, e);
    const p = e.parentUuid ?? e.logicalParentUuid; // a compaction boundary links back through logicalParentUuid
    if (p) (children.get(p) ?? children.set(p, []).get(p)).push(e.uuid);
  }
  const isPrompt = e => e?.type === 'user' && !e.isMeta && !e.isCompactSummary
    && !(Array.isArray(e.message?.content) && e.message.content.some(b => b?.type === 'tool_result'));
  const head = [...entries].reverse().find(e => e.uuid && !e.isSidechain && (e.type === 'user' || e.type === 'assistant'));
  const chain = new Set();
  for (let c = head; c && !chain.has(c.uuid); c = byId.get(c.parentUuid ?? c.logicalParentUuid)) chain.add(c.uuid);
  const roots = [...byId.values()].filter(e => isPrompt(e) && !chain.has(e.uuid)
    && chain.has(e.parentUuid ?? e.logicalParentUuid)).map(e => e.uuid);
  if (cutAt && byId.has(cutAt)) roots.push(cutAt);
  const hidden = new Set();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop();
    if (hidden.has(id)) continue;
    hidden.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return hidden;
}

export function readHistory(file, { limit = 400, before = null, cutAt = null } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { items: [], truncated: false }; }
  const items = [];
  const entries = [...parseLines(text)];
  const rewound = rewoundEntries(entries, cutAt);
  for (const e of entries) {
    if (e.isSidechain) continue;
    if (e.uuid && rewound.has(e.uuid)) continue;
    if (before && e.timestamp && e.timestamp >= before) continue;
    const ts = e.timestamp ?? null;
    if (e.type === 'system' && e.subtype === 'compact_boundary') { items.push({ kind: 'note', text: 'Conversation compacted', ts }); continue; }
    if (e.type === 'system' && e.subtype === 'away_summary') { items.push({ kind: 'note', text: cleanRecap(e.content), ts }); continue; }
    if (e.type === 'user') {
      if (e.isMeta || e.isCompactSummary) continue;
      const c = e.message?.content;
      if (Array.isArray(c) && c.some(b => b?.type === 'tool_result')) {
        for (const b of c) if (b?.type === 'tool_result') {
          items.push({ kind: 'tool_result', id: b.tool_use_id, isError: !!b.is_error, text: resultText(b.content).slice(0, 4000), ts });
        }
        continue;
      }
      if (isTaskNotice(e)) {
        const n = parseTaskNotice(contentText(c));
        items.push({ kind: 'note', text: n.summary ? n.summary.replace(/\s+/g, ' ').slice(0, 200) : `Background job ${n.status ?? 'finished'}`, ts });
        continue;
      }
      // A slash command's output (/usage, /context) is saved as a user entry; live it arrives as Claude's reply.
      const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(contentText(c))?.[1].trim();
      if (out) { items.push({ kind: 'assistant', text: out, ts }); continue; }
      // "! command" (terminal bash mode, or Pit Wall's): show the command and its output, then any message after it.
      const sh = parseShellBlocks(contentText(c));
      if (sh) {
        for (const s of sh.items) items.push({ kind: 'shell', ...s, code: null, ts });
        if (!sh.rest) continue;
      } else if (/^\s*<bash-std(out|err)>/.test(contentText(c))) {
        const last = items.at(-1);
        if (last?.kind === 'shell' && !last.stdout && !last.stderr) {
          last.stdout = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/.exec(contentText(c))?.[1].trimEnd() ?? '';
          last.stderr = /<bash-stderr>([\s\S]*?)<\/bash-stderr>/.exec(contentText(c))?.[1].trimEnd() ?? '';
        }
        continue;
      }
      const t = cleanPrompt(sh ? sh.rest : contentText(c));
      const images = imagesOf(c);
      if (t.startsWith('[Request interrupted')) items.push({ kind: 'note', text: 'Stopped', ts });
      else if (t || images.length) items.push({ kind: 'user', text: t, images, uuid: e.uuid ?? null, ts });
      continue;
    }
    if (e.type === 'assistant') {
      const uuid = e.uuid ?? null;
      for (const b of e.message?.content ?? []) {
        if (b?.type === 'thinking' && b.thinking?.trim()) items.push({ kind: 'thinking', text: b.thinking, uuid, ts });
        else if (b?.type === 'text' && b.text.trim()) items.push({ kind: 'assistant', text: b.text, uuid, ts });
        else if (b?.type === 'tool_use') items.push({ kind: 'tool', id: b.id, name: b.name, summary: toolSummary(b.name, b.input), input: b.input, uuid, ts });
      }
    }
  }
  const truncated = items.length > limit;
  const shown = truncated ? items.slice(-limit) : items;
  return { items: [...shown, ...agentItems(file.replace(/\.jsonl$/, ''), shown, before)], truncated };
}

// ── subagents and workflows ────────────────────────────────────────────────
// Their steps are not in the main transcript: each agent writes <session>/subagents/agent-<id>.jsonl (+ .meta.json
// naming the Agent call that launched it), and a workflow writes <session>/subagents/workflows/<run>/journal.jsonl
// and, once finished, <session>/workflows/<run>.json.
const MAX_AGENT_STEPS = 200;
const MAX_AGENT_BYTES = 16 * 1024 * 1024;
const agentCache = new Map(); // file -> {key, steps}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** One agent's steps as nested items (without `parent`), newest kept. Cached per file version. */
function agentSteps(file) {
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  const key = `${st.size}:${st.mtimeMs}`;
  const c = agentCache.get(file);
  if (c?.key === key) return c.steps;
  const start = Math.max(0, st.size - MAX_AGENT_BYTES);
  const steps = [];
  for (const e of parseLines(readRange(file, start, st.size - start), { dropFirst: start > 0 })) {
    if (e.type !== 'assistant') continue;
    const ts = e.timestamp ?? null;
    for (const b of e.message?.content ?? []) {
      if (b?.type === 'text' && b.text.trim()) steps.push({ kind: 'sub', text: b.text.slice(0, 2000), ts });
      else if (b?.type === 'tool_use' && b.name === HANDBACK) steps.push({ kind: 'sub', report: String(b.input?.message ?? '').slice(0, REPORT_MAX), ts });
      else if (b?.type === 'tool_use') steps.push({ kind: 'sub', tool: b.name, summary: toolSummary(b.name, b.input), ts });
    }
  }
  const kept = steps.slice(-MAX_AGENT_STEPS);
  if (agentCache.size > 400) agentCache.clear();
  agentCache.set(file, { key, steps: kept });
  return kept;
}

/** A workflow's progress from its files: the finished record if there is one, else the running journal. */
function workflowFromDisk(sessionDir, runId, parent, ts) {
  const done = readJson(path.join(sessionDir, 'workflows', `${runId}.json`));
  if (done?.workflowProgress) {
    const phaseDetails = Object.fromEntries((done.phases ?? []).filter(p => p?.title && p.detail).map(p => [p.title, String(p.detail)]));
    return workflowItem(parent, { progress: done.workflowProgress, name: done.workflowName ?? null, ts,
      status: done.status === 'completed' ? 'completed' : done.status === 'running' ? 'running' : 'failed',
      info: { description: done.summary ? String(done.summary).slice(0, 400) : null, durationMs: done.durationMs ?? null,
        tokens: done.totalTokens ?? null, tools: done.totalToolCalls ?? null, phaseDetails } });
  }
  let text;
  try { text = fs.readFileSync(path.join(sessionDir, 'subagents', 'workflows', runId, 'journal.jsonl'), 'utf8'); } catch { return null; }
  const agents = new Map();
  for (const j of parseLines(text)) {
    if (j.type === 'started') agents.set(j.agentId, { type: 'workflow_agent', agentId: j.agentId, label: j.label, phaseTitle: j.phase, state: 'start' });
    else if (j.type === 'result' && agents.has(j.agentId)) {
      const r = typeof j.result === 'string' ? j.result : j.result?.summary ?? JSON.stringify(j.result ?? '');
      Object.assign(agents.get(j.agentId), { state: 'done', resultPreview: r });
    } else if (j.type === 'error' && agents.has(j.agentId)) agents.get(j.agentId).state = 'failed';
  }
  // No finished record: it is still going, or the session ended under it — these files alone don't say which.
  return workflowItem(parent, { progress: [...agents.values()], status: 'unknown', ts });
}

const DETAIL_TEXT = 6000;

/** A workflow agent's prompt without Claude Code's "[Workflow harness — computed task] …" preamble and its indent. */
function unframe(text) {
  const m = /^\[Workflow harness[\s\S]*?follows:\n/.exec(text);
  if (!m) return text;
  const lines = text.slice(m[0].length).split('\n');
  const indent = Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^ */)[0].length));
  return lines.map(l => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
}
const clipText = (s, n) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);

/**
 * Everything one agent did, for the agent panel: the full prompt, each step (text, tool call with its input and what came
 * back), and its result (a StructuredOutput object, else its last words). Agents of Agent calls and of workflows alike.
 */
export function agentDetail(sessionDir, agentId) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(agentId))) return null;
  const sub = path.join(sessionDir, 'subagents');
  let file = path.join(sub, `agent-${agentId}.jsonl`);
  if (!fs.existsSync(file)) {
    let runs = [];
    try { runs = fs.readdirSync(path.join(sub, 'workflows')); } catch { /* no workflows */ }
    file = runs.map(r => path.join(sub, 'workflows', r, `agent-${agentId}.jsonl`)).find(f => fs.existsSync(f));
    // An Agent call's agent is known in the chat only by that call's id, which its .meta.json names.
    if (!file) {
      let metas = [];
      try { metas = fs.readdirSync(sub).filter(f => f.endsWith('.meta.json')); } catch { /* no agents */ }
      const m = metas.find(f => readJson(path.join(sub, f))?.toolUseId === agentId);
      file = m && path.join(sub, m.replace(/\.meta\.json$/, '.jsonl'));
    }
    if (!file) return null;
  }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const meta = readJson(file.replace(/\.jsonl$/, '.meta.json')) ?? {};
  const out = { prompt: null, model: null, startedAt: null, lastAt: null, steps: [], result: null, meta };
  const byId = new Map();
  let lastText = null;
  for (const e of parseLines(text)) {
    if (e.timestamp) { out.startedAt ??= e.timestamp; out.lastAt = e.timestamp; }
    const c = e.message?.content;
    if (e.type === 'user') {
      if (out.prompt == null) { out.prompt = clipText(unframe(contentText(c)), 60_000); continue; }
      for (const b of Array.isArray(c) ? c : []) {
        const step = b?.type === 'tool_result' && byId.get(b.tool_use_id);
        if (step) { step.result = clipText(resultText(b.content), DETAIL_TEXT); step.isError = !!b.is_error; }
      }
    } else if (e.type === 'assistant') {
      out.model ??= e.message?.model ?? null;
      for (const b of Array.isArray(c) ? c : []) {
        if (b?.type === 'text' && b.text.trim()) { lastText = b.text; out.steps.push({ kind: 'text', text: clipText(b.text, DETAIL_TEXT), ts: e.timestamp ?? null }); }
        else if (b?.type === 'tool_use' && b.name === 'StructuredOutput') out.result = b.input ?? null;
        else if (b?.type === 'tool_use') {
          const step = { kind: 'tool', id: b.id, name: b.name, summary: toolSummary(b.name, b.input),
            input: clipText(JSON.stringify(b.input ?? {}, null, 2), DETAIL_TEXT), result: null, isError: false, ts: e.timestamp ?? null };
          byId.set(b.id, step);
          out.steps.push(step);
        }
      }
    }
  }
  out.result ??= lastText;
  out.stepCount = out.steps.length;
  out.steps = out.steps.slice(-400);
  return out;
}

/** Nested items for the Agent and Workflow calls among `shown`. */
function agentItems(sessionDir, shown, before) {
  const tools = new Map(shown.filter(i => i.kind === 'tool').map(i => [i.id, i]));
  if (!tools.size) return [];
  const out = [];
  const subDir = path.join(sessionDir, 'subagents');
  let files = [];
  try { files = fs.readdirSync(subDir).filter(f => f.endsWith('.meta.json')); } catch { /* no agents in this session */ }
  for (const f of files) {
    const parent = readJson(path.join(subDir, f))?.toolUseId;
    if (!parent || !tools.has(parent)) continue;
    for (const s of agentSteps(path.join(subDir, f.replace(/\.meta\.json$/, '.jsonl')))) {
      if (before && s.ts && s.ts >= before) continue;
      out.push({ ...s, parent });
    }
  }
  for (const r of shown) {
    if (r.kind !== 'tool_result' || tools.get(r.id)?.name !== 'Workflow') continue;
    const runId = r.text.match(/\b(wf_[\w-]+)/)?.[1];
    const wf = runId && workflowFromDisk(sessionDir, runId, r.id, r.ts);
    if (wf) out.push(wf);
  }
  return out;
}

/** Tokens (input + output + cache writes; cache reads excluded) used today in this session, its agents included. */
export function tokensToday(file, today = new Date()) {
  const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
  let stat;
  try { stat = fs.statSync(file); } catch { return 0; }
  if (stat.mtimeMs < Date.parse(dayStart)) return 0;
  let total = 0;
  const seen = new Set(); // one API message is split across several entries, each repeating its usage
  for (const f of [file, ...agentTranscripts(file)]) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs < Date.parse(dayStart)) continue;
    for (const e of entriesSince(f, st.size, dayStart)) {
      if (e.type !== "assistant" || !e.timestamp || e.timestamp < dayStart) continue;
      const id = e.message?.id;
      if (id) { if (seen.has(id)) continue; seen.add(id); }
      const u = e.message?.usage;
      if (u) total += (u.output_tokens ?? 0) + (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }
  }
  return total;
}

/** A transcript's entries since `sinceIso`: reads a growing tail until it reaches back that far (or the whole file). */
function entriesSince(file, size, sinceIso) {
  let len = Math.min(size, 4 * 1024 * 1024);
  for (;;) {
    const start = size - len;
    const entries = parseLines(readRange(file, start, len), { dropFirst: start > 0 });
    const firstTs = entries.find(e => e.timestamp)?.timestamp;
    if (start > 0 && firstTs && firstTs >= sinceIso && len < size) { len = Math.min(size, len * 2); continue; }
    return entries;
  }
}
