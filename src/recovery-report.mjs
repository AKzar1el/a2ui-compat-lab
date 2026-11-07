#!/usr/bin/env node
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {parseJsonLines, replayV09Recoverable} from './replay.mjs';

const messages = JSON.parse(readFileSync(new URL('../fixtures/recovery-v09.json', import.meta.url), 'utf8'));
const raw = messages.map(message => JSON.stringify(message)).join('\n') + '\n';
const baseline = replayV09Recoverable(messages);
const rejectedIndices = baseline.events.filter(event => event.outcome === 'rejected').map(event => event.index);
const expectedRejections = [3, 5, 9];
const trials = [1, 7, 57, raw.length].map(chunkSize => {
  const chunks = [];
  for (let i = 0; i < raw.length; i += chunkSize) chunks.push(raw.slice(i, i + chunkSize));
  const trial = replayV09Recoverable(parseJsonLines(chunks));
  return {chunkSize, matches: JSON.stringify(trial) === JSON.stringify(baseline)};
});
const report = {
  schemaVersion: 1,
  protocol: 'v0.9',
  sdk: '@a2ui/web_core@0.15.0',
  scope: 'Headless actual MessageProcessor error containment, not React/browser rendering',
  fixtureSha256: createHash('sha256').update(raw).digest('hex'),
  messageCount: messages.length,
  expectedRejections,
  observedRejections: rejectedIndices,
  matchesExpectedRejections: JSON.stringify(rejectedIndices) === JSON.stringify(expectedRejections),
  chunkTrials: trials,
  allMatch: trials.every(trial => trial.matches),
  replay: baseline,
};
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--out' || !args[1] || args[1].startsWith('--')))
  throw new Error('Usage: node src/recovery-report.mjs [--out FILE]');
if (args.length === 2) {
  const path = resolve(args[1]);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  console.error('Wrote ' + path);
} else console.log(JSON.stringify(report, null, 2));
if (!report.allMatch || !report.matchesExpectedRejections || !baseline.safeToContinue)
  process.exitCode = 1;
