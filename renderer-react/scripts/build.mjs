import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {bundleHarness} from './build-harness.mjs';

const output = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const {html, javascript} = await bundleHarness();
await mkdir(output, {recursive: true});
await Promise.all([
  writeFile(resolve(output, 'index.html'), html),
  writeFile(resolve(output, 'bundle.js'), javascript),
]);
console.log('Standalone A2UI React browser harness built');
