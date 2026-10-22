// test/fixtures/fake-codex.mjs — a scripted stand-in for `codex app-server`.
// FAKE_CODEX env: 'ok' | 'signed-out' | 'approval' | 'filechange' | 'permissions' | 'resolved' | 'orphan' | 'plugins-fail' | 'config-fail' | 'hang-start' | 'elicit' | 'legacy' | 'sandbox-unset' | 'no-sandbox-method' | 'sandbox-error' | 'sandbox-hang' | 'sandbox-leaky' | 'replay' (plays FAKE_CODEX_REPLAY's recorded turn) | 'foreign' (a normal turn that also sees another thread's reply). Logs every line it receives to stderr as `IN {...}`.
// Branching: thread/fork (ephemeral needs excludeTurns), thread/revert, thread/unsubscribe. A turn on a side thread (thr-side-N)
// answers "Side answer" (in 'approval' mode only after asking for an approval).
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
const mode = process.env.FAKE_CODEX ?? 'ok';
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const log = o => process.stderr.write('IN ' + JSON.stringify(o) + '\n');
const done = status => out({ method: 'turn/completed', params: { threadId: currentThread, turn: { id: `turn-${turn}`, status, error: null } } });
let turn = 0;
let currentThread = 'thr-new'; // from thread/start (thr-new) or the resumed id: every notification carries it, as Codex does
let calls = 0; // model calls so far on this thread
let sideN = 0, sideWait = null; // side threads forked so far; the side approval waiting for our answer
// v2 ThreadTokenUsage for the n-th model call: every call is 100 in (60 cached) / 5 out.
const breakdown = k => ({ totalTokens: 105 * k, inputTokens: 100 * k, cachedInputTokens: 60 * k, cacheWriteInputTokens: 0, outputTokens: 5 * k, reasoningOutputTokens: 0 });
const usage = n => ({ last: breakdown(1), total: breakdown(n), modelContextWindow: 258400 });
// replay: the recorded lines from turn/started on, played in order; a recorded server request waits for our answer.
const recorded = mode === 'replay' ? fs.readFileSync(process.env.FAKE_CODEX_REPLAY, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
let replayAt = -1, replayWait = null;
const recordedThread = recorded.find(r => r.params?.threadId)?.params.threadId; // replay answers thread/start with the recorded thread
function play() {
  while (replayAt < recorded.length) {
    const r = recorded[replayAt++];
    if (r.method && r.id != null) { replayWait = r.id; return out(r); } // carries on when the answer comes back
    if (r.method) out(r);
  }
}
process.stderr.write(`FAKEPID ${process.pid}\n`);
readline.createInterface({ input: process.stdin }).on('line', l => {
  const m = JSON.parse(l); log(m);
  if (mode === 'replay' && m.method === 'turn/start') {
    replayAt = recorded.findIndex(r => r.method === 'turn/started');
    out({ id: m.id, result: { turn: recorded[replayAt].params.turn } });
    return play();
  }
  if (mode === 'replay' && m.id != null && !m.method && m.id === replayWait) { replayWait = null; return play(); }
  if (m.method === 'initialize') return out({ id: m.id, result: { userAgent: 'fake' } });
  if (m.method === 'account/read') return out({ id: m.id, result: { account: mode === 'signed-out' ? null : { type: 'chatgpt', email: 'r@x', planType: 'plus' }, requiresOpenaiAuth: true } });
  // v2/WindowsSandboxReadinessResponse.ts: { status: 'ready' | 'notConfigured' | 'updateRequired' }
  if (m.method === 'windowsSandbox/readiness' && mode === 'sandbox-error') return out({ id: m.id, error: { code: -32603, message: 'sandbox check failed' } });
  if (m.method === 'windowsSandbox/readiness' && mode === 'sandbox-hang') return; // never answers
  if (m.method === 'windowsSandbox/readiness' && mode === 'no-sandbox-method') return out({ id: m.id, error: { code: -32601, message: 'unknown method' } });
  if (m.method === 'windowsSandbox/readiness') return out({ id: m.id, result: { status: mode === 'sandbox-unset' ? 'notConfigured' : 'ready' } });
  // v2/CommandExecParams.ts → CommandExecResponse { exitCode, stdout, stderr }. Sandbox enforcement is simulated: 'ok' is a working
  // elevated sandbox; started with -c windows.sandbox="unelevated" it enforces read-only; otherwise (and 'sandbox-leaky') nothing.
  // The probes it understands: [.., target] writes target; a curl command reports reaching the site (200) unless blocked (000).
  if (m.method === 'command/exec') {
    const pol = m.params.sandboxPolicy ?? {};
    const enforce = process.argv.includes('windows.sandbox="unelevated"') || mode === 'ok';
    const cmd = m.params.command;
    if (/curl/i.test(cmd[0])) {
      const blocked = enforce && !pol.networkAccess;
      return out({ id: m.id, result: blocked ? { exitCode: 7, stdout: '000', stderr: '' } : { exitCode: 0, stdout: '200', stderr: '' } });
    }
    const target = cmd[cmd.length - 1];
    const inside = path.resolve(target).toLowerCase().startsWith(path.resolve(m.params.cwd).toLowerCase() + path.sep);
    if (enforce && !(pol.type === 'workspaceWrite' && inside)) return out({ id: m.id, result: { exitCode: 1, stdout: '', stderr: 'Access is denied.' } });
    fs.writeFileSync(target, 'x');
    return out({ id: m.id, result: { exitCode: 0, stdout: '', stderr: '' } });
  }
  if (m.method === 'thread/start' && mode === 'hang-start') return; // never answers
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    currentThread = m.params.threadId ?? recordedThread ?? 'thr-new';
    if (m.method === 'thread/resume') turn = Number(process.env.FAKE_CODEX_TURNS ?? 0); // turns the resumed thread already had
    return out({ id: m.id, result: { thread: { id: currentThread }, model: 'gpt-6.1-sol' } });
  }
  // v2 ThreadForkParams / ThreadRevertParams. A non-ephemeral fork keeps the source's turn ids and replays their usage.
  if (m.method === 'thread/fork') {
    const { ephemeral, excludeTurns, lastTurnId } = m.params;
    if (ephemeral && !excludeTurns) return out({ id: m.id, error: { code: -32600, message: 'ephemeral paginated thread/fork requires `excludeTurns: true`' } });
    const tid = ephemeral ? `thr-side-${++sideN}` : 'thr-fork';
    out({ id: m.id, result: { thread: { id: tid, ephemeral: !!ephemeral, turns: [] }, model: 'gpt-6.1-sol' } });
    if (ephemeral) return;
    currentThread = tid;
    if (lastTurnId) {
      turn = Number(lastTurnId.replace('turn-', '')); // the fork's next turn follows the copied ones
      out({ method: 'thread/tokenUsage/updated', params: { threadId: tid, turnId: lastTurnId, tokenUsage: usage(1) } });
    }
    return;
  }
  if (m.method === 'thread/revert') {
    const n = /^turn-(\d+)$/.exec(m.params.beforeTurnId)?.[1];
    if (!n || Number(n) > turn) return out({ id: m.id, error: { code: -32600, message: `unknown turn ${m.params.beforeTurnId}` } });
    out({ id: m.id, result: { thread: { id: m.params.threadId }, turnsBackwardsCursor: null, itemsBackwardsCursor: null } });
    return out({ method: 'thread/reverted', params: { threadId: m.params.threadId } });
  }
  if (m.method === 'thread/unsubscribe') return out({ id: m.id, result: {} });
  if (m.method === 'turn/start' && String(m.params.threadId).startsWith('thr-side')) {
    const side = { threadId: m.params.threadId, turnId: `side-turn-${sideN}` };
    out({ id: m.id, result: { turn: { id: side.turnId, status: 'inProgress' } } });
    out({ method: 'turn/started', params: { threadId: side.threadId, turn: { id: side.turnId } } });
    const finish = () => {
      out({ method: 'item/agentMessage/delta', params: { ...side, itemId: 's1', delta: 'Side' } });
      out({ method: 'item/completed', params: { ...side, item: { type: 'agentMessage', id: 's1', text: 'Side answer' } } });
      out({ method: 'thread/tokenUsage/updated', params: { ...side, tokenUsage: usage(1) } });
      out({ method: 'turn/completed', params: { threadId: side.threadId, turn: { id: side.turnId, status: 'completed', error: null } } });
    };
    if (mode !== 'approval') return finish();
    sideWait = { id: 980, finish };
    return out({ id: 980, method: 'item/commandExecution/requestApproval', params: { command: 'rm x', cwd: '.', itemId: 'sc1', ...side } });
  }
  if (sideWait && m.id === sideWait.id && !m.method) { const f = sideWait.finish; sideWait = null; return f(); }
  if (m.method === 'account/rateLimits/read') return out({ id: m.id, result: { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1 }, secondary: null } } });
  if (m.method === 'model/list') return out({ id: m.id, result: { data: [{ id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], isDefault: true }], nextCursor: null } });
  // v2/ConfigReadResponse.ts: { config, origins, layers }
  if (m.method === 'config/read' && mode === 'config-fail') return out({ id: m.id, error: { code: -32603, message: 'bad config.toml' } });
  if (m.method === 'config/read') return out({ id: m.id, result: { config: { model: null, mcp_servers: { 'shop.tools': { command: 'node', enabled: true } } }, origins: {}, layers: null } });
  // Shape per v2/PluginInstalledResponse.ts: marketplaces[].plugins[] (PluginSummary).
  if (m.method === 'plugin/installed' && mode === 'plugins-fail') return out({ id: m.id, error: { code: -32603, message: 'marketplace unavailable' } });
  if (m.method === 'plugin/installed') return out({ id: m.id, result: { marketplaces: [{ name: 'openai', path: null, interface: null,
    plugins: [{ id: 'gmail', name: 'Gmail', installed: true, enabled: true }, { id: 'drive', name: 'Drive', installed: false, enabled: false }] }], marketplaceLoadErrors: [] } });
  if (m.method === 'turn/interrupt') { out({ id: m.id, result: {} }); return done('interrupted'); }
  if (m.method === 'turn/start') {
    turn++;
    const t = `turn-${turn}`;
    out({ id: m.id, result: { turn: { id: t, status: 'inProgress' } } });
    out({ method: 'turn/started', params: { threadId: currentThread, turn: { id: t } } });
    if (mode === 'orphan') { // a card is up, then the turn ends without serverRequest/resolved
      out({ id: 900 + turn, method: 'item/commandExecution/requestApproval', params: { command: 'rm -rf x', cwd: '.', itemId: 'c1', threadId: currentThread, turnId: t } });
      return setTimeout(() => done('completed'), 100);
    }
    if (mode === 'elicit') {
      out({ id: 950, method: 'mcpServer/elicitation/request', params: { threadId: currentThread, serverName: 's', message: 'pick' } });
      out({ id: 951, method: 'item/tool/requestUserInput', params: { threadId: currentThread, turnId: t, itemId: 'q1', questions: [] } });
      return setTimeout(() => done('completed'), 100);
    }
    if (mode === 'legacy') { // pre-v2 approvals and a request Pit Wall doesn't know
      out({ id: 960, method: 'execCommandApproval', params: { conversationId: currentThread, callId: 'c', command: ['git', 'push'], cwd: '.', parsedCmd: [] } });
      out({ id: 961, method: 'applyPatchApproval', params: { conversationId: currentThread, callId: 'p', fileChanges: {} } });
      out({ id: 962, method: 'item/tool/call', params: { threadId: currentThread, turnId: t, callId: 'd', tool: 'x', arguments: {} } });
      return setTimeout(() => done('completed'), 100);
    }
    if (mode === 'approval' || mode === 'resolved') {
      out({ id: 900 + turn, method: 'item/commandExecution/requestApproval', params: { command: 'git push', cwd: '.', itemId: 'c1', threadId: currentThread, turnId: t } });
      if (mode === 'resolved') { out({ method: 'serverRequest/resolved', params: { threadId: currentThread, requestId: 900 + turn } }); done('completed'); }
      return;
    }
    if (mode === 'filechange') {
      out({ method: 'item/started', params: { threadId: currentThread, turnId: t, item: { type: 'fileChange', id: 'fc1', status: 'inProgress',
        changes: [{ path: 'a.txt', kind: { type: 'add' }, diff: '+a' }, { path: 'b.txt', kind: { type: 'update', move_path: null }, diff: '-b' }] } } });
      return out({ id: 900 + turn, method: 'item/fileChange/requestApproval', params: { threadId: currentThread, turnId: t, itemId: 'fc1', startedAtMs: 1 } });
    }
    if (mode === 'permissions') {
      return out({ id: 900 + turn, method: 'item/permissions/requestApproval', params: { threadId: currentThread, turnId: t, itemId: 'p1', environmentId: null, startedAtMs: 1,
        cwd: '.', reason: 'write outside', permissions: { network: null, fileSystem: { read: null, write: ['C:/x'] } } } });
    }
    if (m.params.input.find(i => i.type === 'text')?.text === 'slow') return; // stays open until interrupted
    const mine = { threadId: currentThread, turnId: t };
    out({ method: 'item/agentMessage/delta', params: { ...mine, itemId: `m${turn}`, delta: 'Hel' } });
    if (mode === 'foreign') { // another thread on the same app-server (a side question) talks while our turn runs
      out({ method: 'item/agentMessage/delta', params: { threadId: 'other-thread', turnId: 'x-1', itemId: 'o1', delta: 'other' } });
      out({ method: 'item/completed', params: { threadId: 'other-thread', turnId: 'x-1', item: { type: 'agentMessage', id: 'o1', text: 'other reply' } } });
      out({ method: 'thread/tokenUsage/updated', params: { threadId: 'other-thread', turnId: 'x-1', tokenUsage: usage(999) } });
    }
    out({ method: 'item/completed', params: { ...mine, item: { type: 'agentMessage', id: `m${turn}`, text: `Hello ${turn}` } } });
    // One notification per model call (Codex 0.161): `last` is that call, `total` the thread's running sum.
    out({ method: 'thread/tokenUsage/updated', params: { ...mine, tokenUsage: usage(++calls) } });
    out({ method: 'thread/tokenUsage/updated', params: { ...mine, tokenUsage: usage(++calls) } });
    return done('completed');
  }
  if (m.id != null && m.result && !m.method && mode !== 'elicit' && mode !== 'orphan' && mode !== 'legacy') done('completed'); // our answer to an approval
});
