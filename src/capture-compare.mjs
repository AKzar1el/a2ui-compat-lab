import {isDeepStrictEqual} from 'node:util';

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 10000;
const FIELDS = ['surfaceId', 'exists', 'components', 'data', 'actionCount'];

function validateCaptureReport(report, label) {
  const fail = reason => { throw new Error(label + ': ' + reason); };
  if (!report || typeof report !== 'object' || Array.isArray(report) ||
      report.schemaVersion !== 1 || report.protocol !== 'v0.9' ||
      typeof report.implementation !== 'string' || !report.implementation)
    fail('expected an A2UI v0.9 capture replay report (schemaVersion 1)');
  if (typeof report.captureSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(report.captureSha256))
    fail('missing or invalid capture SHA-256');
  if (!Number.isSafeInteger(report.captureBytes) || report.captureBytes < 1 ||
      report.captureBytes > MAX_CAPTURE_BYTES)
    fail('invalid capture byte count');
  if (!Number.isSafeInteger(report.events) || report.events < 1 || report.events > MAX_EVENTS)
    fail('invalid event count');
  const replay = report.replay;
  if (!replay || replay.protocol !== 'v0.9' || !Array.isArray(replay.snapshots) ||
      replay.snapshots.length !== report.events ||
      !Number.isSafeInteger(replay.actionCount) || replay.actionCount < 0)
    fail('missing or inconsistent replay state');
  let previousActions = 0;
  for (const [index, snapshot] of replay.snapshots.entries()) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
        snapshot.index !== index ||
        typeof snapshot.surfaceId !== 'string' || !snapshot.surfaceId ||
        typeof snapshot.exists !== 'boolean' ||
        !Object.hasOwn(snapshot, 'data') || snapshot.data === undefined ||
        !Array.isArray(snapshot.components) ||
        snapshot.components.some(id => typeof id !== 'string' || !id) ||
        !Number.isSafeInteger(snapshot.actionCount) ||
        snapshot.actionCount < previousActions || snapshot.actionCount > replay.actionCount)
      fail('malformed replay snapshot at index ' + index);
    if (!snapshot.exists && (snapshot.components.length !== 0 || snapshot.data !== null))
      fail('deleted surface has visible component or data state at index ' + index);
    previousActions = snapshot.actionCount;
  }
  if (previousActions !== replay.actionCount)
    fail('final snapshot action count disagrees with replay total');
  return report;
}

/**
 * Compare two independent observations of the SAME JSONL capture. The report
 * names changed step indices and fields but never emits captured data values.
 */
export function compareCaptureReports(before, after) {
  const previous = validateCaptureReport(before, 'before');
  const current = validateCaptureReport(after, 'after');
  if (previous.captureSha256 !== current.captureSha256 ||
      previous.captureBytes !== current.captureBytes ||
      previous.events !== current.events)
    throw new Error('Reports were generated from different captures; comparison refused');

  const differences = [];
  for (let index = 0; index < previous.events; index++) {
    const a = previous.replay.snapshots[index];
    const b = current.replay.snapshots[index];
    const fields = FIELDS.filter(field => !isDeepStrictEqual(a[field], b[field]));
    if (fields.length) differences.push({index, fields});
  }
  const actionCountChanged = previous.replay.actionCount !== current.replay.actionCount;
  return {
    schemaVersion: 1,
    kind: 'a2ui-capture-observation-comparison',
    protocol: 'v0.9',
    captureSha256: previous.captureSha256,
    events: previous.events,
    beforeImplementation: previous.implementation,
    afterImplementation: current.implementation,
    differingSteps: differences.length,
    differences,
    actionCountChanged,
    ok: differences.length === 0 && !actionCountChanged,
  };
}
