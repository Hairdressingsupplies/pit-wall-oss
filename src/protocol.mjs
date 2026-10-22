// Claude Code stream-json protocol: building what we send, and turning what we receive
// into display items. Pure functions — no processes — so they can be unit-tested.

export const PERMISSION_MODES = ['manual', 'acceptEdits', 'auto', 'plan']; // never bypassPermissions / dontAsk

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** extras: what a terminal session gets from your settings but headless mode needs told (effort, Chrome). */
export function buildArgs({ sessionId, resume, forkFrom, resumeAt, name, model, permissionMode, effort, chrome, disallowedTools }) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool', 'stdio',
    // Echoes each message back, with Pit Wall's own uuid, when Claude actually picks it up (clears "Queued").
    '--replay-user-messages',
  ];
  if (permissionMode) {
    if (!PERMISSION_MODES.includes(permissionMode)) throw new Error(`Permission mode not allowed: ${permissionMode}`);
    args.push('--permission-mode', permissionMode);
  }
  if (model) args.push('--model', model);
  if (effort && EFFORTS.includes(effort)) args.push('--effort', effort);
  if (chrome) args.push('--chrome');
  // Hard blocks enforced by Claude Code itself (used for unattended queue jobs), not just asked for in a prompt.
  if (disallowedTools?.length) args.push('--disallowedTools', disallowedTools.join(','));
  if (name) args.push('-n', name);
  // A fork: a copy of forkFrom (up to and including resumeAt, an assistant entry, if given) under the new id.
  if (forkFrom) args.push('--resume', forkFrom, '--fork-session', ...(resumeAt ? ['--resume-session-at', resumeAt] : []), '--session-id', sessionId);
  else args.push(resume ? '--resume' : '--session-id', sessionId);
  return args;
}

// Variables a running Claude Code session sets for its own children. Inherited, they would make a
// Pit Wall session think it is a sub-process of whichever terminal started Pit Wall. Anything else
// (including CLAUDE_CODE_* settings you set yourself) passes through untouched.
const SESSION_VARS = new Set([
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SSE_PORT',
]);

/** Environment for a child: the parent's, minus the variables that tie it to one particular session. */
export function childEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!SESSION_VARS.has(k)) out[k] = v;
  return out;
}

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MAX_IMAGES = 6;
const MAX_IMAGE_B64 = 7_000_000; // ≈5 MB of image, Claude's per-image limit

/** Checks images from the browser: [{mediaType, data(base64)}]. Returns a clean list or throws a readable error. */
export function validateImages(images) {
  if (images == null) return [];
  if (!Array.isArray(images)) throw new Error('Images must be a list.');
  if (images.length > MAX_IMAGES) throw new Error(`Send at most ${MAX_IMAGES} images at a time.`);
  return images.map((img, i) => {
    const mediaType = String(img?.mediaType ?? '');
    const data = String(img?.data ?? '');
    if (!IMAGE_TYPES.includes(mediaType)) throw new Error(`Image ${i + 1} is not a PNG, JPEG, GIF or WebP.`);
    if (!data || data.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error(`Image ${i + 1} is too large or unreadable.`);
    return { mediaType, data };
  });
}

/**
 * A user turn: plain text, or image blocks followed by the text. uuid: Pit Wall's id for it (kept in the transcript, used
 * to rewind to it or take it back while queued). priority 'now': interrupt the current turn and start this one.
 */
export function userMessage(text, images = [], { uuid, priority } = {}) {
  const extra = { ...(uuid ? { uuid } : {}), ...(priority ? { priority } : {}) };
  if (!images.length) return { type: 'user', message: { role: 'user', content: text }, ...extra };
  const content = images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } }));
  if (text) content.push({ type: 'text', text });
  return { type: 'user', message: { role: 'user', content }, ...extra };
}

/** A request Pit Wall makes of Claude Code (side_question, rewind_conversation, set_model …); answered by a control_response. */
export const controlRequest = (id, subtype, body = {}) => ({ type: 'control_request', request_id: id, request: { subtype, ...body } });

export const interruptRequest = id => ({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } });

/**
 * Answer to a can_use_tool request.
 * decision: {behavior:'allow'|'deny', always?:boolean, answers?:{[question]:label}, message?:string}
 */
export function permissionResponse(requestId, request, decision) {
  let response;
  if (decision.behavior === 'allow') {
    const updatedInput = decision.answers ? { ...request.input, answers: decision.answers } : request.input;
    response = { behavior: 'allow', updatedInput };
    if (decision.always && Array.isArray(request.permission_suggestions) && request.permission_suggestions.length) {
      response.updatedPermissions = request.permission_suggestions;
    }
  } else {
    response = { behavior: 'deny', message: decision.message || 'Denied from Pit Wall.' };
  }
  return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } };
}

function toolSummary(input = {}) {
  const pick = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query
    ?? input.description ?? input.prompt ?? input.skill ?? '';
  return String(pick).replace(/\s+/g, ' ').slice(0, 160);
}

// A subagent hands its final report back to the session that launched it through this tool.
export const HANDBACK = 'SubagentHandback';
export const REPORT_MAX = 20_000;

/** Agents and workflows are work Claude is still doing for you; a background shell command (a dev server) is not. */
export const isAgentWork = type => /agent|workflow/i.test(String(type ?? ''));

/**
 * Still working for you: an agent or workflow, or a shell command Claude was waiting on that the 2-minute tool
 * timeout pushed into the background (it carries on once that finishes). A command Claude started in the
 * background on purpose (a dev server) is not.
 */
export const isWork = t => isAgentWork(t?.type) || !!t?.awaited;

const AGENT_STATES = { start: 'running', started: 'running', running: 'running', queued: 'queued', done: 'done', completed: 'done', failed: 'failed', error: 'failed' };

/**
 * A workflow's progress as one display item, shown inside the Workflow call that launched it.
 * progress: Claude Code's list of {type:'workflow_phase', title} and {type:'workflow_agent', label, phaseTitle, state…}.
 */
export function workflowItem(parent, { progress = [], status = 'running', name = null, ts = null, info = null } = {}) {
  const phases = progress.filter(p => p?.type === 'workflow_phase').map(p => String(p.title ?? ''));
  const num = v => (Number.isFinite(v) ? v : null);
  // Kept short: this goes to the page on every progress update. The agent panel loads the full prompt and result on demand.
  const agents = progress.filter(p => p?.type === 'workflow_agent').map(a => ({
    id: a.agentId ?? null, label: String(a.label ?? a.agentId ?? 'agent').slice(0, 120), phase: a.phaseTitle ?? null,
    state: AGENT_STATES[a.state] ?? String(a.state ?? 'queued'),
    model: a.model ?? null, startedAt: num(a.startedAt), lastAt: num(a.lastProgressAt), durationMs: num(a.durationMs),
    tokens: num(a.tokens), tools: num(a.toolCalls), lastTool: a.lastToolName ?? null, attempt: num(a.attempt) ?? 1,
    prompt: a.promptPreview ? String(a.promptPreview).slice(0, 200) : null,
    result: a.resultPreview ? String(a.resultPreview).slice(0, 300) : null,
  }));
  for (const a of agents) if (a.phase && !phases.includes(a.phase)) phases.push(a.phase);
  return { kind: 'workflow', parent, name, status, phases, agents, ts, ...(info ? { info } : {}) };
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

/**
 * Classify one stdout event. Returns a list of actions for the runner:
 *  {do:'init', model, permissionMode} · {do:'delta', text} · {do:'activity', what, chars} · {do:'tokens', n} · {do:'item', item} · {do:'turn_end', isError, subtype, costUsd}
 *  {do:'permission', requestId, request} · {do:'cancel', requestId} · {do:'rate', info} · {do:'busy'}
 *  {do:'task_start', task} · {do:'task_progress', id} · {do:'task_end', id} · {do:'task_background', id, background}
 *  {do:'bg_tasks', tasks} · {do:'workflow', item} · {do:'ready'} · {do:'picked', uuid} · {do:'control_response', requestId, ok, response, error}
 */
export function classify(e, now = () => new Date().toISOString()) {
  const ts = now();
  switch (e.type) {
    case 'system':
      if (e.subtype === 'init') {
        // Terminal-only commands are listed in slash_commands too, but do nothing in a headless chat.
        const terminalOnly = new Set(e.terminal_slash_commands ?? []);
        const slashCommands = Array.isArray(e.slash_commands) ? e.slash_commands.filter(n => !terminalOnly.has(n)) : null;
        // branching: only the Codex bridge sends it (that chat has a turn map, so it can fork and rewind).
        return [{ do: 'init', model: e.model, permissionMode: e.permissionMode, sessionId: e.session_id, slashCommands, ...('branching' in e ? { branching: e.branching } : {}) }];
      }
      // Sent when a resumed session is ready for input; writing before it can stall a resumed fork.
      if (e.subtype === 'status') return [{ do: 'ready' }];
      if (e.subtype === 'api_retry') return [{ do: 'item', item: { kind: 'note', text: `API retry (attempt ${e.attempt ?? '?'})…`, ts } }];
      if (e.subtype === 'task_started') return [{ do: 'task_start', task: { id: e.task_id, toolUseId: e.tool_use_id ?? null,
        type: e.task_type ?? null, description: e.workflow_name ?? e.description ?? '', background: e.is_backgrounded ?? true,
        // A command started in the foreground: Claude was waiting for it. A missing flag (older CLI) counts as not
        // awaited. Agents and workflows are work anyway, with no time cap.
        awaited: e.is_backgrounded === false && !isAgentWork(e.task_type) } }];
      if (e.subtype === 'task_progress') {
        const out = [{ do: 'task_progress', id: e.task_id, description: e.description ?? null }];
        if (Array.isArray(e.workflow_progress) && e.tool_use_id) {
          out.push({ do: 'workflow', item: workflowItem(e.tool_use_id, { progress: e.workflow_progress, status: 'running', ts }) });
        }
        return out;
      }
      if (e.subtype === 'task_notification' && e.status !== 'running') return [{ do: 'task_end', id: e.task_id, status: e.status ?? null }];
      if (e.subtype === 'task_updated') {
        const st = e.patch?.status;
        if (st && st !== 'running' && st !== 'pending') return [{ do: 'task_end', id: e.task_id, status: st }];
        if (typeof e.patch?.is_backgrounded === 'boolean') return [{ do: 'task_background', id: e.task_id, background: e.patch.is_backgrounded }];
        return [];
      }
      // The authoritative list of what is still running in the background after the turn has ended.
      if (e.subtype === 'background_tasks_changed' && Array.isArray(e.tasks)) {
        return [{ do: 'bg_tasks', tasks: e.tasks.map(t => ({ id: t.task_id, type: t.task_type ?? null, description: t.description ?? '' })) }];
      }
      if (e.subtype === 'compact_boundary') return [{ do: 'item', item: { kind: 'note', text: 'Conversation compacted', ts } }];
      return [];
    case 'stream_event': {
      if (e.parent_tool_use_id) return []; // a subagent typing — shown once its message is complete
      const ev = e.event;
      if (ev?.type === 'message_start') return [{ do: 'busy' }];
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') return [{ do: 'delta', text: ev.delta.text }];
      // For the "✻ Pondering… (12s · ↓ 1.2k tokens · thinking)" line: what Claude is doing and how much it has written.
      if (ev?.type === 'content_block_start' && ev.content_block?.type === 'thinking') return [{ do: 'activity', what: 'thinking', chars: 0 }];
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') return [{ do: 'activity', what: 'thinking', chars: (ev.delta.thinking ?? '').length }];
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta') return [{ do: 'activity', what: null, chars: (ev.delta.partial_json ?? '').length }];
      if (ev?.type === 'message_delta' && ev.usage?.output_tokens != null) return [{ do: 'tokens', n: ev.usage.output_tokens }];
      return [];
    }
    case 'assistant': {
      if (e.parent_tool_use_id) {
        // A subagent's step: shown nested under the Task/Agent call that launched it.
        const out = [];
        for (const b of e.message?.content ?? []) {
          if (b?.type === 'text' && b.text.trim()) out.push({ do: 'item', item: { kind: 'sub', parent: e.parent_tool_use_id, text: b.text.slice(0, 2000), ts } });
          else if (b?.type === 'tool_use' && b.name === HANDBACK) out.push({ do: 'item', item: { kind: 'sub', parent: e.parent_tool_use_id, report: String(b.input?.message ?? '').slice(0, REPORT_MAX), ts } });
          else if (b?.type === 'tool_use') out.push({ do: 'item', item: { kind: 'sub', parent: e.parent_tool_use_id, tool: b.name, summary: toolSummary(b.input), ts } });
        }
        return out;
      }
      const out = [];
      const uuid = e.uuid ?? null; // the transcript entry: fork from here
      for (const b of e.message?.content ?? []) {
        if (b?.type === 'thinking' && b.thinking?.trim()) out.push({ do: 'item', item: { kind: 'thinking', text: b.thinking, uuid, ts } });
        else if (b?.type === 'text' && b.text.trim()) out.push({ do: 'item', item: { kind: 'assistant', text: b.text, uuid, ts } });
        else if (b?.type === 'tool_use') out.push({ do: 'item', item: { kind: 'tool', id: b.id, name: b.name, summary: toolSummary(b.input), input: b.input, uuid, ts } });
      }
      return out;
    }
    case 'user': {
      // Our own message coming back: Claude has picked it up (it was queued until now).
      if (e.isReplay) return e.uuid ? [{ do: 'picked', uuid: e.uuid }] : [];
      if (e.parent_tool_use_id) return [];
      const c = e.message?.content;
      if (!Array.isArray(c)) return [];
      return c.filter(b => b?.type === 'tool_result').map(b => ({
        do: 'item', item: { kind: 'tool_result', id: b.tool_use_id, isError: !!b.is_error, text: resultText(b.content).slice(0, 4000), ts },
      }));
    }
    case 'result':
      return [{ do: 'turn_end', isError: !!e.is_error, subtype: e.subtype, costUsd: e.total_cost_usd ?? null, text: e.is_error ? (e.result ?? e.subtype) : null }];
    case 'control_request':
      if (e.request?.subtype === 'can_use_tool') return [{ do: 'permission', requestId: e.request_id, request: e.request }];
      return [];
    case 'control_response': {
      const r = e.response ?? {};
      return [{ do: 'control_response', requestId: r.request_id, ok: r.subtype === 'success', response: r.response ?? null, error: r.error ?? null }];
    }
    case 'control_cancel_request':
      return [{ do: 'cancel', requestId: e.request_id }];
    case 'rate_limit_event':
      return [{ do: 'rate', info: e.rate_limit_info }];
    case 'codex_rate_event': // Codex chats only (src/codex-bridge.mjs); kept apart from Claude's gauge and queue gate
      return [{ do: 'rate_codex', info: e.rate_limit_info }];
    default:
      return [];
  }
}
