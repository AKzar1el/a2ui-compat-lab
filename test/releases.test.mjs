import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getReleaseCases} from '../src/releases.mjs';

test('published release probes are fixed, isolated and semver-pinned', () => {
  const rows = getReleaseCases();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.id), ['a2ui-react-webcore-0.14', 'a2ui-react-webcore-0.15']);
  assert.deepEqual(rows.map(row => row.expected), ['resolves', 'ERESOLVE']);
  for (const row of rows) {
    assert.ok(row.packages['@a2ui/react']);
    assert.ok(row.packages['@a2ui/web_core']);
    assert.ok(Object.values(row.packages).every(version => /^\d+\.\d+\.\d+$/.test(version)));
  }
});
