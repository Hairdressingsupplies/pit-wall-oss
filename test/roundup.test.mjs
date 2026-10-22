import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekKey, roundupDue, buildRoundupPrompt, ROUNDUP_SCHEMA } from '../src/roundup.mjs';

const at = s => new Date(s); // local time (no Z)

test('weeks run Monday to Sunday', () => {
  assert.equal(weekKey(at('2026-10-05T09:00:00')), '2026-10-05'); // Monday
  assert.equal(weekKey(at('2026-10-08T17:00:00')), '2026-10-05'); // Thursday
  assert.equal(weekKey(at('2026-10-11T23:00:00')), '2026-10-05'); // Sunday
  assert.equal(weekKey(at('2026-10-12T00:30:00')), '2026-10-12');
});

test('due from Thursday 15:00, once a week, with catch-up if the PC was off', () => {
  assert.equal(roundupDue(at('2026-10-08T14:59:00'), null), null, 'not before Thursday 15:00');
  assert.equal(roundupDue(at('2026-10-08T15:00:00'), null), '2026-10-05');
  assert.equal(roundupDue(at('2026-10-08T16:30:00'), '2026-10-05'), null, 'already written this week');
  assert.equal(roundupDue(at('2026-10-10T10:00:00'), '2025-12-29'), '2026-10-05', 'Saturday catch-up');
  assert.equal(roundupDue(at('2026-10-12T09:00:00'), '2026-10-05'), null, 'new week, not Thursday yet');
});

test('the prompt names the person, the recipient and the week; the schema asks for subject and body', () => {
  const p = buildRoundupPrompt({ name: 'Lee', to: 'sam@x.com', week: '2026-10-05',
    days: [{ day: '2026-10-06', sessions: [{ name: 'Email sections', turns: 12, edits: ['a.html'], commits: 1, deploys: [] }], changes: [] }],
    projects: [{ name: 'Marketing: SES email', items: [{ text: 'Segments', state: 'live' }] }] });
  assert.match(p, /Lee/);
  assert.match(p, /week starting Monday,? 5 October 2026/i);
  assert.match(p, /Email sections/);
  assert.match(p, /Marketing: SES email/);
  assert.deepEqual(ROUNDUP_SCHEMA.required, ['subject', 'body']);
});

test('the Gmail send is allowed only to roundupTo, with exactly the roundup, nothing else', async () => {
  const { allowGmailCall } = await import('../src/roundup.mjs');
  const mail = { to: 'sam@x.com', subject: 'Weekly roundup', body: 'Done: a' };
  const ok = { to: ['sam@x.com'], subject: 'Weekly roundup', body: 'Done: a' };
  assert.equal(allowGmailCall('mcp__claude_ai_Gmail__send_message', ok, mail), true);
  assert.equal(allowGmailCall('ToolSearch', { query: 'gmail' }, mail), true, 'finding the tool is fine');
  assert.equal(allowGmailCall('mcp__claude_ai_Gmail__send_message', { ...ok, to: ['eve@x.com'] }, mail), false);
  assert.equal(allowGmailCall('mcp__claude_ai_Gmail__send_message', { ...ok, to: ['sam@x.com', 'eve@x.com'] }, mail), false);
  assert.equal(allowGmailCall('mcp__claude_ai_Gmail__send_message', { ...ok, bcc: ['eve@x.com'] }, mail), false);
  assert.equal(allowGmailCall('mcp__claude_ai_Gmail__send_message', { ...ok, body: 'Something else' }, mail), false);
  assert.equal(allowGmailCall('mcp__claude_ai_Gmail__send_message', { ...ok, attachments: [{ content: 'eA==' }] }, mail), false);
  assert.equal(allowGmailCall('mcp__claude_ai_Gmail__trash_message', { id: '1' }, mail), false);
  assert.equal(allowGmailCall('Bash', { command: 'curl' }, mail), false);
  assert.equal(allowGmailCall('mcp__claude_ai_Gmail__create_draft', ok, { ...mail, tool: 'create_draft' }), true, 'test mode drafts');
});
