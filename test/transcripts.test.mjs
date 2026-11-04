import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanPrompt, cleanRecap, readHistory, summariseTranscript, tokensToday } from '../src/transcripts.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-tx-'));
const now = new Date();
const iso = (minsAgo) => new Date(now.getTime() - minsAgo * 60_000).toISOString();

function write(name, entries) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return f;
}

const file = write('s1.jsonl', [
  { type: 'user', sessionId: 's1', cwd: 'C:\\repo', gitBranch: 'main', timestamp: iso(30), message: { role: 'user', content: 'Fix the callback queue' } },
  { type: 'user', sessionId: 's1', isMeta: true, timestamp: iso(30), message: { content: 'skill body' } },
  { type: 'assistant', sessionId: 's1', timestamp: iso(29), message: { id: 'm1', content: [{ type: 'text', text: 'On it.' }], usage: { input_tokens: 10, output_tokens: 5 } } },
  { type: 'assistant', sessionId: 's1', timestamp: iso(29), message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git status' } }], usage: { input_tokens: 10, output_tokens: 5 } } },
  { type: 'user', sessionId: 's1', timestamp: iso(28), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'clean' }] } },
  { type: 'ai-title', aiTitle: 'Callback queue fix', sessionId: 's1' },
  { type: 'last-prompt', lastPrompt: 'Fix the callback queue', sessionId: 's1' },
  { type: 'assistant', sessionId: 's1', timestamp: iso(27), message: { id: 'm2', content: [{ type: 'text', text: 'Shall I deploy it now?' }], usage: { input_tokens: 1, output_tokens: 2 } } },
]);

test('summariseTranscript picks titles, prompts and "asked a question"', () => {
  const m = summariseTranscript(file);
  assert.equal(m.sessionId, 's1');
  assert.equal(m.title, 'Callback queue fix');
  assert.equal(m.firstPrompt, 'Fix the callback queue');
  assert.equal(m.cwd, 'C:\\repo');
  assert.equal(m.gitBranch, 'main');
  assert.equal(m.endedWithQuestion, true);
  assert.equal(m.pendingToolUse, false);
});

test('summariseTranscript keeps the first timestamp as the start, so the board order stays put', () => {
  const m = summariseTranscript(file);
  assert.equal(m.startedAt, iso(30));
  assert.equal(m.lastActivity, iso(27));
});

test('summariseTranscript spots a tool call still waiting', () => {
  const f = write('s2.jsonl', [
    { type: 'user', sessionId: 's2', timestamp: iso(5), message: { content: 'deploy' } },
    { type: 'assistant', sessionId: 's2', timestamp: iso(4), message: { content: [{ type: 'tool_use', id: 'tx', name: 'Bash', input: { command: 'ssh' } }] } },
  ]);
  assert.equal(summariseTranscript(f).pendingToolUse, true);
});

test('readHistory skips meta/sidechain and pairs tool results', () => {
  const { items } = readHistory(file);
  assert.deepEqual(items.map(i => i.kind), ['user', 'assistant', 'tool', 'tool_result', 'assistant']);
  assert.equal(items[2].summary, 'git status');
  assert.equal(readHistory(file, { before: iso(28.5) }).items.length, 3);
});

test('tokensToday counts each API message once', () => {
  assert.equal(tokensToday(file, now), 15 + 3);
});

test('cleanRecap drops the Claude Code settings hint', () => {
  assert.equal(cleanRecap('Pushed, not live. (disable recaps in /config)'), 'Pushed, not live.');
});

test('cleanPrompt shows slash commands plainly and drops reminders', () => {
  assert.equal(cleanPrompt('<command-name>/review</command-name><command-args>12</command-args>'), '/review 12');
  assert.equal(cleanPrompt('hi <system-reminder>x</system-reminder>'), 'hi');
});

test('readHistory shows images you sent', () => {
  const f = write('s3.jsonl', [
    { type: 'user', sessionId: 's3', timestamp: iso(3), message: { content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'QUJD' } },
      { type: 'text', text: 'Look at this' } ] } },
    { type: 'user', sessionId: 's3', timestamp: iso(2), message: { content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } } ] } },
  ]);
  const { items } = readHistory(f);
  assert.deepEqual(items.map(i => [i.text, i.images]), [
    ['Look at this', ['data:image/png;base64,QUJD']],
    ['', ['data:image/jpeg;base64,QUJD']],
  ]);
});

test('workflow items keep each agent\'s details; agentDetail reads the full prompt, steps and result', async () => {
  const { workflowItem } = await import('../src/protocol.mjs');
  const { agentDetail } = await import('../src/transcripts.mjs');
  const wf = workflowItem('t1', { progress: [
    { type: 'workflow_phase', title: 'Check' },
    { type: 'workflow_agent', label: 'check:top', phaseTitle: 'Check', agentId: 'a1', model: 'claude-opus-5-5', state: 'done',
      startedAt: 1000, lastProgressAt: 5000, durationMs: 4000, tokens: 900, toolCalls: 3, lastToolName: 'Read', attempt: 2,
      promptPreview: 'Fact-check the report', resultPreview: '{"issues":[]}' },
  ], info: { description: 'Cross-check', durationMs: 9000, tokens: 1200, tools: 5, phaseDetails: { Check: '3 checkers' } } });
  assert.deepEqual(wf.agents[0], { id: 'a1', label: 'check:top', phase: 'Check', state: 'done', model: 'claude-opus-5-5', startedAt: 1000,
    lastAt: 5000, durationMs: 4000, tokens: 900, tools: 3, lastTool: 'Read', attempt: 2, prompt: 'Fact-check the report', result: '{"issues":[]}' });
  assert.equal(wf.info.phaseDetails.Check, '3 checkers');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-agent-'));
  const wdir = path.join(dir, 'subagents', 'workflows', 'wf_1');
  fs.mkdirSync(wdir, { recursive: true });
  const L = o => JSON.stringify(o);
  fs.writeFileSync(path.join(wdir, 'agent-a1.jsonl'), [
    L({ type: 'user', timestamp: '2026-10-06T10:00:00Z', message: { content: 'Fact-check the report. ' + 'x'.repeat(3000) } }),
    L({ type: 'assistant', timestamp: '2026-10-06T10:00:05Z', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Reading it.' },
      { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: 'C:/r/report.html' } }] } }),
    L({ type: 'user', timestamp: '2026-10-06T10:00:06Z', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: '<html>…</html>' }] } }),
    L({ type: 'assistant', timestamp: '2026-10-06T10:00:09Z', message: { content: [{ type: 'tool_use', id: 'u2', name: 'StructuredOutput',
      input: { issues: [{ claim: '42 promises', severity: 'wrong' }] } }] } }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(wdir, 'agent-a1.meta.json'), L({ description: 'check:top', workflowPhase: 'Check' }));
  const d = agentDetail(dir, 'a1');
  assert.match(d.prompt, /^Fact-check the report\. x{3000}$/);
  assert.equal(d.model, 'claude-opus-5-5');
  assert.deepEqual(d.steps.map(s => s.kind === 'tool' ? `${s.name}:${s.result ?? ''}` : `text:${s.text}`), ['text:Reading it.', 'Read:<html>…</html>']);
  assert.deepEqual(d.result, { issues: [{ claim: '42 promises', severity: 'wrong' }] });
  assert.equal(d.startedAt, '2026-10-06T10:00:00Z');
  assert.equal(agentDetail(dir, '../etc'), null, 'ids are checked');
  assert.equal(agentDetail(dir, 'nope'), null);
});

test('agentDetail drops the workflow harness preamble from the prompt', async () => {
  const { agentDetail } = await import('../src/transcripts.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-agent-'));
  fs.mkdirSync(path.join(dir, 'subagents'), { recursive: true });
  const prompt = '[Workflow harness — computed task] The task text below was computed at runtime. The computed task text follows:\n  Fact-check the report.\n\n    1. Read it.';
  fs.writeFileSync(path.join(dir, 'subagents', 'agent-b2.jsonl'), JSON.stringify({ type: 'user', message: { content: prompt } }) + '\n');
  assert.equal(agentDetail(dir, 'b2').prompt, 'Fact-check the report.\n\n  1. Read it.');
});

test('agentDetail finds an Agent call’s agent by the call’s tool_use id', async () => {
  const { agentDetail } = await import('../src/transcripts.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-agent-'));
  const sub = path.join(dir, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-c3.jsonl'), JSON.stringify({ type: 'user', message: { content: 'Hunt for XSS.' } }) + '\n');
  fs.writeFileSync(path.join(sub, 'agent-c3.meta.json'), JSON.stringify({ description: 'Hunter h08', toolUseId: 'toolu_01Abc' }));
  fs.writeFileSync(path.join(sub, 'agent-d4.meta.json'), '{not json');
  assert.equal(agentDetail(dir, 'toolu_01Abc').prompt, 'Hunt for XSS.');
  assert.equal(agentDetail(dir, 'toolu_01Nope'), null);
});

test('a Codex usage entry (assistant, empty content) never shows, and leaves "last reply" and "asked a question" alone', async () => {
  const { Transcript } = await import('../src/codex-transcript.mjs');
  const { usageEntry } = await import('../src/codex-translate.mjs');
  const f = path.join(dir, 'codex-usage.jsonl');
  const tr = new Transcript(f, { sessionId: 'cx', cwd: 'C:\repo' });
  tr.append({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Fix it' } });
  tr.append({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Shall I deploy it now?' }] } });
  tr.append(usageEntry('turn-1', 1, { inputTokens: 100, cachedInputTokens: 60, outputTokens: 5, reasoningOutputTokens: 0 }, 'gpt-6.1-sol'));
  const items = readHistory(f).items;
  assert.deepEqual(items.map(i => i.kind), ['user', 'assistant'], 'no empty assistant item');
  const s = summariseTranscript(f);
  assert.equal(s.lastAssistant, 'Shall I deploy it now?');
  assert.equal(s.context, 100, 'input + cache read of the usage entry');
  assert.equal(s.endedWithQuestion, true, 'the trailing usage entry does not hide the question');
  // A tool call still waiting (card up) when a usage entry lands after it stays pending.
  tr.append({ type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'git push' } }] } });
  tr.append(usageEntry('turn-1', 2, { inputTokens: 120, cachedInputTokens: 100, outputTokens: 5, reasoningOutputTokens: 0 }, 'gpt-6.1-sol'));
  assert.equal(summariseTranscript(f).pendingToolUse, true);
});
