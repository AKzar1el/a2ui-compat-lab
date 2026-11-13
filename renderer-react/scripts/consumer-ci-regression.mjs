import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compareErrorBoundaries} from '../../src/browser-capture-error-boundary-compare.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const before = resolve(repo, 'fixtures/lifecycle-v09.jsonl');
const after = resolve(repo, 'examples/consumer-ci/after.jsonl');
const geometryBefore = resolve(repo, 'examples/consumer-ci/geometry-before.jsonl');
const geometryAfter = resolve(repo, 'examples/consumer-ci/geometry-after.jsonl');
const textComparator = resolve(repo, 'src/browser-capture-summary-compare.mjs');
const errorComparator = resolve(repo, 'src/browser-capture-error-boundary-compare.mjs');

function run(script, args) {
  return spawnSync(process.execPath, [script, '--before-capture', before,
    '--after-capture', after, ...args], {
    cwd: repo, encoding: 'utf8', windowsHide: true,
    timeout: 120000, maxBuffer: 256 * 1024,
  });
}

function runGeometry(args, from = geometryBefore, to = geometryAfter) {
  return spawnSync(process.execPath, [errorComparator, '--before-capture', from,
    '--after-capture', to, ...args], {
    cwd: repo, encoding: 'utf8', windowsHide: true,
    timeout: 120000, maxBuffer: 256 * 1024,
  });
}

/** Exercise the published React/Chromium paths used by the copyable CI recipe. */
export function testConsumerCiStarter() {
  const workflow = readFileSync(resolve(repo, 'examples/consumer-ci/workflow.yml'), 'utf8');
  // The consumer uses a separate immutable checkout. Pin to the verified
  // source revision containing BOTH CLI parse and runtime diagnostic guards.
  assert.match(workflow, /ref: a26bd19ca2cbbec128f1c7a8d6071ff1eaa53ddb\b/,
    'Consumer checkout must pin the full tested geometry runtime, not its earlier comparator-only commit');
  assert.match(workflow, /--require-no-observed-failures --compare-rendered-text --compare-button-geometry --strict/,
    'Consumer CI must gate replay health AND real rendered Text drift');
  assert.doesNotMatch(workflow, /src\/browser-capture-summary-compare\.mjs/,
    'Consumer CI must not trigger a second Chromium pair');
  assert.doesNotMatch(workflow, /rendered-text\.xml/,
    'Consumer CI should emit one combined JUnit suite');
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-consumer-ci-'));
  try {
    const driftPath = join(dir, 'rendered-text.json');
    const driftRun = run(textComparator,
      ['--compare-rendered-text', '--strict', '--out', driftPath]);
    assert.equal(driftRun.error, undefined, 'Chromium demo must start');
    assert.equal(driftRun.status, 1, 'Changing rendered Text must fail strict CI');
    const drift = JSON.parse(readFileSync(driftPath, 'utf8'));
    assert.equal(drift.ok, false);
    assert.equal(drift.renderedTextParity, 'drift');
    assert.equal(drift.firstDifferentRenderedTextEventIndex, 2);

    const textJUnitPath = join(dir, 'rendered-text.xml');
    const textJUnitRun = run(textComparator,
      ['--compare-rendered-text', '--strict', '--format', 'junit', '--out', textJUnitPath]);
    assert.equal(textJUnitRun.error, undefined, 'Chromium JUnit Text check must run');
    assert.equal(textJUnitRun.status, 1,
      'Healthy but visually drifted captures must fail the consumer CI Text gate');
    const textJUnit = readFileSync(textJUnitPath, 'utf8');
    assert.match(textJUnit, /renderedTextParity/);
    assert.match(textJUnit, /<failure /);

    // A single pair of Chromium replays must detect healthy-but-changed Text.
    const combinedDir = join(dir, 'combined-health-and-text');
    const combined = run(errorComparator,
      ['--require-no-observed-failures', '--compare-rendered-text',
        '--strict', '--report-dir', combinedDir]);
    assert.equal(combined.error, undefined, 'One-pair Chromium comparator must run');
    assert.equal(combined.status, 1, 'Text drift must fail strict CI with healthy replays');
    const combinedJson = readFileSync(join(combinedDir, 'comparison.json'), 'utf8');
    const combinedResult = JSON.parse(combinedJson);
    assert.equal(combinedResult.observedFailuresAbsent, true);
    assert.equal(combinedResult.errorBoundaryParity, 'match');
    assert.equal(combinedResult.renderedTextParity, 'drift');
    assert.equal(combinedResult.firstDifferentRenderedTextEventIndex, 2);
    assert.equal(combinedResult.ok, false);
    const combinedMarkdown = readFileSync(join(combinedDir, 'comparison.md'), 'utf8');
    const combinedJUnit = readFileSync(join(combinedDir, 'comparison.xml'), 'utf8');
    assert.match(combinedMarkdown, /Real Chromium rendered Text parity:.*DRIFT/);
    assert.match(combinedJUnit, /name="rendered-text-parity"/);
    assert.match(combinedJUnit, /<failure message="rendered Text drift"/);
    // A real Row/Column layout regression moves the Button without changing
    // the number of events or causing observed Chromium replay failures.
    const layoutBlind = runGeometry(['--require-no-observed-failures', '--strict']);
    assert.equal(layoutBlind.status, 0,
      'Replay health alone must not claim actual Button geometry parity');
    const geoMatch = runGeometry(['--require-no-observed-failures',
      '--compare-button-geometry', '--strict'], geometryBefore, geometryBefore);
    assert.equal(geoMatch.status, 0, 'Identical Button layout must match');
    assert.equal(JSON.parse(geoMatch.stdout).buttonGeometryParity, 'match');

    const geometryDir = join(dir, 'one-pair-geometry');
    const geometry = runGeometry(['--require-no-observed-failures',
      '--compare-button-geometry', '--strict', '--report-dir', geometryDir]);
    assert.equal(geometry.error, undefined);
    assert.equal(geometry.status, 1,
      'Real Chromium Button relocation must fail strict consumer CI');
    const geometryJson = readFileSync(join(geometryDir, 'comparison.json'), 'utf8');
    const geometryReport = JSON.parse(geometryJson);
    assert.equal(geometryReport.observedFailuresAbsent, true);
    assert.equal(geometryReport.buttonGeometryParity, 'drift');
    assert.equal(geometryReport.firstDifferentButtonGeometryEventIndex, 1);
    assert.equal(geometryReport.errorBoundaryParity, 'match');
    assert.equal(geometryReport.ok, false);
    const geometryMarkdown = readFileSync(join(geometryDir, 'comparison.md'), 'utf8');
    const geometryJUnit = readFileSync(join(geometryDir, 'comparison.xml'), 'utf8');
    assert.match(geometryMarkdown, /Button geometry parity:.*DRIFT/);
    assert.match(geometryJUnit, /name="button-geometry-parity"/);
    assert.match(geometryJUnit, /<failure message="Button geometry drift"/);

    const allChecks = runGeometry(['--require-no-observed-failures',
      '--compare-rendered-text', '--compare-button-geometry', '--strict']);
    assert.equal(allChecks.status, 1, 'Combined real-Chromium comparison must detect layout drift');
    const allReport = JSON.parse(allChecks.stdout);
    assert.equal(allReport.buttonGeometryParity, 'drift');
    assert.ok(['match', 'drift'].includes(allReport.renderedTextParity));
    const deniedGeometry = runGeometry(['--compare-button-geometry', '--strict']);
    assert.equal(deniedGeometry.status, 2,
      'Button geometry sampling requires strict observed-health policy');
    const failedGeometry = compareErrorBoundaries(
      {events: 3, index: 1, digests: null, geometryDigests: null},
      {events: 3, index: 1, digests: null, geometryDigests: null},
      {requireNoObservedFailures: true, compareButtonGeometry: true});
    assert.equal(failedGeometry.buttonGeometryParity, 'unavailable');
    assert.equal(failedGeometry.ok, false,
      'Matching failing replays cannot claim geometry parity');

    for (const output of [geometryJson, geometryMarkdown, geometryJUnit,
      allChecks.stdout]) {
      assert.doesNotMatch(output,
        /PUBLIC_STABLE_GEOMETRY_DEMO|geometry-before\.jsonl|geometry-after\.jsonl|__private|[a-f0-9]{64}/);
    }

    const deniedUngated = run(errorComparator, ['--compare-rendered-text', '--strict']);
    assert.equal(deniedUngated.status, 2,
      'Rendered Text mode requires explicit no-observed-failures policy');
    const failed = compareErrorBoundaries(
      {events: 3, index: 1, digests: null}, {events: 3, index: 1, digests: null},
      {requireNoObservedFailures: true, compareRenderedText: true});
    assert.equal(failed.renderedTextParity, 'unavailable');
    assert.equal(failed.ok, false, 'Matching failures must not be reported healthy');

    const reports = join(dir, 'review-bundle');
    const reportRun = run(errorComparator,
      ['--require-no-observed-failures', '--strict', '--report-dir', reports]);
    assert.equal(reportRun.error, undefined, 'Chromium CI artifacts must run');
    assert.equal(reportRun.status, 0, 'Two healthy captures must pass error policy');
    const json = readFileSync(join(reports, 'comparison.json'), 'utf8');
    const markdown = readFileSync(join(reports, 'comparison.md'), 'utf8');
    const junit = readFileSync(join(reports, 'comparison.xml'), 'utf8');
    const result = JSON.parse(json);
    assert.equal(result.ok, true);
    assert.equal(result.requireNoObservedFailures, true);
    assert.equal(result.observedFailuresAbsent, true);
    assert.match(markdown, /MATCH/);
    assert.match(junit, /<testsuite .*failures="0"/);
    for (const text of [JSON.stringify(drift), textJUnit, combinedJson,
      combinedMarkdown, combinedJUnit, json, markdown, junit]) {
      assert.doesNotMatch(text, /Changed for Chromium demo|"Hello"|"First"/);
      assert.doesNotMatch(text, /lifecycle-v09\.jsonl|after\.jsonl/);
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}
