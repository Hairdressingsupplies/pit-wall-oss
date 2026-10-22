// public/engine-text.js — wording that depends on the chat's engine. Pure (no DOM), so test/engine-text.test.mjs can check it.
// The Claude strings are exactly what the page always said.

/** The heading and "Always allow" tooltip of a permission card. */
export function permissionText(toolName, codex = false) {
  return codex
    ? { heading: `Codex wants to use ${toolName}`, alwaysTitle: 'Allow this for the rest of this chat (runs outside the sandbox)' }
    : { heading: `Claude wants to use ${toolName}`, alwaysTitle: 'Adds an allow rule to this folder’s local Claude settings' };
}

/** The New session message placeholder (index.html holds the Claude one) for the engine picked. */
export function newMessagePlaceholder(claudePlaceholder, codex = false) {
  return codex ? claudePlaceholder.replace('What should Claude work on?', 'What should Codex work on?') : claudePlaceholder;
}

/** Whether a chat can fork / rewind / btw: 'claude' (always), 'codex' (its live bridge branches), 'codex-nobranch' (parked or old). */
export function branchState(session, run) {
  if ((session ?? run)?.engine !== 'codex') return 'claude';
  return run?.codexBranching ? 'codex' : 'codex-nobranch';
}

// ── Codex (GPT) panel (More › Codex (GPT)…) ────────────────────────────────────────────────────────────────────────

const newer = (a, b) => {
  const p = v => String(v ?? '').match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const x = p(a), y = p(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

/** One line about a newer Codex for the update dialog, from the update info's { codexInstalled, codexLatest } (null: nothing to say). */
export function codexUpdateText(u) {
  if (!u?.codexInstalled || !newer(u.codexLatest, u.codexInstalled)) return null;
  return `Codex ${u.codexLatest} is out (you have ${u.codexInstalled}) — update it from More › Codex (GPT)…`;
}

const planName = p => (p ? ` (${String(p)[0].toUpperCase()}${String(p).slice(1)})` : '');
const when = iso => { try { return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

/** What the last sandbox check found, in a sentence. */
function checkText(c) {
  if (!c) return 'Not checked yet. It takes a few seconds and uses no Codex messages.';
  if (c.error) return c.error;
  const at = c.at ? `Checked ${when(c.at)}: ` : '';
  if (c.ok) return `${at}edits stay inside the chat’s folder and the internet is blocked.`;
  const leaks = [c.writesOutsideBlocked === false && 'it could write outside the chat’s folder', c.networkBlocked === false && 'it could reach the internet'].filter(Boolean);
  if (leaks.length) return `${at}not safe — ${leaks.join(' and ')}. Set up the sandbox, then check again.`;
  if (c.mode === 'read-only') return `${at}read-only mode — every file edit asks you first (nothing outside the folder or online got through).`;
  if (c.writesInside === false) return `${at}Codex couldn’t write inside the chat’s folder, so edits would fail.`;
  return `${at}the check didn’t finish (${c.networkBlocked == null ? 'couldn’t test the internet' : 'unclear result'}).`;
}

/**
 * The panel's checklist from GET /api/codex/setup and GET /api/codex/status (null while loading).
 * Each step: { id, title, done, detail, action: { id, label } | null, busy? }.
 */
export function codexSteps(setup, status, { checking = false } = {}) {
  const s = setup ?? {};
  const installed = !!s.installed;
  const ready = installed && !s.install?.running; // nothing else can happen while Codex is being replaced
  const remote = !!s.remote;
  const install = s.install ?? {};
  const steps = [];

  steps.push({ id: 'install', title: 'Install Codex', done: installed, busy: !!install.running,
    detail: install.running ? 'Installing… this can take a few minutes.'
      : install.error ? install.error
      : !installed ? 'Codex isn’t on this PC yet.'
      : s.updateAvailable ? `Version ${s.version} — ${s.latest} is out.`
      : s.version ? `Version ${s.version}${s.latest ? ' (the newest)' : ''}.` : 'Installed.',
    action: install.running ? null : !installed ? { id: 'install', label: 'Install Codex' } : s.updateAvailable ? { id: 'install', label: 'Update Codex' } : null });

  const signedIn = !!status?.signedIn;
  steps.push({ id: 'signin', title: 'Sign in with ChatGPT', done: signedIn,
    detail: !ready ? 'After installing.' : !status ? 'Checking…' : signedIn ? `Signed in as ${status.email ?? 'your ChatGPT account'}${planName(status.plan)}`
      : remote ? 'Not signed in. Sign in at the PC.' : 'Not signed in.',
    action: ready && status && !signedIn && !remote ? { id: 'login', label: 'Sign in' } : null });

  const box = status?.sandbox ?? null;
  steps.push({ id: 'sandbox', title: 'Set up the sandbox', done: box === 'ready',
    detail: !ready ? 'After installing.' : !status ? 'Checking…'
      : box === 'ready' ? 'Sandbox ready — Codex edits files in the chat’s folder, with no internet.'
      : box === 'updateRequired' ? 'The sandbox needs to be set up again (Codex was updated). Until then: read-only mode — every file edit asks you.'
      : box === 'notConfigured' ? 'Read-only mode — every file edit asks you. Setting up needs Windows admin approval once.'
      : 'Couldn’t read the sandbox state.',
    action: ready && status && box !== 'ready' && !remote ? { id: 'sandbox', label: 'Set up the sandbox' } : null });

  steps.push({ id: 'check', title: 'Check the sandbox', done: !!s.check?.ok, busy: checking || !!s.checking,
    detail: checking || s.checking ? 'Checking…' : checkText(s.check),
    action: ready && !(checking || s.checking) ? { id: 'check', label: 'Check now' } : null });

  steps.push({ id: 'enable', title: 'Turn Codex on', done: !!s.enabled,
    detail: s.enabled ? 'On — pick Codex for a chat, or make it the default (More › Default engine).' : 'Off — Pit Wall uses Claude only.',
    action: { id: 'enable', label: s.enabled ? 'Turn Codex off' : 'Turn Codex on' } });
  return steps;
}

// ── header gauges ────────────────────────────────────────────────────────────────────────────────────────────────

const hasReading = r => !!r?.unifiedWindows;

/**
 * What the header rings show: the default engine's reading (GPT's when the default is Codex and Codex has reported),
 * else Claude's. `other` is the other engine for the tooltip; `label` is 'GPT' only when GPT's reading is the one shown.
 */
export function gaugeView(usage, engine) {
  const u = usage ?? {};
  if (engine === 'codex' && hasReading(u.rateCodex)) return { label: 'GPT', rate: u.rateCodex, burn: u.burnCodex ?? null, other: { label: 'Claude', rate: u.rate ?? null } };
  return { label: '', rate: u.rate ?? null, burn: u.burn ?? null, other: { label: 'GPT', rate: u.rateCodex ?? null } };
}
