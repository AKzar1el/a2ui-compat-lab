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

    // A private first-error comparator must distinguish clean captures from an
    // observed Chromium failure without executing captured Button actions.
    const errorCompare = resolve(repo, 'src/browser-capture-error-boundary-compare.mjs');
    const runErrorCompare = args => spawnSync(process.execPath, [errorCompare, ...args], {
      cwd: repo, encoding: 'utf8', windowsHide: true,
      timeout: 120000, maxBuffer: 256 * 1024,
    });
    const cleanErrorMatch = runErrorCompare(['--before-capture', capturePath,
      '--after-capture', capturePath, '--strict']);
    assert.equal(cleanErrorMatch.status, 0, 'Two healthy private Chromium captures must match');
    const cleanBoundary = JSON.parse(cleanErrorMatch.stdout);
    assert.equal(cleanBoundary.errorBoundaryParity, 'match');
    assert.equal(cleanBoundary.beforeFirstObservedFailureEventIndex, null);
    assert.equal(cleanBoundary.afterFirstObservedFailureEventIndex, null);
    assert.equal(cleanBoundary.ok, true);

    const eventsForErrors = encodedCapture.toString('utf8').trimEnd()
      .split('\n').map(line => JSON.parse(line));
    assert.ok(eventsForErrors.length >= 3);
    const failureAtSecond = structuredClone(eventsForErrors);
    failureAtSecond[1].updateComponents = null;
    const failureAtThird = structuredClone(eventsForErrors);
    failureAtThird[2].updateDataModel = null;
    const secondFailurePath = join(dir, 'private-error-second.jsonl');
    const thirdFailurePath = join(dir, 'private-error-third.jsonl');
    writeFileSync(secondFailurePath, failureAtSecond.map(x => JSON.stringify(x)).join('\n') + '\n');
    writeFileSync(thirdFailurePath, failureAtThird.map(x => JSON.stringify(x)).join('\n') + '\n');

    const sameFailure = runErrorCompare(['--before-capture', thirdFailurePath,
      '--after-capture', thirdFailurePath, '--strict']);
    assert.equal(sameFailure.status, 0, 'A matching observed failure boundary is parity, not health');
    const sameFailureResult = JSON.parse(sameFailure.stdout);
    assert.equal(sameFailureResult.errorBoundaryParity, 'match');
    assert.equal(sameFailureResult.beforeFirstObservedFailureEventIndex, 2);
    assert.equal(sameFailureResult.afterFirstObservedFailureEventIndex, 2);

    const newlyBroken = runErrorCompare(['--before-capture', capturePath,
      '--after-capture', thirdFailurePath, '--strict']);
    assert.equal(newlyBroken.status, 1, 'A newly failing Chromium event must be CI drift');
    const newFailure = JSON.parse(newlyBroken.stdout);
    assert.equal(newFailure.errorBoundaryParity, 'drift');
    assert.equal(newFailure.beforeFirstObservedFailureEventIndex, null);
    assert.equal(newFailure.afterFirstObservedFailureEventIndex, 2);
    assert.equal(newFailure.ok, false);
    assert.doesNotMatch(newlyBroken.stdout, /private-error|selection|alpha|surfaceId|stack|__private/,
      'Do not echo capture values, paths or browser error text');

    const shiftedFailure = runErrorCompare(['--before-capture', secondFailurePath,
      '--after-capture', thirdFailurePath, '--strict']);
    assert.equal(shiftedFailure.status, 1, 'Moved failing boundary must be visible in real Chromium');
    const moved = JSON.parse(shiftedFailure.stdout);
    assert.equal(moved.beforeEvents, moved.afterEvents);
    assert.equal(moved.beforeFirstObservedFailureEventIndex, 1);
    assert.equal(moved.afterFirstObservedFailureEventIndex, 2);

    const incompatibleMode = runErrorCompare(['--before-capture', capturePath,
      '--after-capture', thirdFailurePath, '--action-plan', baselinePath]);
    assert.equal(incompatibleMode.status, 2, 'First-error compare must never authorize actions');
    assert.equal(incompatibleMode.stdout, '');
    const malformedInput = join(dir, 'private-invalid-error-input.jsonl');
    writeFileSync(malformedInput, '{"privateSecret":"DO_NOT_EXPORT_FIRST_ERROR_CANARY"}\n');
    const malformed = runErrorCompare(['--before-capture', capturePath,
      '--after-capture', malformedInput, '--strict']);
    assert.equal(malformed.status, 2, 'Malformed private input must fail closed');
    assert.equal(malformed.stdout, '');
    assert.doesNotMatch(malformed.stderr,
      /DO_NOT_EXPORT_FIRST_ERROR_CANARY|private-invalid-error-input|surfaceId|stack/,
      'Never disclose malformed private capture values');

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

    // A Row-versus-Column layout can move an interactive control while the
    // published browser structural report still observes identical counts.
    const geometryMessages = encodedCapture.toString('utf8').trimEnd()
      .split('\n').map(line => JSON.parse(line));
    // Stable, nonempty Text guarantees that Row and Column relocate the Button
    // before any model path is initialized; both captures use identical Text.
    geometryMessages[1].updateComponents.components.find(
      component => component.id === 'status').text = 'PRIVATE_STATIC_GEOMETRY_STATUS';
    const geometryBeforePath = join(dir, 'private-geometry-baseline.jsonl');
    writeFileSync(geometryBeforePath,
      geometryMessages.map(message => JSON.stringify(message)).join('\n') + '\n');
    const geometryShifted = structuredClone(geometryMessages);
    const geometryRoot = geometryShifted[1].updateComponents.components.find(
      component => component.id === 'root');
    assert.equal(geometryRoot.component, 'Column');
    geometryRoot.component = 'Row';
    const geometryAfterPath = join(dir, 'private-geometry-shift.jsonl');
    writeFileSync(geometryAfterPath,
      geometryShifted.map(message => JSON.stringify(message)).join('\n') + '\n');
    const layoutBlind = run(['--before-capture', geometryBeforePath,
      '--after-capture', geometryAfterPath, '--strict']);
    assert.equal(layoutBlind.status, 0, 'Structural browser parity does not test geometry');
    assert.equal(JSON.parse(layoutBlind.stdout).ok, true);
    const geometrySame = run(['--before-capture', geometryBeforePath,
      '--after-capture', geometryBeforePath, '--compare-button-geometry', '--strict']);
    assert.equal(geometrySame.status, 0,
      'Identical private captures must preserve real Chromium Button positions');
    assert.equal(JSON.parse(geometrySame.stdout).buttonGeometryParity, 'match');
    const geometryDiff = run(['--before-capture', geometryBeforePath,
      '--after-capture', geometryAfterPath, '--compare-button-geometry', '--strict']);
    assert.equal(geometryDiff.status, 1,
      'Real Chromium should detect Button relocation without changed structural counts');
    const shiftedGeometry = JSON.parse(geometryDiff.stdout);
    assert.equal(shiftedGeometry.buttonGeometryParity, 'drift');
    assert.equal(shiftedGeometry.firstDifferentButtonGeometryEventIndex, 1);
    assert.deepEqual(shiftedGeometry.changedSummaryFields, ['buttonGeometryParity']);
    assert.equal(shiftedGeometry.differingSteps, 0);
    assert.doesNotMatch(JSON.stringify(shiftedGeometry),
      /private-geometry-shift|action-replay|alpha|selection|surfaceId|__private|[a-f0-9]{64}/,
      'Button geometry reports must not disclose private inputs or reusable digests');
    const geometrySavedRefusal = run(['--before', baselinePath,
      '--after-capture', geometryAfterPath, '--compare-button-geometry']);
    const geometryActionRefusal = run(['--before-capture', geometryBeforePath,
      '--after-capture', geometryAfterPath, '--action-plan', baselinePath,
      '--compare-button-geometry']);
    assert.equal(geometrySavedRefusal.status, 2);
    assert.equal(geometryActionRefusal.status, 2,
      'Geometry observation never activates approved Button actions');

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

    const dualTextPath = join(dir, 'dual-parity-text-drift.json');
    const dualTextDrift = run(['--before-capture', capturePath,
      '--after-capture', visibleChangePath, '--action-plan', baselinePath,
      '--compare-actions', '--compare-rendered-text', '--strict', '--out', dualTextPath]);
    assert.equal(dualTextDrift.status, 1, 'Combined replay must detect a private Text-only change');
    const dualTextReport = JSON.parse(readFileSync(dualTextPath, 'utf8'));
    assert.equal(dualTextReport.renderedTextParity, 'drift');
    assert.equal(dualTextReport.firstDifferentRenderedTextEventIndex, 2);
    assert.doesNotMatch(JSON.stringify(dualTextReport),
      /PRIVATE_RENDERED_TEXT_DIFFERENCE|private-visible-after|alpha|selection|surfaceId|__[A-Za-z]*Digest|[a-f0-9]{64}/,
      'Combined text drift must not disclose private rendered text or comparison keys');

    // Published v0.9 Button checks can disable activation without changing
    // visible Text or the number of rendered controls. This is a consumer-
    // visible interaction regression that structural/text parity must not hide.
    // Seed the private gate before mounting the Button so validation never
    // observes an unresolved model path during component creation.
    const gatedBefore = [JSON.parse(lines[0]), JSON.parse(lines[2]), JSON.parse(lines[1])];
    const gatedButton = gatedBefore[2].updateComponents.components.find(component =>
      component.id === 'submit');
    gatedButton.checks = [{
      condition: {path: '/gate'},
      message: 'PRIVATE_GATE_REQUIRED',
    }];
    gatedBefore[1].updateDataModel.value.gate = true;
    const gatedAfter = structuredClone(gatedBefore);
    gatedAfter[1].updateDataModel.value.gate = false;
    const gateBeforePath = join(dir, 'private-button-enabled.jsonl');
    const gateAfterPath = join(dir, 'private-button-disabled.jsonl');
    const gateMatchPath = join(dir, 'private-button-state-match.json');
    const gateDiffPath = join(dir, 'private-button-state-diff.json');
    writeFileSync(gateBeforePath, gatedBefore.map(x => JSON.stringify(x)).join('\n') + '\n');
    writeFileSync(gateAfterPath, gatedAfter.map(x => JSON.stringify(x)).join('\n') + '\n');

    const textOnlyGate = run(['--before-capture', gateBeforePath, '--after-capture',
      gateAfterPath, '--compare-rendered-text', '--strict']);
    assert.equal(textOnlyGate.status, 0,
      'Text parity alone cannot detect Button enabled-state changes');
    assert.equal(JSON.parse(textOnlyGate.stdout).renderedTextParity, 'match');

    const stateMatch = run(['--before-capture', gateBeforePath,
      '--after-capture', gateBeforePath, '--compare-button-state', '--strict',
      '--out', gateMatchPath]);
    assert.equal(stateMatch.status, 0, 'Identical Button enablement must match');
    const matchedState = JSON.parse(readFileSync(gateMatchPath, 'utf8'));
    assert.equal(matchedState.buttonStateParity, 'match');
    assert.equal(matchedState.ok, true);

    const stateDrift = run(['--before-capture', gateBeforePath,
      '--after-capture', gateAfterPath, '--compare-button-state', '--strict',
      '--out', gateDiffPath]);
    assert.equal(stateDrift.status, 1,
      'Real Chromium must detect disabled Button when text and counts match');
    const changedState = JSON.parse(readFileSync(gateDiffPath, 'utf8'));
    assert.equal(changedState.buttonStateParity, 'drift');
    assert.equal(changedState.firstDifferentButtonStateEventIndex, 2);
    assert.deepEqual(changedState.changedSummaryFields, ['buttonStateParity']);
    assert.equal(changedState.differingSteps, 0);
    assert.doesNotMatch(JSON.stringify(changedState),
      /PRIVATE_GATE_REQUIRED|private-button-disabled|private-button-enabled|gate|allowed|surfaceId|__private|[a-f0-9]{64}/,
      'Only bounded event indices and fixed enum fields may leave the process');

    // Real Tab reachability can regress even when Text, counts and structure
    // agree. Replay keyboard focus in Chromium without pressing a Button.
    const focusMatchPath = join(dir, 'private-button-focus-match.json');
    const focusDriftPath = join(dir, 'private-button-focus-drift.json');
    const focusMatch = run(['--before-capture', gateBeforePath,
      '--after-capture', gateBeforePath, '--compare-button-focus', '--strict',
      '--out', focusMatchPath]);
    assert.equal(focusMatch.status, 0,
      'Identical real Chromium Tab focus traversal must match');
    const focusSame = JSON.parse(readFileSync(focusMatchPath, 'utf8'));
    assert.equal(focusSame.buttonFocusParity, 'match');
    assert.equal(focusSame.ok, true);
    assert.equal(Object.hasOwn(focusSame, 'firstDifferentButtonFocusEventIndex'), false);

    const focusDrift = run(['--before-capture', gateBeforePath,
      '--after-capture', gateAfterPath, '--compare-button-focus', '--strict',
      '--out', focusDriftPath]);
    assert.equal(focusDrift.status, 1,
      'A disabled Button must leave actual Tab traversal even when its Text matches');
    const focusChanged = JSON.parse(readFileSync(focusDriftPath, 'utf8'));
    assert.equal(focusChanged.buttonFocusParity, 'drift');
    assert.equal(focusChanged.firstDifferentButtonFocusEventIndex, 2);
    assert.deepEqual(focusChanged.changedSummaryFields, ['buttonFocusParity']);
    assert.equal(focusChanged.differingSteps, 0);
    assert.doesNotMatch(JSON.stringify(focusChanged),
      /PRIVATE_GATE_REQUIRED|private-button-disabled|private-button-enabled|surfaceId|__private|[a-f0-9]{64}/,
      'Focus parity must not expose private input, accessible names or fingerprints');

    const invalidFocusMode = run(['--before', baselinePath,
      '--after-capture', gateAfterPath, '--compare-button-focus']);
    assert.equal(invalidFocusMode.status, 2,
      'Keyboard focus traversal compares only two private Chromium captures');
    assert.equal(invalidFocusMode.stdout, '');
    const focusWithPlan = run(['--before-capture', gateBeforePath,
      '--after-capture', gateAfterPath, '--action-plan', baselinePath,
      '--compare-button-focus']);
    assert.equal(focusWithPlan.status, 2,
      'Tab-focus probing must never activate saved-plan Button actions');
    assert.equal(focusWithPlan.stdout, '');
    assert.doesNotMatch(invalidFocusMode.stderr + focusWithPlan.stderr,
      /private-button-disabled|PRIVATE_GATE_REQUIRED|surfaceId/);

    // The published v0.9 accessibility label may change the Button's
    // screen-reader name without changing visible Text, Button count, state,
    // or action payloads. Compare actual Chromium accessibility snapshots.
    const labelBefore = lines.map(line => JSON.parse(line));
    const labeledButton = labelBefore[1].updateComponents.components.find(component =>
      component.id === 'submit');
    assert.ok(labeledButton);
    labeledButton.accessibility = {label: 'PRIVATE_ASSISTIVE_NAME_BEFORE'};
    const labelAfter = structuredClone(labelBefore);
    labelAfter[1].updateComponents.components.find(component =>
      component.id === 'submit').accessibility.label = 'PRIVATE_ASSISTIVE_NAME_AFTER';
    const labelBeforePath = join(dir, 'private-label-before.jsonl');
    const labelAfterPath = join(dir, 'private-label-after.jsonl');
    writeFileSync(labelBeforePath, labelBefore.map(x => JSON.stringify(x)).join('\n') + '\n');
    writeFileSync(labelAfterPath, labelAfter.map(x => JSON.stringify(x)).join('\n') + '\n');
    const labelTextOnly = run(['--before-capture', labelBeforePath,
      '--after-capture', labelAfterPath, '--compare-rendered-text', '--strict']);
    assert.equal(labelTextOnly.status, 0,
      'Changing accessible Button labels must not alter visible Text');
    const labelMatchPath = join(dir, 'a11y-label-match.json');
    const labelMatch = run(['--before-capture', labelBeforePath,
      '--after-capture', labelBeforePath, '--compare-button-a11y', '--strict',
      '--out', labelMatchPath]);
    assert.equal(labelMatch.status, 0, 'Identical real Chromium Button accessibility must match');
    assert.equal(JSON.parse(readFileSync(labelMatchPath, 'utf8')).buttonA11yParity, 'match');
    const labelDiffPath = join(dir, 'a11y-label-diff.json');
    const labelDiff = run(['--before-capture', labelBeforePath,
      '--after-capture', labelAfterPath, '--compare-button-a11y', '--strict',
      '--out', labelDiffPath]);
    assert.equal(labelDiff.status, 1,
      'Declared Button-label drift must be detected even if the pinned renderer ignores it');
    const labelReport = JSON.parse(readFileSync(labelDiffPath, 'utf8'));
    assert.equal(labelReport.buttonA11yParity, 'match',
      'Published React 0.14 does not reflect this explicit v0.9 Button label in the a11y tree');
    assert.equal(labelReport.declaredButtonA11yParity, 'drift');
    assert.equal(labelReport.firstDifferentDeclaredButtonA11yEventIndex, 1);
    assert.deepEqual(labelReport.changedSummaryFields, ['declaredButtonA11yParity']);
    assert.equal(labelReport.differingSteps, 0);
    assert.doesNotMatch(JSON.stringify(labelReport),
      /PRIVATE_ASSISTIVE_NAME|private-label-|__private|[a-f0-9]{64}/,
      'Comparison must never expose private a11y labels, input paths or digests');

    // Private surface IDs are capture-local, not assistive semantics. A
    // capture with another surface ID but identical Button labels must match.
    const renamedSurface = structuredClone(labelBefore);
    const privateOldId = renamedSurface[0].createSurface.surfaceId;
    for (const event of renamedSurface) {
      for (const operation of ['createSurface', 'updateComponents', 'updateDataModel']) {
        if (event[operation]?.surfaceId === privateOldId)
          event[operation].surfaceId = 'DIFFERENT_PRIVATE_SURFACE_ID';
      }
    }
    const renamedSurfacePath = join(dir, 'private-renamed-surface.jsonl');
    writeFileSync(renamedSurfacePath, renamedSurface.map(x => JSON.stringify(x)).join('\n') + '\n');
    const idOnlyMatch = run(['--before-capture', labelBeforePath,
      '--after-capture', renamedSurfacePath, '--compare-button-a11y', '--strict']);
    assert.equal(idOnlyMatch.status, 0, 'ID-only changes must not cause Button accessibility drift');
    const idOnlyReport = JSON.parse(idOnlyMatch.stdout);
    assert.equal(idOnlyReport.declaredButtonA11yParity, 'match');
    assert.equal(idOnlyReport.buttonA11yParity, 'match');
    assert.doesNotMatch(idOnlyMatch.stdout, /DIFFERENT_PRIVATE_SURFACE_ID|PRIVATE_ASSISTIVE_NAME/);

    const invalidA11yMode = run(['--before', baselinePath,
      '--after-capture', labelAfterPath, '--compare-button-a11y']);
    assert.equal(invalidA11yMode.status, 2,
      'Accessibility parity must refuse a saved report versus a private capture');
    assert.equal(invalidA11yMode.stdout, '');
    assert.doesNotMatch(invalidA11yMode.stderr,
      /private-label-after|PRIVATE_ASSISTIVE_NAME_AFTER/);

    const invalidGateMode = run(['--before', baselinePath,
      '--after-capture', gateAfterPath, '--compare-button-state']);
    assert.equal(invalidGateMode.status, 2,
      'Button-state comparison is only valid between two private captures');
    assert.equal(invalidGateMode.stdout, '');
    assert.doesNotMatch(invalidGateMode.stderr, /private-button-disabled|PRIVATE_GATE_REQUIRED/);

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
