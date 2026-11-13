import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const before = resolve(repo, 'fixtures/lifecycle-v09.jsonl');
const after = resolve(repo, 'examples/consumer-ci/after.jsonl');
const textComparator = resolve(repo, 'src/browser-capture-summary-compare.mjs');
const errorComparator = resolve(repo, 'src/browser-capture-error-boundary-compare.mjs');

function run(script, args) {
  return spawnSync(process.execPath, [script, '--before-capture', before,
    '--after-capture', after, ...args], {
    cwd: repo, encoding: 'utf8', windowsHide: true,
    timeout: 120000, maxBuffer: 256 * 1024,
  });
}

/** Exercise the published React/Chromium paths used by the copyable CI recipe. */
export function testConsumerCiStarter() {
  const workflow = readFileSync(resolve(repo, 'examples/consumer-ci/workflow.yml'), 'utf8');
  assert.match(workflow, /--compare-rendered-text --strict --format junit/,
    'Consumer CI must gate real rendered Text drift, not only replay errors');
  assert.match(workflow, /a2ui-comparison\/rendered-text\.xml/,
    'Consumer CI must save its privacy-limited rendered Text JUnit report');
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
    for (const text of [JSON.stringify(drift), textJUnit, json, markdown, junit]) {
      assert.doesNotMatch(text, /Changed for Chromium demo|"Hello"|"First"/);
      assert.doesNotMatch(text, /lifecycle-v09\.jsonl|after\.jsonl/);
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}
