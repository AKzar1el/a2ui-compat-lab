#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {emitReplayReport} from './report-output.mjs';
import {createHash} from 'node:crypto';
import {parseJsonLines, parseJsonLinesBytes, replayV09Actions} from './replay.mjs';

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
// Preserve the actual Button action context across arbitrary UTF-8 transport splits,
// not only the ASCII fixture's JavaScript string boundaries.
const unicodeSteps = structuredClone(steps);
unicodeSteps[2].message.updateDataModel.value.selection = 'Čebelica 🌍';
unicodeSteps[4].message.updateDataModel.value.selection = 'こんにちは 👋';
const unicodeRaw = unicodeSteps.map(step => JSON.stringify(step)).join('\n') + '\n';
const utf8 = Buffer.from(unicodeRaw, 'utf8');
const unicodeBaseline = await replayV09Actions(unicodeSteps);
const byteChunkTrials = [];
for (const chunkSizeBytes of [1, 2, 3, 7, 57, utf8.length]) {
  const chunks = [];
  for (let i = 0; i < utf8.length; i += chunkSizeBytes)
    chunks.push(utf8.subarray(i, i + chunkSizeBytes));
  const observed = await replayV09Actions(parseJsonLinesBytes(chunks));
  byteChunkTrials.push({chunkSizeBytes, chunks: chunks.length,
    matches: JSON.stringify(observed) === JSON.stringify(unicodeBaseline)});
}
const packageInfo = JSON.parse(readFileSync(new URL('../node_modules/@a2ui/web_core/package.json', import.meta.url), 'utf8'));
const report = {
  schemaVersion: 1,
  protocol: 'v0.9',
  implementation: '@a2ui/web_core@' + packageInfo.version,
  harness: 'published SDK MessageProcessor + ComponentContext + GenericBinder (headless; no DOM)',
  fixtureSha256: createHash('sha256').update(raw).digest('hex'),
  unicodeFixtureSha256: createHash('sha256').update(utf8).digest('hex'),
  steps: steps.length,
  actionCount: baseline.actions.length,
  chunkTrials,
  byteChunkTrials,
  allMatch: chunkTrials.every(trial => trial.matches) &&
    byteChunkTrials.every(trial => trial.matches),
  trace: baseline,
  unicodeTrace: unicodeBaseline,
};
emitReplayReport(report, process.argv.slice(2),
  'Usage: node src/replay-action-report.mjs [--out FILE]');
if (!report.allMatch) process.exitCode = 1;
