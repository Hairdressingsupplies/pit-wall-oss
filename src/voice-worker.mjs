// src/voice-worker.mjs — Kokoro in a process of its own, started by src/voice.mjs when something is read aloud. The
// model takes ~800 MB, so this exits after 10 minutes unused (freeing all of it) and a crash can't take Pit Wall down.
// Messages: { id, warm } loads the model; { id, text, voice } → { id, samples, rate } or { id, error }.
import { pathToFileURL } from 'node:url';

const [entry, modelId] = process.argv.slice(2);
const IDLE_MS = 10 * 60_000;

let model = null;
const load = () => (model ??= import(pathToFileURL(entry).href)
  .then(m => m.KokoroTTS.from_pretrained(modelId, { dtype: 'fp32', device: 'cpu' }))); // fp32 is the fastest on a CPU

let idle = null;
const touch = () => { clearTimeout(idle); idle = setTimeout(() => process.exit(0), IDLE_MS); };
touch();

let chain = Promise.resolve(); // one at a time: each uses every CPU core
process.on('message', msg => {
  chain = chain.then(async () => {
    touch();
    try {
      const tts = await load();
      if (msg.warm) return process.send({ id: msg.id, ok: true });
      const audio = await tts.generate(msg.text, { voice: msg.voice });
      process.send({ id: msg.id, samples: audio.audio, rate: audio.sampling_rate });
    } catch (e) {
      process.send({ id: msg.id, error: e.message });
    }
    touch();
  });
});
process.on('disconnect', () => process.exit(0)); // Pit Wall stopped
