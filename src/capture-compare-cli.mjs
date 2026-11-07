#!/usr/bin/env node
import {readFileSync, statSync} from 'node:fs';
import {resolve} from 'node:path';
import {compareCaptureReports} from './capture-compare.mjs';

const USAGE = 'Usage: node src/capture-compare-cli.mjs --before old.json --after new.json [--strict] [--json]';
const MAX_REPORT_BYTES = 8 * 1024 * 1024;

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return {help: true};
  const options = {strict: false, json: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--strict' || arg === '--json') && !options[arg.slice(2)]) {
      options[arg.slice(2)] = true;
    } else if ((arg === '--before' || arg === '--after') &&
        !options[arg.slice(2)] && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      options[arg.slice(2)] = resolve(argv[++i]);
    } else throw new Error(USAGE);
  }
  if (!options.before || !options.after) throw new Error(USAGE);
  return options;
}

function readReport(path) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_REPORT_BYTES)
    throw new RangeError('Report must be a regular JSON file of 1 byte to 8 MiB');
  return JSON.parse(readFileSync(path, 'utf8'));
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
  } else {
    const report = compareCaptureReports(readReport(options.before), readReport(options.after));
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('A2UI same-capture replay comparison: ' + (report.ok ? 'MATCH' : 'DRIFT'));
      console.log('  steps: ' + report.events + '; differing: ' + report.differingSteps);
      console.log('  SDK: ' + report.beforeImplementation + ' -> ' + report.afterImplementation);
      for (const difference of report.differences)
        console.log('  step ' + difference.index + ': ' + difference.fields.join(', '));
      if (report.actionCountChanged) console.log('  emitted action count changed');
      if (!report.ok) console.error('Inspect input reports locally; captured data is not included in this diff');
    }
    if (options.strict && !report.ok) process.exitCode = 1;
  }
} catch (error) {
  console.error('A2UI replay comparison refused: ' + error.message);
  process.exitCode = 2;
}
