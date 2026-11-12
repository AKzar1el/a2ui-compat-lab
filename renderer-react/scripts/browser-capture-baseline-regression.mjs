import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const compareScript = resolve(repo, 'src/browser-capture-summary-compare.mjs');

/** End-to-end published React/Chromium private-capture comparison, not a mocked report. */
export function testDirectBrowserCaptureBaseline(encodedCapture, baseline) {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-browser-private-baseline-'));
  const run = args => spawnSync(process.execPath, [compareScript, ...args], {
    cwd: repo, encoding: 'utf8', windowsHide: true,
    timeout: 120000, maxBuffer: 256 * 1024,
  });
  try {
    const baselinePath = join(dir, 'browser-baseline.json');
    const capturePath = join(dir, 'private-original.jsonl');
    const matchingDiff = join(dir, 'match.json');
    const driftPath = join(dir, 'private-drift.jsonl');
    const driftDiff = join(dir, 'drift.json');
    const invalidPath = join(dir, 'private-invalid.jsonl');
    writeFileSync(baselinePath, JSON.stringify(baseline));
    writeFileSync(capturePath, encodedCapture);

    const match = run(['--before', baselinePath, '--after-capture', capturePath,
      '--strict', '--out', matchingDiff]);
    assert.equal(match.status, 0, 'Direct private capture must match a real Chromium baseline');
    assert.equal(JSON.parse(readFileSync(matchingDiff, 'utf8')).ok, true);
    assert.equal(match.stdout, '', 'Output file mode must not echo a capture report');

    // A valid duplicate agent update changes lifecycle structure while keeping
    // the same rendered Button and action plan; strict mode must report drift.
    const lines = encodedCapture.toString('utf8').trimEnd().split('\n');
    writeFileSync(driftPath, encodedCapture.toString('utf8') + lines.at(-1) + '\n');
    const drift = run(['--before', baselinePath, '--after-capture', driftPath,
      '--strict', '--out', driftDiff]);
    assert.equal(drift.status, 1, 'Direct private capture must detect added event boundaries');
    const changes = JSON.parse(readFileSync(driftDiff, 'utf8'));
    assert.equal(changes.ok, false);
    assert.ok(changes.changedSummaryFields.includes('events'));
    assert.deepEqual(changes.changedSteps.at(-1), {index: baseline.events, fields: ['presence']});
    assert.doesNotMatch(JSON.stringify(changes), /action-replay|alpha|selection|surfaceId/,
      'Structural diff must never copy private values or identifiers');

    writeFileSync(invalidPath, '{"modelSecret":"TOP_SECRET_CAPTURE_VALUE"}\n');
    const refused = run(['--before', baselinePath, '--after-capture', invalidPath]);
    assert.equal(refused.status, 2, 'Malformed private captures must fail closed');
    assert.equal(refused.stdout, '');
    assert.doesNotMatch(refused.stderr, /TOP_SECRET_CAPTURE_VALUE|private-invalid/,
      'Refused capture must not leak input text or paths');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}
