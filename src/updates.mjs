// Checks GitHub for a newer Pit Wall: fetch, then compare this copy with origin. An update is offered only when this
// copy is simply behind — no commits of its own and no changed files — so updating is a plain fast-forward.
import { execFile } from 'node:child_process';

// Never ask for a password: a check runs unattended, and a prompt would hang it.
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

export function git(root, args, { timeout = 60_000 } = {}) {
  return new Promise(resolve => {
    execFile('git', ['-C', root, ...args], { env: ENV, timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr || err?.message || '').trim() }));
  });
}

/** "2\t5" from rev-list --left-right --count HEAD...@{u} → { ahead: 2, behind: 5 } */
export function parseCounts(out) {
  const [ahead, behind] = String(out).trim().split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0 };
}

/** What the page shows. canUpdate: safe to fast-forward and restart. */
export function updateState({ ahead, behind, dirty, subjects = [], checkedAt, error = null }) {
  return { ahead, behind, dirty, subjects, checkedAt, error, canUpdate: !error && behind > 0 && ahead === 0 && !dirty };
}

export async function checkUpdates(root, run = git) {
  const checkedAt = new Date().toISOString();
  const fetch = await run(root, ['fetch', '--quiet', 'origin']);
  if (!fetch.ok) {
    // Git wanted to ask for a GitHub login: unattended checks need it to use the GitHub CLI's (gh auth setup-git).
    const login = /prompt|username|interactivity|authentication/i.test(fetch.err);
    return updateState({ ahead: 0, behind: 0, dirty: false, checkedAt, error: login
      ? 'Pit Wall can’t sign in to GitHub on its own to check for updates. Ask Claude to run: gh auth setup-git'
      : `Couldn't reach GitHub: ${fetch.err.split('\n')[0]}` });
  }
  const counts = await run(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  if (!counts.ok) return updateState({ ahead: 0, behind: 0, dirty: false, checkedAt, error: 'This copy has no upstream branch to compare with.' });
  const { ahead, behind } = parseCounts(counts.out);
  const status = await run(root, ['status', '--porcelain', '--untracked-files=no']);
  const log = behind ? await run(root, ['log', '--format=%s', '-n', '12', 'HEAD..@{u}']) : { out: '' };
  return updateState({ ahead, behind, dirty: !!status.out, subjects: log.out ? log.out.split('\n') : [], checkedAt });
}
