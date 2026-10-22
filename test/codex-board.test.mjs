import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Scanner } from '../src/scanner.mjs';
import { Search } from '../src/search.mjs';
import { Transcript, transcriptFile } from '../src/codex-transcript.mjs';
import { turnCost } from '../src/insights.mjs';

const made = [];
after(() => { for (const d of made) try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ } });

function setup() {
  const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-cl-'));
  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-cx-'));
  made.push(claudeRoot, codexRoot);
  const cwd = String.raw`C:\r`;
  const tr = new Transcript(transcriptFile(codexRoot, cwd, 'cx-1'), { sessionId: 'cx-1', cwd });
  tr.append({ type: 'user', uuid: 'u', message: { role: 'user', content: 'hello zebrafinch' } });
  return { claudeRoot, codexRoot };
}

test('a Codex chat with no live run is still on the board from its own transcript root', () => {
  const { claudeRoot, codexRoot } = setup();
  const sc = new Scanner({ sessionsDir: claudeRoot, projectsDir: claudeRoot, projectsDirs: [claudeRoot, codexRoot], recentDays: 14, isExcludedProjectDir: () => false });
  assert.ok(sc.transcriptIndex().has('cx-1'));
});

test('Search walks the Codex transcript root too', async () => {
  const { claudeRoot, codexRoot } = setup();
  const s = new Search({ projectsDir: claudeRoot, projectsDirs: [claudeRoot, codexRoot], isExcludedProjectDir: () => false });
  const r = await s.run('zebrafinch');
  assert.ok(JSON.stringify(r).includes('cx-1'));
});

test('an unknown (GPT) model costs 0 price-weight, never NaN', () => {
  const c = turnCost({ input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0 }, 'gpt-6.1-sol');
  assert.ok(Number.isFinite(c));
  assert.ok(Number.isFinite(turnCost({ input_tokens: 1, cache_read_input_tokens: 5 }, undefined)));
});
