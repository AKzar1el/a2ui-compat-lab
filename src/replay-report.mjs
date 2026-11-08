#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {emitReplayReport} from './report-output.mjs';
import {createHash} from 'node:crypto';
import {parseJsonLines, parseJsonLinesBytes, replayV09} from './replay.mjs';

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
// Exercise genuine UTF-8 transport bytes, not only JavaScript string slices.
const unicodeMessages = structuredClone(messages);
unicodeMessages[2].updateDataModel.value = {title: 'Čebelica 🌍', body: 'こんにちは'};
unicodeMessages[3].updateDataModel.value = 'Здраво 👋';
const unicodeRaw = unicodeMessages.map(message => JSON.stringify(message)).join('\n') + '\n';
const utf8 = Buffer.from(unicodeRaw, 'utf8');
const unicodeBaseline = replayV09(unicodeMessages);
const byteChunkTrials = [1, 2, 3, 7, 57, utf8.length].map(size => {
  const chunks = [];
  for (let i = 0; i < utf8.length; i += size) chunks.push(utf8.subarray(i, i + size));
  const replay = replayV09(parseJsonLinesBytes(chunks));
  return {chunkSizeBytes: size, chunks: chunks.length,
    matches: JSON.stringify(replay) === JSON.stringify(unicodeBaseline)};
});
const report = {
  schemaVersion: 1,
  protocol: 'v0.9',
  implementation: '@a2ui/web_core@0.15.0 MessageProcessor',
  note: 'Headless real-SDK state replay, not browser-rendered UI',
  fixtureSha256: createHash('sha256').update(raw).digest('hex'),
  unicodeFixtureSha256: createHash('sha256').update(utf8).digest('hex'),
  events: messages.length,
  chunkTrials: trials,
  byteChunkTrials,
  allMatch: trials.every(trial => trial.matches) && byteChunkTrials.every(trial => trial.matches),
  replay: baseline,
  unicodeReplay: unicodeBaseline,
};
emitReplayReport(report, process.argv.slice(2),
  'Usage: node src/replay-report.mjs [--out FILE]');
if (!report.allMatch) process.exitCode = 1;
