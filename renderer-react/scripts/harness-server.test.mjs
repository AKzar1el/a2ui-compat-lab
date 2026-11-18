import assert from 'node:assert/strict';
import {request} from 'node:http';
import {startHarnessServer} from './harness-server.mjs';

const server = await startHarnessServer();
const origin = new URL(server.origin);
const probe = (path, {method = 'GET', host = origin.host} = {}) => new Promise((resolve, reject) => {
  const req = request({
    hostname: '127.0.0.1',
    port: origin.port,
    path,
    method,
    headers: {host},
    timeout: 5000,
  }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({
      status: response.statusCode,
      headers: response.headers,
      body: Buffer.concat(chunks),
    }));
    response.on('error', reject);
  });
  req.on('timeout', () => req.destroy(new Error('Loopback request timed out')));
  req.on('error', reject);
  req.end();
});

try {
  assert.equal(origin.hostname, '127.0.0.1');
  assert.ok(Number(origin.port) > 0);
  const html = await probe('/');
  assert.equal(html.status, 200);
  assert.match(html.body.toString('utf8'), /src="\/bundle.js"/);
  assert.equal(html.headers['cache-control'], 'no-store');
  assert.equal(html.headers['x-content-type-options'], 'nosniff');

  const bundle = await probe('/bundle.js');
  assert.equal(bundle.status, 200);
  assert.ok(bundle.body.length > 1000);
  assert.match(bundle.headers['content-type'], /^text\/javascript/);
  assert.equal((await probe('/bundle.js', {method: 'HEAD'})).body.length, 0);

  assert.equal((await probe('/src/main.jsx')).status, 404);
  assert.equal((await probe('/%2e%2e%2fprivate')).status, 404);
  assert.equal((await probe('/favicon.ico')).status, 204);
  assert.equal((await probe('/bundle.js', {method: 'POST'})).status, 405);
  assert.equal((await probe('/bundle.js', {host: 'malicious.example'})).status, 403);
  assert.equal((await probe('/bundle.js', {host: 'localhost:' + origin.port})).status, 403);
  console.log('A2UI offline esbuild loopback server and request isolation: PASS');
} finally {
  await server.close();
}
