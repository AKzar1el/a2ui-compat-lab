import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {
  browserCaptureReplayArguments,
  compareBrowserCaptureSummaries,
  parseBrowserCaptureSummaryCompareOptions,
} from '../src/browser-capture-summary-compare.mjs';

const script = fileURLToPath(new URL('../src/browser-capture-summary-compare.mjs', import.meta.url));
const report = () => ({
  schemaVersion: 1,
  kind: 'a2ui-react-capture-browser-replay',
  protocol: 'v0.9',
  renderer: '@a2ui/react@0.14.0 + @a2ui/web_core@0.14.0',
  events: 2,
  steps: [
    {index: 0, operation: 'createSurface', surfaceCount: 1, visibleButtonCount: 0, actionCount: 0},
    {index: 1, operation: 'updateComponents', surfaceCount: 1, visibleButtonCount: 1, actionCount: 0},
  ],
  clickSingleButton: true,
  pressSingleButtonEnter: false,
  clickButtonIndex: null,
  pressButtonIndexEnter: null,
  actionAfterEventIndex: null,
  actionSteps: [],
  actionsVerified: 1,
  keyboardFocusVerified: false,
  actionsEmitted: 1,
  note: 'Real local Chromium renderer; counts/operation order only, not anonymity or SDK parity',
});

test('direct two-private-capture CLI mode requires both captures and stays mutually exclusive', () => {
  const parsed = parseBrowserCaptureSummaryCompareOptions([
    '--before-capture', 'old.jsonl', '--after-capture', 'new.jsonl', '--strict',
    '--format', 'junit',
  ]);
  assert.ok(parsed['before-capture'].endsWith('old.jsonl'));
  assert.ok(parsed['after-capture'].endsWith('new.jsonl'));
  assert.equal(parsed.strict, true);
  assert.equal(parsed.format, 'junit');
  assert.throws(() => parseBrowserCaptureSummaryCompareOptions([
    '--before-capture', 'old.jsonl', '--after', 'saved.json',
  ]), /Usage:/);
  assert.throws(() => parseBrowserCaptureSummaryCompareOptions([
    '--before-capture', 'old.jsonl', '--before', 'baseline.json',
    '--after-capture', 'new.jsonl',
  ]), /Usage:/);
  assert.throws(() => parseBrowserCaptureSummaryCompareOptions([
    '--after-capture', 'new.jsonl',
  ]), /Usage:/);
});

test('paired private captures accept only an explicit vetted action-plan file', () => {
  const options = parseBrowserCaptureSummaryCompareOptions([
    '--before-capture', 'private-before.jsonl', '--after-capture', 'private-after.jsonl',
    '--action-plan', 'vetted-browser-baseline.json', '--strict',
  ]);
  assert.ok(options['action-plan'].endsWith('vetted-browser-baseline.json'));
  assert.equal(options.strict, true);
  for (const args of [
    ['--before', 'baseline.json', '--after-capture', 'private.jsonl',
      '--action-plan', 'vetted.json'],
    ['--before-capture', 'private.jsonl', '--after', 'report.json',
      '--action-plan', 'vetted.json'],
    ['--before-capture', 'a.jsonl', '--after-capture', 'b.jsonl',
      '--action-plan', 'vetted.json', '--action-plan', 'other.json'],
  ]) {
    assert.throws(() => parseBrowserCaptureSummaryCompareOptions(args), /Usage:/);
  }
});

test('opt-in private action parity requires two captures and a vetted action plan', () => {
  const options = parseBrowserCaptureSummaryCompareOptions([
    '--before-capture', 'private-old.jsonl', '--after-capture', 'private-new.jsonl',
    '--action-plan', 'reviewed-browser-report.json', '--compare-actions', '--strict',
  ]);
  assert.equal(options.compareActions, true);
  for (const argumentsToReject of [
    ['--before-capture', 'a.jsonl', '--after-capture', 'b.jsonl', '--compare-actions'],
    ['--before', 'saved.json', '--after-capture', 'b.jsonl',
      '--action-plan', 'reviewed.json', '--compare-actions'],
    ['--before-capture', 'a.jsonl', '--after-capture', 'b.jsonl',
      '--action-plan', 'reviewed.json', '--compare-actions', '--compare-actions'],
  ]) {
    assert.throws(() => parseBrowserCaptureSummaryCompareOptions(argumentsToReject), /Usage:/);
  }
});

test('real-Chromium report schema matches without copying private values', () => {
  const comparison = compareBrowserCaptureSummaries(report(), structuredClone(report()));
  assert.equal(comparison.ok, true);
  assert.equal(comparison.differingSteps, 0);
  assert.deepEqual(comparison.changedSummaryFields, []);
  assert.doesNotMatch(JSON.stringify(comparison), /surfaceId|componentId|selection|alpha/);
});

test('saved scripted action plans compare values rather than JSON object key order', () => {
  const before = report();
  before.clickSingleButton = false;
  before.actionSteps = [
    {eventIndex: 1, buttonIndex: 0, mode: 'click'},
    {eventIndex: 1, buttonIndex: 1, mode: 'enter'},
  ];
  before.actionsVerified = 2;
  before.actionsEmitted = 2;

  const after = structuredClone(before);
  after.actionSteps = [
    {mode: 'click', buttonIndex: 0, eventIndex: 1},
    {buttonIndex: 1, mode: 'enter', eventIndex: 1},
  ];
  const equivalent = compareBrowserCaptureSummaries(before, after);
  assert.equal(equivalent.ok, true,
    'JSON member insertion order is not a change in vetted action plan semantics');
  assert.deepEqual(equivalent.changedSummaryFields, []);

  const reordered = structuredClone(after);
  reordered.actionSteps.reverse();
  assert.ok(compareBrowserCaptureSummaries(before, reordered)
    .changedSummaryFields.includes('actionSteps'), 'Action sequence must remain ordered');

  const changed = structuredClone(after);
  changed.actionSteps[1].mode = 'space';
  assert.ok(compareBrowserCaptureSummaries(before, changed)
    .changedSummaryFields.includes('actionSteps'), 'Action mode changes are genuine drift');
});

test('detects UI/button regression and playback mode drift by fixed field names', () => {
  const before = report();
  const after = report();
  after.steps[1].visibleButtonCount = 2;
  after.clickSingleButton = false;
  after.pressSingleButtonEnter = true;
  after.keyboardFocusVerified = true;
  const comparison = compareBrowserCaptureSummaries(before, after);
  assert.equal(comparison.ok, false);
  assert.deepEqual(comparison.changedSteps, [{index: 1, fields: ['visibleButtonCount']}]);
  assert.ok(comparison.changedSummaryFields.includes('pressSingleButtonEnter'));
  assert.ok(comparison.changedSummaryFields.includes('keyboardFocusVerified'));
});

test('checks event deletion and sampled placeholder visibility separately', () => {
  const before = report();
  before.steps.forEach(step => { step.loadingPlaceholderCount = 0; });
  before.steps[0].loadingPlaceholderCount = 1;
  before.loadingPlaceholderEvents = 1;
  const after = structuredClone(before);
  after.steps[0].loadingPlaceholderCount = 0;
  after.loadingPlaceholderEvents = 0;
  let comparison = compareBrowserCaptureSummaries(before, after);
  assert.equal(comparison.ok, false);
  assert.deepEqual(comparison.changedSteps, [{index: 0, fields: ['loadingPlaceholderCount']}]);
  assert.ok(comparison.changedSummaryFields.includes('loadingPlaceholderEvents'));
  after.steps.pop();
  after.events = 1;
  comparison = compareBrowserCaptureSummaries(before, after);
  assert.equal(comparison.differingSteps, 2);
  assert.deepEqual(comparison.changedSteps.at(-1), {index: 1, fields: ['presence']});
});

test('rejects unexpected producer fields, malformed plans and inconsistent counts', () => {
  const injected = report();
  injected.privateModelValue = 'TOP_SECRET_CAPTURE_VALUE';
  assert.throws(() => compareBrowserCaptureSummaries(injected, report()),
    error => /Invalid browser capture summary/.test(error.message) &&
      !error.message.includes('TOP_SECRET_CAPTURE_VALUE'));
  const invalidCount = report();
  invalidCount.steps[1].actionCount = -1;
  assert.throws(() => compareBrowserCaptureSummaries(report(), invalidCount),
    /Invalid browser capture summary/);
  const malformed = report();
  malformed.actionSteps = [{eventIndex: 1, buttonIndex: 0, mode: 'click'}];
  assert.throws(() => compareBrowserCaptureSummaries(report(), malformed),
    /Invalid browser capture summary/);
  const invalidLoading = report();
  invalidLoading.loadingPlaceholderEvents = 1;
  assert.throws(() => compareBrowserCaptureSummaries(report(), invalidLoading),
    /Invalid browser capture summary/);
  assert.throws(() => parseBrowserCaptureSummaryCompareOptions(
    ['--before', 'a.json', '--after', 'b.json', '--strict', '--strict']), /Usage:/);
});

test('CLI strict exit codes, exclusive evidence and private-input redaction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-browser-diff-'));
  try {
    const before = join(dir, 'private-before.json');
    const after = join(dir, 'private-after.json');
    const out = join(dir, 'new-diff.json');
    writeFileSync(before, JSON.stringify(report()));
    writeFileSync(after, JSON.stringify(report()));
    let run = spawnSync(process.execPath, [script, '--before', before, '--after', after,
      '--strict', '--out', out], {encoding: 'utf8'});
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).ok, true);
    run = spawnSync(process.execPath, [script, '--before', before, '--after', after,
      '--out', out], {encoding: 'utf8'});
    assert.equal(run.status, 2, 'Evidence output must never be overwritten');
    const changed = report();
    changed.steps[1].visibleButtonCount = 3;
    writeFileSync(after, JSON.stringify(changed));
    run = spawnSync(process.execPath, [script, '--before', before, '--after', after,
      '--strict'], {encoding: 'utf8'});
    assert.equal(run.status, 1);
    assert.equal(JSON.parse(run.stdout).ok, false);
    writeFileSync(after, '{"secret":"TOP_SECRET_CAPTURE_VALUE"}');
    run = spawnSync(process.execPath, [script, '--before', before, '--after', after],
      {encoding: 'utf8'});
    assert.equal(run.status, 2);
    assert.doesNotMatch(run.stderr, /TOP_SECRET_CAPTURE_VALUE|private-before/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('opt-in Markdown CI summary shows fixed structural fields, preserves strict exit and privacy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-browser-markdown-'));
  try {
    const before = join(dir, 'PRIVATE_BEFORE_PATH.json');
    const after = join(dir, 'PRIVATE_AFTER_PATH.json');
    const out = join(dir, 'summary.md');
    writeFileSync(before, JSON.stringify(report()));
    writeFileSync(after, JSON.stringify(report()));
    let run = spawnSync(process.execPath, [script, '--before', before, '--after', after,
      '--strict', '--format', 'markdown'], {encoding: 'utf8'});
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /\*\*Result:\*\* MATCH/);
    assert.match(run.stdout, /\*\*Changed event steps:\*\* 0/);
    const changed = report();
    changed.steps[1].visibleButtonCount = 3;
    writeFileSync(after, JSON.stringify(changed));
    run = spawnSync(process.execPath, [script, '--before', before, '--after', after,
      '--strict', '--format', 'markdown', '--out', out], {encoding: 'utf8'});
    assert.equal(run.status, 1);
    const markdown = readFileSync(out, 'utf8');
    assert.match(markdown, /\*\*Result:\*\* DRIFT/);
    assert.ok(markdown.includes('| 1 | `visibleButtonCount`: 1 -> 3 |'));
    assert.doesNotMatch(markdown, /undefined|\[object Object\]/);
    assert.doesNotMatch(markdown, /PRIVATE_BEFORE_PATH|PRIVATE_AFTER_PATH|selection|alpha|TOP_SECRET_CAPTURE_VALUE/);
    run = spawnSync(process.execPath, [script, '--before', before, '--after', after,
      '--format', 'markdown', '--out', out], {encoding: 'utf8'});
    assert.equal(run.status, 2, 'Markdown report must never overwrite existing evidence');
    const operationDrift = report();
    operationDrift.steps[1].operation = 'updateDataModel';
    writeFileSync(after, JSON.stringify(operationDrift));
    run = spawnSync(process.execPath, [script, '--before', before, '--after', after,
      '--strict', '--format', 'markdown'], {encoding: 'utf8'});
    assert.equal(run.status, 1);
    assert.ok(run.stdout.includes('| 1 | `operation`: updateComponents -> updateDataModel |'));
    const missingEvent = report();
    missingEvent.events = 1;
    missingEvent.steps.pop();
    writeFileSync(after, JSON.stringify(missingEvent));
    run = spawnSync(process.execPath, [script, '--before', before, '--after', after,
      '--strict', '--format', 'markdown'], {encoding: 'utf8'});
    assert.equal(run.status, 1);
    assert.ok(run.stdout.includes('| 1 | `presence`: present -> absent |'));
    const injected = report();
    injected.steps[1].operation = 'PRIVATE_UNTRUSTED_MODEL_VALUE';
    writeFileSync(after, JSON.stringify(injected));
    run = spawnSync(process.execPath, [script, '--before', before, '--after', after,
      '--format', 'markdown'], {encoding: 'utf8'});
    assert.equal(run.status, 2);
    assert.doesNotMatch(run.stdout + run.stderr, /PRIVATE_UNTRUSTED_MODEL_VALUE|PRIVATE_BEFORE_PATH|PRIVATE_AFTER_PATH/);
    for (const argv of [
      ['--before', before, '--after', after, '--format', 'html'],
      ['--before', before, '--after', after, '--format', 'markdown', '--format', 'json'],
    ]) assert.throws(() => parseBrowserCaptureSummaryCompareOptions(argv), /Usage:/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('opt-in JUnit XML exposes fixed structural failures for CI without private data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-browser-junit-'));
  try {
    const before = join(dir, 'PRIVATE_BEFORE_CAPTURE.json');
    const after = join(dir, 'PRIVATE_AFTER_CAPTURE.json');
    const out = join(dir, 'report.xml');
    writeFileSync(before, JSON.stringify(report()));
    writeFileSync(after, JSON.stringify(report()));
    let run = spawnSync(process.execPath, [script, '--before', before, '--after', after,
      '--strict', '--format', 'junit'], {encoding: 'utf8'});
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(run.stdout, /tests="1" failures="0" errors="0"/);
    assert.doesNotMatch(run.stdout, /<failure /);

    const changed = report();
    changed.steps[1].visibleButtonCount = 3;
    changed.clickSingleButton = false;
    changed.pressSingleButtonEnter = true;
    changed.keyboardFocusVerified = true;
    writeFileSync(after, JSON.stringify(changed));
    run = spawnSync(process.execPath, [script, '--before', before, '--after', after,
      '--strict', '--format', 'junit', '--out', out], {encoding: 'utf8'});
    assert.equal(run.status, 1, run.stderr);
    const xml = readFileSync(out, 'utf8');
    assert.match(xml, /tests="2" failures="2" errors="0"/);
    assert.match(xml, /name="summary">[\s\S]*<failure message="structural summary drift">/);
    assert.match(xml, /name="event-1">[\s\S]*visibleButtonCount: 1 -&gt; 3/);
    assert.match(xml, /pressSingleButtonEnter/);
    assert.doesNotMatch(xml, /PRIVATE_BEFORE_CAPTURE|PRIVATE_AFTER_CAPTURE|selection|alpha|undefined/);
    run = spawnSync(process.execPath, [script, '--before', before, '--after', after,
      '--format', 'junit', '--out', out], {encoding: 'utf8'});
    assert.equal(run.status, 2, 'JUnit evidence must not be overwritten');

    const deleted = report();
    deleted.events = 1;
    deleted.steps.pop();
    writeFileSync(after, JSON.stringify(deleted));
    run = spawnSync(process.execPath, [script, '--before', before, '--after', after,
      '--strict', '--format', 'junit'], {encoding: 'utf8'});
    assert.equal(run.status, 1);
    assert.match(run.stdout, /name="event-1">[\s\S]*presence: present -&gt; absent/);

    const injected = report();
    injected.steps[1].operation = 'PRIVATE_UNTRUSTED_VALUE';
    writeFileSync(after, JSON.stringify(injected));
    run = spawnSync(process.execPath, [script, '--before', before, '--after', after,
      '--format', 'junit'], {encoding: 'utf8'});
    assert.equal(run.status, 2);
    assert.doesNotMatch(run.stdout + run.stderr,
      /PRIVATE_UNTRUSTED_VALUE|PRIVATE_BEFORE_CAPTURE|PRIVATE_AFTER_CAPTURE/);
    assert.throws(() => parseBrowserCaptureSummaryCompareOptions(
      ['--before', before, '--after', after, '--format', 'junit', '--format', 'json']), /Usage:/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('private-capture comparison is an exclusive input mode and inherits browser action plans', () => {
  const options = parseBrowserCaptureSummaryCompareOptions(
    ['--before', 'baseline.json', '--after-capture', 'private.jsonl', '--strict']);
  assert.equal(options.strict, true);
  assert.ok(options['after-capture'].endsWith('private.jsonl'));
  for (const argv of [
    ['--before', 'baseline.json', '--after', 'report.json', '--after-capture', 'private.jsonl'],
    ['--before', 'baseline.json'],
    ['--before', 'baseline.json', '--after-capture', 'private.jsonl', '--after-capture', 'other.jsonl'],
  ]) assert.throws(() => parseBrowserCaptureSummaryCompareOptions(argv), /Usage:/);

  const pointer = report();
  assert.deepEqual(browserCaptureReplayArguments(pointer), ['--click-single-button']);
  const timed = report();
  timed.clickSingleButton = false;
  timed.clickButtonIndex = 0;
  timed.actionAfterEventIndex = 1;
  assert.deepEqual(browserCaptureReplayArguments(timed),
    ['--click-button-index', '0', '--action-after-event-index', '1']);
  const scripted = report();
  scripted.clickSingleButton = false;
  scripted.actionSteps = [{eventIndex: 1, buttonIndex: 0, mode: 'enter'}];
  scripted.steps[1].actionCount = 0;
  scripted.keyboardFocusVerified = true;
  assert.deepEqual(browserCaptureReplayArguments(scripted),
    ['--action-step', '1:0:enter']);
  const repeated = structuredClone(scripted);
  repeated.actionSteps = [
    {eventIndex: 1, buttonIndex: 0, mode: 'click'},
    {eventIndex: 1, buttonIndex: 0, mode: 'enter'},
  ];
  repeated.actionsVerified = 2;
  repeated.actionsEmitted = 2;
  assert.deepEqual(browserCaptureReplayArguments(repeated),
    ['--action-step', '1:0:click', '--action-step', '1:0:enter']);
  assert.equal(compareBrowserCaptureSummaries(repeated, structuredClone(repeated)).ok, true);
  const space = structuredClone(scripted);
  space.actionSteps = [{eventIndex: 1, buttonIndex: 0, mode: 'space'}];
  assert.deepEqual(browserCaptureReplayArguments(space), ['--action-step', '1:0:space']);
  assert.equal(compareBrowserCaptureSummaries(space, structuredClone(space)).ok, true);
  const unknownKey = structuredClone(space);
  unknownKey.actionSteps[0].mode = 'PRIVATE_CAPTURE_VALUE';
  assert.throws(() => browserCaptureReplayArguments(unknownKey),
    error => /Invalid browser capture summary/.test(error.message) &&
      !error.message.includes('PRIVATE_CAPTURE_VALUE'));
  const descending = structuredClone(repeated);
  descending.actionSteps[1].eventIndex = 0;
  assert.throws(() => browserCaptureReplayArguments(descending),
    /Invalid browser capture summary/);
  const withLoading = report();
  withLoading.steps.forEach(step => { step.loadingPlaceholderCount = 0; });
  withLoading.loadingPlaceholderEvents = 0;
  assert.deepEqual(browserCaptureReplayArguments(withLoading),
    ['--click-single-button', '--inspect-loading-placeholders']);
  withLoading.steps[1].loadingPlaceholderCount = 1;
  withLoading.loadingPlaceholderEvents = 0;
  assert.throws(() => browserCaptureReplayArguments(withLoading),
    /Invalid browser capture summary/);
  const secret = report();
  secret.privateValue = 'NEVER_PRINT_CAPTURE_VALUE';
  assert.throws(() => browserCaptureReplayArguments(secret),
    error => !error.message.includes('NEVER_PRINT_CAPTURE_VALUE'));
});
