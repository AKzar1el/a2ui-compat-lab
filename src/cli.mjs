#!/usr/bin/env node
import {mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {inspectInstallation} from './doctor.mjs';
import {compareScans} from './compare.mjs';

function usage() {
  console.log('a2ui-compat-lab — published A2UI SDK parity and release checks');
  console.log('  node src/cli.mjs scan [--strict] [--json] [--out FILE]');
  console.log('  node src/cli.mjs releases [--strict] [--json] [--out FILE]');
  console.log('  node src/cli.mjs compare --before FILE --after FILE [--strict] [--json] [--out FILE]');
  console.log('  node src/cli.mjs doctor [--strict] [--json] [--out FILE]  (offline install check)');
  console.log('  node src/cli.mjs --version');
  console.log('  npm test  (offline, deterministic regression tests)');
  console.log('Note: releases accesses npm and can take minutes; scan is fully offline after npm ci.');
}

function parseArgs(argv) {
  const verb = argv[0] ?? 'help';
  let strict = false, json = false, out = null, before = null, after = null;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--strict') strict = true;
    else if (token === '--json') json = true;
    else if (token === '--out' && argv[i + 1]) out = argv[++i];
    else if (token === '--before' && argv[i + 1]) before = argv[++i];
    else if (token === '--after' && argv[i + 1]) after = argv[++i];
    else throw new Error('Unknown or incomplete option: ' + token);
  }
  return {verb, strict, json, out, before, after};
}

const MAX_COMPARISON_BYTES = 8 * 1024 * 1024;

// User-provided scan artifacts may be confidential; Node JSON errors can quote
// their contents, and unrestricted reads can exhaust memory before validation.
function readComparisonReport(path) {
  let contents;
  try {
    const target = resolve(path);
    const stat = statSync(target);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_COMPARISON_BYTES)
      throw new RangeError('Comparison report must be a regular JSON file of 1 byte to 8 MiB');
    contents = readFileSync(target, 'utf8');
  } catch (error) {
    if (error instanceof RangeError) throw error;
    throw new Error('Cannot read comparison report; path omitted');
  }
  try {
    return JSON.parse(contents);
  } catch {
    throw new SyntaxError('Comparison JSON is invalid; input contents omitted');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.verb === 'help' || args.verb === '--help') return usage();
  if (args.verb === '--version' || args.verb === 'version') {
    if (args.strict || args.json || args.out || args.before || args.after)
      throw new Error('Version command takes no options');
    console.log(inspectInstallation().tool.version);
    return;
  }
  if (!['scan', 'releases', 'compare', 'doctor'].includes(args.verb))
    throw new Error('Unknown command: ' + args.verb);
  if (args.verb === 'compare' ? (!args.before || !args.after) : (args.before || args.after))
    throw new Error('Compare requires --before FILE and --after FILE; other commands do not accept them');

  let report;
  if (args.verb === 'scan') {
    const {evaluate, checkBaseline} = await import('./differential.mjs');
    report = evaluate();
    report.baseline = checkBaseline(report);
  } else if (args.verb === 'releases') {
    const {probeAllReleases} = await import('./releases.mjs');
    report = probeAllReleases();
  } else if (args.verb === 'compare') {
    report = compareScans(readComparisonReport(args.before),
      readComparisonReport(args.after));
  } else {
    report = inspectInstallation();
  }
  const ok = args.verb === 'scan' ? report.baseline.ok : report.ok;
  if (args.out) {
    const target = resolve(args.out);
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
    console.error('Wrote ' + target);
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (args.verb === 'scan') {
    console.log('A2UI published SDK parity: ' + report.fixtureCount + ' cases, ' +
      report.divergenceCount + ' discrepancies; baseline ' + (ok ? 'MATCH' : 'DRIFT'));
    for (const row of report.rows.filter(r => r.divergent))
      console.log('  ' + row.id + ': JSON Schema=' + row.referenceValid +
        ' web_core=' + row.webCoreValid + ' (' + row.category + ')');
    if (!ok) console.error('Baseline drift: ' + JSON.stringify(report.baseline));
  } else if (args.verb === 'compare') {
    console.log('A2UI SDK parity comparison: ' + report.comparedFixtures +
      ' common fixtures; ' + (ok ? 'MATCH' : 'DRIFT'));
    console.log('  web_core ' + report.before.webCore + ' -> ' + report.after.webCore);
    if (report.referenceImplementationChanged)
      console.log('  reference implementation changed; inspect before/after configuration');
    for (const key of ['resolved', 'newlyObserved', 'directionChanged', 'referenceChanged',
      'decisionChanged', 'addedFixtures', 'removedFixtures']) {
      if (report[key].length) console.log('  ' + key + ': ' + report[key].join(', '));
    }
    console.log('  persistent discrepancies: ' + report.persistent.length +
      '; stable controls: ' + report.stableControls);
    if (!ok) console.error('Review observed drift; neither report nor pinned baselines were modified');
  } else if (args.verb === 'releases') {
    for (const row of report.rows) {
      console.log(row.id + ': expected ' + row.expected +
        ', observed ' + row.observed + ' — ' + (row.matchesExpectation ? 'MATCH' : 'DRIFT'));
      if (!row.matchesExpectation && row.nextAction)
        console.error('  ' + row.failureKind +
          (row.npmErrorCode ? ' (' + row.npmErrorCode + ')' : '') + ': ' + row.nextAction);
    }
    if (!ok) console.error('Published package resolution diverged from expected baseline');
  } else {
    console.log('A2UI offline installation: ' + (ok ? 'READY' : 'NEEDS ATTENTION'));
    console.log('  Node ' + report.node.actual + ' (required ' + report.node.required +
      '): ' + (report.node.ok ? 'OK' : 'FAIL'));
    if (!report.lockfile.ok) console.log('  Lockfile: ' + report.lockfile.issues.join(', '));
    for (const item of report.packages) {
      console.log('  ' + item.name + ': pinned=' + item.expected +
        ' locked=' + (item.locked ?? 'missing') +
        ' installed=' + (item.installed ?? 'missing') +
        ' ' + (item.ok ? 'OK' : item.issues.join(', ')));
    }
  }
  if (args.strict && !ok) process.exitCode = 1;
}
main().catch(error => {
  console.error('a2ui-compat-lab: ' + (error?.stack || error));
  process.exitCode = 2;
});
