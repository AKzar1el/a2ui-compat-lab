#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {lstatSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const USAGE = 'Usage: node src/browser-capture-summary-compare.mjs --before OLD.json (--after NEW.json | --after-capture PRIVATE.jsonl) [--strict] [--format json|markdown] [--out NEW-DIFF.json|summary.md]';
const MAX_BYTES = 256 * 1024;
const RENDERER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'renderer-react');
const RENDERER_SCRIPT = resolve(RENDERER_DIR, 'scripts/browser-capture-replay.mjs');
const MAX_EVENTS = 100;
const MAX_COUNT = 10000;
const REPORT_KIND = 'a2ui-react-capture-browser-replay';
const RENDERER = '@a2ui/react@0.14.0 + @a2ui/web_core@0.14.0';
const NOTE = 'Real local Chromium renderer; counts/operation order only, not anonymity or SDK parity';
const OPERATIONS = new Set(['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface']);
const TOP_FIELDS = new Set(['schemaVersion', 'kind', 'protocol', 'renderer', 'events', 'steps',
  'loadingPlaceholderEvents', 'clickSingleButton', 'pressSingleButtonEnter', 'clickButtonIndex',
  'pressButtonIndexEnter', 'actionAfterEventIndex', 'actionSteps', 'actionsVerified',
  'keyboardFocusVerified', 'actionsEmitted', 'note']);
const STEP_FIELDS = ['operation', 'surfaceCount', 'visibleButtonCount', 'actionCount',
  'loadingPlaceholderCount'];
const SUMMARY_FIELDS = ['events', 'loadingPlaceholderEvents', 'clickSingleButton',
  'pressSingleButtonEnter', 'clickButtonIndex', 'pressButtonIndexEnter',
  'actionAfterEventIndex', 'actionSteps', 'actionsVerified', 'keyboardFocusVerified',
  'actionsEmitted'];

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const invalid = () => new Error('Invalid browser capture summary; input content omitted');

function validate(report) {
  if (!isRecord(report) || Object.keys(report).some(key => !TOP_FIELDS.has(key)) ||
      report.schemaVersion !== 1 || report.kind !== REPORT_KIND ||
      report.protocol !== 'v0.9' || report.renderer !== RENDERER || report.note !== NOTE ||
      !bounded(report.events, MAX_EVENTS) || report.events < 1 ||
      !Array.isArray(report.steps) || report.steps.length !== report.events ||
      typeof report.clickSingleButton !== 'boolean' ||
      typeof report.pressSingleButtonEnter !== 'boolean' ||
      typeof report.keyboardFocusVerified !== 'boolean' ||
      !bounded(report.actionsVerified, 8) || !bounded(report.actionsEmitted, MAX_COUNT))
    throw invalid();

  const hasLoading = Object.hasOwn(report, 'loadingPlaceholderEvents');
  if (hasLoading && !bounded(report.loadingPlaceholderEvents, MAX_EVENTS))
    throw invalid();
  let loadingEvents = 0;
  let previousActions = 0;
  for (let i = 0; i < report.steps.length; i++) {
    const step = report.steps[i];
    if (!isRecord(step) || Object.keys(step).some(key =>
          !['index', ...STEP_FIELDS].includes(key)) ||
        Object.hasOwn(step, 'loadingPlaceholderCount') !== hasLoading ||
        step.index !== i || !OPERATIONS.has(step.operation) ||
        !bounded(step.surfaceCount, MAX_COUNT) ||
        !bounded(step.visibleButtonCount, MAX_COUNT) ||
        !bounded(step.actionCount, MAX_COUNT) || step.actionCount < previousActions ||
        (hasLoading && !bounded(step.loadingPlaceholderCount, MAX_COUNT)))
      throw invalid();
    previousActions = step.actionCount;
    if (hasLoading && step.loadingPlaceholderCount > 0) loadingEvents++;
  }
  if ((hasLoading && report.loadingPlaceholderEvents !== loadingEvents) ||
      report.actionsEmitted < previousActions || report.actionsVerified > report.actionsEmitted)
    throw invalid();

  for (const key of ['clickButtonIndex', 'pressButtonIndexEnter']) {
    if (report[key] !== null && !bounded(report[key], 31)) throw invalid();
  }
  const modes = Number(report.clickSingleButton) + Number(report.pressSingleButtonEnter) +
    Number(report.clickButtonIndex !== null) + Number(report.pressButtonIndexEnter !== null);
  if (modes > 1 || !Array.isArray(report.actionSteps) || report.actionSteps.length > 8)
    throw invalid();
  if (report.actionAfterEventIndex !== null &&
      (!bounded(report.actionAfterEventIndex, report.events - 1) || modes !== 1))
    throw invalid();
  if (report.actionSteps.length && (modes !== 0 || report.actionAfterEventIndex !== null))
    throw invalid();
  for (let i = 0; i < report.actionSteps.length; i++) {
    const step = report.actionSteps[i];
    if (!isRecord(step) || Object.keys(step).sort().join(',') !== 'buttonIndex,eventIndex,mode' ||
        !bounded(step.eventIndex, report.events - 1) || !bounded(step.buttonIndex, 31) ||
        !['click', 'enter'].includes(step.mode) ||
        (i > 0 && step.eventIndex < report.actionSteps[i - 1].eventIndex))
      throw invalid();
  }
  if (report.actionsVerified !== (report.actionSteps.length || Number(modes === 1)))
    throw invalid();
  return report;
}

/** Reconstruct only an allowlisted browser action plan from a validated baseline. */
export function browserCaptureReplayArguments(before) {
  const report = validate(before);
  const args = [];
  if (report.clickSingleButton) args.push('--click-single-button');
  else if (report.pressSingleButtonEnter) args.push('--press-single-button-enter');
  else if (report.clickButtonIndex !== null)
    args.push('--click-button-index', String(report.clickButtonIndex));
  else if (report.pressButtonIndexEnter !== null)
    args.push('--press-button-index-enter', String(report.pressButtonIndexEnter));
  if (report.actionAfterEventIndex !== null)
    args.push('--action-after-event-index', String(report.actionAfterEventIndex));
  for (const step of report.actionSteps)
    args.push('--action-step', step.eventIndex + ':' + step.buttonIndex + ':' + step.mode);
  if (Object.hasOwn(report, 'loadingPlaceholderEvents'))
    args.push('--inspect-loading-placeholders');
  return args;
}

/** Compare only fixed, validated structural fields from real browser replay reports. */
export function compareBrowserCaptureSummaries(before, after) {
  const a = validate(before);
  const b = validate(after);
  const changedSummaryFields = SUMMARY_FIELDS.filter(field => !same(a[field], b[field]));
  const changedSteps = [];
  for (let index = 0; index < Math.max(a.steps.length, b.steps.length); index++) {
    const left = a.steps[index];
    const right = b.steps[index];
    const fields = !left || !right ? ['presence'] :
      STEP_FIELDS.filter(field => !same(left[field], right[field]));
    if (fields.length) changedSteps.push({index, fields});
  }
  return {
    schemaVersion: 1,
    kind: 'a2ui-react-browser-capture-structural-diff',
    protocol: 'v0.9',
    ok: changedSummaryFields.length === 0 && changedSteps.length === 0,
    beforeEvents: a.events,
    afterEvents: b.events,
    changedSummaryFields,
    differingSteps: changedSteps.length,
    changedSteps,
    note: 'Structural real-browser replay differences only; values/IDs are not compared or anonymized',
  };
}

/** Render only comparator-owned, fixed-schema fields for human CI review. */
function markdownComparisonReport(diff, before, after) {
  // Reports are strictly validated before any field is rendered into Markdown.
  const a = validate(before);
  const b = validate(after);
  const fields = values => values.length ? values.map(value => '`' + value + '`').join(', ') : 'none';
  const fixedValue = (step, field) => {
    if (field === 'presence') return step ? 'present' : 'absent';
    if (!step) return 'absent';
    return Object.hasOwn(step, field) ? String(step[field]) : 'not sampled';
  };
  const rows = diff.changedSteps.map(step => {
    const left = a.steps[step.index];
    const right = b.steps[step.index];
    const deltas = step.fields.map(field =>
      '`' + field + '`: ' + fixedValue(left, field) + ' -> ' + fixedValue(right, field));
    return '| ' + step.index + ' | ' + deltas.join('; ') + ' |';
  });
  return [
    '## A2UI React/Chromium capture structural comparison',
    '',
    '**Result:** ' + (diff.ok ? 'MATCH' : 'DRIFT'),
    '**Protocol:** ' + diff.protocol,
    '**Events:** ' + diff.beforeEvents + ' before / ' + diff.afterEvents + ' after',
    '**Changed summary fields:** ' + fields(diff.changedSummaryFields),
    '**Changed event steps:** ' + diff.differingSteps,
    '',
    '| Event index | Structural changes (before -> after) |',
    '| ---: | --- |',
    ...rows,
    '',
    '_Only fixed structural counts and field names are shown. Event patterns may be sensitive; this is not anonymization._',
    '',
  ].join('\n');
}

export function parseBrowserCaptureSummaryCompareOptions(argv) {
  if (argv.length === 1 && argv[0] === '--help') return {help: true};
  const options = {strict: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--strict' && !options.strict) options.strict = true;
    else if (arg === '--format' && !Object.hasOwn(options, 'format') &&
      ['json', 'markdown'].includes(argv[i + 1])) options.format = argv[++i];
    else if (['--before', '--after', '--after-capture', '--out'].includes(arg) &&
      !Object.hasOwn(options, arg.slice(2)) && argv[i + 1] &&
      !argv[i + 1].startsWith('--')) options[arg.slice(2)] = resolve(argv[++i]);
    else throw new Error(USAGE);
  }
  if (!options.before || Number(Boolean(options.after)) + Number(Boolean(options['after-capture'])) !== 1)
    throw new Error(USAGE);
  return options;
}

function readReport(path) {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size < 1 || info.size > MAX_BYTES) throw invalid();
    const bytes = readFileSync(path);
    const json = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    return JSON.parse(json);
  } catch {
    throw invalid();
  }
}

function replayPrivateCapture(inputPath, baseline) {
  const args = browserCaptureReplayArguments(baseline);
  let child;
  try {
    child = spawnSync(process.execPath, [RENDERER_SCRIPT, '--input', inputPath, ...args], {
      cwd: RENDERER_DIR, shell: false, windowsHide: true,
      encoding: 'utf8', maxBuffer: MAX_BYTES, timeout: 120000,
    });
  } catch {
    throw invalid();
  }
  // Never relay child stderr, private paths or captured A2UI values on failure.
  if (child.error || child.status !== 0 || !child.stdout ||
      Buffer.byteLength(child.stdout, 'utf8') > MAX_BYTES)
    throw invalid();
  try {
    return validate(JSON.parse(child.stdout));
  } catch {
    throw invalid();
  }
}

function saveReport(path, json) {
  try {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, json, {flag: 'wx'});
  } catch {
    throw new Error('Cannot write browser comparison report; path omitted or already exists');
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = parseBrowserCaptureSummaryCompareOptions(process.argv.slice(2));
    if (args.help) console.log(USAGE);
    else {
      const baseline = readReport(args.before);
      const observed = args['after-capture']
        ? replayPrivateCapture(args['after-capture'], baseline) : readReport(args.after);
      const result = compareBrowserCaptureSummaries(baseline, observed);
      const content = args.format === 'markdown' ? markdownComparisonReport(result, baseline, observed) :
        JSON.stringify(result, null, 2) + '\n';
      if (args.out) saveReport(args.out, content);
      else process.stdout.write(content);
      if (args.strict && !result.ok) process.exitCode = 1;
    }
  } catch {
    // Do not relay private JSON, paths or SDK diagnostic strings.
    console.error('A2UI browser capture comparison refused; inputs and paths omitted');
    process.exitCode = 2;
  }
}
