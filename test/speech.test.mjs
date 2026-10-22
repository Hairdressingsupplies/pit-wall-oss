// test/speech.test.mjs — what "Read aloud" says: only the words of a reply, in pieces Chrome reads without cutting out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { speakableText, chunks, pickVoice, resolveChoice } from '../public/speech.js';
import { speakRequest, voiceInstallCommand, wav16, VOICES, MAX_TEXT, VOICE_PACKAGE } from '../src/voice.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('code blocks, tables, images and rules are left out; the words around them stay', () => {
  const md = [
    'Here is the fix.',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '| Tier | Price |',
    '|------|-------|',
    '| plus | £9 |',
    '',
    '---',
    '![chart](a.png)',
    'That should do it',
  ].join('\n');
  assert.equal(speakableText(md), 'Here is the fix. That should do it.');
});

test('an unclosed code fence (reply still mid-block) drops the rest rather than reading code', () => {
  assert.equal(speakableText('Before.\n```\nnpm test\nmore code'), 'Before.');
});

test('markdown marks go, links read as their words, bare addresses as "a link"', () => {
  assert.equal(speakableText('## Summary\n- **Done**: see [the runbook](docs/x.md)\n- check `wrangler` at https://example.com/x'),
    'Summary. Done: see the runbook. check wrangler at a link.');
  assert.equal(speakableText('> quoted *note* here\n1. first\n2) second'), 'quoted note here. first. second.');
  assert.equal(speakableText('keep snake_case_names and 2 * 3'), 'keep snake_case_names and 2 * 3.');
});

test('nothing worth reading gives an empty string', () => {
  assert.equal(speakableText('```\ncode only\n```'), '');
  assert.equal(speakableText(null), '');
});

test('chunks: whole sentences up to the limit, a long sentence split at spaces, nothing lost', () => {
  assert.deepEqual(chunks('One. Two. Three.', 10), ['One. Two.', 'Three.']);
  const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + '.';
  const parts = chunks(long, 50);
  assert.ok(parts.every(p => p.length <= 50));
  assert.equal(parts.join(' '), long);
  assert.deepEqual(chunks(''), []);
});

test('chunks firstAlone: the first sentence goes on its own so the natural voice starts sooner', () => {
  assert.deepEqual(chunks('Short one. Two. Three.', 300, { firstAlone: true }), ['Short one.', 'Two. Three.']);
  assert.deepEqual(chunks('Only one.', 300, { firstAlone: true }), ['Only one.']);
});

test('resolveChoice: natural when the PC has it, the device voice otherwise; a picked device/Google voice sticks', () => {
  const nat = { installed: true, voices: { bf_emma: 'Emma', bm_george: 'George' } };
  assert.equal(resolveChoice(null, nat), 'natural:bf_emma');
  assert.equal(resolveChoice('natural:bm_george', nat), 'natural:bm_george');
  assert.equal(resolveChoice('natural:bm_nobody', nat), 'natural:bf_emma');
  assert.equal(resolveChoice('natural:bm_george', { installed: false, voices: nat.voices }), 'device', 'phone on a PC without it');
  assert.equal(resolveChoice('natural:bm_george', null), 'device', 'old server: no /api/voice');
  assert.equal(resolveChoice('google', nat), 'google');
  assert.equal(resolveChoice('device', nat), 'device');
});

test('speak requests: text required and capped, voice must be one of the British ones', () => {
  assert.deepEqual(speakRequest({ text: ' Hello. ' }), { text: 'Hello.', voice: 'bf_emma' });
  assert.deepEqual(speakRequest({ text: 'Hi', voice: 'bm_george' }), { text: 'Hi', voice: 'bm_george' });
  assert.ok(speakRequest({ text: '' }).error);
  assert.ok(speakRequest({ text: 'x'.repeat(MAX_TEXT + 1) }).error);
  assert.ok(speakRequest({ text: 'Hi', voice: 'af_heart' }).error);
  assert.ok(speakRequest({ text: 'Hi', voice: 'toString' }).error, 'no prototype keys');
  assert.ok(Object.keys(VOICES).every(v => /^b[fm]_/.test(v)));
});

test('wav16: a 16-bit mono WAV header and clipped samples', () => {
  const b = wav16(new Float32Array([0, 1, -1, 2]), 24000);
  assert.equal(b.toString('ascii', 0, 4), 'RIFF');
  assert.equal(b.toString('ascii', 8, 12), 'WAVE');
  assert.equal(b.readUInt32LE(24), 24000);
  assert.equal(b.readUInt16LE(34), 16);
  assert.equal(b.readUInt32LE(40), 8);
  assert.deepEqual([0, 1, 2, 3].map(i => b.readInt16LE(44 + i * 2)), [0, 32767, -32767, 32767]);
});

test('voice install: fixed npm arguments, pinned version', () => {
  assert.match(VOICE_PACKAGE, /^kokoro-js@\d+\.\d+\.\d+$/);
  assert.deepEqual(voiceInstallCommand('win32'), { file: 'cmd.exe', args: ['/d', '/s', '/c', `npm install ${VOICE_PACKAGE} --no-audit --no-fund --omit=dev`] });
  assert.equal(voiceInstallCommand('linux').file, 'npm');
});

test('pickVoice: this device only unless Google voices are allowed; British English first', () => {
  const v = (name, lang, localService, def = false) => ({ name, lang, localService, default: def });
  const voices = [v('Google UK English Female', 'en-GB', false), v('Microsoft David', 'en-US', true, true), v('Microsoft Hazel', 'en-GB', true), v('Microsoft Hortense', 'fr-FR', true)];
  assert.equal(pickVoice(voices).name, 'Microsoft Hazel');
  assert.equal(pickVoice(voices, true).name, 'Google UK English Female');
  assert.equal(pickVoice([v('Google UK English Female', 'en-GB', false)]), null, 'no local voice → none, never a silent fall back to Google');
  assert.equal(pickVoice([v('Microsoft David', 'en-US', true)]).name, 'Microsoft David');
});

test('speech.js is soft-loaded and served', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.doesNotMatch(app, /^import[^;]*from '\.\/speech\.js'/m, 'no static import: a 404 would stop the whole page');
  assert.match(app, /await import\('\.\/speech\.js'\)[\s\S]{0,80}\.catch\(\(\) => null\)/);
  const server = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');
  assert.ok(server.includes("'/speech.js': ['speech.js'"));
});
