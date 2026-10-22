import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeHooks, removeHooks, mergeLocal, aboutLine, parseSettings } from '../src/setup.mjs';

const opts = { nodePath: 'C:\\node\\node.exe', root: 'C:\\Users\\m\\Documents\\GitHub\\pit-wall' };
const mine = { hooks: [{ type: 'command', command: 'echo hi' }] };

test('empty settings get the six Pit Wall hooks with forward-slash paths', () => {
  const s = mergeHooks({}, opts);
  assert.deepEqual(Object.keys(s.hooks).sort(), ['Notification', 'PreToolUse', 'SessionEnd', 'Stop', 'UserPromptSubmit']);
  const [cron] = s.hooks.PreToolUse;
  assert.equal(cron.matcher, 'CronCreate');
  assert.equal(cron.hooks[0].async, undefined, 'cron hook is synchronous: it has to be able to deny');
  assert.ok(cron.hooks[0].args[0].endsWith('pit-wall/src/hook-cron.mjs'));
  assert.equal(s.hooks.UserPromptSubmit.length, 2);
  const json = JSON.stringify(s);
  assert.ok(json.includes('C:/Users/m/Documents/GitHub/pit-wall/src/hook-status.mjs'));
  assert.ok(json.includes('"command":"C:/node/node.exe"'));
  const [status, inbox] = s.hooks.UserPromptSubmit.map(e => e.hooks[0]);
  assert.equal(status.async, true);
  assert.equal(inbox.async, undefined, 'inbox hook is synchronous');
  assert.equal(inbox.timeout, 5);
});

test('other hooks and settings are kept, in order', () => {
  const s = mergeHooks({ model: 'opus', hooks: { Stop: [mine], PreToolUse: [mine] } }, opts);
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.hooks.Stop[0], mine);
  assert.equal(s.hooks.Stop.length, 2);
  assert.deepEqual(s.hooks.PreToolUse[0], mine);
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.deepEqual(removeHooks(s).hooks.PreToolUse, [mine], 'uninstall takes the cron hook back out');
});

test('re-running, or after moving the clone, never duplicates', () => {
  const once = mergeHooks({}, { ...opts, root: 'D:\\old\\pit-wall' });
  const twice = mergeHooks(mergeHooks(once, opts), opts);
  assert.equal(twice.hooks.UserPromptSubmit.length, 2);
  assert.equal(twice.hooks.Stop.length, 1);
  assert.equal(twice.hooks.PreToolUse.length, 1);
  assert.ok(!JSON.stringify(twice).includes('D:/old'));
});

test('hand-added entries are recognised and replaced', () => {
  const hand = { hooks: [{ type: 'command', command: 'C:/Program Files/nodejs/node.exe', args: ['C:/Users/me/Documents/GitHub/pit-wall/src/hook-status.mjs'], timeout: 5, async: true }] };
  const s = mergeHooks({ hooks: { Stop: [hand] } }, opts);
  assert.equal(s.hooks.Stop.length, 1);
});

test('remove leaves the user own hooks and drops empty events', () => {
  assert.deepEqual(removeHooks(mergeHooks({ hooks: { Stop: [mine] } }, opts)).hooks, { Stop: [mine] });
  assert.equal(removeHooks(mergeHooks({}, opts)).hooks, undefined);
  assert.deepEqual(removeHooks({}), {});
});

test('local.json: existing keys kept, missing ones added, blanks skipped', () => {
  assert.deepEqual(mergeLocal({ workspace: 'C:\\laragon\\www' }, { name: 'Lee', about: 'x', workspace: 'C:\\y', automation: false, folders: '' }),
    { workspace: 'C:\\laragon\\www', name: 'Lee', about: 'x', automation: false });
});

test('about line reads as a sentence after the name', () => {
  assert.equal(aboutLine('marketing and email', 'Acme'), 'works at Acme on marketing and email.');
  assert.equal(aboutLine('works in the warehouse.', 'Acme'), 'works in the warehouse.');
  assert.equal(aboutLine('', 'Acme'), 'works at Acme.');
  assert.equal(aboutLine('marketing', null), 'works on marketing.');
  assert.equal(aboutLine('', null), 'uses Claude Code for software and other work.');
});

test('settings parsing: missing, empty, BOM, invalid', () => {
  assert.deepEqual(parseSettings(null), {});
  assert.deepEqual(parseSettings('  '), {});
  assert.deepEqual(parseSettings('\uFEFF{"a":1}'), { a: 1 });
  assert.throws(() => parseSettings('{oops'));
});

test('arguments: --codex asks for Codex without a prompt; default is no Codex; unknown flags still fail', async () => {
  const { parseArgs } = await import('../src/setup.mjs');
  assert.equal(parseArgs([]).codex, undefined, 'not asked on the command line: interactive runs ask, others skip');
  assert.equal(parseArgs(['--codex']).codex, true);
  assert.equal(parseArgs(['--no-codex']).codex, false);
  assert.deepEqual({ ...parseArgs(['--name', 'Lee', '--codex']) }, { startup: true, start: true, name: 'Lee', codex: true });
  assert.throws(() => parseArgs(['--codexx']), /Unknown option/);
});

test('the Codex question defaults to No', async () => {
  const { yesNo } = await import('../src/setup.mjs');
  assert.equal(yesNo(''), false);
  assert.equal(yesNo('n'), false);
  assert.equal(yesNo('y'), true);
  assert.equal(yesNo(' Yes '), true);
  assert.equal(yesNo('', true), true, 'a (Y/n) question defaults to yes');
});

test('--check sees Codex switched on in the panel too (kv codexEnabled, read-only), and the panel wins over local.json', async () => {
  const { readKvCodexEnabled, codexOnForCheck } = await import('../src/setup.mjs');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { openDb } = await import('../src/db.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-setup-kv-'));
  const file = path.join(dir, 'pitwall.db');
  assert.equal(readKvCodexEnabled(file), null, 'no database yet');
  const db = openDb(file);
  assert.equal(readKvCodexEnabled(file), null, 'never switched');
  db.set('codexEnabled', true);
  assert.equal(readKvCodexEnabled(file), true);
  db.set('codexEnabled', false);
  assert.equal(readKvCodexEnabled(file), false);
  db.db.close();
  assert.equal(codexOnForCheck(false, null), false);
  assert.equal(codexOnForCheck(true, null), true);
  assert.equal(codexOnForCheck(false, true), true);
  assert.equal(codexOnForCheck(true, false), false);
});

test('setup --codex turns Codex on in a running Pit Wall through its own page API (cookie + Origin)', async () => {
  const { enableOnRunningServer } = await import('../src/setup.mjs');
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push({ url, ...opts });
    if (!opts.method) return { ok: true, status: 200, headers: { get: () => 'pw=abc; HttpOnly; Path=/' } };
    return { ok: true, status: 200, json: async () => ({ enabled: true }) };
  };
  assert.equal(await enableOnRunningServer('http://127.0.0.1:4040/', fetchFn), true);
  const post = calls[1];
  assert.equal(post.url, 'http://127.0.0.1:4040/api/codex/enable');
  assert.equal(post.method, 'POST');
  assert.equal(post.headers.cookie, 'pw=abc');
  assert.equal(post.headers.origin, 'http://127.0.0.1:4040');
  assert.equal(post.body, '{"enabled":true}');
  assert.equal(await enableOnRunningServer('http://127.0.0.1:4040/', async () => { throw new Error('down'); }), false);
  assert.equal(await enableOnRunningServer('http://127.0.0.1:4040/', async (u, o = {}) => (o.method ? { ok: false, status: 404 } : { ok: true, headers: { get: () => 'pw=x' } })), false, 'an older Pit Wall without the route');
});
