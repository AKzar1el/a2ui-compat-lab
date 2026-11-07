#!/usr/bin/env node
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {inspectInstallation} from './doctor.mjs';

function usage() {
  console.log('a2ui-compat-lab — published A2UI SDK parity and release checks');
  console.log('  node src/cli.mjs scan [--strict] [--json] [--out FILE]');
  console.log('  node src/cli.mjs releases [--strict] [--json] [--out FILE]');
  console.log('  node src/cli.mjs doctor [--strict] [--json] [--out FILE]  (offline install check)');
  console.log('  node src/cli.mjs --version');
  console.log('  npm test  (offline, deterministic regression tests)');
  console.log('Note: releases accesses npm and can take minutes; scan is fully offline after npm ci.');
}
function parseArgs(argv) {
  const verb = argv[0] ?? 'help';
  let strict = false, json = false, out = null;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--strict') strict = true;
    else if (token === '--json') json = true;
    else if (token === '--out' && argv[i + 1]) out = argv[++i];
    else throw new Error('Unknown or incomplete option: ' + token);
  }
  return {verb, strict, json, out};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.verb === 'help' || args.verb === '--help') return usage();
  if (args.verb === '--version' || args.verb === 'version') {
    if (args.strict || args.json || args.out) throw new Error('Version command takes no options');
    console.log(inspectInstallation().tool.version);
    return;
  }
  if (!['scan', 'releases', 'doctor'].includes(args.verb)) throw new Error('Unknown command: ' + args.verb);
  let report;
  if (args.verb === 'scan') {
    const {evaluate, checkBaseline} = await import('./differential.mjs');
    report = evaluate();
    report.baseline = checkBaseline(report);
  } else if (args.verb === 'releases') {
    const {probeAllReleases} = await import('./releases.mjs');
    report = probeAllReleases();
  } else report = inspectInstallation();
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
      console.log('  ' + row.id + ': JSON Schema=' + row.referenceValid + ' web_core=' + row.webCoreValid + ' (' + row.category + ')');
    if (!ok) console.error('Baseline drift: ' + JSON.stringify(report.baseline));
  } else if (args.verb === 'releases') {
    for (const row of report.rows)
      console.log(row.id + ': expected ' + row.expected + ', observed ' + row.observed +
        ' — ' + (row.matchesExpectation ? 'MATCH' : 'DRIFT'));
    if (!ok) console.error('Published package resolution diverged from expected baseline');
  } else {
    console.log('A2UI offline installation: ' + (ok ? 'READY' : 'NEEDS ATTENTION'));
    console.log('  Node ' + report.node.actual + ' (required ' + report.node.required + '): ' + (report.node.ok ? 'OK' : 'FAIL'));
    if (!report.lockfile.ok) console.log('  Lockfile: ' + report.lockfile.issues.join(', '));
    for (const item of report.packages) {
      console.log('  ' + item.name + ': pinned=' + item.expected + ' locked=' + (item.locked ?? 'missing') +
        ' installed=' + (item.installed ?? 'missing') + ' ' + (item.ok ? 'OK' : item.issues.join(', ')));
    }
  }
  if (args.strict && !ok) process.exitCode = 1;
}
main().catch(error => {console.error('a2ui-compat-lab: ' + (error?.stack || error)); process.exitCode = 2;});
