// test/files.test.mjs — downloading a file a chat mentions: only documents, only inside the workspace, never secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDownload, downloadHeaders, cleanPath, transcriptFolders, transcriptPaths } from '../src/files.mjs';
import { renderMarkdown } from '../public/markdown.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-files-'));
const ws = path.join(tmp, 'ws');
const outside = path.join(tmp, 'outside');
const data = path.join(ws, 'pit-wall', 'data');
for (const d of [path.join(ws, 'repo', 'out'), path.join(ws, 'repo', '.git'), outside, data]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(ws, 'repo', 'out', 'prices.csv'), 'sku,price\n');
fs.writeFileSync(path.join(ws, 'repo', '.env'), 'SECRET=1');
fs.writeFileSync(path.join(ws, 'repo', '.git', 'notes.txt'), 'x');
fs.writeFileSync(path.join(ws, 'repo', 'appsettings.json'), '{}');
fs.writeFileSync(path.join(outside, 'leak.csv'), 'x');
fs.writeFileSync(path.join(data, 'chats.csv'), 'x');
const opts = { cwd: path.join(ws, 'repo'), roots: [ws], blocked: [data] };
const status = fn => { try { fn(); return 200; } catch (e) { return e.status; } };

test('a document inside the workspace resolves, absolute or relative to the chat folder', () => {
  const a = resolveDownload(path.join(ws, 'repo', 'out', 'prices.csv'), opts);
  assert.equal(a.name, 'prices.csv');
  assert.equal(a.type, 'text/csv');
  assert.equal(resolveDownload('out/prices.csv', opts).file, a.file);
  assert.equal(resolveDownload('out\\prices.csv:12', opts).file, a.file);
});

test('a document downloads from any folder on the PC, hidden ones included', () => {
  assert.equal(status(() => resolveDownload('.git/notes.txt', opts)), 200);
  assert.equal(status(() => resolveDownload('../../outside/leak.csv', opts)), 200);
  assert.equal(status(() => resolveDownload(path.join(outside, 'leak.csv'), opts)), 200);
});

test('a ~ path means the home folder', () => {
  assert.equal(cleanPath('~/notes/a.md'), path.join(os.homedir(), 'notes/a.md'));
});

test('secrets, code, Pit Wall data and network paths are refused', () => {
  assert.equal(status(() => resolveDownload('.env', opts)), 403);
  assert.equal(status(() => resolveDownload('appsettings.json', opts)), 403);
  assert.equal(status(() => resolveDownload(path.join(data, 'chats.csv'), opts)), 403);
  assert.equal(status(() => resolveDownload('out/prices.csv:secret', opts)), 403);
  assert.equal(status(() => resolveDownload('\\\\server\\share\\x.csv', opts)), 403);
  assert.equal(status(() => resolveDownload('out/missing.csv', opts)), 404);
});

test('a relative path is also tried in the folders the chat moved through, newest first', () => {
  const a = path.join(ws, 'repo', 'analysis', 'a');
  const b = path.join(ws, 'repo', 'analysis', 'b');
  for (const d of [a, b]) { fs.mkdirSync(path.join(d, 'out'), { recursive: true }); fs.writeFileSync(path.join(d, 'out', 'report.csv'), d); }
  const start = { cwd: ws, roots: [ws], blocked: [data] };
  assert.equal(status(() => resolveDownload('out/report.csv', start)), 404);
  assert.equal(resolveDownload('out/report.csv', { ...start, seen: [a, b] }).file, fs.realpathSync.native(path.join(a, 'out', 'report.csv')));
  // Bash writes its folder as /c/Users/…, and that is what the transcript keeps.
  assert.deepEqual(transcriptFolders('{"cwd":"C:\\\\one"}\n{"cwd":"/c/two"}\n{"cwd":"C:\\\\one"}\n{"text":"\\"cwd\\":\\"C:\\\\\\\\no\\""}\n'), ['C:\\one', 'C:\\two']);
});

test('a path from a folder further up resolves, from the chat folder or the workspace', () => {
  fs.mkdirSync(path.join(ws, 'repo', 'deep', 'er'), { recursive: true });
  assert.equal(resolveDownload('repo/out/prices.csv', { cwd: path.join(ws, 'repo', 'deep', 'er'), roots: [ws] }).name, 'prices.csv');
  assert.equal(resolveDownload('out/prices.csv', { cwd: path.join(ws, 'repo', 'deep', 'er'), roots: [ws] }).name, 'prices.csv');
});

test('the chat folder wins over any other match, and the other folders open no way into Pit Wall data', () => {
  const near = path.join(ws, 'near');
  const far = path.join(ws, 'far');
  for (const d of [near, far]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'same.csv'), d); }
  assert.equal(resolveDownload('same.csv', { cwd: near, seen: [far], roots: [ws] }).file, fs.realpathSync.native(path.join(near, 'same.csv')));
  assert.equal(status(() => resolveDownload('chats.csv', { cwd: ws, seen: [data], roots: [ws], blocked: [data] })), 403);
});

test('a bare name or part of a path is found from the full paths the transcript recorded, newest first', () => {
  const old = path.join(ws, 'proj', 'old');
  const newer = path.join(ws, 'proj', 'new');
  for (const d of [old, newer]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'report-x.csv'), d); }
  const text = [JSON.stringify({ file_path: path.join(old, 'report-x.csv') }), JSON.stringify({ text: `saved to ${path.join(newer, 'report-x.csv')} ok` })].join('\n');
  assert.deepEqual(transcriptPaths(text, 'report-x.csv'), [path.join(newer, 'report-x.csv'), path.join(old, 'report-x.csv')]);
  assert.equal(resolveDownload('report-x.csv', { cwd: ws, roots: [ws], mentions: rel => transcriptPaths(text, rel) }).file, fs.realpathSync.native(path.join(newer, 'report-x.csv')));
});

test('a path only matches on whole folder and file names', () => {
  const text = JSON.stringify({ a: 'C:\\m\\project_labels_laravel.md', b: 'C:\\m\\laravel.md.bak', c: 'C:\\x\\other\\laravel.md' });
  assert.deepEqual(transcriptPaths(text, 'systems/laravel.md'), []);
  assert.deepEqual(transcriptPaths(text, 'laravel.md'), ['C:\\x\\other\\laravel.md']);
  assert.deepEqual(transcriptPaths(JSON.stringify({ t: 'ls /c/app/out/a.csv' }), 'out\\a.csv'), ['C:\\app\\out\\a.csv']);
  assert.deepEqual(transcriptPaths(JSON.stringify({ t: 'line\nC:\\app\\a.csv' }), 'a.csv'), ['C:\\app\\a.csv']);
});

test('a file saved outside the workspace downloads by name too', () => {
  const text = JSON.stringify({ f: path.join(outside, 'leak.csv') });
  assert.equal(resolveDownload('leak.csv', { cwd: ws, roots: [ws], mentions: rel => transcriptPaths(text, rel) }).name, 'leak.csv');
});

test('a name is found a few folders below where the chat worked, never by combing the whole workspace', () => {
  const work = path.join(ws, 'analysis', 'run');
  for (const d of ['out', '.hidden', 'node_modules']) fs.mkdirSync(path.join(work, d), { recursive: true });
  fs.writeFileSync(path.join(work, 'out', 'agreed.csv'), 'x');
  fs.writeFileSync(path.join(work, '.hidden', 'secret.csv'), 'x');
  fs.writeFileSync(path.join(work, 'node_modules', 'dep.csv'), 'x');
  assert.equal(resolveDownload('agreed.csv', { cwd: ws, seen: [work], roots: [ws] }).name, 'agreed.csv');
  assert.equal(status(() => resolveDownload('agreed.csv', { cwd: ws, seen: [ws], roots: [ws] })), 404);
  assert.equal(status(() => resolveDownload('secret.csv', { cwd: ws, seen: [work], roots: [ws] })), 404);
  assert.equal(status(() => resolveDownload('dep.csv', { cwd: ws, seen: [work], roots: [ws] })), 404);
});

test('a junction or link into Pit Wall data is followed and refused', t => {
  const link = path.join(ws, 'repo', 'linked');
  try { fs.symlinkSync(data, link, 'junction'); } catch { return t.skip('cannot make a junction here'); }
  assert.equal(status(() => resolveDownload('linked/chats.csv', opts)), 403);
});

test('downloads are always attachments in a sandbox, never shown on the page', () => {
  const h = downloadHeaders({ name: 'report £.html', size: 3, type: 'text/html' });
  assert.match(h['Content-Disposition'], /^attachment; filename="report _.html"; filename\*=UTF-8''report%20%C2%A3\.html$/);
  assert.equal(h['Content-Security-Policy'], 'sandbox');
});

test('Git Bash paths become Windows paths', () => {
  assert.equal(cleanPath('/c/Users/x/a.csv'), 'C:\\Users/x/a.csv');
});

test('paths in replies become download links; other code and user text stay as they were', () => {
  const html = renderMarkdown('Send **`C:\\A&B\\out\\prices.csv`** and `out/x.xlsx`, not `npm test` or `.env`.', { files: { session: 'abc' } });
  assert.match(html, /<a class="file-link" href="\/api\/files\?session=abc&amp;path=C%3A%5CA%26B%5Cout%5Cprices\.csv" download/);
  assert.match(html, /path=out%2Fx\.xlsx/);
  assert.match(html, /<code>npm test<\/code>/);
  assert.match(html, /<code>\.env<\/code>/);
  assert.match(renderMarkdown('Saved to C:\\r\\a.csv.', { files: {} }), /href="\/api\/files\?path=C%3A%5Cr%5Ca\.csv"/);
  assert.doesNotMatch(renderMarkdown('`C:\\r\\a.csv`'), /file-link/);
});
