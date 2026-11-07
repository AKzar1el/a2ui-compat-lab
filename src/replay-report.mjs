#!/usr/bin/env node
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {parseJsonLines, replayV09} from './replay.mjs';

const messages = JSON.parse(readFileSync(new URL('../fixtures/lifecycle-v09.json', import.meta.url), 'utf8'));
const raw = messages.map(message => JSON.stringify(message)).join('\n') + '\n';
const baseline = replayV09(messages);
const chunkSizes = [1, 7, 57, raw.length];
const trials = chunkSizes.map(size => {
  const chunks = [];
  for (let i = 0; i < raw.length; i += size) chunks.push(raw.slice(i, i + size));
  const replay = replayV09(parseJsonLines(chunks));
  return {chunkSize: size, chunks: chunks.length, matches: JSON.stringify(replay) === JSON.stringify(baseline)};
});
const report = {
  schemaVersion: 1,
  protocol: 'v0.9',
  implementation: '@a2ui/web_core@0.15.0 MessageProcessor',
  note: 'Headless real-SDK state replay, not browser-rendered UI',
  fixtureSha256: createHash('sha256').update(raw).digest('hex'),
  events: messages.length,
  chunkTrials: trials,
  allMatch: trials.every(trial => trial.matches),
  replay: baseline,
};
const i = process.argv.indexOf('--out');
if (i !== -1 && process.argv[i + 1]) {
  const path = resolve(process.argv[i + 1]);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  console.error('Wrote ' + path);
} else console.log(JSON.stringify(report, null, 2));
if (!report.allMatch) process.exitCode = 1;
