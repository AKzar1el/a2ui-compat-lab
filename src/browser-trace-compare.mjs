#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {lstatSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_REPORTED_INDICES = 100;
const FIELDS = ['actions', 'checkpoints', 'runtimeErrors', 'consoleErrors', 'accessibilityFindings'];
const USAGE = 'Usage: node src/browser-trace-compare.mjs --before OLD.json --after NEW.json [--strict] [--json] [--out NEW.json]';

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
  const changedFields = FIELDS.filter(field => differences[field].changedCount > 0);
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
    changedFields,
    differences,
    ok: candidateHealthy && !passedChanged && changedFields.length === 0,
    note: 'Observable actual Chromium replay comparison, not official A2UI conformance or authenticated provenance',
  };
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

function options(args) {
  if (args.length === 1 && args[0] === '--help') return {help: true};
  const result = {strict: false, json: false};
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--before', '--after', '--out', '--strict', '--json'].includes(key) ||
        seen.has(key)) throw new Error(USAGE);
    seen.add(key);
    if (key === '--strict') result.strict = true;
    else if (key === '--json') result.json = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(USAGE);
      result[key.slice(2)] = value;
    }
  }
  if (!result.before || !result.after) throw new Error(USAGE);
  return result;
}

function main() {
  const args = options(process.argv.slice(2));
  if (args.help) return console.log(USAGE);
  const report = compareBrowserTraces(
    readTrace(args.before, 'before'), readTrace(args.after, 'after'));
  if (args.out) {
    const target = resolve(args.out);
    mkdirSync(dirname(target), {recursive: true});
    try {
      writeFileSync(target, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error('Comparison output exists; choose a new --out path');
      throw error;
    }
    console.error('Wrote ' + target);
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log('A2UI actual-browser trace comparison: ' +
    (report.ok ? 'MATCH' : 'DRIFT') + '; changed fields: ' +
    (report.changedFields.join(', ') || 'none') +
    '; candidate healthy: ' + report.candidateHealthy);
  if (args.strict && !report.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error('A2UI browser trace comparison failed: ' + error.message);
    process.exitCode = 2;
  }
}
