import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transcript, transcriptFile, saveThread, loadThread, loadThreadState, saveThreadState, copyTranscript } from '../src/codex-transcript.mjs';
import { readHistory, summariseTranscript } from '../src/transcripts.mjs';

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-codex-')); made.push(d); return d; };
after(() => { for (const d of made) try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ } });

test('a Codex chat transcript reads back through the existing history and board readers', () => {
  const dir = tmp();
  const CWD = String.raw`C:\Users\x\repo`;
  const file = transcriptFile(dir, CWD, 'id-1');
  assert.ok(file.startsWith(path.join(dir, 'C--Users-x-repo')));
  let t = 0;
  const tr = new Transcript(file, { sessionId: 'id-1', cwd: CWD, now: () => new Date(Date.UTC(2026, 9, 8, 10, 0, t++)).toISOString() });
  tr.append({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Fix the test' } });
  tr.append({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'npm test' } }] } });
  tr.append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: false, content: 'ok' }] } });
  tr.append({ type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
  tr.append({ type: 'stream_event', event: {} }); // not saved
  const h = readHistory(file);
  assert.deepEqual(h.items.map(i => i.kind), ['user', 'tool', 'tool_result', 'assistant']);
  const s = summariseTranscript(file);
  assert.equal(s.sessionId, 'id-1');
  assert.equal(s.cwd, CWD);
  assert.equal(s.firstPrompt, 'Fix the test');
  assert.equal(s.lastAssistant, 'Done.');
});

test('the stopped marker shows as "Stopped" but never becomes the last prompt', () => {
  const file = transcriptFile(tmp(), String.raw`C:\Users\x\repo`, 'id-2');
  const tr = new Transcript(file, { sessionId: 'id-2', cwd: String.raw`C:\Users\x\repo` });
  tr.append({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Run the slow build' } });
  tr.append({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  assert.deepEqual(readHistory(file).items.map(i => i.kind === 'note' ? i.text : i.kind), ['user', 'Stopped']);
  const s = summariseTranscript(file);
  assert.equal(s.lastPrompt, 'Run the slow build');
  assert.equal(s.firstPrompt, 'Run the slow build');
});

test('thread map survives a restart and is per Pit Wall id', () => {
  const dir = tmp();
  assert.equal(loadThread(dir, 'a'), null);
  saveThread(dir, 'a', 'thr-1');
  assert.equal(loadThread(dir, 'a'), 'thr-1');
  assert.equal(loadThread(dir, 'b'), null);
});

const readLines = f => fs.readFileSync(f, 'utf8').trim().split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
const convo = f => readLines(f).filter(l => l.type === 'user' || l.type === 'assistant');

test('entries form a parent chain; append returns the uuid; setParent re-hangs the next entry', () => {
  const file = transcriptFile(tmp(), String.raw`C:\Users\x\repo`, 'id-3');
  const tr = new Transcript(file, { sessionId: 'id-3', cwd: String.raw`C:\Users\x\repo` });
  assert.equal(tr.append({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'one' } }), 'u1');
  assert.equal(tr.append({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } }), 'a1');
  const gen = tr.append({ type: 'assistant', message: { role: 'assistant', content: [] } });
  assert.match(gen, /^[0-9a-f-]{36}$/, 'a generated uuid comes back');
  assert.equal(tr.append({ type: 'stream_event', event: {} }), null, 'live-only: skipped');
  assert.equal(tr.append({ type: 'user', isReplay: true, uuid: 'r1', message: { role: 'user', content: 'x' } }), null, 'replay: skipped');
  tr.setParent('u1');
  tr.append({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'two' } });
  assert.deepEqual(convo(file).map(l => [l.uuid, l.parentUuid]), [['u1', null], ['a1', 'u1'], [gen, 'a1'], ['u2', 'u1']]);
});

test('a Transcript opened on an existing file continues the chain from its last entry', () => {
  const file = transcriptFile(tmp(), String.raw`C:\Users\x\repo`, 'id-4');
  const a = new Transcript(file, { sessionId: 'id-4', cwd: 'C:\r' });
  a.append({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'one' } }); // also writes a last-prompt line after it
  a.append({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } });
  a.append({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'two' } });
  fs.appendFileSync(file, 'not json\n');
  const b = new Transcript(file, { sessionId: 'id-4', cwd: 'C:\r' });
  b.append({ type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'Again' }] } });
  assert.equal(convo(file).at(-1).parentUuid, 'u2');
  const fresh = new Transcript(transcriptFile(tmp(), 'C:\r', 'id-5'), { sessionId: 'id-5', cwd: 'C:\r' });
  assert.equal(fresh.parent, null, 'a new file starts with no parent');
  const given = new Transcript(file, { sessionId: 'id-4', cwd: 'C:\r', parent: 'u1' });
  assert.equal(given.parent, 'u1', 'explicit parent wins');
});

test('an old Codex transcript (no parentUuid anywhere) keeps reading, and continues with a chain', () => {
  const file = transcriptFile(tmp(), 'C:\r', 'id-6');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: 'user', uuid: 'o1', sessionId: 'id-6', message: { role: 'user', content: 'old one' } },
    { type: 'assistant', uuid: 'o2', sessionId: 'id-6', message: { role: 'assistant', content: [{ type: 'text', text: 'Old reply' }] } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const tr = new Transcript(file, { sessionId: 'id-6', cwd: 'C:\r' });
  tr.append({ type: 'user', uuid: 'n1', message: { role: 'user', content: 'new one' } });
  assert.equal(convo(file).at(-1).parentUuid, 'o2');
  assert.deepEqual(readHistory(file).items.map(i => i.text), ['old one', 'Old reply', 'new one']);
});

test('thread state: old {threadId} files load with turns null; saveThreadState round-trips; saveThread writes turns []', () => {
  const dir = tmp();
  assert.equal(loadThreadState(dir, 'none'), null);
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ threadId: 'thr-old' }));
  assert.deepEqual(loadThreadState(dir, 'old'), { threadId: 'thr-old', turns: null });
  assert.equal(loadThread(dir, 'old'), 'thr-old');
  const st = { threadId: 'thr-2', turns: [{ turnId: 'turn-1', userUuid: 'u1', itemUuids: ['m1', 'x'] }] };
  saveThreadState(dir, 'new', st);
  assert.deepEqual(loadThreadState(dir, 'new'), st);
  saveThread(dir, 'c', 'thr-3');
  assert.deepEqual(loadThreadState(dir, 'c'), { threadId: 'thr-3', turns: [] });
});

test('copyTranscript: kept turns with their tool results and stop markers, under the new id; a rewound branch and later turns stay behind', () => {
  const dir = tmp();
  const src = path.join(dir, 'src.jsonl');
  const tr = new Transcript(src, { sessionId: 'src', cwd: 'C:\\r' });
  const say = (uuid, text) => tr.append({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  tr.append({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'one' } });
  tr.append({ type: 'assistant', uuid: 'c1-use', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } }] } });
  tr.append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] } });
  say('m1', 'Hello 1');
  tr.append({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  tr.append({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'rewound' } });
  say('m2', 'gone');
  tr.setParent(tr.parentOf('u2'));
  tr.append({ type: 'user', uuid: 'u3', message: { role: 'user', content: 'three' } });
  say('m3', 'Hello 3');
  tr.append({ type: 'user', uuid: 'u4', message: { role: 'user', content: 'after the cut' } });
  const dst = path.join(dir, 'sub', 'dst.jsonl');
  copyTranscript(src, dst, ['u1', 'c1-use', 'm1', 'u3', 'm3'], 'new');
  const lines = fs.readFileSync(dst, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(lines.every(l => l.sessionId === 'new'));
  const convo = lines.filter(l => l.uuid);
  assert.equal(convo.length, 7, 'u1, c1-use, tool result, m1, stop marker, u3, m3');
  assert.ok(!convo.some(l => ['u2', 'm2', 'u4'].includes(l.uuid)));
  assert.deepEqual(lines.filter(l => l.type === 'last-prompt').map(l => l.lastPrompt), ['one', 'rewound', 'three'], 'none after the cut');
  const items = readHistory(dst).items;
  assert.deepEqual(items.filter(i => i.kind === 'user' || i.kind === 'assistant').map(i => i.text), ['one', 'Hello 1', 'three', 'Hello 3']);
  assert.ok(items.some(i => i.kind === 'note' && i.text === 'Stopped'), 'stop marker kept');
  copyTranscript(path.join(dir, 'missing.jsonl'), path.join(dir, 'none.jsonl'), ['u1'], 'x');
  assert.ok(!fs.existsSync(path.join(dir, 'none.jsonl')), 'nothing written without a source');
});
