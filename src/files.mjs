// Downloading a file a chat mentions (a CSV, a workbook, a report) — mostly from a phone over remote access.
// Any folder on the PC: chats save work anywhere, and whoever uses Pit Wall can already have Claude read the file.
// Only deliverable file types, never Pit Wall's own data. Code and config (.js, .json, appsettings, .env) are never
// served: repos here hold credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DOWNLOAD_TYPES = {
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.txt': 'text/plain', '.md': 'text/markdown',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.html': 'text/html',
};
export const MAX_DOWNLOAD = 200_000_000;

const fail = (status, msg) => Object.assign(new Error(msg), { status });
const norm = p => (process.platform === 'win32' ? p.toLowerCase() : p);
const inside = (root, p) => {
  const rel = path.relative(norm(root), norm(p));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
};
const real = p => { try { return fs.realpathSync.native(p); } catch { return null; } };

/** Git Bash style /c/Users/… → C:\Users\…, ~/… → the home folder, and a trailing :line(:col) dropped. */
export function cleanPath(raw) {
  let p = String(raw ?? '').trim().replace(/^["'`]+|["'`]+$/g, '');
  p = p.replace(/(\.[A-Za-z0-9]{1,5}):\d+(?::\d+)?$/, '$1');
  const bash = /^\/([a-zA-Z])\/(.*)$/.exec(p);
  if (bash) p = `${bash[1].toUpperCase()}:\\${bash[2]}`;
  if (/^~[\\/]/.test(p)) p = path.join(os.homedir(), p.slice(2));
  return p;
}

/** Every folder a transcript's turns ran in, newest first: a chat that cd's writes its paths relative to where it had got to. */
export function transcriptFolders(text) {
  const found = [...String(text).matchAll(/"cwd":("(?:[^"\\]|\\.)*")/g)].map(m => cleanPath(JSON.parse(m[1])));
  return [...new Set(found.reverse())];
}

/**
 * The full paths a transcript wrote that end in rel, newest first: replies often give just a file's name.
 * Whole folder and file names only, so laravel.md never finds project_laravel.md.
 */
export function transcriptPaths(text, rel) {
  const src = String(text);
  const tail = rel.replace(/\\/g, '/').replace(/^(\.\/)+/, '').toLowerCase();
  const name = tail.split('/').pop();
  if (!name || tail.split('/').includes('..')) return [];
  const found = [];
  for (let at = src.indexOf(name); at !== -1; at = src.indexOf(name, at + 1)) {
    const end = at + name.length;
    if (/[\w.-]/.test(src[end] ?? '')) continue;
    let start = at;
    while (start > 0 && !/["'`<>| (=,]/.test(src[start - 1])) start--;
    const m = /(?:[a-zA-Z]:|(?:^|[^\w/])\/[a-zA-Z])[\\/].*$/.exec(src.slice(start, end));
    if (!m) continue;
    const full = cleanPath(m[0].replace(/^[^/a-zA-Z]/, '').replace(/\\\\/g, '\\'));
    const slashed = full.replace(/\\/g, '/').toLowerCase();
    if (slashed.endsWith(`/${tail}`)) found.push(path.win32.isAbsolute(full) ? path.win32.normalize(full) : full);
  }
  return [...new Set(found.reverse())];
}

const WALK_DEPTH = 3;
const WALK_FOLDERS = 2000;
const WALK_SKIP = new Set(['node_modules', 'vendor']);

/** rel, a few folders below the folders given: a file saved by a script often has no full path anywhere in the transcript. */
function findBelow(folders, rel) {
  const queue = folders.map(dir => ({ dir, depth: 0 }));
  for (let i = 0; i < queue.length && i < WALK_FOLDERS; i++) {
    const { dir, depth } = queue[i];
    const hit = real(path.join(dir, rel));
    if (hit) return path.join(dir, rel);
    if (depth >= WALK_DEPTH) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* gone or unreadable: nothing below it */ }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && !WALK_SKIP.has(e.name)) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return null;
}

/** Where a relative path may be: the chat's folder, the others it worked in, the folders above those, then the roots. */
function searchFolders(cwd, seen, roots) {
  const start = [cwd, ...seen].filter(Boolean);
  const above = start.flatMap(dir => {
    const root = roots.find(r => inside(r, dir));
    const up = [];
    for (let d = path.dirname(dir); root && inside(root, d) && d !== dir; dir = d, d = path.dirname(d)) up.push(d);
    return up;
  });
  const all = [...start, ...above, ...roots];
  return all.filter((d, i) => all.findIndex(o => norm(o) === norm(d)) === i);
}

/**
 * → { file, name, size, type } for a file it is safe to hand over, else throws with a status.
 * raw: absolute, or relative to cwd (the chat's folder), or to a folder in seen (others it worked in, see transcriptFolders).
 * Failing those, mentions(rel) gives full paths to try (see transcriptPaths), then a short look below cwd and seen.
 * roots: searched last for relative paths. blocked: never these. Every rule below applies to whichever file is found.
 */
export function resolveDownload(raw, { cwd, seen = [], mentions = () => [], roots, blocked = [] }) {
  const p = cleanPath(raw);
  if (!p || p.length > 1000 || p.includes('\0')) throw fail(400, 'No file given.');
  if (/^[\\/]{2}/.test(p)) throw fail(403, 'Network and device paths aren’t served.');
  if (p.slice(2).includes(':') || (p.includes(':') && !/^[a-zA-Z]:[\\/]/.test(p))) throw fail(403, 'That isn’t a plain file path.');
  const tries = searchFolders(cwd, seen, roots).map(d => path.resolve(d, p));
  const named = () => {
    const there = mentions(p).filter(real);
    return there.find(f => roots.some(r => real(r) && inside(real(r), real(f)))) ?? there[0];
  };
  const below = () => findBelow([cwd, ...seen].filter(d => d && !roots.some(r => norm(path.resolve(r)) === norm(path.resolve(d)))), p);
  const abs = tries.find(real) ?? (path.isAbsolute(p) ? null : named() ?? below()) ?? tries[0] ?? path.resolve(p);
  const ext = path.extname(abs).toLowerCase();
  if (!DOWNLOAD_TYPES[ext]) throw fail(403, `Pit Wall only hands over documents and data (${Object.keys(DOWNLOAD_TYPES).join(' ')}).`);
  const file = real(abs);
  if (!file) throw fail(404, 'That file isn’t there any more.');
  // Checked on the real path, so a junction or link can't lead into Pit Wall's data or to a type that isn't served.
  if (blocked.map(real).filter(Boolean).some(b => inside(b, file))) throw fail(403, 'Pit Wall’s own data isn’t served.');
  if (DOWNLOAD_TYPES[path.extname(file).toLowerCase()] == null) throw fail(403, 'Pit Wall only hands over documents and data.');
  const st = fs.statSync(file);
  if (!st.isFile()) throw fail(404, 'That isn’t a file.');
  if (st.size > MAX_DOWNLOAD) throw fail(413, 'That file is over 200 MB.');
  return { file, name: path.basename(file), size: st.size, type: DOWNLOAD_TYPES[path.extname(file).toLowerCase()] };
}

/** Headers that make the browser save it, never show it on Pit Wall's own page (an .html report could call the API). */
export function downloadHeaders({ name, size, type }) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return {
    'Content-Type': type,
    'Content-Length': String(size),
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}
