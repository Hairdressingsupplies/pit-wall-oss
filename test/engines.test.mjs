// test/engines.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ENGINES, isEngine, defaultEngine, engineFor, helperModel, findCodex, codexEnabled, setCodexDefault } from '../src/engines.mjs';

const kv = init => ({ m: new Map(Object.entries(init)), get(k, d) { return this.m.has(k) ? this.m.get(k) : d; } });

test('default engine is claude until the setting says codex', () => {
  assert.deepEqual(ENGINES, ['claude', 'codex']);
  assert.equal(defaultEngine(kv({})), 'claude');
  assert.equal(defaultEngine(kv({ defaultEngine: 'codex', codexEnabled: true })), 'codex');
  assert.equal(defaultEngine(kv({ defaultEngine: 'bogus', codexEnabled: true })), 'claude');
  assert.ok(isEngine('codex') && !isEngine('gemini'));
});

test('a per-chat choice overrides the default; an unknown one falls back', () => {
  const s = kv({ defaultEngine: 'codex', codexEnabled: true });
  assert.equal(engineFor(s, 'claude'), 'claude');
  assert.equal(engineFor(s, null), 'codex');
  assert.equal(engineFor(s, 'gemini'), 'codex');
});

test('helper models map Claude tiers to GPT tiers only for codex', () => {
  assert.equal(helperModel('claude', 'haiku'), 'haiku');
  assert.equal(helperModel('codex', 'haiku'), 'gpt-6-luna');
  assert.equal(helperModel('codex', 'sonnet'), 'gpt-6.1-sol');
});

test('findCodex: env wins, then the npm native exe, else null', () => {
  const home = 'C:\\Users\\x';
  assert.equal(findCodex({ PITWALL_CODEX_EXE: 'D:\\c.exe' }, home, p => p === 'D:\\c.exe'), 'D:\\c.exe');
  assert.equal(findCodex({ PITWALL_CODEX_EXE: 'D:\\gone.exe', APPDATA: 'C:\\nowhere' }, home, () => false), null, 'a PITWALL_CODEX_EXE that does not exist is "not installed"');
  const want = path.join('C:\\Users\\x\\AppData\\Roaming', 'npm', 'node_modules', '@openai', 'codex', 'node_modules',
    '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  assert.equal(findCodex({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, home, p => p === want), want);
  assert.equal(findCodex({ APPDATA: 'C:\\nowhere' }, home, () => false), null);
});

test('Codex is off by default: a stored codex default and a codex override both resolve to claude', () => {
  const s = kv({ defaultEngine: 'codex' });
  assert.equal(codexEnabled(s), false);
  assert.equal(defaultEngine(s), 'claude');
  assert.equal(engineFor(s, 'codex'), 'claude');
  assert.equal(engineFor(s, null), 'claude');
  assert.equal(engineFor(s, 'claude'), 'claude');
});

test('codexEnabled: the kv switch wins over the local.json default', () => {
  try {
    setCodexDefault(true);
    assert.equal(codexEnabled(kv({})), true, 'local.json says on');
    assert.equal(codexEnabled(kv({ codexEnabled: false })), false, 'turned off in the panel');
    assert.equal(engineFor(kv({ defaultEngine: 'codex' }), null), 'codex');
    setCodexDefault(false);
    assert.equal(codexEnabled(kv({ codexEnabled: true })), true, 'turned on in the panel');
    assert.equal(codexEnabled(kv({ codexEnabled: 'yes' })), false, 'junk is ignored');
  } finally { setCodexDefault(false); }
});

test('editing an agent while Codex is off keeps its stored GPT model unless model or engine really changed', async () => {
  const { keepStoredModel } = await import('../src/engines.mjs');
  const role = { engine: 'codex', model: 'gpt-6.1-sol' };
  assert.equal(keepStoredModel(role, { enabled: 0 }, false), true, 'unrelated edit');
  assert.equal(keepStoredModel(role, { name: 'x', model: '' }, false), true, 'the Claude-only form sends a blank model');
  assert.equal(keepStoredModel(role, { model: 'opus' }, false), false, 'a Claude model really picked');
  assert.equal(keepStoredModel(role, { model: '', engine: 'claude' }, false), false, 'engine changed');
  assert.equal(keepStoredModel(role, { model: '' }, true), false, 'Codex on: the form shows GPT models, so blank means blank');
  assert.equal(keepStoredModel({ engine: null, model: 'sonnet' }, { model: '' }, false), false, 'a Claude model can be cleared');
  assert.equal(keepStoredModel({ engine: null, model: 'sonnet' }, { enabled: 1 }, false), true);
});
