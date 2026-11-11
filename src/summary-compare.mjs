#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const USAGE = 'Usage: node src/summary-compare.mjs (--before baseline-summary.json | --before-capture before.jsonl) (--after summary.json | --after-capture after.jsonl) [--verify-chunks] [--strict] [--out result.json]';
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_STEPS = 10000;
const MAX_REVIEW_INDICES = 100;
const OPERATIONS = new Set(['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface', 'unclassified']);
const STEP_FIELDS = ['operation', 'surfacePresent', 'componentCount', 'actionCount', 'actionsEmitted'];
const SUMMARY_KEYS = ['schemaVersion', 'kind', 'protocol', 'events', 'chunksVerified', 'steps'];
const STEP_KEYS = ['index', ...STEP_FIELDS];

function recordHasExactly(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every(key => Object.hasOwn(value, key));
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// Validate a deliberately narrow schema; never propagate arbitrary input
// properties into the comparison or its diagnostics.
function validateSummary(report) {
  if (!recordHasExactly(report, SUMMARY_KEYS) || report.schemaVersion !== 1 ||
      report.kind !== 'a2ui-capture-safe-summary' || report.protocol !== 'v0.9' ||
      typeof report.chunksVerified !== 'boolean' ||
      !Number.isSafeInteger(report.events) || report.events < 1 ||
      report.events > MAX_STEPS || !Array.isArray(report.steps) ||
      report.steps.length !== report.events)
    throw new Error('Invalid A2UI safe summary structure; input contents omitted');
  let previousActionCount = 0;
  for (let index = 0; index < report.steps.length; index++) {
    const step = report.steps[index];
    if (!recordHasExactly(step, STEP_KEYS) || step.index !== index ||
        !OPERATIONS.has(step.operation) ||
        typeof step.surfacePresent !== 'boolean' ||
        !nonnegativeInteger(step.componentCount) ||
        !nonnegativeInteger(step.actionCount) ||
        !nonnegativeInteger(step.actionsEmitted) ||
        step.actionCount < previousActionCount ||
        step.actionsEmitted !== step.actionCount - previousActionCount)
      throw new Error('Invalid A2UI safe summary step; input contents omitted');
    previousActionCount = step.actionCount;
  }
  return report;
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return {help: true};
  const options = {strict: false, verifyChunks: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--strict' && !options.strict) {
      options.strict = true;
    } else if (arg === '--verify-chunks' && !options.verifyChunks) {
      options.verifyChunks = true;
    } else if (['--before', '--before-capture', '--after', '--after-capture', '--out'].includes(arg) &&
        argv[i + 1] && !argv[i + 1].startsWith('--')) {
      const key = arg === '--after-capture' ? 'afterCapture' :
        arg === '--before-capture' ? 'beforeCapture' : arg.slice(2);
      if (options[key]) throw new Error(USAGE);
      options[key] = resolve(argv[++i]);
    } else {
      throw new Error(USAGE);
    }
  }
  if (Boolean(options.before) === Boolean(options.beforeCapture) ||
      Boolean(options.after) === Boolean(options.afterCapture) ||
      (options.verifyChunks && !options.beforeCapture && !options.afterCapture))
    throw new Error(USAGE);
  return options;
}

function readSummary(path) {
  let bytes;
  try {
    const meta = statSync(path);
    if (!meta.isFile() || meta.size < 1 || meta.size > MAX_REPORT_BYTES)
      throw new RangeError('Summary must be a regular JSON file of 1 byte to 4 MiB');
    bytes = readFileSync(path);
  } catch (error) {
    if (error instanceof RangeError) throw error;
    throw new Error('Cannot read summary file; path omitted');
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch {
    // JSON/UTF-8 decoder errors sometimes contain private input fragments.
    throw new Error('Invalid summary encoding or JSON; input contents omitted');
  }
  return validateSummary(value);
}

// Use the existing pinned-SDK capture CLI in a bounded, shell-free child process.
// It emits only the allowlisted safe summary; raw capture reports are never
// written to disk or returned in parent diagnostics.
function summaryFromCapture(path, verifyChunks) {
  let output;
  try {
    output = execFileSync(process.execPath, [
      fileURLToPath(new URL('./replay-file.mjs', import.meta.url)),
      '--input', path, '--summary', ...(verifyChunks ? ['--verify-chunks'] : []),
    ], {encoding: 'utf8', timeout: 30000, maxBuffer: MAX_REPORT_BYTES,
      stdio: ['ignore', 'pipe', 'pipe']});
  } catch {
    throw new Error('Cannot replay capture with pinned SDK; input contents and path omitted');
  }
  try {
    return validateSummary(JSON.parse(output));
  } catch {
    throw new Error('Invalid generated safe summary; input contents omitted');
  }
}

function compareSummaries(before, after) {
  const differences = [];
  let changedSteps = 0;
  for (let index = 0; index < Math.max(before.events, after.events); index++) {
    const previous = before.steps[index];
    const current = after.steps[index];
    const fields = !previous ? ['stepAdded'] :
      !current ? ['stepRemoved'] :
        STEP_FIELDS.filter(field => previous[field] !== current[field]);
    if (!fields.length) continue;
    changedSteps++;
    if (differences.length < MAX_REVIEW_INDICES) differences.push({index, fields});
  }
  const verificationCoverageChanged = before.chunksVerified !== after.chunksVerified;
  return {
    schemaVersion: 1,
    kind: 'a2ui-capture-structure-diff',
    protocol: 'v0.9',
    result: changedSteps || verificationCoverageChanged ? 'DRIFT' : 'MATCH',
    beforeEvents: before.events,
    afterEvents: after.events,
    beforeChunksVerified: before.chunksVerified,
    afterChunksVerified: after.chunksVerified,
    verificationCoverageChanged,
    changedSteps,
    differences,
    omittedDifferences: changedSteps - differences.length,
    note: 'Structural workflow comparison only; values, IDs and capture identity are not compared',
  };
}

function saveReport(path, content) {
  try {
    mkdirSync(dirname(path), {recursive: true});
  } catch {
    throw new Error('Cannot prepare summary comparison directory; path omitted');
  }
  try {
    // Exclusive creation also refuses symlinks and existing source reports.
    writeFileSync(path, content, {flag: 'wx'});
  } catch (error) {
    if (error?.code === 'EEXIST')
      throw new Error('Summary comparison already exists; choose a new --out path');
    throw new Error('Cannot write summary comparison; path omitted');
  }
  console.error('Wrote summary comparison report');
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
  } else {
    const before = args.beforeCapture ? summaryFromCapture(args.beforeCapture, args.verifyChunks) :
      readSummary(args.before);
    const after = args.afterCapture ? summaryFromCapture(args.afterCapture, args.verifyChunks) :
      readSummary(args.after);
    const report = compareSummaries(before, after);
    const output = JSON.stringify(report, null, 2) + '\n';
    if (args.out) saveReport(args.out, output);
    else process.stdout.write(output);
    if (args.strict && report.result === 'DRIFT') process.exitCode = 1;
  }
} catch (error) {
  console.error('A2UI summary comparison refused: ' + error.message);
  process.exitCode = 2;
}
