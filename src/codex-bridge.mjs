// src/codex-bridge.mjs
// A Codex chat as Pit Wall sees it: drives `codex app-server` and speaks the Claude Code stream-json subset the Runner uses.
// Run by the relay like `claude` would be:
//   node src/codex-bridge.mjs (--session-id <id> | --resume <id>) --replay-user-messages [--model m] [--effort e] [--job] [--name n]
//   A fork: --session-id <new id> --fork-from <source id> [--fork-at <uuid of a message in the source's turn map>]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import { config, paths } from './config.mjs';
import { Rpc } from './codex-rpc.mjs';
import { itemEvents, deltaEvent, approvalToPermission, permissionToApproval, jobDecision, jobConfig, sandboxChoice, turnResult, rateEvent, usageEntry, sumUsage, NO_FILE_UNDO } from './codex-translate.mjs';
import { Transcript, transcriptFile, loadThreadState, saveThreadState, copyTranscript } from './codex-transcript.mjs';

const APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']);
// Pre-v2 approval requests (ExecCommandApprovalResponse / ApplyPatchApprovalResponse: { decision: ReviewDecision }): never shown, so denied.
const LEGACY_APPROVALS = new Set(['execCommandApproval', 'applyPatchApproval']);
// Network off for every chat and job, whatever ~/.codex/config.toml says: no ssh, push or deploy from inside Codex.
// Key as Codex 0.161 names it (config/read → sandbox_workspace_write.network_access; `exec --strict-config` accepts it).
const NO_NETWORK = { 'sandbox_workspace_write.network_access': false };
// Startup requests answer in well under a second; a stuck one should end the chat with an error soon, not after Rpc's 60 s.
const START_MS = Number(process.env.PITWALL_CODEX_START_MS) || 15_000;
// Debugging aid: PITWALL_CODEX_TRACE=<file> appends every raw line Codex writes to stdout to <file>.<bridge pid> (one file per
// bridge, so chats running at once don't interleave). It holds the account email/ids and whole conversations: delete it after use.
// (How test/fixtures/codex-session.jsonl was recorded, then scrubbed.)
const TRACE = process.env.PITWALL_CODEX_TRACE ? `${process.env.PITWALL_CODEX_TRACE}.${process.pid}` : null;
// A /btw answer gives up a little before the runner's 120 s control-request timeout, so you see this message, not a generic one.
const SIDE_MS = Number(process.env.PITWALL_CODEX_SIDE_MS) || 110_000;
const UNMAPPED = 'Not available in this Codex chat (started before Pit Wall could branch Codex chats).';
const BUSY = 'Wait for the reply to finish, then ask.';

const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const opt = f => (argv.includes(f) ? argv[argv.indexOf(f) + 1] ?? null : null);
const resume = flag('--resume');
const id = opt(resume ? '--resume' : '--session-id');
const model = opt('--model');
const effort = opt('--effort');
let job = flag('--job'); // also true when the chat's (or a fork's source's) thread state says it is a job: fail closed
const forkFrom = opt('--fork-from');
const forkAt = opt('--fork-at');
const cwd = process.cwd();

const emitRaw = o => process.stdout.write(JSON.stringify(o) + '\n');

let codex = null;
let exiting = false;
/** Ends the bridge (and Codex with it). stdout/stderr are flushed first so the last line always reaches the relay. */
/** Codex gets its stdin closed and up to 1.5 s to exit by itself (codex.exe takes ~50 ms) before it is killed. */
function quit(code) {
  if (exiting) return;
  exiting = true;
  process.exitCode = code;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (process.stdout.destroyed) return process.exit(code);
    process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
  };
  if (!codex?.pid || codex.exitCode != null || codex.signalCode != null) return finish();
  codex.once('exit', finish);
  try { codex.stdin.end(); } catch { /* already gone */ }
  setTimeout(() => { try { codex.kill(); } catch { /* already gone */ } finish(); }, 1500);
}
// The relay went away mid-write (EPIPE): end Codex rather than crash and leave it running.
process.stdout.on('error', () => { if (!exiting) quit(0); else process.exit(process.exitCode ?? 0); });
function fail(msg, subtype = 'error') {
  if (exiting) return;
  emitRaw({ type: 'result', subtype, is_error: true, result: msg });
  process.stderr.write(msg + '\n');
  quit(1);
}

if (!id) { process.stderr.write('codex-bridge: --session-id or --resume <id> is required\n'); process.exit(2); }
if (!config.codexExe) fail('Codex is not installed on this PC (npm i -g @openai/codex).', 'not_installed');
else main();

function main() {
  // Opened once the thread state is known (a fork after copying the source's history in), so the chain continues from the
  // right entry: the file's last one, or where a rewind left it (state.attach) — the abandoned turn's tail would be wrong.
  const newTranscript = attach => new Transcript(transcriptFile(paths.codexProjectsDir, cwd, id), { sessionId: id, cwd, parent: attach });
  let transcript = null;
  let cur = null; // the open turn's map entry: {turnId, userUuid, itemUuids}
  // Transcript writes during a turn: assistant entries' uuids join the turn map (fork/rewind cut points).
  const save = o => { const uuid = transcript?.append(o); if (uuid && cur && o.type === 'assistant') cur.itemUuids.push(uuid); };
  const emit = o => { emitRaw(o); save(o); };

  let preArgs = [];
  try { preArgs = JSON.parse(process.env.PITWALL_CODEX_PREARGS ?? '[]'); } catch { /* tests only; ignore junk */ }
  codex = spawn(config.codexExe, [...preArgs, 'app-server'], { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  codex.on('error', e => fail(`Could not start Codex: ${e.message}`, 'not_installed'));
  codex.stderr.on('data', d => process.stderr.write(d));
  if (TRACE) codex.stdout.on('data', d => { try { fs.appendFileSync(TRACE, d); } catch { /* tracing must never break a chat */ } });
  codex.on('exit', code => { if (!exiting) quit(code ?? 1); });
  const rpc = new Rpc(codex.stdout, codex.stdin);

  let threadId = null, turnId = null, turnOpen = false, wantInterrupt = false, disabledPluginIds = null;
  let state = null, threadModel = model, turnUsage = null, common = null; // turn map; summed usage this turn; thread overrides
  const calls = new Map();       // turn id → model calls so far (a late usage update must not reuse an entry id)
  const turnEnded = [];          // waiting for the open turn to end (rewind)
  let side = null;               // the /btw question running: {threadId, text, done}
  let rewinding = 0;             // rewinds in progress: no turn may start until the revert is done
  let markStarted;
  const started = new Promise(res => { markStarted = res; }); // control requests can arrive before the thread is ready
  const held = [];               // user messages waiting for the current turn to end (FIFO; priority 'now' goes first)
  const pending = new Map();     // card request_id → { id, method, params } for open approval cards
  const fileChanges = new Map(); // fileChange item id → its changes (approvals carry only the item id)
  const seen = new Set();        // unhandled request methods already logged

  const interrupt = () => {
    if (!turnOpen) return;
    if (!turnId) { wantInterrupt = true; return; } // turn/start not answered yet: interrupt once we know the turn
    wantInterrupt = false;
    rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {});
  };

  function startNext() {
    if (turnOpen || rewinding || !threadId || !held.length) return;
    const m = held.shift();
    turnOpen = true;
    turnId = null;
    wantInterrupt = false;
    const c = m.message?.content;
    const text = typeof c === 'string' ? c : (c ?? []).filter(b => b?.type === 'text').map(b => b.text).join('\n');
    const images = Array.isArray(c)
      ? c.filter(b => b?.type === 'image' && b.source?.data).map(b => ({ type: 'image', url: `data:${b.source.media_type};base64,${b.source.data}` }))
      : [];
    const input = [{ type: 'text', text, text_elements: [] }, ...images];
    if (m.uuid) emitRaw({ type: 'user', isReplay: true, uuid: m.uuid, message: m.message });
    cur = { turnId: null, userUuid: transcript.append({ type: 'user', uuid: m.uuid, message: m.message }), itemUuids: [] };
    if (state.attach !== undefined) { delete state.attach; saveThreadState(paths.codexThreadsDir, id, state); } // the rewind's hang point is used
    emitRaw({ type: 'stream_event', event: { type: 'message_start' } });
    rpc.request('turn/start', { threadId, input, clientUserMessageId: m.uuid ?? null, ...(effort ? { effort } : {}), ...(disabledPluginIds ? { disabledPluginIds } : {}) })
      .then(r => { if (!turnId) turnId = r?.turn?.id ?? null; if (cur && !cur.turnId) cur.turnId = turnId; if (wantInterrupt) interrupt(); })
      .catch(e => { turnOpen = false; cur = null; emitRaw({ type: 'result', subtype: 'error', is_error: true, result: e.message, total_cost_usd: null, usage: null }); endWaiters(); startNext(); });
  }

  // Another thread on this app-server (Task 4's side question) must never stream into the chat. Notifications without a
  // thread id (account/rateLimits/updated, serverRequest/resolved on older builds) are for everyone.
  const mine = p => !p?.threadId || p.threadId === threadId;
  const endWaiters = () => { for (const w of turnEnded.splice(0)) w(); };

  // The /btw thread: only its reply text is kept, for the answer. Nothing streams, nothing is saved, no usage is counted.
  function onSide(method, p) {
    if (method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.text) side.text.push(p.item.text);
    else if (method === 'turn/completed') { side.finished = true; side.done?.(p.turn); }
  }

  /** /btw: one turn on an ephemeral fork of this thread (it sees the chat so far; the chat never sees it). */
  async function sideQuestion({ question, history }) {
    await started;
    if (state.turns === null) throw new Error(UNMAPPED); // a bridge never forks a chat without its turn map
    if (turnOpen || side) throw new Error(BUSY);
    const s = side = { threadId: null, turnId: null, text: [], finished: false, done: null, timer: null };
    const text = [...(Array.isArray(history) ? history : []).map(h => `Q: ${h.question}\nA: ${h.response}`), String(question ?? '')].join('\n');
    try {
      // Always read-only (unelevated on Windows) with no apps or plugins, on top of the chat's no-network/job overrides:
      // /btw only answers, it never changes the project. Codex refuses an ephemeral fork that copies the turns: excludeTurns.
      const sideBox = { ...common, sandbox: 'read-only',
        config: { ...common.config, 'windows.sandbox': 'unelevated', features: { ...common.config.features, apps: false, plugins: false } } };
      const r = await rpc.request('thread/fork', { threadId, ephemeral: true, excludeTurns: true, ...sideBox }, START_MS);
      s.threadId = r.thread.id;
      const ended = new Promise((res, rej) => { s.done = res; s.timer = setTimeout(() => rej(new Error('Codex did not answer in time.')), SIDE_MS); });
      const t = await rpc.request('turn/start', { threadId: s.threadId, input: [{ type: 'text', text, text_elements: [] }],
        ...(effort ? { effort } : {}), ...(disabledPluginIds ? { disabledPluginIds } : {}) });
      s.turnId = t?.turn?.id ?? null;
      const turn = await ended;
      if (turn?.status === 'failed') throw new Error(turn.error?.message ?? 'Codex turn failed');
      return { response: s.text.join('\n\n') };
    } finally {
      clearTimeout(s.timer);
      side = null;
      if (s.turnId && !s.finished) rpc.request('turn/interrupt', { threadId: s.threadId, turnId: s.turnId }).catch(() => {});
      if (s.threadId) rpc.request('thread/unsubscribe', { threadId: s.threadId }).catch(() => {});
    }
  }

  /** Back to before the turn your message `target` started: Codex forgets it and what followed (files stay as they are). */
  async function rewind(target) {
    held.length = 0; // the runner drops messages still queued at a rewind; ones sent after it wait until it is done
    rewinding++;
    try {
      await started;
      if (state.turns === null) throw new Error(UNMAPPED);
      if (turnOpen) {
        const ended = new Promise(res => turnEnded.push(res));
        interrupt();
        await ended;
      }
      const i = state.turns.findIndex(t => t.userUuid === target);
      if (i < 0) { // already gone: a repeated rewind (e.g. into a fresh bridge) must not revert again
        if (state.attach !== undefined) transcript.setParent(state.attach);
        return {};
      }
      await rpc.request('thread/revert', { threadId, beforeTurnId: state.turns[i].turnId });
      // The next message hangs where the target did, so rewoundEntries hides the abandoned branch. Saved with the map, so
      // a bridge started before that message (parked, restarted) hangs it there too.
      const last = state.turns[i - 1];
      state.attach = transcript.parentOf(target) ?? (last ? last.itemUuids.at(-1) ?? last.userUuid : null);
      state.turns = state.turns.slice(0, i);
      saveThreadState(paths.codexThreadsDir, id, state);
      transcript.setParent(state.attach);
      return {};
    } finally {
      rewinding--;
      startNext();
    }
  }

  rpc.on('notification', (method, p) => {
    if (side && p?.threadId === side.threadId) return onSide(method, p);
    if (!mine(p)) return;
    if (method === 'turn/started') { turnId = p.turn?.id ?? turnId; if (cur && !cur.turnId) cur.turnId = turnId; if (wantInterrupt) interrupt(); }
    else if (method === 'item/agentMessage/delta') emitRaw(deltaEvent(p));
    else if (method === 'item/started') {
      if (p.item?.type === 'fileChange') fileChanges.set(p.item.id, p.item.changes ?? []);
      for (const e of itemEvents(p.item, { completed: false })) emit(e);
    } else if (method === 'item/completed') {
      if (p.item?.type === 'fileChange') fileChanges.delete(p.item.id);
      for (const e of itemEvents(p.item, { completed: true })) emit(e);
    } else if (method === 'thread/tokenUsage/updated') {
      // One per model call. The replay a fork emits for its copied turns arrives during startup, before threadId is set, so
      // mine() drops it; the map check is a second guard (and drops a late update for a turn already saved).
      if (!transcript || !p.tokenUsage?.last || state?.turns?.some(t => t.turnId === p.turnId)) return;
      const n = (calls.get(p.turnId) ?? 0) + 1;
      calls.set(p.turnId, n);
      const entry = usageEntry(p.turnId, n, p.tokenUsage.last, threadModel);
      turnUsage = sumUsage(turnUsage, entry.message.usage);
      save(entry); // transcript only: insights and the board count it; the chat never shows it
      emitRaw({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: turnUsage.output_tokens } } });
    } else if (method === 'turn/completed') {
      // Only one turn is ever open, so any card still up belongs to it: withdraw it or the board shows "needs you" forever.
      for (const rid of pending.keys()) emitRaw({ type: 'control_cancel_request', request_id: rid });
      pending.clear();
      fileChanges.clear();
      // Claude Code's own marker for a stopped turn: the history shows it as "Stopped" (transcripts.mjs), as for Claude chats.
      if (p.turn?.status === 'interrupted') emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
      emitRaw(turnResult(p.turn, turnUsage));
      if (cur && !cur.turnId) cur.turnId = p.turn?.id ?? null;
      if (state?.turns && cur?.turnId) { state.turns.push(cur); saveThreadState(paths.codexThreadsDir, id, state); }
      turnOpen = false; turnId = null; wantInterrupt = false; cur = null; turnUsage = null;
      endWaiters();
      startNext();
    } else if (method === 'account/rateLimits/updated') emitRaw(rateEvent(p.rateLimits));
    else if (method === 'error' && p.willRetry) emitRaw({ type: 'system', subtype: 'api_retry', attempt: 1 });
    else if (method === 'serverRequest/resolved') {
      for (const [rid, q] of pending) if (String(q.id) === String(p.requestId)) { pending.delete(rid); emitRaw({ type: 'control_cancel_request', request_id: rid }); }
    }
  });

  rpc.on('request', (rid, method, params) => {
    // Another thread's approval (a /btw side thread): nobody is looking at it, so it is declined and never shown as a card.
    if (APPROVALS.has(method) && params?.threadId && params.threadId !== threadId) return rpc.respond(rid, jobDecision(method, params));
    if (APPROVALS.has(method)) {
      if (job) return rpc.respond(rid, jobDecision(method, params));
      const card = approvalToPermission(rid, method, params);
      const changes = method === 'item/fileChange/requestApproval' ? fileChanges.get(params.itemId) : null;
      if (changes?.length) Object.assign(card.request.input, { file_path: changes.map(c => c.path).join(', '), changes });
      pending.set(card.request_id, { id: rid, method, params });
      return emitRaw(card);
    }
    if (method === 'item/tool/requestUserInput') return rpc.respond(rid, { answers: {} });
    // v2/McpServerElicitationRequestResponse.ts: { action, content: JsonValue | null, _meta: JsonValue | null }
    if (method === 'mcpServer/elicitation/request') return rpc.respond(rid, { action: 'decline', content: null, _meta: null });
    if (LEGACY_APPROVALS.has(method)) return rpc.respond(rid, { decision: { denied: { rejection: 'Pit Wall answers approvals through item/*/requestApproval only.' } } });
    if (!seen.has(method)) { seen.add(method); process.stderr.write(`[codex-bridge] unhandled request ${method}\n`); }
    rpc.respondError(rid, -32601, `Pit Wall does not handle ${method}.`);
  });

  rpc.on('close', () => { if (!exiting && codex.exitCode == null) setTimeout(() => quit(codex.exitCode ?? 1), 2000).unref(); });

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('close', () => quit(0)); // the relay closed us: take Codex down too (Windows won't kill grandchildren for us)
  rl.on('line', l => {
    let m;
    try { m = JSON.parse(l); } catch { return; }
    if (m.type === 'user') {
      if (m.priority === 'now' && turnOpen) { held.unshift(m); interrupt(); }
      else held.push(m);
      return startNext();
    }
    if (m.type === 'control_response') {
      const rid = m.response?.request_id;
      const q = pending.get(rid);
      if (!q) return;
      pending.delete(rid);
      // The response type's permission fields are optional, not nullable: echo only what was actually asked for.
      const params = q.method === 'item/permissions/requestApproval'
        ? { ...q.params, permissions: Object.fromEntries(Object.entries(q.params.permissions ?? {}).filter(([, v]) => v != null)) }
        : q.params;
      return rpc.respond(q.id, permissionToApproval(q.method, params, m.response?.response));
    }
    if (m.type === 'control_request') {
      const sub = m.request?.subtype;
      const ok = (response = {}) => emitRaw({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
      if (sub === 'interrupt') { interrupt(); return ok(); }
      if (sub === 'cancel_async_message') {
        // The runner only drops the message from the chat when this says it was really taken back (not already started).
        const i = held.findIndex(x => x.uuid === m.request.message_uuid);
        if (i >= 0) held.splice(i, 1);
        return ok({ cancelled: i >= 0 });
      }
      const no = error => emitRaw({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error } });
      if (sub === 'rewind_conversation') return rewind(m.request.target_message_uuid).then(ok, e => no(e.message));
      if (sub === 'rewind_files') return no(NO_FILE_UNDO);
      if (sub === 'side_question') return sideQuestion(m.request).then(ok, e => no(e.message));
      return no('Not available in Codex chats.');
    }
  });

  (async () => {
    try {
      await rpc.request('initialize', { clientInfo: { name: 'pitwall', title: 'Pit Wall', version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } }, START_MS);
      rpc.notify('initialized');
      const acct = await rpc.request('account/read', {}, START_MS);
      if (!acct?.account) return fail('Codex is not signed in. Use Settings › Sign in to Codex.', 'not_signed_in');
      const saved = resume ? loadThreadState(paths.codexThreadsDir, id) : null;
      const src = forkFrom ? loadThreadState(paths.codexThreadsDir, forkFrom) : null;
      if (forkFrom && !src?.turns) return fail(UNMAPPED);
      if (saved?.job || src?.job) job = true; // a job's resume or fork is a job, whether or not --job was passed
      // Windows sandbox state decides workspace-write vs read-only (see sandboxChoice). Every probe here fails CLOSED:
      // a failed or timed-out readiness check on Windows, or a failed config/read on a "ready" PC, gives read-only.
      const ready = await rpc.request('windowsSandbox/readiness', {}, START_MS).catch(() => null);
      let cfg = null;
      if (job) {
        // Fail closed: without the effective config we can't name the MCP servers to switch off.
        try { cfg = await rpc.request('config/read', { cwd }, START_MS); } catch (e) { return fail(`Could not check Codex settings: ${e.message}`); }
        if (!cfg?.config) return fail('Could not check Codex settings: no config came back.');
      } else if (ready?.status === 'ready') cfg = await rpc.request('config/read', { cwd }, START_MS).catch(() => null);
      const box = sandboxChoice(ready?.status ?? null, cfg?.config);
      const overrides = { ...NO_NETWORK, ...box.config, ...(job ? jobConfig(cfg.config) : {}) };
      // Every thread this bridge opens (started, resumed, forked) gets these; /btw tightens them to read-only.
      common = { cwd, approvalPolicy: 'on-request', sandbox: box.sandbox, config: overrides, ...(model ? { model } : {}) };
      let r;
      if (forkFrom) {
        // A copy of the source chat up to the turn holding --fork-at (all of it without). Nothing is written unless Codex forks.
        const at = forkAt ? src.turns.findIndex(t => t.userUuid === forkAt || t.itemUuids.includes(forkAt)) : src.turns.length - 1;
        if (forkAt && at < 0) return fail("That reply can't be forked (not in this chat's map).");
        try {
          r = await rpc.request('thread/fork', { threadId: src.threadId, ...(forkAt ? { lastTurnId: src.turns[at].turnId } : {}), ...common }, START_MS);
        } catch (e) { return fail(`Could not fork this chat: ${e.message}`); } // e.g. its turn is still running
        const turns = src.turns.slice(0, at + 1);
        copyTranscript(transcriptFile(paths.codexProjectsDir, cwd, forkFrom), transcriptFile(paths.codexProjectsDir, cwd, id),
          turns.flatMap(t => [t.userUuid, ...t.itemUuids]), id);
        state = { threadId: r.thread.id, turns, ...(job ? { job: true } : {}) };
        saveThreadState(paths.codexThreadsDir, id, state);
        transcript = newTranscript(undefined);
      } else {
        r = saved
          ? await rpc.request('thread/resume', { threadId: saved.threadId, ...common }, START_MS)
          : await rpc.request('thread/start', { ...common, serviceName: 'pitwall' }, START_MS);
        state = saved ?? { threadId: r.thread.id, turns: [] };
        if (job) state.job = true; // saved with the map (an old {threadId}-only file is never rewritten)
        if (!saved) saveThreadState(paths.codexThreadsDir, id, state);
        transcript = newTranscript(state.attach);
      }
      threadModel = r.model ?? model;
      if (job) {
        // v2/PluginInstalledResponse.ts: { marketplaces: [{ plugins: PluginSummary[] }], marketplaceLoadErrors }
        // Fail closed: [] would CLEAR the thread's disabled list and let an unattended job use Gmail/Drive.
        let inst;
        try { inst = await rpc.request('plugin/installed', { cwds: [cwd] }, START_MS); } catch (e) { return fail(`Could not check Codex plugins: ${e.message}`); }
        disabledPluginIds = (inst?.marketplaces ?? []).flatMap(mk => mk.plugins ?? []).filter(pl => pl?.id && pl.installed !== false).map(pl => pl.id);
      }
      // branching: this chat has a turn map, so fork and rewind can find their turns (old chats have none).
      emitRaw({ type: 'system', subtype: 'init', session_id: id, model: threadModel, slash_commands: [], branching: state.turns !== null });
      emitRaw({ type: 'system', subtype: 'status' });
      rpc.request('account/rateLimits/read', {}).then(x => x?.rateLimits && emitRaw(rateEvent(x.rateLimits))).catch(() => {});
      threadId = r.thread.id; // only now may turns start: plugins are known for jobs
      markStarted();
      startNext();
    } catch (e) { fail(`Codex failed to start: ${e.message}`); }
  })();
}
