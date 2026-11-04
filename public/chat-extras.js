// What a terminal chat can do that Pit Wall's chat now does too: /btw side questions, forking from a reply, rewinding
// to one of your messages, queued messages you can take back or send now, plan approval, background tasks with Stop,
// Claude's thinking, and a colour for the chat on the board.
import { renderMarkdown } from './markdown.js';

let D; // { S, h, api, toast, fail, openChat, $, speech } — speech is null when speech.js didn't load or the browser can't speak
export function init(deps) { D = deps; }

const isTerminal = () => D.S.data?.sessions.find(s => s.id === D.S.selected)?.source === 'terminal' && !D.S.chat?.run?.running;
const isCodexChat = () => (D.S.data?.sessions.find(s => s.id === D.S.selected) ?? D.S.chat?.run)?.engine === 'codex';
const busy = () => ['busy', 'starting', 'needs_you'].includes(D.S.chat?.run?.status);

// ── message actions ─────────────────────────────────────────────────────
/** Small actions shown on hover under one of your messages: Rewind (sent), Take back / Send now (still queued). */
export function userActions(item) {
  const { h } = D;
  if (!item.uuid) return null;
  return h('div', { class: 'msg-actions', 'data-for': item.uuid },
    h('span', { class: 'queued-chip' }, isCodexChat() ? 'Queued — read after its current step' : 'Queued — Claude reads it after its current step'),
    h('button', { class: 'link q-only', type: 'button', onclick: () => queued(item.uuid, 'cancel') }, 'Take back'),
    h('button', { class: 'link q-only', type: 'button', title: 'Stop what Claude is doing and start on this now', onclick: () => queued(item.uuid, 'now') }, 'Send now'),
    h('button', { class: 'link sent-only', type: 'button', title: 'Go back to before this message (and optionally undo Claude’s file changes since)',
      onclick: () => rewindDialog(item) }, 'Rewind to here'));
}

/**
 * Under a reply: "Read aloud" on any reply with words in it, and "Fork from here" on a finished one (which replies
 * qualify is worked out after rendering, markActions).
 */
export function replyActions(item) {
  const { h } = D;
  const read = D.speech && item.text ? h('button', { class: 'link speak-btn', type: 'button', title: 'Read this reply out loud (code and tables are skipped)',
    onclick: e => { if (!item.uuid) e.currentTarget.closest('.msg').dataset.speakKey = speakKey(item); toggleSpeak(item); } }, 'Read aloud') : null;
  const fork = item.uuid ? h('button', { class: 'link fork-only', type: 'button', title: 'Start a new chat that carries on from this reply; this one stays as it is',
    onclick: () => forkDialog(item.uuid) }, 'Fork from here') : null;
  if (!read && !fork) return null;
  return h('div', { class: 'msg-actions reply-actions' }, read, fork);
}

// ── reading replies aloud ───────────────────────────────────────────────
let speakSeq = 0;
const speakKey = item => item.uuid ?? (item.speakKey ??= `r${++speakSeq}`);

/** Starts reading a reply, or stops it if it's the one being read. */
function toggleSpeak(item) {
  const key = speakKey(item);
  if (D.speech.speakingId() === key) { D.speech.stop(); return; }
  D.speech.speak(item.text, { id: key, done: err => { markSpeaking(null); if (err) D.toast(err, true); }, note: msg => D.toast(msg, true) }).catch(e => { markSpeaking(null); D.toast(e.message, true); });
  markSpeaking(key);
}

/** Shows which reply is being read: its button says "Stop reading". */
function markSpeaking(key) {
  for (const m of D.$('#stream')?.querySelectorAll('.msg.assistant') ?? []) {
    const on = !!key && (m.dataset.uuid === key || m.dataset.speakKey === key);
    if (m.classList.contains('speaking') === on) continue; // markActions runs per message; only touch what changed
    m.classList.toggle('speaking', on);
    const b = m.querySelector('.speak-btn');
    if (b) b.textContent = on ? 'Stop reading' : 'Read aloud';
  }
}

let heard = { sid: null, uuid: null }; // the newest finished reply seen in the open chat, so each is read out only once
/** With "Read replies aloud" on, reads the reply that just finished a turn — never older ones already in the chat. */
function autoSpeak(last) {
  const sid = D.S.selected;
  const uuid = last?.dataset.uuid ?? null;
  // Just opened, still loading or redrawn whole (reload, Load earlier): what's there was already written, so it only
  // sets the starting point.
  if (heard.sid !== sid || D.S.chat?.loading || D.S.chat?.redrawing) { heard = { sid, uuid }; return; }
  if (!uuid || uuid === heard.uuid) return;
  heard.uuid = uuid;
  const item = D.S.chat?.live?.find(i => i.kind === 'assistant' && i.uuid === uuid);
  if (item && D.speech?.autoRead()) toggleSpeak(item);
}

/**
 * Marks which messages show which actions: a reply can be forked from only when it ended its turn (the last reply before
 * one of your messages, or the last one when Claude is idle); your messages show Rewind once sent, the queue actions
 * while waiting. Terminal-held chats get neither.
 */
export function markActions() {
  const st = D.$('#stream');
  if (!st) return;
  const term = isTerminal();
  const queuedIds = new Set((D.S.chat?.run?.queued ?? []).map(q => q.uuid));
  const msgs = [...st.querySelectorAll('.msg.user[data-uuid], .msg.assistant[data-uuid]')];
  msgs.forEach((m, i) => {
    if (m.classList.contains('user')) {
      m.classList.toggle('queued', queuedIds.has(m.dataset.uuid));
      m.classList.toggle('can-act', !term);
      return;
    }
    const next = msgs[i + 1];
    const ended = next ? next.classList.contains('user') : !busy();
    m.classList.toggle('turn-end', ended);
    m.classList.toggle('forkable', !term && ended);
  });
  if (!D.speech) return;
  markSpeaking(D.speech.speakingId()); // the chat may have just been redrawn mid-read
  autoSpeak(msgs.filter(m => m.classList.contains('turn-end')).pop());
}

async function queued(uuid, what) {
  try {
    await D.api('POST', `/api/sessions/${D.S.selected}/queued/${uuid}?do=${what === 'now' ? 'now' : 'cancel'}`);
    D.toast(what === 'now' ? 'Sent — Claude starts on it now' : 'Message taken back');
  } catch (e) { D.fail(e); }
}

// ── fork ────────────────────────────────────────────────────────────────
export function forkDialog(atUuid = null) {
  const { h, S } = D;
  const sid = S.selected;
  const text = h('textarea', { rows: 4, placeholder: 'What should the fork do differently? This is its first message.', required: true });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const dlg = h('dialog', { class: 'dialog', onclose: () => dlg.remove() },
    h('h2', {}, atUuid ? 'Fork from this reply' : 'Fork this chat'),
    h('p', { class: 'pdesc' }, 'A new chat starts with everything up to ', atUuid ? 'this reply' : 'the latest reply',
      '. This chat stays exactly as it is. Permissions you allowed “for this session” are not carried over.'),
    h('form', { onsubmit: async e => {
      e.preventDefault();
      e.submitter && (e.submitter.disabled = true);
      try {
        const { id } = await D.api('POST', `/api/sessions/${sid}/fork`, { atUuid, message: text.value });
        dlg.close();
        D.toast('Fork started');
        setTimeout(() => D.openChat(id), 300);
      } catch (x) { err.textContent = x.message; e.submitter && (e.submitter.disabled = false); }
    } },
      h('label', {}, 'First message', text), err,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'ghost', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { class: 'primary', type: 'submit' }, 'Start fork'))));
  document.body.append(dlg);
  dlg.showModal();
  text.focus();
}

/** The newest reply that ended a turn, for "Fork" in the chat menu. */
export function lastForkable() {
  const m = [...(D.$('#stream')?.querySelectorAll('.msg.assistant.forkable[data-uuid]') ?? [])].pop();
  return m?.dataset.uuid ?? null;
}

// ── rewind ──────────────────────────────────────────────────────────────
async function rewindDialog(item) {
  const { h, S } = D;
  const sid = S.selected;
  const files = h('div', { class: 'rw-files' }, h('p', { class: 'hint' }, isCodexChat() ? '' : 'Checking which files Claude changed since…'));
  const undo = h('input', { type: 'checkbox' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const go = h('button', { class: 'danger', type: 'button' }, 'Rewind');
  const dlg = h('dialog', { class: 'dialog', onclose: () => dlg.remove() },
    h('h2', {}, 'Rewind to before this message'),
    h('p', { class: 'pdesc' }, `This message and everything after it leave the chat (${isCodexChat() ? 'Codex' : 'Claude'} forgets them). Your message comes back in the box so you can change it and send it again.`),
    h('blockquote', { class: 'rw-quote' }, String(item.text ?? '').slice(0, 400)),
    files, err,
    h('div', { class: 'dialog-actions' }, h('button', { class: 'ghost', type: 'button', onclick: () => dlg.close() }, 'Cancel'), go));
  document.body.append(dlg);
  dlg.showModal();
  go.onclick = async () => {
    go.disabled = true;
    try {
      const r = await D.api('POST', `/api/sessions/${sid}/rewind`, { uuid: item.uuid, files: !isCodexChat() && undo.checked });
      dlg.close();
      const input = D.$('#input');
      if (input && S.selected === sid) { input.value = r.prefillText || item.text || ''; input.dispatchEvent(new Event('input')); input.focus(); }
      D.toast(!isCodexChat() && undo.checked ? 'Rewound — files put back too' : 'Rewound');
    } catch (x) { err.textContent = x.message; go.disabled = false; }
  };
  try {
    const p = await D.api('POST', `/api/sessions/${sid}/rewind-preview`, { uuid: item.uuid });
    const changed = p.filesChanged ?? [];
    if (p.codex) files.replaceChildren(h('p', { class: 'hint' }, p.error ?? 'Codex rewind doesn’t undo file changes.'));
    else if (p.canRewind && changed.length) {
      files.replaceChildren(h('label', { class: 'check' }, undo, ` Also undo Claude’s changes to ${changed.length} file${changed.length === 1 ? '' : 's'}`,
        p.insertions != null ? h('span', { class: 'hint' }, ` (+${p.insertions} / −${p.deletions} lines)`) : null),
        h('ul', { class: 'rw-list' }, changed.slice(0, 12).map(f => h('li', {}, f)), changed.length > 12 ? h('li', {}, `…and ${changed.length - 12} more`) : null),
        h('p', { class: 'hint' }, 'Only edits Claude made with its edit tools are undone — not changes made by commands it ran.'));
    } else if (p.canRewind) files.replaceChildren(h('p', { class: 'hint' }, 'Claude has not changed any files since this message.'));
    else files.replaceChildren(h('p', { class: 'hint' }, 'Undoing file changes isn’t available for this chat (it started before Pit Wall kept file checkpoints). The conversation can still be rewound.'));
  } catch { files.replaceChildren(h('p', { class: 'hint' }, 'Couldn’t check the files; the conversation can still be rewound.')); }
}

// ── /btw ────────────────────────────────────────────────────────────────
/** A side panel for quick questions about the chat: answered from the conversation, no tools, nothing added to it. */
export function toggleBtw() {
  const { h, S } = D;
  const pane = D.$('#chat');
  let panel = D.$('#btw');
  if (panel) { panel.remove(); return; }
  S.btw ??= new Map();
  const sid = S.selected;
  const list = h('div', { class: 'btw-list' });
  const input = h('textarea', { rows: 2, placeholder: 'Ask about this chat — e.g. “what did we decide about the cache?”' });
  const draw = () => {
    const hist = S.btw.get(sid) ?? [];
    list.replaceChildren(...(hist.length ? hist.map(x => h('div', { class: 'btw-qa' }, h('div', { class: 'btw-q' }, x.question),
      x.response == null ? h('div', { class: 'hint' }, 'Thinking…') : h('div', { class: 'btw-a', html: renderMarkdown(x.response) })))
      : [h('p', { class: 'hint' }, 'Answers come from the conversation so far. Nothing here is added to the chat, and Claude uses no tools for it — you can ask while it works.')]));
    list.scrollTop = list.scrollHeight;
  };
  const ask = async () => {
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    const hist = S.btw.get(sid) ?? [];
    const entry = { question: q, response: null };
    S.btw.set(sid, [...hist, entry]);
    draw();
    try {
      const r = await D.api('POST', `/api/sessions/${sid}/btw`, { question: q, history: hist.filter(x => x.response != null) });
      entry.response = r.response ?? '';
    } catch (e) { entry.response = `_Couldn’t ask: ${e.message}_`; }
    if (D.S.selected === sid) draw();
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } });
  panel = h('aside', { class: 'btw', id: 'btw', 'aria-label': 'Side questions' },
    h('div', { class: 'btw-head' }, h('strong', {}, 'btw'), h('span', { class: 'hint' }, ' side questions — not added to the chat'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close side questions', onclick: () => panel.remove() }, '×')),
    list,
    h('div', { class: 'btw-ask' }, input, h('button', { class: 'primary small', type: 'button', onclick: ask }, 'Ask')));
  pane.append(panel);
  draw();
  input.focus();
}

/** The open chat changed: a panel left open belongs to the old one. */
export function closeBtw() { D.$('#btw')?.remove(); }

// ── plan approval ───────────────────────────────────────────────────────
/** ExitPlanMode: the plan as formatted text, and how to carry on once it is approved. */
export function planCard(p, answer) {
  const { h } = D;
  const feedback = h('textarea', { rows: 2, placeholder: 'What should change in the plan?' });
  const approve = mode => answer(p, { behavior: 'allow', mode });
  return h('div', { class: 'ask plan-ask', role: 'group', 'aria-label': 'Claude’s plan' },
    h('h4', {}, 'Claude’s plan — approve to start'),
    h('div', { class: 'plan-body msg assistant', html: renderMarkdown(String(p.input?.plan ?? '')) }),
    h('div', { class: 'ask-actions' },
      h('button', { class: 'primary', type: 'button', title: 'Carry on in auto mode', onclick: () => approve('auto') }, 'Approve — auto'),
      h('button', { class: 'ghost', type: 'button', title: 'Approve; file edits go ahead, other actions ask', onclick: () => approve('acceptEdits') }, 'Approve — accept edits'),
      h('button', { class: 'ghost', type: 'button', title: 'Approve; ask before every action', onclick: () => approve('manual') }, 'Approve — ask each time')),
    h('details', { class: 'plan-more' }, h('summary', {}, 'Keep planning'),
      feedback,
      h('button', { class: 'ghost small', type: 'button', onclick: () => answer(p, { behavior: 'deny', message: feedback.value.trim() || 'Keep planning — not approved yet.' }) }, 'Send back')));
}

// ── background tasks ────────────────────────────────────────────────────
const TASK_WORDS = { local_bash: 'command', local_agent: 'agent', remote_agent: 'agent', local_workflow: 'workflow' };
function since(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}
const taskMeta = (word, startedAt) => `${word}${startedAt ? ` · ${since(startedAt)}` : ''}`;
// The strip only redraws on chat events, so keep the running times counting between them.
setInterval(() => {
  for (const el of document.querySelectorAll('#tasks .task-meta[data-start]:not([data-start=""])')) {
    const text = taskMeta(el.dataset.word, el.dataset.start);
    if (el.textContent !== text) el.textContent = text;
  }
}, 5000);
/** The open chat's background commands (agents and workflows are in the agents panel), how long each has run, and a Stop button. */
export function renderTasks() {
  const { h } = D;
  const box = D.$('#tasks');
  if (!box) return;
  // Agents and workflows are listed in the agents panel; this strip keeps the rest (commands).
  const jobs = D.S.chat?.run?.running ? (D.S.chat.run.jobs ?? []).filter(j => !['local_agent', 'remote_agent', 'local_workflow'].includes(j.type)) : [];
  box.hidden = !jobs.length;
  if (!jobs.length) { box.replaceChildren(); return; }
  box.replaceChildren(h('span', { class: 'tasks-label' }, 'In the background'),
    ...jobs.map(j => h('span', { class: 'task' },
      h('span', { class: `task-dot${j.working ? ' on' : ''}` }),
      h('span', { class: 'task-name', title: j.description }, j.description || 'task'),
      h('span', { class: 'task-meta', 'data-word': TASK_WORDS[j.type] ?? j.type ?? '', 'data-start': j.startedAt ?? '' }, taskMeta(TASK_WORDS[j.type] ?? j.type ?? '', j.startedAt)),
      h('button', { class: 'link', type: 'button', title: 'Stop just this task; the chat carries on', onclick: async e => {
        e.currentTarget.disabled = true;
        try { await D.api('POST', `/api/sessions/${D.S.selected}/tasks/${encodeURIComponent(j.id)}`); D.toast('Stopping it'); } catch (x) { D.fail(x); }
      } }, 'Stop'))));
}

// ── thinking ────────────────────────────────────────────────────────────
export function thinkingEl(item) {
  const { h } = D;
  return h('details', { class: 'thinking' }, h('summary', {}, 'Thinking'), h('div', { class: 'thinking-body', html: renderMarkdown(item.text) }));
}

// ── colour ──────────────────────────────────────────────────────────────
export const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'teal', 'cyan', 'brown', 'grey', 'black'];
/** Colour swatches for the chat menu; the board row keeps the colour until you clear it. */
export function colorRow(s) {
  const { h } = D;
  const set = color => D.api('PATCH', `/api/sessions/${s.id}`, { color }).catch(D.fail);
  return h('div', { class: 'menu-field color-row', role: 'group', 'aria-label': 'Colour on the board' }, h('span', {}, 'Colour'),
    h('span', { class: 'swatches' },
      ...COLORS.map(c => h('button', { type: 'button', class: `swatch c-${c}`, 'aria-label': c, 'aria-pressed': String(s.color === c), title: c, onclick: () => set(c) })),
      h('button', { type: 'button', class: 'swatch none', 'aria-label': 'No colour', 'aria-pressed': String(!s.color), title: 'No colour', onclick: () => set(null) }, '×')));
}
