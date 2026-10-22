// Codex app-server ⇄ the Claude Code stream-json events Pit Wall's Runner already understands. Pure functions.

const assistant = (uuid, content) => ({ type: 'assistant', uuid, message: { role: 'assistant', content } });
const toolResult = (id, isError, text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: !!isError, content: String(text ?? '') }] } });

function toolUse(item) {
  if (item.type === 'commandExecution') return { type: 'tool_use', id: item.id, name: 'Bash', input: { command: item.command, cwd: item.cwd } };
  if (item.type === 'fileChange') return { type: 'tool_use', id: item.id, name: 'Edit', input: { file_path: (item.changes ?? []).map(c => c.path).join(', '), changes: item.changes ?? [] } };
  if (item.type === 'mcpToolCall') return { type: 'tool_use', id: item.id, name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} };
  return null;
}

function resultOf(item) {
  if (item.type === 'commandExecution') return toolResult(item.id, (item.exitCode ?? 0) !== 0 || item.status === 'failed' || item.status === 'declined', item.aggregatedOutput ?? '');
  if (item.type === 'fileChange') return toolResult(item.id, item.status !== 'completed', (item.changes ?? []).map(c => `${c.kind?.type ?? 'update'} ${c.path}`).join('\n'));
  if (item.type === 'mcpToolCall') return toolResult(item.id, !!item.error || item.status === 'failed', item.error ? (item.error.message ?? 'MCP error') : JSON.stringify(item.result?.content ?? item.result ?? ''));
  return null;
}

/** One app-server item (started or completed) → Claude events. */
export function itemEvents(item, { completed } = {}) {
  if (!item) return [];
  if (item.type === 'agentMessage') return completed && item.text?.trim() ? [assistant(item.id, [{ type: 'text', text: item.text }])] : [];
  if (item.type === 'reasoning') {
    const t = [...(item.summary ?? []), ...(item.content ?? [])].join('\n').trim();
    return completed && t ? [assistant(item.id, [{ type: 'thinking', thinking: t }])] : [];
  }
  const use = toolUse(item);
  if (!use) return [];
  return completed ? [resultOf(item)] : [assistant(`${item.id}-use`, [use])];
}

export const deltaEvent = p => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: p.delta ?? '' } } });

export const requestId = id => `codex-${id}`;
export const rpcId = rid => { const s = String(rid).replace(/^codex-/, ''); return /^\d+$/.test(s) ? Number(s) : s; };

const ALWAYS = [{ type: 'codexAcceptForSession' }]; // non-empty → Pit Wall offers "always"; it comes back as updatedPermissions
// What Approve really does (checked on 0.161): an approved escalation runs outside the sandbox, network included.
// Codex's own reason stays in input.description; the card's reason line is this fixed warning instead (no duplicate).
export const OUTSIDE_SANDBOX = {
  'item/commandExecution/requestApproval': 'Approve runs this outside the sandbox, with network access.',
  'item/fileChange/requestApproval': 'Approve writes these files outside the sandbox.',
};

/** An approval the app-server asks for → a Claude can_use_tool card. */
export function approvalToPermission(id, method, p) {
  let tool_name, input;
  if (method === 'item/commandExecution/requestApproval') { tool_name = 'Bash'; input = { command: p.command ?? '', cwd: p.cwd ?? null, description: p.reason ?? undefined }; }
  else if (method === 'item/fileChange/requestApproval') { tool_name = 'Edit'; input = { file_path: p.grantRoot ?? '(files in this change)', description: p.reason ?? undefined }; }
  else { tool_name = 'Permissions'; input = { description: p.reason ?? 'Codex asks for more access', permissions: p.permissions ?? {}, cwd: p.cwd ?? null }; }
  return { type: 'control_request', request_id: requestId(id),
    request: { subtype: 'can_use_tool', tool_name, input, decision_reason: OUTSIDE_SANDBOX[method] ?? p.reason ?? null, permission_suggestions: ALWAYS } };
}

/** Pit Wall's answer (control_response.response.response) → the app-server reply. */
export function permissionToApproval(method, p, r) {
  const allow = r?.behavior === 'allow';
  const always = allow && Array.isArray(r.updatedPermissions) && r.updatedPermissions.length > 0;
  if (method === 'item/permissions/requestApproval') return allow ? { permissions: p.permissions ?? {}, scope: always ? 'session' : 'turn' } : { permissions: {}, scope: 'turn' };
  return { decision: allow ? (always ? 'acceptForSession' : 'accept') : 'decline' };
}

/** Unattended jobs: nobody to ask, so every approval is declined (blocked commands and sandbox escapes included). */
export function jobDecision(method) {
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  return { decision: 'decline' };
}

/**
 * Thread config overrides for an unattended job: no ChatGPT apps/connectors, no plugins, every MCP server off.
 * `cfg` is config/read's effective config. Disabling servers one by one is needed: an empty mcp_servers table
 * merges with config.toml instead of replacing it (checked on Codex 0.161). Nested, as a server name may hold a dot.
 */
export function jobConfig(cfg) {
  const names = Object.keys(cfg?.mcp_servers ?? {});
  return { features: { apps: false, plugins: false }, ...(names.length ? { mcp_servers: Object.fromEntries(names.map(n => [n, { enabled: false }])) } : {}) };
}

/**
 * The sandbox a thread asks for. Checked on Codex 0.161 / Windows 11 with `command/exec`:
 * - readiness "notConfigured" (no `windows.sandbox` set): Codex enforces nothing. A readOnly command wrote a file, and
 *   curl with networkAccess:false reached the internet.
 * - "unelevated" (restricted token, no admin, no setup): readOnly is enforced (writes "Access is denied", curl blocked),
 *   but workspaceWrite is refused outright ("cannot enforce split writable root sets"), so every command would need approval.
 * - "elevated" (`codex sandbox setup --elevated`, needs admin once): the intended workspace-write sandbox.
 * So: a working sandbox that isn't the unelevated one → workspace-write; anything else → unelevated read-only, where
 * reads run sandboxed and every write or network use comes as an approval card (declined for jobs).
 * Fails closed on Windows: workspace-write only on a positive answer. `readiness` null means the probe failed or timed out;
 * that is "not a Windows Codex" (workspace-write as on any other OS) only when we aren't on Windows. `cfg` null means
 * config/read failed: we can't rule out an explicit unelevated setting, so read-only too.
 */
export function sandboxChoice(readiness, cfg, platform = process.platform) {
  const ws = { sandbox: 'workspace-write', config: {} };
  if (readiness == null && platform !== 'win32') return ws;
  if (readiness === 'ready' && cfg && cfg.windows?.sandbox !== 'unelevated') return ws;
  return { sandbox: 'read-only', config: { 'windows.sandbox': 'unelevated' } };
}

/** Codex's thread/revert changes history only: the rewind dialog shows this instead of "Also undo … files". */
export const NO_FILE_UNDO = "Codex rewind doesn't undo file changes.";

/** turn/completed → Claude's result event (tokens only; Codex reports no $ cost). */
export function turnResult(turn, usage) {
  const failed = turn?.status === 'failed';
  return { type: 'result', subtype: turn?.status === 'interrupted' ? 'interrupted' : failed ? 'error' : 'success', is_error: failed,
    result: failed ? (turn.error?.message ?? 'Codex turn failed') : null, total_cost_usd: null, usage: usage ?? null };
}

/**
 * One Codex model call (TokenUsageBreakdown `last`) → a transcript-only assistant entry with no content, so insights,
 * the board's context badge and tokens-today count Codex as they count Claude. Reasoning tokens are billed as output.
 */
export function usageEntry(turnId, n, last, model) {
  const l = last ?? {};
  return { type: 'assistant', message: { id: `codex-usage-${turnId}-${n}`, role: 'assistant', model, content: [],
    usage: { input_tokens: (l.inputTokens ?? 0) - (l.cachedInputTokens ?? 0), cache_read_input_tokens: l.cachedInputTokens ?? 0,
      output_tokens: (l.outputTokens ?? 0) + (l.reasoningOutputTokens ?? 0) } } };
}

const USAGE_KEYS = ['input_tokens', 'cache_read_input_tokens', 'output_tokens'];
/** Two Claude-shaped usage objects added (either may be null). */
export const sumUsage = (a, b) => Object.fromEntries(USAGE_KEYS.map(k => [k, (a?.[k] ?? 0) + (b?.[k] ?? 0)]));

const windowKey = w => (w?.windowDurationMins ?? 0) <= 24 * 60 ? 'five_hour' : 'seven_day';

/** A Codex RateLimitSnapshot → Pit Wall's gauge/gate shape, under a type Claude never sends. */
export function rateEvent(s) {
  const unifiedWindows = {};
  for (const w of [s?.primary, s?.secondary]) if (w) unifiedWindows[windowKey(w)] = { utilization: (w.usedPercent ?? 0) / 100, resetsAt: w.resetsAt ?? null };
  return { type: 'codex_rate_event', rate_limit_info: { unifiedWindows, planType: s?.planType ?? null } };
}
