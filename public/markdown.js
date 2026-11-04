// Small, safe Markdown renderer. Everything is HTML-escaped FIRST; only our own tags are added after.
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// File types Pit Wall will hand over (src/files.mjs DOWNLOAD_TYPES — keep the two lists the same).
const FILE_EXT = 'csv|tsv|txt|md|xlsx|xls|docx|pptx|pdf|png|jpe?g|html';
// A whole code span that is a path: C:\…, C:/…, /c/…, or relative to the chat's folder; an optional :line suffix.
const PATH_RE = new RegExp(String.raw`^(?:[a-zA-Z]:[\\/]|/[a-zA-Z]/)?[^<>"|*?\n]*\.(?:${FILE_EXT})(?::\d+(?::\d+)?)?$`, 'i');
// A bare absolute Windows path in running text (no spaces — those need backticks).
const BARE_RE = new RegExp(String.raw`(^|[\s(])([a-zA-Z]:[\\/][^\s<>"|*?]+\.(?:${FILE_EXT}))(?=$|[\s).,;:!?])`, 'gi');
const unescapeHtml = s => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));
/** escaped = the path as it sits in the (already escaped) text. */
function fileLink(inner, escaped, session) {
  const q = `${session ? `session=${encodeURIComponent(session)}&amp;` : ''}path=${encodeURIComponent(unescapeHtml(escaped))}`;
  return `<a class="file-link" href="/api/files?${q}" download title="Download">${inner}</a>`;
}

function inline(s, opts = {}) {
  // s is already escaped. Protect code spans first.
  const files = opts.files ?? null;
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  if (files) s = s.replace(BARE_RE, (_, p, f) => `${p}${fileLink(f, f, files.session)}`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const c = codes[i];
    return files && PATH_RE.test(unescapeHtml(c).trim()) ? fileLink(`<code>${c}</code>`, c.trim(), files.session) : `<code>${c}</code>`;
  });
}

function table(lines, opts) {
  const cells = l => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => inline(c.trim(), opts));
  const head = cells(lines[0]);
  const rows = lines.slice(2).map(cells);
  return `<div class="md-table"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
    rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

/** opts.files = { session } turns file paths into download links (assistant replies only). */
export function renderMarkdown(src, opts = {}) {
  const lines = escapeHtml(src).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```(\S*)/.exec(line);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre class="md-code"${fence[1] ? ` data-lang="${fence[1]}"` : ''}><code>${buf.join('\n')}</code></pre>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1] ?? '')) {
      const buf = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) buf.push(lines[i++]);
      out.push(table(buf, opts));
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { out.push(`<h${h[1].length + 2}>${inline(h[2], opts)}</h${h[1].length + 2}>`); i++; continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^\s*&gt;\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*&gt;\s?/, ''));
      out.push(`<blockquote>${buf.map(l => inline(l, opts)).join('<br>')}</blockquote>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const buf = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const depth = Math.floor((/^\s*/.exec(lines[i])[0].length) / 2);
        buf.push(`<li style="margin-left:${depth * 1.1}em">${inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''), opts)}</li>`);
        i++;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${buf.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|[-*]\s|\d+\.\s|&gt;|\|)/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) buf.push(lines[i++]);
    out.push(`<p>${buf.map(l => inline(l, opts)).join('<br>')}</p>`);
  }
  return out.join('');
}
