import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, loadRemote, AccessKeys } from '../src/remote.mjs';

const LOCAL = new Set(['127.0.0.1:4040', 'localhost:4040']);
const HOST = 'pitwall.example.com';
const REMOTE = { hosts: [HOST], team: 'acme.cloudflareaccess.com', aud: 'app-aud', emails: ['sam@example.com'] };

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

function jwt(claims = {}, { kid = 'k1', key = privateKey, alg = 'RS256' } = {}) {
  const body = { iss: 'https://acme.cloudflareaccess.com', aud: ['app-aud'], email: 'sam@example.com',
    iat: now(), nbf: now(), exp: now() + 3600, type: 'app', ...claims };
  const data = `${b64({ alg, kid, typ: 'JWT' })}.${b64(body)}`;
  return `${data}.${createSign('RSA-SHA256').update(data).sign(key).toString('base64url')}`;
}

function keys() {
  let fetches = 0;
  const k = new AccessKeys({ nowFn: () => keys.clock, fetchFn: async url => { fetches++; assert.equal(url, 'https://acme.cloudflareaccess.com/cdn-cgi/access/certs'); return { keys: [JWK] }; } });
  return { k, fetches: () => fetches };
}
keys.clock = 1_000_000;
const req = headers => ({ headers });
const viaTunnel = (token, extra = {}) => req({ host: HOST, 'cf-ray': 'abc', 'x-forwarded-for': '81.2.3.4', ...(token ? { 'cf-access-jwt-assertion': token } : {}), ...extra });

test('a browser on this PC is local, as before', async () => {
  assert.deepEqual(await classify(req({ host: '127.0.0.1:4040' }), LOCAL, REMOTE, keys().k), { ok: true, remote: false, origin: 'http://127.0.0.1:4040' });
  assert.equal((await classify(req({ host: 'localhost:4040' }), LOCAL, REMOTE, keys().k)).ok, true);
});

test('an unknown host is refused (DNS rebinding)', async () => {
  assert.equal((await classify(req({ host: 'evil.example:4040' }), LOCAL, REMOTE, keys().k)).ok, false);
});

test('an allowed email through Cloudflare Access is let in as remote', async () => {
  const r = await classify(viaTunnel(jwt({ email: 'Sam@Example.com' })), LOCAL, REMOTE, keys().k);
  assert.deepEqual(r, { ok: true, remote: true, origin: `https://${HOST}`, email: 'sam@example.com' });
});

test('the tunnel without an Access token is refused (no Access app in front)', async () => {
  assert.equal((await classify(viaTunnel(null), LOCAL, REMOTE, keys().k)).ok, false);
});

test('forged, foreign, expired or mis-addressed tokens are refused', async () => {
  const k = keys().k;
  const bad = [
    jwt({}, { key: other.privateKey }),                     // signed by someone else
    jwt({ email: 'someone@else.com' }),                     // not an allowed person
    jwt({ email: undefined, common_name: 'svc.access' }),   // a service token, not a person
    jwt({ aud: ['another-app'] }),                          // issued for another Access app
    jwt({ iss: 'https://evil.cloudflareaccess.com' }),
    jwt({ exp: now() - 120 }),
    jwt({ nbf: now() + 600 }),
    jwt({}, { alg: 'none' }),
    jwt({}, { kid: 'unknown' }),
    'not.a.jwt', 'garbage',
  ];
  for (const t of bad) assert.equal((await classify(viaTunnel(t), LOCAL, REMOTE, k)).ok, false, t.slice(0, 40));
  const [h, b] = jwt().split('.');
  assert.equal((await classify(viaTunnel(`${h}.${b}.`), LOCAL, REMOTE, k)).ok, false, 'empty signature');
});

test('a valid token on a host not listed is refused', async () => {
  const r = await classify(req({ host: 'other.example.com', 'cf-ray': 'x', 'cf-access-jwt-assertion': jwt() }), LOCAL, REMOTE, keys().k);
  assert.equal(r.ok, false);
});

test('a proxied request claiming a local host still needs a valid token', async () => {
  const k = keys().k;
  assert.equal((await classify(req({ host: '127.0.0.1:4040', 'cf-ray': 'x' }), LOCAL, REMOTE, k)).ok, false);
  const r = await classify(req({ host: '127.0.0.1:4040', 'cf-ray': 'x', 'cf-access-jwt-assertion': jwt() }), LOCAL, REMOTE, k);
  assert.deepEqual([r.ok, r.remote, r.origin], [true, true, `https://${HOST}`]);
});

test('remote access is off until hosts, team, aud and emails are all configured', async () => {
  for (const missing of ['hosts', 'team', 'aud', 'emails']) {
    const cfg = { ...REMOTE, [missing]: missing === 'hosts' || missing === 'emails' ? [] : '' };
    assert.equal((await classify(viaTunnel(jwt()), LOCAL, cfg, keys().k)).ok, false, missing);
  }
});

test('signing keys are fetched once and cached; an unknown kid refetches at most once a minute', async () => {
  const { k, fetches } = keys();
  await classify(viaTunnel(jwt()), LOCAL, REMOTE, k);
  await classify(viaTunnel(jwt()), LOCAL, REMOTE, k);
  assert.equal(fetches(), 1);
  await classify(viaTunnel(jwt({}, { kid: 'rotated' })), LOCAL, REMOTE, k);
  assert.equal(fetches(), 1, 'not again within the minute');
  keys.clock += 61_000;
  await classify(viaTunnel(jwt({}, { kid: 'rotated' })), LOCAL, REMOTE, k);
  await classify(viaTunnel(jwt({}, { kid: 'rotated' })), LOCAL, REMOTE, k);
  assert.equal(fetches(), 2, 'once after the minute');
  keys.clock = 1_000_000;
});

test('a failed key fetch refuses rather than throws', async () => {
  const k = new AccessKeys({ fetchFn: async () => { throw new Error('offline'); } });
  assert.equal((await classify(viaTunnel(jwt()), LOCAL, REMOTE, k)).ok, false);
});

test('loadRemote reads data/remote.json and tolerates it missing or broken', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-remote-'));
  const off = { hosts: [], team: '', aud: '', emails: [] };
  assert.deepEqual(loadRemote(dir), off);
  fs.writeFileSync(path.join(dir, 'remote.json'), '{ nope');
  assert.deepEqual(loadRemote(dir), off);
  fs.writeFileSync(path.join(dir, 'remote.json'), JSON.stringify({ hosts: ['PitWall.example.com'], team: 'ACME.cloudflareaccess.com', aud: 'abc', emails: ['X@Y.com'] }));
  assert.deepEqual(loadRemote(dir), { hosts: ['pitwall.example.com'], team: 'acme.cloudflareaccess.com', aud: 'abc', emails: ['x@y.com'] });
});
