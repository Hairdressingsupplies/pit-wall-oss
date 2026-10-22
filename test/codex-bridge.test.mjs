// test/codex-bridge.test.mjs — the bridge as a real child process, driving test/fixtures/fake-codex.mjs.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(ROOT, 'src', 'codex-bridge.mjs');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-codex.mjs');

const live = new Set(); // a failed assertion must not leave a bridge running (it would hang npm test)
const dirs = new Set(); // temp data dirs and cwds, removed once nothing holds them (Windows: EBUSY on a live process's cwd)
afterEach(async () => {
  await Promise.all([...live].map(p => p.exitCode != null || p.signalCode != null ? null
    : new Promise(res => { p.once('exit', res); p.kill(); setTimeout(res, 3000).unref(); })));
  live.clear();
  for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort: never fail a test on cleanup */ }
  dirs.clear();
});

function bridge(args, { mode = 'ok', dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-bridge-')), env = {}, cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-cwd-')) } = {}) {
  dirs.add(cwd).add(dataDir);
  const p = spawn(process.execPath, [BRIDGE, ...args], { cwd, env: { ...process.env, PITWALL_DATA_DIR: dataDir, PITWALL_CODEX_EXE: process.execPath,
    PITWALL_CODEX_PREARGS: JSON.stringify([FAKE]), FAKE_CODEX: mode, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  live.add(p);
  const events = [];
  let err = '';
  p.stderr.on('data', d => { err += d; });
  readline.createInterface({ input: p.stdout }).on('line', l => { try { events.push(JSON.parse(l)); } catch {} });
  const exited = new Promise(res => p.on('exit', code => res(code)));
  const until = (pred, ms = 5000) => new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => {
    const e = events.find(pred); if (e) { clearInterval(i); res(e); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout: ' + JSON.stringify(events) + err)); } }, 20); });
  const write = o => p.stdin.write(JSON.stringify(o) + '\n');
  // Ends the bridge the way the relay does (stdin closes); kills it only if that fails, so no test leaves processes behind.
  const stop = async () => {
    if (p.exitCode != null) return p.exitCode;
    p.stdin.end();
    const t = setTimeout(() => p.kill(), 3000);
    const code = await exited;
    clearTimeout(t);
    return code;
  };
  return { p, events, until, write, dataDir, cwd, exited, stop, stderr: () => err };
}
const user = (text, uuid, extra = {}) => ({ type: 'user', uuid, message: { role: 'user', content: text }, ...extra });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a chat: init, echo, streamed reply, result, transcript written', async () => {
  const b = bridge(['--session-id', 'pw-1', '--replay-user-messages']);
  const init = await b.until(e => e.type === 'system' && e.subtype === 'init');
  assert.equal(init.session_id, 'pw-1');
  assert.equal(init.model, 'gpt-6.1-sol');
  assert.deepEqual(init.slash_commands, []);
  b.write(user('hi', 'u1'));
  await b.until(e => e.type === 'user' && e.isReplay && e.uuid === 'u1');
  await b.until(e => e.type === 'stream_event' && e.event?.type === 'message_start');
  await b.until(e => e.type === 'stream_event' && e.event?.delta?.text === 'Hel');
  await b.until(e => e.type === 'assistant' && e.message.content[0].text === 'Hello 1');
  await b.until(e => e.type === 'result' && !e.is_error);
  await b.until(e => e.type === 'codex_rate_event');
  await b.stop();
  const dir = path.join(b.dataDir, 'codex', 'projects');
  const files = fs.readdirSync(dir, { recursive: true }).filter(f => String(f).endsWith('pw-1.jsonl'));
  assert.equal(files.length, 1);
  const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(lines.some(l => l.type === 'user' && l.uuid === 'u1'), 'user turn saved');
  assert.ok(lines.some(l => l.type === 'assistant' && l.message.content[0].text === 'Hello 1'), 'reply saved');
  assert.match(b.stderr(), /"method":"thread\/start","params":\{"cwd":.*"approvalPolicy":"on-request","sandbox":"workspace-write","config":\{"sandbox_workspace_write.network_access":false\}/);
  assert.match(b.stderr(), /"input":\[\{"type":"text","text":"hi","text_elements":\[\]\}\],"clientUserMessageId":"u1"/);
});

test('queued message echoes when its turn starts', async () => {
  const b = bridge(['--session-id', 'pw-2', '--replay-user-messages']);
  await b.until(e => e.subtype === 'init');
  b.write(user('slow', 'u1'));
  b.write(user('second', 'u2'));
  await b.until(e => e.isReplay && e.uuid === 'u1');
  await new Promise(r => setTimeout(r, 200));
  assert.ok(!b.events.some(e => e.isReplay && e.uuid === 'u2'), 'u2 waits while turn 1 is open');
  b.write({ type: 'control_request', request_id: 'i1', request: { subtype: 'interrupt' } });
  await b.until(e => e.type === 'control_response' && e.response?.request_id === 'i1' && e.response.subtype === 'success');
  await b.until(e => e.type === 'result' && e.subtype === 'interrupted');
  await b.until(e => e.isReplay && e.uuid === 'u2');
  await b.stop();
});

test('a stopped turn ends "interrupted" and the history shows "Stopped", as for Claude', async () => {
  const b = bridge(['--session-id', 'pw-stop', '--replay-user-messages']);
  await b.until(e => e.subtype === 'init');
  b.write(user('slow', 'u1'));
  await b.until(e => e.isReplay && e.uuid === 'u1');
  b.write({ type: 'control_request', request_id: 'int-1', request: { subtype: 'interrupt' } });
  const res = await b.until(e => e.type === 'result');
  assert.equal(res.subtype, 'interrupted');
  await b.stop();
  const { readHistory } = await import('../src/transcripts.mjs');
  const dir = path.join(b.dataDir, 'codex', 'projects');
  const file = fs.readdirSync(dir, { recursive: true }).find(f => String(f).endsWith('pw-stop.jsonl'));
  const items = readHistory(path.join(dir, file)).items;
  assert.deepEqual(items.map(i => i.kind === 'note' ? i.text : i.kind), ['user', 'Stopped']);
});

test('priority now interrupts the open turn and goes first', async () => {
  const b = bridge(['--session-id', 'pw-2b', '--replay-user-messages']);
  await b.until(e => e.subtype === 'init');
  b.write(user('slow', 'u1'));
  b.write(user('queued', 'u2'));
  await b.until(e => e.isReplay && e.uuid === 'u1');
  b.write(user('urgent', 'u3', { priority: 'now' }));
  await b.until(e => e.isReplay && e.uuid === 'u2');
  const at = u => b.events.findIndex(e => e.isReplay && e.uuid === u);
  assert.ok(at('u3') > at('u1') && at('u3') < at('u2'), 'urgent jumps the queue');
  assert.match(b.stderr(), /"method":"turn\/interrupt","params":\{"threadId":"thr-new","turnId":"turn-1"\}/);
  await b.stop();
});

test('image blocks become data URLs', async () => {
  const b = bridge(['--session-id', 'pw-img', '--replay-user-messages']);
  await b.until(e => e.subtype === 'init');
  b.write({ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'look' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] } });
  await b.until(e => e.type === 'result');
  assert.match(b.stderr(), /\{"type":"image","url":"data:image\/png;base64,AAAA"\}/);
  await b.stop();
});

test('take-back drops a held message; Claude-only requests get a readable error', async () => {
  const b = bridge(['--session-id', 'pw-3', '--replay-user-messages']);
  await b.until(e => e.subtype === 'init');
  b.write(user('slow', 'u1'));
  b.write(user('later', 'u2'));
  b.write({ type: 'control_request', request_id: 'c1', request: { subtype: 'cancel_async_message', message_uuid: 'u2' } });
  const took = await b.until(e => e.type === 'control_response' && e.response?.request_id === 'c1');
  assert.deepEqual([took.response.subtype, took.response.response], ['success', { cancelled: true }]);
  b.write({ type: 'control_request', request_id: 'c3', request: { subtype: 'cancel_async_message', message_uuid: 'u1' } }); // already started
  const late = await b.until(e => e.type === 'control_response' && e.response?.request_id === 'c3');
  assert.deepEqual(late.response.response, { cancelled: false });
  b.write({ type: 'control_request', request_id: 'c2', request: { subtype: 'stop_task', task_id: 't' } });
  const err = await b.until(e => e.type === 'control_response' && e.response?.request_id === 'c2');
  assert.equal(err.response.subtype, 'error');
  assert.match(err.response.error, /Not available in Codex chats/);
  b.write({ type: 'control_request', request_id: 'i1', request: { subtype: 'interrupt' } });
  await b.until(e => e.type === 'result');
  await new Promise(r => setTimeout(r, 200));
  assert.ok(!b.events.some(e => e.isReplay && e.uuid === 'u2'));
  await b.stop();
});

test('approval round-trip: card out, answer back', async () => {
  const b = bridge(['--session-id', 'pw-4', '--replay-user-messages'], { mode: 'approval' });
  await b.until(e => e.subtype === 'init');
  b.write(user('push it', 'u1'));
  const card = await b.until(e => e.type === 'control_request' && e.request?.subtype === 'can_use_tool');
  assert.equal(card.request_id, 'codex-901');
  assert.equal(card.request.input.command, 'git push');
  b.write({ type: 'control_response', response: { subtype: 'success', request_id: card.request_id, response: { behavior: 'deny', message: 'no' } } });
  await b.until(e => e.type === 'result');
  assert.match(b.stderr(), /\{"id":901,"result":\{"decision":"decline"\}\}/);
  await b.stop();
});

test('"always" comes back as acceptForSession', async () => {
  const b = bridge(['--session-id', 'pw-4b', '--replay-user-messages'], { mode: 'approval' });
  await b.until(e => e.subtype === 'init');
  b.write(user('push it', 'u1'));
  const card = await b.until(e => e.type === 'control_request' && e.request?.subtype === 'can_use_tool');
  b.write({ type: 'control_response', response: { subtype: 'success', request_id: card.request_id,
    response: { behavior: 'allow', updatedInput: card.request.input, updatedPermissions: card.request.permission_suggestions } } });
  await b.until(e => e.type === 'result');
  assert.match(b.stderr(), /"result":\{"decision":"acceptForSession"\}/);
  await b.stop();
});

test('file-change card names the files from the started item', async () => {
  const b = bridge(['--session-id', 'pw-fc', '--replay-user-messages'], { mode: 'filechange' });
  await b.until(e => e.subtype === 'init');
  b.write(user('edit', 'u1'));
  const card = await b.until(e => e.type === 'control_request' && e.request?.subtype === 'can_use_tool');
  assert.equal(card.request.tool_name, 'Edit');
  assert.equal(card.request.input.file_path, 'a.txt, b.txt');
  assert.deepEqual(card.request.input.changes.map(c => [c.path, c.kind.type]), [['a.txt', 'add'], ['b.txt', 'update']]);
  b.write({ type: 'control_response', response: { subtype: 'success', request_id: card.request_id, response: { behavior: 'allow', updatedInput: {} } } });
  await b.until(e => e.type === 'result');
  assert.match(b.stderr(), /"result":\{"decision":"accept"\}/);
  await b.stop();
});

test('a permissions grant echoes the profile without null keys', async () => {
  const b = bridge(['--session-id', 'pw-perm', '--replay-user-messages'], { mode: 'permissions' });
  await b.until(e => e.subtype === 'init');
  b.write(user('write there', 'u1'));
  const card = await b.until(e => e.type === 'control_request' && e.request?.subtype === 'can_use_tool');
  assert.equal(card.request.tool_name, 'Permissions');
  b.write({ type: 'control_response', response: { subtype: 'success', request_id: card.request_id, response: { behavior: 'allow', updatedInput: {} } } });
  await b.until(e => e.type === 'result');
  assert.match(b.stderr(), /"result":\{"permissions":\{"fileSystem":\{"read":null,"write":\["C:\/x"\]\}\},"scope":"turn"\}/);
  await b.stop();
});

test('a request Codex resolves itself withdraws its card', async () => {
  const b = bridge(['--session-id', 'pw-res', '--replay-user-messages'], { mode: 'resolved' });
  await b.until(e => e.subtype === 'init');
  b.write(user('push it', 'u1'));
  const card = await b.until(e => e.type === 'control_request' && e.request?.subtype === 'can_use_tool');
  await b.until(e => e.type === 'control_cancel_request' && e.request_id === card.request_id);
  await b.stop();
});

test('a card still up when the turn ends is withdrawn', async () => {
  const b = bridge(['--session-id', 'pw-orph', '--replay-user-messages'], { mode: 'orphan' });
  await b.until(e => e.subtype === 'init');
  b.write(user('clean up', 'u1'));
  const card = await b.until(e => e.type === 'control_request' && e.request?.subtype === 'can_use_tool');
  await b.until(e => e.type === 'control_cancel_request' && e.request_id === card.request_id);
  const at = pred => b.events.findIndex(pred);
  assert.ok(at(e => e.type === 'control_cancel_request') < at(e => e.type === 'result'), 'withdrawn before the result');
  await b.stop();
});

test('elicitations are declined and user-input questions get no answers', async () => {
  const b = bridge(['--session-id', 'pw-eli', '--replay-user-messages'], { mode: 'elicit' });
  await b.until(e => e.subtype === 'init');
  b.write(user('go', 'u1'));
  await b.until(e => e.type === 'result');
  await b.stop();
  assert.match(b.stderr(), /\{"id":950,"result":\{"action":"decline","content":null,"_meta":null\}\}/);
  assert.match(b.stderr(), /\{"id":951,"result":\{"answers":\{\}\}\}/);
});

test('legacy approvals are denied; unknown requests get a JSON-RPC error, not {}', async () => {
  const b = bridge(['--session-id', 'pw-leg', '--replay-user-messages'], { mode: 'legacy' });
  await b.until(e => e.subtype === 'init');
  b.write(user('go', 'u1'));
  await b.until(e => e.type === 'result');
  await b.stop();
  assert.ok(!b.events.some(e => e.type === 'control_request'), 'no card');
  assert.match(b.stderr(), /\{"id":960,"result":\{"decision":\{"denied":\{"rejection":"[^"]+"\}\}\}\}/);
  assert.match(b.stderr(), /\{"id":961,"result":\{"decision":\{"denied":/);
  assert.match(b.stderr(), /\{"id":962,"error":\{"code":-32601,"message":"Pit Wall does not handle item\/tool\/call\."\}\}/);
  assert.match(b.stderr(), /unhandled request item\/tool\/call/);
});

test('a job whose plugin check fails stops instead of running with plugins on', async () => {
  const b = bridge(['--session-id', 'pw-pf', '--replay-user-messages', '--job'], { mode: 'plugins-fail' });
  const r = await b.until(e => e.type === 'result');
  assert.equal(r.is_error, true);
  assert.match(r.result, /Could not check Codex plugins: marketplace unavailable/);
  assert.equal(await b.exited, 1);
  assert.ok(!b.events.some(e => e.subtype === 'init'), 'no chat started');
  assert.doesNotMatch(b.stderr(), /turn\/start/);
});

test('job bridge auto-declines without a server and disables plugins', async () => {
  const b = bridge(['--session-id', 'pw-5', '--replay-user-messages', '--job'], { mode: 'approval' });
  await b.until(e => e.subtype === 'init');
  b.write(user('push it', 'u1'));
  await b.until(e => e.type === 'result');
  assert.ok(!b.events.some(e => e.type === 'control_request'), 'no card: nobody to ask');
  assert.match(b.stderr(), /"result":\{"decision":"decline"\}/);
  assert.match(b.stderr(), /"disabledPluginIds":\["gmail"\]/);
  assert.match(b.stderr(), /"method":"config\/read","params":\{"cwd":/);
  const start = JSON.parse(/IN (\{"id":\d+,"method":"thread\/start".*)/.exec(b.stderr())[1]);
  assert.deepEqual(start.params.config, { 'sandbox_workspace_write.network_access': false, features: { apps: false, plugins: false },
    mcp_servers: { 'shop.tools': { enabled: false } } });
  await b.stop();
});

test('a job whose config check fails stops before any thread starts', async () => {
  const b = bridge(['--session-id', 'pw-cf', '--replay-user-messages', '--job'], { mode: 'config-fail' });
  const r = await b.until(e => e.type === 'result');
  assert.equal(r.is_error, true);
  assert.match(r.result, /Could not check Codex settings: bad config.toml/);
  assert.equal(await b.exited, 1);
  assert.doesNotMatch(b.stderr(), /thread\/start/);
});

test('a chat (not a job) keeps its apps and MCP servers but not the network', async () => {
  const b = bridge(['--session-id', 'pw-chatcfg', '--replay-user-messages']);
  await b.until(e => e.subtype === 'init');
  const start = JSON.parse(/IN (\{"id":\d+,"method":"thread\/start".*)/.exec(b.stderr())[1]);
  assert.deepEqual(start.params.config, { 'sandbox_workspace_write.network_access': false });
  await b.stop();
});

test('Windows sandbox not set up: unelevated read-only; set up: workspace-write; not Windows: workspace-write', async () => {
  const start = b => JSON.parse(/IN (\{"id":\d+,"method":"thread\/start".*)/.exec(b.stderr())[1]).params;
  const unset = bridge(['--session-id', 'pw-sbx1', '--replay-user-messages'], { mode: 'sandbox-unset' });
  await unset.until(e => e.subtype === 'init');
  assert.equal(start(unset).sandbox, 'read-only');
  assert.deepEqual(start(unset).config, { 'sandbox_workspace_write.network_access': false, 'windows.sandbox': 'unelevated' });
  await unset.stop();
  const job = bridge(['--session-id', 'pw-sbx2', '--replay-user-messages', '--job'], { mode: 'sandbox-unset' });
  await job.until(e => e.subtype === 'init');
  assert.equal(start(job).sandbox, 'read-only');
  assert.equal(start(job).config['windows.sandbox'], 'unelevated');
  assert.deepEqual(start(job).config.features, { apps: false, plugins: false });
  await job.stop();
  const old = bridge(['--session-id', 'pw-sbx3', '--replay-user-messages'], { mode: 'no-sandbox-method' });
  await old.until(e => e.subtype === 'init');
  // No readiness method: workspace-write only off Windows. On Windows a missing answer never widens the sandbox.
  assert.equal(start(old).sandbox, process.platform === 'win32' ? 'read-only' : 'workspace-write');
  await old.stop();
});

test('on Windows a readiness check that errors or never answers, or a failed config/read, fails closed', async () => {
  const start = b => JSON.parse(/IN (\{"id":\d+,"method":"thread\/start".*)/.exec(b.stderr())[1]).params;
  const closed = process.platform === 'win32' ? 'read-only' : 'workspace-write';
  for (const [mode, env] of [['sandbox-error', {}], ['sandbox-hang', { PITWALL_CODEX_START_MS: '300' }]]) {
    const b = bridge(['--session-id', `pw-${mode}`, '--replay-user-messages'], { mode, env });
    await b.until(e => e.subtype === 'init');
    assert.equal(start(b).sandbox, closed, mode);
    if (closed === 'read-only') assert.equal(start(b).config['windows.sandbox'], 'unelevated', mode);
    await b.stop();
  }
  // readiness "ready" but config/read fails: an explicit unelevated setting can't be ruled out → read-only everywhere
  const cfgFail = bridge(['--session-id', 'pw-cfgfail', '--replay-user-messages'], { mode: 'config-fail' });
  await cfgFail.until(e => e.subtype === 'init');
  assert.equal(start(cfgFail).sandbox, 'read-only');
  await cfgFail.stop();
});

test('PITWALL_CODEX_TRACE appends the raw stdout lines from Codex to <file>.<bridge pid>', async () => {
  const trace = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-bridge-')), 'trace.jsonl');
  dirs.add(path.dirname(trace));
  const b = bridge(['--session-id', 'pw-trace', '--replay-user-messages'], { env: { PITWALL_CODEX_TRACE: trace } });
  await b.until(e => e.subtype === 'init');
  b.write(user('hi', 'u1'));
  await b.until(e => e.type === 'result');
  await b.stop();
  assert.ok(!fs.existsSync(trace), 'no shared file: each bridge writes its own');
  const lines = fs.readFileSync(`${trace}.${b.p.pid}`, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(lines.some(l => l.result?.userAgent === 'fake'), 'initialize reply traced');
  assert.ok(lines.some(l => l.method === 'turn/completed'), 'notifications traced');
});

test('resume uses the saved thread id', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-bridge-'));
  fs.mkdirSync(path.join(dataDir, 'codex', 'threads'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'codex', 'threads', 'pw-6.json'), JSON.stringify({ threadId: 'thr-saved' }));
  const b = bridge(['--resume', 'pw-6', '--replay-user-messages', '--model', 'gpt-x'], { dataDir });
  await b.until(e => e.subtype === 'init');
  assert.match(b.stderr(), /"method":"thread\/resume","params":\{"threadId":"thr-saved".*"config":\{"sandbox_workspace_write.network_access":false\}.*"model":"gpt-x"/);
  await b.stop();
});

test('a new chat saves its thread id', async () => {
  const b = bridge(['--session-id', 'pw-8', '--replay-user-messages']);
  await b.until(e => e.subtype === 'init');
  const saved = JSON.parse(fs.readFileSync(path.join(b.dataDir, 'codex', 'threads', 'pw-8.json'), 'utf8'));
  assert.equal(saved.threadId, 'thr-new');
  await b.stop();
});

test('a startup request Codex never answers ends the chat on the short startup timeout', async () => {
  const b = bridge(['--session-id', 'pw-hang', '--replay-user-messages'], { mode: 'hang-start', env: { PITWALL_CODEX_START_MS: '300' } });
  const r = await b.until(e => e.type === 'result', 4000);
  assert.equal(r.is_error, true);
  assert.match(r.result, /Codex failed to start: Codex did not answer thread\/start in time/);
  assert.equal(await b.exited, 1);
});

test('not signed in ends with a readable error', async () => {
  const b = bridge(['--session-id', 'pw-7', '--replay-user-messages'], { mode: 'signed-out' });
  const r = await b.until(e => e.type === 'result');
  assert.equal(r.is_error, true);
  assert.equal(r.subtype, 'not_signed_in');
  assert.match(r.result, /not signed in/i);
  assert.equal(await b.exited, 1);
  assert.match(b.stderr(), /Codex is not signed in/);
});

test('closing stdin ends the bridge and its Codex child', async () => {
  const b = bridge(['--session-id', 'pw-9', '--replay-user-messages']);
  await b.until(e => e.subtype === 'init');
  const pid = Number(/FAKEPID (\d+)/.exec(b.stderr())[1]);
  assert.ok(alive(pid));
  assert.equal(await b.stop(), 0, 'exits by itself, not killed');
  const t0 = Date.now();
  while (alive(pid) && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 50));
  assert.ok(!alive(pid), 'Codex child is gone');
});

const transcriptLines = (b, id) => {
  const dir = path.join(b.dataDir, 'codex', 'projects');
  const file = fs.readdirSync(dir, { recursive: true }).find(f => String(f).endsWith(`${id}.jsonl`));
  return fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').map(l => JSON.parse(l));
};
const threadFile = (b, id) => path.join(b.dataDir, 'codex', 'threads', `${id}.json`);

test('usage: live token count rises, result is the turn sum, usage entries in the transcript only, parent chain', async () => {
  const b = bridge(['--session-id', 'pw-use', '--replay-user-messages']);
  await b.until(e => e.subtype === 'init');
  b.write(user('hi', 'u1'));
  const res = await b.until(e => e.type === 'result');
  await b.stop();
  const live = b.events.filter(e => e.type === 'stream_event' && e.event?.type === 'message_delta').map(e => e.event.usage.output_tokens);
  assert.deepEqual(live, [5, 10]);
  assert.deepEqual(res.usage, { input_tokens: 80, cache_read_input_tokens: 120, output_tokens: 10 });
  assert.ok(!b.events.some(e => e.type === 'assistant' && Array.isArray(e.message?.content) && !e.message.content.length), 'usage entries never reach stdout');
  const lines = transcriptLines(b, 'pw-use');
  const uses = lines.filter(l => l.message?.id?.startsWith('codex-usage-'));
  assert.deepEqual(uses.map(l => l.message.id), ['codex-usage-turn-1-1', 'codex-usage-turn-1-2']);
  assert.deepEqual(uses[0].message.usage, { input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 5 });
  assert.equal(uses[0].message.model, 'gpt-6.1-sol');
  const convo = lines.filter(l => l.type === 'user' || l.type === 'assistant');
  assert.equal(convo[0].parentUuid, null);
  for (let i = 1; i < convo.length; i++) assert.equal(convo[i].parentUuid, convo[i - 1].uuid, `entry ${i} hangs off the one before`);
});

test('turn map: the thread file records each turn with its user uuid and item uuids', async () => {
  const b = bridge(['--session-id', 'pw-map', '--replay-user-messages']);
  const init = await b.until(e => e.subtype === 'init');
  assert.equal(init.branching, true, 'a new chat has a turn map');
  assert.deepEqual(JSON.parse(fs.readFileSync(threadFile(b, 'pw-map'), 'utf8')), { threadId: 'thr-new', turns: [] }, 'saved right after thread/start');
  b.write(user('hi', 'u1'));
  await b.until(e => e.type === 'result');
  await b.stop();
  const uses = transcriptLines(b, 'pw-map').filter(l => l.message?.id?.startsWith('codex-usage-')).map(l => l.uuid);
  const saved = JSON.parse(fs.readFileSync(threadFile(b, 'pw-map'), 'utf8'));
  assert.equal(saved.threadId, 'thr-new');
  assert.equal(saved.turns.length, 1);
  assert.equal(saved.turns[0].turnId, 'turn-1');
  assert.equal(saved.turns[0].userUuid, 'u1');
  assert.deepEqual(saved.turns[0].itemUuids, ['m1', ...uses]);
});

test('an old chat (thread file {threadId} only) resumes with branching false and its file left alone', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-bridge-'));
  fs.mkdirSync(path.join(dataDir, 'codex', 'threads'), { recursive: true });
  const f = path.join(dataDir, 'codex', 'threads', 'pw-old.json');
  fs.writeFileSync(f, JSON.stringify({ threadId: 'thr-saved' }));
  const b = bridge(['--resume', 'pw-old', '--replay-user-messages'], { dataDir });
  const init = await b.until(e => e.subtype === 'init');
  assert.equal(init.branching, false);
  b.write(user('hi', 'u1'));
  const res = await b.until(e => e.type === 'result');
  await b.stop();
  assert.equal(res.usage.output_tokens, 10, 'usage still counted');
  assert.equal(fs.readFileSync(f, 'utf8'), JSON.stringify({ threadId: 'thr-saved' }), 'no turn map created');
});

test('another thread\'s notifications never reach this chat', async () => {
  const b = bridge(['--session-id', 'pw-foreign', '--replay-user-messages'], { mode: 'foreign' });
  await b.until(e => e.subtype === 'init');
  b.write(user('hi', 'u1'));
  const res = await b.until(e => e.type === 'result');
  await b.stop();
  assert.ok(b.events.some(e => e.event?.delta?.text === 'Hel'), 'own delta arrives');
  assert.ok(!b.events.some(e => e.event?.delta?.text === 'other'), 'no foreign delta');
  assert.ok(!b.events.some(e => e.type === 'assistant' && e.uuid === 'o1'), 'no foreign reply on stdout');
  assert.ok(!transcriptLines(b, 'pw-foreign').some(l => l.uuid === 'o1'), 'no foreign reply in the transcript');
  assert.deepEqual(res.usage, { input_tokens: 80, cache_read_input_tokens: 120, output_tokens: 10 }, 'foreign usage not counted');
});

// ── fork, rewind, /btw ──
const inLines = (b, method) => [...b.stderr().matchAll(/^IN (.*)$/gm)].map(x => JSON.parse(x[1])).filter(m => m.method === method);
const ctl = (b, id, request) => { b.write({ type: 'control_request', request_id: id, request }); return b.until(e => e.type === 'control_response' && e.response?.request_id === id); };
const results = (b, n) => b.until(() => b.events.filter(e => e.type === 'result').length >= n);
const waitFor = async (pred, ms = 3000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 20)); } };
const transcriptPath = (b, id) => {
  const dir = path.join(b.dataDir, 'codex', 'projects');
  const f = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).find(x => String(x).endsWith(`${id}.jsonl`)) : null;
  return f ? path.join(dir, f) : null;
};
const SANDBOX_KEYS = ['cwd', 'sandbox', 'approvalPolicy', 'config'];
const UNMAPPED = 'Not available in this Codex chat (started before Pit Wall could branch Codex chats).';

/** A chat with two finished turns: 'one' (u1 → m1) and 'two' (u2 → m2). */
async function twoTurns(id, opts = {}) {
  const b = bridge(['--session-id', id, '--replay-user-messages'], opts);
  await b.until(e => e.subtype === 'init');
  b.write(user('one', 'u1'));
  await results(b, 1);
  b.write(user('two', 'u2'));
  await results(b, 2);
  return b;
}

test('fork from a reply: thread/fork at that turn with the source sandbox, map and transcript copied up to it', async () => {
  const src = await twoTurns('pw-src');
  await src.stop();
  const { dataDir, cwd } = src;
  const srcMap = JSON.parse(fs.readFileSync(threadFile(src, 'pw-src'), 'utf8'));
  const f = bridge(['--session-id', 'pw-fork', '--replay-user-messages', '--fork-from', 'pw-src', '--fork-at', 'm1'], { dataDir, cwd });
  const init = await f.until(e => e.subtype === 'init');
  assert.equal(init.branching, true);
  assert.equal(init.session_id, 'pw-fork');
  const fork = inLines(f, 'thread/fork')[0].params;
  assert.deepEqual([fork.threadId, fork.lastTurnId, fork.ephemeral], ['thr-new', 'turn-1', undefined]);
  const start = inLines(src, 'thread/start')[0].params;
  for (const k of SANDBOX_KEYS) assert.deepEqual(fork[k], start[k], `fork ${k} = source thread/start ${k}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(threadFile(f, 'pw-fork'), 'utf8')), { threadId: 'thr-fork', turns: [srcMap.turns[0]] });
  const keep = [srcMap.turns[0].userUuid, ...srcMap.turns[0].itemUuids];
  const strip = ({ sessionId, ...l }) => l;
  const copied = transcriptLines(f, 'pw-fork');
  assert.deepEqual(copied.filter(l => l.uuid).map(strip), transcriptLines(src, 'pw-src').filter(l => keep.includes(l.uuid)).map(strip), 'turn 1 copied as is');
  assert.ok(copied.every(l => l.sessionId === 'pw-fork'), 'sessionId rewritten');
  assert.deepEqual(copied.filter(l => l.type === 'last-prompt').map(l => l.lastPrompt), ['one'], 'the prompt after the cut is not copied');
  // Then it is an ordinary chat: the replayed usage for turn 1 added nothing, and the next turn continues the chain.
  f.write(user('three', 'u3'));
  await f.until(e => e.type === 'result');
  await f.stop();
  const after = transcriptLines(f, 'pw-fork');
  assert.equal(after.filter(l => l.message?.id?.startsWith('codex-usage-turn-1-')).length, 2, 'no usage entry for the replay');
  assert.equal(after.find(l => l.uuid === 'u3').parentUuid, keep.at(-1));
  assert.deepEqual(JSON.parse(fs.readFileSync(threadFile(f, 'pw-fork'), 'utf8')).turns.map(t => t.turnId), ['turn-1', 'turn-2']);
  assert.deepEqual(JSON.parse(fs.readFileSync(threadFile(src, 'pw-src'), 'utf8')), srcMap, 'the source is untouched');
});

test('fork: unknown reply fails with nothing written; no --fork-at forks the whole thread; a job fork stays locked down', async () => {
  const src = await twoTurns('pw-src2');
  await src.stop();
  const { dataDir, cwd } = src;
  const bad = bridge(['--session-id', 'pw-bad', '--replay-user-messages', '--fork-from', 'pw-src2', '--fork-at', 'nope'], { dataDir, cwd });
  const r = await bad.until(e => e.type === 'result');
  assert.equal(r.is_error, true);
  assert.equal(r.result, "That reply can't be forked (not in this chat's map).");
  assert.equal(await bad.exited, 1);
  assert.ok(!fs.existsSync(threadFile(bad, 'pw-bad')), 'no thread file');
  assert.equal(transcriptPath(bad, 'pw-bad'), null, 'no transcript');
  assert.deepEqual(inLines(bad, 'thread/fork'), []);

  const whole = bridge(['--session-id', 'pw-whole', '--replay-user-messages', '--fork-from', 'pw-src2'], { dataDir, cwd });
  await whole.until(e => e.subtype === 'init');
  assert.ok(!('lastTurnId' in inLines(whole, 'thread/fork')[0].params));
  assert.equal(JSON.parse(fs.readFileSync(threadFile(whole, 'pw-whole'), 'utf8')).turns.length, 2);
  await whole.stop();

  const job = bridge(['--session-id', 'pw-jobfork', '--replay-user-messages', '--job', '--fork-from', 'pw-src2', '--fork-at', 'u2'], { dataDir, cwd });
  await job.until(e => e.subtype === 'init');
  const fork = inLines(job, 'thread/fork')[0].params;
  assert.equal(fork.lastTurnId, 'turn-2', 'a user uuid finds its turn too');
  assert.deepEqual(fork.config, { 'sandbox_workspace_write.network_access': false, features: { apps: false, plugins: false },
    mcp_servers: { 'shop.tools': { enabled: false } } });
  await job.stop();
});

test('a job stays a job: its fork and its resume are locked down even without --job', async () => {
  const JOB_CONFIG = { 'sandbox_workspace_write.network_access': false, features: { apps: false, plugins: false }, mcp_servers: { 'shop.tools': { enabled: false } } };
  const src = bridge(['--session-id', 'pw-jobsrc', '--replay-user-messages', '--job']);
  await src.until(e => e.subtype === 'init');
  src.write(user('one', 'u1'));
  await src.until(e => e.type === 'result');
  await src.stop();
  const { dataDir, cwd } = src;
  assert.equal(JSON.parse(fs.readFileSync(threadFile(src, 'pw-jobsrc'), 'utf8')).job, true, 'job saved in the thread state');

  const f = bridge(['--session-id', 'pw-jobfork2', '--replay-user-messages', '--fork-from', 'pw-jobsrc', '--fork-at', 'm1'], { dataDir, cwd, mode: 'approval' });
  await f.until(e => e.subtype === 'init');
  assert.deepEqual(inLines(f, 'thread/fork')[0].params.config, JOB_CONFIG);
  f.write(user('push it', 'u2'));
  await f.until(e => e.type === 'result');
  await f.stop();
  assert.ok(!f.events.some(e => e.type === 'control_request'), 'no card: approvals auto-declined');
  assert.match(f.stderr(), /\{"id":902,"result":\{"decision":"decline"\}\}/);
  assert.match(f.stderr(), /"disabledPluginIds":\["gmail"\]/);
  assert.equal(JSON.parse(fs.readFileSync(threadFile(f, 'pw-jobfork2'), 'utf8')).job, true, 'the fork is saved as a job too');

  const r = bridge(['--resume', 'pw-jobsrc', '--replay-user-messages'], { dataDir, cwd, mode: 'approval', env: { FAKE_CODEX_TURNS: '1' } });
  await r.until(e => e.subtype === 'init');
  assert.deepEqual(inLines(r, 'thread/resume')[0].params.config, JOB_CONFIG);
  r.write(user('push it', 'u3'));
  await r.until(e => e.type === 'result');
  await r.stop();
  assert.ok(!r.events.some(e => e.type === 'control_request'), 'no card on the resumed job either');
});

test('rewind: thread/revert before that turn, map and parent cut back, history hides it; again is a no-op; no file undo', async () => {
  const { NO_FILE_UNDO } = await import('../src/codex-translate.mjs');
  const b = await twoTurns('pw-rw');
  const map = JSON.parse(fs.readFileSync(threadFile(b, 'pw-rw'), 'utf8'));
  const res = await ctl(b, 'r1', { subtype: 'rewind_conversation', target_message_uuid: 'u2' });
  assert.equal(res.response.subtype, 'success');
  assert.deepEqual(inLines(b, 'thread/revert').map(m => m.params), [{ threadId: 'thr-new', beforeTurnId: 'turn-2' }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(threadFile(b, 'pw-rw'), 'utf8')).turns, [map.turns[0]]);
  b.write(user('three', 'u3'));
  await results(b, 3);
  assert.equal(transcriptLines(b, 'pw-rw').find(l => l.uuid === 'u3').parentUuid, map.turns[0].itemUuids.at(-1));
  const { readHistory } = await import('../src/transcripts.mjs');
  assert.deepEqual(readHistory(transcriptPath(b, 'pw-rw')).items.map(i => i.text), ['one', 'Hello 1', 'three', 'Hello 3']);
  // The relay replays a rewind into a fresh bridge: the target is already gone, so it succeeds without reverting again.
  const again = await ctl(b, 'r2', { subtype: 'rewind_conversation', target_message_uuid: 'u2' });
  assert.equal(again.response.subtype, 'success');
  assert.equal(inLines(b, 'thread/revert').length, 1);
  const files = await ctl(b, 'r3', { subtype: 'rewind_files', user_message_id: 'u3', dry_run: true });
  assert.deepEqual([files.response.subtype, files.response.error], ['error', NO_FILE_UNDO]);
  assert.equal(NO_FILE_UNDO, "Codex rewind doesn't undo file changes.");
  await b.stop();
});

test('rewind while a turn runs: interrupted first, then reverted', async () => {
  const b = bridge(['--session-id', 'pw-rw2', '--replay-user-messages']);
  await b.until(e => e.subtype === 'init');
  b.write(user('one', 'u1'));
  await results(b, 1);
  b.write(user('slow', 'u2'));
  await b.until(e => e.isReplay && e.uuid === 'u2');
  await waitFor(() => /"method":"turn\/start".*"text":"slow"/.test(b.stderr()));
  const res = await ctl(b, 'r1', { subtype: 'rewind_conversation', target_message_uuid: 'u2' });
  assert.equal(res.response.subtype, 'success');
  assert.equal(inLines(b, 'turn/interrupt').length, 1);
  assert.deepEqual(inLines(b, 'thread/revert').map(m => m.params.beforeTurnId), ['turn-2']);
  assert.deepEqual(JSON.parse(fs.readFileSync(threadFile(b, 'pw-rw2'), 'utf8')).turns.map(t => t.turnId), ['turn-1']);
  await b.stop();
});

test('a rewind sent to a bridge still starting goes first; a message sent after it waits for the revert and runs normally', async () => {
  const src = await twoTurns('pw-rw3');
  await src.stop();
  const b = bridge(['--resume', 'pw-rw3', '--replay-user-messages'], { dataDir: src.dataDir, cwd: src.cwd, env: { FAKE_CODEX_TURNS: '2' } });
  b.write({ type: 'control_request', request_id: 'r1', request: { subtype: 'rewind_conversation', target_message_uuid: 'u2' } });
  b.write(user('three', 'u3'));
  const res = await b.until(e => e.type === 'control_response' && e.response?.request_id === 'r1');
  assert.equal(res.response.subtype, 'success');
  const done = await b.until(e => e.type === 'result');
  assert.equal(done.subtype, 'success', 'not interrupted by the rewind');
  await b.stop();
  const ins = [...b.stderr().matchAll(/^IN (.*)$/gm)].map(x => JSON.parse(x[1]).method);
  assert.ok(ins.indexOf('thread/revert') < ins.indexOf('turn/start'), 'reverted before the next turn started');
  assert.ok(!ins.includes('turn/interrupt'));
  assert.deepEqual(JSON.parse(fs.readFileSync(threadFile(b, 'pw-rw3'), 'utf8')).turns.map(t => t.turnId), ['turn-1', 'turn-3']);
});

test('an old Codex chat (no turn map) refuses rewind and fork with a readable message', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-bridge-'));
  fs.mkdirSync(path.join(dataDir, 'codex', 'threads'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'codex', 'threads', 'pw-old2.json'), JSON.stringify({ threadId: 'thr-saved' }));
  const b = bridge(['--resume', 'pw-old2', '--replay-user-messages'], { dataDir });
  await b.until(e => e.subtype === 'init');
  const res = await ctl(b, 'r1', { subtype: 'rewind_conversation', target_message_uuid: 'u1' });
  assert.deepEqual([res.response.subtype, res.response.error], ['error', UNMAPPED]);
  assert.deepEqual(inLines(b, 'thread/revert'), []);
  const btw = await ctl(b, 'q1', { subtype: 'side_question', question: 'q', history: [] });
  assert.deepEqual([btw.response.subtype, btw.response.error], ['error', UNMAPPED]);
  assert.deepEqual(inLines(b, 'thread/fork'), [], 'no side thread either');
  await b.stop();
  const f = bridge(['--session-id', 'pw-oldfork', '--replay-user-messages', '--fork-from', 'pw-old2'], { dataDir, cwd: b.cwd });
  const r = await f.until(e => e.type === 'result');
  assert.deepEqual([r.is_error, r.result], [true, UNMAPPED]);
  assert.ok(!fs.existsSync(threadFile(f, 'pw-oldfork')));
});

test('a rewind survives the bridge: a resumed chat hangs the next message where the rewind left it, even through a replayed rewind', async () => {
  const { readHistory } = await import('../src/transcripts.mjs');
  const a = await twoTurns('pw-rwd');
  const map = JSON.parse(fs.readFileSync(threadFile(a, 'pw-rwd'), 'utf8'));
  assert.equal((await ctl(a, 'r1', { subtype: 'rewind_conversation', target_message_uuid: 'u2' })).response.subtype, 'success');
  await a.stop();
  const attach = map.turns[0].itemUuids.at(-1);
  assert.equal(JSON.parse(fs.readFileSync(threadFile(a, 'pw-rwd'), 'utf8')).attach, attach, 'the hang point is saved with the map');
  const opts = { dataDir: a.dataDir, cwd: a.cwd, env: { FAKE_CODEX_TURNS: '2' } };
  const b = bridge(['--resume', 'pw-rwd', '--replay-user-messages'], opts);
  await b.until(e => e.subtype === 'init');
  assert.equal((await ctl(b, 'r2', { subtype: 'rewind_conversation', target_message_uuid: 'u2' })).response.subtype, 'success');
  assert.deepEqual(inLines(b, 'thread/revert'), [], 'already gone: no second revert');
  b.write(user('three', 'u3'));
  await b.until(e => e.type === 'result');
  await b.stop();
  assert.equal(transcriptLines(b, 'pw-rwd').find(l => l.uuid === 'u3').parentUuid, attach);
  assert.ok(!('attach' in JSON.parse(fs.readFileSync(threadFile(b, 'pw-rwd'), 'utf8'))), 'used up by the next message');
  const file = transcriptPath(b, 'pw-rwd');
  assert.deepEqual(readHistory(file, { cutAt: 'u2' }).items.map(i => i.text), ['one', 'Hello 1', 'three', 'Hello 3'], 'with the server\'s rewind_cut');
  assert.deepEqual(readHistory(file).items.map(i => i.text), ['one', 'Hello 1', 'three', 'Hello 3']);
  // A later bridge continues from the file's last entry as usual.
  const c = bridge(['--resume', 'pw-rwd', '--replay-user-messages'], { ...opts, env: { FAKE_CODEX_TURNS: '3' } });
  await c.until(e => e.subtype === 'init');
  c.write(user('four', 'u4'));
  await c.until(e => e.type === 'result');
  await c.stop();
  assert.deepEqual(readHistory(file, { cutAt: 'u2' }).items.map(i => i.text), ['one', 'Hello 1', 'three', 'Hello 3', 'four', 'Hello 4']);
});

test('/btw: an ephemeral fork answers; nothing reaches the chat or the transcript; the side thread is let go', async () => {
  const b = bridge(['--session-id', 'pw-btw', '--replay-user-messages']);
  await b.until(e => e.subtype === 'init');
  b.write(user('one', 'u1'));
  await results(b, 1);
  const lines = fs.readFileSync(transcriptPath(b, 'pw-btw'), 'utf8');
  const n = b.events.length;
  const res = await ctl(b, 'q1', { subtype: 'side_question', question: 'q', history: [{ question: 'q0', response: 'a0' }] });
  assert.equal(res.response.subtype, 'success');
  assert.deepEqual(res.response.response, { response: 'Side answer' });
  const fork = inLines(b, 'thread/fork')[0].params;
  assert.deepEqual([fork.threadId, fork.ephemeral, fork.excludeTurns], ['thr-new', true, true]);
  const start = inLines(b, 'thread/start')[0].params;
  assert.equal(start.sandbox, 'workspace-write', 'the chat itself may write (fake reports the sandbox ready)');
  assert.deepEqual([fork.cwd, fork.approvalPolicy], [start.cwd, start.approvalPolicy]);
  assert.equal(fork.sandbox, 'read-only', '/btw never writes, whatever the chat may do');
  assert.deepEqual(fork.config, { ...start.config, 'windows.sandbox': 'unelevated', features: { apps: false, plugins: false } }, 'no apps or plugins either');
  const side = inLines(b, 'turn/start').find(m => m.params.threadId === 'thr-side-1');
  assert.equal(side.params.input[0].text, 'Q: q0\nA: a0\nq');
  await waitFor(() => inLines(b, 'thread/unsubscribe').some(m => m.params.threadId === 'thr-side-1'));
  assert.ok(!b.events.slice(n).some(e => ['assistant', 'stream_event', 'result', 'user'].includes(e.type)), 'side output never streams');
  assert.equal(fs.readFileSync(transcriptPath(b, 'pw-btw'), 'utf8'), lines, 'transcript untouched');
  await b.stop();
});

test('/btw during a reply is refused; an approval on the side thread is declined without a card', async () => {
  const b = bridge(['--session-id', 'pw-btw2', '--replay-user-messages']);
  await b.until(e => e.subtype === 'init');
  b.write(user('slow', 'u1'));
  await b.until(e => e.isReplay && e.uuid === 'u1');
  const res = await ctl(b, 'q1', { subtype: 'side_question', question: 'q', history: [] });
  assert.deepEqual([res.response.subtype, res.response.error], ['error', 'Wait for the reply to finish, then ask.']);
  assert.deepEqual(inLines(b, 'thread/fork'), []);
  await b.stop();

  const a = bridge(['--session-id', 'pw-btw3', '--replay-user-messages'], { mode: 'approval' });
  await a.until(e => e.subtype === 'init');
  const ans = await ctl(a, 'q2', { subtype: 'side_question', question: 'q', history: [] });
  assert.deepEqual(ans.response.response, { response: 'Side answer' });
  assert.equal(inLines(a, 'turn/start')[0].params.input[0].text, 'q');
  assert.match(a.stderr(), /\{"id":980,"result":\{"decision":"decline"\}\}/);
  assert.ok(!a.events.some(e => e.type === 'control_request'), 'no card');
  await a.stop();
});
