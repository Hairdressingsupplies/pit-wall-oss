import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, childEnv, classify, permissionResponse, userMessage, validateImages } from '../src/protocol.mjs';

test('buildArgs routes permissions to the host and never bypasses them', () => {
  const a = buildArgs({ sessionId: 'abc', resume: false, name: 'Fix', model: 'haiku', permissionMode: 'acceptEdits' });
  assert.deepEqual(a.slice(a.indexOf('--permission-prompt-tool'), a.indexOf('--permission-prompt-tool') + 2), ['--permission-prompt-tool', 'stdio']);
  assert.ok(a.includes('--session-id') && a.includes('abc'));
  assert.ok(!a.some(x => /bypass|dangerously|dontAsk/i.test(x)));
  assert.throws(() => buildArgs({ sessionId: 'x', permissionMode: 'bypassPermissions' }));
  assert.throws(() => buildArgs({ sessionId: 'x', permissionMode: 'dontAsk' }));
  const r = buildArgs({ sessionId: 'abc', resume: true });
  assert.equal(r[r.indexOf('--resume') + 1], 'abc');
  assert.ok(!r.includes('--permission-mode'), 'omits mode so the user’s usual setting applies');
});

test('childEnv strips the parent session’s own variables but keeps settings you set', () => {
  const env = childEnv({ PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_PID: '9',
    CLAUDE_EFFORT: 'high', ANTHROPIC_MODEL: 'x', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000', CLAUDE_CODE_GIT_BASH_PATH: 'b' });
  assert.deepEqual(env, { PATH: 'p', ANTHROPIC_MODEL: 'x', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000', CLAUDE_CODE_GIT_BASH_PATH: 'b' });
});

test('buildArgs passes effort and Chrome like a terminal session gets them', () => {
  const a = buildArgs({ sessionId: 'x', effort: 'medium', chrome: true });
  assert.equal(a[a.indexOf('--effort') + 1], 'medium');
  assert.ok(a.includes('--chrome'));
  assert.ok(!buildArgs({ sessionId: 'x', effort: 'bogus' }).includes('--effort'));
});

test('permissionResponse: allow, always-allow, question answers, deny', () => {
  const req = { input: { command: 'ls' }, permission_suggestions: [{ type: 'addRules' }] };
  assert.deepEqual(permissionResponse('r1', req, { behavior: 'allow' }).response,
    { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { command: 'ls' } } });
  assert.deepEqual(permissionResponse('r1', req, { behavior: 'allow', always: true }).response.response.updatedPermissions, [{ type: 'addRules' }]);
  const q = { input: { questions: [{ question: 'Colour?' }] } };
  assert.deepEqual(permissionResponse('r2', q, { behavior: 'allow', answers: { 'Colour?': 'Red' } }).response.response.updatedInput,
    { questions: [{ question: 'Colour?' }], answers: { 'Colour?': 'Red' } });
  assert.equal(permissionResponse('r3', req, { behavior: 'deny' }).response.response.behavior, 'deny');
});

test('classify maps stream events to runner actions', () => {
  const now = () => 'T';
  assert.deepEqual(classify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } }, now), [{ do: 'delta', text: 'hi' }]);
  const perm = classify({ type: 'control_request', request_id: 'q', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } }, now);
  assert.equal(perm[0].do, 'permission');
  assert.deepEqual(classify({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'text', text: 'sub' }, { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } }] } }, now),
    [{ do: 'item', item: { kind: 'sub', parent: 'x', text: 'sub', ts: 'T' } }, { do: 'item', item: { kind: 'sub', parent: 'x', tool: 'Grep', summary: 'foo', ts: 'T' } }]);
  assert.deepEqual(classify({ type: 'stream_event', parent_tool_use_id: 'x', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } }, now), [],
    'subagent typing does not leak into the main reply');
  const items = classify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }, now);
  assert.deepEqual(items.map(i => i.item.kind), ['assistant', 'tool']);
  assert.equal(classify({ type: 'result', is_error: false, total_cost_usd: 0.1 }, now)[0].do, 'turn_end');
  assert.equal(classify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, now)[0].do, 'rate');
});

test('userMessage sends images as blocks before the text', () => {
  const m = userMessage('What is this?', [{ mediaType: 'image/png', data: 'AAAA' }]);
  assert.deepEqual(m.message.content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'text', text: 'What is this?' },
  ]);
  assert.equal(userMessage('plain').message.content, 'plain');
  assert.equal(userMessage('', [{ mediaType: 'image/jpeg', data: 'AA==' }]).message.content.length, 1);
});

test('validateImages accepts real image types and rejects the rest', () => {
  assert.deepEqual(validateImages(undefined), []);
  assert.deepEqual(validateImages([{ mediaType: 'image/webp', data: 'QUJD', extra: 1 }]), [{ mediaType: 'image/webp', data: 'QUJD' }]);
  assert.throws(() => validateImages([{ mediaType: 'image/svg+xml', data: 'QUJD' }]), /PNG, JPEG, GIF or WebP/);
  assert.throws(() => validateImages([{ mediaType: 'image/png', data: 'not base64!' }]), /too large or unreadable/);
  assert.throws(() => validateImages(Array(7).fill({ mediaType: 'image/png', data: 'QUJD' })), /at most 6/);
});

test('classify passes thinking, tool-input typing and token counts through for the working line', () => {
  const now = () => '2026-10-05T10:00:00.000Z';
  const ev = event => classify({ type: 'stream_event', event }, now);
  assert.deepEqual(ev({ type: 'content_block_start', content_block: { type: 'thinking' } }), [{ do: 'activity', what: 'thinking', chars: 0 }]);
  assert.deepEqual(ev({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm…' } }), [{ do: 'activity', what: 'thinking', chars: 4 }]);
  assert.deepEqual(ev({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"a":1}' } }), [{ do: 'activity', what: null, chars: 7 }]);
  assert.deepEqual(ev({ type: 'message_delta', usage: { output_tokens: 321 } }), [{ do: 'tokens', n: 321 }]);
  assert.deepEqual(classify({ type: 'stream_event', parent_tool_use_id: 'x', event: { type: 'message_delta', usage: { output_tokens: 5 } } }, now), []);
});

test('terminal parity: fork args, message ids/priority, control requests and the new events', async () => {
  const { buildArgs, userMessage, controlRequest } = await import('../src/protocol.mjs');
  const now = () => 't';
  const fork = buildArgs({ sessionId: 'new', forkFrom: 'old', resumeAt: 'a1' });
  assert.deepEqual(fork.slice(-7), ['--resume', 'old', '--fork-session', '--resume-session-at', 'a1', '--session-id', 'new']);
  assert.ok(buildArgs({ sessionId: 's' }).includes('--replay-user-messages'));
  assert.deepEqual(userMessage('hi', [], { uuid: 'u1', priority: 'now' }), { type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1', priority: 'now' });
  assert.deepEqual(controlRequest('r1', 'side_question', { question: 'q', history: [] }),
    { type: 'control_request', request_id: 'r1', request: { subtype: 'side_question', question: 'q', history: [] } });
  assert.deepEqual(classify({ type: 'user', isReplay: true, uuid: 'u1', message: { content: 'hi' } }, now), [{ do: 'picked', uuid: 'u1' }]);
  assert.deepEqual(classify({ type: 'system', subtype: 'status' }, now), [{ do: 'ready' }]);
  assert.deepEqual(classify({ type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { response: 'yes' } } }, now),
    [{ do: 'control_response', requestId: 'r1', ok: true, response: { response: 'yes' }, error: null }]);
  assert.deepEqual(classify({ type: 'control_response', response: { subtype: 'error', request_id: 'r2', error: 'nope' } }, now),
    [{ do: 'control_response', requestId: 'r2', ok: false, response: null, error: 'nope' }]);
  const items = classify({ type: 'assistant', uuid: 'a9', message: { content: [{ type: 'thinking', thinking: 'Let me see.' }, { type: 'text', text: 'Done.' }] } }, now);
  assert.deepEqual(items.map(a => [a.item.kind, a.item.uuid, a.item.text]), [['thinking', 'a9', 'Let me see.'], ['assistant', 'a9', 'Done.']]);
});
