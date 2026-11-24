import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareCaptureReports} from '../src/capture-compare.mjs';

function valid() {
  return {
    schemaVersion: 1, protocol: 'v0.9', implementation: '@a2ui/web_core@0.14.0',
    captureSha256: 'a'.repeat(64), captureBytes: 1, events: 1,
    replay: {protocol: 'v0.9', actionCount: 0,
      snapshots: [{index: 0, surfaceId: 'demo', exists: true,
        components: ['button'], data: {}, actionCount: 0}]},
  };
}
test('valid dense component IDs remain accepted', () => {
  const report = valid();
  assert.equal(compareCaptureReports(report, structuredClone(report)).ok, true);
});
test('missing component IDs must not report a false MATCH', () => {
  const report = valid();
  report.replay.snapshots[0].components = new Array(2);
  report.replay.snapshots[0].components[1] = 'button';
  assert.throws(() => compareCaptureReports(report, structuredClone(report)),
    /malformed replay snapshot/);
});
