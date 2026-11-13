import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const compareScript = resolve(repo, 'src/browser-capture-summary-compare.mjs');

/** End-to-end published React/Chromium private-capture comparison, not a mocked report. */
export function testDirectBrowserCaptureBaseline(encodedCapture, baseline, twoActionEvidence) {
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

    // Changing only private text preserves all structural counts, but the real
    // rendered Text node changes. The opt-in comparison must detect that.
    const changedVisible = encodedCapture.toString('utf8').trimEnd()
      .split('\n').map(line => JSON.parse(line));
    assert.equal(changedVisible[2].updateDataModel.value.selection, 'alpha');
    changedVisible[2].updateDataModel.value.selection = 'PRIVATE_RENDERED_TEXT_DIFFERENCE';
    const visibleChangePath = join(dir, 'private-visible-after.jsonl');
    writeFileSync(visibleChangePath,
      changedVisible.map(message => JSON.stringify(message)).join('\n') + '\n');

    const unchangedStructure = run(['--before-capture', capturePath,
      '--after-capture', visibleChangePath, '--strict']);
    assert.equal(unchangedStructure.status, 0,
      'Existing structural counts intentionally do not compare rendered values');
    assert.equal(JSON.parse(unchangedStructure.stdout).ok, true);

    const visibleMatchPath = join(dir, 'rendered-text-match.json');
    const visibleMatch = run(['--before-capture', capturePath,
      '--after-capture', capturePath, '--compare-rendered-text', '--strict',
      '--out', visibleMatchPath]);
    assert.equal(visibleMatch.status, 0,
      'Identical private captures must render the same text in real Chromium');
    const visibleMatchReport = JSON.parse(readFileSync(visibleMatchPath, 'utf8'));
    assert.equal(visibleMatchReport.renderedTextParity, 'match');
    assert.equal(visibleMatchReport.ok, true);
    assert.equal(Object.hasOwn(visibleMatchReport, 'firstDifferentRenderedTextEventIndex'), false);

    const visibleDiffPath = join(dir, 'rendered-text-drift.json');
    const visibleDrift = run(['--before-capture', capturePath,
      '--after-capture', visibleChangePath, '--compare-rendered-text', '--strict',
      '--out', visibleDiffPath]);
    assert.equal(visibleDrift.status, 1,
      'Changed rendered private Text must DRIFT even when UI counts MATCH');
    const visibleDiff = JSON.parse(readFileSync(visibleDiffPath, 'utf8'));
    assert.equal(visibleDiff.renderedTextParity, 'drift');
    assert.equal(visibleDiff.firstDifferentRenderedTextEventIndex, 2);
    assert.deepEqual(visibleDiff.changedSummaryFields, ['renderedTextParity']);
    assert.equal(visibleDiff.differingSteps, 0);
    assert.doesNotMatch(JSON.stringify(visibleDiff),
      /PRIVATE_RENDERED_TEXT_DIFFERENCE|private-visible-after|alpha|selection|surfaceId|__[A-Za-z]*Digest|[a-f0-9]{64}/,
      'Private rendered text, paths, digest keys and reusable hashes must not leave the process');

    const illegalVisiblePlan = run(['--before-capture', capturePath,
      '--after-capture', visibleChangePath, '--action-plan', baselinePath,
      '--compare-rendered-text']);
    assert.equal(illegalVisiblePlan.status, 2,
      'Private rendered-text comparison cannot activate Button actions');
    assert.equal(illegalVisiblePlan.stdout, '');
    assert.doesNotMatch(illegalVisiblePlan.stderr,
      /private-visible-after|PRIVATE_RENDERED_TEXT_DIFFERENCE|alpha/,
      'Mode errors must redact capture values and file names');

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
    assert.equal(Object.hasOwn(matchingActions, 'firstDifferentActionIndex'), false);
    assert.doesNotMatch(JSON.stringify(matchingActions), /privateActionDigest|[a-f0-9]{64}/,
      'Do not export reusable action fingerprints');

    // JSON object members are unordered: only changing context key insertion
    // order in a real published-SDK Chromium action must not trigger parity drift.
    const orderBefore = lines.map(line => JSON.parse(line));
    const beforeButton = orderBefore[1].updateComponents.components.find(component =>
      component.id === 'submit');
    assert.deepEqual(Object.keys(beforeButton.action.event.context), ['selection']);
    beforeButton.action.event.context.confirmed = {path: '/confirmed'};
    const orderAfter = structuredClone(orderBefore);
    const afterButton = orderAfter[1].updateComponents.components.find(component =>
      component.id === 'submit');
    afterButton.action.event.context = {
      confirmed: {path: '/confirmed'},
      selection: {path: '/selection'},
    };
    const orderBeforePath = join(dir, 'private-context-order-before.jsonl');
    const orderAfterPath = join(dir, 'private-context-order-after.jsonl');
    const orderDiffPath = join(dir, 'private-context-order-diff.json');
    writeFileSync(orderBeforePath, orderBefore.map(message => JSON.stringify(message)).join('\n') + '\n');
    writeFileSync(orderAfterPath, orderAfter.map(message => JSON.stringify(message)).join('\n') + '\n');
    const sameContext = run(['--before-capture', orderBeforePath,
      '--after-capture', orderAfterPath, '--action-plan', baselinePath,
      '--compare-actions', '--strict', '--out', orderDiffPath]);
    assert.equal(sameContext.status, 0,
      'Permuting JSON object keys must not mark identical Chromium actions as drift');
    const sameContextReport = JSON.parse(readFileSync(orderDiffPath, 'utf8'));
    assert.equal(sameContextReport.actionPayloadParity, 'match');
    assert.equal(sameContextReport.ok, true);
    assert.equal(Object.hasOwn(sameContextReport, 'firstDifferentActionIndex'), false);
    assert.doesNotMatch(JSON.stringify(sameContextReport),
      /private-context-order|selection|confirmed|surfaceId|__privateActionDigest|[a-f0-9]{64}/,
      'Context names, private paths and fingerprints must stay out of parity reports');

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
    assert.equal(actionResult.firstDifferentActionIndex, 0);
    assert.deepEqual(actionResult.changedSummaryFields, ['actionPayloadParity']);
    assert.equal(actionResult.differingSteps, 0);
    assert.doesNotMatch(JSON.stringify(actionResult),
      /PRIVATE_DIFFERENT_ACTION_DO_NOT_REPORT|private-renamed|private-original|alpha|selection|surfaceId|__privateActionDigest/,
      'Private action values, fingerprints and capture paths must stay out of reports');

    // A separately verified real Chromium plan emits two distinct Button
    // actions at the same boundary. Alter only the SECOND action's name.
    assert.equal(twoActionEvidence.report.actionsVerified, 2);
    assert.equal(twoActionEvidence.report.actionsEmitted, 2);
    const twoCapturePath = join(dir, 'private-two-action-before.jsonl');
    const twoChangedPath = join(dir, 'private-two-action-after.jsonl');
    const twoPlanPath = join(dir, 'vetted-two-action-report.json');
    const twoDiffPath = join(dir, 'two-action-diff.json');
    writeFileSync(twoCapturePath, twoActionEvidence.capture);
    writeFileSync(twoPlanPath, JSON.stringify(twoActionEvidence.report));
    const modified = twoActionEvidence.capture.toString('utf8').trimEnd()
      .split('\n').map(line => JSON.parse(line));
    const secondPlannedButton = modified[1].updateComponents.components.find(component =>
      component.id === 'submit');
    assert.ok(secondPlannedButton?.action?.event?.name);
    secondPlannedButton.action.event.name = 'PRIVATE_SECOND_ONLY_ACTION_DRIFT';
    writeFileSync(twoChangedPath, modified.map(message => JSON.stringify(message)).join('\n') + '\n');
    const secondOnlyDrift = run(['--before-capture', twoCapturePath,
      '--after-capture', twoChangedPath, '--action-plan', twoPlanPath,
      '--compare-actions', '--strict', '--out', twoDiffPath]);
    assert.equal(secondOnlyDrift.status, 1,
      'Real Chromium should localize the second differing emitted action');
    const localized = JSON.parse(readFileSync(twoDiffPath, 'utf8'));
    assert.equal(localized.actionPayloadParity, 'drift');
    assert.equal(localized.firstDifferentActionIndex, 1);
    assert.equal(localized.differingSteps, 0,
      'Per-action parity must reveal a change invisible to structural counts');
    assert.doesNotMatch(JSON.stringify(localized),
      /PRIVATE_SECOND_ONLY_ACTION_DRIFT|private-two-action|submit-second|selection|alpha|surfaceId|__privateActionDigest|[a-f0-9]{64}/,
      'Never persist private action text, paths, keys or reusable digests');

    // Two independent opt-in checks should work in one vetted Chromium replay.
    // Without a reviewed action plan, combining them must not activate controls.
    const dualDenied = run(['--before-capture', capturePath,
      '--after-capture', changedActionPath, '--compare-actions',
      '--compare-rendered-text', '--strict']);
    assert.equal(dualDenied.status, 2,
      'Combined action and rendered-text parity must reject an unvetted plan');
    assert.equal(dualDenied.stdout, '');

    const dualMatchPath = join(dir, 'dual-parity-match.json');
    const dualMatch = run(['--before-capture', capturePath,
      '--after-capture', capturePath, '--action-plan', baselinePath,
      '--compare-actions', '--compare-rendered-text', '--strict', '--out', dualMatchPath]);
    assert.equal(dualMatch.status, 0, 'Reviewed plan should allow both parity checks together');
    const dualSame = JSON.parse(readFileSync(dualMatchPath, 'utf8'));
    assert.equal(dualSame.ok, true);
    assert.equal(dualSame.actionPayloadParity, 'match');
    assert.equal(dualSame.renderedTextParity, 'match');

    const dualDriftPath = join(dir, 'dual-parity-action-drift.json');
    const dualDrift = run(['--before-capture', capturePath,
      '--after-capture', changedActionPath, '--action-plan', baselinePath,
      '--compare-actions', '--compare-rendered-text', '--strict', '--out', dualDriftPath]);
    assert.equal(dualDrift.status, 1, 'Reviewed combined replay must detect action-only drift');
    const dualChanged = JSON.parse(readFileSync(dualDriftPath, 'utf8'));
    assert.equal(dualChanged.actionPayloadParity, 'drift');
    assert.equal(dualChanged.renderedTextParity, 'match');
    assert.equal(dualChanged.firstDifferentActionIndex, 0);
    assert.doesNotMatch(JSON.stringify(dualChanged),
      /PRIVATE_DIFFERENT_ACTION_DO_NOT_REPORT|private-renamed|alpha|selection|surfaceId|__[A-Za-z]*Digest|[a-f0-9]{64}/,
      'Both private signals must discard keys, hashes and capture values');

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
