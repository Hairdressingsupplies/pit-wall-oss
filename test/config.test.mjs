import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userSettings, DEFAULT_ABOUT } from '../src/config.mjs';

test('no local.json or site.json: the Windows user, a neutral line, automation on', () => {
  assert.deepEqual(userSettings({}, { USERNAME: 'pat' }), { name: 'pat', their: 'their', about: DEFAULT_ABOUT, automation: true });
  assert.equal(userSettings({}, {}).name, 'User');
});

test('site.json owner is the default; local.json name wins over it', () => {
  const site = { owner: 'Sam', ownerTheir: 'her', about: 'runs Acme: a shop and a blog.', company: 'Acme' };
  assert.deepEqual(userSettings({}, {}, site), { name: 'Sam', their: 'her', about: 'runs Acme: a shop and a blog.', automation: true });
  assert.deepEqual(userSettings({ name: 'Lee' }, {}, site), { name: 'Lee', their: 'their', about: 'works at Acme.', automation: true });
});

test('team settings', () => {
  const u = userSettings({ name: 'Lee', about: 'works at Acme on email.', automation: false }, {});
  assert.deepEqual(u, { name: 'Lee', their: 'their', about: 'works at Acme on email.', automation: false });
});

test('a name without about gets a neutral line; env overrides', () => {
  assert.equal(userSettings({ name: 'Lee' }, {}).about, DEFAULT_ABOUT);
  assert.equal(userSettings({}, { PITWALL_AUTOMATION: '0' }).automation, false);
  assert.equal(userSettings({ automation: false }, { PITWALL_AUTOMATION: '1' }).automation, true);
  assert.equal(userSettings({}, { PITWALL_USER_NAME: 'Kim' }).name, 'Kim');
  assert.equal(userSettings({ name: '  ' }, {}, { owner: 'Sam' }).name, 'Sam');
});

test('Codex is off unless local.json says "codexEnabled": true (PITWALL_CODEX overrides)', async () => {
  const { codexDefaultFrom } = await import('../src/config.mjs');
  assert.equal(codexDefaultFrom({}, {}), false);
  assert.equal(codexDefaultFrom({ codexEnabled: true }, {}), true);
  assert.equal(codexDefaultFrom({ codexEnabled: 'yes' }, {}), false);
  assert.equal(codexDefaultFrom({ codexEnabled: true }, { PITWALL_CODEX: '0' }), false);
  assert.equal(codexDefaultFrom({}, { PITWALL_CODEX: '1' }), true);
});

test('config.codexExe is looked up again while Codex is missing (so an install is picked up without a restart)', async () => {
  const { config } = await import('../src/config.mjs');
  const d = Object.getOwnPropertyDescriptor(config, 'codexExe');
  assert.equal(typeof d.get, 'function', 'a getter, so every `config.codexExe` reader sees a fresh lookup');
  assert.ok(config.codexExe === null || typeof config.codexExe === 'string');
});
