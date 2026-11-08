import {isDeepStrictEqual} from 'node:util';

const FIELDS = ['kind','surfaceId','componentId','exists','components','data','actionCount'];
const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);

function validated(report, label) {
  const refuse = reason => { throw Error(label + ': ' + reason); };
  if (!isObject(report) || report.schemaVersion !== 1 || report.protocol !== 'v0.9' ||
      typeof report.implementation !== 'string' || !report.implementation ||
      typeof report.fixtureSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(report.fixtureSha256) ||
      !Number.isSafeInteger(report.steps) || report.steps < 1 || report.steps > 10000)
    refuse('invalid v0.9 published SDK action replay report');
  const t = report.trace;
  if (!isObject(t) || t.protocol !== 'v0.9' ||
      !Array.isArray(t.snapshots) || t.snapshots.length !== report.steps ||
      !Array.isArray(t.actions) || t.actions.length > report.steps ||
      t.actions.some(action => !isObject(action)) ||
      report.actionCount !== t.actions.length ||
      report.allMatch !== true || !Array.isArray(report.chunkTrials) ||
      !report.chunkTrials.length || report.chunkTrials.some(x => !isObject(x) || x.matches !== true))
    refuse('incomplete or inconsistent action evidence');
  let count = 0;
  for (const [i, s] of t.snapshots.entries()) {
    if (!isObject(s) || s.index !== i || !['message','tap'].includes(s.kind) ||
        typeof s.surfaceId !== 'string' || !s.surfaceId ||
        typeof s.exists !== 'boolean' || !Array.isArray(s.components) ||
        s.components.some(id => typeof id !== 'string' || !id) ||
        !Number.isSafeInteger(s.actionCount) ||
        s.actionCount !== count + (s.kind === 'tap' ? 1 : 0) ||
        (s.kind === 'tap' && (!s.exists || typeof s.componentId !== 'string' || !s.componentId)) ||
        (!s.exists && (s.components.length !== 0 || s.data !== null)))
      refuse('malformed action snapshot at index ' + i);
    count = s.actionCount;
  }
  if (count !== t.actions.length) refuse('final action count disagrees with trace');
  return report;
}

/** Compares complete actions including routing/context; exposes only changed indices. */
export function compareActionReports(before, after) {
  const a = validated(before, 'before');
  const b = validated(after, 'after');
  if (a.fixtureSha256 !== b.fixtureSha256 || a.steps !== b.steps)
    throw Error('Action reports were generated from different fixtures; comparison refused');
  const differences = [];
  for (let i = 0; i < a.steps; i++) {
    const fields = FIELDS.filter(field =>
      !isDeepStrictEqual(a.trace.snapshots[i][field], b.trace.snapshots[i][field]));
    if (fields.length) differences.push({index: i, fields});
  }
  const changedActionIndices = [];
  for (let i = 0; i < Math.max(a.trace.actions.length, b.trace.actions.length); i++)
    if (!isDeepStrictEqual(a.trace.actions[i], b.trace.actions[i]))
      changedActionIndices.push(i);
  return {
    schemaVersion: 1, kind: 'a2ui-action-observation-comparison', protocol: 'v0.9',
    fixtureSha256: a.fixtureSha256, steps: a.steps,
    beforeImplementation: a.implementation, afterImplementation: b.implementation,
    differingSteps: differences.length, differences,
    differingActions: changedActionIndices.length, changedActionIndices,
    ok: differences.length === 0 && changedActionIndices.length === 0,
  };
}
