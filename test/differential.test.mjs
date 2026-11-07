import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluate, checkBaseline, getBaseline, getCases} from '../src/differential.mjs';

const report = evaluate();
const check = checkBaseline(report);

test('25 real published A2UI SDK fixtures retain their pinned baseline', () => {
  assert.equal(getCases().length, 25);
  assert.equal(report.fixtureCount, 25);
  assert.equal(report.divergenceCount, 9);
  assert.equal(check.ok, true, JSON.stringify(check));
});

test('additional cross-SDK divergences were reproduced rather than simulated', () => {
  const expected = getBaseline().additionalDisagreements;
  const actual = report.rows.filter(row => row.divergent && row.category === 'additional').map(row => row.id);
  assert.deepEqual(actual.sort(), [...expected].sort());
  const falseAccepts = actual.filter(id => id !== 'new_patternProperties_valid');
  for (const id of falseAccepts) {
    const row = report.rows.find(r => r.id === id);
    assert.equal(row.referenceValid, false, id);
    assert.equal(row.webCoreValid, true, id);
  }
  const rejectedValid = report.rows.find(row => row.id === 'new_patternProperties_valid');
  assert.equal(rejectedValid.referenceValid, true);
  assert.equal(rejectedValid.webCoreValid, false);
});

test('format-dependent differences do not contaminate normative results', () => {
  for (const id of getBaseline().formatDependentExcluded) {
    const row = report.rows.find(x => x.id === id);
    assert.ok(row);
    assert.equal(row.divergent, false, id + ' should not assert formats without enabling their vocabulary');
  }
});

test('reordering fixtures does not change divergence classification', () => {
  const reversed = evaluate([...getCases()].reverse());
  assert.deepEqual(reversed.divergenceIds, report.divergenceIds);
  assert.equal(checkBaseline(reversed).ok, true);
});
