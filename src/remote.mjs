// Remote access through a Cloudflare Tunnel guarded by Cloudflare Access. The server stays on 127.0.0.1;
// cloudflared on this PC forwards https://<host> to it, and Access adds a signed JWT
// (Cf-Access-Jwt-Assertion) once you have logged in. Pit Wall checks that token itself — signature against
// the team's published keys, issuer, this app's AUD tag, expiry, and an allowed email — so a tunnel route
// without an Access app in front (or any other misconfiguration) fails closed.
// Settings live in data/remote.json (git-ignored):
//   { "hosts": ["pitwall.example.com"], "team": "<team>.cloudflareaccess.com", "aud": "<AUD tag>", "emails": ["you@example.com"] }
import fs from 'node:fs';
import path from 'node:path';
import { createPublicKey, verify } from 'node:crypto';

const lower = a => (Array.isArray(a) ? a : []).filter(x => typeof x === 'string').map(x => x.trim().toLowerCase());
const str = v => (typeof v === 'string' ? v.trim() : '');
const PROXY_HEADERS = ['x-forwarded-for', 'cf-ray', 'cf-connecting-ip', 'cf-access-jwt-assertion'];

export function loadRemote(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'remote.json'), 'utf8'));
    return { hosts: lower(j.hosts), team: str(j.team).toLowerCase(), aud: str(j.aud), emails: lower(j.emails) };
  } catch { return { hosts: [], team: '', aud: '', emails: [] }; }
}

/** The team's signing keys, cached; an unknown kid (key rotation) refetches at most once a minute. */
export class AccessKeys {
  constructor({ fetchFn = defaultFetch, ttlMs = 3_600_000, nowFn = Date.now } = {}) {
    this.fetchFn = fetchFn;
    this.ttlMs = ttlMs;
    this.now = nowFn;
    this.cache = new Map(); // team → { keys: Map(kid → KeyObject), at }
    this.tried = new Map(); // team → last fetch attempt, so failures and unknown kids can't hammer Cloudflare
  }
  async get(team, kid) {
    const c = this.cache.get(team);
    const due = !c || this.now() - c.at > this.ttlMs || !c.keys.has(kid);
    if (due && this.now() - (this.tried.get(team) ?? -Infinity) > 60_000) {
      this.tried.set(team, this.now());
      try {
        const j = await this.fetchFn(`https://${team}/cdn-cgi/access/certs`);
        const keys = new Map();
        for (const k of j?.keys ?? []) {
          try { keys.set(k.kid, createPublicKey({ key: k, format: 'jwk' })); } catch {}
        }
        this.cache.set(team, { keys, at: this.now() });
      } catch (e) {
        console.warn(`[remote] could not fetch Access keys: ${e.message}`);
      }
    }
    return this.cache.get(team)?.keys.get(kid) ?? null;
  }
}

async function defaultFetch(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const part = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/** → the token's email if it is a valid, unexpired Access token for this app and an allowed person, else null. */
async function accessEmail(token, remote, keys) {
  const bits = String(token ?? '').split('.');
  if (bits.length !== 3 || !bits[2]) return null;
  let head, claims;
  try { head = part(bits[0]); claims = part(bits[1]); } catch { return null; }
  if (head.alg !== 'RS256' || typeof head.kid !== 'string') return null;
  const key = await keys.get(remote.team, head.kid);
  if (!key) return null;
  const ok = verify('RSA-SHA256', Buffer.from(`${bits[0]}.${bits[1]}`), key, Buffer.from(bits[2], 'base64url'));
  if (!ok) return null;
  const t = Date.now() / 1000;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== `https://${remote.team}` || !aud.includes(remote.aud)) return null;
  if (!(claims.exp > t - 60) || (claims.nbf != null && claims.nbf > t + 60)) return null;
  const email = str(claims.email).toLowerCase();
  return email && remote.emails.includes(email) ? email : null;
}

/** → { ok, remote, origin, email? } for a request; ok:false means refuse it. */
export async function classify(req, localHosts, remote, keys) {
  const host = (req.headers.host ?? '').toLowerCase();
  const proxied = PROXY_HEADERS.some(h => req.headers[h] != null);
  if (localHosts.has(host) && !proxied) return { ok: true, remote: false, origin: `http://${host}` };

  if (!remote.hosts.length || !remote.team || !remote.aud || !remote.emails.length) return { ok: false };
  const bare = host.replace(/:443$/, '');
  // cloudflared may be set to pass the origin address as Host; the token is what counts.
  const name = remote.hosts.includes(bare) ? bare : localHosts.has(host) ? remote.hosts[0] : null;
  if (!name) return { ok: false };
  const email = await accessEmail(req.headers['cf-access-jwt-assertion'], remote, keys);
  return email ? { ok: true, remote: true, origin: `https://${name}`, email } : { ok: false };
}
