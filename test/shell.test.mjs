import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runShell, shellItem, shellContext, parseShellBlocks } from '../src/shell.mjs';
import { Runner } from '../src/runner.mjs';
import { readHistory } from '../src/transcripts.mjs';

test('runShell runs a command in the folder and captures output and exit code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-sh-'));
  const ok = await runShell('echo hello && pwd', { cwd: dir });
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /hello/);
  assert.match(ok.stdout.toLowerCase(), new RegExp(path.basename(dir).toLowerCase()));
  const bad = await runShell('echo oops 1>&2; exit 3', { cwd: dir });
  assert.equal(bad.code, 3);
  assert.match(bad.stderr, /oops/);
});

test('a command that runs too long is stopped', async () => {
  const r = await runShell('sleep 20', { cwd: os.tmpdir(), timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.match(shellItem('sleep 20', r).stderr, /stopped/);
});

test('runShell reports output as it arrives, before the command ends', async () => {
  const seen = [];
  const r = await runShell('echo first; sleep 1; echo second', { cwd: os.tmpdir(), onOutput: (text, stream) => seen.push({ text, stream, at: Date.now() }) });
  const doneAt = Date.now();
  assert.equal(r.code, 0);
  const first = seen.find(s => /first/.test(s.text));
  assert.ok(first, 'saw the first line');
  assert.equal(first.stream, 'stdout');
  assert.ok(doneAt - first.at >= 500, 'the first line came before the command finished');
});

test('runShell can be stopped', async () => {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 300);
  const started = Date.now();
  const r = await runShell('sleep 20', { cwd: os.tmpdir(), signal: ctrl.signal });
  assert.ok(Date.now() - started < 10_000);
  assert.equal(r.stopped, true);
  assert.match(shellItem('sleep 20', r).stderr, /stopped/i);
});

test('shellContext round-trips through parseShellBlocks (so history shows it as a command, not raw tags)', () => {
  const item = shellItem('docker ps', { stdout: 'CONTAINER ID\n', stderr: '', code: 0 });
  const parsed = parseShellBlocks(`${shellContext(item)}\n\nwhat is running?`);
  assert.deepEqual(parsed.items, [{ command: 'docker ps', stdout: 'CONTAINER ID', stderr: '' }]);
  assert.equal(parsed.rest, 'what is running?');
  assert.equal(parseShellBlocks('plain message'), null);
});

test('the runner sends the shell context to Claude but shows only what you typed', async () => {
  const procs = [];
  const spawnFn = () => {
    const p = new EventEmitter();
    p.pid = 1; p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.written = [];
    p.stdin = { write: s => { p.written.push(JSON.parse(s)); return true; } };
    procs.push(p);
    return p;
  };
  const runner = new Runner({ claudeExe: 'claude', killFn: async () => {}, spawnFn });
  const id = runner.start({ cwd: 'C:\\x' });
  runner.send(id, 'why?', { context: '<bash-input>ls</bash-input>' });
  assert.equal(procs[0].written[0].message.content, '<bash-input>ls</bash-input>\n\nwhy?');
  assert.equal(runner.get(id).items.at(-1).text, 'why?');
  await runner.shutdown();
});

test('history shows "! command" entries as shell items, including terminal-style split output', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-sh-')), 's.jsonl');
  const user = (content, ts) => JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content } });
  fs.writeFileSync(f, [
    user('<bash-input>git status</bash-input>\n<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>\n\nok?', '2026-10-01T10:00:00Z'),
    user('<bash-input>docker ps</bash-input>', '2026-10-01T10:01:00Z'),
    user('<bash-stdout>CONTAINER</bash-stdout><bash-stderr></bash-stderr>', '2026-10-01T10:01:01Z'),
  ].join('\n') + '\n');
  const { items } = readHistory(f);
  assert.deepEqual(items.map(i => [i.kind, i.command ?? i.text, i.stdout]), [
    ['shell', 'git status', 'clean'], ['user', 'ok?', undefined], ['shell', 'docker ps', 'CONTAINER']]);
});
