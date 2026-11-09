import {test} from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  resolveBrowserEvidenceDir, assertBrowserEvidenceUnused, publishBrowserEvidence,
} from '../src/browser-evidence.mjs';

test('browser evidence output names reject ambiguous and escaping CLI arguments', () => {
  const root = join(tmpdir(), 'a2ui-browser-root');
  assert.equal(resolveBrowserEvidenceDir(root, []), join(root, 'out'));
  assert.equal(resolveBrowserEvidenceDir(root, ['--out-dir', 'run-2']), join(root, 'run-2'));
  for (const args of [
    ['--out-dir'], ['--unknown'], ['--out-dir', '--another'], ['--out-dir', '.'],
    ['--out-dir', '..'], ['--out-dir', '../outside'], ['--out-dir', 'a/b'],
    ['--out-dir', 'C:\\external'], ['--out-dir', 'run', 'extra'],
  ]) assert.throws(() => resolveBrowserEvidenceDir(root, args), /Usage:/);
});

test('successful browser evidence is exclusive and preserves older artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'a2ui-browser-output-'));
  try {
    const target = join(root, 'out');
    const screenshot = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==',
      'base64');
    const report = {schemaVersion: 1, passed: true,
      screenshotSha256: createHash('sha256').update(screenshot).digest('hex'),
      actions: [{name: 'confirm'}]};
    assertBrowserEvidenceUnused(target);
    assert.throws(() => publishBrowserEvidence(join(root, 'not-published'),
      Buffer.alloc(0), report), /valid PNG/);
    assert.throws(() => publishBrowserEvidence(join(root, 'failed-run'),
      screenshot, {passed: false}), /passing replay report/);
    assert.equal(existsSync(join(root, 'failed-run')), false);

    const first = publishBrowserEvidence(target, screenshot, report);
    assert.deepEqual(readFileSync(first.screenshotPath), screenshot);
    assert.deepEqual(JSON.parse(readFileSync(first.tracePath, 'utf8')), report);
    assert.throws(() => assertBrowserEvidenceUnused(target), /already exists/);
    assert.throws(() => publishBrowserEvidence(target, Buffer.from('changed'), report),
      /already exists/);
    assert.deepEqual(readFileSync(first.screenshotPath), screenshot);
    assert.deepEqual(JSON.parse(readFileSync(first.tracePath, 'utf8')), report);

    const second = publishBrowserEvidence(join(root, 'run-2'), screenshot, report);
    assert.equal(existsSync(second.tracePath), true);
    assert.deepEqual(readFileSync(first.screenshotPath), screenshot);
    mkdirSync(join(root, 'reserved'));
    writeFileSync(join(root, 'reserved', 'user.txt'), 'keep');
    assert.throws(() => publishBrowserEvidence(join(root, 'reserved'), screenshot, report),
      /already exists/);
    assert.equal(readFileSync(join(root, 'reserved', 'user.txt'), 'utf8'), 'keep');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('PNG and digest preflight refuses invalid evidence without creating output paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'a2ui-png-preflight-'));
  try {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==',
      'base64');
    const digest = createHash('sha256').update(png).digest('hex');
    const valid = {schemaVersion: 1, passed: true, screenshotSha256: digest};
    const cases = [
      ['invalid-png', Buffer.from('not-a-png'), valid, /valid PNG/],
      ['wrong-digest', png, {...valid, screenshotSha256: '0'.repeat(64)}, /matching SHA-256/],
      ['missing-digest', png, {schemaVersion: 1, passed: true}, /matching SHA-256/],
      ['malformed-digest', png, {...valid, screenshotSha256: 'private-value'}, /matching SHA-256/],
      ['failed-replay', png, {...valid, passed: false}, /passing replay/],
    ];
    for (const [name, screenshot, report, error] of cases) {
      const output = join(root, name);
      assert.throws(() => publishBrowserEvidence(output, screenshot, report), error);
      assert.equal(existsSync(output), false, name + ' must not publish partial evidence');
    }

    const circular = {...valid};
    circular.self = circular;
    const path = join(root, 'not-serializable');
    assert.throws(() => publishBrowserEvidence(path, png, circular), /not JSON-serializable/);
    assert.equal(existsSync(path), false, 'Serialization failure must happen before mkdir');

    const upper = {...valid, screenshotSha256: digest.toUpperCase()};
    const created = publishBrowserEvidence(join(root, 'uppercase-digest'), png, upper);
    assert.deepEqual(readFileSync(created.screenshotPath), png);
    assert.equal(JSON.parse(readFileSync(created.tracePath, 'utf8')).screenshotSha256,
      digest.toUpperCase());
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
