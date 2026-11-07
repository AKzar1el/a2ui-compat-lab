#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {parseJsonLines, replayV09} from './replay.mjs';

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_FRAMES = 10000;
const USAGE = 'Usage: node src/replay-file.mjs --input capture.jsonl [--out report.json]';

// This CLI handles local captures only: never fetch, upload or run supplied code.
function options(argv) {
  if (argv.length === 1 && argv[0] === '--help') return {help: true};
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const next = argv[i + 1];
    if ((key !== '--input' && key !== '--out') || !next || next.startsWith('--') || result[key])
      throw new Error(USAGE);
    result[key] = next;
  }
  if (!result['--input']) throw new Error(USAGE);
  return {input: resolve(result['--input']), out: result['--out'] ? resolve(result['--out']) : null};
}

function replayCapture(raw) {
  if (raw.length === 0 || raw.length > MAX_INPUT_BYTES)
    throw new RangeError('Capture must be 1 byte to 4 MiB');
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
  const text = new TextDecoder('utf-8', {fatal: true}).decode(raw);
  const messages = parseJsonLines([text], {maxLineBytes: MAX_LINE_BYTES});
  if (!messages.length) throw new SyntaxError('Capture has no A2UI messages');
  const replay = replayV09(messages);
  return {
    schemaVersion: 1,
    protocol: 'v0.9',
    implementation: '@a2ui/web_core@0.15.0 MessageProcessor',
    note: 'Real SDK headless replay; not browser rendering or conformance certification',
    captureSha256: createHash('sha256').update(raw).digest('hex'),
    captureBytes: raw.length,
    events: messages.length,
    replay,
  };
}

try {
  const {input, out, help} = options(process.argv.slice(2));
  if (help) {
    console.log(USAGE);
  } else {
    const metadata = statSync(input);
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_INPUT_BYTES)
      throw new RangeError('Capture must be a regular file of 1 byte to 4 MiB');
    const report = JSON.stringify(replayCapture(readFileSync(input)), null, 2) + '\n';
    if (out) {
      mkdirSync(dirname(out), {recursive: true});
      // Fail closed on an existing report instead of silently leaving stale evidence.
      writeFileSync(out, report, {flag: 'wx'});
      console.error('Wrote ' + out);
    } else process.stdout.write(report);
  }
} catch (error) {
  console.error('A2UI capture replay failed: ' + error.message);
  process.exitCode = 1;
}
