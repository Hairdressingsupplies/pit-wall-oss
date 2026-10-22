// Weekly roundup: on Thursdays from 15:00 (or the next time the PC is on that week) Pit Wall writes a short summary of
// the week's work from its own records — chats, files changed, commits, task status changes, projects — for the owner
// to send to roundupTo. One tool-less Sonnet call writes it; another run sends it from the person's own Gmail (connector).

const DUE_DAY = 4;   // Thursday
const DUE_HOUR = 15; // 15:00 local

const pad = n => String(n).padStart(2, '0');
const localDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The Monday (local date) of the week `date` falls in. */
export function weekKey(date = new Date()) {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localDay(d);
}

/** The week to write a roundup for now, or null: from Thursday 16:00 to Sunday, once per week. */
export function roundupDue(now = new Date(), lastWeek = null) {
  const week = weekKey(now);
  if (lastWeek === week) return null;
  const thursday = new Date(`${week}T00:00:00`);
  thursday.setDate(thursday.getDate() + (DUE_DAY - 1));
  thursday.setHours(DUE_HOUR, 0, 0, 0);
  return now >= thursday ? week : null;
}

/** The last seven local days up to today, oldest first. */
export function weekDays(now = new Date()) {
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(now); d.setDate(d.getDate() - (6 - i)); return localDay(d); });
}

export const ROUNDUP_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string', description: 'Email subject line, under 80 characters' },
    body: { type: 'string', description: 'Plain-text email body' },
  },
  required: ['subject', 'body'],
};

const clip = (s, n) => (s ? String(s).replace(/\s+/g, ' ').trim().slice(0, n) : '');

/** days: [{day, sessions:[{name, project, turns, edits, commits, deploys}], changes:[{project, item_text, from_state, to_state, note}]}] */
export function buildRoundupPrompt({ name, to, toLabel = null, week, days, projects }) {
  const monday = new Date(`${week}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const dayText = days.map(d => {
    const lines = d.sessions.map(s => `  - ${clip(s.name, 90)}${s.project ? ` [${clip(s.project, 60)}]` : ''}: ${s.turns} turns`
      + `${s.edits?.length ? `, ${s.edits.length} files changed` : ''}${s.commits ? `, ${s.commits} commits` : ''}${s.deploys?.length ? `, deploy/push: ${s.deploys.map(x => clip(x, 60)).join('; ')}` : ''}`);
    const changes = d.changes.map(c => `  - task "${clip(c.item_text, 80)}" (${clip(c.project, 50)}): ${c.from_state ?? '?'} → ${c.to_state}${c.note ? ` (${clip(c.note, 60)})` : ''}`);
    return lines.length || changes.length ? `${d.day}\n${[...lines, ...changes].join('\n')}` : '';
  }).filter(Boolean).join('\n\n') || '(no recorded activity this week)';
  const projText = projects.map(p => `- ${clip(p.name, 80)}: ${p.items.map(i => `${clip(i.text, 60)} [${i.state}]`).join('; ') || 'no tasks'}`).join('\n') || '(none)';
  return `Write ${name}'s weekly work roundup, to be emailed to ${to}${toLabel ? ` (${toLabel})` : ''}.
It covers the week starting ${monday}. Use ONLY the records below — never invent work, numbers or outcomes. If something
is unclear from the records, leave it out rather than guess.

Format: plain text (no markdown symbols like # or **), friendly and brief, under 250 words, in ${name}'s voice ("I").
Sections, each a few short bullet lines starting with "- ": "Done this week", "In progress", "Needs a decision or help"
(only if the records show something blocked or waiting), then one closing line. Name projects and chats in plain words.
Subject: "Weekly roundup — ${name} — w/c ${week.slice(8)}/${week.slice(5, 7)}" style, under 80 characters.

CLAUDE CODE ACTIVITY BY DAY (chat name [project]: turns, files, commits, deploys; task status changes)
${dayText}

PROJECTS AND THEIR TASKS (states: todo · doing · blocked · built = done, not live · live)
${projText}

Return the subject and the body.`;
}

// ── sending it from the person's own Gmail (the Gmail connector in their Claude account) ──
/**
 * Pit Wall approves each tool call of the send run itself: only finding the tool, and one Gmail send (or, in a test,
 * a draft) to exactly the roundup's recipient with exactly its subject and body — no cc, bcc or attachments. Anything
 * else is refused, so text inside a roundup can't send mail anywhere else.
 */
export function allowGmailCall(toolName, input = {}, { to, subject, body, tool = 'send_message' }) {
  if (toolName === 'ToolSearch') return true;
  if (!/^mcp__.*gmail.*__/i.test(toolName) || !toolName.endsWith(`__${tool}`)) return false;
  const norm = s => String(s ?? '').replace(/\r\n/g, '\n').trim();
  return Array.isArray(input.to) && input.to.length === 1 && input.to[0].toLowerCase() === to.toLowerCase()
    && !input.cc?.length && !input.bcc?.length && !input.attachments?.length && !input.draftId && !input.htmlBody
    && norm(input.subject) === norm(subject) && norm(input.body) === norm(body);
}

/** One headless Claude run that sends the roundup with the Gmail connector. Resolves {ok, error}. */
export function sendViaGmail({ claudeExe, cwd, env, to, subject, body, tool = 'send_message', spawnFn, timeoutMs = 240_000 }) {
  const mail = { to, subject, body, tool };
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet',
    '--effort', 'low', '--tools', 'ToolSearch', '--permission-prompt-tool', 'stdio', '--no-session-persistence', '--max-turns', '6'];
  const prompt = `Use the Gmail connector's ${tool} tool (search for it with ToolSearch if it isn't loaded) exactly once, with these`
    + ` fields and nothing else — no cc, bcc, htmlBody or attachments — then reply DONE. Do not change the text.\n\n`
    + JSON.stringify({ to: [to], subject, body }, null, 2);
  return new Promise(resolve => {
    const proc = spawnFn(claudeExe, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const write = o => { try { proc.stdin.write(JSON.stringify(o) + '\n'); } catch { /* gone */ } };
    let sentId = null, sent = false, why = null, buf = '', done = false;
    const finish = r => { if (done) return; done = true; clearTimeout(timer); try { proc.kill(); } catch { /* gone */ } resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, error: 'Sending took too long.' }), timeoutMs);
    const line = l => {
      let e; try { e = JSON.parse(l); } catch { return; }
      if (e.type === 'control_request' && e.request?.subtype === 'can_use_tool') {
        const ok = allowGmailCall(e.request.tool_name, e.request.input, mail);
        if (!ok) why = `Refused ${e.request.tool_name}`;
        write({ type: 'control_response', response: { subtype: 'success', request_id: e.request_id,
          response: ok ? { behavior: 'allow', updatedInput: e.request.input } : { behavior: 'deny', message: 'Not allowed: send exactly the email given, to the address given.' } } });
      } else if (e.type === 'assistant') {
        for (const b of e.message?.content ?? []) if (b?.type === 'tool_use' && b.name.endsWith(`__${tool}`)) sentId = b.id;
      } else if (e.type === 'user') {
        for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
          if (b?.type === 'tool_result' && b.tool_use_id === sentId) { if (b.is_error) why = 'Gmail refused it'; else sent = true; }
        }
      } else if (e.type === 'result') {
        finish(sent ? { ok: true } : { ok: false, error: why ?? (e.is_error ? (e.result ?? e.subtype) : 'The Gmail connector wasn’t available or didn’t send it.') });
      }
    };
    proc.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    proc.on('error', e => finish({ ok: false, error: e.message }));
    proc.on('exit', () => finish(sent ? { ok: true } : { ok: false, error: why ?? 'Claude stopped before sending.' }));
    write({ type: 'user', message: { role: 'user', content: prompt } });
  });
}
