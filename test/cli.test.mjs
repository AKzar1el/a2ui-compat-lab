import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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

test('CLI reports its own version without importing SDK runtime', () => {
  const result = spawnSync(process.execPath, [path, '--version'], {encoding: 'utf8', timeout: 5000});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '0.1.0');
});

test('CLI doctor emits offline JSON and verifies direct package installation', () => {
  const result = spawnSync(process.execPath, [path, 'doctor', '--strict', '--json'], {encoding: 'utf8', timeout: 5000});
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.reportVersion, 1);
  assert.equal(report.packages.length, 2);
  assert.ok(report.packages.every(item => item.ok));
});

test('CLI rejects options on --version instead of ignoring them', () => {
  const result = spawnSync(process.execPath, [path, '--version', '--json'], {encoding: 'utf8', timeout: 5000});
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Version command takes no options/);
});

test('CLI rejects repeated flags before selecting comparison evidence', () => {
  for (const args of [
    ['scan', '--out', 'first.json', '--out', 'second.json'],
    ['compare', '--before', 'one.json', '--before', 'two.json', '--after', 'three.json'],
    ['compare', '--before', 'one.json', '--after', 'two.json', '--after', 'three.json'],
    ['scan', '--strict', '--strict'],
    ['scan', '--json', '--json'],
  ]) {
    const result = spawnSync(process.execPath, [path, ...args],
      {encoding: 'utf8', timeout: 5000});
    assert.equal(result.status, 2, args.join(' ') + ': ' + result.stderr);
    assert.match(result.stderr, /Duplicate option:/);
    assert.equal(result.stdout, '', 'Invalid invocations must not print a report');
  }
});

test('CLI refuses flag tokens used as file paths without creating artifacts', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'a2ui-cli-options-'));
  try {
    for (const args of [
      ['scan', '--out', '--strict'],
      ['scan', '--out', '--json'],
      ['scan', '--out'],
      ['compare', '--before', '--after', 'later.json'],
    ]) {
      const result = spawnSync(process.execPath, [path, ...args],
        {cwd, encoding: 'utf8', timeout: 5000});
      assert.equal(result.status, 2, args.join(' ') + ': ' + result.stderr);
      assert.match(result.stderr, /Missing value for option:/);
      assert.equal(result.stdout, '', 'An incomplete flag must not run the SDK scan');
    }
    assert.equal(existsSync(join(cwd, '--strict')), false,
      'A missing --out value must not create a file named --strict');
    assert.equal(existsSync(join(cwd, '--json')), false,
      'A missing --out value must not create a file named --json');
  } finally {
    rmSync(cwd, {recursive: true, force: true});
  }
});

test('CLI scan and doctor never overwrite existing report evidence', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'a2ui-cli-evidence-'));
  try {
    for (const verb of ['scan', 'doctor']) {
      const target = join(cwd, verb + '.json');
      const args = [path, verb, '--out', target];
      const first = spawnSync(process.execPath, args,
        {cwd, encoding: 'utf8', timeout: 20000});
      assert.equal(first.status, 0, verb + ': ' + first.stderr);
      const original = readFileSync(target, 'utf8');
      assert.ok(JSON.parse(original).reportVersion,
        'The first run must produce a valid machine-readable report');
      const second = spawnSync(process.execPath, args,
        {cwd, encoding: 'utf8', timeout: 20000});
      assert.equal(second.status, 2, verb + ': ' + second.stderr);
      assert.match(second.stderr, /Report output already exists; choose a new --out path/);
      assert.equal(second.stdout, '', 'A rejected overwrite must not report success');
      assert.equal(readFileSync(target, 'utf8'), original,
        verb + ' must preserve prior output byte-for-byte');
    }
  } finally {
    rmSync(cwd, {recursive: true, force: true});
  }
});
