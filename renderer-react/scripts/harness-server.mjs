import {createServer} from 'node:http';
import {bundleHarness} from './build-harness.mjs';

// Only two immutable local assets are served. No filesystem traversal, proxy,
// network dependencies, or process-wide public interface are needed for replay.
export async function startHarnessServer() {
  const assets = await bundleHarness();
  let port;
  const server = createServer((request, response) => {
    if (request.headers.host !== '127.0.0.1:' + port) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, {Allow: 'GET, HEAD'}).end();
      return;
    }
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    const entry = path === '/' ?
      {data: assets.html, type: 'text/html; charset=utf-8'} :
      path === '/bundle.js' ?
        {data: assets.javascript, type: 'text/javascript; charset=utf-8'} : null;
    if (!entry) {
      response.writeHead(path === '/favicon.ico' ? 204 : 404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': entry.type,
      'Content-Length': entry.data.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : entry.data);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string' ||
        address.address !== '127.0.0.1' || !Number.isInteger(address.port)) {
      throw new Error('Harness server must bind an ephemeral IPv4 loopback port');
    }
    port = address.port;
    return {
      origin: 'http://127.0.0.1:' + port,
      close: () => new Promise((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve())),
    };
  } catch (error) {
    server.close();
    throw error;
  }
}
