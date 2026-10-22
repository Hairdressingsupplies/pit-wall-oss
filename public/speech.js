// public/speech.js — reading Claude's replies aloud. Three kinds of voice, picked in More › Voice:
//   natural — Kokoro, made by Pit Wall's server on the PC (src/voice.mjs) and played here; the text stays on the PC;
//   device  — the browser's speechSynthesis with a voice that runs on this device (Windows' own on the PC);
//   google  — Chrome's Google voices: better than device, but Chrome sends the text to Google (like dictation).
// The text helpers are pure (no DOM), so test/speech.test.mjs can check them.

const AUTO_KEY = 'pitwall.readAloud';
const VOICE_KEY = 'pitwall.voice';

/** A reply's markdown as plain words worth hearing: code blocks, tables, images and link addresses left out. */
export function speakableText(md) {
  const lines = String(md ?? '')
    .replace(/^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, '')  // fenced code (an unclosed fence runs to the end)
    .replace(/<[^>\n]+>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .split('\n');
  const out = [];
  for (let line of lines) {
    if (/^\s*\|/.test(line) || /^\s*([-*_]\s*){3,}$/.test(line)) continue; // table rows, horizontal rules
    line = line
      .replace(/^\s*>+\s?/, '')
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/(\*\*|__|~~)/g, '')
      .replace(/(^|[\s(])\*(\S[^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1$2')
      .trim();
    if (!line) continue;
    out.push(/[.!?:;,]$/.test(line) ? line : `${line}.`); // a pause where the page has a line break
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Text split into pieces of at most `max` characters at sentence ends (Chrome can cut out partway through long text).
 * `firstAlone`: the first sentence is a piece of its own, so the natural voice can start while it makes the rest.
 */
export function chunks(text, max = 220, { firstAlone = false } = {}) {
  const out = [];
  let cur = '';
  const push = s => { if (!s) return; if (cur && cur.length + 1 + s.length > max) { out.push(cur); cur = s; } else cur = cur ? `${cur} ${s}` : s; };
  String(text).split(/(?<=[.!?])\s+/).forEach((sentence, i) => {
    if (sentence.length <= max) push(sentence);
    else for (const word of sentence.split(/\s+/)) push(word);
    if (i === 0 && firstAlone && cur) { out.push(cur); cur = ''; }
  });
  if (cur) out.push(cur);
  return out;
}

/** The voice to use: one on this device unless Google voices are allowed (then Google's first); British English first. */
export function pickVoice(voices, allowGoogle = false) {
  const pool = (voices ?? []).filter(v => allowGoogle || v.localService);
  const rank = v => (allowGoogle && !v.localService ? 0 : 4) + (v.lang === 'en-GB' ? 0 : /^en/i.test(v.lang) ? 1 : 2);
  return [...pool].sort((a, b) => rank(a) - rank(b) || Number(b.default) - Number(a.default))[0] ?? null;
}

/**
 * The voice in use: what was picked here, or the natural voice when the PC has it, else this device's. A natural voice
 * picked on a device whose Pit Wall doesn't have it (yet) falls back to this device's.
 */
export function resolveChoice(stored, natural) {
  const ok = natural?.installed ? Object.keys(natural.voices ?? {}) : [];
  if (stored === 'device' || stored === 'google') return stored;
  const name = /^natural:(\w+)$/.exec(stored ?? '')?.[1];
  if (name && ok.includes(name)) return stored;
  return ok.length ? `natural:${ok[0]}` : 'device';
}

// ── in the browser ───────────────────────────────────────────────────────
const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
const flag = (key, value) => { try { if (value === undefined) return localStorage.getItem(key) === '1'; localStorage.setItem(key, value ? '1' : '0'); } catch { /* storage blocked */ } return value; };

export const supported = () => !!synth && typeof SpeechSynthesisUtterance !== 'undefined';
/** "Read replies aloud" and the voice are kept per device (a phone and the PC each have their own voices). */
export const autoRead = value => flag(AUTO_KEY, value);

let natural = null; // GET /api/voice: { installed, installing, error, voices, remote }
/** What the server said about the natural voice; app.js passes it in. */
export function setNatural(status) { natural = status; }
export const naturalStatus = () => natural;
/** The voice picked on this device ('natural:bf_emma', 'device' or 'google'), set when given one. */
export function voiceChoice(value) {
  if (value !== undefined) { try { localStorage.setItem(VOICE_KEY, value); } catch { /* storage blocked */ } }
  let stored = null;
  try { stored = localStorage.getItem(VOICE_KEY); } catch { /* storage blocked */ }
  return resolveChoice(stored, natural);
}

let current = null; // { id, done, abort } — the reply being read
let audio = null;   // AudioContext for the natural voice, made on first use
const voices = () => new Promise(resolve => {
  const now = synth.getVoices();
  if (now.length) return resolve(now);
  const t = setTimeout(() => resolve(synth.getVoices()), 1500); // Chrome loads its voice list after the page
  synth.addEventListener('voiceschanged', () => { clearTimeout(t); resolve(synth.getVoices()); }, { once: true });
});
const NOT_ALLOWED = 'Chrome only reads aloud once you’ve clicked or typed on the page — click anywhere and try again';

export const speakingId = () => current?.id ?? null;

/** Stops whatever is being read. */
export function stop() {
  const was = current;
  current = null;
  if (synth) synth.cancel();
  was?.abort?.();
  was?.done?.();
}

/**
 * Reads a reply's markdown aloud, stopping anything already being read. `done` runs once it ends or is stopped, with
 * a message when it couldn't (Chrome only lets a page make sound once you've clicked or typed in it). `note` gets a
 * message when the natural voice failed and this device's read it instead.
 * Throws (as a rejected promise) when there's nothing to read or no voice allowed on this device.
 */
export async function speak(md, { id = null, done, note } = {}) {
  stop();
  const choice = voiceChoice();
  const text = speakableText(md);
  if (!text) throw new Error('Nothing to read out in this reply');
  const me = { id, done, note };
  if (choice.startsWith('natural:')) return speakNatural(text, choice.slice('natural:'.length), me);
  return speakDevice(text, choice === 'google', me);
}

async function speakDevice(text, google, me) {
  const parts = chunks(text, 220);
  const voice = pickVoice(await voices(), google);
  if (!voice) throw new Error('No voice on this device — pick Google in More › Voice to use Chrome’s');
  const { done } = me;
  current = me;
  parts.forEach((text, i) => {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang;
    const end = e => {
      if (current !== me) return;
      current = null;
      synth.cancel();
      done?.(e?.error === 'not-allowed' ? NOT_ALLOWED : e?.error && !['interrupted', 'canceled'].includes(e.error) ? `Reading stopped: ${e.error}` : undefined);
    };
    u.onerror = end;
    if (i === parts.length - 1) u.onend = end;
    synth.speak(u);
  });
}

/** The natural voice: each piece is made on the PC while the one before it plays. */
async function speakNatural(text, voice, me) {
  const parts = chunks(text, 300, { firstAlone: true });
  const ctl = new AbortController();
  let source = null, played = false;
  me.abort = () => { ctl.abort(); try { source?.stop(); } catch { /* not started */ } };
  current = me;
  const finish = msg => { if (current !== me) return; current = null; me.abort(); me.done?.(msg); };
  // Without a click or key press on the page, resume() never settles (it doesn't fail), so don't wait on it for long.
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return finish(NOT_ALLOWED);
  audio ??= new AudioContext();
  await Promise.race([audio.resume().catch(() => {}), new Promise(r => setTimeout(r, 800))]);
  if (current !== me) return;
  if (audio.state !== 'running') return finish(NOT_ALLOWED);
  const make = text => fetch('/api/voice/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice }), signal: ctl.signal })
    .then(async r => {
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `The natural voice failed (${r.status})`);
      return audio.decodeAudioData(await r.arrayBuffer());
    });
  try {
    let next = make(parts[0]);
    for (let i = 0; i < parts.length; i++) {
      const buf = await next;
      if (current !== me) return;
      next = i + 1 < parts.length ? make(parts[i + 1]) : null;
      next?.catch(() => {}); // a failure is reported when its turn comes
      await new Promise(resolve => {
        source = audio.createBufferSource();
        source.buffer = buf;
        source.connect(audio.destination);
        source.onended = resolve;
        source.start();
        played = true;
      });
      if (current !== me) return;
    }
    finish();
  } catch (e) {
    if (current !== me || e.name === 'AbortError') return;
    if (played) return finish(e.message);
    // Nothing heard yet: read it with this device's voice instead of leaving you with silence.
    current = null;
    me.abort = null;
    me.note?.(`Natural voice failed (${e.message}) — reading with this device’s voice`);
    speakDevice(text, false, me).catch(x => { me.done?.(x.message); });
  }
}
