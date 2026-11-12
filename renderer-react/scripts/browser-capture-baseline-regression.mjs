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

    // Compare two developer-owned private captures without writing intermediate
    // browser reports. Actions are deliberately not replayed without a saved plan.
    const rawPairMatch = join(dir, 'raw-pair-match.json');
    const pairMatch = run(['--before-capture', capturePath, '--after-capture', capturePath,
      '--strict', '--out', rawPairMatch]);
    assert.equal(pairMatch.status, 0, 'Two identical private captures must match in Chromium');
    assert.equal(JSON.parse(readFileSync(rawPairMatch, 'utf8')).ok, true);
    assert.equal(pairMatch.stdout, '', 'Raw private capture must not appear in stdout');

    // A vetted saved report may explicitly authorize the SAME bounded real
    // Button interaction in both private captures, without leaking its data.
    assert.equal(baseline.actionsVerified, 1);
    const plannedPairDiff = join(dir, 'raw-pair-action-match.json');
    const plannedPair = run(['--before-capture', capturePath, '--after-capture', capturePath,
      '--action-plan', baselinePath, '--strict', '--out', plannedPairDiff]);
    assert.equal(plannedPair.status, 0,
      'Vetted browser interaction must replay in both captures and match');
    assert.equal(JSON.parse(readFileSync(plannedPairDiff, 'utf8')).ok, true);
    assert.equal(plannedPair.stdout, '');

    // Compare actual emitted browser action payload equality without publishing
    // the payloads, reusable hashes, identifiers or the ephemeral HMAC key.
    const parityMatchPath = join(dir, 'private-action-parity-match.json');
    const parityMatch = run(['--before-capture', capturePath, '--after-capture', capturePath,
      '--action-plan', baselinePath, '--compare-actions', '--strict', '--out', parityMatchPath]);
    assert.equal(parityMatch.status, 0, 'The same real Chromium action must match in both runs');
    const matchingActions = JSON.parse(readFileSync(parityMatchPath, 'utf8'));
    assert.equal(matchingActions.actionPayloadParity, 'match');
    assert.equal(matchingActions.ok, true);
    assert.doesNotMatch(JSON.stringify(matchingActions), /privateActionDigest|[a-f0-9]{64}/,
      'Do not export reusable action fingerprints');

    const changedActionPath = join(dir, 'private-renamed-action.jsonl');
    const changedAction = lines.map(line => JSON.parse(line));
    const actionButton = changedAction[1].updateComponents.components.find(component =>
      component.id === 'submit');
    assert.ok(actionButton?.action?.event?.name);
    actionButton.action.event.name = 'PRIVATE_DIFFERENT_ACTION_DO_NOT_REPORT';
    writeFileSync(changedActionPath, changedAction.map(message => JSON.stringify(message)).join('\n') + '\n');

    const structuralOnly = run(['--before-capture', capturePath,
      '--after-capture', changedActionPath, '--action-plan', baselinePath, '--strict']);
    assert.equal(structuralOnly.status, 0,
      'Existing structural-only comparison should not claim payload parity');

    const changedActionDiff = join(dir, 'private-action-parity-drift.json');
    const actionDrift = run(['--before-capture', capturePath,
      '--after-capture', changedActionPath, '--action-plan', baselinePath,
      '--compare-actions', '--strict', '--out', changedActionDiff]);
    assert.equal(actionDrift.status, 1,
      'Opt-in action parity must detect an action change with the same count and UI');
    const actionResult = JSON.parse(readFileSync(changedActionDiff, 'utf8'));
    assert.equal(actionResult.actionPayloadParity, 'drift');
    assert.deepEqual(actionResult.changedSummaryFields, ['actionPayloadParity']);
    assert.equal(actionResult.differingSteps, 0);
    assert.doesNotMatch(JSON.stringify(actionResult),
      /PRIVATE_DIFFERENT_ACTION_DO_NOT_REPORT|private-renamed|private-original|alpha|selection|surfaceId|__privateActionDigest/,
      'Private action values, fingerprints and capture paths must stay out of reports');

    const unreachablePlanPath = join(dir, 'private-unreachable-plan.json');
    writeFileSync(unreachablePlanPath, JSON.stringify({...baseline,
      clickSingleButton: false, clickButtonIndex: 31}));
    const unreachable = run(['--before-capture', capturePath, '--after-capture', capturePath,
      '--action-plan', unreachablePlanPath, '--strict']);
    assert.equal(unreachable.status, 2, 'Unreachable vetted action must fail closed');
    assert.equal(unreachable.stdout, '');
    assert.doesNotMatch(unreachable.stderr,
      /private-unreachable-plan|private-original|action-replay|alpha|selection/,
      'Action failure must omit private paths and capture values');

    const rawPairDrift = join(dir, 'raw-pair-drift.json');
    const pairDrift = run(['--before-capture', capturePath, '--after-capture', driftPath,
      '--strict', '--out', rawPairDrift]);
    assert.equal(pairDrift.status, 1, 'Real Chromium must detect private capture event drift');
    const paired = JSON.parse(readFileSync(rawPairDrift, 'utf8'));
    assert.equal(paired.ok, false);
    assert.ok(paired.changedSummaryFields.includes('events'));
    assert.doesNotMatch(JSON.stringify(paired),
      /action-replay|alpha|selection|surfaceId|private-original/,
      'Raw-capture comparison must not publish private identifiers or input paths');

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
