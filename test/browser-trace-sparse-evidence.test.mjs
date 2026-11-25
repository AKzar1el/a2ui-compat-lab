import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareBrowserTraces} from '../src/browser-trace-compare.mjs';

function trace() {
  return {
    schemaVersion: 1, protocol: 'v0.9', passed: true,
    harness: 'synthetic browser trace', fixtureSha256: 'a'.repeat(64),
    versions: {'@a2ui/react': '0.14.0'},
    checkpoints: [{step: 'render'}],
    actions: [], runtimeErrors: [], consoleErrors: [], accessibilityFindings: [],
  };
}

test('complete dense traces still match', () => {
  assert.equal(compareBrowserTraces(trace(), trace()).ok, true);
});

for (const field of ['actions', 'checkpoints', 'accessibilityFindings']) {
  test(`sparse ${field} cannot be treated as matching evidence`, () => {
    const incomplete = trace();
    incomplete[field] = Array(1);
    assert.throws(() => compareBrowserTraces(incomplete, incomplete),
      /Invalid before browser trace schema/);
    assert.throws(() => compareBrowserTraces(trace(), incomplete),
      /Invalid after browser trace schema/);
  });
}
