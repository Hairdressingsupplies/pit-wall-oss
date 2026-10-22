import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify } from '../src/protocol.mjs';
import { buildCommands, loadCommandCache, saveCommandCache, handoffText } from '../src/commands.mjs';
import { readHistory } from '../src/transcripts.mjs';

test('handoff: the /handoff skill for Claude in the workspace, plain text for Codex or elsewhere', () => {
  assert.equal(handoffText('claude', true), '/handoff');
  assert.match(handoffText('claude', false), /^Write a self-contained, copy-paste prompt/);
  assert.match(handoffText('codex', true), /^Write a self-contained, copy-paste prompt/);
  assert.equal(handoffText('codex', true), handoffText('claude', false));
});

test('init passes on the slash commands a headless chat accepts, minus terminal-only ones', () => {
  const [a] = classify({ type: 'system', subtype: 'init', model: 'm', session_id: 's',
    slash_commands: ['usage', 'color', 'handoff', 'superpowers:brainstorming'], terminal_slash_commands: ['color', 'doctor'] });
  assert.deepEqual(a.slashCommands, ['usage', 'handoff', 'superpowers:brainstorming']);
  const [b] = classify({ type: 'system', subtype: 'init', model: 'm', session_id: 's' });
  assert.equal(b.slashCommands, null);
});

test('buildCommands puts everyday commands first, hides /clear and internals, and describes skills', () => {
  const skills = [{ name: 'handoff', description: 'Write a handoff', scope: 'yours' }];
  const list = buildCommands(['handoff', 'clear', '__remote-workflow', 'compact', 'usage', 'superpowers:brainstorming', 'rename', 'usage'], skills);
  assert.deepEqual(list.map(c => c.name), ['usage', 'compact', 'rename', 'handoff', 'superpowers:brainstorming']);
  assert.equal(list.find(c => c.name === 'handoff').description, 'Write a handoff');
  assert.equal(list.find(c => c.name === 'handoff').kind, 'skill');
  assert.equal(list.find(c => c.name === 'usage').kind, 'command');
});

test('buildCommands falls back to built-ins plus your skills before any chat has run', () => {
  const list = buildCommands(null, [{ name: 'handoff', description: 'd', scope: 'yours' }]);
  assert.equal(list[0].name, 'usage');
  assert.ok(list.some(c => c.name === 'handoff'));
  assert.ok(!list.some(c => c.name === 'clear' || c.name === 'btw'));
});

test('the command cache keeps a list per folder and survives a reload', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-cmd-')), 'slash-commands.json');
  const cache = loadCommandCache(file);
  saveCommandCache(file, cache, 'C:\\Work\\A', ['usage', 'a-skill']);
  const again = loadCommandCache(file);
  assert.deepEqual(again.byCwd['c:\\work\\a'], ['usage', 'a-skill']);
  assert.deepEqual(again.latest, ['usage', 'a-skill']);
});

test('history shows a slash command’s output as the reply, as it appeared live', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-hist-')), 's.jsonl');
  const line = (content, extra = {}) => JSON.stringify({ type: 'user', timestamp: '2026-10-01T10:00:00Z', message: { role: 'user', content }, ...extra });
  fs.writeFileSync(file, [
    line('<command-name>/usage</command-name>\n<command-message>usage</command-message>\n<command-args></command-args>'),
    line('<local-command-caveat>Caveat: run directly in Claude Code.</local-command-caveat>', { isMeta: true }),
    line('<local-command-stdout>Current session: 20% used</local-command-stdout>'),
  ].join('\n'));
  const { items } = readHistory(file);
  assert.deepEqual(items.map(i => [i.kind, i.text]), [['user', '/usage'], ['assistant', 'Current session: 20% used']]);
});
