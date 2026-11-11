#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {parseJsonLines, parseJsonLinesBytes, replayV09} from './replay.mjs';

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_FRAMES = 10000;
// Keep the opt-in 1-byte transport replay bounded on real-world captures.
const MAX_CHUNK_VERIFY_BYTES = 512 * 1024;
const USAGE = 'Usage: node src/replay-file.mjs --input capture.jsonl [--out report.json] [--verify-chunks] [--summary]';

// This CLI handles local captures only: never fetch, upload or run supplied code.
function options(argv) {
  if (argv.length === 1 && argv[0] === '--help') return {help: true};
  const result = {};
  let verifyChunks = false;
  let summary = false;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--summary') {
      if (summary) throw new Error(USAGE);
      summary = true;
      continue;
    }
    if (key === '--verify-chunks') {
      if (verifyChunks) throw new Error(USAGE);
      verifyChunks = true;
      continue;
    }
    const next = argv[++i];
    if ((key !== '--input' && key !== '--out') || !next || next.startsWith('--') || result[key])
      throw new Error(USAGE);
    result[key] = next;
  }
  if (!result['--input']) throw new Error(USAGE);
  return {
    input: resolve(result['--input']),
    out: result['--out'] ? resolve(result['--out']) : null,
    verifyChunks,
    summary,
  };
}

function* byteChunks(raw, size) {
  for (let offset = 0; offset < raw.length; offset += size)
    yield raw.subarray(offset, offset + size);
}

// Errors thrown while interpreting user captures may include private JSON or surface IDs.
function redactCaptureError(stage, run) {
  try {
    return run();
  } catch {
    throw new Error('Capture ' + stage + ' failed; input contents omitted');
  }
}

function replayCapture(raw, {verifyChunks = false} = {}) {
  if (raw.length === 0 || raw.length > MAX_INPUT_BYTES)
    throw new RangeError('Capture must be 1 byte to 4 MiB');
  if (verifyChunks && raw.length > MAX_CHUNK_VERIFY_BYTES)
    throw new RangeError('Chunk verification is limited to captures of 512 KiB or less');
  // Validate raw bytes BEFORE the older text parser's whitespace normalization.
  // This remains safe even when testing older installed harness versions.
  let start = 0;
  let frames = 0;
  for (let offset = 0; offset < raw.length; offset++) {
    if (raw[offset] !== 10) continue;
    if (offset - start > MAX_LINE_BYTES)
      throw new RangeError('JSONL frame exceeds 256 KiB untrimmed byte limit');
    frames++;
    if (frames > MAX_FRAMES) throw new RangeError('Capture exceeds 10,000 JSONL frames');
    start = offset + 1;
  }
  if (start !== raw.length) throw new SyntaxError('Capture must end with a JSONL newline');
  if (frames === 0) throw new SyntaxError('Capture contains no JSONL frames');
  const text = redactCaptureError('UTF-8 decoding', () =>
    new TextDecoder('utf-8', {fatal: true}).decode(raw));
  const messages = redactCaptureError('JSONL parsing', () =>
    parseJsonLines([text], {maxLineBytes: MAX_LINE_BYTES}));
  if (!messages.length) throw new SyntaxError('Capture has no A2UI messages');
  const replay = redactCaptureError('SDK replay', () => replayV09(messages));
  const report = {
    schemaVersion: 1,
    protocol: 'v0.9',
    implementation: '@a2ui/web_core@0.15.0 MessageProcessor',
    note: 'Real SDK headless replay; not browser rendering or conformance certification',
    captureSha256: createHash('sha256').update(raw).digest('hex'),
    captureBytes: raw.length,
    events: messages.length,
    replay,
  };
  if (verifyChunks) {
    const baseline = JSON.stringify(replay);
    const chunkSizes = [1, 7, 57, raw.length];
    const trials = chunkSizes.map(chunkSizeBytes => ({
      chunkSizeBytes,
      chunks: Math.ceil(raw.length / chunkSizeBytes),
      matches: redactCaptureError('byte-chunk verification', () =>
        JSON.stringify(replayV09(parseJsonLinesBytes(byteChunks(raw, chunkSizeBytes), {
          maxLineBytes: MAX_LINE_BYTES, maxMessages: MAX_FRAMES,
        }))) === baseline),
    }));
    if (!trials.every(trial => trial.matches))
      throw new Error('A2UI SDK state diverged across transport byte-chunk boundaries');
    report.chunkTrials = trials;
    report.allChunksMatch = true;
  }
  return report;
}

// File-system errors can contain absolute paths, user names and capture names.
// Keep the size diagnostics useful without exposing those paths in CLI output.
function readCaptureFile(input) {
  let metadata;
  try {
    metadata = statSync(input);
  } catch {
    throw new Error('Cannot inspect capture input; path omitted');
  }
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_INPUT_BYTES)
    throw new RangeError('Capture must be a regular file of 1 byte to 4 MiB');
  try {
    return readFileSync(input);
  } catch {
    throw new Error('Cannot read capture input; path omitted');
  }
}

function writeCaptureReport(out, report) {
  try {
    mkdirSync(dirname(out), {recursive: true});
  } catch {
    throw new Error('Cannot prepare capture report directory; path omitted');
  }
  try {
    // Exclusive creation prevents overwriting previous evidence and symlink targets.
    writeFileSync(out, report, {flag: 'wx'});
  } catch (error) {
    if (error?.code === 'EEXIST')
      throw new Error('Capture report already exists; choose a new --out path');
    throw new Error('Cannot write capture report; path omitted');
  }
}

try {
  const {input, out, help, verifyChunks, summary} = options(process.argv.slice(2));
  if (help) {
    console.log(USAGE);
  } else {
    const observed = replayCapture(readCaptureFile(input), {verifyChunks});
    // A shareable structural summary never includes capture values, IDs, or its
    // digest; raw evidence remains private unless the caller explicitly omits --summary.
    const view = summary ? {
      schemaVersion: 1,
      kind: 'a2ui-capture-safe-summary',
      protocol: observed.protocol,
      events: observed.events,
      chunksVerified: observed.allChunksMatch === true,
      steps: observed.replay.snapshots.map(snapshot => ({
        index: snapshot.index,
        surfacePresent: snapshot.exists,
        componentCount: snapshot.components.length,
        actionCount: snapshot.actionCount,
      })),
    } : observed;
    const report = JSON.stringify(view, null, 2) + '\n';
    if (out) {
      writeCaptureReport(out, report);
      console.error('Wrote capture replay report');
    } else process.stdout.write(report);
  }
} catch (error) {
  console.error('A2UI capture replay failed: ' + error.message);
  process.exitCode = 1;
}
