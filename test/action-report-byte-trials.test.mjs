import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareActionReports} from '../src/action-report-compare.mjs';

// Minimal synthetic saved action report; no SDK or browser dependency needed.
function savedReport() {
  const snapshot = {surfaceId: 'surface', exists: true,
    components: ['button'], data: null};
  return {
    schemaVersion: 1, protocol: 'v0.9', implementation: '@a2ui/web_core@0.15.0',
    fixtureSha256: 'a'.repeat(64), steps: 2, actionCount: 1, allMatch: true,
    chunkTrials: [{chunkSize: 1, chunks: 20, matches: true}],
    byteChunkTrials: [{chunkSizeBytes: 1, chunks: 24, matches: true}],
    trace: {protocol: 'v0.9', snapshots: [
      {...snapshot, index: 0, kind: 'message', actionCount: 0},
      {...snapshot, index: 1, kind: 'tap', componentId: 'button', actionCount: 1},
    ], actions: [{name: 'select', surfaceId: 'surface',
      sourceComponentId: 'button', context: {}}]},
  };
}

test('failed UTF-8 byte trials cannot contradict allMatch in either saved report', () => {
  const valid = savedReport();
  const invalid = structuredClone(valid);
  invalid.byteChunkTrials[0].matches = false;
  for (const [before, after] of [[valid, invalid], [invalid, valid], [invalid, invalid]]) {
    assert.throws(() => compareActionReports(before, after), /incomplete or inconsistent action evidence/);
  }
});

test('present byte trial evidence must be a nonempty list of passing trials', () => {
  for (const trials of [null, {}, [], [null], [{matches: 'true'}], Array(1)]) {
    const invalid = savedReport();
    invalid.byteChunkTrials = trials;
    assert.throws(() => compareActionReports(invalid, invalid), /incomplete or inconsistent action evidence/);
  }
});

test('passing byte trials and legacy reports without byte trials still compare', () => {
  const modern = savedReport();
  const legacy = structuredClone(modern);
  delete legacy.byteChunkTrials;
  assert.equal(compareActionReports(modern, structuredClone(modern)).ok, true);
  assert.equal(compareActionReports(legacy, structuredClone(legacy)).ok, true);
  assert.equal(compareActionReports(legacy, modern).ok, true);
});
