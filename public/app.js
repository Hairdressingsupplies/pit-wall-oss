import { renderMarkdown } from './markdown.js';
import { startStarfield } from './starfield.js';
import { THEMES, currentTheme, setTheme } from './theme.js';
import * as more from './more.js';
// Soft-loaded: a server still running from before this file existed answers 404 for it until it restarts (its STATIC
// list is the old one), and a failed static import would stop the whole page. Without it, cards keep the Claude wording.
const { permissionText, newMessagePlaceholder, codexSteps, codexUpdateText, gaugeView, branchState } = await import('./engine-text.js').catch(() => ({
  permissionText: toolName => ({ heading: `Claude wants to use ${toolName}`, alwaysTitle: 'Adds an allow rule to this folder’s local Claude settings' }),
  newMessagePlaceholder: claudePlaceholder => claudePlaceholder,
  codexSteps: null, codexUpdateText: () => null, branchState: (s, run) => ((s ?? run)?.engine === 'codex' ? 'codex-nobranch' : 'claude'),
  gaugeView: u => ({ label: '', rate: u?.rate ?? null, burn: u?.burn ?? null, other: { label: 'GPT', rate: null } }),
}));
// Loaded softly: a server started before this file existed doesn't serve it (it only serves files it knows), and the
// page must still work until Pit Wall is restarted — the new chat features just stay hidden until then.
const extras = await import('./chat-extras.js').catch(() => ({
  init() {}, userActions: () => null, replyActions: () => null, markActions() {}, renderTasks() {}, toggleBtw() {}, closeBtw() {},
  planCard: null, thinkingEl: () => null, colorRow: () => null, forkDialog() {}, lastForkable: () => null,
}));
// Soft-loaded too; null (no Read aloud, no menu switches) when it isn't served yet or the browser can't speak.
const speech = await import('./speech.js').then(m => (m.supported() ? m : null)).catch(() => null);

// ── state ────────────────────────────────────────────────────────────────
const S = {
  files: new Map(), // sessionId -> [{name, path, pending}] files attached to the next message
  data: null,
  view: 'board',
  search: '',
  selected: null,       // session id open in chat
  chat: null,           // {items, live, run, partial, truncated}
  drafts: new Map(),    // session id -> unsent text
  attachments: new Map(), // session id -> images waiting to send [{mediaType, data, url, pending}]
  confirmDelete: null,  // project id awaiting a second click
  showClosed: false,
};

const $ = sel => document.querySelector(sel);

/** Build an element. Children: strings become text nodes (never HTML). */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; // only ever used with renderMarkdown output (escaped first)
    else if (k === 'value') el.value = v; // property, so it works for <textarea> too
    else if (k === 'style') el.style.cssText = v; // CSSOM — the CSP blocks style="" attributes
    else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${err ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, err ? 6000 : 2500);
}
const fail = e => toast(e.message, true);

function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 50) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const folder = p => (p ? p.split(/[\\/]/).filter(Boolean).pop() : '');
const clock = epochS => new Date(epochS * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayName = epochS => new Date(epochS * 1000).toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const fmtTokens = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

// ── header ───────────────────────────────────────────────────────────────
/** The tooltip line for the engine whose reading is not in the rings (nothing until it has one). */
function otherGaugeLine(o) {
  const w = o?.rate?.unifiedWindows;
  if (!w) return '';
  const p = x => `${Math.round((x?.utilization ?? 0) * 100)}%`;
  return ` ${o.label} ${w.five_hour ? `5-hour ${p(w.five_hour)} · ` : ''}week ${p(w.seven_day)}${w.five_hour?.resetsAt ? ` · resets ${clock(w.five_hour.resetsAt)}` : ''}.`;
}
function renderHeader() {
  const d = S.data;
  renderUpdateBtn(d.update);
  const { label, rate, burn, other } = gaugeView(d.usage, d.settings.defaultEngine); // the default engine's reading; the other one goes in the tooltip
  const u = $('#usage');
  u.replaceChildren();
  if (rate?.unifiedWindows) {
    const five = rate.unifiedWindows.five_hour, week = rate.unifiedWindows.seven_day;
    // No 5-hour window in the reading means this plan doesn't have one (Ultra since 2026-10-31): the week ring alone.
    $('#gauge').classList.toggle('week-only', !five);
    $('#gauge-title').textContent = five ? 'Claude usage: inner ring 5-hour window, outer ring week' : `${label || 'Claude'} usage: ring shows the week`;
    $('#g5').style.strokeDasharray = `${Math.round((five?.utilization ?? 0) * 100)} 100`;
    $('#g7').style.strokeDasharray = `${Math.round((week?.utilization ?? 0) * 100)} 100`;
    const pct = x => h('b', { class: x >= 0.8 ? 'hot' : '' }, `${Math.round(x * 100)}%`);
    u.append(...(five ? [label ? `${label} 5-hour ` : '5-hour ', pct(five.utilization ?? 0), ' · week '] : [label ? `${label} week ` : 'Week ']), pct(week?.utilization ?? 0),
      burn?.fullAt ? h('span', { class: 'hot' }, ` · runs out ~${new Date(burn.fullAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`) : '');
    u.title = `${five ? `5-hour window resets ${five.resetsAt ? clock(five.resetsAt) : '?'}, week` : 'Week'} resets ${week?.resetsAt ? dayName(week.resetsAt) : '?'}. ${fmtTokens(d.usage.tokensToday)} tokens today. Measured ${ago(rate.capturedAt)}.${otherGaugeLine(other)}`;
  } else {
    u.append('Usage shows after your first message here');
  }

  const live = d.sessions.filter(s => s.source !== 'closed' && !s.done).length;
  const needs = d.sessions.filter(s => s.needsYou && !s.needsYou.soft).length;
  const o = d.organiser;
  $('#stats').replaceChildren(...[
    h('span', {}, h('strong', {}, live), ' live'),
    needs ? h('span', { class: 'alert' }, h('strong', {}, needs), needs === 1 ? ' needs you' : ' need you') : null,
  ].filter(Boolean));
  const ob = $('#organise-btn');
  ob.disabled = o.running || o.callsToday >= o.cap;
  ob.textContent = o.running ? 'Organising projects…' : `Organise projects now (${o.callsToday}/${o.cap} today)`;
  document.title = needs ? `(${needs}) Pit Wall` : 'Pit Wall';
}

// ── board ────────────────────────────────────────────────────────────────
function matches(s) {
  if (!S.search) return true;
  const q = S.search.toLowerCase();
  const p = s.projectId ? S.data.projects.find(p => p.id === s.projectId) : null;
  return [s.name, s.title, s.lastPrompt, s.summary, s.terminalName, s.cwd, p?.name].some(x => x && x.toLowerCase().includes(q));
}

function bodyClass(s) {
  if (s.needsYou && !s.needsYou.soft) return 'needs';
  if (s.status === 'error') return 'error';
  if (s.status === 'busy' || s.status === 'starting' || s.status === 'agents_working') return 'busy';
  if (s.needsYou?.soft) return 'soft';
  if (s.source === 'closed' || s.status === 'parked' || s.status === 'stopped') return 'closed';
  return '';
}

/** "1 agent working" · "running a command" · "2 jobs working" — from the chat's own job list when Pit Wall runs it. */
function workingWord(s) {
  const jobs = (s.run?.jobs ?? []).filter(j => j.working);
  if (!jobs.length) return s.jobs === 1 ? '1 agent working' : `${s.jobs || ''} agents working`.trim();
  const commands = jobs.filter(j => j.type === 'local_bash').length;
  if (commands === jobs.length) return commands === 1 ? 'running a command' : `running ${commands} commands`;
  if (!commands) return jobs.length === 1 ? '1 agent working' : `${jobs.length} agents working`;
  return `${jobs.length} jobs working`;
}

function statusWord(s) {
  if (s.status === 'agents_working') return workingWord(s);
  if (s.source === 'terminal') return s.status === 'busy' ? 'working' : s.status === 'shell' ? 'running a command' : 'idle';
  return { starting: 'starting', busy: 'working', needs_you: 'waiting on you', your_turn: 'your turn', parked: 'resting', stopped: 'stopped', error: 'error', closed: 'closed' }[s.status] ?? s.status;
}

function row(s) {
  const alert = s.needsYou && !s.needsYou.soft;
  const sub = s.needsYou ? `${s.needsYou.reason}${s.needsYou.exact ? '' : ' (best guess)'}` : (s.summary || s.lastPrompt || s.firstPrompt || '');
  // Only the folder when it isn't the usual workspace root — less noise on most rows.
  const root = S.data.options.workspaces[0];
  const where = s.cwd && s.cwd !== root ? folder(s.cwd) : '';
  const origin = s.source === 'terminal' ? `terminal ${s.terminalName ?? ''}`.trim() : '';
  const hover = [statusWord(s), origin, where, s.branch, s.context ? `${more.fmtK(s.context)} context` : '',
    s.weekShare >= 0.01 ? `~${Math.round(s.weekShare * 100)}% of this week` : ''].filter(Boolean).join(' · ');
  return h('button', { class: `row${s.color ? ` tinted c-${s.color}` : ''}`, type: 'button', title: hover, 'aria-current': S.selected === s.id ? 'true' : 'false', onclick: () => openChat(s.id) },
    h('span', { class: `body ${bodyClass(s)}`, 'aria-label': statusWord(s) }),
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title' }, h('span', { class: 'name' }, s.name),
        engineTag(s),
        where ? h('span', { class: 'where' }, where) : null,
        more.contextBadge(s, { onlyWhenHigh: true }),
        s.clash ? h('span', { class: 'clash', title: 'Another open session is editing the same repo' }, 'clash') : null),
      sub ? h('span', { class: `row-sub${alert ? ' alert' : ''}` }, sub) : null),
    h('span', { class: 'row-meta' }, ago(s.lastActivity)),
  );
}

/** "3 of 7 done · 1 blocked" — one quiet line instead of a row of pills. */
function progressText(p) {
  const n = p.checklist.length;
  if (!n) return null;
  const done = p.checklist.filter(c => c.state === 'live').length;
  const blocked = p.checklist.filter(c => c.state === 'blocked').length;
  return h('span', { class: 'progress-text' }, `${done} of ${n} done`, blocked ? h('span', { class: 'alert-text' }, ` · ${blocked} blocked`) : null,
    h('span', { class: 'meter', 'aria-hidden': 'true' }, h('span', { style: `width:${Math.round((done / n) * 100)}%` })));
}

function lane(title, sessions, { cls = '', desc = '', extra = null } = {}) {
  return h('section', { class: `lane ${cls}` },
    h('div', { class: 'lane-head', title: desc || null }, h('h2', {}, title), h('span', { class: 'count' }, `${sessions.length}`), extra),
    h('div', { class: 'rows' }, sessions.map(row)));
}

// ── continuing project work ──────────────────────────────────────────────
/** Open the New session form pre-filled with a brief for a project or one of its tasks, to review and start. */
async function startFromBrief(url) {
  try {
    const b = await api('POST', url);
    openNewDialog();
    const f = $('#new-form').elements;
    f.message.value = b.message;
    f.name.value = b.name;
    f.cwd.value = b.cwd;
    f.projectId.value = String(b.projectId);
    f.message.rows = 14;
    $('#new-form').dataset.brief = '1';
    f.message.dispatchEvent(new Event('input'));
    f.message.setSelectionRange(0, 0);
    f.message.scrollTop = 0;
  } catch (e) { fail(e); }
}

/** Continue a project: jump back into its live chat if there is one, otherwise start from a brief. */
function continueProject(p) {
  const s = S.data.sessions.filter(x => x.projectId === p.id && x.source !== 'closed' && !x.done && !x.supersededBy)
    .sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))[0];
  if (s) openChat(s.id); else startFromBrief(`/api/projects/${p.id}/brief`);
}

/** Closed = its Claude has exited, or you finished it (it reopens if anything new happens in it). */
const isClosed = s => s.source === 'closed' || !!s.done;

function renderBoard() {
  const view = $('#view');
  const d = S.data;
  const sessions = d.sessions.filter(matches);
  const active = sessions.filter(s => !isClosed(s));
  const needs = sessions.filter(s => s.needsYou).sort((a, b) => (a.needsYou.soft ? 1 : 0) - (b.needsYou.soft ? 1 : 0));
  const needIds = new Set(needs.map(s => s.id));
  const out = [];

  const due = more.followupRows();
  if (needs.length || due.length) {
    const l = lane('Needs you', needs, { cls: 'needs' });
    l.querySelector('.count').textContent = String(needs.length + due.length);
    l.querySelector('.rows').append(...due);
    out.push(l);
  }

  // "One list" (More menu): every open chat in a single lane, newest started first — no project lanes.
  const started = s => s.startedAt ?? s.lastActivity ?? '';
  const grouped = d.settings.groupByProject !== false;
  if (!grouped) {
    const all = active.filter(s => !needIds.has(s.id)).sort((a, b) => started(b).localeCompare(started(a)));
    if (all.length) out.push(lane('Sessions', all));
  }

  // New sessions land here until the organiser files them (or all day once its daily cap is used),
  // so keep them near the top where you'll look for something you just started.
  const unsorted = !grouped ? [] : active.filter(s => !s.projectId && !needIds.has(s.id)).sort((a, b) => started(b).localeCompare(started(a)));
  if (unsorted.length) {
    const capped = d.organiser.callsToday >= d.organiser.cap;
    out.push(lane('New — not filed yet', unsorted, {
      desc: 'Claude files these into projects once they have gone quiet for a minute.',
      extra: capped ? h('span', { class: 'desc' }, 'The organiser has used today’s calls, so these stay here until tomorrow — pick a project in the chat header to file one now.') : null,
    }));
  }

  // Newest-started open session first. Ordering by last activity made busy projects swap places on every update;
  // start times only change when you start or close a chat. Chats in "Needs you" do not move their project.
  const latest = id => active.filter(s => s.projectId === id && !needIds.has(s.id)).map(started).sort().pop() ?? '';
  const projects = !grouped ? [] : d.projects.filter(p => !p.archived).sort((a, b) => latest(b.id).localeCompare(latest(a.id)));
  for (const p of projects) {
    const mine = active.filter(s => s.projectId === p.id && !needIds.has(s.id)).sort((a, b) => started(b).localeCompare(started(a)));
    const closed = sessions.filter(s => s.projectId === p.id && isClosed(s) && !needIds.has(s.id));
    const nameHit = S.search && p.name.toLowerCase().includes(S.search.toLowerCase());
    if (!mine.length && !(S.showClosed && closed.length) && !(nameHit && closed.length)) continue;
    const shown = [...mine, ...(S.showClosed || nameHit ? closed : [])];
    const l = lane(p.name, shown, { desc: p.description, extra: progressText(p) });
    // The lane head says "2 blocked" — show which tasks, right here, with a way to act on each.
    const blocked = p.checklist.filter(c => c.state === 'blocked');
    if (blocked.length) {
      const byId = new Map(d.sessions.map(s => [s.id, s]));
      l.append(h('ul', { class: 'blocked-list', 'aria-label': `Blocked tasks in ${p.name}` }, blocked.map(c => {
        const from = c.source_session && byId.get(c.source_session);
        return h('li', {},
          h('span', { class: 'blocked-tag' }, 'Blocked'),
          h('span', { class: 'blocked-text', title: historyTitle(c) }, c.text),
          from ? h('button', { class: 'link', type: 'button', title: `Reopen “${from.name}”`, onclick: () => openChat(from.id) }, 'Open chat') : null,
          h('button', { class: 'link strong', type: 'button', title: 'Open a new session pre-filled with this task and where the project stands',
            onclick: () => startFromBrief(`/api/checklist/${c.id}/brief`) }, 'Continue'));
      })));
    }
    out.push(l);
  }

  const closedLoose = sessions.filter(s => isClosed(s) && !needIds.has(s.id) && (!grouped || !s.projectId || !S.showClosed));
  if (closedLoose.length) {
    out.push(h('details', { class: 'lane closed', open: S.showClosed },
      h('summary', { onclick: e => { e.preventDefault(); S.showClosed = !S.showClosed; renderBoard(); } },
        h('div', { class: 'lane-head' }, h('h2', {}, S.showClosed ? 'Closed sessions' : 'Closed in the last 14 days'), h('span', { class: 'count' }, closedLoose.length),
          h('span', { class: 'desc' }, S.showClosed && grouped ? 'Showing closed sessions inside their projects too.' : 'Open one to pick it back up here.'))),
      h('div', { class: 'rows' }, closedLoose.slice(0, 200).map(row))));
  }

  const found = searchResultsLane();
  if (found) out.unshift(found);
  if (!out.length) {
    out.push(h('div', { class: 'empty' }, h('h2', {}, S.search ? 'Nothing on the board matches that' : 'No sessions yet'),
      h('p', {}, S.search.length >= 3 ? 'Press Enter to search inside every conversation, including older ones.' : S.search ? 'Try a project name or a word from the task.' : 'Start one with New session.')));
  }
  view.replaceChildren(...out);
}

// ── task status changes → history + the chat behind the task ──────────────
const STATE_NAMES = { todo: 'To do', doing: 'Doing', blocked: 'Blocked', built: 'Built', live: 'Done' };

function historyTitle(c) {
  if (!c.history?.length) return 'Change the status — the chat this task came from is told on your next message there';
  const when = at => new Date(`${at.replace(' ', 'T')}Z`).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return ['History:', ...c.history.map(e => `${when(e.at)} — ${STATE_NAMES[e.from_state] ?? '?'} → ${STATE_NAMES[e.to_state]}`
    + `${e.note ? ` (${e.note})` : ''}, ${e.by === 'user' ? 'you' : 'organiser'}`
    + (e.by === 'user' ? (e.delivered_at ? ', chat told' : e.session_id ? ', chat not told yet' : ', no chat linked') : ''))].join('\n');
}

async function changeTaskState(c, state) {
  try {
    const r = await api('PATCH', `/api/checklist/${c.id}`, { state });
    S.justChanged = r.event ? { itemId: c.id, event: r.event, tell: r.tell, note: null, told: false } : null;
    renderProjects();
  } catch (e) { fail(e); }
}

/** Under a task you just changed: what it means (Deployed / Finished / a note) and which chat hears about it. */
function changeStrip(c) {
  const j = S.justChanged;
  const setNote = note => api('PATCH', `/api/task-events/${j.event.id}`, { note }).then(() => { j.note = note; renderProjects(); }).catch(fail);
  const noteBtn = (label, value) => h('button', { type: 'button', class: `chip${j.note === value ? ' on' : ''}`, 'aria-pressed': String(j.note === value), onclick: () => setNote(value) }, label);
  const custom = h('input', { class: 'note-input', placeholder: j.event.to_state === 'live' ? 'or a note…' : 'Add a note (optional)…', value: j.note && !['deployed', 'finished'].includes(j.note) ? j.note : '',
    'aria-label': 'Note for this change', onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); setNote(e.target.value); } }, onchange: e => setNote(e.target.value) });
  const tell = j.tell;
  const who = tell
    ? (j.told ? `Sent to “${tell.name}” — it will update its notes now.`
      : `“${tell.name}” will be told on your next message there${j.note ? '' : ' — add a note first if it helps'}.`)
    : 'No chat is linked to this task, so it is only kept in the task’s history and today’s activity log.';
  return h('div', { class: 'change-strip', role: 'status' },
    h('div', { class: 'change-row' },
      h('strong', {}, `Marked ${STATE_NAMES[j.event.to_state]}.`),
      j.event.to_state === 'live' ? [noteBtn('Deployed', 'deployed'), noteBtn('Finished', 'finished')] : null,
      custom,
      h('button', { type: 'button', class: 'link muted', 'aria-label': 'Close', onclick: () => { S.justChanged = null; renderProjects(); } }, 'Close')),
    h('div', { class: 'change-row muted' }, who,
      tell && !j.told && tell.source !== 'terminal'
        ? h('button', { type: 'button', class: 'link strong', title: 'Sends it now so the chat updates its notes straight away (uses one message of usage)',
          onclick: () => api('POST', `/api/task-events/${j.event.id}/tell`).then(() => { j.told = true; renderProjects(); }).catch(fail) }, 'Tell it now')
        : null,
      tell?.source === 'terminal' && !j.told ? h('span', {}, ' (open in a terminal, so it can’t be sent from here)') : null),
    S.data.settings.inboxHook ? null : h('div', { class: 'change-row alert-text' }, 'The Pit Wall message hook isn’t installed, so chats won’t be told automatically.'));
}

const allDone = p => p.checklist.length > 0 && p.checklist.every(c => c.state === 'live');

/** Close a project and every chat in it. Asks once more when tasks are still open. */
async function finishProject(p, btn) {
  const open = p.checklist.filter(c => c.state !== 'live').length;
  if (open && btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.textContent = `${open} task${open === 1 ? '' : 's'} not done — finish anyway?`;
    return;
  }
  try {
    const r = await api('POST', `/api/projects/${p.id}/finish`);
    toast(`Finished “${p.name}”${r.chats ? ` and closed ${r.chats} chat${r.chats === 1 ? '' : 's'}` : ''} — restore it from Finished projects`);
  } catch (e) { fail(e); }
}

// ── projects view ────────────────────────────────────────────────────────
function renderProjects() {
  const d = S.data;
  const q = S.search.toLowerCase();
  const list = d.projects.filter(p => !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
    .sort((a, b) => a.archived - b.archived);
  const count = id => d.sessions.filter(s => s.projectId === id).length;
  const byId = new Map(d.sessions.map(s => [s.id, s]));

  // Each task: reopen the chat it came from, or start a new session briefed from what Pit Wall knows.
  const taskAction = (p, c) => {
    // The chat the task came from; for older tasks (before that was recorded), the project's only chat.
    const mine = d.sessions.filter(s => s.projectId === p.id);
    const from = (c.source_session && byId.get(c.source_session)) || (mine.length === 1 ? mine[0] : null);
    const done = c.state === 'live';
    const buttons = [];
    if (from) buttons.push(h('button', { class: 'link', type: 'button', title: `Reopen “${from.name}”`, onclick: () => openChat(from.id) }, 'Open chat'));
    if (!done) buttons.push(h('button', { class: 'link strong', type: 'button', title: 'Open a new session pre-filled with this task, the project goal and recent progress — you check it before it starts',
      onclick: () => startFromBrief(`/api/checklist/${c.id}/brief`) }, c.state === 'todo' ? 'Start' : 'Continue'));
    return h('span', { class: 'task-actions' }, ...buttons);
  };

  const cards = list.map(p => {
    const pinned = c => S.justChanged?.itemId === c.id;
    const open = p.checklist.filter(c => c.state !== 'live' || pinned(c));
    const doneItems = p.checklist.filter(c => c.state === 'live' && !pinned(c));
    const showDone = S.showDone?.has(p.id);
    const item = c => h('li', { class: `st-${c.state}` },
      h('select', { class: `state ${c.state}`, 'aria-label': 'State', title: historyTitle(c),
        onchange: e => changeTaskState(c, e.target.value) },
        ['todo', 'doing', 'blocked', 'built', 'live'].map(st => h('option', { value: st, selected: st === c.state }, STATE_NAMES[st]))),
      h('span', { class: 'task-body' }, h('span', { class: 'task-text', title: c.locked ? 'Set by you' : null }, c.text), taskAction(p, c),
        S.justChanged?.itemId === c.id ? changeStrip(c) : null),
      h('button', { class: 'x', type: 'button', 'aria-label': `Remove ${c.text}`, onclick: () => api('DELETE', `/api/checklist/${c.id}`).catch(fail) }, '×'));
    return h('article', { class: `proj${p.archived ? ' archived' : ''}` },
      h('div', { class: 'proj-head' },
        h('h3', {}, h('textarea', { rows: 1, value: p.name, 'aria-label': 'Project name',
          onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
          onchange: e => api('PATCH', `/api/projects/${p.id}`, { name: e.target.value.replace(/\s+/g, ' ').trim() }).catch(fail) })),
        p.archived ? h('button', { class: 'ghost small', type: 'button', onclick: () => api('PATCH', `/api/projects/${p.id}`, { archived: false }).then(() => toast('Project restored')).catch(fail) }, 'Restore')
          : allDone(p) ? h('button', { class: 'primary small', type: 'button', title: 'Every task is done: close this project and its chats. You can restore it later.', onclick: e => finishProject(p, e.currentTarget) }, 'Finish project')
          : h('button', { class: 'ghost small', type: 'button', title: 'Reopen the latest live chat for this project, or start a new one briefed with where it stands',
            onclick: () => continueProject(p) }, 'Continue')),
      p.description ? h('p', { class: 'pdesc' }, p.description) : null,
      progressText(p),
      h('ul', { class: 'check' }, open.map(item)),
      doneItems.length ? h('button', { class: 'link muted', type: 'button', onclick: () => {
        S.showDone ??= new Set();
        if (showDone) S.showDone.delete(p.id); else S.showDone.add(p.id);
        renderProjects();
      } }, showDone ? 'Hide done' : `${doneItems.length} done`) : null,
      showDone ? h('ul', { class: 'check done' }, doneItems.map(item)) : null,
      h('form', { class: 'add-item', onsubmit: e => {
        e.preventDefault();
        const input = e.target.elements.text;
        if (!input.value.trim()) return;
        api('POST', `/api/projects/${p.id}/checklist`, { text: input.value }).then(() => { input.value = ''; }).catch(fail);
      } }, h('input', { name: 'text', placeholder: '+ Add a task', 'aria-label': 'Add a task' })),
      h('div', { class: 'proj-foot' },
        h('span', { class: p.overBudget ? 'alert-text' : '' }, `${count(p.id)} session${count(p.id) === 1 ? '' : 's'}`,
          p.weekShare >= 0.01 ? ` · ~${Math.round(p.weekShare * 100)}% of week` : '', p.overBudget ? ' · over budget' : ''),
        h('details', { class: 'menu up' },
          h('summary', { class: 'link', 'aria-label': `More for ${p.name}` }, '•••'),
          h('div', { class: 'menu-list' },
            h('label', { class: 'menu-field' }, 'Weekly budget ',
              h('input', { type: 'number', min: 0, max: 100, value: p.budget_pct ?? '', placeholder: 'none', class: 'budget-input', 'aria-label': 'Weekly budget %',
                onchange: e => api('PATCH', `/api/projects/${p.id}`, { budgetPct: e.target.value ? Number(e.target.value) : null }).catch(fail) }), '%'),
            p.archived ? h('button', { type: 'button', onclick: () => api('PATCH', `/api/projects/${p.id}`, { archived: false }).catch(fail) }, 'Restore project')
              : h('button', { type: 'button', title: 'Closes the project and every chat in it. You can restore it later.', onclick: e => { e.stopPropagation(); finishProject(p, e.currentTarget); } }, 'Finish project'),
            h('button', { type: 'button', class: 'danger-text', onclick: e => {
              if (S.confirmDelete !== p.id) { S.confirmDelete = p.id; e.target.textContent = 'Click again to delete'; return; }
              S.confirmDelete = null;
              api('DELETE', `/api/projects/${p.id}`).catch(fail);
            } }, 'Delete project')))),
    );
  });

  const newCard = h('form', { class: 'proj', onsubmit: e => {
    e.preventDefault();
    const f = e.target.elements;
    api('POST', '/api/projects', { name: f.name.value, description: f.description.value }).then(() => e.target.reset()).catch(fail);
  } },
  h('h3', { class: 'plain' }, 'Add a project'),
  h('p', { class: 'pdesc' }, 'Claude creates and names projects on its own. Add one here to name it yourself.'),
  h('div', { class: 'add-item' }, h('input', { name: 'name', placeholder: 'Area: specific focus', required: true, 'aria-label': 'Project name' })),
  h('div', { class: 'add-item', style: 'margin-top:6px' }, h('input', { name: 'description', placeholder: 'One line on the goal', 'aria-label': 'Description' })),
  h('div', { class: 'proj-foot' }, h('span'), h('button', { class: 'primary', type: 'submit' }, 'Add project')));

  // Finished projects sit out of the way in their own collapsed section.
  const liveCards = cards.filter((_, i) => !list[i].archived), doneCards = cards.filter((_, i) => list[i].archived);
  $('#view').replaceChildren(h('div', { class: 'proj-grid' }, ...liveCards, newCard),
    ...(doneCards.length ? [h('details', { class: 'finished-projects', open: !!S.showFinished || !!q,
      ontoggle: e => { S.showFinished = e.target.open; } },
      h('summary', {}, `Finished projects (${doneCards.length})`),
      h('div', { class: 'proj-grid' }, ...doneCards))] : []));
}

function renderView() {
  if (!S.data) return;
  renderHeader();
  if (S.view === 'board') renderBoard();
  else if (S.view === 'projects') renderProjects();
  else if (S.view === 'queue' && automationOn()) renderQueue();
  else if (S.view === 'agents' && automationOn()) renderAgents();
  else if (S.view === 'jobs') renderJobs();
  else if (S.view === 'usage') more.renderUsage();
  else if (S.view === 'repos') more.renderRepos();
  else if (S.view === 'activity') more.renderActivity();
  if (S.selected) renderChatHead();
  $('#search-all').hidden = !(S.view === 'board' && S.search.length >= 3);
}

// Four top tabs; Automation and Insights hold their sections in a quiet second row.
const GROUPS = {
  board: [['board', 'Sessions']],
  projects: [['projects', 'Projects']],
  automation: [['queue', 'Queue'], ['agents', 'Agents'], ['jobs', 'Scheduled jobs']],
  insights: [['usage', 'Usage'], ['repos', 'Repos'], ['activity', 'Activity']],
};
const automationOn = () => S.data?.options.automation !== false;
const groupOf = v => Object.keys(GROUPS).find(g => GROUPS[g].some(([k]) => k === v)) ?? 'board';

function setView(v) {
  if (GROUPS[v] && !GROUPS[v].some(([k]) => k === v)) {
    const last = S.lastInGroup?.[v];
    v = GROUPS[v].some(([k]) => k === last) ? last : GROUPS[v][0][0];
  }
  S.view = v;
  const g = groupOf(v);
  (S.lastInGroup ??= {})[g] = v;
  document.querySelectorAll('.tab').forEach(x => x.setAttribute('aria-selected', String(x.dataset.group === g)));
  const sub = $('#subtabs');
  sub.hidden = GROUPS[g].length < 2;
  sub.replaceChildren(...(GROUPS[g].length < 2 ? [] : GROUPS[g].map(([k, label]) =>
    h('button', { type: 'button', class: 'subtab', 'aria-current': k === v ? 'true' : 'false', onclick: () => setView(k) }, label))));
  renderView();
}

// Queue and Agents redraw from live state — but not while you are typing into one of their forms.
function renderExtraViews() {
  const typing = document.activeElement?.closest?.('.pw-form');
  if (typing || !automationOn()) return;
  if (S.view === 'queue') renderQueue();
  else if (S.view === 'agents') renderAgents();
}

// ── search all conversations ─────────────────────────────────────────────
async function searchAll() {
  const q = S.search;
  S.searchResults = { q, loading: true, results: [] };
  renderBoard();
  try {
    const r = await api('POST', '/api/search', { q });
    if (S.search !== q) return;
    S.searchResults = { q, ...r, loading: false };
  } catch (e) {
    if (/newer search/.test(e.message)) return;
    S.searchResults = { q, loading: false, results: [], error: e.message };
  }
  renderBoard();
}

function searchResultsLane() {
  const sr = S.searchResults;
  if (!sr || sr.q !== S.search) return null;
  const head = h('div', { class: 'lane-head' }, h('h2', {}, `Conversations mentioning “${sr.q}”`),
    h('span', { class: 'count' }, sr.loading ? 'searching…' : `${sr.results.length}${sr.capped ? '+' : ''}`),
    sr.error ? h('span', { class: 'desc' }, sr.error) : !sr.loading ? h('span', { class: 'desc' }, `Searched ${sr.scanned} of ${sr.total} conversations, newest first.`) : null);
  return h('section', { class: 'lane search-lane' }, head,
    h('div', { class: 'rows' }, sr.results.map(r => h('button', { class: 'row', type: 'button', onclick: () => openChat(r.sessionId) },
      h('span', { class: `body ${r.live ? '' : 'closed'}` }),
      h('span', { class: 'row-main' },
        h('span', { class: 'row-title' }, h('span', { class: 'name' }, r.name), h('span', { class: 'where' }, folder(r.cwd))),
        ...r.snippets.map(s => h('span', { class: 'row-sub snippet' }, `${s.role === 'user' ? 'You' : 'Claude'}: ${s.text}`))),
      h('span', { class: 'row-meta' }, ago(new Date(r.mtimeMs).toISOString()))))));
}

// ── queue ────────────────────────────────────────────────────────────────
/** SQLite's datetime('now') is UTC without a zone ("2026-09-29 18:00:00"); ISO strings pass through. */
const sqlTime = s => (s && !s.includes('T') ? `${s.replace(' ', 'T')}Z` : s);

const JOB_WORDS = { queued: 'Waiting', running: 'Working', needs_you: 'Needs you', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };

function folderField(name, value) {
  const input = h('input', { name, required: true, spellcheck: 'false', 'aria-label': 'Folder path', placeholder: 'Type a folder path' });
  const sel = folderPicker(input);
  input.value = value ?? lastFolder() ?? S.data.options.workspaces[0] ?? '';
  return [sel, input];
}

// Folder dropdown: the known folders plus "Other folder…", which shows the path box. The path box keeps the form
// field's name, so code that reads or sets f.cwd.value works unchanged (setting it moves the dropdown too).
const OTHER_FOLDER = '(other)';
const LAST_FOLDER_KEY = 'pw-last-folder';
function lastFolder() { try { return localStorage.getItem(LAST_FOLDER_KEY); } catch { return null; } }
function rememberFolder(dir) { try { if (dir) localStorage.setItem(LAST_FOLDER_KEY, dir); } catch { /* storage blocked */ } }
function folderLabel(dir, root) {
  if (dir === root) return `${folder(dir)} (whole workspace)`;
  return dir.toLowerCase().startsWith(`${root.toLowerCase()}\\`) ? dir.slice(root.length + 1) : dir;
}
function folderPicker(input) {
  const sel = h('select', { 'aria-label': 'Folder' });
  const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const sync = () => {
    const list = S.data?.options.workspaces ?? [];
    const v = native.get.call(input);
    const known = list.find(w => w.toLowerCase() === v.toLowerCase());
    sel.replaceChildren(...list.map(w => h('option', { value: w }, folderLabel(w, list[0]))), h('option', { value: OTHER_FOLDER }, 'Other folder…'));
    sel.value = known ?? OTHER_FOLDER;
    input.hidden = !!known;
  };
  Object.defineProperty(input, 'value', { configurable: true, get: () => native.get.call(input), set: v => { native.set.call(input, v); sync(); } });
  sel.addEventListener('change', () => {
    if (sel.value === OTHER_FOLDER) { native.set.call(input, ''); input.hidden = false; input.focus(); }
    else { native.set.call(input, sel.value); input.hidden = true; }
  });
  // A form reset clears the path box without going through the setter; put the dropdown back on the default.
  queueMicrotask(() => input.form?.addEventListener('reset', () => setTimeout(() => { input.value = lastFolder() ?? S.data?.options.workspaces[0] ?? ''; })));
  sync();
  return sel;
}
function projectField(name, value) {
  return h('select', { name, 'aria-label': 'Project' }, h('option', { value: '' }, 'No project'),
    S.data.projects.filter(p => !p.archived).map(p => h('option', { value: p.id, selected: p.id === value }, p.name)));
}

function renderQueue() {
  const q = S.data.queue;
  const pct = x => `${Math.round(x * 100)}%`;
  const form = h('form', { class: 'panel pw-form', onsubmit: async e => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      await api('POST', '/api/queue', { title: f.title.value, prompt: f.prompt.value, cwd: f.cwd.value, projectId: f.projectId.value || null, model: f.model.value, engine: engineOf(f), offPeak: f.offPeak.checked,
        startAt: f.startAt.value ? new Date(f.startAt.value).toISOString() : null });
      e.target.reset();
      syncEngineModels(e.target, 'queue-model-hint'); // the reset put the engine back; match its model list
      document.activeElement?.blur();
      toast('Added to the queue');
    } catch (err) { fail(err); }
  } },
  h('h3', {}, 'Add a job'),
  h('p', { class: 'pdesc' }, `${defaultEngine() === 'codex' ? 'Codex' : 'Claude'} works through these one at a time in the background, only while your ${q.limits.fiveHour != null ? `5-hour usage is under ${pct(q.limits.fiveHour)} and your week under` : 'week is under'} ${pct(q.limits.week)}, up to ${q.dailyCap} a day${defaultEngine() === 'codex' ? '. Codex jobs run sandboxed with no network; anything needing approval is declined' : `, in auto mode. Claude Code hard-blocks: ${q.blocked}. Everything else relies on auto mode and your CLAUDE.md rules`} — so ask for drafts and reports, not live changes.`),
  h('div', { class: 'grid2' },
    h('label', {}, 'Title', h('input', { name: 'title', required: true, placeholder: 'e.g. Margin check on spring offers' })),
    h('label', {}, 'Project', projectField('projectId')),
    h('label', {}, 'Folder', ...folderField('cwd')),
    engineField(null, 'queue-model-hint'),
    h('label', {}, 'Model', backgroundModelSelect('model', null, effectiveEngine(null)))),
  h('label', {}, `What should ${defaultEngine() === 'codex' ? 'Codex' : 'Claude'} do?`, h('textarea', { name: 'prompt', rows: 4, required: true, placeholder: 'Be specific about the output you want and where to save it. Start with /skill-name to use a skill.' })),
  h('p', { class: 'hint', id: 'queue-model-hint', hidden: effectiveEngine(null) === 'codex' }),
  h('label', { class: 'start-at' }, 'Start at (optional — leave empty to start as soon as allowed)', h('input', { type: 'datetime-local', name: 'startAt' })),
  h('label', { class: 'check-label' }, h('input', { type: 'checkbox', name: 'offPeak' }),
    ` Off-peak: wait for spare capacity (${q.limits.fiveHour != null ? 'just before your 5-hour window resets, or while it is under 20% used' : 'while your week is under 20% used or behind pace'})`),
  h('div', { class: 'dialog-actions' }, h('button', { class: 'primary', type: 'submit' }, 'Add to queue')));
  setTimeout(() => { if (form.elements.prompt) more.modelHint(form.elements.prompt, form.elements.model, form.querySelector('#queue-model-hint')); });

  const list = q.items.length ? h('div', { class: 'rows' }, q.items.map(j => h('div', { class: `row job ${j.status}` },
    h('span', { class: `body ${j.status === 'running' ? 'busy' : j.status === 'needs_you' ? 'needs' : j.status === 'failed' ? 'error' : j.status === 'done' ? 'soft' : 'closed'}` }),
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title' }, h('span', { class: 'name' }, j.role_id ? `${S.data.roles.find(r => r.id === j.role_id)?.name ?? 'Agent'}: ${j.title}` : j.title),
        h('span', { class: 'where' }, folder(j.cwd))),
      h('span', { class: `row-sub${j.status === 'failed' || j.status === 'needs_you' ? ' alert' : ''}` },
        j.result ? j.result.replace(/\s+/g, ' ').slice(0, 220) : j.prompt.replace(/\s+/g, ' ').slice(0, 160))),
    h('span', { class: 'row-meta' }, j.status === 'queued' && j.start_at && Date.parse(j.start_at) > Date.now()
      ? `Starts ${new Date(j.start_at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
      : [JOB_WORDS[j.status] ?? j.status, ' ', ago(sqlTime(j.finished_at ?? j.started_at ?? j.created_at))],
      h('span', { class: 'job-actions' },
        j.session_id && h('button', { class: 'ghost small', type: 'button', onclick: () => openChat(j.session_id) }, 'Open'),
        ['queued', 'running', 'needs_you'].includes(j.status) && h('button', { class: 'danger small', type: 'button', onclick: () => api('POST', `/api/queue/${j.id}/cancel`).catch(fail) }, 'Cancel'),
        ['failed', 'cancelled', 'done'].includes(j.status) && h('button', { class: 'ghost small', type: 'button', onclick: () => api('POST', `/api/queue/${j.id}/retry`).then(() => toast('Queued again')).catch(fail) }, 'Run again')))))) :
    h('div', { class: 'empty' }, h('p', {}, 'No jobs yet. Add one above.'));

  $('#view').replaceChildren(
    h('div', { class: 'status-strip' },
      h('strong', {}, q.enabled ? q.why : 'Queue paused'),
      h('span', {}, `${q.startedToday} of ${q.dailyCap} jobs started today`),
      h('button', { class: 'ghost small', type: 'button', onclick: () => api('POST', '/api/queue/toggle', { enabled: !q.enabled }).catch(fail) }, q.enabled ? 'Pause queue' : 'Resume queue')),
    form, h('section', { class: 'lane' }, h('div', { class: 'lane-head' }, h('h2', {}, 'Jobs')), list));
}

// ── role agents ──────────────────────────────────────────────────────────
/** Model picker for background work: Sonnet unless you choose otherwise. Codex: its own models. */
function backgroundModelSelect(name, value = null, engine = 'claude') {
  if (engine === 'codex') return h('select', { name }, codexModelOptions(value));
  const def = S.data.options.queueDefaultModel ?? 'sonnet';
  return h('select', { name }, h('option', { value: '' }, `${def[0].toUpperCase() + def.slice(1)} (default for background work)`),
    ['opus', 'sonnet', 'haiku', 'fable'].filter(m => m !== def).map(m => h('option', { value: m, selected: m === value }, m[0].toUpperCase() + m.slice(1))));
}

// ── engines: Claude (Claude Code) or Codex (ChatGPT) ─────────────────────
// A server without Codex support sends no `engines`, so every engine control stays hidden and nothing changes.
const codexOn = () => (S.data?.options.engines ?? []).includes('codex');
const codexInstalled = () => (S.data?.settings?.codexInstalled ?? S.data?.codexInstalled) !== false;
const defaultEngine = () => ((S.data?.settings?.defaultEngine ?? S.data?.defaultEngine) === 'codex' ? 'codex' : 'claude');
const isCodex = x => x?.engine === 'codex';
const codexModels = () => S.data?.options.codexModels ?? [];
/** "GPT-5.5" for a Codex model id; the default model's name when none was chosen. */
function codexModelName(id) {
  const list = codexModels();
  const m = list.find(x => x.id === id) ?? (id ? null : list.find(x => x.isDefault));
  return m?.name ?? id ?? '';
}
/** Codex models, the default first (value '' = Codex's own default). */
function codexModelOptions(value = '') {
  const list = codexModels();
  const def = list.find(m => m.isDefault);
  return [h('option', { value: '' }, def ? `${def.name} (default)` : 'Usual model'),
    ...list.filter(m => m !== def).map(m => h('option', { value: m.id, selected: m.id === value }, m.name))];
}
/** The thinking levels a Codex model offers (the default model's when none is picked). */
function codexEfforts(modelId) {
  const list = codexModels();
  return (list.find(m => m.id === modelId) ?? list.find(m => m.isDefault) ?? list[0])?.efforts ?? [];
}
/** Engine picker. With `followDefault`, a first option '' means "whatever the Default engine is when it runs". */
function engineSelect(name, value, onchange, { followDefault = false } = {}) {
  const v = value === 'codex' ? 'codex' : value === 'claude' || !followDefault ? 'claude' : '';
  const opt = (val, label, extra = {}) => h('option', { value: val, defaultSelected: v === val, selected: v === val, ...extra }, label);
  // defaultSelected, so a form reset lands back on this choice too.
  return h('select', { name, 'aria-label': 'Engine', title: 'Which AI does the work: Claude, or Codex (ChatGPT)', onchange },
    followDefault ? opt('', `Default (${defaultEngine() === 'codex' ? 'Codex' : 'Claude'})`) : null,
    opt('claude', 'Claude'),
    opt('codex', codexInstalled() ? 'Codex' : 'Codex (not installed)', { disabled: !codexInstalled() && v !== 'codex' }));
}
/** The small "GPT" tag on a Codex chat (board row and chat header); the tooltip names the model. */
function engineTag(s) {
  if (!isCodex(s)) return null;
  const model = codexModelName(s.model ?? '');
  return h('span', { class: 'engine-tag', title: model ? `Codex · ${model}` : 'Codex' }, 'GPT');
}
/** The engine a stored queue job / agent runs on: its own, or the Default engine when it has none (null). */
const effectiveEngine = stored => (!codexOn() ? 'claude' : stored === 'codex' || stored === 'claude' ? stored : defaultEngine());
/** Engine field for the Queue and Agent forms (value null = follow the Default engine); switching it swaps the model list. */
function engineField(value, hintId = null) {
  if (!codexOn()) return null;
  return h('label', {}, 'Engine', engineSelect('engine', value, e => syncEngineModels(e.target.form, hintId), { followDefault: true }));
}
/** Model list (and the Claude-only model hint) for the engine picked in a Queue/Agent form. */
function syncEngineModels(form, hintId = null) {
  if (!form?.elements.engine) return;
  const eng = effectiveEngine(form.elements.engine.value || null);
  form.elements.model.replaceChildren(...backgroundModelSelect('model', null, eng).children);
  form.elements.model.selectedIndex = 0; // moved options keep their old selection: start on the default
  const hint = hintId && form.querySelector(`#${hintId}`);
  if (hint) { hint.hidden = eng === 'codex'; if (eng === 'codex') hint.replaceChildren(); }
}
/** What to send as `engine`: nothing to an older server; null = follow the Default engine. */
const engineOf = f => (codexOn() && f.engine ? f.engine.value || null : undefined);

/** A datetime-local value (local time, no zone) for an ISO time; empty if none. */
const localInput = iso => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

/** When an agent runs: every N minutes or hours, once at a time, daily, weekdays, or chosen days — at a time. */
function scheduleFields(r = {}) {
  const kind = r.schedule_kind ?? 'interval';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const wrap = h('div', { class: 'schedule' });
  const draw = k => {
    wrap.replaceChildren(...[
      h('label', {}, 'Runs', h('select', { name: 'scheduleKind', onchange: e => draw(e.target.value) },
        [['minutes', 'Every few minutes'], ['interval', 'Every few hours'], ['once', 'Once'], ['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'On chosen days']]
          .map(([v, l]) => h('option', { value: v, selected: v === k }, l)))),
      k === 'minutes' ? h('label', {}, 'Every (minutes)', h('input', { name: 'everyMinutes', type: 'number', min: 5, max: 1440, value: r.every_minutes ?? 30 }))
        : k === 'interval' ? h('label', {}, 'Every (hours)', h('input', { name: 'everyHours', type: 'number', min: 1, max: 720, value: r.every_hours ?? 24 }))
        : k === 'once' ? h('label', {}, 'On', h('input', { name: 'runAt', type: 'datetime-local', required: true, value: localInput(r.run_at) }))
        : h('label', {}, 'At', h('input', { name: 'scheduleTime', type: 'time', value: r.schedule_time ?? '08:00' })),
      // Short intervals meet the queue's safety limit: say so rather than let the agent stop without a word.
      k === 'minutes' ? h('p', { class: 'hint' }, `The queue starts at most ${S.data.options.dailyJobCap ?? 10} jobs a day in total, so an agent this frequent stops for the day after that many runs (sooner if other jobs run). It also waits while your usage is high.`) : null,
      k === 'weekly' ? h('div', { class: 'days' }, days.map((d, i) => h('label', { class: 'day' },
        h('input', { type: 'checkbox', name: `day${i}`, checked: !!((r.schedule_days ?? 0) & (1 << i)) }), d))) : null,
    ].filter(Boolean));
  };
  draw(kind);
  return wrap;
}

function scheduleValues(f) {
  let mask = 0;
  for (let i = 0; i < 7; i++) if (f[`day${i}`]?.checked) mask |= 1 << i;
  return { scheduleKind: f.scheduleKind.value, everyHours: f.everyHours?.value ?? 24, everyMinutes: f.everyMinutes?.value ?? 30,
    runAt: f.runAt?.value ? new Date(f.runAt.value).toISOString() : null, scheduleTime: f.scheduleTime?.value ?? '08:00', scheduleDays: mask };
}

function skillSelect(name, value = null) {
  const sel = h('select', { name }, h('option', { value: '' }, 'No skill — just the goal'), value ? h('option', { value, selected: true }, `/${value}`) : null);
  more.skills().then(list => {
    sel.replaceChildren(h('option', { value: '' }, 'No skill — just the goal'),
      ...list.map(s => h('option', { value: s.name, selected: s.name === value, title: s.description }, `/${s.name}`)));
  }).catch(() => {});
  return sel;
}

function renderAgents() {
  const roles = S.data.roles;
  const card = r => h('form', { class: 'proj pw-form', onsubmit: async e => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      await api('PATCH', `/api/roles/${r.id}`, { name: f.name.value, goal: f.goal.value, instructions: f.instructions.value, cwd: f.cwd.value,
        projectId: f.projectId.value || null, skill: f.skill.value, model: f.model.value, engine: engineOf(f), ...scheduleValues(f) });
      document.activeElement?.blur();
      toast('Agent saved');
    } catch (err) { fail(err); }
  } },
  h('div', { class: 'agent-head' },
    h('input', { name: 'name', value: r.name, class: 'agent-name', 'aria-label': 'Agent name' }),
    h('button', { class: r.enabled ? 'primary small' : 'ghost small', type: 'button', 'aria-pressed': String(!!r.enabled),
      onclick: () => api('PATCH', `/api/roles/${r.id}`, { enabled: !r.enabled }).then(() => toast(r.enabled ? 'Agent switched off' : 'Agent switched on')).catch(fail) }, r.enabled ? 'On' : 'Off')),
  h('label', {}, 'Goal', h('textarea', { name: 'goal', rows: 3, value: r.goal })),
  h('label', {}, 'Standing instructions', h('textarea', { name: 'instructions', rows: 3, value: r.instructions })),
  scheduleFields(r),
  h('div', { class: 'grid2' },
    h('label', {}, 'Skill', skillSelect('skill', r.skill)),
    engineField(r.engine ?? null),
    h('label', {}, 'Model', backgroundModelSelect('model', r.model, effectiveEngine(r.engine ?? null))),
    h('label', {}, 'Project', projectField('projectId', r.project_id)),
    h('label', {}, 'Folder', ...folderField('cwd', r.cwd))),
  h('div', { class: 'proj-foot' },
    h('span', {}, `${r.scheduleText}. `, r.enabled && r.nextRun ? `Next ${new Date(r.nextRun).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}. ` : '',
      r.last_run_at ? `Last run ${ago(r.last_run_at)}` : 'Not run yet'),
    h('span', {},
      h('button', { class: 'ghost small', type: 'button', onclick: () => api('POST', `/api/roles/${r.id}/run`).then(() => toast('Queued a run')).catch(fail) }, 'Run now'), ' ',
      h('button', { class: 'ghost small', type: 'submit' }, 'Save'), ' ',
      h('button', { class: 'danger small', type: 'button', onclick: e => {
        if (e.currentTarget.dataset.confirm !== '1') { e.currentTarget.dataset.confirm = '1'; e.currentTarget.textContent = 'Confirm delete'; return; }
        api('DELETE', `/api/roles/${r.id}`).catch(fail);
      } }, 'Delete'))));

  const add = h('form', { class: 'proj pw-form', onsubmit: async e => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      await api('POST', '/api/roles', { name: f.name.value, goal: f.goal.value, instructions: f.instructions.value, cwd: f.cwd.value,
        projectId: f.projectId.value || null, skill: f.skill.value, model: f.model.value, engine: engineOf(f), ...scheduleValues(f) });
      e.target.reset();
      syncEngineModels(e.target);
      document.activeElement?.blur();
      toast('Agent added — switch it on when you are ready');
    } catch (err) { fail(err); }
  } },
  h('h3', {}, 'Add an agent or scheduled Claude job'),
  h('p', { class: 'pdesc' }, 'Runs a goal — or one of your skills — on a timetable through the queue, with the same usage limits and safety blocks. New ones start switched off. For scripts that aren’t Claude (Python reports, the DB refresh) use Scheduled jobs → Set up a new scheduled script.'),
  h('label', {}, 'Name', h('input', { name: 'name', required: true, placeholder: 'e.g. Monday ads scan' })),
  h('label', {}, 'Goal', h('textarea', { name: 'goal', rows: 3, required: true, placeholder: 'e.g. Check last week’s Google Ads spend for wasted search terms and draft a short report in analysis/.' })),
  h('label', {}, 'Standing instructions', h('textarea', { name: 'instructions', rows: 2, placeholder: 'Optional: rules it should always follow' })),
  scheduleFields(),
  h('div', { class: 'grid2' },
    h('label', {}, 'Skill', skillSelect('skill')),
    engineField(null),
    h('label', {}, 'Model', backgroundModelSelect('model', null, effectiveEngine(null))),
    h('label', {}, 'Project', projectField('projectId')),
    h('label', {}, 'Folder', ...folderField('cwd'))),
  h('div', { class: 'proj-foot' }, h('span'), h('button', { class: 'primary', type: 'submit' }, 'Add agent')));

  $('#view').replaceChildren(h('div', { class: 'proj-grid agents' }, ...roles.map(card), add));
}

// ── scheduled jobs ───────────────────────────────────────────────────────
async function renderJobs(fresh = false) {
  const view = $('#view');
  if (!S.jobs || fresh) {
    view.replaceChildren(more.roundupPanel(), h('div', { class: 'empty' }, h('p', {}, 'Reading Windows Task Scheduler…')));
    try { S.jobs = (await api('POST', '/api/jobs', { fresh })).jobs; } catch (e) { view.replaceChildren(h('div', { class: 'empty' }, h('p', {}, e.message))); return; }
    if (S.view !== 'jobs') return;
  }
  const when = iso => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const act = async (job, action, btn) => {
    if (action === 'run' && btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = 'Confirm: run it now'; return; }
    btn.disabled = true;
    try {
      S.jobs = (await api('POST', '/api/jobs/act', { id: job.id, action })).jobs;
      toast(action === 'run' ? `Started ${job.name}` : action === 'enable' ? `Switched on ${job.name}` : `Switched off ${job.name}`);
      renderJobs();
    } catch (e) { fail(e); btn.disabled = false; }
  };
  view.replaceChildren(
    more.roundupPanel(),
    h('div', { class: 'status-strip' }, h('strong', {}, `${S.jobs.length} scheduled job${S.jobs.length === 1 ? '' : 's'}`),
      h('span', {}, 'Your Windows scheduled tasks that run Claude or something in Documents\\GitHub.'),
      h('button', { class: 'ghost small', type: 'button', title: 'Opens a chat where Claude sets up, test-runs and registers a new Windows scheduled task with you',
        onclick: async e => {
          e.currentTarget.disabled = true;
          try { const { id } = await api('POST', '/api/jobs/setup', {}); toast('Opening a chat to set it up'); setTimeout(() => openChat(id), 400); }
          catch (err) { fail(err); e.currentTarget.disabled = false; }
        } }, 'Set up a new scheduled script'),
      h('button', { class: 'ghost small', type: 'button', onclick: () => renderJobs(true) }, 'Refresh')),
    h('div', { class: 'rows' }, S.jobs.map(j => h('div', { class: 'row job' },
      h('span', { class: `body ${!j.enabled ? 'closed' : j.running ? 'busy' : j.ok || j.neverRun ? '' : 'needs'}` }),
      h('span', { class: 'row-main' },
        h('span', { class: 'row-title' }, h('span', { class: 'name' }, j.name), h('span', { class: 'where' }, j.enabled ? j.schedule : 'Switched off')),
        h('span', { class: `row-sub${!j.ok && !j.neverRun && j.enabled ? ' alert' : ''}` },
          j.neverRun ? 'Never run' : `Last run ${when(j.lastRun)}: ${j.lastResult}`, j.enabled && j.nextRun ? ` · next ${when(j.nextRun)}` : ''),
        h('span', { class: 'row-sub mono' }, j.action)),
      h('span', { class: 'row-meta job-actions' },
        h('button', { class: 'ghost small', type: 'button', disabled: j.running, onclick: e => act(j, 'run', e.currentTarget) }, j.running ? 'Running…' : 'Run now'),
        h('button', { class: 'ghost small', type: 'button', onclick: e => act(j, j.enabled ? 'disable' : 'enable', e.currentTarget) }, j.enabled ? 'Switch off' : 'Switch on'))))));
}

// ── chat ─────────────────────────────────────────────────────────────────
const session = () => S.data?.sessions.find(s => s.id === S.selected) ?? null;

async function openChat(id) {
  if (S.selected && S.selected !== id) saveDraft();
  S.selected = id;
  S.chat = { items: [], live: [], run: null, partial: '', truncated: false, loading: true };
  reportViewing();
  const pane = $('#chat');
  pane.hidden = false;
  $('#splitter').hidden = false;
  pane.replaceChildren(
    h('div', { class: 'chat-head', id: 'chat-head' }),
    h('div', { class: 'stream', id: 'stream' }, h('div', { class: 'more' }, 'Loading conversation…')),
    h('div', { class: 'asks', id: 'asks' }),
    h('div', { class: 'tasks', id: 'tasks', hidden: true }),
    h('div', { class: 'working', id: 'working', hidden: true }),
    h('div', { class: 'agent-strip', id: 'agent-strip', hidden: true }),
    h('div', { id: 'banner' }),
    h('div', { class: 'thumbs', id: 'thumbs' }),
    h('form', { class: 'composer', id: 'composer', onsubmit: sendMessage },
      h('button', { class: 'icon-btn attach', type: 'button', id: 'attach', 'aria-label': 'Attach images or files', title: 'Attach images or files (or paste / drop them)',
        onclick: () => $('#file-pick').click() }, attachIcon()),
      h('input', { type: 'file', id: 'file-pick', multiple: true, hidden: true,
        onchange: e => { addFiles(S.selected, [...e.target.files]); e.target.value = ''; } }),
      h('textarea', { id: 'input', rows: 1, placeholder: 'Message Claude', 'aria-label': 'Message', onkeydown: onComposerKey, oninput: autoGrow,
        onpaste: e => {
          const files = [...(e.clipboardData?.files ?? [])].filter(f => f.type.startsWith('image/'));
          if (files.length) { e.preventDefault(); addImages(S.selected, files); }
        } }),
      h('span', { id: 'mic-slot' }),
      h('button', { class: 'primary', type: 'submit', id: 'send' }, 'Send')),
    h('div', { class: 'composer-hint' }, 'Enter to send, Shift+Enter for a new line. Type / for commands. Paste, drop or attach images. Ctrl+K to jump anywhere.'),
  );
  more.slashMenu($('#input'), () => session()?.cwd, { extra: [{ name: 'workflows', description: 'Show this chat’s workflow progress (Pit Wall’s own — the terminal one doesn’t work here)', kind: 'command' }] });
  renderThumbs();
  const mic = more.voiceButton($('#input'));
  if (mic) $('#mic-slot').replaceWith(mic);
  $('#input').value = S.drafts.get(id) ?? '';
  autoGrow({ target: $('#input') });
  renderChatHead();
  if (S.view === 'board') renderBoard();
  try {
    const h0 = await api('GET', `/api/sessions/${id}/history`);
    if (S.selected !== id) return;
    Object.assign(S.chat, { items: h0.items, live: h0.live, run: h0.run, turn: h0.run?.turn ?? null, partial: h0.run?.partial ?? '', truncated: h0.truncated, loading: false });
    renderStream(true);
    renderAsks();
    renderChatHead();
  } catch (e) { fail(e); }
  $('#input').focus();
}

async function loadEarlier() {
  const id = S.selected;
  S.chat.limit = Math.min((S.chat.limit ?? 400) + 400, 5000);
  try {
    const h0 = await api('GET', `/api/sessions/${id}/history?limit=${S.chat.limit}`);
    if (S.selected !== id) return;
    const st = $('#stream');
    const fromBottom = st.scrollHeight - st.scrollTop;
    Object.assign(S.chat, { items: h0.items, truncated: h0.truncated });
    renderStream();
    st.scrollTop = st.scrollHeight - fromBottom; // keep your place
  } catch (e) { fail(e); }
}

function closeChat() {
  saveDraft();
  S.selected = null;
  S.chat = null;
  $('#chat').hidden = true;
  $('#splitter').hidden = true;
  setChatWide(false);
  reportViewing();
  if (S.view === 'board') renderBoard();
}

// ── chat width: drag the splitter (remembered on this PC) or expand to the full width ──
const CHAT_W_KEY = 'pitwall-chat-width';
const chatWide = () => $('#layout').classList.contains('chat-wide');
function setChatWide(on) { $('#layout').classList.toggle('chat-wide', on); }
function applyChatWidth(px) {
  const max = Math.max(440, window.innerWidth - 420); // always leave the board room to be usable
  const w = Math.round(Math.min(Math.max(px, 440), max));
  $('#layout').style.setProperty('--chat-w', `${w}px`);
  return w;
}
(() => {
  let saved = null;
  try { saved = Number(localStorage.getItem(CHAT_W_KEY)) || null; } catch { /* storage blocked */ }
  if (saved) applyChatWidth(saved);
  const sp = $('#splitter');
  const save = w => { try { localStorage.setItem(CHAT_W_KEY, String(w)); } catch { /* storage blocked */ } };
  sp.addEventListener('pointerdown', e => {
    e.preventDefault();
    sp.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const move = ev => applyChatWidth(window.innerWidth - ev.clientX);
    const up = ev => {
      save(applyChatWidth(window.innerWidth - ev.clientX));
      document.body.classList.remove('resizing');
      sp.removeEventListener('pointermove', move);
      sp.removeEventListener('pointerup', up);
    };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up);
  });
  // Keyboard: arrows resize, double-click resets.
  sp.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const cur = $('#chat').getBoundingClientRect().width;
    save(applyChatWidth(cur + (e.key === 'ArrowLeft' ? 40 : -40)));
  });
  sp.addEventListener('dblclick', () => { $('#layout').style.removeProperty('--chat-w'); try { localStorage.removeItem(CHAT_W_KEY); } catch { /* */ } });
})();

const JOB_WORDS_BG = { local_agent: 'agent', local_workflow: 'workflow', local_bash: 'command' };

/** ", running in the background: Review task 2 (agent), probe (workflow) +1 more" for the chat header. */
function jobsText(run) {
  const jobs = run?.jobs ?? [];
  if (!jobs.length) return '';
  const names = jobs.slice(0, 3).map(j => `${j.description || 'job'}${JOB_WORDS_BG[j.type] ? ` (${JOB_WORDS_BG[j.type]})` : ''}`);
  return `, running in the background: ${names.join(', ')}${jobs.length > 3 ? ` +${jobs.length - 3} more` : ''}`;
}

/** Ending a session ends its agents and workflows too — ask twice before doing that. */
function confirmKill(action, id) {
  // A terminal's own process is never ended from here, so its agents carry on.
  const row = S.data.sessions.find(x => x.id === id);
  const n = row?.source === 'terminal' ? 0 : row?.jobs ?? 0;
  const key = `${action}:${id}`;
  if (!n || S.killConfirm === key) { S.killConfirm = null; return true; }
  S.killConfirm = key;
  toast(`${n === 1 ? 'A job is' : `${n} jobs are`} still running in this chat (agents or commands) and would be stopped. Press again to go ahead.`, true);
  return false;
}

async function finishChat(id, name) {
  if (!confirmKill('finish', id)) return;
  try {
    await api('POST', `/api/sessions/${id}/finish`);
    if (S.selected === id) closeChat();
    toast(`Finished “${name}” — it’s under Closed if you need it again`);
  } catch (e) { fail(e); }
}

function saveDraft() {
  const input = $('#input');
  if (S.selected && input) S.drafts.set(S.selected, input.value);
}

function renderChatHead() {
  const s = session();
  const head = $('#chat-head');
  if (!head) return;
  const run = S.chat?.run;
  const name = s?.name ?? run?.name ?? 'Session';
  const d = S.data;
  // A Codex chat: no model and permission switchers; Fork / Rewind / btw only once its live bridge can branch.
  const codex = isCodex(s ?? run);
  $('#chat')?.classList.toggle('engine-codex', codex);
  const branch = branchState(s ?? run, run);
  $('#chat')?.classList.toggle('codex-nobranch', branch === 'codex-nobranch');
  const running = !!run?.running;
  const busy = run?.status === 'busy' || run?.status === 'starting' || run?.status === 'needs_you';
  const existingInput = head.querySelector('input');
  const keepName = existingInput && document.activeElement === existingInput;

  const projectSel = h('select', { 'aria-label': 'Project', onchange: e => api('PATCH', `/api/sessions/${S.selected}`, { projectId: e.target.value || null }).catch(fail) },
    h('option', { value: '' }, 'Not filed'),
    d.projects.filter(p => !p.archived || p.id === s?.projectId).map(p => h('option', { value: p.id, selected: p.id === s?.projectId }, p.name)));
  const modelSel = h('select', { 'aria-label': 'Model', title: 'Switches straight away (from the next message if Claude isn’t running)', onchange: e => api('PATCH', `/api/sessions/${S.selected}`, { model: e.target.value }).catch(fail) },
    d.options.models.map(m => h('option', { value: m, selected: m === (s?.model ?? '') }, m ? m[0].toUpperCase() + m.slice(1) : 'Usual model')));
  const modeSel = h('select', { 'aria-label': 'Permissions', title: 'Switches straight away (from the next message if Claude isn’t running)', onchange: e => api('PATCH', `/api/sessions/${S.selected}`, { permissionMode: e.target.value }).catch(fail) },
    h('option', { value: '' }, 'Auto (default)'),
    d.options.permissionModes.filter(m => m !== 'auto').map(m => h('option', { value: m, selected: m === s?.permissionMode },
      { manual: 'Ask before acting', acceptEdits: 'Accept edits', auto: 'Auto', plan: 'Plan only' }[m] ?? m)));
  const effortSel = effortSelect(s?.effort ?? '', e => api('PATCH', `/api/sessions/${S.selected}`, { effort: e.target.value }).catch(fail));

  // Don't redraw the header under you while you're using its More menu.
  const oldMenu = head.querySelector('details.menu');
  const menuBusy = oldMenu?.open && oldMenu.contains(document.activeElement);
  if (!menuBusy) head.replaceChildren(
    h('div', { class: 'chat-title' },
      // Phones only: the chat covers the screen there, so give it an obvious way back.
      h('button', { class: 'chat-back', type: 'button', 'aria-label': 'Back to the board', onclick: closeChat }, '‹ Back'),
      h('span', { class: `body ${s ? bodyClass(s) : ''}` }),
      keepName ? existingInput : h('input', { value: name, 'aria-label': 'Session name', onchange: e => api('PATCH', `/api/sessions/${S.selected}`, { displayName: e.target.value }).catch(fail) }),
      codex ? engineTag({ engine: 'codex', model: s?.model ?? run?.model ?? '' }) : null,
      h('button', { class: 'icon-btn wide-btn', type: 'button', 'aria-pressed': String(chatWide()), title: chatWide() ? 'Show the board again' : 'Give the chat the whole width',
        'aria-label': chatWide() ? 'Shrink chat' : 'Expand chat', onclick: () => { setChatWide(!chatWide()); renderChatHead(); } }, chatWide() ? '⇥' : '⇤'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close chat', onclick: closeChat }, '×')),
    h('div', { class: 'chat-controls' },
      projectSel,
      h('span', { class: 'chat-status' }, s ? `${statusWord(s)}${s.cwd ? ' in ' + folder(s.cwd) : ''}` : '',
        jobsText(run)),
      s ? more.contextBadge(s, { onlyWhenHigh: true }) : null,
      h('span', { class: 'spacer' }),
      s && s.source !== 'terminal' && branch !== 'codex-nobranch' && h('button', { class: 'ghost small', type: 'button', title: 'Side questions: ask about this chat without adding to it (' + (codex ? 'works between replies, not while Codex is answering' : 'works while Claude is busy') + ')',
        onclick: () => extras.toggleBtw() }, 'btw'),
      busy && h('button', { class: 'ghost small', type: 'button', onclick: () => api('POST', `/api/sessions/${S.selected}/interrupt`).catch(fail) }, 'Stop reply'),
      s && !s.done && !busy && h('button', { class: 'ghost small', type: 'button',
        title: s.source === 'terminal' ? 'Takes it off the board. The terminal window stays open — close it yourself.' : 'You’re done with this chat: ends it and files it under Closed. Sending it a message reopens it.',
        onclick: () => finishChat(S.selected, name) }, 'Finish'),
      h('details', { class: 'menu', open: !!oldMenu?.open },
        h('summary', { class: 'ghost small' }, 'More'),
        h('div', { class: 'menu-list wide' },
          codex ? null : h('label', { class: 'menu-field' }, 'Model', modelSel),
          codex ? null : h('label', { class: 'menu-field' }, 'Effort', effortSel),
          codex ? null : h('label', { class: 'menu-field' }, 'Permissions', modeSel),
          s && h('label', { class: 'menu-field' }, 'Remind me', more.remindMenu(S.selected, name)),
          s && extras.colorRow(s),
          h('hr'),
          s && s.source !== 'terminal' && branch !== 'codex-nobranch' && h('button', { type: 'button', title: 'A new chat that carries on from the latest finished reply; this one stays as it is',
            onclick: () => extras.forkDialog(extras.lastForkable()) }, 'Fork…'),
          s && s.source !== 'terminal' && !busy && h('button', { type: 'button',
            title: 'Asks this session for a handoff, then continues in a new, short session seeded with it — every turn after that costs far less',
            onclick: e => { e.stopPropagation(); freshStart(e.currentTarget); } }, 'Fresh start'),
          s && s.source !== 'terminal' && !busy && h('button', { type: 'button', title: 'Runs your /handoff skill: a paste-ready prompt for the other PC or a teammate’s Claude',
            onclick: () => api('POST', `/api/sessions/${S.selected}/handoff`).then(() => toast('Writing a handoff…')).catch(fail) }, 'Write a handoff'),
          s?.needsYou && h('button', { type: 'button', onclick: () => api('POST', `/api/sessions/${S.selected}/snooze`, { minutes: 60 }).then(() => toast('Snoozed for an hour')).catch(fail) }, 'Snooze for an hour'),
          s?.snoozedUntil && h('button', { type: 'button', onclick: () => api('POST', `/api/sessions/${S.selected}/snooze`, { clear: true }).catch(fail) }, 'Unsnooze'),
          running && h('button', { class: 'danger-text', type: 'button', title: 'Ends the Claude process; send a message to pick it back up.', onclick: () => { if (confirmKill('stop', S.selected)) api('POST', `/api/sessions/${S.selected}/stop`).catch(fail); } }, 'End session')))),
  );

  const banner = $('#banner');
  const input = $('#input'), sendBtn = $('#send');
  banner.replaceChildren();
  const inTerminal = s?.source === 'terminal' && !running;
  if (inTerminal) banner.append(h('div', { class: 'banner warn' },
    `This session is open in terminal ${s.terminalName ?? ''}. Type /exit there and it carries on here with the full history — or move it here now.`,
    h('div', { class: 'banner-actions' },
      h('button', { class: 'ghost', type: 'button', disabled: s.status !== 'idle',
        title: s.status === 'idle' ? 'Ends Claude in that terminal window, then continues the conversation here'
          : s.status === 'agents_working' ? 'Its agents are still working — moving it now would stop them' : 'Only while the terminal is idle',
        onclick: e => moveHere(e.currentTarget) }, 'Move here'))));
  else if (s?.needsYou?.interrupted && !running) banner.append(h('div', { class: 'banner warn' },
    'Pit Wall restarted while this session was working, so its last step was cut off — and any agents or workflow it was running were stopped. Continue may start them again.',
    h('div', { class: 'banner-actions' },
      h('button', { class: 'primary', type: 'button', onclick: () => api('POST', `/api/sessions/${S.selected}/continue`).then(() => toast('Continuing')).catch(fail) }, 'Continue'),
      h('button', { class: 'ghost', type: 'button', onclick: () => api('POST', `/api/sessions/${S.selected}/dismiss`).catch(fail) }, 'Dismiss'))));
  else if (s && more.isCold(s) && !S.coldAck?.has(s.id)) banner.append(h('div', { class: 'banner warn' },
    `This session has been idle for a while and is big (${more.fmtK(s.context)} tokens). Claude's cache has expired, so your next message makes it re-read all of it. A Fresh start costs that one read too (to write the handoff), but every turn after it runs in a short session — worth it if you'll keep going more than a couple of turns.`,
    h('div', { class: 'banner-actions' },
      h('button', { class: 'primary', type: 'button', onclick: e => freshStart(e.currentTarget) }, 'Fresh start'),
      h('button', { class: 'ghost', type: 'button', onclick: () => { (S.coldAck ??= new Set()).add(s.id); renderChatHead(); } }, 'Carry on anyway'))));
  else if (s?.done) banner.append(h('div', { class: 'banner' }, 'You finished this chat. Send a message to reopen it, or put it back on the board.',
    h('div', { class: 'banner-actions' },
      h('button', { class: 'ghost small', type: 'button', onclick: () => api('POST', `/api/sessions/${S.selected}/reopen`).then(() => toast('Back on the board')).catch(fail) }, 'Reopen'))));
  else if (run?.error) banner.append(h('div', { class: 'banner err' }, run.error));
  else if (s?.source === 'closed' && !run) banner.append(h('div', { class: 'banner' }, 'This session is closed. Send a message to pick it back up here.'));
  if (input) { input.disabled = inTerminal; sendBtn.disabled = inTerminal; input.placeholder = inTerminal ? 'Close the terminal first' : codex ? 'Message Codex' : 'Message Claude'; }
}

function effortSelect(value, onchange) {
  const d = S.data.options;
  return h('select', { 'aria-label': 'Effort', title: 'How hard Claude thinks — takes effect from the next message', onchange },
    h('option', { value: '' }, `Effort: ${d.defaultEffort} (default)`),
    d.efforts.filter(x => x !== d.defaultEffort).map(x => h('option', { value: x, selected: x === value }, `Effort: ${x}`)));
}

async function freshStart(btn) {
  if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = 'Confirm: write handoff & start fresh'; return; }
  btn.disabled = true;
  try {
    await api('POST', `/api/sessions/${S.selected}/fresh-start`);
    toast('Writing the handoff… the fresh session opens when it is ready');
  } catch (e) { fail(e); btn.disabled = false; }
}

async function moveHere(btn) {
  if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = 'Confirm: close it in the terminal'; return; }
  btn.disabled = true;
  try {
    await api('POST', `/api/sessions/${S.selected}/take-over`);
    toast('Moved here — carry on below');
  } catch (e) { fail(e); btn.disabled = false; }
}

// A readable before/after for file edits instead of raw JSON.
function diffView(name, input = {}) {
  const lines = (text, cls, sign) => String(text ?? '').split('\n').map(l => h('div', { class: `dl ${cls}` }, `${sign} ${l}`));
  const block = (oldS, newS) => h('div', { class: 'diff' }, ...lines(oldS, 'del', '−'), ...lines(newS, 'add', '+'));
  if (name === 'Edit') return h('div', {}, h('div', { class: 'dpath' }, input.file_path ?? ''), block(input.old_string, input.new_string));
  if (name === 'MultiEdit') return h('div', {}, h('div', { class: 'dpath' }, input.file_path ?? ''), ...(input.edits ?? []).map(e => block(e.old_string, e.new_string)));
  if (name === 'Write') {
    const text = String(input.content ?? '');
    return h('div', {}, h('div', { class: 'dpath' }, `${input.file_path ?? ''} (new contents)`),
      h('div', { class: 'diff' }, ...lines(text.length > 20_000 ? text.slice(0, 20_000) + '\n…' : text, 'add', '+')));
  }
  return null;
}

// Tool results attach to the tool call that produced them; subagent steps nest inside their Task/Agent call.
function toolEl(item) {
  if (item.name === 'Agent' || item.name === 'Task') return agentEl(item);
  const diff = diffView(item.name, item.input);
  const d = h('details', { class: 'tool', 'data-id': item.id },
    h('summary', {}, h('span', { class: 'tname' }, item.name), h('span', { class: 'tsum' }, item.summary), h('span', { class: 'tsteps' })),
    h('div', { class: 'wf', hidden: true }),
    diff ?? (item.name === 'Workflow'
      ? h('details', { class: 'wf-script' }, h('summary', {}, 'Show script'), h('pre', {}, item.input?.script ? String(item.input.script) : JSON.stringify(item.input ?? {}, null, 2)))
      : h('pre', {}, JSON.stringify(item.input ?? {}, null, 2))),
    h('ol', { class: 'subs', hidden: true }),
    h('div', { class: 'report', hidden: true }));
  d.input = item.input;
  return d;
}
const toolFor = (container, id) => [...container.querySelectorAll('.tool')].reverse().find(t => t.dataset.id === id);

// ── subagents ────────────────────────────────────────────────────────────
// An Agent call shows who it is, whether it's still going and what it's doing now; steps, report and prompt open below.
const AGENT_RECENT = 5;
function agentEl(item) {
  const inp = item.input ?? {};
  const d = h('details', { class: 'tool agent', 'data-id': item.id },
    h('summary', {},
      h('span', { class: 'agent-dot' }),
      h('span', { class: 'tname' }, 'Agent'),
      h('span', { class: 'tsum' }, inp.description || item.summary),
      h('span', { class: 'agent-who' }, [inp.subagent_type, inp.model].filter(Boolean).join(' · ')),
      h('span', { class: 'tsteps agent-state' })),
    h('div', { class: 'report', hidden: true }),
    h('ol', { class: 'subs recent', hidden: true }),
    h('button', { class: 'link agent-all', type: 'button', hidden: true, onclick: e => {
      const list = d.querySelector('.subs');
      list.classList.toggle('recent');
      e.target.textContent = list.classList.contains('recent') ? `Show all ${list.children.length} steps` : 'Show only the latest steps';
    } }),
    inp.prompt ? h('details', { class: 'agent-prompt' }, h('summary', {}, 'Prompt'), h('pre', {}, String(inp.prompt))) : null);
  d.agent = { start: Date.parse(item.ts) || Date.now(), steps: 0, last: null, lastAt: 0, end: null, failed: false, background: !!inp.run_in_background };
  renderAgent(d);
  return d;
}

/** Is the open chat still doing something (a reply, or agents it launched)? */
function chatBusy() {
  const s = S.data?.sessions.find(x => x.id === S.selected);
  return !!s && (['busy', 'starting', 'agents_working'].includes(s.status) || s.jobs > 0);
}

/** "Bash php artisan test", short: long paths keep their last two parts. */
function stepLabel(tool, summary = '') {
  const s = String(summary ?? '').replace(/(?:[A-Za-z]:)?[\\/][^\s'"]*[\\/]([^\\/\s'"]+[\\/][^\\/\s'"]+)/g, '…/$1');
  return `${tool} ${s}`.trim().replace(/\s+/g, ' ').slice(0, 60);
}

function since(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 1 ? 'under a minute' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function agentRunning(d) { return !!d.agent && !d.agent.end && chatBusy(); }

function renderAgent(d) {
  const a = d.agent;
  const running = agentRunning(d);
  d.classList.toggle('running', running);
  const steps = `${a.steps} step${a.steps === 1 ? '' : 's'}`;
  d.querySelector('.agent-state').textContent = ' ' + (running
    ? [`running ${since(Date.now() - a.start)}`, steps, a.last ? `now: ${a.last}` : null]
    : a.end ? [a.failed ? 'failed' : `finished in ${since(a.end - a.start)}`, steps]
      : [steps]).filter(Boolean).join(' · ');
  const list = d.querySelector('.subs');
  const more = d.querySelector('.agent-all');
  more.hidden = list.children.length <= AGENT_RECENT;
  if (!more.hidden && list.classList.contains('recent')) more.textContent = `Show all ${list.children.length} steps`;
}

/** The "agents working" strip above the composer, and the note under a message Claude will read later. */
function renderAgentStrip() {
  const strip = $('#agent-strip');
  const st = $('#stream');
  if (!strip || !st) return;
  st.querySelectorAll('.tool.agent').forEach(renderAgent);
  const running = [...st.querySelectorAll('.tool.agent.running')];
  const waiting = running.some(d => !d.agent.background && [...st.querySelectorAll('.msg.user')].some(m => d.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING));
  strip.hidden = !running.length;
  strip.replaceChildren(
    h('span', { class: 'agent-dot' }),
    h('span', { class: 'agent-count' }, `${running.length} agent${running.length === 1 ? '' : 's'} working`),
    h('ul', {}, running.map(d => h('li', {}, h('button', { class: 'link', type: 'button', title: 'Show it in the chat',
      onclick: () => { d.open = true; d.scrollIntoView({ block: 'center', behavior: 'smooth' }); } },
      h('strong', {}, d.querySelector('.tsum').textContent), ` · ${since(Date.now() - d.agent.start)}`, d.agent.last ? h('span', { class: 'agent-now' }, ` · ${d.agent.last}`) : null)))),
    ...(waiting ? [h('span', { class: 'agent-wait' }, 'Claude reads your message when the agent finishes.')] : []));
}
setInterval(() => { if (S.chat) renderAgentStrip(); }, 15_000);

const WF_STATUS = { running: 'running', completed: 'finished', failed: 'failed', stopped: 'stopped', unknown: '' };
const fmtDur = ms => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
};
const fmtTok = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const modelName = m => (m ? (m.match(/opus|sonnet|haiku|fable/i)?.[0] ?? m).replace(/^./, c => c.toUpperCase()) : '');
const QUIET_MS = 3 * 60_000;
const STATE_ORDER = { running: 0, failed: 1, queued: 2, done: 3 };

/** description and per-phase notes from the script's `export const meta = {…}` (a running workflow has no finished record yet). */
function scriptMeta(script) {
  const s = String(script ?? '');
  const description = s.match(/description:\s*(['"`])([\s\S]*?)\1/)?.[2] ?? null;
  const phaseDetails = {};
  for (const m of s.matchAll(/\{\s*title:\s*(['"`])(.*?)\1\s*,\s*detail:\s*(['"`])(.*?)\3/g)) phaseDetails[m[2]] = m[4];
  return { description, phaseDetails };
}

/** One line of facts about an agent: model · time · tools · tokens · what it is doing (or how long it has been quiet). */
function agentFacts(a, now = Date.now()) {
  const ran = a.durationMs ?? (a.startedAt ? (a.state === 'running' ? now : a.lastAt ?? now) - a.startedAt : null);
  const quiet = a.state === 'running' && a.lastAt && now - a.lastAt > QUIET_MS;
  return [modelName(a.model), ran != null && a.state !== 'queued' ? fmtDur(ran) : '', a.tools ? `${a.tools} tool${a.tools === 1 ? '' : 's'}` : '',
    a.tokens ? `${fmtTok(a.tokens)} tokens` : '', a.attempt > 1 ? `attempt ${a.attempt}` : '',
    quiet ? `quiet ${since(now - a.lastAt)}` : a.state === 'running' && a.lastTool ? `now: ${a.lastTool}` : ''].filter(Boolean);
}

/** A workflow's summary, phases and agents, drawn inside the Workflow call; redrawn whole on every progress update. */
function attachWorkflow(container, item) {
  const tool = toolFor(container, item.parent);
  if (!tool) return;
  tool.wfItem = item;
  const now = Date.now();
  const count = st => item.agents.filter(a => a.state === st).length;
  const [done, running, failed, queued] = ['done', 'running', 'failed', 'queued'].map(count);
  const current = item.status === 'running' ? item.agents.findLast(a => a.state === 'running')?.phase : null;
  tool.querySelector('.tsteps').textContent = [` ${done}/${item.agents.length} agents done`, running ? `${running} running` : '', failed ? `${failed} failed` : '',
    current, WF_STATUS[item.status] ?? item.status].filter(Boolean).join(' · ');

  const meta = scriptMeta(tool.input?.script);
  const info = item.info ?? {};
  const details = { ...meta.phaseDetails, ...(info.phaseDetails ?? {}) };
  const starts = item.agents.map(a => a.startedAt).filter(Boolean);
  const elapsed = info.durationMs ?? (starts.length ? (item.status === 'running' ? now : Math.max(...item.agents.map(a => a.lastAt ?? 0))) - Math.min(...starts) : null);
  const tokens = info.tokens ?? item.agents.reduce((n, a) => n + (a.tokens ?? 0), 0);
  const tools = info.tools ?? item.agents.reduce((n, a) => n + (a.tools ?? 0), 0);

  const open = (tool.wfOpen ??= new Map()); // phase title -> open/closed, once you have toggled it
  const phases = [...item.phases, null].map(title => ({ title, agents: item.agents.filter(a => (a.phase ?? null) === title) }))
    .filter(p => p.agents.length || p.title);
  const phaseEl = p => {
    const n = p.agents.length;
    const pd = p.agents.filter(a => a.state === 'done').length;
    const pr = p.agents.filter(a => a.state === 'running').length;
    const pf = p.agents.filter(a => a.state === 'failed').length;
    const st = p.agents.map(a => a.startedAt).filter(Boolean);
    const took = st.length && !pr ? Math.max(...p.agents.map(a => (a.startedAt ?? 0) + (a.durationMs ?? 0))) - Math.min(...st) : null;
    const state = !n ? 'waiting' : pr || p.agents.some(a => a.state === 'queued') ? 'active' : pf ? 'failed' : 'done';
    const isOpen = open.has(p.title) ? open.get(p.title) : state === 'active' || state === 'failed';
    const agents = [...p.agents].sort((x, y) => (STATE_ORDER[x.state] ?? 9) - (STATE_ORDER[y.state] ?? 9));
    // Only your clicks are remembered (setting `open` here fires a toggle too), so a finished phase still folds by itself.
    return h('details', { class: `wf-phase ${state}`, open: isOpen },
      h('summary', { onclick: e => open.set(p.title, !e.currentTarget.parentElement.open) },
        h('span', { class: 'wf-title' }, p.title ?? 'Other agents'),
        h('span', { class: 'wf-bar', title: `${pd} of ${n} done` }, h('span', { style: `width:${n ? Math.round(pd / n * 100) : 0}%` })),
        h('span', { class: 'wf-pcount' }, !n ? 'waiting' : state === 'done' ? `✓ ${pd} done${took ? ` · ${fmtDur(took)}` : ''}`
          : [`${pd}/${n} done`, pr ? `${pr} running` : '', pf ? `${pf} failed` : ''].filter(Boolean).join(' · ')),
        details[p.title] ? h('span', { class: 'wf-pdetail' }, details[p.title]) : null),
      n ? h('ul', {}, agents.map(a => {
        const quiet = a.state === 'running' && a.lastAt && now - a.lastAt > QUIET_MS;
        return h('li', {}, h('button', { type: 'button', class: `wf-a ${a.state}${quiet ? ' quiet' : ''}`, title: 'Open this agent',
          onclick: () => openAgentPanel(item.parent, a.id ?? a.label) },
          h('span', { class: 'wf-dot' }), h('span', { class: 'wf-label' }, a.label),
          h('span', { class: 'wf-facts' }, agentFacts(a, now).join(' · ')),
          a.state === 'done' && a.result ? h('span', { class: 'wf-res' }, a.result.replace(/\s+/g, ' ').slice(0, 120)) : null));
      })) : null);
  };
  const box = tool.querySelector('.wf');
  box.hidden = false;
  box.replaceChildren(
    h('div', { class: 'wf-head' },
      (info.description ?? meta.description) ? h('div', { class: 'wf-desc' }, info.description ?? meta.description) : null,
      h('div', { class: 'wf-counts' },
        running ? h('span', { class: 'chip running' }, `${running} running`) : null,
        h('span', { class: 'chip done' }, `${done} done`),
        queued ? h('span', { class: 'chip' }, `${queued} waiting`) : null,
        failed ? h('span', { class: 'chip failed' }, `${failed} failed`) : null,
        h('span', { class: 'wf-totals' }, [elapsed != null ? fmtDur(elapsed) : '', tokens ? `${fmtTok(tokens)} tokens` : '', tools ? `${tools} tool calls` : ''].filter(Boolean).join(' · ')))),
    ...phases.map(phaseEl));
  if (agentPanel?.parent === item.parent) agentPanel.refresh();
}

// ── agent panel: everything one workflow agent was asked, did and returned ──
let agentPanel = null;
function liveAgent(parent, key) {
  const tool = toolFor($('#stream') ?? document, parent);
  return tool?.wfItem?.agents.find(a => (a.id ?? a.label) === key) ?? null;
}

function resultView(r) {
  if (r == null || r === '') return h('p', { class: 'hint' }, 'Nothing returned yet.');
  if (typeof r === 'string') {
    try { const j = JSON.parse(r); if (j && typeof j === 'object') return resultView(j); } catch { /* plain text */ }
    return h('div', { class: 'msg assistant', html: renderMarkdown(r) });
  }
  const val = v => (v != null && typeof v === 'object' ? h('pre', {}, JSON.stringify(v, null, 2)) : h('span', {}, String(v)));
  const fields = o => h('dl', { class: 'ap-fields' }, ...Object.entries(o).flatMap(([k, v]) => [h('dt', {}, k.replace(/_/g, ' ')), h('dd', {}, val(v))]));
  return h('div', {}, ...Object.entries(r).map(([k, v]) => {
    if (Array.isArray(v) && v.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
      return h('section', { class: 'ap-list' }, h('h4', {}, `${k.replace(/_/g, ' ')} (${v.length})`),
        ...(v.length ? v.map(x => h('div', { class: 'ap-card' }, fields(x))) : [h('p', { class: 'hint' }, 'None.')]));
    }
    return fields({ [k]: v });
  }));
}

function openAgentPanel(parent, key) {
  agentPanel?.dlg.close();
  const sessionId = S.selected;
  const body = h('div', { class: 'ap-body' }, h('p', { class: 'hint' }, 'Loading…'));
  const head = h('div', { class: 'ap-head' });
  const dlg = h('dialog', { class: 'dialog agent-panel', onclose: () => { clearInterval(timer); dlg.remove(); if (agentPanel?.dlg === dlg) agentPanel = null; } },
    head, body, h('div', { class: 'dialog-actions' }, h('button', { class: 'ghost', type: 'button', onclick: () => dlg.close() }, 'Close')));
  document.body.append(dlg);
  dlg.showModal();
  let detail = null;
  const openSteps = new Set();
  let promptOpen = false;

  const drawHead = () => {
    const a = liveAgent(parent, key) ?? { label: key, state: 'unknown' };
    const facts = [
      ['Phase', a.phase], ['Model', modelName(a.model ?? detail?.model)], ['State', a.state],
      ['Started', a.startedAt ? new Date(a.startedAt).toLocaleTimeString() : detail?.startedAt ? new Date(detail.startedAt).toLocaleTimeString() : ''],
      ['Ran for', a.durationMs != null ? fmtDur(a.durationMs) : a.startedAt ? fmtDur((a.state === 'running' ? Date.now() : a.lastAt ?? Date.now()) - a.startedAt) : ''],
      ['Tool calls', a.tools ?? detail?.stepCount ?? ''], ['Tokens', a.tokens ? fmtTok(a.tokens) : ''], ['Attempt', a.attempt > 1 ? a.attempt : ''],
      ['Now', a.state === 'running' ? (a.lastAt && Date.now() - a.lastAt > QUIET_MS ? `quiet for ${since(Date.now() - a.lastAt)}` : a.lastTool ?? 'working') : ''],
    ].filter(([, v]) => v !== '' && v != null);
    head.replaceChildren(h('h2', {}, h('span', { class: `wf-dot ${a.state}` }), ' ', a.label),
      h('dl', { class: 'ap-facts' }, ...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))])));
    return a;
  };

  const draw = () => {
    const a = drawHead();
    if (!detail) {
      body.replaceChildren(h('p', { class: 'hint' }, a.state === 'queued' ? 'This agent has not started yet.' : 'This agent has not written anything yet.'),
        a.prompt ? h('section', {}, h('h3', {}, 'Asked (preview)'), h('p', {}, a.prompt)) : null);
      return;
    }
    const st = body.scrollTop;
    const long = (detail.prompt ?? '').length > 1500;
    const prompt = h('section', { class: 'ap-prompt' }, h('h3', {}, 'Asked'),
      h('div', { class: `msg user${long && !promptOpen ? ' folded' : ''}`, html: renderMarkdown(detail.prompt ?? '') }),
      long ? h('button', { class: 'link', type: 'button', onclick: () => { promptOpen = !promptOpen; draw(); } }, promptOpen ? 'Show less' : 'Show all') : null);
    const steps = h('section', {}, h('h3', {}, `Steps (${detail.stepCount})`),
      detail.stepCount > detail.steps.length ? h('p', { class: 'hint' }, `Showing the last ${detail.steps.length}.`) : null,
      detail.steps.length ? h('ol', { class: 'ap-steps' }, detail.steps.map((s, i) => (s.kind === 'text'
        ? h('li', { class: 'ap-text' }, h('div', { html: renderMarkdown(s.text) }))
        : h('li', {}, h('details', { open: openSteps.has(i), ontoggle: e => (e.target.open ? openSteps.add(i) : openSteps.delete(i)) },
          h('summary', {}, h('span', { class: 'tname' }, s.name), ' ', h('span', { class: 'tsum' }, s.summary), s.isError ? h('span', { class: 'chip failed' }, 'error') : null),
          h('div', { class: 'ap-io' }, h('div', { class: 'ap-io-label' }, 'Input'), h('pre', {}, s.input),
            h('div', { class: 'ap-io-label' }, 'Result'), h('pre', { class: s.isError ? 'err' : '' }, s.result ?? (a.state === 'running' ? 'Waiting…' : '(nothing came back)')))))))) : h('p', { class: 'hint' }, 'No steps yet.'));
    const result = h('section', {}, h('h3', {}, 'Result'), resultView(detail.result ?? (a.state === 'done' ? a.result : null)));
    body.replaceChildren(prompt, steps, result);
    body.scrollTop = st;
  };

  const load = async () => {
    try { detail = await api('GET', `/api/sessions/${sessionId}/agents/${encodeURIComponent(liveAgent(parent, key)?.id ?? key)}`); }
    catch { detail = null; }
    draw();
  };
  // While it runs, new steps arrive every few seconds.
  const timer = setInterval(() => { if (liveAgent(parent, key)?.state === 'running') load(); else drawHead(); }, 4000);
  agentPanel = { dlg, parent, refresh: drawHead };
  load();
}

function attachSub(container, item) {
  const tool = toolFor(container, item.parent);
  if (!tool) return;
  if (item.report != null) {
    // What the agent handed back — the part worth reading, so it shows as a message, not a step.
    const rep = tool.querySelector('.report');
    rep.hidden = false;
    rep.replaceChildren(h('div', { class: 'report-label' }, 'Report'), h('div', { class: 'msg assistant', html: renderMarkdown(item.report) }));
    if (tool.agent?.background) { tool.agent.end ??= Date.parse(item.ts) || Date.now(); renderAgent(tool); }
    return;
  }
  const list = tool.querySelector('.subs');
  list.hidden = false;
  // Numbered explicitly: the agent view hides early steps, which would otherwise renumber the rest from 1.
  list.append(h('li', { value: list.children.length + 1 }, item.tool ? h('span', {}, h('span', { class: 'tname' }, item.tool), ' ', item.summary) : item.text));
  const n = list.children.length;
  if (tool.agent) {
    Object.assign(tool.agent, { steps: n, lastAt: Date.parse(item.ts) || Date.now(),
      last: item.tool ? stepLabel(item.tool, item.summary) : null });
    renderAgent(tool);
  } else tool.querySelector('.tsteps').textContent = ` ${n} step${n === 1 ? '' : 's'}`;
}
function attachResult(container, item) {
  const tool = toolFor(container, item.id);
  if (!tool) return false;
  if (item.isError && !tool.agent) tool.querySelector('summary').append(h('span', { class: 'terr' }, 'failed'));
  // Claude Code's notes to itself about an agent it launched say nothing useful here; the report is shown instead.
  const text = String(item.text ?? '').trim();
  if (/^Async agent launched successfully/.test(text)) {
    if (tool.agent) { tool.agent.background = true; renderAgent(tool); }
    tool.append(h('div', { class: 'tnote' }, 'Launched in the background.'));
    return true;
  }
  const handedBack = /^This agent's report was delivered to you/.test(text);
  if (tool.agent) {
    // A foreground agent's result means it has finished; unless it handed its report back separately, the result is the report.
    Object.assign(tool.agent, { end: Date.parse(item.ts) || Date.now(), failed: !!item.isError });
    const rep = tool.querySelector('.report');
    if (rep.hidden && text && !handedBack) { rep.hidden = false; rep.replaceChildren(h('div', { class: 'report-label' }, 'Report'), h('div', { class: 'msg assistant', html: renderMarkdown(text) })); }
    renderAgent(tool);
    return true;
  }
  if (handedBack) return true;
  if (/^Workflow launched in background/.test(text)) { tool.append(h('div', { class: 'tnote' }, 'Launched in the background.')); return true; }
  tool.append(h('pre', {}, item.text || '(no output)'));
  return true;
}

function itemEl(item) {
  switch (item.kind) {
    case 'user': return h('div', { class: 'msg user', 'data-uuid': item.uuid ?? null },
      item.images?.length ? h('div', { class: 'msg-images' }, item.images.map(src =>
        h('button', { class: 'img-btn', type: 'button', 'aria-label': 'View image', onclick: () => viewImage(src) }, h('img', { src, alt: '' })))) : null,
      item.text || null, extras.userActions(item));
    case 'assistant': {
      const el = h('div', { class: 'msg assistant', 'data-uuid': item.uuid ?? null, html: renderMarkdown(item.text) });
      const act = extras.replyActions(item);
      if (act) el.append(act);
      return el;
    }
    case 'thinking': return extras.thinkingEl(item);
    case 'tool': return toolEl(item);
    case 'note': return h('div', { class: 'note' }, item.text);
    case 'shell': return h('div', { class: 'shell', 'data-shell': item.id, title: 'Ran here. Claude sees the command and its output with your next message.' },
      h('div', { class: 'shell-cmd' }, `! ${item.command}`, item.code ? h('span', { class: 'shell-code' }, ` exit ${item.code}`) : null,
        item.running ? h('span', { class: 'shell-running' }, ' running… ',
          h('button', { class: 'link', type: 'button', onclick: () => api('POST', `/api/sessions/${S.selected}/shell-stop`, { shellId: item.id }).catch(fail) }, 'Stop')) : null),
      // stderr isn't an error by itself (logins print their code there), so only colour it once the command has failed.
      h('pre', { class: item.code && item.stderr && !item.stdout ? 'err' : '' },
        [item.stdout.trimEnd(), item.stderr.trimEnd()].filter(Boolean).join('\n') || (item.running ? 'Waiting for output…' : '(no output)')));
    default: return null;
  }
}

function appendItem(container, item) {
  if (item.kind === 'tool_result') { attachResult(container, item); return; }
  if (item.kind === 'sub') { attachSub(container, item); return; }
  if (item.kind === 'workflow') { attachWorkflow(container, item); return; }
  const el = itemEl(item);
  if (el) container.insertBefore(el, container.querySelector('#partial'));
  if (item.kind === 'user' || item.kind === 'assistant') extras.markActions();
}

function nearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 120; }

function renderStream(forceBottom = false) {
  const st = $('#stream');
  if (!st || !S.chat) return;
  const stick = forceBottom || nearBottom(st);
  S.chat.redrawing = true; // tells auto-read these replies were already there, not new
  st.replaceChildren();
  if (S.chat.truncated) st.append(h('div', { class: 'more' }, 'Showing the latest part of this conversation. ',
    h('button', { class: 'ghost small', type: 'button', onclick: loadEarlier }, 'Load earlier')));
  st.append(h('div', { id: 'partial', class: 'msg assistant partial', hidden: !S.chat.partial }));
  for (const it of [...S.chat.items, ...S.chat.live]) appendItem(st, it);
  renderAgentStrip();
  if (!S.chat.items.length && !S.chat.live.length) st.insertBefore(h('div', { class: 'more' }, 'No messages yet.'), $('#partial'));
  renderPartial();
  extras.markActions();
  S.chat.redrawing = false;
  if (stick) st.scrollTop = st.scrollHeight;
}

function renderPartial() {
  const p = $('#partial');
  if (!p) return;
  p.hidden = !S.chat.partial;
  if (S.chat.partial) p.innerHTML = renderMarkdown(S.chat.partial);
}

// ── working line: the terminal's "✻ Pondering… (12s · ↓ 1.2k tokens · thinking)" while Claude has the turn ──
const WORK_VERBS = ['Thingamajigging', 'Pondering', 'Noodling', 'Combobulating', 'Schlepping', 'Percolating', 'Mulling',
  'Tinkering', 'Ruminating', 'Cogitating', 'Brewing', 'Simmering', 'Whirring', 'Puzzling', 'Musing', 'Contemplating',
  'Finagling', 'Fiddling', 'Wrangling', 'Untangling', 'Doodling', 'Crafting', 'Conjuring', 'Concocting', 'Marinating',
  'Kneading', 'Whittling', 'Spelunking', 'Moseying', 'Hatching', 'Churning', 'Mustering', 'Orchestrating', 'Sleuthing',
  'Deliberating', 'Scheming', 'Tidying', 'Juggling', 'Shimmying', 'Reticulating'];
const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const STILL = matchMedia('(prefers-reduced-motion: reduce)');
const TOOL_WORDS = { Read: 'reading', Edit: 'editing', MultiEdit: 'editing', Write: 'writing', Bash: 'running', PowerShell: 'running',
  Grep: 'searching', Glob: 'looking for', WebFetch: 'fetching', WebSearch: 'searching the web for', Agent: 'agent:', Task: 'agent:',
  Skill: 'skill:', Workflow: 'workflow:', TodoWrite: 'updating the to-do list' };

/** The turn being worked on, or null. Progress events are newer than the run; an older server sends neither. */
function workingTurn() {
  const run = S.chat?.run;
  if (!run || !['busy', 'starting'].includes(run.status)) { if (S.chat) S.chat.seenBusyAt = null; return null; }
  const t = S.chat.turn ?? run.turn;
  if (t) return t;
  S.chat.seenBusyAt ??= new Date().toISOString(); // no progress from the server: time it from when this page saw it start
  return { startedAt: S.chat.seenBusyAt, tokens: 0, activity: null };
}

function activityText(a) {
  if (a === 'thinking') return 'thinking';
  if (!a?.tool) return '';
  const word = TOOL_WORDS[a.tool];
  if (word && !word.endsWith(':') && !a.summary) return word;
  const what = /[\\/]/.test(a.summary) && !/\s/.test(a.summary) ? a.summary.split(/[\\/]/).pop() : a.summary.slice(0, 40);
  return `${word ?? a.tool} ${what}`.trim();
}

function renderWorking() {
  const el = $('#working');
  if (!el) return;
  const t = workingTurn();
  el.hidden = !t;
  if (!t) return;
  const secs = Math.max(0, Math.floor((Date.now() - Date.parse(t.startedAt)) / 1000));
  const elapsed = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
  const tokens = t.tokens >= 1000 ? `${(t.tokens / 1000).toFixed(1)}k` : String(t.tokens);
  const meta = [elapsed, t.tokens ? `↓ ${tokens} token${t.tokens === 1 ? '' : 's'}` : '', activityText(t.activity)].filter(Boolean).join(' · ');
  let n = 0;
  for (const c of t.startedAt) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  const verb = `${WORK_VERBS[n % WORK_VERBS.length]}…`;
  const glyph = STILL.matches ? '✻' : SPIN[Math.floor(Date.now() / 120) % SPIN.length];
  if (!el.firstChild) {
    el.append(h('span', { class: 'spin', 'aria-hidden': 'true' }), h('span', { class: 'verb' }), h('span', { class: 'meta' }),
      h('button', { class: 'ghost small stop', type: 'button', title: 'Stop Claude’s reply',
        onclick: () => api('POST', `/api/sessions/${S.selected}/interrupt`).catch(fail) }, 'Stop'));
  }
  const [spin, v, m] = el.children;
  if (spin.textContent !== glyph) spin.textContent = glyph;
  if (v.textContent !== verb) v.textContent = verb;
  if (m.textContent !== `(${meta})`) m.textContent = `(${meta})`;
}
setInterval(() => { if (S.chat) renderWorking(); }, 120);

function renderAsks() {
  renderWorking();
  const box = $('#asks');
  if (!box) return;
  const pending = S.chat?.run?.pending ?? [];
  extras.renderTasks();
  extras.markActions();
  box.replaceChildren(...pending.map(p => (p.kind === 'question' ? questionCard(p)
    : p.toolName === 'ExitPlanMode' && extras.planCard ? extras.planCard(p, answer) : permissionCard(p, isCodex(S.chat?.run)))));
  if (pending.length) { const st = $('#stream'); st.scrollTop = st.scrollHeight; }
}

function answer(p, decision) {
  return api('POST', `/api/sessions/${S.selected}/answer`, { requestId: p.requestId, ...decision }).catch(fail);
}

function permissionCard(p, codex = false) {
  const i = p.input ?? {};
  const words = permissionText(p.toolName, codex);
  const body = i.command ?? (i.file_path ? `${i.file_path}${i.content ? '\n\n' + String(i.content).slice(0, 1500) : ''}${i.new_string ? '\n\n' + String(i.new_string).slice(0, 1500) : ''}` : JSON.stringify(i, null, 2));
  const danger = p.danger ?? [];
  return h('div', { class: `ask${danger.length ? ' danger-ask' : ''}`, role: 'group', 'aria-label': `Permission for ${p.toolName}` },
    danger.length ? h('div', { class: 'danger-badges' }, h('strong', {}, 'Careful — this touches something live: '), ...danger.map(d => h('span', { class: 'danger-badge' }, d))) : null,
    h('h4', {}, words.heading),
    i.description && h('p', { class: 'reason' }, i.description),
    h('pre', {}, body),
    p.reason && h('p', { class: 'reason' }, p.reason),
    h('div', { class: 'ask-actions' },
      h('button', { class: 'primary', type: 'button', onclick: () => answer(p, { behavior: 'allow' }) }, 'Approve'),
      p.canAlways && h('button', { class: 'ghost', type: 'button', title: words.alwaysTitle, onclick: () => answer(p, { behavior: 'allow', always: true }) }, 'Always allow'),
      h('button', { class: 'danger', type: 'button', onclick: () => answer(p, { behavior: 'deny' }) }, 'Deny')));
}

function questionCard(p) {
  const qs = p.input?.questions ?? [];
  const picked = new Map(qs.map(q => [q.question, new Set()]));
  const other = new Map();
  const value = q => (other.get(q.question) ?? '').trim() || [...picked.get(q.question)].join(', ');
  // Several questions show one at a time (like the terminal), with tabs to jump between them, so the card stays short.
  let step = 0;
  const many = qs.length > 1;
  const tabs = many ? qs.map((q, i) => h('button', { class: 'q-tab', type: 'button', title: q.question, onclick: () => go(i) }, q.header || `Q${i + 1}`)) : [];
  const panes = qs.map(q => h('div', { class: 'q' },
    h('p', {}, q.question),
    h('div', { class: 'opts' }, ...(q.options ?? []).map(o => h('button', { class: 'opt', type: 'button', 'aria-pressed': 'false', onclick: e => {
      const set = picked.get(q.question);
      if (!q.multiSelect) { set.clear(); e.currentTarget.parentElement.querySelectorAll('.opt').forEach(b => b.setAttribute('aria-pressed', 'false')); }
      if (set.has(o.label)) set.delete(o.label); else set.add(o.label);
      e.currentTarget.setAttribute('aria-pressed', set.has(o.label) ? 'true' : 'false');
      sync();
      if (!q.multiSelect && set.size && step < qs.length - 1) setTimeout(() => go(step + 1), 180); // picked one: on to the next
    } }, o.label, o.description && h('small', {}, o.description)))),
    h('div', { class: 'add-item', style: 'margin-top:6px' }, h('input', { placeholder: 'Or type your own answer', 'aria-label': `Own answer: ${q.question}`,
      oninput: e => { other.set(q.question, e.target.value); sync(); } }))));
  const back = h('button', { class: 'ghost', type: 'button', onclick: () => go(step - 1) }, 'Back');
  const next = h('button', { class: 'ghost', type: 'button', onclick: () => go(step + 1) }, 'Next');
  const count = h('span', { class: 'q-count' });
  function sync() {
    tabs.forEach((t, i) => { t.classList.toggle('done', !!value(qs[i])); t.setAttribute('aria-current', i === step ? 'step' : 'false'); });
    count.textContent = many ? `${step + 1} of ${qs.length}` : '';
    back.hidden = !many || step === 0;
    next.hidden = !many || step === qs.length - 1;
  }
  function go(i) {
    step = Math.max(0, Math.min(qs.length - 1, i));
    panes.forEach((el, n) => { el.hidden = n !== step; });
    sync();
  }
  const card = h('div', { class: 'ask', role: 'group', 'aria-label': 'Claude has a question' },
    h('h4', {}, many ? `Claude has ${qs.length} questions` : 'Claude has a question'),
    many && h('div', { class: 'q-tabs' }, ...tabs),
    ...panes,
    h('div', { class: 'ask-actions' },
      back, next,
      h('button', { class: 'primary', type: 'button', onclick: () => {
        const answers = {};
        for (const [i, q] of qs.entries()) {
          const val = value(q);
          if (!val) { go(i); toast(many ? 'This one still needs an answer.' : 'Pick an answer first.', true); return; }
          answers[q.question] = val;
        }
        answer(p, { behavior: 'allow', answers });
      } }, 'Send answers'),
      h('button', { class: 'ghost', type: 'button', onclick: () => answer(p, { behavior: 'deny', message: `${S.data?.options.userName ?? 'The user'} skipped the question — carry on with your best judgement or ask in chat.` }) }, 'Skip'),
      count));
  go(0);
  return card;
}

function autoGrow(e) {
  const t = e.target;
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 220)}px`;
}

function onComposerKey(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
}

/** /workflows is terminal-only (headless Claude answers "isn't available"), so Pit Wall shows its own Workflow box instead. */
function showWorkflows() {
  const boxes = [...document.querySelectorAll('#chat .tool')].filter(t => t.querySelector(':scope > .wf:not([hidden])'));
  const box = boxes.findLast(t => t.wfItem?.status === 'running') ?? boxes.at(-1);
  if (!box) { toast('No workflow in this chat yet — when Claude runs one, its progress shows here in a Workflow box.'); return; }
  box.open = true;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (boxes.length > 1) toast(`${boxes.length} workflows in this chat — showing the ${box.wfItem?.status === 'running' ? 'running' : 'latest'} one.`);
}

async function sendMessage(e) {
  e.preventDefault();
  const input = $('#input');
  const text = input.value.trim();
  const id = S.selected;
  const images = S.attachments.get(id) ?? [];
  const files = S.files.get(id) ?? [];
  if (!id || (!text && !images.length && !files.length)) return;
  if (/^\/workflows?$/i.test(text) && !images.length && !files.length) { input.value = ''; S.drafts.delete(id); showWorkflows(); return; }
  if (images.some(i => i.pending)) { toast('Images are still being prepared — send again in a moment.'); return; }
  if (files.some(f => f.pending)) { toast('Files are still uploading — send again in a moment.'); return; }
  input.value = '';
  S.drafts.delete(id);
  S.attachments.delete(id);
  S.files.delete(id);
  renderThumbs();
  autoGrow({ target: input });
  // Claude reads files from disk: tell it where each one is.
  const withFiles = files.length ? `${text}${text ? '\n\n' : ''}Files I've attached (read them from these paths):\n${files.map(f => `- ${f.path}`).join('\n')}` : text;
  try {
    await api('POST', `/api/sessions/${id}/message`, { text: withFiles, images: images.map(({ mediaType, data }) => ({ mediaType, data })) });
    // Hands-free with the natural voice: load it while Claude works, so the reply isn't kept waiting for it.
    if (speech?.autoRead() && speech.voiceChoice().startsWith('natural:')) api('POST', '/api/voice/warm').catch(() => {});
  } catch (err) {
    if (S.selected === id) { input.value = text; S.attachments.set(id, images); S.files.set(id, files); renderThumbs(); }
    fail(err);
  }
}

// ── images ───────────────────────────────────────────────────────────────
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
const MAX_IMAGES = 6;
const MAX_EDGE = 2000;              // longer side, px — plenty for Claude, keeps uploads small
const KEEP_AS_IS_BYTES = 3_500_000; // smaller than this and already within MAX_EDGE: send untouched

function attachIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M21 11.5l-8.6 8.6a5.5 5.5 0 01-7.8-7.8l8.6-8.6a3.7 3.7 0 015.2 5.2l-8.6 8.6a1.8 1.8 0 01-2.6-2.6l7.9-7.9');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.8');
  p.setAttribute('stroke-linecap', 'round');
  svg.append(p);
  return svg;
}

function readAsDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Could not read that image.'));
    r.readAsDataURL(blob);
  });
}

/** File → {mediaType, data, url}. Big or huge images are scaled down in the browser first. */
async function prepareImage(file) {
  const types = IMAGE_ACCEPT.split(',');
  if (!types.includes(file.type)) throw new Error(`${file.name || 'That file'} isn't a PNG, JPEG, GIF or WebP.`);
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error(`${file.name || 'That image'} couldn't be opened.`));
      i.src = url;
    });
    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    let blob = file;
    if (scale < 1 || file.size > KEEP_AS_IS_BYTES) {
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const keepPng = file.type === 'image/png' && c.width * c.height <= 1_500_000;
      blob = await new Promise(r => c.toBlob(r, keepPng ? 'image/png' : 'image/jpeg', 0.88));
    }
    const dataUrl = await readAsDataURL(blob);
    const [, mediaType, data] = /^data:([^;]+);base64,(.*)$/.exec(dataUrl) ?? [];
    return { mediaType, data, url: dataUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function addImages(sessionId, files) {
  if (!sessionId || !files.length) return;
  const list = S.attachments.get(sessionId) ?? [];
  const room = MAX_IMAGES - list.length;
  if (room <= 0) { toast(`You can send up to ${MAX_IMAGES} images at a time.`, true); return; }
  if (files.length > room) toast(`Only the first ${room} image${room === 1 ? '' : 's'} were added (max ${MAX_IMAGES}).`, true);
  for (const file of files.slice(0, room)) {
    const slot = { pending: true, url: '' };
    list.push(slot);
    S.attachments.set(sessionId, list);
    renderThumbs();
    try {
      Object.assign(slot, await prepareImage(file), { pending: false });
    } catch (e) {
      list.splice(list.indexOf(slot), 1);
      fail(e);
    }
    renderThumbs();
  }
}

const NEW_SESSION = '__new'; // attachments key for the New session form

function renderThumbs() {
  for (const [key, boxId] of [[S.selected, 'thumbs'], [NEW_SESSION, 'new-thumbs']]) {
    const box = document.getElementById(boxId);
    if (!box) continue;
    const list = S.attachments.get(key) ?? [];
    const files = key === S.selected ? S.files.get(key) ?? [] : [];
    box.replaceChildren(...list.map((img, i) => h('div', { class: `thumb${img.pending ? ' pending' : ''}` },
      img.pending ? h('span', { class: 'thumb-wait' }, 'Preparing…') : h('img', { src: img.url, alt: `Attached image ${i + 1}` }),
      h('button', { class: 'thumb-x', type: 'button', 'aria-label': `Remove image ${i + 1}`, onclick: () => {
        list.splice(i, 1);
        renderThumbs();
      } }, '×'))),
    ...files.map((f, i) => h('div', { class: `file-chip${f.pending ? ' pending' : ''}`, title: f.path ?? 'Uploading…' },
      h('span', { class: 'file-kind' }, (f.name.split('.').pop() || 'file').slice(0, 5)), h('span', { class: 'file-name' }, f.pending ? `${f.name} — uploading…` : f.name),
      h('button', { class: 'thumb-x', type: 'button', 'aria-label': `Remove ${f.name}`, onclick: () => { files.splice(i, 1); renderThumbs(); } }, '×'))));
    box.hidden = !list.length && !files.length;
  }
}

function viewImage(src) {
  const d = h('dialog', { class: 'lightbox', onclick: () => d.close(), onclose: () => d.remove() },
    h('img', { src, alt: 'Attached image, full size' }));
  document.body.append(d);
  d.showModal();
}

// Drop images anywhere on the chat pane.
$('#chat').addEventListener('dragover', e => {
  if (!S.selected || ![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
  e.preventDefault();
  $('#chat').classList.add('dropping');
});
$('#chat').addEventListener('dragleave', e => { if (e.target === $('#chat')) $('#chat').classList.remove('dropping'); });
$('#chat').addEventListener('drop', e => {
  $('#chat').classList.remove('dropping');
  const all = [...(e.dataTransfer?.files ?? [])];
  if (!S.selected || !all.length) return;
  e.preventDefault(); // otherwise the browser types the file's location into the box
  addFiles(S.selected, all, droppedPaths(e.dataTransfer));
});

/** Windows paths of dropped files, when the browser says where they are (dragged from Explorer on this PC). */
function droppedPaths(dt) {
  const local = ['127.0.0.1', 'localhost'].includes(location.hostname);
  if (!local) return new Map(); // used from another PC: its paths mean nothing here
  const raw = [dt.getData('text/uri-list'), dt.getData('text/plain')].join('\n');
  const out = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const m = /^file:\/\/\/?([A-Za-z]:\/.*)$/.exec(line.trim()) ?? /^([A-Za-z]:\\[^\n]+)$/.exec(line.trim());
    if (!m) continue;
    let p = m[1];
    if (line.trim().startsWith('file:')) { try { p = decodeURIComponent(p); } catch { /* not encoded after all */ } }
    p = p.replace(/\//g, '\\');
    out.set(p.split('\\').pop().toLowerCase(), p);
  }
  return out;
}

/** Images attach as before; any other file becomes a chip — by its own path if known, else an uploaded copy. */
function addFiles(sessionId, all, paths = new Map()) {
  const images = all.filter(f => IMAGE_ACCEPT.split(',').includes(f.type));
  if (images.length) addImages(sessionId, images);
  const others = all.filter(f => !images.includes(f));
  if (!others.length) return;
  const list = S.files.get(sessionId) ?? [];
  S.files.set(sessionId, list);
  for (const file of others.slice(0, Math.max(0, 10 - list.length))) {
    const known = paths.get(file.name.toLowerCase());
    if (known) { list.push({ name: file.name, path: known }); continue; }
    const entry = { name: file.name, pending: true };
    list.push(entry);
    if (file.size > 50_000_000) { list.splice(list.indexOf(entry), 1); toast(`${file.name} is over 50 MB.`, true); continue; }
    fetch(`/api/uploads?session=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(file.name)}`,
      { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: file })
      .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Upload failed'); Object.assign(entry, { path: j.path, pending: false }); })
      .catch(x => { list.splice(list.indexOf(entry), 1); fail(x); })
      .finally(renderThumbs);
  }
  if (others.length > 10) toast('Up to 10 files at a time.', true);
  renderThumbs();
}

// ── new session dialog ───────────────────────────────────────────────────
{ const cwd = $('#new-form').elements.cwd; cwd.before(folderPicker(cwd)); }
// Engine picker (built here so it appears without a server restart); hidden unless the server knows about Codex.
const newEngineLabel = h('label', { hidden: true }, 'Engine', engineSelect('engine', 'claude', () => applyNewEngine()));
$('#new-form').elements.model.closest('label').before(newEngineLabel);
$('#new-form').elements.model.addEventListener('change', () => { if (newFormCodex()) fillNewEffort(); });
const newFormCodex = () => codexOn() && $('#new-form').elements.engine.value === 'codex';
const CLAUDE_PLACEHOLDER = $('#new-form').elements.message.placeholder;

/** Model, effort and permission lists for the engine picked in the New session form. */
function applyNewEngine() {
  const d = S.data;
  const f = $('#new-form').elements;
  const codex = newFormCodex();
  f.model.replaceChildren(...(codex ? codexModelOptions()
    : d.options.models.map(m => h('option', { value: m }, m ? m[0].toUpperCase() + m.slice(1) : 'Usual model'))));
  f.permissionMode.replaceChildren(h('option', { value: '' }, 'Auto (default)'),
    ...d.options.permissionModes.filter(m => m !== 'auto').map(m => h('option', { value: m }, { manual: 'Ask before acting', acceptEdits: 'Accept edits', auto: 'Auto', plan: 'Plan only' }[m] ?? m)));
  f.permissionMode.closest('label').hidden = codex;
  f.message.placeholder = newMessagePlaceholder(CLAUDE_PLACEHOLDER, codex);
  const hint = $('#new-model-hint');
  hint.hidden = codex; // its suggestions are Claude models
  if (codex) hint.replaceChildren();
  fillNewEffort();
}
function fillNewEffort() {
  const d = S.data.options;
  const f = $('#new-form').elements;
  if (newFormCodex()) {
    f.effort.replaceChildren(h('option', { value: '' }, 'Default'), ...codexEfforts(f.model.value).map(x => h('option', { value: x }, x)));
    return;
  }
  f.effort.replaceChildren(h('option', { value: '' }, `${d.defaultEffort} (default)`),
    ...d.efforts.filter(x => x !== d.defaultEffort).map(x => h('option', { value: x }, x)));
}

function openNewDialog() {
  const d = S.data;
  const f = $('#new-form').elements;
  more.setupTemplates($('#new-form'));
  f.projectId.replaceChildren(h('option', { value: '' }, 'Let Claude file it'), ...d.projects.filter(p => !p.archived).map(p => h('option', { value: p.id }, p.name)));
  f.cwd.value = f.cwd.value || lastFolder() || d.options.workspaces[0] || '';
  newEngineLabel.hidden = !codexOn();
  newEngineLabel.querySelector('select').replaceWith(engineSelect('engine', codexOn() ? defaultEngine() : 'claude', () => applyNewEngine()));
  applyNewEngine();
  $('#new-error').textContent = '';
  renderThumbs();
  $('#new-dialog').showModal();
  f.message.focus();
}

$('#new-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target.elements;
  const images = S.attachments.get(NEW_SESSION) ?? [];
  if (images.some(i => i.pending)) { $('#new-error').textContent = 'Images are still being prepared — try again in a moment.'; return; }
  try {
    const { id } = await api('POST', '/api/sessions', {
      message: f.message.value, name: f.name.value, projectId: f.projectId.value || null,
      cwd: f.cwd.value, model: f.model.value, permissionMode: newFormCodex() ? '' : f.permissionMode.value, effort: f.effort.value,
      engine: engineOf(f),
      images: images.map(({ mediaType, data }) => ({ mediaType, data })),
    });
    rememberFolder(f.cwd.value);
    $('#new-dialog').close();
    e.target.reset();
    delete e.target.dataset.brief;
    f.message.rows = 6;
    S.attachments.delete(NEW_SESSION);
    renderThumbs();
    toast('Session started');
    setTimeout(() => openChat(id), 300);
  } catch (err) { $('#new-error').textContent = err.message; }
});
$('#new-attach').addEventListener('click', () => $('#new-file-pick').click());
$('#new-file-pick').addEventListener('change', e => { addImages(NEW_SESSION, [...e.target.files]); e.target.value = ''; });
$('#new-form').elements.message.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files ?? [])].filter(x => x.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); addImages(NEW_SESSION, files); }
});
$('#new-dialog').addEventListener('dragover', e => { if ([...(e.dataTransfer?.types ?? [])].includes('Files')) e.preventDefault(); });
$('#new-dialog').addEventListener('drop', e => {
  const files = [...(e.dataTransfer?.files ?? [])].filter(x => x.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  addImages(NEW_SESSION, files);
});
$('#new-cancel').addEventListener('click', () => {
  $('#new-dialog').close();
  // A cancelled task brief shouldn't linger as the next New session's draft.
  if ($('#new-form').dataset.brief) { $('#new-form').reset(); delete $('#new-form').dataset.brief; $('#new-form').elements.message.rows = 6; }
});
$('#new-btn').addEventListener('click', openNewDialog);
$('#organise-btn').addEventListener('click', async () => {
  $('#organise-btn').disabled = true;
  try {
    const r = await api('POST', '/api/organise');
    toast(r.ok ? `Organised: ${r.assigned} filed, ${r.created} new projects, ${r.items} checklist updates` : r.skipped ? `Nothing to organise (${r.skipped})` : `Organiser failed: ${r.error}`, !r.ok && !r.skipped);
  } catch (err) { fail(err); }
});

// ── tabs / search / keys ─────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setView(t.dataset.group)));

// Menus close when you pick something or click elsewhere.
document.addEventListener('click', e => {
  document.querySelectorAll('details.menu[open]').forEach(m => {
    if (!m.contains(e.target) || (e.target.closest('.menu-list button'))) m.open = false;
  });
});

// ── theme ────────────────────────────────────────────────────────────────
{
  const sel = $('#theme-select');
  const group = t => t.group ?? (t.mode === 'light' ? 'Light' : 'Dark');
  for (const g of new Set(THEMES.map(group))) {
    sel.append(h('optgroup', { label: g }, ...THEMES.filter(t => group(t) === g).map(t => h('option', { value: t.id }, t.label))));
  }
  sel.value = currentTheme();
  sel.addEventListener('change', () => setTheme(sel.value));
}
$('#search').addEventListener('input', e => { S.search = e.target.value.trim(); renderView(); });
$('#search').addEventListener('keydown', e => { if (e.key === 'Enter' && S.search.length >= 3 && S.view === 'board') searchAll(); });
$('#search-all').addEventListener('click', searchAll);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && S.selected && !$('#new-dialog').open && !document.querySelector('dialog[open]')) closeChat();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && S.data) { e.preventDefault(); more.openPalette(); }
});
$('#palette-btn').addEventListener('click', () => S.data && more.openPalette());
$('#brief-btn').addEventListener('click', () => S.data && more.showBrief({ markSeen: true }));
// On phones Find and Brief live in the More menu.
$('#palette-menu').addEventListener('click', () => $('#palette-btn').click());
$('#brief-menu').addEventListener('click', () => $('#brief-btn').click());

// ── Pit Wall updates ─────────────────────────────────────────────────────
/** A quiet header button when GitHub has a newer Pit Wall. */
function renderUpdateBtn(u) {
  let btn = $('#update-btn');
  if (!u?.behind) { btn?.remove(); return; }
  if (!btn) {
    btn = h('button', { class: 'ghost update-btn', id: 'update-btn', type: 'button', onclick: () => openUpdate() }, 'Update available');
    $('#brief-btn').before(btn);
  }
  btn.title = `${u.behind} change${u.behind === 1 ? '' : 's'} on GitHub`;
}

// Built here rather than in index.html so it shows on a page refresh, without a server restart.
const checkBtn = h('button', { type: 'button', id: 'check-update-btn' }, 'Check for updates');
$('#organise-btn').after(checkBtn);
checkBtn.addEventListener('click', async () => {
  checkBtn.disabled = true;
  checkBtn.textContent = 'Checking for updates…';
  try {
    const u = await api('POST', '/api/update/check');
    if (S.data) S.data.update = u;
    renderUpdateBtn(u);
    if (u.error) toast(u.error, true);
    else if (u.behind) toast(`${u.behind} change${u.behind === 1 ? '' : 's'} on GitHub — click Update available`);
    else toast('Pit Wall is up to date');
  } catch (err) { fail(err); }
  finally { checkBtn.disabled = false; checkBtn.textContent = 'Check for updates'; }
});

function openUpdate() {
  const u = S.data.update;
  if (!u) return;
  const err = h('p', { class: 'form-error', role: 'alert' });
  const go = h('button', { class: 'primary', type: 'button', disabled: !u.canUpdate }, 'Update & restart');
  const dlg = h('dialog', { class: 'dialog', onclose: () => dlg.remove() },
    h('h2', {}, 'A newer Pit Wall is available'),
    h('p', { class: 'pdesc' }, `${u.behind} change${u.behind === 1 ? '' : 's'} since this copy:`),
    h('ul', { class: 'update-list' }, u.subjects.map(s => h('li', {}, s))),
    codexUpdateText(u) ? h('p', { class: 'codex-update-note' }, codexUpdateText(u)) : null,
    u.canUpdate
      ? h('p', { class: 'hint' }, 'Pit Wall downloads it and restarts — about 10 seconds. Chats keep running and come back after the restart.')
      : h('p', { class: 'hint' }, u.ahead ? `This copy has ${u.ahead} change${u.ahead === 1 ? '' : 's'} of its own that aren’t on GitHub, so it isn’t updated automatically — ask Claude to update it.`
        : u.dirty ? 'Some of Pit Wall’s files have been changed on this PC, so it isn’t updated automatically — ask Claude to update it.' : (u.error ?? '')),
    err,
    h('div', { class: 'dialog-actions' }, h('button', { class: 'ghost', type: 'button', onclick: () => dlg.close() }, 'Not now'), go));
  go.onclick = async () => {
    go.disabled = true;
    go.textContent = 'Updating…';
    try {
      await api('POST', '/api/update');
      S.data.update = null;
      renderUpdateBtn(null);
      toast('Updated — Pit Wall is restarting');
      dlg.close();
    }
    catch (x) { err.textContent = x.message; go.textContent = 'Update & restart'; }
  };
  document.body.append(dlg);
  dlg.showModal();
}

// ── live updates ─────────────────────────────────────────────────────────
function connect() {
  const es = new EventSource('/api/events');
  let lastProjectsKey = '';
  es.addEventListener('state', e => {
    const focused = document.activeElement;
    // Hold redraws only while you are mid-edit: a focused name box, or a box with unsent text in it.
    const editing = S.view === 'projects' && focused?.closest?.('.proj')
      && (focused.tagName === 'TEXTAREA' || (focused.tagName === 'INPUT' && focused.value.trim() !== ''));
    S.data = JSON.parse(e.data);
    // Queue and Agents switched off on this PC: drop their views everywhere.
    if (!automationOn() && GROUPS.automation.length > 1) {
      GROUPS.automation = GROUPS.automation.filter(([k]) => k !== 'queue' && k !== 'agents');
      if (S.view === 'queue' || S.view === 'agents') setView('jobs');
    }
    renderHeader();
    if (S.view === 'jobs') more.refreshRoundup();
    if (S.chat) renderAgentStrip(); // an agent stops counting as running once the chat goes quiet
    if (S.view === 'board') renderBoard();
    else if (S.view === 'projects') {
      // Projects only change when the organiser or you edit something — skip needless redraws.
      const key = JSON.stringify([S.data.projects, S.data.sessions.map(s => s.projectId)]);
      if (!editing && key !== lastProjectsKey) { lastProjectsKey = key; renderProjects(); }
    }
    if (S.selected) renderChatHead();
    renderNotifyBtn();
    renderGroupBtn();
    renderEngineSetting();
    renderCodexMenu();
    renderExtraViews();
    if (openOnLoad && !S.openedFromLink) { S.openedFromLink = true; openChat(openOnLoad); }
    // Morning brief: once, the first time Pit Wall is opened each day.
    if (!S.briefChecked) {
      S.briefChecked = true;
      if (S.data.settings.lastBriefDay !== S.data.settings.today && !openOnLoad) more.showBrief({ markSeen: true });
    }
  });
  es.addEventListener('fresh', e => {
    const { from, to, error } = JSON.parse(e.data);
    if (error) { if (S.selected === from) toast(`Fresh start failed: ${error}`, true); return; }
    toast('Fresh session ready — the old one is filed under Closed');
    if (S.selected === from) setTimeout(() => openChat(to), 400);
  });
  es.addEventListener('run', e => {
    const run = JSON.parse(e.data);
    if (!S.chat || run.sessionId !== S.selected) return;
    const hadRun = !!S.chat.run;
    const restarted = hadRun && S.chat.run.startedAt !== run.startedAt;
    S.chat.run = run;
    S.chat.turn = run.turn ?? null;
    if (restarted) { S.chat.items = [...S.chat.items, ...S.chat.live]; S.chat.live = []; }
    if (!run.partial) { S.chat.partial = ''; renderPartial(); }
    renderAsks();
    renderChatHead();
  });
  es.addEventListener('item', e => {
    const { sessionId, item } = JSON.parse(e.data);
    if (!S.chat || sessionId !== S.selected) return;
    // Workflow progress arrives whole each time: keep only the newest per workflow.
    if (item.kind === 'workflow') S.chat.live = S.chat.live.filter(i => !(i.kind === 'workflow' && i.parent === item.parent));
    S.chat.live.push(item);
    const st = $('#stream');
    const stick = nearBottom(st);
    st.querySelectorAll('.more').forEach(m => { if (m.textContent === 'No messages yet.') m.remove(); });
    if (item.kind === 'assistant') { S.chat.partial = ''; renderPartial(); }
    appendItem(st, item);
    if (item.kind === 'tool' || item.kind === 'sub' || item.kind === 'tool_result' || item.kind === 'user') renderAgentStrip();
    if (stick) st.scrollTop = st.scrollHeight;
  });
  // A "! command" still running: swap in its latest output where it already sits in the chat.
  es.addEventListener('shell', e => {
    const { sessionId, item } = JSON.parse(e.data);
    if (!S.chat || sessionId !== S.selected) return;
    S.chat.live = S.chat.live.map(i => (i.kind === 'shell' && i.id === item.id ? item : i));
    const st = $('#stream');
    const old = st.querySelector(`[data-shell="${CSS.escape(item.id)}"]`);
    if (!old) return;
    const stick = nearBottom(st);
    old.replaceWith(itemEl(item));
    if (stick) st.scrollTop = st.scrollHeight;
  });
  es.addEventListener('reload', async e => {
    const { sessionId } = JSON.parse(e.data);
    if (!S.chat || sessionId !== S.selected) return;
    try {
      const h0 = await api('GET', `/api/sessions/${sessionId}/history`);
      if (S.selected !== sessionId) return;
      Object.assign(S.chat, { items: h0.items, live: h0.live, run: h0.run, turn: h0.run?.turn ?? null, partial: h0.run?.partial ?? '', truncated: h0.truncated });
      renderStream(true);
      renderAsks();
      renderChatHead();
    } catch (x) { fail(x); }
  });
  es.addEventListener('progress', e => {
    const { sessionId, turn } = JSON.parse(e.data);
    if (!S.chat || sessionId !== S.selected) return;
    S.chat.turn = turn;
    renderWorking();
  });
  es.addEventListener('delta', e => {
    const { sessionId, text } = JSON.parse(e.data);
    if (!S.chat || sessionId !== S.selected) return;
    S.chat.partial += text;
    const st = $('#stream');
    const stick = nearBottom(st);
    renderPartial();
    if (stick) st.scrollTop = st.scrollHeight;
  });
  es.onerror = () => {
    es.close();
    toast('Lost touch with Pit Wall. Reconnecting…', true);
    setTimeout(() => fetch('/api/state', { credentials: 'same-origin' }).then(r => (r.status === 401 ? location.reload() : connect())).catch(() => setTimeout(connect, 3000)), 2000);
  };
}

// ── notifications ────────────────────────────────────────────────────────
function renderNotifyBtn() {
  const on = S.data?.settings?.notify !== false;
  const b = $('#notify-btn');
  b.textContent = on ? 'Notifications on' : 'Notifications off';
  b.setAttribute('aria-pressed', String(on));
}
$('#notify-btn').addEventListener('click', async () => {
  const on = S.data?.settings?.notify !== false;
  try {
    await api('POST', '/api/settings', { notify: !on, testNotification: !on });
    toast(on ? 'Notifications off' : 'Notifications on — a test one is on its way');
  } catch (e) { fail(e); }
});

// ── board grouping (More menu) ───────────────────────────────────────────
function renderGroupBtn() {
  const on = S.data?.settings?.groupByProject !== false;
  const b = $('#group-btn');
  b.textContent = on ? 'Grouped by project' : 'One list (no projects)';
  b.setAttribute('aria-pressed', String(on));
}
$('#group-btn').addEventListener('click', async () => {
  const on = S.data?.settings?.groupByProject !== false;
  try {
    await api('POST', '/api/settings', { groupByProject: !on });
    toast(on ? 'All chats in one list — Claude stops filing them into projects' : 'Chats grouped by project again');
  } catch (e) { fail(e); }
});

// ── reading replies aloud (More menu) ────────────────────────────────────
// Kept per device in localStorage, not server settings: a phone and the PC each have their own voices. The natural
// voice is made by the server (GET /api/voice says whether this PC has it set up).
let voicePoll = null;
async function loadVoiceStatus() {
  if (!speech) return;
  const st = await api('GET', '/api/voice').catch(() => null); // null: a server from before this, until it restarts
  speech.setNatural(st);
  renderSpeechBtns();
  // Natural voice picked: have the PC load it now, so the first Read aloud doesn't wait for it (it unloads when unused).
  if (st?.installed && speech.voiceChoice().startsWith('natural:')) api('POST', '/api/voice/warm').catch(() => {});
  clearTimeout(voicePoll);
  if (st?.installing) voicePoll = setTimeout(loadVoiceStatus, 5000); // watch a set-up through to the end
}
function renderSpeechBtns() {
  if (!speech) return;
  const auto = speech.autoRead();
  Object.assign($('#read-aloud-btn'), { hidden: false, textContent: auto ? 'Read replies aloud: on' : 'Read replies aloud: off' });
  $('#read-aloud-btn').setAttribute('aria-pressed', String(auto));
  const nat = speech.naturalStatus();
  const opts = [];
  if (nat?.installed) for (const [id, name] of Object.entries(nat.voices)) opts.push([`natural:${id}`, `Natural — ${name}`]);
  else if (nat?.installing) opts.push(['', 'Natural: setting up…']);
  else if (nat && !nat.remote) opts.push(['setup', nat.error ? 'Natural: set up failed — try again' : 'Natural: set up (~720 MB download)']);
  opts.push(['device', 'This device'], ['google', 'Google (sends text to Google)']);
  const sel = $('#voice-select');
  const choice = speech.voiceChoice();
  sel.replaceChildren(...opts.map(([value, label]) => h('option', { value, disabled: !value }, label)));
  sel.value = choice;
  $('#voice-field').hidden = false;
}
$('#read-aloud-btn').addEventListener('click', () => {
  const on = !speech.autoRead();
  speech.autoRead(on);
  if (!on) speech.stop();
  renderSpeechBtns();
  toast(on ? 'Claude’s reply is read out each time it finishes' : 'Replies no longer read out — Read aloud under a reply still works');
});
$('#voice-select').addEventListener('change', async e => {
  const value = e.target.value;
  if (value === 'setup') {
    try {
      await api('POST', '/api/voice/install');
      toast('Setting up the natural voice — a few minutes; it shows here when ready');
      setTimeout(loadVoiceStatus, 1000);
    } catch (x) { fail(x); }
    renderSpeechBtns();
    return;
  }
  speech.stop();
  speech.voiceChoice(value);
  renderSpeechBtns();
  if (value.startsWith('natural:')) api('POST', '/api/voice/warm').catch(() => {});
  toast(value === 'google' ? 'Google voice — Chrome sends the reply text to Google to speak it'
    : value === 'device' ? 'This device’s own voice — reply text stays here' : 'Natural voice — made on the PC, reply text stays there');
});
loadVoiceStatus();

// ── default engine (More menu) ───────────────────────────────────────────
// Built here so it appears on a page refresh; hidden until the server knows about Codex.
const engineStatus = h('div', { class: 'engine-status', role: 'status' });
const engineDefaultSel = h('select', { 'aria-label': 'Default engine', onchange: async e => {
  const value = e.target.value;
  try {
    await api('POST', '/api/settings', { defaultEngine: value });
    toast(value === 'codex' ? 'New sessions use Codex unless you pick Claude' : 'New sessions use Claude unless you pick Codex');
  } catch (x) { fail(x); renderEngineSetting(); }
} }, h('option', { value: 'claude' }, 'Claude'), h('option', { value: 'codex' }, 'Codex'));
const engineSetting = h('div', { class: 'engine-setting', hidden: true },
  h('label', { class: 'menu-field', title: 'Which AI new sessions, queue jobs and agents use unless you pick the other one' }, 'Default engine', engineDefaultSel),
  engineStatus);
$('#notify-btn').after(engineSetting);
$('#notify-btn').closest('details').addEventListener('toggle', e => { if (e.target.open && codexOn()) checkCodex(); });

function renderEngineSetting() {
  engineSetting.hidden = !codexOn();
  if (engineSetting.hidden) return;
  if (document.activeElement !== engineDefaultSel) engineDefaultSel.value = defaultEngine();
  engineDefaultSel.options[1].disabled = !codexInstalled() && defaultEngine() !== 'codex';
  const st = S.codexStatus;
  if (!st) { engineStatus.replaceChildren(codexInstalled() ? 'Checking Codex…' : 'Codex isn’t installed on this PC'); return; }
  if (st.error) { engineStatus.replaceChildren(`Couldn’t check Codex: ${st.error}`); return; }
  if (!st.installed) { engineStatus.replaceChildren('Codex isn’t installed on this PC'); return; }
  if (st.signedIn) {
    const plan = st.plan ? ` (${String(st.plan)[0].toUpperCase()}${String(st.plan).slice(1)})` : '';
    engineStatus.replaceChildren(`Signed in as ${st.email ?? 'your ChatGPT account'}${plan}`);
    return;
  }
  if (loginPoll) { engineStatus.replaceChildren('Waiting for you to sign in — finish it in the window that opened'); return; }
  engineStatus.replaceChildren('Not signed in — ', h('button', { class: 'link strong engine-login', type: 'button', onclick: codexLogin }, 'Sign in to Codex'));
}

async function checkCodex() {
  try { S.codexStatus = await api('GET', '/api/codex/status'); }
  catch (x) { S.codexStatus = { error: x.message }; }
  renderEngineSetting();
  return S.codexStatus;
}

// Sign-in happens in a terminal window on this PC; check every 5 seconds for 2 minutes until it has worked.
let loginPoll = null;
let loginRun = 0;
async function codexLogin() {
  try { await api('POST', '/api/codex/login'); } catch (x) { fail(x); return; }
  toast('A Codex sign-in window has opened on this PC');
  clearTimeout(loginPoll);
  const until = Date.now() + 120_000;
  const run = ++loginRun; // a second click starts a fresh chain; the old one stops at its next step
  // A chain of timeouts, not an interval: a slow status check never overlaps the next one.
  const tick = async () => {
    const st = await checkCodex();
    if (run !== loginRun) return;
    if (st?.signedIn || Date.now() > until) {
      loginPoll = null;
      renderEngineSetting();
      if (st?.signedIn) toast(`Signed in to Codex as ${st.email ?? 'your ChatGPT account'}`);
      return;
    }
    loginPoll = setTimeout(tick, 5000);
  };
  loginPoll = setTimeout(tick, 5000);
  renderEngineSetting();
}

// ── Codex (GPT) opt-in (More menu) ───────────────────────────────────────
// Codex is off by default and the page shows nothing of it — except this one quiet item, which is the way in:
// a checklist to install, sign in, set up and check the sandbox, and switch Codex on or off.
const codexMenuBtn = h('button', { type: 'button', id: 'codex-menu', title: 'Add OpenAI Codex as a second engine (off unless you turn it on)',
  onclick: () => { codexMenuBtn.closest('details').open = false; openCodexPanel(); } }, 'Codex (GPT)…');
checkBtn.after(codexMenuBtn);
function renderCodexMenu() {
  codexMenuBtn.textContent = codexUpdateText(S.data?.update) ? 'Codex (GPT)… · update' : 'Codex (GPT)…';
}

let codexPanelRun = 0; // bumped when the panel closes or reopens: its timers stop at their next step
function openCodexPanel() {
  const run = ++codexPanelRun;
  const P = { setup: null, status: null, checking: false, waiting: null };
  const list = h('ol', { class: 'codex-steps' });
  const note = h('p', { class: 'codex-note', role: 'status' });
  const dlg = h('dialog', { class: 'dialog codex-panel', onclose: () => { codexPanelRun++; dlg.remove(); } },
    h('h2', {}, 'Codex (GPT)'),
    h('p', { class: 'codex-intro' }, 'OpenAI’s Codex as a second engine next to Claude, using your ChatGPT plan. Off unless you turn it on; while it’s off Pit Wall works exactly as before.'),
    list, note,
    h('div', { class: 'dialog-actions' }, h('button', { class: 'ghost', type: 'button', onclick: () => dlg.close() }, 'Close')));
  const alive = () => run === codexPanelRun;

  function render() {
    if (!codexSteps) { list.replaceChildren(h('li', {}, 'Restart Pit Wall to set up Codex.')); return; }
    if (!P.setup) { list.replaceChildren(h('li', { class: 'codex-step' }, 'Checking this PC…')); return; }
    list.replaceChildren(...codexSteps(P.setup, P.status, { checking: P.checking }).map(st => h('li', { class: `codex-step${st.done ? ' codex-done' : ''}` },
      h('span', { class: 'codex-mark', 'aria-hidden': 'true' }, st.busy ? '…' : st.done ? '✓' : '○'),
      h('div', { class: 'codex-body' }, h('strong', {}, st.title), h('span', { class: 'codex-detail' }, st.detail)),
      st.action ? h('button', { type: 'button', class: st.action.id === 'enable' && !P.setup.enabled ? 'primary small' : 'ghost small', onclick: e => act(st.action.id, e.target) }, st.action.label) : null)));
    note.textContent = P.waiting ?? '';
  }
  async function loadSetup() {
    try { P.setup = await api('GET', '/api/codex/setup'); } catch (x) { if (alive()) { note.textContent = x.message; } return; }
    if (!alive()) return;
    render();
    // The newest version is looked up on npm in the background the first time: ask once more so "Update Codex" can show.
    if (P.setup.latestChecking && !P.latestRetried) { P.latestRetried = true; setTimeout(() => { if (alive()) loadSetup(); }, 5000); }
  }
  async function loadStatus() {
    if (!P.setup?.installed) { P.status = null; return; }
    try { P.status = await api('GET', '/api/codex/status'); } catch { P.status = { installed: true, signedIn: false, sandbox: null }; }
    S.codexStatus = P.status; // the More menu's sign-in line uses the same reading
    if (alive()) render();
  }
  /** Re-check until done() says so, backing off (3 s, 5 s, 8 s … up to 20 s) and giving up after `forMs`. */
  function poll(load, done, forMs, waiting) {
    const until = Date.now() + forMs;
    let wait = 3000;
    P.waiting = waiting;
    render();
    const tick = async () => {
      if (!alive()) return;
      await load();
      if (!alive()) return;
      if (done() || Date.now() > until) { P.waiting = null; render(); return; }
      wait = Math.min(Math.round(wait * 1.6), 20_000);
      setTimeout(tick, wait);
    };
    setTimeout(tick, wait);
  }
  async function act(id, btn) {
    btn.disabled = true;
    try {
      if (id === 'install') {
        await api('POST', '/api/codex/install');
        poll(async () => { await loadSetup(); if (!P.setup?.install?.running) await loadStatus(); }, () => !P.setup?.install?.running, 6 * 60_000,
          'Installing with npm — this window can stay open or be closed.');
      } else if (id === 'login') {
        await api('POST', '/api/codex/login');
        toast('A Codex sign-in window has opened on this PC');
        poll(loadStatus, () => P.status?.signedIn, 3 * 60_000, 'Waiting for you to sign in — finish it in the window that opened.');
      } else if (id === 'sandbox') {
        await api('POST', '/api/codex/sandbox');
        poll(loadStatus, () => P.status?.sandbox === 'ready', 5 * 60_000,
          'Windows asks you to allow it (admin). A blue window shows the result; close it when it says Finished, then press Check now.');
      } else if (id === 'check') {
        P.checking = true; render();
        try { P.setup = { ...P.setup, check: await api('POST', '/api/codex/sandbox/check') }; } finally { P.checking = false; }
        await loadStatus();
      } else if (id === 'enable') {
        const on = !P.setup.enabled;
        await api('POST', '/api/codex/enable', { enabled: on });
        toast(on ? 'Codex is on — pick it when you start a session' : 'Codex is off — Pit Wall uses Claude only');
        await loadSetup();
      }
    } catch (x) { fail(x); }
    finally { if (alive()) render(); }
  }

  document.body.append(dlg);
  dlg.showModal();
  render();
  loadSetup().then(loadStatus);
}

// Tell the server which chat is on screen, so it doesn't notify about the one you're reading.
function reportViewing() {
  fetch('/api/viewing', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: S.selected, visible: !document.hidden && !!S.selected }) }).catch(() => {});
}
document.addEventListener('visibilitychange', reportViewing);
setInterval(reportViewing, 20_000);

// A notification link (/?s=<id>) opens that chat once the board has loaded.
const openOnLoad = new URLSearchParams(location.search).get('s');
if (openOnLoad) history.replaceState(null, '', '/');

more.init({ S, h, api, toast, fail, ago, folder, openChat, renderView, setView, $ });
extras.init({ S, h, api, toast, fail, openChat, $, speech });

// New session form: templates, model suggestion, dictation.
{
  const f = $('#new-form');
  more.modelHint(f.elements.message, f.elements.model, $('#new-model-hint'));
  more.slashMenu(f.elements.message, () => f.elements.cwd.value, { below: true });
  const mic = more.voiceButton(f.elements.message);
  if (mic) f.querySelector('.new-images').append(mic);
}

startStarfield($('#stars'));
connect();
setInterval(() => { if (S.data && S.view === 'board' && !document.hidden) renderBoard(); }, 30_000);
