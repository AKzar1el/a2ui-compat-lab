import {startHarnessServer} from './harness-server.mjs';

const server = await startHarnessServer();
console.log('A2UI React harness listening at ' + server.origin);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0)).catch(() => process.exit(1));
  });
}
