// Light theme by default; other themes are picked from the Theme menu and remembered on this PC.
// Runs before the app so the page never flashes the wrong theme.
// "light" and "dark" keep their old ids so a choice saved before the Theme menu still works.
export const THEMES = [
  { id: 'light', label: 'Classic', mode: 'light' },
  { id: 'paper', label: 'Paper', mode: 'light' },
  { id: 'slate', label: 'Slate', mode: 'light' },
  { id: 'telemetry', label: 'Telemetry', mode: 'light' },
  { id: 'dark', label: 'Space', mode: 'dark' },
  { id: 'refined', label: 'Refined space', mode: 'dark' },
  { id: 'graphite', label: 'Graphite', mode: 'dark' },
  { id: 'midnight', label: 'Midnight', mode: 'dark' },
  { id: 'synthwave', label: 'Synthwave', mode: 'dark', group: 'Fun' },
  { id: 'phosphor', label: 'Phosphor', mode: 'dark', group: 'Fun' },
  { id: 'pitlane', label: 'Pit lane', mode: 'light', group: 'Fun' },
];
const KEY = 'pitwall-theme';

function apply(id) {
  const t = THEMES.find(x => x.id === id) || THEMES[0];
  document.documentElement.dataset.theme = t.mode;
  document.documentElement.dataset.variant = t.id;
}

let saved = null;
try { saved = localStorage.getItem(KEY); } catch { /* storage blocked */ }
apply(saved);

export function currentTheme() { return document.documentElement.dataset.variant; }

export function setTheme(id) {
  apply(id);
  try { localStorage.setItem(KEY, currentTheme()); } catch { /* storage blocked */ }
  window.dispatchEvent(new Event('pitwall-theme'));
}
