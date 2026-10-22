// Full-text search across every transcript, run in a worker thread so the server never stalls
// (there are well over a gigabyte of transcripts). Newest files first; stops at the result cap.
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';

const { q, projectsDirs, excludedDirs, maxFiles = 40, maxSnippets = 3 } = workerData;
const needle = q.toLowerCase();

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b?.type === 'text').map(b => b.text).join('\n');
}

function snippet(text) {
  const i = text.toLowerCase().indexOf(needle);
  if (i < 0) return null;
  const start = Math.max(0, i - 90);
  const end = Math.min(text.length, i + needle.length + 150);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

const files = [];
for (const projectsDir of projectsDirs) {
  let entries = [];
  try { entries = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { continue; }
  for (const d of entries) {
    if (!d.isDirectory() || excludedDirs.includes(d.name)) continue;
    const dir = path.join(projectsDir, d.name);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith('.jsonl')) continue;
      try { files.push({ file: path.join(dir, f), mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs }); } catch { /* vanished */ }
    }
  }
}
files.sort((a, b) => b.mtimeMs - a.mtimeMs);

const results = [];
let scanned = 0;
for (const { file, mtimeMs } of files) {
  if (results.length >= maxFiles) break;
  scanned++;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
  if (!raw.toLowerCase().includes(needle)) continue;
  const hit = { sessionId: path.basename(file, '.jsonl'), mtimeMs, title: null, cwd: null, snippets: [] };
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const lower = line.toLowerCase();
    const isTitle = lower.startsWith('{"type":"ai-title"') || lower.startsWith('{"type":"custom-title"');
    if (!isTitle && (hit.snippets.length >= maxSnippets || !lower.includes(needle))) {
      if (!hit.cwd && lower.includes('"cwd"')) { try { hit.cwd = JSON.parse(line).cwd ?? null; } catch { /* partial */ } }
      continue;
    }
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'custom-title') hit.title = e.customTitle;
    else if (e.type === 'ai-title' && !hit.title) hit.title = e.aiTitle;
    if (e.cwd) hit.cwd = e.cwd;
    if ((e.type === 'user' || e.type === 'assistant') && !e.isSidechain && !e.isMeta && hit.snippets.length < maxSnippets) {
      const s = snippet(textOf(e.message?.content));
      if (s) hit.snippets.push({ role: e.type, text: s, ts: e.timestamp ?? null });
    }
  }
  if (hit.snippets.length) results.push(hit);
}

parentPort.postMessage({ results, scanned, total: files.length, capped: results.length >= maxFiles });
