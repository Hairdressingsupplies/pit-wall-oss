// src/codex-exec.mjs
// One-off Codex calls outside a chat: account/usage/models (a throwaway app-server) and helper prompts (codex exec).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Rpc } from './codex-rpc.mjs';
import { rateEvent } from './codex-translate.mjs';
import { EFFORTS, childEnv } from './protocol.mjs';

const MODELS_CLAUDE = ['', 'opus', 'sonnet', 'haiku', 'fable'];
/** Claude model aliases (never valid on Codex). */
export const CLAUDE_ALIASES = MODELS_CLAUDE.filter(Boolean);
// Before Pit Wall has read Codex's model list (never signed in yet): the efforts Codex models offer.
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function validModel(engine, model, codexModels = []) {
  if (engine !== 'codex') return MODELS_CLAUDE.includes(model ?? '');
  if (!model) return true;
  return codexModels.length ? codexModels.some(m => m.id === model) : /^[a-z0-9][a-z0-9.\-]{1,40}$/.test(model);
}

/** Claude: one of EFFORTS. Codex: one the chosen model offers (no model chosen: one any model offers). '' = the default. */
export function validEffort(engine, effort, model, codexModels = []) {
  if (!effort) return true;
  if (engine !== 'codex') return EFFORTS.includes(effort);
  if (!codexModels.length) return CODEX_EFFORTS.includes(effort);
  const m = model ? codexModels.find(x => x.id === model) : null;
  const offered = m ? m.efforts ?? [] : codexModels.flatMap(x => x.efforts ?? []);
  return offered.includes(effort);
}

export async function codexAccount({ exe, preArgs = [], env = process.env, spawnFn = spawn, timeoutMs = 15_000 }) {
  const none = { installed: false, signedIn: false, email: null, plan: null, rate: null, models: [], sandbox: null };
  if (!exe) return none;
  let p;
  try { p = spawnFn(exe, [...preArgs, 'app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); } catch { return none; }
  p.on?.('error', () => { /* couldn't start or went away: the requests below fail and say so */ });
  const rpc = new Rpc(p.stdout, p.stdin);
  const done = r => { try { p.kill(); } catch { /* gone */ } return r; };
  try {
    await rpc.request('initialize', { clientInfo: { name: 'pitwall', title: 'Pit Wall', version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } }, timeoutMs);
    rpc.notify('initialized');
    // Windows sandbox state for the Codex panel: 'ready' | 'notConfigured' | 'updateRequired' (null: not Windows, or no answer).
    const sandbox = (await rpc.request('windowsSandbox/readiness', {}, timeoutMs).catch(() => null))?.status ?? null;
    const acct = await rpc.request('account/read', {}, timeoutMs);
    if (!acct?.account) return done({ ...none, installed: true, sandbox });
    const [rl, ml] = await Promise.all([rpc.request('account/rateLimits/read', {}, timeoutMs).catch(() => null), rpc.request('model/list', {}, timeoutMs).catch(() => null)]);
    return done({ installed: true, signedIn: true, sandbox, email: acct.account.email ?? null, plan: acct.account.planType ?? null,
      rate: rl?.rateLimits ? rateEvent(rl.rateLimits).rate_limit_info : null,
      models: (ml?.data ?? []).filter(m => !m.hidden).map(m => ({ id: m.id, name: m.displayName, efforts: (m.supportedReasoningEfforts ?? []).map(e => e.reasoningEffort), isDefault: !!m.isDefault })) });
  } catch { return done({ ...none, installed: true }); }
}

// Parity with Claude helpers' `--tools '' --strict-mcp-config`: no MCP servers from ~/.codex/config.toml (--ignore-user-config
// stops them starting; auth still comes from CODEX_HOME), no ChatGPT apps/connectors, no plugins, no web search.
// --strict-config makes Codex refuse a key it doesn't know, so a rename in a later Codex fails the helper instead of
// silently leaving a tool on (all four keys accepted by 0.161 under --strict-config).
export const HELPER_ISOLATION = ['--ignore-user-config', '--strict-config', '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'web_search="disabled"'];
// Windows: with no sandbox set up Codex enforces nothing, so `--sandbox read-only` would let a helper write files and use the
// network. The unelevated sandbox (no admin) does enforce read-only and blocks the network (checked on 0.161, see sandboxChoice).
export const HELPER_SANDBOX = process.platform === 'win32' ? ['-c', 'windows.sandbox="unelevated"'] : [];

const isObjectSchema = s => s.type === 'object' || (Array.isArray(s.type) && s.type.includes('object')) || 'properties' in s;
const SUBSCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'allOf']);

/**
 * `codex exec --output-schema` asks for strict structured output: every object closed (additionalProperties false) and
 * every property listed in `required`. A property that was optional becomes required-but-nullable instead; the nulls
 * are dropped again from the reply (dropOptionalNulls), so callers see the same shape Claude gives them.
 * Returns a new schema; the one passed in (shared with the Claude path) is never changed.
 */
export function strictSchema(schema) {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'properties' || k === 'required' || k === 'additionalProperties') continue;
    out[k] = k === 'items' || SUBSCHEMA_LISTS.has(k) ? strictSchema(v) : structuredClone(v);
  }
  if (isObjectSchema(schema)) {
    const required = new Set(schema.required ?? []);
    const props = Object.entries(schema.properties ?? {});
    // anyOf, not type: [t, 'null']: an enum-only property has no type to widen.
    out.properties = Object.fromEntries(props.map(([k, v]) => [k, required.has(k) ? strictSchema(v) : { anyOf: [strictSchema(v), { type: 'null' }] }]));
    out.required = props.map(([k]) => k);
    out.additionalProperties = false;
  }
  return out;
}

/** Undo strictSchema's nullable stand-ins: drop a null under a key the ORIGINAL schema left optional (a required null stays). */
export function dropOptionalNulls(value, schema) {
  if (value == null || !schema || typeof schema !== 'object') return value;
  if (Array.isArray(value)) return schema.items ? value.map(v => dropOptionalNulls(v, schema.items)) : value;
  if (typeof value !== 'object' || !schema.properties) return value;
  const required = new Set(schema.required ?? []);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const sub = schema.properties[k];
    if (v === null && sub && !required.has(k)) continue;
    out[k] = sub ? dropOptionalNulls(v, sub) : v;
  }
  return out;
}

/** One isolated helper prompt on Codex: read-only sandbox, nothing saved, structured output when a schema is given. */
export function callCodex({ exe, cwd, model, prompt, schema = null, timeoutMs = 240_000, spawnFn = spawn, onSpawn = () => {} }) {
  fs.mkdirSync(cwd, { recursive: true });
  const schemaFile = schema ? path.join(cwd, `schema-${randomUUID()}.json`) : null;
  if (schemaFile) fs.writeFileSync(schemaFile, JSON.stringify(strictSchema(schema)));
  const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', ...(model ? ['-m', model] : []),
    '-c', 'model_reasoning_effort="low"', ...HELPER_ISOLATION, ...HELPER_SANDBOX, ...(schemaFile ? ['--output-schema', schemaFile] : []), '-'];
  return new Promise(resolve => {
    let buf = '', err = '', text = null, failed = null, lastError = null, settled = false, timer = null;
    const finish = r => { if (settled) return; settled = true; clearTimeout(timer); if (schemaFile) fs.rmSync(schemaFile, { force: true }); resolve(r); };
    if (!exe) return finish({ ok: false, error: 'Codex is not installed.' });
    let proc;
    try { proc = spawnFn(exe, args, { cwd, env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return finish({ ok: false, error: e.message }); }
    onSpawn(proc.pid);
    timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } finish({ ok: false, error: 'Codex helper timed out' }); }, timeoutMs);
    // The JSONL event names live here only, so they are easy to fix once checked against a signed-in run.
    const line = l => {
      let e; try { e = JSON.parse(l); } catch { return; }
      if (e.type === 'item.completed' && e.item?.type === 'agent_message') text = e.item.text;
      if (e.type === 'turn.failed') failed = e.error?.message ?? e.message ?? 'Codex helper failed';
      // Top-level `error` events can be transient (0.161 sends "Reconnecting... 2/5 (…)" and then carries on): only the reason if no reply comes.
      if (e.type === 'error') lastError = e.message ?? e.error?.message ?? 'Codex helper failed';
    };
    proc.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    proc.stderr.on('data', d => { err = (err + d).slice(-2000); });
    proc.stdin.on?.('error', () => { /* process went away before reading the prompt */ });
    proc.on('error', e => finish({ ok: false, error: e.message }));
    proc.on('close', () => { // 'close' (not 'exit'): stdout is fully drained, so the final agent_message isn't lost
      if (buf.trim()) line(buf);
      if (failed) return finish({ ok: false, costUsd: null, error: failed });
      if (text == null) return finish({ ok: false, error: lastError ?? (err.trim().slice(-300) || 'Codex returned nothing') });
      if (!schema) return finish({ ok: true, text, costUsd: null });
      let data;
      try { data = JSON.parse(text); } catch { return finish({ ok: false, error: 'No structured output' }); }
      finish({ ok: true, data: dropOptionalNulls(data, schema), text, costUsd: null });
    });
    proc.stdin.end(prompt);
  });
}
