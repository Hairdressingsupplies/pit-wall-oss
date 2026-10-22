// src/voice.mjs — the natural voice for "Read aloud": Kokoro (an open speech model) run on this PC, so reply text never
// leaves it. Optional: it lives in data/voice (its own npm install, ~720 MB with the model), not in Pit Wall's own
// folder, and the page falls back to the browser's voices when it isn't set up. The model runs in src/voice-worker.mjs,
// a process of its own that exits when unused.
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from './config.mjs';
import { runTree } from './codex-setup.mjs';

export const VOICE_PACKAGE = 'kokoro-js@1.2.1';
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
/** Kokoro's British voices, the first one the default. */
export const VOICES = { bf_emma: 'Emma', bf_isabella: 'Isabella', bf_alice: 'Alice', bf_lily: 'Lily', bm_george: 'George', bm_lewis: 'Lewis', bm_daniel: 'Daniel', bm_fable: 'Fable' };
export const MAX_TEXT = 600; // one piece of a reply; the page sends them a sentence or two at a time

const dir = () => path.join(config.dataDir, 'voice');
const entry = () => path.join(dir(), 'node_modules', 'kokoro-js', 'dist', 'kokoro.js');

/** A speak request checked: { text, voice } or { error }. */
export function speakRequest(data) {
  const text = String(data?.text ?? '').trim();
  const voice = String(data?.voice ?? Object.keys(VOICES)[0]);
  if (!text) return { error: 'Nothing to say.' };
  if (text.length > MAX_TEXT) return { error: `Send at most ${MAX_TEXT} characters at a time.` };
  if (!Object.hasOwn(VOICES, voice)) return { error: 'Unknown voice.' };
  return { text, voice };
}

/** Mono samples (-1…1) as a 16-bit WAV — half the size of Kokoro's own float one, which matters on a phone. */
export function wav16(samples, rate) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return b;
}

/** npm install of the voice package into data/voice (fixed arguments; run there, so no path is quoted). */
export function voiceInstallCommand(platform = process.platform) {
  const args = ['install', VOICE_PACKAGE, '--no-audit', '--no-fund', '--omit=dev'];
  return platform === 'win32' ? { file: 'cmd.exe', args: ['/d', '/s', '/c', `npm ${args.join(' ')}`] } : { file: 'npm', args };
}

let worker = null;               // the voice-worker process while it runs
const waiting = new Map();       // request id → { resolve, reject }
let nextId = 1;
let chain = Promise.resolve();   // one piece at a time, so a stopped reply's later pieces can be skipped
const setup = { running: false, error: null };

export function voiceStatus() {
  // Not "installed" mid-install: npm unpacks kokoro.js before it has finished the rest.
  return { installed: !setup.running && fs.existsSync(entry()), installing: setup.running, error: setup.error, voices: VOICES };
}

function ask(msg) {
  if (!worker) {
    const w = fork(fileURLToPath(new URL('./voice-worker.mjs', import.meta.url)), [entry(), MODEL],
      { serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let err = '';
    w.stderr.on('data', d => { err = (err + d).slice(-2000); });
    w.on('message', m => { const p = waiting.get(m.id); if (!p) return; waiting.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m); });
    w.on('exit', code => {
      if (worker === w) worker = null;
      for (const p of waiting.values()) p.reject(new Error(code ? `The natural voice stopped (${err.trim().split('\n').pop() || `exit ${code}`})` : 'The natural voice stopped.'));
      waiting.clear();
    });
    worker = w;
  }
  const id = nextId++;
  return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); worker.send({ id, ...msg }); });
}

/** Loads the model now (the page asks when it opens with a natural voice picked), so the first Read aloud is quick. */
export function warmVoice() {
  if (voiceStatus().installed) chain = chain.then(() => ask({ warm: true })).catch(() => {});
}

/**
 * One piece of a reply as WAV audio. Pieces wait their turn; `cancelled()` is asked when a piece's turn comes, so a
 * reply you stopped (or swapped for another) doesn't keep the CPU busy.
 */
export function speakWav(text, voice, cancelled = () => false) {
  if (!fs.existsSync(entry())) return Promise.reject(Object.assign(new Error('The natural voice is not set up on this PC.'), { status: 503 }));
  const run = chain.then(async () => {
    if (cancelled()) return null;
    const { samples, rate } = await ask({ text, voice });
    return wav16(samples, rate);
  });
  chain = run.catch(() => {});
  return run;
}

/** Installs the voice package, then loads it once so the model downloads now rather than on the first Read aloud. */
export async function installVoice(onDone = () => {}) {
  if (setup.running) return;
  Object.assign(setup, { running: true, error: null });
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const pkg = path.join(dir(), 'package.json');
    if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, `${JSON.stringify({ name: 'pitwall-voice', private: true, type: 'module' }, null, 2)}\n`);
    const r = await runTree(voiceInstallCommand(), { cwd: dir(), timeoutMs: 10 * 60_000 });
    if (!r.ok) throw new Error(r.timedOut ? 'The install took over 10 minutes and was stopped.' : (r.err || r.out).split('\n').slice(-3).join(' ') || `npm exited ${r.code}`);
    await ask({ warm: true });
  } catch (e) {
    setup.error = e.message;
  } finally {
    setup.running = false;
    onDone();
  }
}
