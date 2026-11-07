import {defineConfig} from 'vite';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  server: {
    host: '127.0.0.1',
    strictPort: true,
    port: 4179,
    fs: {allow: [root, resolve(root, '..')]},
  },
});
