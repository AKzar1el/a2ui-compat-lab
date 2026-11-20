import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function bundleHarness() {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['src/main.jsx'],
    outfile: 'bundle.js',
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    logLevel: 'silent',
    sourcemap: false,
  });
  if (result.outputFiles?.length !== 1 ||
      !result.outputFiles[0].path.endsWith('bundle.js')) {
    throw new Error('Expected one standalone browser bundle');
  }
  const html = await readFile(resolve(root, 'index.html'));
  return {html, javascript: result.outputFiles[0].contents};
}
