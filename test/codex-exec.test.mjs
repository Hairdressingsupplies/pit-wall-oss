import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callCodex, strictSchema, dropOptionalNulls } from '../src/codex-exec.mjs';
import { callModel, RESULT_SCHEMA } from '../src/organiser.mjs';
import { SCHEMA as TITLE_SCHEMA } from '../src/titler.mjs';
import { REVIEW_SCHEMA } from '../src/nightly-review.mjs';
import { ROUNDUP_SCHEMA } from '../src/roundup.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex-exec.mjs');
const made = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-exec-')); made.push(d); return d; };
after(() => { for (const d of made) try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ } });
const via = (mode, extra = {}) => (exe, args, opts) => spawn(process.execPath, [FAKE, ...args], { ...opts, env: { ...process.env, FAKE_EXEC: mode, ...extra } });

test('callCodex returns structured output, read-only and nothing saved', async () => {
  const cwd = tmpDir();
  const r = await callCodex({ exe: 'codex.exe', cwd, model: 'gpt-6-luna', prompt: 'name it', schema: { type: 'object' }, spawnFn: via('ok') });
  assert.equal(r.ok, true);
  assert.equal(r.data.title, 'Fix login');
  const args = r.data.args;
  for (const f of ['exec', '--json', '--ephemeral', '--output-schema']) assert.ok(args.includes(f), f);
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-6-luna');
  // No MCP servers, apps, plugins or web search (Claude helpers: --tools '' --strict-mcp-config)
  for (const f of ['--ignore-user-config', '--strict-config']) assert.ok(args.includes(f), f);
  const overrides = args.flatMap((a, i) => (a === '-c' ? [args[i + 1]] : []));
  for (const c of ['features.apps=false', 'features.plugins=false', 'web_search="disabled"']) assert.ok(overrides.includes(c), c);
  // Windows: an unset sandbox enforces nothing, so helpers pin the unelevated one (which does enforce read-only)
  assert.equal(overrides.includes('windows.sandbox="unelevated"'), process.platform === 'win32');
});

test('callCodex reports a failed turn', async () => {
  const cwd = tmpDir();
  const r = await callCodex({ exe: 'codex.exe', cwd, model: 'm', prompt: 'x', schema: null, spawnFn: via('fail') });
  assert.deepEqual([r.ok, r.error], [false, 'Usage limit reached']);
});

test('callCodex: a transient error event (reconnecting) is not a failure; with no reply it is the reason', async () => {
  const cwd = tmpDir();
  const r = await callCodex({ exe: 'codex.exe', cwd, model: 'm', prompt: 'x', schema: TITLE_SCHEMA, spawnFn: via('reconnect') });
  assert.equal(r.ok, true);
  assert.equal(r.data.title, 'Fix login');
  const r2 = await callCodex({ exe: 'codex.exe', cwd, model: 'm', prompt: 'x', schema: null, spawnFn: via('reconnect-fail') });
  assert.deepEqual([r2.ok, r2.error], [false, 'Reconnecting... 2/5 (stream disconnected)']);
});

test('callModel with engine codex spawns the Codex exe, not claudeExe', async () => {
  const cwd = tmpDir();
  const exes = [], pids = [];
  const spawnFn = (exe, args, opts) => { exes.push(exe); return via('ok')(exe, args, opts); };
  const models = [{ id: 'gpt-6-luna', isDefault: false }, { id: 'gpt-6.1-sol', isDefault: true }];
  const r = await callModel({ engine: 'codex', claudeExe: 'claude.exe', codexExe: 'codex.exe', cwd, model: 'haiku', prompt: 'x', schema: { type: 'object' }, spawnFn, onSpawn: pid => pids.push(pid), codexModels: models });
  assert.equal(pids.length, 1);
  assert.deepEqual(exes, ['codex.exe']);
  assert.equal(r.ok, true);
  assert.equal(r.data.args[r.data.args.indexOf('-m') + 1], 'gpt-6-luna');
});

test('callModel on Codex: an unlisted helper model falls back to the default; no list → no -m', async () => {
  const cwd = tmpDir();
  const run = codexModels => callModel({ engine: 'codex', codexExe: 'codex.exe', cwd, model: 'haiku', prompt: 'x', schema: { type: 'object' }, spawnFn: via('ok'), codexModels });
  const listed = (await run([{ id: 'gpt-7', isDefault: true }, { id: 'gpt-7-mini', isDefault: false }])).data.args;
  assert.equal(listed[listed.indexOf('-m') + 1], 'gpt-7');
  assert.ok(!(await run([])).data.args.includes('-m'), 'nothing cached: Codex picks');
  assert.ok(!(await run([{ id: 'gpt-7', isDefault: false }])).data.args.includes('-m'), 'no default either: Codex picks');
});

import { pickHelperModel } from '../src/engines.mjs';
test('pickHelperModel', () => {
  const list = [{ id: 'a', isDefault: false }, { id: 'b', isDefault: true }];
  assert.equal(pickHelperModel('a', list), 'a');
  assert.equal(pickHelperModel('zzz', list), 'b');
  assert.equal(pickHelperModel('a', []), null);
  assert.equal(pickHelperModel('a', undefined), null);
});

import { shouldPollCodex, codexPollBackoff } from '../src/engines.mjs';
test('shouldPollCodex: only when stale and not recently found signed out', () => {
  const now = Date.parse('2026-10-08T12:00:00Z'), staleMin = 10;
  const fresh = { capturedAt: new Date(now - 60_000).toISOString() }, old = { capturedAt: new Date(now - 20 * 60_000).toISOString() };
  assert.equal(shouldPollCodex({ rateCodex: fresh, now, staleMin }), false);
  assert.equal(shouldPollCodex({ rateCodex: old, now, staleMin }), true);
  assert.equal(shouldPollCodex({ rateCodex: null, now, staleMin }), true);
  assert.equal(shouldPollCodex({ rateCodex: old, lastSignedOutAt: now - 60_000, now, staleMin }), false);
  assert.equal(shouldPollCodex({ rateCodex: old, lastSignedOutAt: now - 6 * 60_000, now, staleMin }), true);
  // What starts the back-off: signed out, or signed in with no usage reading; a good reading clears it.
  const rate = { unifiedWindows: {} };
  assert.equal(codexPollBackoff({ signedIn: false, rate: null }, now), now);
  assert.equal(codexPollBackoff({ signedIn: true, rate: null }, now), now);
  assert.equal(codexPollBackoff({ signedIn: true, rate }, now), 0);
  assert.equal(codexPollBackoff(null, now), 0);
  assert.equal(shouldPollCodex({ rateCodex: old, lastSignedOutAt: codexPollBackoff({ signedIn: true, rate: null }, now - 60_000), now, staleMin }), false);
});

// Every object closed and fully required; an originally optional property only via a nullable anyOf.
function assertStrict(strict, orig, at = '$') {
  if (!strict || typeof strict !== 'object') return;
  if (orig.items) assertStrict(strict.items, orig.items, at + '[]');
  if (orig.type !== 'object') return;
  assert.equal(strict.additionalProperties, false, at);
  assert.deepEqual(strict.required, Object.keys(orig.properties ?? {}), at);
  for (const [k, v] of Object.entries(orig.properties ?? {})) {
    if ((orig.required ?? []).includes(k)) { assertStrict(strict.properties[k], v, `${at}.${k}`); continue; }
    assert.deepEqual(strict.properties[k].anyOf[1], { type: 'null' }, `${at}.${k} nullable`);
    assertStrict(strict.properties[k].anyOf[0], v, `${at}.${k}`);
  }
}

test('strictSchema makes every helper schema strict without touching the original', () => {
  for (const [name, schema] of Object.entries({ RESULT_SCHEMA, TITLE_SCHEMA, REVIEW_SCHEMA, ROUNDUP_SCHEMA })) {
    const before = structuredClone(schema);
    const strict = strictSchema(schema);
    assertStrict(strict, schema, name);
    assert.deepEqual(schema, before, `${name} unchanged (the Claude path uses it)`);
  }
  const item = strictSchema(RESULT_SCHEMA).properties.checklist.items.properties;
  const states = RESULT_SCHEMA.properties.checklist.items.properties.update.items.properties.state.enum;
  assert.deepEqual(item.update.anyOf[0].items.properties.state, { anyOf: [{ enum: states }, { type: 'null' }] }, 'optional enum: nullable via anyOf');
  assert.deepEqual(item.add.anyOf[0].items.properties.state, { enum: states }, 'required enum: as it was');
  assert.deepEqual(strictSchema(RESULT_SCHEMA).properties.assignments.items.properties.project, { type: ['string', 'null'] }, 'required stays as it was');
});

test('dropOptionalNulls drops nulls only where the original schema made a key optional', () => {
  const reply = { new_projects: [], project_updates: [{ id: 'p1', name: null, description: null, archive: null }],
    assignments: [{ session: 's1', project: null }],
    checklist: [{ project: 'p1', add: null, update: [{ id: 3, state: null, text: 'x' }] }] };
  assert.deepEqual(dropOptionalNulls(reply, RESULT_SCHEMA), { new_projects: [], project_updates: [{ id: 'p1' }],
    assignments: [{ session: 's1', project: null }], checklist: [{ project: 'p1', update: [{ id: 3, text: 'x' }] }] });
});

test('callCodex writes the strict schema and hands back the reply without stand-in nulls', async () => {
  const cwd = tmpDir();
  const r = await callCodex({ exe: 'codex.exe', cwd, model: 'm', prompt: 'x', schema: TITLE_SCHEMA, spawnFn: via('ok') });
  assert.deepEqual(r.data.schema, strictSchema(TITLE_SCHEMA));
  const text = JSON.stringify({ new_projects: [], project_updates: [{ id: 'p2', archive: null }], assignments: [], checklist: [] });
  const r2 = await callCodex({ exe: 'codex.exe', cwd, model: 'm', prompt: 'x', schema: RESULT_SCHEMA, spawnFn: via('ok', { FAKE_EXEC_TEXT: text }) });
  assert.deepEqual(r2.data.project_updates, [{ id: 'p2' }]);
  assert.deepEqual(fs.readdirSync(cwd).filter(f => f.startsWith('schema-')), [], 'schema file removed');
});
