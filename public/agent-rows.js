// Pure helpers for the agents panel above the composer — no DOM, so node tests can import them.

/** Drops the words every label starts with ("Hunter h01: …", "Hunter h02: …" → "h01: …"), keeping each label non-empty. */
export function stripCommonPrefix(labels) {
  if (labels.length < 2) return labels;
  const words = labels.map(l => String(l).split(' '));
  let n = 0;
  while (words.every(w => w.length > n + 1 && w[n] === words[0][n])) n++;
  return words.map(w => w.slice(n).join(' '));
}

/** "h01: public analytics ingest" → { id: 'h01', name: 'public analytics ingest' }; a label without a short "id:" keeps it all as the name. */
export function splitId(label) {
  const m = /^([\w.-]{1,10}):\s+(.+)$/.exec(String(label ?? '').trim());
  return m ? { id: m[1], name: m[2] } : { id: '', name: String(label ?? '').trim() };
}

const VERBS = { Read: 'reading', Grep: 'searching', Glob: 'finding files', Edit: 'editing', MultiEdit: 'editing', Write: 'writing',
  NotebookEdit: 'editing', Bash: 'running', PowerShell: 'running', WebFetch: 'fetching', WebSearch: 'searching the web',
  Agent: 'starting an agent', Task: 'starting an agent', Skill: 'using a skill', TodoWrite: 'updating its to-dos', ToolSearch: 'loading tools' };

/** What an agent is doing, in words: "Bash cd …/src && sed -n 1,60p x" → "running sed -n 1,60p x". */
export function doingLabel(tool, summary = '', max = 70) {
  if (!tool) return '';
  let s = String(summary ?? '').replace(/\s+/g, ' ').trim();
  if (tool === 'Bash' || tool === 'PowerShell') s = s.replace(/^(?:cd\s+\S+\s*(?:&&|;)\s*)+/, '');
  const text = `${VERBS[tool] ?? tool}${s ? ` ${s}` : ''}`;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const RANK = { failed: 0, quiet: 1, running: 2, queued: 3, done: 4 };
/** Failed and quiet agents first — the ones worth a look — then the rest, oldest first. */
export function sortRows(rows) {
  const rank = r => RANK[r.quiet && r.state === 'running' ? 'quiet' : r.state] ?? 9;
  return [...rows].sort((a, b) => rank(a) - rank(b) || (a.startedAt ?? 0) - (b.startedAt ?? 0));
}
