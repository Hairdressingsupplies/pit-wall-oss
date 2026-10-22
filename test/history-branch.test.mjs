import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readHistory } from '../src/transcripts.mjs';

// A transcript as Claude Code writes it: every entry has a uuid and a parentUuid; a rewind leaves the old branch in
// the file and the next message hangs off an earlier entry.
function write(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-branch-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return file;
}
const U = (uuid, parentUuid, text) => ({ type: 'user', uuid, parentUuid, timestamp: '2026-10-06T10:00:00Z', message: { content: text } });
const A = (uuid, parentUuid, text) => ({ type: 'assistant', uuid, parentUuid, timestamp: '2026-10-06T10:00:01Z', message: { content: [{ type: 'text', text }] } });
const texts = r => r.items.map(i => i.text);

test('a rewound branch is left out; items carry their transcript uuid', () => {
  const file = write([
    U('u1', null, 'one'), A('a1', 'u1', 'reply one'),
    U('u2', 'a1', 'numbers please'), A('a2', 'u2', '1 2 3'),
    U('u3', 'a1', 'did I ask for numbers?'), A('a3', 'u3', 'No.'),
  ]);
  const r = readHistory(file);
  assert.deepEqual(texts(r), ['one', 'reply one', 'did I ask for numbers?', 'No.']);
  assert.deepEqual(r.items.map(i => i.uuid), ['u1', 'a1', 'u3', 'a3']);
});

test('no branch: everything shows as before, including side entries off the chain', () => {
  const file = write([
    U('u1', null, 'one'),
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'x' } }, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'y' } }] } },
    { type: 'user', uuid: 'r1', parentUuid: 'a1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'X' }] } },
    { type: 'user', uuid: 'r2', parentUuid: 'a1', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'Y' }] } },
    A('a2', 'r2', 'both read'),
  ]);
  assert.deepEqual(readHistory(file).items.map(i => i.kind), ['user', 'tool', 'tool', 'tool_result', 'tool_result', 'assistant']);
});

test('compaction keeps the earlier conversation; a just-rewound chat hides the rewound turn', () => {
  const file = write([
    U('u1', null, 'one'), A('a1', 'u1', 'reply one'),
    { type: 'system', subtype: 'compact_boundary', uuid: 'c1', parentUuid: null, logicalParentUuid: 'a1' },
    U('u2', 'c1', 'two'), A('a2', 'u2', 'reply two'),
  ]);
  assert.deepEqual(texts(readHistory(file)), ['one', 'reply one', 'Conversation compacted', 'two', 'reply two']);
  assert.deepEqual(texts(readHistory(file, { cutAt: 'u2' })), ['one', 'reply one', 'Conversation compacted']);
});

test('thinking shows as its own item', () => {
  const file = write([U('u1', null, 'q'), { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: [{ type: 'thinking', thinking: 'Hmm.' }, { type: 'text', text: 'A.' }] } }]);
  assert.deepEqual(readHistory(file).items.map(i => [i.kind, i.text]), [['user', 'q'], ['thinking', 'Hmm.'], ['assistant', 'A.']]);
});
