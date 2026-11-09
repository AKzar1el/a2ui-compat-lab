import {lstatSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

const usage = 'Usage: npm test -- [--out-dir NEW_DIRECTORY_NAME]';

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
  if (!Buffer.isBuffer(screenshot) || screenshot.length === 0 || report?.passed !== true)
    throw new Error('Browser evidence requires a non-empty screenshot and a passing replay report');
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
  writeFileSync(tracePath, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  return {screenshotPath, tracePath};
}
