// Pit Wall — the extra views: Usage, Repos, Activity, the morning brief, follow-ups, templates,
// the command palette and voice input. app.js hands over its helpers with init().
let D; // { S, h, api, toast, fail, ago, folder, openChat, renderView, setView, $ }

export function init(deps) { D = deps; }

/** replaceChildren that skips empty (null/false) sections. */
const put = (el, ...kids) => el.replaceChildren(...kids.filter(k => k != null && k !== false));

const pct = x => `${Math.round((x ?? 0) * 100)}%`;
export const fmtK = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n ?? 0));
const when = iso => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const hhmm = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// ── context badge ────────────────────────────────────────────────────────
/** How much Claude re-reads every turn. Amber over the warning level, red over the high level. */
export function contextBadge(s, { onlyWhenHigh = false } = {}) {
  const { warn, high } = D.S.data.options.context;
  if (!s.context || s.context < (onlyWhenHigh ? warn : warn / 2)) return null;
  const level = s.context >= high ? 'high' : s.context >= warn ? 'warn' : '';
  return D.h('span', { class: `ctx ${level}`, title: `Claude re-reads about ${fmtK(s.context)} tokens on every turn of this session${level ? ' — a Fresh start would make each turn much cheaper' : ''}` }, `${fmtK(s.context)} ctx`);
}

export function isCold(s) {
  const { warn, coldMinutes } = D.S.data.options.context;
  return !s.running && s.context >= warn && s.lastActivity && Date.now() - Date.parse(s.lastActivity) > coldMinutes * 60_000;
}

// ── usage view ───────────────────────────────────────────────────────────
export async function renderUsage() {
  const { S, h, api, $ } = D;
  const view = $('#view');
  view.replaceChildren(h('div', { class: 'empty' }, h('p', {}, 'Adding up this week…')));
  let u;
  try { u = await api('POST', '/api/usage'); } catch (e) { view.replaceChildren(h('div', { class: 'empty' }, h('p', {}, e.message))); return; }
  if (S.view !== 'usage') return;
  const rate = S.data.usage.rate?.unifiedWindows;
  const burn = S.data.usage.burn;
  const burnCodex = S.data.usage.burnCodex;
  const proj = S.data.projects.filter(p => p.weekShare > 0.005).sort((a, b) => b.weekShare - a.weekShare);
  const tips = [];
  const cold = u.top.filter(t => t.context >= S.data.options.context.warn);
  if (cold.length) tips.push(`${cold.length} of your heaviest sessions re-read over ${fmtK(S.data.options.context.warn)} tokens every turn. Use Fresh start on them — the handoff keeps the important parts and each turn after costs a fraction.`);
  if (u.cacheTokenShare > 0.5) tips.push(`${pct(u.cacheTokenShare)} of the tokens Claude handled this week were re-reads of long conversations. Re-reading is cheap per token, but at that volume it is about ${pct(u.cacheShare)} of the estimated cost — shorter sessions cut it directly.`);
  if (u.browserHeavy.length) tips.push(`${u.browserHeavy.map(b => b.name).join(', ')} took a lot of browser screenshots. Screenshots are expensive — asking Claude to read pages as text first (read_page / get_page_text) is much cheaper.`);
  const bar = x => h('span', { class: 'bar' }, h('span', { style: `width:${Math.max(2, Math.round(x * 100))}%` }));
  put(view,
    h('div', { class: 'status-strip' },
      h('strong', {}, rate ? `${S.data.usage.rateCodex ? 'Claude ' : ''}5-hour ${pct(rate.five_hour?.utilization)} · week ${pct(rate.seven_day?.utilization)}` : 'No usage reading yet'),
      burn?.fullAt ? h('span', { class: 'hot-text' }, `At this pace the 5-hour limit runs out about ${hhmm(burn.fullAt)}`) : burn ? h('span', {}, `Burning about ${Math.round(burn.perHour * 100)} points an hour`) : null,
      h('span', {}, `${fmtK(u.tokens)} tokens handled in 7 days${u.totals?.codex > 0 ? ` (Claude ${fmtK((u.tokensEngine ?? u.totals).claude)} · GPT ${fmtK((u.tokensEngine ?? u.totals).codex)})` : ''}${u.agentShare >= 0.005 ? ` (agents and workflows ${pct(u.agentShare)} of the cost)` : ''}`)),
    codexUsageStrip(S.data.usage.rateCodex, burnCodex),
    tips.length ? h('section', { class: 'panel tips' }, h('h3', {}, 'Ways to get more out of your limits'), h('ul', {}, tips.map(t => h('li', {}, t)))) : null,
    h('section', { class: 'lane' }, h('div', { class: 'lane-head' }, h('h2', {}, 'Heaviest sessions this week'), h('span', { class: 'desc' }, 'Estimated share of this week’s cost, weighting tokens by API price (writing 5×, new input 1×, re-reading 0.05–0.1×). Subscription limits aren’t published per token type, so treat it as a guide.')),
      h('div', { class: 'rows' }, u.top.map(t => h('button', { class: 'row', type: 'button', onclick: () => D.openChat(t.id) },
        h('span', { class: `body ${t.source === 'closed' ? 'closed' : ''}` }),
        h('span', { class: 'row-main' },
          h('span', { class: 'row-title' }, h('span', { class: 'name' }, t.name), t.engine === 'codex' ? h('span', { class: 'engine-tag', title: 'Codex' }, 'GPT') : null, contextBadge({ context: t.context })),
          h('span', { class: 'row-sub' }, `${t.turns} turns · ${fmtK(t.cacheRead)} re-read · ${fmtK(t.fresh)} new · ${fmtK(t.out)} written${t.agentTurns ? ` · agents ${pct(t.agentShare)} of it` : ''}${t.screenshots ? ` · ${t.screenshots} screenshots` : ''}`)),
        h('span', { class: 'row-meta share' }, pct(t.share), bar(t.share)))))),
    proj.length ? h('section', { class: 'lane' }, h('div', { class: 'lane-head' }, h('h2', {}, 'By project'), h('span', { class: 'desc' }, 'Set a budget from a project’s ••• menu (Projects tab) to get a warning when it goes over.')),
      h('div', { class: 'rows' }, proj.map(p => h('div', { class: 'row' },
        h('span', { class: `body ${p.overBudget ? 'needs' : ''}` }),
        h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, h('span', { class: 'name' }, p.name)),
          h('span', { class: `row-sub${p.overBudget ? ' alert' : ''}` }, p.budget_pct ? `Budget ${p.budget_pct}% of the week${p.overBudget ? ' — over budget' : ''}` : 'No budget set')),
        h('span', { class: 'row-meta share' }, pct(p.weekShare), bar(p.weekShare)))))) : null,
  );
}

/** Codex's own limits (your ChatGPT plan), shown the same way as Claude's; nothing until Codex has reported them. */
function codexUsageStrip(rc, burn) {
  const w = rc?.unifiedWindows;
  if (!w || (!w.five_hour && !w.seven_day)) return null;
  const { h, ago } = D;
  const plan = rc.planType ? `${String(rc.planType)[0].toUpperCase()}${String(rc.planType).slice(1)}` : 'Plus';
  const resets = x => (x?.resetsAt ? new Date(x.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '?');
  return h('div', { class: 'status-strip engine-usage', title: `5-hour window resets ${resets(w.five_hour)}, week resets ${resets(w.seven_day)}.${rc.capturedAt ? ` Measured ${ago(rc.capturedAt)}.` : ''}` },
    h('strong', {}, `Codex (ChatGPT ${plan})`),
    h('span', {}, [w.five_hour ? `5-hour ${pct(w.five_hour.utilization)}` : null, w.seven_day ? `week ${pct(w.seven_day.utilization)}` : null].filter(Boolean).join(' · ')),
    w.five_hour?.resetsAt || w.seven_day?.resetsAt ? h('span', {}, `Resets ${[w.five_hour?.resetsAt ? `5-hour ${resets(w.five_hour)}` : null, w.seven_day?.resetsAt ? `week ${resets(w.seven_day)}` : null].filter(Boolean).join(', ')}`) : null,
    burn?.fullAt ? h('span', { class: 'hot-text' }, `At this pace the GPT 5-hour limit runs out about ${hhmm(burn.fullAt)}`) : burn && Math.round(burn.perHour * 100) > 0 ? h('span', {}, `GPT burning about ${Math.round(burn.perHour * 100)} points an hour`) : null);
}

// ── repos, deploys waiting, stale memory ─────────────────────────────────
export async function renderRepos() {
  const { S, h, api, $, ago } = D;
  const view = $('#view');
  view.replaceChildren(h('div', { class: 'empty' }, h('p', {}, 'Checking every repo…')));
  let r;
  try { r = await api('POST', '/api/repos'); } catch (e) { view.replaceChildren(h('div', { class: 'empty' }, h('p', {}, e.message))); return; }
  if (S.view !== 'repos') return;
  const clashRepos = new Set(S.data.clashes.map(c => c.repo));
  const interesting = r.repos.filter(x => x.error || x.changed || x.untracked || x.ahead || x.behind || x.sessions.length || clashRepos.has(x.key));
  const quiet = r.repos.filter(x => !interesting.includes(x));
  const repoRow = x => h('div', { class: 'row job' },
    h('span', { class: `body ${clashRepos.has(x.key) ? 'needs' : x.changed || x.ahead ? 'soft' : ''}` }),
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title' }, h('span', { class: 'name' }, x.name), h('span', { class: 'where' }, x.branch ?? '')),
      h('span', { class: `row-sub${clashRepos.has(x.key) ? ' alert' : ''}` }, x.error ?? ([
        x.changed ? `${x.changed} changed file${x.changed === 1 ? '' : 's'}` : null,
        x.untracked ? `${x.untracked} untracked` : null,
        x.ahead ? `${x.ahead} commit${x.ahead === 1 ? '' : 's'} not pushed` : null,
        x.behind ? `${x.behind} behind (as of last fetch)` : null,
        x.sessions.length ? `${x.sessions.length} open session${x.sessions.length === 1 ? '' : 's'} editing it${clashRepos.has(x.key) ? ' — at the same time!' : ''}: ${x.sessions.map(s => s.name).join(', ')}` : null,
      ].filter(Boolean).join(' · ') || 'Clean')),
      x.unpushed?.length ? h('span', { class: 'row-sub mono' }, x.unpushed.slice(0, 4).map(c => `${c.hash} ${c.subject}`).join('  ·  ')) : null),
    h('span', { class: 'row-meta' }, x.lastCommitAt ? `last commit ${ago(x.lastCommitAt)}` : ''));
  put(view,
    S.data.clashes.length ? h('div', { class: 'banner err' }, `Two or more open sessions are editing the same repo: ${S.data.clashes.map(c => c.repo).join(', ')}. They can overwrite each other's work or commit each other's changes.`) : null,
    h('section', { class: 'lane' }, h('div', { class: 'lane-head' }, h('h2', {}, 'Repos that need a look'), h('span', { class: 'count' }, interesting.length)),
      h('div', { class: 'rows' }, interesting.map(repoRow))),
    h('section', { class: 'lane' }, h('div', { class: 'lane-head' }, h('h2', {}, 'Waiting to go live'), h('span', { class: 'desc' }, 'Built but not deployed, from project checklists and your memory notes. You deploy — this just keeps the list.')),
      h('div', { class: 'rows' },
        ...r.waiting.checklist.map(c => h('div', { class: 'row job' }, h('span', { class: 'body soft' }),
          h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, h('span', { class: 'name' }, c.text)), h('span', { class: 'row-sub' }, c.project)),
          h('span', { class: 'row-meta' }, h('button', { class: 'ghost small', type: 'button', onclick: () => api('PATCH', `/api/checklist/${c.id}`, { state: 'live' }).then(renderRepos).catch(D.fail) }, 'Mark live')))),
        ...r.waiting.memory.map(m => h('div', { class: 'row job' }, h('span', { class: 'body closed' }),
          h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, h('span', { class: 'name' }, m.title), h('span', { class: 'where' }, 'memory note')), h('span', { class: 'row-sub' }, m.note)),
          h('span', { class: 'row-meta' }))))),
    r.staleMemory.length ? h('section', { class: 'lane' }, h('div', { class: 'lane-head' }, h('h2', {}, 'Memory notes that may be out of date'),
      h('span', { class: 'desc' }, 'They still say "not deployed / not merged" but haven\'t changed in 2+ weeks. Ask a session to check and update them.')),
      h('div', { class: 'rows' }, r.staleMemory.map(m => h('div', { class: 'row job' }, h('span', { class: 'body closed' }),
        h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, h('span', { class: 'name' }, m.title), h('span', { class: 'where' }, `${m.ageDays} days old`)), h('span', { class: 'row-sub' }, m.note)),
        h('span', { class: 'row-meta' }))))) : null,
    quiet.length ? h('details', { class: 'lane closed' }, h('summary', {}, h('div', { class: 'lane-head' }, h('h2', {}, 'Clean repos'), h('span', { class: 'count' }, quiet.length))),
      h('div', { class: 'rows' }, quiet.map(repoRow))) : null,
  );
}

// ── activity log ─────────────────────────────────────────────────────────
export async function renderActivity(day = D.S.activityDay ?? D.S.data.settings.today) {
  const { S, h, api, $ } = D;
  S.activityDay = day;
  const view = $('#view');
  view.replaceChildren(h('div', { class: 'empty' }, h('p', {}, 'Reading the day…')));
  let a;
  try { a = await api('POST', '/api/activity', { day }); } catch (e) { view.replaceChildren(h('div', { class: 'empty' }, h('p', {}, e.message))); return; }
  if (S.view !== 'activity') return;
  const shift = n => { const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const edits = a.sessions.reduce((n, s) => n + s.edits.length, 0), commits = a.sessions.reduce((n, s) => n + s.commits, 0);
  put(view,
    h('div', { class: 'status-strip' },
      h('button', { class: 'ghost small', type: 'button', onclick: () => renderActivity(shift(-1)) }, 'Previous day'),
      h('strong', {}, new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })),
      h('span', {}, `${a.sessions.length} sessions · ${edits} files changed · ${commits} commits`),
      day < D.S.data.settings.today ? h('button', { class: 'ghost small', type: 'button', onclick: () => renderActivity(shift(1)) }, 'Next day') : null),
    a.sessions.length ? h('div', { class: 'rows' }, a.sessions.map(s => h('button', { class: 'row', type: 'button', onclick: () => D.openChat(s.id) },
      h('span', { class: `body ${s.vaultReminder ? 'soft' : ''}` }),
      h('span', { class: 'row-main' },
        h('span', { class: 'row-title' }, h('span', { class: 'name' }, s.name), h('span', { class: 'where' }, `${hhmm(s.first)}–${hhmm(s.last)}`)),
        h('span', { class: 'row-sub' }, [`${s.turns} turns`, s.edits.length ? `${s.edits.length} files: ${s.edits.slice(0, 4).map(p => p.split(/[\\/]/).pop()).join(', ')}${s.edits.length > 4 ? '…' : ''}` : null,
          s.commits ? `${s.commits} commit${s.commits === 1 ? '' : 's'}` : null, s.deploys.length ? `deploy/push: ${s.deploys.length}` : null].filter(Boolean).join(' · ')),
        s.vaultReminder ? h('span', { class: 'row-sub alert' }, 'Committed code without touching the vault — your CLAUDE.md says the vault must stay current.') : null),
      h('span', { class: 'row-meta' })))) : h('div', { class: 'empty' }, h('p', {}, 'Nothing happened that day.')),
  );
}

// ── morning brief ────────────────────────────────────────────────────────
export async function showBrief({ markSeen = true } = {}) {
  const { S, h, api } = D;
  let b;
  try { b = await api('POST', '/api/brief', { markSeen }); } catch (e) { D.fail(e); return; }
  const r = b.rate?.unifiedWindows;
  const item = (label, count, body) => h('section', { class: 'brief-item' }, h('h3', {}, label, h('span', { class: 'count' }, ` ${count}`)), body);
  const decide = (s, accept, li) => api('POST', `/api/suggestions/${s.key}`, { accept })
    .then(() => li.remove()).catch(D.fail);
  const dlg = h('dialog', { class: 'dialog brief', onclose: () => dlg.remove() },
    h('h2', {}, `Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}${S.data?.options.userName ? `, ${S.data.options.userName}` : ''}`),
    h('p', { class: 'pdesc' }, `Since ${new Date(b.since).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.${r ? ` ${b.rateEngine === 'codex' ? 'GPT usage' : 'Usage'}: 5-hour ${pct(r.five_hour?.utilization)}, week ${pct(r.seven_day?.utilization)}.` : ''}`),
    item('Waiting on you', b.needsYou.length, h('ul', {}, b.needsYou.slice(0, 8).map(n => h('li', {}, h('a', { href: '#', onclick: e => { e.preventDefault(); dlg.close(); D.openChat(n.id); } }, n.name), ` — ${n.reason}`)))),
    item('Follow-ups due today', b.followupsDue.length, h('ul', {}, b.followupsDue.map(f => h('li', {}, f.text)))),
    roundupWaiting() ? item('Your weekly roundup is ready', 1, h('p', {}, h('a', { href: '#', onclick: e => { e.preventDefault(); dlg.close(); openRoundup(); } }, `Read it and send it to ${roundupTo()}`))) : null,
    S.data?.options.automation === false ? null : item('Background jobs finished', b.finished.length, h('ul', {}, b.finished.slice(0, 8).map(q => h('li', {}, `${q.title}: ${q.status}${q.result ? ` — ${q.result.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`)))),
    item('Scheduled jobs that failed', b.failedJobs.length, h('ul', {}, b.failedJobs.map(j => h('li', {}, `${j.name}: ${j.lastResult}`)))),
    b.suggestions.length ? item('Board tidy-up (from the nightly review)', b.suggestions.length, h('ul', { class: 'suggestions' }, b.suggestions.map(s => {
      const li = h('li', { title: s.reason },
        s.kind === 'finish' ? `Finish project "${s.text}"` : s.kind === 'close' ? `${s.project}: close "${s.text}" (${s.from})` : `${s.project}: "${s.text}" ${s.from} → ${s.to}`,
        h('span', { class: 'why' }, ` — ${s.reason}`), ' ',
        h('button', { class: 'primary small', type: 'button', onclick: () => decide(s, true, li) }, 'Accept'), ' ',
        h('button', { class: 'ghost small', type: 'button', onclick: () => decide(s, false, li) }, 'Dismiss'));
      return li;
    }))) : null,
    b.nightlyNotes.length ? item('Notes from the nightly review', b.nightlyNotes.length, h('ul', {}, b.nightlyNotes.map(n => h('li', {}, n)))) : null,
    h('p', { class: 'pdesc' }, `${b.waitingToGoLive} checklist item${b.waitingToGoLive === 1 ? '' : 's'} built but not live · ${b.staleMemory} memory note${b.staleMemory === 1 ? '' : 's'} may be out of date (Repos tab).`),
    h('div', { class: 'dialog-actions' }, h('button', { class: 'primary', type: 'button', onclick: () => dlg.close() }, 'Start the day')));
  document.body.append(dlg);
  dlg.showModal();
}

// ── follow-ups ───────────────────────────────────────────────────────────
export function dueFollowups() {
  // A scheduled check whose job is running shows as that job's chat, not as a follow-up too.
  return (D.S.data.followups ?? []).filter(f => Date.parse(f.due_at) <= Date.now() && f.state !== 'running');
}

const FOLLOWUP_KIND = { ran: 'scheduled check · ran', missed: 'scheduled check · missed' };

export function followupRows() {
  const { h, api } = D;
  return dueFollowups().map(f => h('div', { class: 'row job' },
    h('span', { class: 'body needs' }),
    h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, h('span', { class: 'name' }, f.text), h('span', { class: 'where' }, FOLLOWUP_KIND[f.state] ?? (f.queue_id ? 'scheduled check' : 'follow-up'))),
      h('span', { class: 'row-sub alert' }, `Due ${when(f.due_at)}`)),
    h('span', { class: 'row-meta job-actions' },
      f.session_id && h('button', { class: 'ghost small', type: 'button', onclick: () => D.openChat(f.session_id) }, 'Open'),
      h('button', { class: 'ghost small', type: 'button', onclick: () => api('PATCH', `/api/followups/${f.id}`, { dueAt: new Date(Date.now() + 86_400_000).toISOString() }).catch(D.fail) }, 'Tomorrow'),
      h('button', { class: 'primary small', type: 'button', onclick: () => api('PATCH', `/api/followups/${f.id}`, { done: true }).catch(D.fail) }, 'Done'))));
}

/** "Remind me" menu for a session: tomorrow 09:00, in an hour, next Monday, or a date you pick. */
export function remindMenu(sessionId, name) {
  const { h, api, toast } = D;
  const at = (days, hour) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d; };
  const nextMon = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(9, 0, 0, 0); return d; };
  const add = (due, text) => api('POST', '/api/followups', { text: text || `Check on: ${name}`, dueAt: due.toISOString(), sessionId })
    .then(() => toast(`Reminder set for ${when(due.toISOString())}`)).catch(D.fail);
  return h('select', { 'aria-label': 'Remind me', class: 'remind', onchange: e => {
    const v = e.target.value;
    e.target.value = '';
    if (v === '1h') add(new Date(Date.now() + 3_600_000));
    else if (v === 'tomorrow') add(at(1, 9));
    else if (v === 'monday') add(nextMon());
    else if (v === 'pick') {
      const d = prompt('Remind me on (YYYY-MM-DD HH:MM):', at(1, 9).toISOString().slice(0, 16).replace('T', ' '));
      if (d && !Number.isNaN(Date.parse(d.replace(' ', 'T')))) add(new Date(d.replace(' ', 'T')));
    }
  } }, h('option', { value: '' }, 'Remind me…'), h('option', { value: '1h' }, 'In an hour'), h('option', { value: 'tomorrow' }, 'Tomorrow 09:00'),
  h('option', { value: 'monday' }, 'Next Monday 09:00'), h('option', { value: 'pick' }, 'Pick a time…'));
}

// ── templates (New session form) ─────────────────────────────────────────
export function setupTemplates(form) {
  const { S, h, api, toast } = D;
  const box = form.querySelector('#tpl-row');
  const render = () => {
    const t = S.data.templates ?? [];
    put(box,
      h('select', { 'aria-label': 'Use a template', onchange: e => {
        const tp = t.find(x => String(x.id) === e.target.value);
        if (!tp) return;
        const f = form.elements;
        f.message.value = tp.prompt;
        if (tp.cwd) f.cwd.value = tp.cwd;
        f.model.value = tp.model ?? '';
        f.effort.value = tp.effort ?? '';
        f.permissionMode.value = tp.permission_mode ?? '';
        f.message.dispatchEvent(new Event('input'));
      } }, h('option', { value: '' }, t.length ? 'Start from a template…' : 'No templates yet'), t.map(x => h('option', { value: x.id }, x.name))),
      h('button', { class: 'ghost small', type: 'button', onclick: async () => {
        const f = form.elements;
        if (!f.message.value.trim()) { toast('Write the message first, then save it as a template.', true); return; }
        const name = prompt('Template name:', f.name.value || f.message.value.slice(0, 40));
        if (!name) return;
        try {
          await api('POST', '/api/templates', { name, prompt: f.message.value, cwd: f.cwd.value, model: f.model.value, effort: f.effort.value, permissionMode: f.permissionMode.value });
          toast('Template saved');
          setTimeout(render, 600);
        } catch (e) { D.fail(e); }
      } }, 'Save as template'),
      t.length ? h('button', { class: 'ghost small', type: 'button', onclick: () => {
        const tp = t.find(x => String(x.id) === box.querySelector('select').value);
        if (!tp) { toast('Pick the template to delete first.', true); return; }
        api('DELETE', `/api/templates/${tp.id}`).then(() => { toast('Template deleted'); setTimeout(render, 600); }).catch(D.fail);
      } }, 'Delete template') : null);
  };
  render();
  return render;
}

// ── model suggestion ─────────────────────────────────────────────────────
/** Debounced hint under a prompt box: "Suggested: Sonnet — …" with a one-click Use button. */
export function modelHint(textarea, select, hintEl) {
  const { h, api } = D;
  let t;
  textarea.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      try {
        const { suggestion } = await api('POST', '/api/suggest', { text: textarea.value });
        const label = suggestion?.model ? suggestion.model[0].toUpperCase() + suggestion.model.slice(1) : 'your usual model';
        // Already on it? (covers "Sonnet (default for background work)" in the queue form)
        const current = select.options[select.selectedIndex]?.text ?? '';
        // A Codex form's select lists GPT models only: nothing to switch to, so stay quiet.
        if (!suggestion || ![...select.options].some(o => o.value === String(suggestion.model ?? '')) || select.value === suggestion.model || (suggestion.model && current.startsWith(label))) { hintEl.replaceChildren(); return; }
        hintEl.replaceChildren(h('span', {}, `Suggested: ${label}. ${suggestion.why} `),
          h('button', { class: 'ghost small', type: 'button', onclick: () => { select.value = suggestion.model; hintEl.replaceChildren(); } }, `Use ${label}`));
      } catch { /* hint only */ }
    }, 600);
  });
}

// ── skills ───────────────────────────────────────────────────────────────
let skillsCache = null;
export async function skills() {
  if (!skillsCache) skillsCache = (await D.api('POST', '/api/skills')).skills;
  return skillsCache;
}

// ── slash command suggestions ────────────────────────────────────────────
const commandsCache = new Map(); // folder → Promise of [{ name, description, kind }]
function commandsFor(cwd) {
  const key = (cwd ?? '').toLowerCase();
  if (!commandsCache.has(key)) {
    const p = D.api('POST', '/api/commands', { cwd }).then(r => r.commands);
    p.catch(() => commandsCache.delete(key));
    commandsCache.set(key, p);
  }
  return commandsCache.get(key);
}

/** Suggest slash commands while a message starts with "/" and has no space yet. cwdFn gives the chat's folder; `extra` are Pit Wall's own. */
export function slashMenu(textarea, cwdFn, { below = false, extra = [] } = {}) {
  const { h } = D;
  const menu = h('ul', { class: `slash-menu${below ? ' below' : ''}`, role: 'listbox', 'aria-label': 'Slash commands', hidden: true });
  textarea.insertAdjacentElement('beforebegin', menu);
  textarea.parentElement.classList.add('has-slash-menu');
  let shown = [];
  let sel = 0;
  const close = () => { menu.hidden = true; shown = []; };
  const pick = c => {
    textarea.value = `/${c.name} `;
    close();
    textarea.focus();
    textarea.dispatchEvent(new Event('input'));
  };
  const draw = () => {
    menu.replaceChildren(...shown.map((c, n) => h('li', { role: 'option', 'aria-selected': String(n === sel),
      onmousedown: e => { e.preventDefault(); pick(c); } },
      h('span', { class: 'slash-name' }, `/${c.name}`),
      c.description ? h('small', {}, c.description.slice(0, 110)) : null)));
    menu.hidden = !shown.length;
    menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };
  const update = async () => {
    const m = /^\/(\S*)$/.exec(textarea.value);
    if (!m) { close(); return; }
    const q = m[1].toLowerCase();
    const all = [...extra, ...await commandsFor(cwdFn()).catch(() => [])];
    if (!/^\/\S*$/.test(textarea.value)) return; // typed on while the list loaded
    const starts = all.filter(c => c.name.toLowerCase().startsWith(q));
    const inName = all.filter(c => !starts.includes(c) && c.name.toLowerCase().includes(q));
    const inDesc = q.length > 1 ? all.filter(c => !starts.includes(c) && !inName.includes(c) && c.description.toLowerCase().includes(q)) : [];
    shown = [...starts, ...inName, ...inDesc];
    if (shown.length === 1 && shown[0].name.toLowerCase() === q) shown = []; // already typed in full
    sel = 0;
    draw();
  };
  textarea.addEventListener('input', update);
  textarea.addEventListener('blur', () => setTimeout(close, 100));
  // Capture, so Enter picks a command instead of sending the message.
  textarea.addEventListener('keydown', e => {
    if (menu.hidden || !shown.length || e.isComposing) return;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.key === 'ArrowDown') { stop(); sel = (sel + 1) % shown.length; draw(); }
    else if (e.key === 'ArrowUp') { stop(); sel = (sel - 1 + shown.length) % shown.length; draw(); }
    else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { stop(); pick(shown[sel]); }
    else if (e.key === 'Escape') { stop(); close(); }
  }, true);
}

// ── command palette (Ctrl+K) ─────────────────────────────────────────────
export function openPalette() {
  const { S, h } = D;
  if (document.querySelector('dialog.palette')) return;
  const tabs = [['board', 'Sessions'], ['projects', 'Projects'], ['queue', 'Queue'], ['agents', 'Agents'], ['jobs', 'Scheduled jobs'],
    ['usage', 'Usage'], ['repos', 'Repos'], ['activity', 'Activity']]
    .filter(([v]) => S.data.options.automation !== false || (v !== 'queue' && v !== 'agents'));
  let items = [
    ...tabs.map(([v, l]) => ({ label: `Go to ${l}`, kind: 'view', run: () => D.setView(v) })),
    { label: 'New session', kind: 'action', run: () => document.getElementById('new-btn').click() },
    { label: 'Morning brief', kind: 'action', run: () => showBrief({ markSeen: false }) },
    ...S.data.sessions.filter(s => s.source !== 'closed').map(s => ({ label: s.name, kind: 'session', hint: s.needsYou?.reason ?? '', run: () => D.openChat(s.id) })),
    ...S.data.projects.filter(p => !p.archived).map(p => ({ label: p.name, kind: 'project', run: () => { D.setView('board'); const i = document.getElementById('search'); i.value = p.name; i.dispatchEvent(new Event('input')); } })),
    ...(S.data.templates ?? []).map(t => ({ label: t.name, kind: 'template', run: () => { document.getElementById('new-btn').click(); setTimeout(() => { const sel = document.querySelector('#tpl-row select'); sel.value = String(t.id); sel.dispatchEvent(new Event('change')); }, 50); } })),
  ];
  skills().then(list => { items = items.concat(list.map(sk => ({ label: `/${sk.name}`, kind: 'skill', hint: sk.description, run: () => startWithSkill(sk.name) }))); draw(); }).catch(() => {});
  let sel = 0;
  const input = h('input', { type: 'search', placeholder: 'Jump to a session, project, view, template or skill…', 'aria-label': 'Command' });
  const list = h('ul', { class: 'palette-list', role: 'listbox' });
  const matches = () => { const q = input.value.toLowerCase().trim(); return items.filter(i => !q || i.label.toLowerCase().includes(q) || (i.hint ?? '').toLowerCase().includes(q)).slice(0, 12); };
  const draw = () => {
    const m = matches();
    sel = Math.min(sel, Math.max(0, m.length - 1));
    list.replaceChildren(...m.map((i, n) => h('li', { role: 'option', 'aria-selected': String(n === sel), onclick: () => { dlg.close(); i.run(); } },
      h('span', { class: 'pk' }, i.kind), h('span', {}, i.label), i.hint ? h('small', {}, i.hint.slice(0, 90)) : null)));
  };
  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', e => {
    const m = matches();
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, m.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter' && m[sel]) { e.preventDefault(); dlg.close(); m[sel].run(); }
  });
  const dlg = h('dialog', { class: 'dialog palette', onclose: () => dlg.remove() }, input, list);
  document.body.append(dlg);
  dlg.showModal();
  draw();
  input.focus();
}

export function startWithSkill(name) {
  document.getElementById('new-btn').click();
  setTimeout(() => {
    const f = document.getElementById('new-form').elements;
    f.message.value = `/${name} `;
    f.message.focus();
    f.message.dispatchEvent(new Event('input'));
  }, 50);
}

// ── voice input ──────────────────────────────────────────────────────────
/**
 * A microphone button that dictates into a text box using Chrome's speech recognition.
 * Note: Chrome sends the audio to Google's speech service to transcribe it.
 */
export function voiceButton(textarea) {
  const { h, toast } = D;
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec) return null;
  let rec = null;
  const btn = h('button', { class: 'icon-btn mic', type: 'button', 'aria-label': 'Dictate', title: 'Dictate (Chrome sends the audio to Google to transcribe it)', onclick: () => {
    if (rec) { rec.stop(); return; }
    rec = new Rec();
    rec.lang = 'en-GB';
    rec.interimResults = true;
    rec.continuous = true;
    const base = textarea.value ? `${textarea.value.trimEnd()} ` : '';
    rec.onresult = e => {
      let text = '';
      for (const r of e.results) text += r[0].transcript;
      textarea.value = base + text;
      textarea.dispatchEvent(new Event('input'));
    };
    rec.onerror = e => { toast(`Dictation stopped: ${e.error}`, true); };
    rec.onend = () => { rec = null; btn.classList.remove('on'); };
    rec.start();
    btn.classList.add('on');
  } }, micIcon());
  return btn;
}

function micIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4M9 21h6');
  p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.8'); p.setAttribute('stroke-linecap', 'round');
  svg.append(p);
  return svg;
}

// ── weekly roundup ───────────────────────────────────────────────────────
const roundupTo = () => D.S.data?.roundup?.toName ?? D.S.data?.roundup?.to ?? 'them';
const roundupWaiting = () => { const r = D.S.data?.roundup; return !!r?.latest && !r.latest.sentAt; };

/** The Automation tab's roundup section: switch, schedule, the latest roundup and how to send it. */
export function roundupPanel() {
  const panel = D.h('section', { class: 'roundup-panel', id: 'roundup-panel' });
  fillRoundup(panel);
  return panel;
}
export function refreshRoundup() { const p = document.getElementById('roundup-panel'); if (p) fillRoundup(p); }

function fillRoundup(panel) {
  const { h, S, api } = D;
  const r = S.data?.roundup;
  if (!r) { panel.replaceChildren(); return; }
  if (!r.to) {
    panel.replaceChildren(h('div', { class: 'status-strip' }, h('strong', {}, 'Weekly roundup'),
      h('span', {}, 'Off: set "roundupTo" (an email address) in data/local.json to use it.')));
    return;
  }
  const when = iso => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  panel.replaceChildren(...[
    h('div', { class: 'status-strip' },
      h('strong', {}, 'Weekly roundup'),
      h('span', {}, !r.enabled ? 'Switched off.' : r.autoSend ? `Thursdays from 15:00, written and sent to ${r.to} from your Gmail. If the PC is off then, it goes the next time it is on that week.`
        : `Thursdays from 15:00, for you to send to ${r.to}. If the PC is off then, it is written the next time it is on that week.`),
      h('button', { class: 'ghost small', type: 'button', disabled: r.running, onclick: e => { e.currentTarget.disabled = true; api('POST', '/api/roundup/now').then(() => D.toast('Writing your roundup — about a minute')).catch(D.fail); } },
        r.running ? 'Writing…' : 'Write it now'),
      h('button', { class: 'ghost small', type: 'button', onclick: () => api('POST', '/api/roundup', { enabled: !r.enabled }).then(() => D.toast(r.enabled ? 'Weekly roundup switched off' : 'Weekly roundup switched on')).catch(D.fail) },
        r.enabled ? 'Switch off' : 'Switch on')),
    r.error && !r.running ? h('p', { class: 'row-sub alert' }, `Last attempt failed: ${r.error}`) : null,
    r.latest ? h('div', { class: 'row job' },
      h('span', { class: `body ${r.latest.sentAt ? '' : 'needs'}` }),
      h('span', { class: 'row-main' },
        h('span', { class: 'row-title' }, h('span', { class: 'name' }, r.latest.subject)),
        h('span', { class: `row-sub${r.latest.sendError && !r.latest.sentAt ? ' alert' : ''}` }, `Written ${when(r.latest.createdAt)}`,
          r.latest.sentAt ? ` · sent ${when(r.latest.sentAt)}${r.latest.sentVia === 'gmail' ? ' from your Gmail' : ''}` : r.sending ? ' · sending…'
            : r.latest.sendError ? ` · not sent: ${r.latest.sendError}` : ' · not sent yet')),
      h('span', { class: 'row-meta job-actions' }, h('button', { class: r.latest.sentAt ? 'ghost small' : 'primary small', type: 'button', onclick: () => openRoundup() }, r.latest.sentAt ? 'Open' : 'Read & send'))) : null].filter(Boolean));
}

/** Read, edit and send the roundup: Send opens your email app with it filled in (long ones go via the clipboard). */
export function openRoundup() {
  const { h, S, api } = D;
  const r = S.data?.roundup;
  if (!r?.latest) return;
  const subject = h('input', { value: r.latest.subject });
  const body = h('textarea', { rows: 16, value: r.latest.body });
  // Send from Gmail (as the Thursday send does), with your edits; the email app is the fallback.
  const sendGmail = async e => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Sending…';
    try { await api('POST', '/api/roundup/send', { subject: subject.value, body: body.value }); D.toast(`Sent to ${roundupTo()}`); dlg.close(); }
    catch (x) { D.fail(x); e.currentTarget.disabled = false; e.currentTarget.textContent = `Send to ${roundupTo()}`; }
  };
  const send = async () => {
    const to = r.to;
    let href = `mailto:${to}?subject=${encodeURIComponent(subject.value)}&body=${encodeURIComponent(body.value)}`;
    if (href.length > 1900) {
      // Email apps cut long mailto links short: copy the text and open an empty message to paste it into.
      await navigator.clipboard.writeText(body.value);
      href = `mailto:${to}?subject=${encodeURIComponent(subject.value)}&body=${encodeURIComponent('(Paste here — the roundup is on your clipboard.)')}`;
      D.toast('Roundup copied — paste it into the email', false);
    }
    location.href = href;
    api('POST', '/api/roundup/sent').catch(() => {});
    dlg.close();
  };
  const dlg = h('dialog', { class: 'dialog roundup-dialog', onclose: () => dlg.remove() },
    h('h2', {}, 'Your weekly roundup'),
    h('p', { class: 'pdesc' }, r.latest.sentAt ? `Sent to ${r.to}${r.latest.sentVia === 'gmail' ? ' from your Gmail' : ''}.` : `Written from your chats and tasks this week. Change anything you like, then send it to ${r.to}.`),
    h('label', {}, 'Subject', subject),
    h('label', {}, 'Message', body),
    h('div', { class: 'dialog-actions' },
      h('button', { class: 'ghost', type: 'button', onclick: () => dlg.close() }, 'Close'),
      h('button', { class: 'ghost', type: 'button', onclick: () => navigator.clipboard.writeText(`${subject.value}\n\n${body.value}`).then(() => D.toast('Copied')) }, 'Copy'),
      h('button', { class: 'ghost', type: 'button', title: 'Opens your email app with it filled in', onclick: send }, 'Open in my email app'),
      r.latest.sentAt ? null : h('button', { class: 'primary', type: 'button', title: 'Sends it now from your Gmail', onclick: sendGmail }, `Send to ${roundupTo()}`)));
  document.body.append(dlg);
  dlg.showModal();
}
