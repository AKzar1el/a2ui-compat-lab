/** Compare two observed scan reports without changing the pinned baseline. */
export function compareScans(before, after) {
  const oldRows = validateScan(before, 'before');
  const newRows = validateScan(after, 'after');
  const ids = [...new Set([...oldRows.keys(), ...newRows.keys()])].sort();
  const resolved = [], newlyObserved = [], persistent = [], directionChanged = [];
  const referenceChanged = [], decisionChanged = [], addedFixtures = [], removedFixtures = [];
  let stableControls = 0;

  for (const id of ids) {
    const previous = oldRows.get(id);
    const current = newRows.get(id);
    if (!previous) { addedFixtures.push(id); continue; }
    if (!current) { removedFixtures.push(id); continue; }
    if (previous.referenceValid !== current.referenceValid) referenceChanged.push(id);
    if (previous.webCoreValid !== current.webCoreValid) decisionChanged.push(id);
    if (previous.divergent && current.divergent) {
      if (previous.referenceValid !== current.referenceValid || previous.webCoreValid !== current.webCoreValid)
        directionChanged.push(id);
      else persistent.push(id);
    } else if (previous.divergent) resolved.push(id);
    else if (current.divergent) newlyObserved.push(id);
    else if (previous.referenceValid === current.referenceValid && previous.webCoreValid === current.webCoreValid)
      stableControls++;
  }

  const referenceImplementationChanged = before.implementations.reference !== after.implementations.reference;
  const ok = !resolved.length && !newlyObserved.length && !directionChanged.length &&
    !referenceChanged.length && !decisionChanged.length && !addedFixtures.length && !removedFixtures.length &&
    !referenceImplementationChanged;
  return {
    reportVersion: 1,
    kind: 'scan-comparison',
    before: before.implementations,
    after: after.implementations,
    comparedFixtures: ids.length - addedFixtures.length - removedFixtures.length,
    stableControls,
    resolved,
    newlyObserved,
    persistent,
    directionChanged,
    referenceChanged,
    referenceImplementationChanged,
    decisionChanged,
    addedFixtures,
    removedFixtures,
    ok,
  };
}

function validateScan(report, label) {
  if (!report || report.reportVersion !== 1 || !Array.isArray(report.rows) ||
      !report.implementations || typeof report.implementations.webCore !== 'string' ||
      typeof report.implementations.reference !== 'string')
    throw new Error(label + ' must be a version-1 A2UI scan report with implementation provenance');
  const rows = new Map();
  for (const row of report.rows) {
    if (!row || typeof row.id !== 'string' || !row.id || rows.has(row.id) ||
        typeof row.referenceValid !== 'boolean' || typeof row.webCoreValid !== 'boolean' ||
        typeof row.divergent !== 'boolean' || row.divergent !== (row.referenceValid !== row.webCoreValid))
      throw new Error(label + ' contains a malformed or duplicate fixture');
    rows.set(row.id, row);
  }
  const observed = [...rows.values()].filter(row => row.divergent).map(row => row.id).sort();
  if (report.fixtureCount !== rows.size || report.divergenceCount !== observed.length ||
      !Array.isArray(report.divergenceIds) ||
      JSON.stringify([...report.divergenceIds].sort()) !== JSON.stringify(observed))
    throw new Error(label + ' has inconsistent fixture or discrepancy totals');
  return rows;
}
