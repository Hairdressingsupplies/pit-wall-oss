import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyseTranscript, processed, dangerBadges, suggestModel, nextDue, describeSchedule, burnRate, staleMemories,
  waitingInMemory, parseStatus, clashes, extractHandoff, listSkills, repoOf } from '../src/insights.mjs';
import { offPeakWindow } from '../src/queue.mjs';
import { siteDangerRules } from '../src/site.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ins-'));
const iso = minsAgo => new Date(Date.now() - minsAgo * 60_000).toISOString();

test('analyseTranscript: usage once per API message, context, edits, commits, deploys, screenshots, vault', () => {
  const f = path.join(tmp, 'a.jsonl');
  const u = (i, cr, cw, o) => ({ input_tokens: i, cache_read_input_tokens: cr, cache_creation_input_tokens: cw, output_tokens: o });
  const lines = [
    { type: 'assistant', timestamp: iso(60 * 24 * 9), message: { id: 'old', usage: u(1, 1000, 1, 1), content: [] } },
    { type: 'assistant', timestamp: iso(30), message: { id: 'm1', usage: u(10, 5000, 100, 50), content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'C:\\r\\laravel\\app\\X.php' } }] } },
    { type: 'assistant', timestamp: iso(30), message: { id: 'm1', usage: u(10, 5000, 100, 50), content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git commit -m "fix"' } }] } },
    { type: 'assistant', timestamp: iso(20), message: { id: 'm2', usage: u(5, 8000, 10, 20), content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ssh root@x ./deploy.sh' } }, { type: 'tool_use', name: 'mcp__claude-in-chrome__computer', input: { action: 'screenshot' } }] } },
    { type: 'assistant', timestamp: iso(10), message: { id: 'm3', usage: u(1, 100, 1, 1), content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'C:\\r\\vault\\systems\\x.md' } }] } },
  ];
  fs.writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const a = analyseTranscript(f, iso(60 * 24 * 7));
  assert.equal(a.turns, 3);
  assert.equal(a.cacheRead, 13100);
  assert.equal(a.fresh, 10 + 100 + 5 + 10 + 1 + 1);
  assert.equal(a.context, 102);
  assert.equal(a.edits.length, 2);
  assert.equal(a.commits, 1);
  assert.equal(a.deploys.length, 1);
  assert.equal(a.screenshots, 1);
  assert.equal(a.vaultEdited, true);
  // Cost weighting: 1h cache writes weren't split out in this fixture, so writes count 2×; model unknown → reads 0.1×.
  assert.equal(Math.round(processed(a)), Math.round((10 + 5 + 1) + (100 + 10 + 1) * 2 + (50 + 20 + 1) * 5 + 13100 * 0.1));
  assert.equal(analyseTranscript(f, iso(25), iso(15)).turns, 1, 'until bound');
});

test('analyseTranscript and tokensToday count agent and workflow transcripts, each message once', async () => {
  const { tokensToday } = await import('../src/transcripts.mjs');
  const f = path.join(tmp, 'sess.jsonl');
  const sub = path.join(tmp, 'sess', 'subagents');
  fs.mkdirSync(path.join(sub, 'workflows', 'wf_1'), { recursive: true });
  const line = (id, i, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: iso(5), ...extra,
    message: { id, model: 'x', usage: { input_tokens: i, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } } });
  fs.writeFileSync(f, line('m1', 100) + '\n');
  fs.writeFileSync(path.join(sub, 'agent-a1.jsonl'), [line('s1', 30, { isSidechain: true }), line('m1', 100)].join('\n') + '\n');
  fs.writeFileSync(path.join(sub, 'agent-a1.meta.json'), '{}');
  fs.writeFileSync(path.join(sub, 'workflows', 'wf_1', 'agent-a2.jsonl'), line('s2', 20, { isSidechain: true }) + '\n');
  fs.writeFileSync(path.join(sub, 'workflows', 'wf_1', 'journal.jsonl'), line('j1', 999) + '\n');
  const a = analyseTranscript(f, iso(60));
  assert.equal(a.turns, 1);
  assert.equal(a.agentTurns, 2, 'one per agent file; m1 already counted from the main transcript; journal ignored');
  assert.equal(a.fresh, 150);
  assert.equal(a.agentCost, 50);
  assert.equal(a.context, 100, 'context is the main conversation only');
  assert.equal(tokensToday(f), 150);
});

test('danger badges flag live systems and leave ordinary work alone', () => {
  assert.deepEqual(dangerBadges('Bash', { command: 'ssh root@203.0.113.5 "cd /var/www && ./deploy.sh"' }),
    ['SSH / remote shell', 'Deploy']);
  assert.ok(dangerBadges('mcp__claude_ai_Gmail__send_message', { to: 'x' }).includes('Sends email / message'));
  assert.ok(dangerBadges('Bash', { command: 'npx wrangler d1 execute b2b-pricing --remote --command "select 1"' }).includes('Remote D1 database'));
  assert.ok(!dangerBadges('Bash', { command: 'npx wrangler d1 execute b2b-pricing --local --command "select 1"' }).includes('Remote D1 database'));
  assert.deepEqual(siteDangerRules({ dangerRules: [{ label: 'Live DB', pattern: 'db\\.example\\.com' }, { label: 'Bad', pattern: '(' }] }).map(([l, re]) => [l, re.test('mysql -h DB.example.com')]),
    [['Live DB', true]], 'site.json rules: case-insensitive by default, a bad pattern is skipped');
  assert.deepEqual(dangerBadges('Bash', { command: 'git status && npm test' }), []);
  assert.deepEqual(dangerBadges('Edit', { file_path: 'C:\\x\\a.php', old_string: 'a', new_string: 'b' }), []);
  assert.deepEqual(dangerBadges('Edit', { file_path: 'C:\\x\\ApiClient.php', new_string: 'Http::post($api."/order"); // POST to the API; ssh root@203.0.113.5' }), [],
    'editing code that mentions live systems is not itself dangerous');
  assert.deepEqual(dangerBadges('Write', { file_path: 'deploy.sh', content: 'git push && ./deploy.sh' }), []);
});

test('model suggestion nudges light work to Sonnet, keeps code on the usual model', () => {
  assert.equal(suggestModel('Draft a reply to Sam about the call list')?.model, 'sonnet');
  assert.equal(suggestModel('Summarise last week of SMS performance')?.model, 'sonnet');
  assert.equal(suggestModel('Fix the callback re-queue bug in Laravel')?.model, '');
  assert.equal(suggestModel('hi'), null);
});

test('schedules: interval, daily, weekdays and weekly', () => {
  const at = (d, h, m = 0) => new Date(2026, 8, d, h, m); // Sept 2026: the 28th is a Monday
  assert.deepEqual(nextDue({ schedule_kind: 'interval', every_hours: 24, last_run_at: null }, at(29, 10)), at(29, 10));
  assert.deepEqual(nextDue({ schedule_kind: 'interval', every_hours: 6, last_run_at: at(29, 8).toISOString() }, at(29, 10)), at(29, 14));
  assert.deepEqual(nextDue({ schedule_kind: 'daily', schedule_time: '08:00', last_run_at: at(29, 8, 1).toISOString() }, at(29, 10)), at(30, 8));
  assert.deepEqual(nextDue({ schedule_kind: 'weekdays', schedule_time: '07:30', last_run_at: at(2 + 24, 7, 31).toISOString() }, at(26, 12)), at(28, 7, 30), 'Sat → Monday');
  assert.deepEqual(nextDue({ schedule_kind: 'weekly', schedule_days: 1 << 4, schedule_time: '16:30', last_run_at: at(24, 16, 31).toISOString() }, at(29, 9)), at(1 + 30, 16, 30).getMonth() === 9 ? new Date(2026, 9, 1, 16, 30) : null);
  assert.equal(describeSchedule({ schedule_kind: 'weekly', schedule_days: 2 | 32, schedule_time: '09:00' }), 'Mon, Fri at 09:00');
  assert.equal(describeSchedule({ schedule_kind: 'interval', every_hours: 12 }), 'Every 12 h');
});

test('burn rate forecasts when the 5-hour window runs out', () => {
  const now = Date.now();
  const r = burnRate([{ at: new Date(now - 60 * 60_000).toISOString(), five: 0.2, five_resets_at: Math.round(now / 1000) + 3 * 3600 },
    { at: new Date(now).toISOString(), five: 0.4, five_resets_at: Math.round(now / 1000) + 3 * 3600 }], now);
  assert.ok(Math.abs(r.perHour - 0.2) < 1e-9);
  assert.ok(Math.abs(Date.parse(r.fullAt) - (now + 3 * 3_600_000)) < 1000 || r.fullAt === null);
  assert.equal(burnRate([], now), null);
});

test('off-peak window: nearly reset or barely used', () => {
  const now = Date.now();
  assert.equal(offPeakWindow({ unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: now / 1000 + 4 * 3600 } } }, now), true);
  assert.equal(offPeakWindow({ unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: now / 1000 + 20 * 60 } } }, now), true);
  assert.equal(offPeakWindow({ unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: now / 1000 + 3 * 3600 } } }, now), false);
});

test('memory: stale "not deployed" notes and the waiting-to-go-live list', () => {
  const dir = path.join(tmp, 'mem');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '- [Offers import](a.md) — on main, NOT deployed\n- [Old live thing](b.md) — LIVE since June\n- [Fresh](c.md) — pushed, not deployed\n');
  for (const f of ['a.md', 'b.md', 'c.md']) fs.writeFileSync(path.join(dir, f), 'x');
  const old = (Date.now() - 30 * 86_400_000) / 1000;
  fs.utimesSync(path.join(dir, 'a.md'), old, old);
  assert.deepEqual(staleMemories(dir).map(s => s.title), ['Offers import']);
  assert.deepEqual(waitingInMemory(dir).map(s => s.title), ['Offers import', 'Fresh']);
});

test('git status parsing, clash detection, handoff extraction, skills, repo attribution', () => {
  assert.deepEqual(parseStatus('## main...origin/main [ahead 2, behind 87]\n M a.php\n?? b.txt\n'),
    { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 87, changed: 1, untracked: 1 });
  const root = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(root, 'laravel', '.git'), { recursive: true });
  const now = Date.now();
  const e = p => ({ path: path.join(root, p), at: new Date(now - 10 * 60_000).toISOString() });
  assert.equal(repoOf(path.join(root, 'laravel', 'app', 'X.php'), root), 'laravel');
  assert.deepEqual(clashes([{ sessionId: 'a', live: true, edits: [e('laravel/app/X.php')] }, { sessionId: 'b', live: true, edits: [e('laravel/routes/web.php')] },
    { sessionId: 'c', live: false, edits: [e('laravel/y.php')] }], root, { now }), [{ repo: 'laravel', sessions: ['a', 'b'] }]);
  assert.equal(extractHandoff('Sure.\n<handoff>\nGoal: X\n</handoff>'), 'Goal: X');
  const sk = path.join(tmp, 'skills', 'copy-studio');
  fs.mkdirSync(sk, { recursive: true });
  fs.writeFileSync(path.join(sk, 'SKILL.md'), '---\nname: copy-studio\ndescription: Draft ad copy\n---\nbody');
  assert.deepEqual(listSkills([{ dir: path.join(tmp, 'skills'), scope: 'yours' }]), [{ name: 'copy-studio', description: 'Draft ad copy', scope: 'yours' }]);
});

test('analyseTranscript counts a Codex usage entry once, and GPT tokens cost a finite number', async () => {
  const { Transcript } = await import('../src/codex-transcript.mjs');
  const { usageEntry } = await import('../src/codex-translate.mjs');
  const f = path.join(tmp, 'codex.jsonl');
  const tr = new Transcript(f, { sessionId: 'cx', cwd: 'C:\r' });
  tr.append({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Fix it' } });
  tr.append({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
  tr.append(usageEntry('turn-1', 1, { inputTokens: 100, cachedInputTokens: 60, outputTokens: 5, reasoningOutputTokens: 7 }, 'gpt-6.1-sol'));
  const a = analyseTranscript(f, iso(60));
  assert.equal(a.turns, 1);
  assert.equal(a.fresh, 40);
  assert.equal(a.out, 12);
  assert.equal(a.cacheRead, 60);
  assert.equal(a.context, 100);
  assert.ok(Number.isFinite(a.cost) && a.cost > 0, 'token-equivalents, never NaN');
  assert.equal(a.cost, 40 + 12 * 5 + 60 * 0.1);
});

test('with no 5-hour window, off-peak judges the week: under 20% used, or behind pace', () => {
  const now = Date.parse('2026-11-02T12:00:00Z'), day = 86_400;
  const week = (utilization, daysLeft) => ({ unifiedWindows: { seven_day: { utilization, resetsAt: now / 1000 + daysLeft * day } } });
  assert.equal(offPeakWindow(week(0.1, 6), now), true);
  assert.equal(offPeakWindow(week(0.3, 6), now), false); // 14% of the week gone, 30% used
  assert.equal(offPeakWindow(week(0.3, 3), now), true); // 57% gone, 30% used
  assert.equal(offPeakWindow(week(0.95, 0.5), now), false);
  assert.equal(offPeakWindow({ unifiedWindows: {} }, now), false);
  assert.equal(offPeakWindow(null, now), false);
});
