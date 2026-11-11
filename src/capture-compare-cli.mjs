#!/usr/bin/env node
import {mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {compareCaptureReports} from './capture-compare.mjs';
import {compareActionReports} from './action-report-compare.mjs';

const USAGE = 'Usage: node src/capture-compare-cli.mjs --before old.json --after new.json [--strict] [--json | --markdown] [--actions] [--out REPORT]';
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_REVIEW_INDICES = 100;

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return {help: true};
  const options = {strict: false, json: false, markdown: false, actions: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--strict', '--json', '--markdown', '--actions'].includes(arg) && !options[arg.slice(2)]) {
      options[arg.slice(2)] = true;
    } else if (['--before', '--after', '--out'].includes(arg) &&
        !options[arg.slice(2)] && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      options[arg.slice(2)] = resolve(argv[++i]);
    } else throw new Error(USAGE);
  }
  if (!options.before || !options.after || (options.json && options.markdown))
    throw new Error(USAGE);
  return options;
}

function readReport(path) {
  let bytes;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_REPORT_BYTES)
      throw new RangeError('Report must be a regular JSON file of 1 byte to 8 MiB');
    bytes = readFileSync(path);
  } catch (error) {
    if (error instanceof RangeError) throw error;
    // Filesystem errors can contain absolute paths to private captures.
    throw new Error('Cannot read comparison report; path omitted');
  }
  let contents;
  try {
    // A lossy UTF-8 replacement can turn a damaged JSON report into valid JSON.
    contents = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    throw new SyntaxError('Report is not valid UTF-8; input contents omitted');
  }
  try {
    return JSON.parse(contents);
  } catch {
    // Node's JSON.parse SyntaxError may contain slices of confidential input.
    throw new SyntaxError('Report is not valid JSON; input contents omitted');
  }
}


function renderMarkdown(report, actions) {
  // Only renderer-generated labels, indices and counts are included: never
  // interpolate arbitrary SDK names, captured values or action payloads.
  const lines = [
    '# A2UI ' + (actions ? 'action' : 'capture') + ' replay comparison',
    '',
    '- Result: **' + (report.ok ? 'MATCH' : 'DRIFT') + '**',
    '- Protocol: v0.9',
    '- Compared steps: ' + (actions ? report.steps : report.events),
    '- Differing steps: ' + report.differingSteps,
    '',
    '## Changed steps',
    '',
  ];
  if (!report.differences.length) lines.push('None');
  for (const difference of report.differences.slice(0, MAX_REVIEW_INDICES))
    lines.push('- Step ' + difference.index + ': ' + difference.fields.join(', '));
  if (report.differences.length > MAX_REVIEW_INDICES)
    lines.push('- ' + (report.differences.length - MAX_REVIEW_INDICES) +
      ' more changed steps (use --json for full indices)');
  lines.push('', '## Action evidence', '');
  if (actions) {
    lines.push('- Changed action indices: ' + report.differingActions);
    if (!report.changedActionIndices.length) lines.push('None');
    for (const index of report.changedActionIndices.slice(0, MAX_REVIEW_INDICES))
      lines.push('- Action index ' + index);
    if (report.changedActionIndices.length > MAX_REVIEW_INDICES)
      lines.push('- More changed actions omitted (use --json for full indices)');
  } else {
    lines.push('- Emitted action count changed: ' +
      (report.actionCountChanged ? 'yes' : 'no'));
  }
  lines.push('', 'Comparison only; raw capture values and action contexts are omitted.');
  return lines.join('\n') + '\n';
}

function renderText(report, actions) {
  const lines = [
    'A2UI ' + (actions ? 'action' : 'same-capture') +
      ' replay comparison: ' + (report.ok ? 'MATCH' : 'DRIFT'),
    '  steps: ' + (actions ? report.steps : report.events) +
      '; differing: ' + report.differingSteps,
    '  SDK: ' + report.beforeImplementation + ' -> ' + report.afterImplementation,
  ];
  for (const difference of report.differences)
    lines.push('  step ' + difference.index + ': ' + difference.fields.join(', '));
  if (actions && report.differingActions)
    lines.push('  changed action indices: ' + report.changedActionIndices.join(', '));
  if (!actions && report.actionCountChanged)
    lines.push('  emitted action count changed');
  return lines.join('\n') + '\n';
}

function emitArtifact(path, contents) {
  try {
    mkdirSync(dirname(path), {recursive: true});
  } catch {
    throw new Error('Cannot write comparison report; path omitted');
  }
  try {
    // O_EXCL prevents clobbering evidence, including input files and symlinks.
    writeFileSync(path, contents, {flag: 'wx'});
  } catch (error) {
    if (error?.code === 'EEXIST')
      throw new Error('Comparison output already exists; choose a new --out path');
    throw new Error('Cannot write comparison report; path omitted');
  }
  console.error('Wrote comparison report');
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
  } else {
    const report = (options.actions ? compareActionReports : compareCaptureReports)(
      readReport(options.before), readReport(options.after));
    const output = options.json ? JSON.stringify(report, null, 2) + '\n' :
      options.markdown ? renderMarkdown(report, options.actions) :
        renderText(report, options.actions);
    if (options.out) emitArtifact(options.out, output);
    else process.stdout.write(output);
    if (!options.out && !options.json && !options.markdown && !report.ok)
      console.error('Inspect input reports locally; captured data is not included in this diff');
    if (options.strict && !report.ok) process.exitCode = 1;
  }
} catch (error) {
  console.error('A2UI replay comparison refused: ' + error.message);
  process.exitCode = 2;
}
