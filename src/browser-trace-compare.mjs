#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {lstatSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_PNG_BYTES = 32 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_REPORTED_INDICES = 100;
const FIELDS = ['actions', 'checkpoints', 'runtimeErrors', 'consoleErrors', 'accessibilityFindings'];
const USAGE = 'Usage: node src/browser-trace-compare.mjs --before OLD.json --after NEW.json [--before-png OLD.png --after-png NEW.png] [--strict] [--json | --markdown] [--out REPORT.json|REPORT.md]';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validVersions(value) {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  // Provenance is package-name -> published-version only; never echo arbitrary objects.
  return entries.length > 0 && entries.length <= 32 &&
    entries.every(([name, version]) =>
      /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name) &&
      typeof version === 'string' &&
      /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version));
}

function checkTrace(trace, label) {
  if (!isRecord(trace) || trace.schemaVersion !== 1 || trace.protocol !== 'v0.9' ||
      !/^[a-f0-9]{64}$/i.test(trace.fixtureSha256 ?? '') ||
      typeof trace.harness !== 'string' || trace.harness.trim().length === 0 ||
      (Object.hasOwn(trace, 'screenshotSha256') &&
        (typeof trace.screenshotSha256 !== 'string' ||
          !/^[a-f0-9]{64}$/i.test(trace.screenshotSha256))) ||
      !validVersions(trace.versions) || typeof trace.passed !== 'boolean' ||
      FIELDS.some(field => !Array.isArray(trace[field])) ||
      trace.actions.some(item => !isRecord(item) ||
        typeof item.name !== 'string' || item.name.length === 0) ||
      trace.checkpoints.some(item => !isRecord(item) ||
        typeof item.step !== 'string' || item.step.length === 0) ||
      [...trace.runtimeErrors, ...trace.consoleErrors].some(item => typeof item !== 'string') ||
      trace.accessibilityFindings.some(item => !isRecord(item) ||
        typeof item.id !== 'string' || item.id.length === 0))
    throw new Error('Invalid ' + label + ' browser trace schema; input contents omitted');
}

function fieldDiff(before, after) {
  let changedCount = 0;
  const changedIndices = [];
  for (let index = 0; index < Math.max(before.length, after.length); index++) {
    if (digest(before[index] ?? null) !== digest(after[index] ?? null) ||
        (index >= before.length || index >= after.length)) {
      changedCount++;
      if (changedIndices.length < MAX_REPORTED_INDICES) changedIndices.push(index);
    }
  }
  return {beforeCount: before.length, afterCount: after.length,
    changedCount, changedIndices, indicesTruncated: changedCount > changedIndices.length};
}

/** Compare actual published React/Chromium evidence; SDK version changes are informational. */
export function compareBrowserTraces(before, after) {
  checkTrace(before, 'before');
  checkTrace(after, 'after');
  if (before.fixtureSha256.toLowerCase() !== after.fixtureSha256.toLowerCase())
    throw new Error('Incomparable browser traces: fixture SHA-256 differs');
  if (before.harness !== after.harness)
    throw new Error('Incomparable browser traces: rendering harness differs');
  const differences = Object.fromEntries(FIELDS.map(field =>
    [field, fieldDiff(before[field], after[field])]));
  // Optional legacy PNG evidence remains comparable. A partial pair is not a MATCH.
  const beforeScreenshot = before.screenshotSha256?.toLowerCase() ?? null;
  const afterScreenshot = after.screenshotSha256?.toLowerCase() ?? null;
  const screenshotChanged = beforeScreenshot !== afterScreenshot;
  const visualEvidence = beforeScreenshot && afterScreenshot ? 'both' :
    beforeScreenshot || afterScreenshot ? 'partial' : 'legacy-unavailable';
  const changedFields = FIELDS.filter(field => differences[field].changedCount > 0);
  if (screenshotChanged) changedFields.push('screenshotSha256');
  const passedChanged = before.passed !== after.passed;
  const candidateHealthy = after.passed && after.runtimeErrors.length === 0 &&
    after.consoleErrors.length === 0;
  return {
    schemaVersion: 1,
    kind: 'a2ui-real-browser-trace-comparison',
    fixtureSha256: before.fixtureSha256.toLowerCase(),
    beforeVersions: before.versions,
    afterVersions: after.versions,
    beforePassed: before.passed,
    afterPassed: after.passed,
    candidateHealthy,
    passedChanged,
    screenshotChanged,
    visualEvidence,
    pngArtifactsVerified: false,
    changedFields,
    differences,
    ok: candidateHealthy && !passedChanged && changedFields.length === 0,
    note: 'PNG SHA-256 is byte-level visual evidence, not pixel-diff; legacy traces may lack it. Not official conformance or authenticated provenance',
  };
}


/** Human-reviewable, content-redacted summary for saved real-browser evidence. */
export function renderBrowserMarkdown(report) {
  const versions = [...new Set([
    ...Object.keys(report.beforeVersions), ...Object.keys(report.afterVersions),
  ])].sort();
  const rows = FIELDS.map(field => {
    const diff = report.differences[field];
    const indices = diff.changedIndices.join(', ') || '-';
    return '| ' + field + ' | ' + diff.beforeCount + ' | ' + diff.afterCount +
      ' | ' + diff.changedCount + ' | ' + indices +
      (diff.indicesTruncated ? ' (first 100 only)' : '') + ' |';
  });
  return [
    '# A2UI real-browser regression comparison',
    '',
    '**Result:** ' + (report.ok ? 'MATCH' : 'DRIFT'),
    '**Candidate healthy:** ' + (report.candidateHealthy ? 'yes' : 'no'),
    '**Replay passed:** ' + (report.beforePassed ? 'yes' : 'no') +
      ' before / ' + (report.afterPassed ? 'yes' : 'no') + ' after',
    '**Fixture SHA-256:** `' + report.fixtureSha256 + '`,
    '**Changed fields:** ' + (report.changedFields.join(', ') || 'none'),
    '**Screenshot bytes changed:** ' + (report.screenshotChanged ? 'yes' : 'no'),
    '**PNG evidence:** ' + report.visualEvidence +
      '; saved artifact bytes verified: ' + (report.pngArtifactsVerified ? 'yes' : 'no'),
    '',
    '## Published SDK versions (informational)',
    '',
    '| Package | Before | After |',
    '| --- | --- | --- |',
    ...versions.map(name => '| `' + name + '` | `' +
      (report.beforeVersions[name] ?? '-') + '` | `' +
      (report.afterVersions[name] ?? '-') + '` |'),
    '',
    '## Browser behavior evidence',
    '',
    '| Category | Before | After | Changed | Changed indices (zero-based) |',
    '| --- | ---: | ---: | ---: | --- |',
    ...rows,
    '',
    'Action contexts, DOM content, error messages and paths are intentionally omitted.',
    'A PNG SHA-256 compares screenshot bytes, not decoded pixels or perceptual similarity.',
    'This report is not official A2UI conformance certification or authenticated provenance.',
    '',
  ].join('
');
}

function readTrace(file, label) {
  let bytes;
  try {
    const path = resolve(file);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_INPUT_BYTES)
      throw new Error('not a regular 1-byte-to-8-MiB file');
    bytes = readFileSync(path);
    if (bytes.length < 1 || bytes.length > MAX_INPUT_BYTES)
      throw new Error('file changed during read');
  } catch {
    throw new Error('Cannot read ' + label + ' browser trace; path and contents omitted');
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch {
    throw new Error('Invalid JSON or UTF-8 in ' + label + ' browser trace; contents omitted');
  }
}

/** Optional CLI integrity check: a trace digest alone cannot detect modified PNG files. */
function verifyScreenshotFile(trace, file, label) {
  if (!trace.screenshotSha256)
    throw new Error('Missing ' + label + ' screenshot SHA-256; cannot verify PNG artifact');
  let bytes;
  try {
    const path = resolve(file);
    const metadata = lstatSync(path); // Reject symlinks and non-regular files.
    if (!metadata.isFile() || metadata.size < PNG_SIGNATURE.length ||
        metadata.size > MAX_PNG_BYTES) throw new Error('invalid size or file type');
    bytes = readFileSync(path);
    if (bytes.length < PNG_SIGNATURE.length || bytes.length > MAX_PNG_BYTES)
      throw new Error('PNG changed size during read');
  } catch {
    throw new Error('Cannot read ' + label + ' PNG screenshot; path and contents omitted');
  }
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
    throw new Error('Invalid ' + label + ' PNG signature; contents omitted');
  if (createHash('sha256').update(bytes).digest('hex') !== trace.screenshotSha256.toLowerCase())
    throw new Error(label + ' PNG SHA-256 mismatch; file contents omitted');
}

function options(args) {
  if (args.length === 1 && args[0] === '--help') return {help: true};
  const result = {strict: false, json: false, markdown: false};
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--before', '--after', '--before-png', '--after-png', '--out', '--strict', '--json', '--markdown'].includes(key) ||
        seen.has(key)) throw new Error(USAGE);
    seen.add(key);
    if (key === '--strict') result.strict = true;
    else if (key === '--json') result.json = true;
    else if (key === '--markdown') result.markdown = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(USAGE);
      const name = key === '--before-png' ? 'beforePng' :
        key === '--after-png' ? 'afterPng' : key.slice(2);
      result[name] = value;
    }
  }
  if (!result.before || !result.after || (result.json && result.markdown) ||
      Boolean(result.beforePng) !== Boolean(result.afterPng))
    throw new Error(USAGE);
  return result;
}

function main() {
  const args = options(process.argv.slice(2));
  if (args.help) return console.log(USAGE);
  const before = readTrace(args.before, 'before');
  const after = readTrace(args.after, 'after');
  const report = compareBrowserTraces(before, after);
  if (args.beforePng) {
    verifyScreenshotFile(before, args.beforePng, 'before');
    verifyScreenshotFile(after, args.afterPng, 'after');
    report.pngArtifactsVerified = true;
  }
  if (args.out) {
    const target = resolve(args.out);
    mkdirSync(dirname(target), {recursive: true});
    try {
      writeFileSync(target, args.markdown ? renderBrowserMarkdown(report) :
        JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error('Comparison output exists; choose a new --out path');
      throw error;
    }
    console.error('Wrote ' + target);
  }
  if (args.markdown) process.stdout.write(renderBrowserMarkdown(report));
  else if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log('A2UI actual-browser trace comparison: ' +
    (report.ok ? 'MATCH' : 'DRIFT') + '; changed fields: ' +
    (report.changedFields.join(', ') || 'none') +
    '; candidate healthy: ' + report.candidateHealthy +
    '; PNG evidence: ' + report.visualEvidence +
    '; PNG bytes verified: ' + report.pngArtifactsVerified);
  if (args.strict && !report.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error('A2UI browser trace comparison failed: ' + error.message);
    process.exitCode = 2;
  }
}
