import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Organisation-wide settings shared by every install of one copy of the repo: site.json at the repo root
// (or PITWALL_SITE_FILE). Optional — without it Pit Wall uses neutral defaults. Per-PC settings stay in data/local.json.
//   owner / ownerTheir   whose Pit Wall it is when local.json has no name ("Sam", "her")
//   about                the line after the owner's name in Pit Wall's prompts
//   company              team installs' default about line: "works at <company>."
//   roundupTo / roundupToName / roundupToLabel   who the weekly roundup goes to, and how prompts and the page name them
//   dangerRules          extra danger badges: [{ "label": "...", "pattern": "regex", "flags": "i" }], shown before the built-in ones
//   jobBlockedCommands   extra command fragments queued jobs may never run
//   liveSystems          what a queued job must never change, e.g. "Shopify/Stripe" ("live <liveSystems> account")
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadSite(file = process.env.PITWALL_SITE_FILE ?? path.join(ROOT, 'site.json')) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return {}; }
}

export const SITE = loadSite();

/** The owner's about line when neither site.json nor data/local.json gives one. */
export const DEFAULT_ABOUT = 'uses Claude Code for software and other work.';

/** site.json dangerRules → [label, RegExp] pairs; a bad pattern is skipped, not fatal. */
export function siteDangerRules(site = SITE) {
  return (Array.isArray(site.dangerRules) ? site.dangerRules : []).flatMap(r => {
    try { return [[String(r.label), new RegExp(r.pattern, r.flags ?? 'i')]]; } catch { return []; }
  });
}
