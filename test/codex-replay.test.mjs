// test/codex-replay.test.mjs — a real Codex 0.161 session (recorded with PITWALL_CODEX_TRACE, scrubbed) replayed.
// "List the files here, then create hello.txt with the word hi." in a git scratch folder, Windows sandbox not set up,
// so the thread ran unelevated read-only: the listing ran sandboxed with no card, the write came as an approval card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { itemEvents, approvalToPermission, turnResult, rateEvent } from '../src/codex-translate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'codex-session.jsonl');
const lines = fs.readFileSync(FIXTURE, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const kind = e => {
  const b = e.message.content[0];
  return b.type === 'tool_use' ? 'tool' : b.type === 'tool_result' ? 'tool_result' : b.type === 'thinking' ? 'thinking' : e.type;
};

test('recorded session: items translate to assistant/tool/tool_result in order, the write as a Bash card', () => {
  const kinds = [];
  let card = null;
  for (const m of lines) {
    if (m.method === 'item/started' || m.method === 'item/completed') kinds.push(...itemEvents(m.params.item, { completed: m.method === 'item/completed' }).map(kind));
    if (m.method === 'item/commandExecution/requestApproval') { card = approvalToPermission(m.id, m.method, m.params); kinds.push('card'); }
    if (m.method === 'turn/completed') kinds.push(turnResult(m.params.turn).subtype);
  }
  assert.deepEqual(kinds, ['assistant', 'tool', 'tool_result', 'assistant', 'tool', 'card', 'tool_result', 'assistant', 'success']);
  assert.equal(card.request_id, 'codex-0'); // Codex numbers its own requests from 0
  assert.equal(card.request.tool_name, 'Bash');
  assert.match(card.request.input.command, /Set-Content -LiteralPath hello\.txt/);
  assert.ok(card.request.input.description, 'the reason Codex gives is shown');
  const listing = lines.find(m => m.method === 'item/completed' && m.params.item.type === 'commandExecution');
  assert.match(itemEvents(listing.params.item, { completed: true })[0].message.content[0].content, /readme\.txt/);
});

test('recorded session: sandbox readiness, rate limits in epoch seconds, a resolved notice for the answered card', () => {
  assert.deepEqual(lines.find(m => m.id === 3).result, { status: 'notConfigured' });
  const rl = rateEvent(lines.find(m => m.method === 'account/rateLimits/updated').params.rateLimits).rate_limit_info;
  assert.equal(rl.unifiedWindows.five_hour.utilization, 0.82);
  assert.equal(rl.planType, 'plus');
  const resets = rl.unifiedWindows.seven_day.resetsAt;
  assert.ok(resets > 1.7e9 && resets < 1e10, 'resetsAt is epoch seconds, not ms');
  assert.equal(lines.find(m => m.method === 'serverRequest/resolved').params.requestId, 0);
});

test('recorded session through the bridge: same events, card answered, result with token usage', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-bridge-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-cwd-'));
  const p = spawn(process.execPath, [path.join(ROOT, 'src', 'codex-bridge.mjs'), '--session-id', 'pw-replay', '--replay-user-messages'], {
    cwd, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PITWALL_DATA_DIR: dataDir, PITWALL_CODEX_EXE: process.execPath,
      PITWALL_CODEX_PREARGS: JSON.stringify([path.join(ROOT, 'test', 'fixtures', 'fake-codex.mjs')]), FAKE_CODEX: 'replay', FAKE_CODEX_REPLAY: FIXTURE } });
  const events = [];
  const write = o => p.stdin.write(JSON.stringify(o) + '\n');
  const done = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout: ' + JSON.stringify(events.map(e => e.type)))), 10_000);
    readline.createInterface({ input: p.stdout }).on('line', l => {
      const e = JSON.parse(l);
      events.push(e);
      if (e.subtype === 'init') write({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'List the files here, then create hello.txt with the word hi.' } });
      if (e.type === 'control_request') write({ type: 'control_response', response: { subtype: 'success', request_id: e.request_id, response: { behavior: 'allow', updatedInput: e.request.input } } });
      if (e.type === 'result') { clearTimeout(t); res(e); }
    });
  });
  try {
    const result = await done;
    assert.equal(result.subtype, 'success');
    assert.ok(result.usage.output_tokens > 0 && result.usage.cache_read_input_tokens > 0, 'tokens from thread/tokenUsage/updated');
    const kinds = events.filter(e => e.type === 'assistant' || (e.type === 'user' && !e.isReplay) || e.type === 'control_request')
      .map(e => (e.type === 'control_request' ? 'card' : kind(e)));
    assert.deepEqual(kinds, ['assistant', 'tool', 'tool_result', 'assistant', 'tool', 'card', 'tool_result', 'assistant']);
    assert.ok(events.some(e => e.type === 'stream_event' && e.event?.delta?.text), 'reply streamed');
    assert.ok(!events.some(e => e.type === 'control_cancel_request'), 'an answered card is not withdrawn again');
  } finally {
    p.stdin.end();
    await new Promise(res => { p.once('exit', res); setTimeout(() => { p.kill(); res(); }, 3000).unref(); });
    for (const d of [dataDir, cwd]) try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
  }
});
