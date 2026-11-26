import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, pickAsset } from '../src/shared/updates.js';

test('versions compare numerically', () => {
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1);
  assert.equal(compareVersions('v0.2.6', '0.2.6'), 0);
  assert.equal(compareVersions('0.2.6', '0.3.0'), -1);
  assert.equal(compareVersions('1.0', '0.9.9'), 1);
});

test('the right installer is chosen for each computer', () => {
  const assets = [{ name: 'RADHA-0.2.7-arm64.dmg' }, { name: 'RADHA-Setup-0.2.7-x64.exe' }, { name: 'RADHA-0.2.7-arm64.dmg.blockmap' }];
  assert.equal(pickAsset(assets, 'darwin', 'arm64').name, 'RADHA-0.2.7-arm64.dmg');
  assert.equal(pickAsset(assets, 'win32', 'x64').name, 'RADHA-Setup-0.2.7-x64.exe');
  assert.equal(pickAsset(assets, 'darwin', 'x64'), null); // Intel Macs have no build
  assert.equal(pickAsset(assets, 'linux', 'x64'), null);
});
