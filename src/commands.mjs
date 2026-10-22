// Slash commands for the chat box's suggestions. The real list comes from Claude Code itself: every
// headless run announces what it accepts in its init event (built-ins, your skills, plugin skills).
// Pit Wall keeps the latest list per folder in data/slash-commands.json so suggestions work before a
// chat has started and after a restart.
import fs from 'node:fs';

/** Everyday commands, shown first when you type just "/". */
const PINNED = ['usage', 'context', 'compact', 'model', 'effort', 'recap'];

/** Accepted headless but wrong for Pit Wall: /clear swaps the session id under the chat (use Fresh start). */
const HIDDEN = new Set(['clear', 'heapdump', 'workflow-launch-exec', 'design-consent', 'design-revoke']);

const BUILTIN = {
  usage: 'Your 5-hour and weekly plan usage',
  context: 'What is filling this chat’s context',
  compact: 'Summarise the chat so far to free up context — add instructions after it if you like',
  model: 'Switch model for this chat, e.g. /model sonnet',
  effort: 'Set thinking effort, e.g. /effort high',
  recap: 'A short recap of the session so far',
  fast: 'Toggle fast mode',
  rename: 'Rename this session',
  goal: 'Set a goal Claude keeps working towards',
  insights: 'A report on how you use Claude Code',
  'usage-credits': 'Usage credits on your plan',
  'extra-usage': 'Extra usage beyond your plan',
  agents: 'Manage subagents',
  'list-agents': 'List available subagents',
  advisor: 'Advisor settings',
  autocompact: 'Automatic compaction settings',
  config: 'Claude Code settings',
  'output-style': 'Change the output style',
  mcp: 'MCP servers',
  init: 'Write a CLAUDE.md for this folder',
  'reload-skills': 'Pick up skills added since the chat started',
  'skill-doctor': 'Check your skills for problems',
  ultrareview: 'Deep multi-agent cloud review of this branch (billed)',
};

const HANDOFF_PROMPT = 'Write a self-contained, copy-paste prompt that hands this work to another Claude session (on another PC or a teammate\'s): the goal, what\'s done, what\'s left, key files and decisions, and the exact next step. Put the prompt in one fenced block.';

/** "Write a handoff": your /handoff skill where a Claude chat has it (inside Documents\GitHub); Codex has no skills, so plain text. */
export function handoffText(engine, insideWorkspace) {
  return engine !== 'codex' && insideWorkspace ? '/handoff' : HANDOFF_PROMPT;
}

export function loadCommandCache(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { byCwd: {}, latest: null }; }
}

export function saveCommandCache(file, cache, cwd, names) {
  const key = String(cwd ?? '').toLowerCase();
  cache.byCwd[key] = names;
  cache.latest = names;
  try { fs.writeFileSync(file, JSON.stringify(cache)); } catch { /* suggestions only */ }
}

/**
 * Suggestions for one folder: [{ name, description, kind: 'command'|'skill' }], pinned first, then
 * built-ins, then skills. `names` is what Claude Code announced (null before any run has started);
 * `skills` come from listSkills() for their descriptions and as the fallback list.
 */
export function buildCommands(names, skills) {
  const skillByName = new Map(skills.map(s => [s.name, s]));
  const list = names ?? [...PINNED, ...Object.keys(BUILTIN), ...skills.map(s => s.name)];
  const seen = new Set();
  const out = [];
  for (const name of list) {
    if (!name || seen.has(name) || HIDDEN.has(name) || name.startsWith('_')) continue;
    seen.add(name);
    // Anything not in the built-in map is a skill (yours, a plugin's, or one bundled with Claude Code).
    out.push({ name, description: BUILTIN[name] ?? skillByName.get(name)?.description ?? '', kind: name in BUILTIN ? 'command' : 'skill' });
  }
  const rank = c => { const p = PINNED.indexOf(c.name); return p >= 0 ? p : c.kind === 'command' ? 100 : 200; };  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
