import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

/** Emit deterministic local fixture evidence without clobbering an older run. */
export function emitReplayReport(report, args, usage) {
  if (args.length === 0) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  if (args.length !== 2 || args[0] !== '--out' ||
      !args[1] || args[1].startsWith('--'))
    throw new Error(usage);
  const output = resolve(args[1]);
  try {
    mkdirSync(dirname(output), {recursive: true});
  } catch {
    throw new Error('Cannot prepare replay report directory; path omitted');
  }
  try {
    // Atomic exclusive creation rejects existing evidence and symlink targets.
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  } catch (error) {
    if (error?.code === 'EEXIST')
      throw new Error('Replay report already exists; choose a new --out path');
    throw new Error('Cannot write replay report; path omitted');
  }
  console.error('Wrote replay report');
}
