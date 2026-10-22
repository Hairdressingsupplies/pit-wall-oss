// src/engines.mjs
// Which model engine runs a chat, job or helper: Claude Code (default) or OpenAI Codex.
import fs from 'node:fs';
import path from 'node:path';

export const ENGINES = ['claude', 'codex'];
export const isEngine = x => ENGINES.includes(x);

// GPT models used for Pit Wall's own helper calls when Codex is the default (data/local.json "codex" overrides).
export const CODEX_HELPER_MODELS = { smallModel: 'gpt-6-luna', standardModel: 'gpt-6.1-sol' };

// Codex is opt-in. data/local.json "codexEnabled": true turns it on for this PC (config.mjs passes it in here, since
// config.mjs imports this file); the More › Codex (GPT)… switch (kv codexEnabled) overrides it either way.
let codexDefault = false;
export function setCodexDefault(on) { codexDefault = on === true; }

/** Whether Codex is switched on. Off: Pit Wall is Claude-only (existing Codex chats still open and continue as Codex). */
export function codexEnabled(store) {
  const v = store.get('codexEnabled', null);
  return typeof v === 'boolean' ? v : codexDefault;
}

/** The Default engine setting (More › Settings). Anything unexpected is Claude; so is everything while Codex is off. */
export function defaultEngine(store) {
  if (!codexEnabled(store)) return 'claude';
  const v = store.get('defaultEngine', 'claude');
  return isEngine(v) ? v : 'claude';
}

/** A new chat's or job's own choice if it made a valid one, else the default. Codex off: always Claude. */
export function engineFor(store, override) {
  if (!codexEnabled(store)) return 'claude';
  return isEngine(override) ? override : defaultEngine(store);
}

/** Helpers ask for a Claude tier (haiku/sonnet); on Codex that becomes a small or standard GPT model. */
export function helperModel(engine, claudeModel, models = CODEX_HELPER_MODELS) {
  if (engine !== 'codex') return claudeModel;
  return claudeModel === 'haiku' ? models.smallModel : models.standardModel;
}

/**
 * The GPT model a helper really asks for. The configured ids are guesses until Codex lists its models, so: no list read yet
 * → null (no -m: Codex picks its default); the mapped id isn't offered → the model Codex marks as its default (null if none).
 */
export function pickHelperModel(mapped, codexModels = []) {
  if (!codexModels?.length) return null;
  if (codexModels.some(m => m.id === mapped)) return mapped;
  return codexModels.find(m => m.isDefault)?.id ?? null;
}

/** After a gauge poll: when its 5-minute back-off starts (0 = none). Signed out, or signed in but no usage reading came back. */
export function codexPollBackoff(a, now = Date.now()) {
  return a && (!a.signedIn || !a.rate) ? now : 0;
}

/** The usage poll may read Codex's account only when its reading is stale and the last poll didn't start a back-off (5 minutes). */
export function shouldPollCodex({ rateCodex, lastSignedOutAt = 0, now = Date.now(), staleMin }) {
  if (lastSignedOutAt && now - lastSignedOutAt < 5 * 60_000) return false;
  return !(rateCodex?.capturedAt && now - Date.parse(rateCodex.capturedAt) < staleMin * 60_000);
}

/** Codex's native exe (npm's codex.cmd can't be spawned without a shell). null = not installed. */
export function findCodex(env = process.env, home, exists = fs.existsSync) {
  // Set by hand: that file, or "not installed" if it isn't there (never a different Codex than the one named).
  if (env.PITWALL_CODEX_EXE) return exists(env.PITWALL_CODEX_EXE) ? env.PITWALL_CODEX_EXE : null;
  const appData = env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const pkg = path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'node_modules');
  const candidates = [
    path.join(pkg, '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
    path.join(pkg, '@openai', 'codex-win32-arm64', 'vendor', 'aarch64-pc-windows-msvc', 'bin', 'codex.exe'),
  ];
  return candidates.find(p => exists(p)) ?? null;
}

const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
/**
 * Editing an agent: keep its stored model? Yes when the edit doesn't touch model or engine, and — while Codex is off — when
 * the page's Claude-only form sends a blank model for an agent that has a GPT one (the form can't show it, so blank isn't a
 * choice). A real change (a Claude model picked, or the engine changed) replaces it.
 */
export function keepStoredModel(role, data, codexOn) {
  if (!('model' in data) && !('engine' in data)) return true;
  if (codexOn) return false;
  const engineSame = !('engine' in data) || (data.engine ?? null) === (role.engine ?? null);
  const gpt = !!role.model && !CLAUDE_MODELS.includes(role.model);
  return engineSame && gpt && !data.model;
}
