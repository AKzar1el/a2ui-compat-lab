import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compareScans} from '../src/compare.mjs';
import {evaluate, checkBaseline} from '../src/differential.mjs';

function scan(decisions, version = '0.15.0') {
  const rows = decisions.map(([id, referenceValid, webCoreValid]) => ({
    id, referenceValid, webCoreValid, divergent: referenceValid !== webCoreValid,
  }));
  const divergenceIds = rows.filter(row => row.divergent).map(row => row.id).sort();
  return {reportVersion: 1, implementations: {webCore: version, reference: 'Ajv format assertions off'},
    fixtureCount: rows.length, divergenceCount: divergenceIds.length, divergenceIds, rows};
}

test('comparison records fixes, regressions, reference drift and direction flips separately', () => {
  const before = scan([
    ['persist', false, true], ['fixed', false, true], ['regression', false, false],
    ['flipped', false, true], ['control', true, true], ['stable', true, true],
  ]);
  const after = scan([
    ['stable', true, true], ['control', false, false], ['flipped', true, false],
    ['regression', false, true], ['fixed', false, false], ['persist', false, true],
  ], '0.16.0');
  const result = compareScans(before, after);
  assert.equal(result.ok, false);
  assert.equal(result.comparedFixtures, 6);
  assert.deepEqual(result.resolved, ['fixed']);
  assert.deepEqual(result.newlyObserved, ['regression']);
  assert.deepEqual(result.persistent, ['persist']);
  assert.deepEqual(result.directionChanged, ['flipped']);
  assert.deepEqual(result.referenceChanged, ['control', 'flipped']);
  assert.deepEqual(result.decisionChanged, ['control', 'fixed', 'flipped', 'regression']);
  assert.equal(result.stableControls, 1);
  assert.equal(result.after.webCore, '0.16.0');
  assert.deepEqual(result.addedFixtures, []);
});

test('fixture additions/removals are reviewable rather than silently treated as fixes', () => {
  const result = compareScans(scan([['removed', false, true], ['shared', true, true]]),
    scan([['added', false, true], ['shared', true, true]]));
  assert.deepEqual(result.removedFixtures, ['removed']);
  assert.deepEqual(result.addedFixtures, ['added']);
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(result.newlyObserved, []);
  assert.equal(result.ok, false);
});

test('malformed, contradictory and duplicate reports fail closed', () => {
  const valid = scan([['one', false, true]]);
  assert.throws(() => compareScans({...valid, divergenceCount: 0}, valid), /inconsistent/);
  assert.throws(() => compareScans({...valid, divergenceIds: []}, valid), /inconsistent/);
  assert.throws(() => compareScans({...valid, rows: [...valid.rows, valid.rows[0]], fixtureCount: 2}, valid), /duplicate/);
  assert.throws(() => compareScans({...valid, rows: [{...valid.rows[0], divergent: false}]}, valid), /malformed/);
  assert.throws(() => compareScans({...valid, reportVersion: 2}, valid), /version-1/);
});

test('changing the reference validator configuration is not silently treated as parity', () => {
  const before = scan([['a', true, true]]);
  const after = structuredClone(before);
  after.implementations.reference = 'Ajv with format assertions enabled';
  const result = compareScans(before, after);
  assert.equal(result.ok, false);
  assert.equal(result.referenceImplementationChanged, true);
});

test('scan baseline fails if SDK installation disagrees with the pinned version', () => {
  const report = evaluate();
  assert.equal(report.implementations.webCore, '0.15.0');
  assert.match(report.implementations.reference, /^Ajv 8\.20\.0 \/ JSON Schema Draft 2020-12, format assertions off$/);
  const mismatched = structuredClone(report);
  mismatched.implementations.webCore = '0.16.0';
  const check = checkBaseline(mismatched);
  assert.equal(check.ok, false);
  assert.equal(check.expectedWebCoreVersion, '0.15.0');
  assert.equal(check.observedWebCoreVersion, '0.16.0');
});

test('comparison CLI bounds report size and redacts malformed JSON in either input', () => {
  const root = mkdtempSync(join(tmpdir(), 'a2ui-compare-private-'));
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  try {
    const valid = join(root, 'valid.json');
    const invalid = join(root, 'invalid.json');
    const huge = join(root, 'huge.json');
    writeFileSync(valid, JSON.stringify(scan([['ok', true, true]])));
    writeFileSync(invalid, '{"secret":LEAK1234_PRIVATE_SCAN}\n');
    writeFileSync(huge, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    for (const flag of ['--before', '--after']) {
      const args = flag === '--before'
        ? ['--before', invalid, '--after', valid]
        : ['--before', valid, '--after', invalid];
      const bad = spawnSync(process.execPath, [cli, 'compare', ...args, '--strict'], {
        encoding: 'utf8', timeout: 20000,
      });
      assert.equal(bad.status, 2, bad.stderr);
      assert.match(bad.stderr, /Comparison JSON is invalid; input contents omitted/);
      assert.doesNotMatch(bad.stderr, /LEAK1234|PRIVATE_SCAN/);
      assert.equal(bad.stdout, '');
    }
    const oversized = spawnSync(process.execPath, [cli, 'compare', '--before', huge, '--after', valid], {
      encoding: 'utf8', timeout: 20000,
    });
    assert.equal(oversized.status, 2, oversized.stderr);
    assert.match(oversized.stderr, /regular JSON file of 1 byte to 8 MiB/);
    assert.equal(oversized.stdout, '');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('comparison CLI is offline, deterministic, and strict on observed drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'a2ui-compare-'));
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  try {
    const before = scan([['a', false, true], ['b', false, false]]);
    const after = scan([['a', false, false], ['b', false, false]], '0.16.0');
    const prev = join(root, 'before.json'), next = join(root, 'after.json');
    writeFileSync(prev, JSON.stringify(before));
    writeFileSync(next, JSON.stringify(after));
    const good = spawnSync(process.execPath, [cli, 'compare', '--before', prev, '--after', prev, '--strict', '--json'], {encoding: 'utf8', timeout: 20000});
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).ok, true);
    const drift = spawnSync(process.execPath, [cli, 'compare', '--before', prev, '--after', next, '--strict', '--json'], {encoding: 'utf8', timeout: 20000});
    assert.equal(drift.status, 1, drift.stderr);
    assert.deepEqual(JSON.parse(drift.stdout).resolved, ['a']);
    const bad = spawnSync(process.execPath, [cli, 'compare', '--before', prev, '--strict'], {encoding: 'utf8', timeout: 20000});
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /requires --before FILE and --after FILE/);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});


test('scan comparison refuses byte-corrupted but syntactically valid UTF-8 in either report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-scan-utf8-'));
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  try {
    const report = scan([['one', true, true]]);
    const good = join(dir, 'good.json');
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(good, JSON.stringify(report));
    const bytes = Buffer.from(JSON.stringify({
      ...report,
      implementations: {...report.implementations, reference: 'PRIVATE_SCAN_UTF8_MARKER'},
    }));
    const index = bytes.indexOf(Buffer.from('PRIVATE_SCAN_UTF8_MARKER'));
    assert.ok(index > 0);
    bytes[index] = 0xff;
    writeFileSync(corrupt, bytes);
    for (const [before, after] of [[corrupt, good], [good, corrupt], [corrupt, corrupt]]) {
      const result = spawnSync(process.execPath,
        [cli, 'compare', '--before', before, '--after', after, '--strict', '--json'],
        {encoding: 'utf8', timeout: 20000});
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Comparison JSON contains invalid UTF-8/);
      assert.doesNotMatch(result.stderr, /RIVATE_SCAN_UTF8_MARKER/);
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
