import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  resolveBrowserEvidenceDir, assertBrowserEvidenceUnused, publishBrowserEvidence,
} from '../src/browser-evidence.mjs';

test('browser evidence output names reject ambiguous and escaping CLI arguments', () => {
  const root = '/safe/renderer-react';
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
    const screenshot = Buffer.from('test-png-content');
    const report = {schemaVersion: 1, passed: true, actions: [{name: 'confirm'}]};
    assertBrowserEvidenceUnused(target);
    assert.throws(() => publishBrowserEvidence(join(root, 'not-published'),
      Buffer.alloc(0), report), /non-empty screenshot/);
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
