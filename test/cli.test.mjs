import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const path = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

test('CLI emits structured, reproducible JSON with no network access', () => {
  const result = spawnSync(process.execPath, [path, 'scan', '--json', '--strict'], {encoding: 'utf8', timeout: 20000});
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.baseline.ok, true);
  assert.equal(report.divergenceCount, 9);
});

test('CLI rejects unknown arguments', () => {
  const result = spawnSync(process.execPath, [path, 'scan', '--not-a-real-option'], {encoding: 'utf8'});
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown or incomplete option/);
});
