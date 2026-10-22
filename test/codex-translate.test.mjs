// test/codex-translate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/protocol.mjs';
import { itemEvents, deltaEvent, approvalToPermission, permissionToApproval, jobDecision, jobConfig, sandboxChoice, turnResult, rateEvent, usageEntry, sumUsage } from '../src/codex-translate.mjs';

const kinds = evs => evs.flatMap(e => classify(e)).map(a => a.item?.kind ?? a.do);

test('an agent message and reasoning become Pit Wall items via the existing classify', () => {
  assert.deepEqual(kinds(itemEvents({ type: 'agentMessage', id: 'm1', text: 'Hi' }, { completed: true })), ['assistant']);
  assert.deepEqual(kinds(itemEvents({ type: 'reasoning', id: 'r1', summary: ['Looking'], content: [] }, { completed: true })), ['thinking']);
  assert.deepEqual(itemEvents({ type: 'reasoning', id: 'r2', summary: [], content: [] }, { completed: true }), []);
  assert.deepEqual(kinds([deltaEvent({ delta: 'H' })]), ['delta']);
});

test('a command shows as a Bash tool call, then its result', () => {
  const item = { type: 'commandExecution', id: 'c1', command: 'npm test', cwd: 'C:\r', status: 'inProgress', aggregatedOutput: null, exitCode: null };
  const start = itemEvents(item, { completed: false }).flatMap(e => classify(e));
  assert.equal(start[0].item.name, 'Bash');
  assert.equal(start[0].item.input.command, 'npm test');
  const done = itemEvents({ ...item, status: 'completed', aggregatedOutput: 'ok', exitCode: 1 }, { completed: true }).flatMap(e => classify(e));
  assert.deepEqual([done[0].item.kind, done[0].item.isError, done[0].item.text], ['tool_result', true, 'ok']);
  const fine = itemEvents({ ...item, status: 'completed', aggregatedOutput: 'ok', exitCode: 0 }, { completed: true }).flatMap(e => classify(e));
  assert.equal(fine[0].item.isError, false);
  const declined = itemEvents({ ...item, status: 'declined', exitCode: null }, { completed: true }).flatMap(e => classify(e));
  assert.equal(declined[0].item.isError, true);
});

test('file changes and MCP calls map to tool calls and results; other items are ignored', () => {
  const fc = { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: 'a.js', kind: { type: 'add' }, diff: '' }, { path: 'b.js', kind: { type: 'update', move_path: null }, diff: '' }] };
  const use = itemEvents({ ...fc, status: 'inProgress' }, { completed: false }).flatMap(e => classify(e));
  assert.deepEqual([use[0].item.name, use[0].item.input.file_path], ['Edit', 'a.js, b.js']);
  const res = itemEvents(fc, { completed: true }).flatMap(e => classify(e));
  assert.deepEqual([res[0].item.isError, res[0].item.text], [false, 'add a.js\nupdate b.js']);
  assert.equal(itemEvents({ ...fc, status: 'failed' }, { completed: true }).flatMap(e => classify(e))[0].item.isError, true);
  const mcp = { type: 'mcpToolCall', id: 'x1', server: 'gh', tool: 'list', arguments: { a: 1 }, status: 'completed', result: { content: [{ type: 'text', text: 'hi' }] }, error: null };
  assert.equal(itemEvents(mcp, { completed: false }).flatMap(e => classify(e))[0].item.name, 'mcp__gh__list');
  assert.equal(itemEvents(mcp, { completed: true }).flatMap(e => classify(e))[0].item.isError, false);
  assert.equal(itemEvents({ ...mcp, error: { message: 'boom' } }, { completed: true }).flatMap(e => classify(e))[0].item.isError, true);
  for (const type of ['userMessage', 'plan', 'webSearch']) assert.deepEqual(itemEvents({ type, id: 'z' }, { completed: true }), []);
  assert.deepEqual(itemEvents(null, { completed: true }), []);
});

test('approval requests become can_use_tool cards and answers map back', () => {
  const cmd = approvalToPermission(5, 'item/commandExecution/requestApproval', { command: 'rm x', cwd: 'C:\r', reason: 'cleanup', itemId: 'c1' });
  assert.equal(cmd.request.subtype, 'can_use_tool');
  assert.equal(cmd.request_id, 'codex-5');
  assert.equal(cmd.request.tool_name, 'Bash');
  assert.equal(cmd.request.input.command, 'rm x');
  assert.ok(cmd.request.permission_suggestions.length, 'offers "always" (accept for session)');
  assert.equal(classify(cmd)[0].do, 'permission');
  // The card says what Approve does; Codex's own reason is shown once, as the description
  assert.equal(cmd.request.decision_reason, 'Approve runs this outside the sandbox, with network access.');
  assert.equal(cmd.request.input.description, 'cleanup');
  const fc = approvalToPermission(6, 'item/fileChange/requestApproval', { reason: 'write a.txt', grantRoot: null });
  assert.equal(fc.request.decision_reason, 'Approve writes these files outside the sandbox.');
  assert.equal(approvalToPermission(7, 'item/permissions/requestApproval', { reason: 'needs net', permissions: {} }).request.decision_reason, 'needs net');
  const allow = { behavior: 'allow', updatedInput: {} };
  assert.deepEqual(permissionToApproval('item/commandExecution/requestApproval', {}, allow), { decision: 'accept' });
  assert.deepEqual(permissionToApproval('item/fileChange/requestApproval', {}, { ...allow, updatedPermissions: [{}] }), { decision: 'acceptForSession' });
  assert.deepEqual(permissionToApproval('item/fileChange/requestApproval', {}, { behavior: 'deny' }), { decision: 'decline' });
  const perm = { permissions: { network: { enabled: true } }, reason: 'needs net', cwd: 'C:\r' };
  assert.deepEqual(permissionToApproval('item/permissions/requestApproval', perm, allow), { permissions: perm.permissions, scope: 'turn' });
  assert.deepEqual(permissionToApproval('item/permissions/requestApproval', perm, { behavior: 'deny' }), { permissions: {}, scope: 'turn' });
});

test('request ids round-trip', async () => {
  const { requestId, rpcId } = await import('../src/codex-translate.mjs');
  assert.equal(requestId(7), 'codex-7');
  assert.equal(rpcId('codex-7'), 7);
  assert.equal(rpcId('codex-abc'), 'abc');
});

test('job policy declines everything, blocked or not', () => {
  for (const [m, p] of [['item/commandExecution/requestApproval', { command: 'git push' }], ['item/commandExecution/requestApproval', { command: 'ls' }],
    ['item/fileChange/requestApproval', {}]]) assert.deepEqual(jobDecision(m, p, ['git push']), { decision: 'decline' });
  assert.deepEqual(jobDecision('item/permissions/requestApproval', { permissions: { network: {} } }, []), { permissions: {}, scope: 'turn' });
});

test('turn results and rate windows', () => {
  const ok = classify(turnResult({ status: 'completed', error: null }, null))[0];
  assert.deepEqual([ok.do, ok.isError], ['turn_end', false]);
  const bad = classify(turnResult({ status: 'failed', error: { message: 'Usage limit reached' } }, null))[0];
  assert.deepEqual([bad.isError, bad.text], [true, 'Usage limit reached']);
  const r = rateEvent({ primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1791460000 }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1791900000 }, planType: 'plus' });
  assert.equal(r.type, 'codex_rate_event');
  assert.deepEqual(r.rate_limit_info.unifiedWindows.five_hour, { utilization: 0.42, resetsAt: 1791460000 });
  assert.deepEqual(r.rate_limit_info.unifiedWindows.seven_day, { utilization: 0.1, resetsAt: 1791900000 });
});

test('jobConfig switches off apps, plugins and every configured MCP server', () => {
  assert.deepEqual(jobConfig({ mcp_servers: { a: { command: 'x' }, 'b.c': { url: 'u', enabled: true } } }),
    { features: { apps: false, plugins: false }, mcp_servers: { a: { enabled: false }, 'b.c': { enabled: false } } });
  assert.deepEqual(jobConfig({ mcp_servers: null }), { features: { apps: false, plugins: false } });
});

test('sandboxChoice: workspace-write only on a positive answer; Windows fails closed', () => {
  const ws = { sandbox: 'workspace-write', config: {} };
  const ro = { sandbox: 'read-only', config: { 'windows.sandbox': 'unelevated' } };
  assert.deepEqual(sandboxChoice(null, null, 'linux'), ws); // not a Windows Codex
  assert.deepEqual(sandboxChoice(null, null, 'darwin'), ws);
  assert.deepEqual(sandboxChoice(null, null, 'win32'), ro); // readiness failed or timed out on Windows
  assert.deepEqual(sandboxChoice('ready', { windows: { sandbox: 'elevated' } }, 'win32'), ws);
  assert.deepEqual(sandboxChoice('ready', {}, 'win32'), ws);
  assert.deepEqual(sandboxChoice('ready', null, 'win32'), ro); // config/read failed: can't rule out unelevated
  assert.deepEqual(sandboxChoice('ready', { windows: { sandbox: 'unelevated' } }, 'win32'), ro); // unelevated refuses workspace-write
  assert.deepEqual(sandboxChoice('notConfigured', {}, 'win32'), ro); // nothing enforced at all
  assert.deepEqual(sandboxChoice('updateRequired', {}, 'win32'), ro);
});

test('usageEntry maps a Codex model call to Claude usage', () => {
  const e = usageEntry('turn-1', 2, { inputTokens: 100, cachedInputTokens: 60, outputTokens: 5, reasoningOutputTokens: 7 }, 'gpt-6.1-sol');
  assert.deepEqual(e.message.usage, { input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 12 });
  assert.equal(e.message.id, 'codex-usage-turn-1-2');
  assert.deepEqual(e.message.content, []);
  assert.equal(e.message.model, 'gpt-6.1-sol');
  assert.equal(e.type, 'assistant');
  assert.equal(e.message.role, 'assistant');
  assert.deepEqual(usageEntry('t', 1, {}, 'm').message.usage, { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, 'missing fields → 0');
});

test('sumUsage adds, null-safe', () => {
  assert.deepEqual(sumUsage(null, { input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3 }), { input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3 });
  assert.deepEqual(sumUsage({ input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3 }, { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 30 }),
    { input_tokens: 11, cache_read_input_tokens: 22, output_tokens: 33 });
  assert.deepEqual(sumUsage({ input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3 }, null), { input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3 });
});
