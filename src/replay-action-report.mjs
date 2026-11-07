#!/usr/bin/env node
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {parseJsonLines, replayV09Actions} from './replay.mjs';

const steps = JSON.parse(readFileSync(new URL('../fixtures/action-v09.json', import.meta.url), 'utf8'));
const raw = steps.map(step => JSON.stringify(step)).join('\n') + '\n';
const baseline = await replayV09Actions(steps);
const chunkTrials = [];
for (const chunkSize of [1, 7, 57, raw.length]) {
  const chunks = [];
  for (let i = 0; i < raw.length; i += chunkSize) chunks.push(raw.slice(i, i + chunkSize));
  const observed = await replayV09Actions(parseJsonLines(chunks));
  chunkTrials.push({chunkSize, chunks: chunks.length, matches: JSON.stringify(observed) === JSON.stringify(baseline)});
}
const packageInfo = JSON.parse(readFileSync(new URL('../node_modules/@a2ui/web_core/package.json', import.meta.url), 'utf8'));
const report = {
  schemaVersion: 1,
  protocol: 'v0.9',
  implementation: '@a2ui/web_core@' + packageInfo.version,
  harness: 'published SDK MessageProcessor + ComponentContext + GenericBinder (headless; no DOM)',
  fixtureSha256: createHash('sha256').update(raw).digest('hex'),
  steps: steps.length,
  actionCount: baseline.actions.length,
  chunkTrials,
  allMatch: chunkTrials.every(trial => trial.matches),
  trace: baseline,
};
const i = process.argv.indexOf('--out');
if (i !== -1) {
  if (!process.argv[i + 1]) throw new Error('--out requires a path');
  const path = resolve(process.argv[i + 1]);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  console.error('Wrote ' + path);
} else {
  console.log(JSON.stringify(report, null, 2));
}
if (!report.allMatch) process.exitCode = 1;
