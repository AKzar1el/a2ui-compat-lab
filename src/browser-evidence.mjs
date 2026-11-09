import {createHash} from 'node:crypto';
import {lstatSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

const usage = 'Usage: npm test -- [--out-dir NEW_DIRECTORY_NAME]';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_BYTES = 32 * 1024 * 1024;

/** Keep browser artifacts in a new, predictable directory inside renderer-react. */
export function resolveBrowserEvidenceDir(root, args) {
  if (args.length === 0) return resolve(root, 'out');
  if (args.length !== 2 || args[0] !== '--out-dir' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(args[1]))
    throw new Error(usage);
  return resolve(root, args[1]);
}

export function assertBrowserEvidenceUnused(outputDir) {
  try {
    lstatSync(outputDir); // lstat also detects a pre-existing symlink.
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Browser evidence directory already exists; use --out-dir with a fresh name: ' + outputDir);
}

/** Publish only an entirely successful browser replay; never clobber prior evidence. */
export function publishBrowserEvidence(outputDir, screenshot, report) {
  // Preflight the same digest checked by the offline comparison CLI. Never
  // publish a successful report paired with missing, corrupt or mismatched PNG evidence.
  if (!Buffer.isBuffer(screenshot) || screenshot.length < PNG_SIGNATURE.length ||
      screenshot.length > MAX_PNG_BYTES ||
      !screenshot.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
      report?.passed !== true ||
      typeof report.screenshotSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(report.screenshotSha256) ||
      createHash('sha256').update(screenshot).digest('hex') !== report.screenshotSha256.toLowerCase())
    throw new Error('Browser evidence requires a passing replay, valid PNG and matching SHA-256');
  let traceJson;
  try {
    // Serialize before creating output directories so invalid reports leave no artifact.
    traceJson = JSON.stringify(report, null, 2) + '\n';
  } catch {
    throw new Error('Browser evidence report is not JSON-serializable');
  }
  assertBrowserEvidenceUnused(outputDir);
  mkdirSync(dirname(outputDir), {recursive: true});
  try {
    // Exclusive directory creation prevents overwrites even if another run raced preflight.
    mkdirSync(outputDir);
  } catch (error) {
    if (error?.code === 'EEXIST') assertBrowserEvidenceUnused(outputDir);
    throw error;
  }
  const screenshotPath = resolve(outputDir, 'react-browser.png');
  const tracePath = resolve(outputDir, 'react-browser-trace.json');
  writeFileSync(screenshotPath, screenshot, {flag: 'wx'});
  writeFileSync(tracePath, traceJson, {flag: 'wx'});
  return {screenshotPath, tracePath};
}
