import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {Catalog} from '@a2ui/web_core/catalog';

const fixturesPath = new URL('../fixtures/catalog-cases.json', import.meta.url);
const baselinePath = new URL('../baselines/expected.json', import.meta.url);

function installedPackageVersion(entrypoint, name) {
  // Resolve public code first: packages may not export package.json directly.
  let dir = dirname(fileURLToPath(import.meta.resolve(entrypoint)));
  for (let i = 0; i < 12; i++) {
    const path = join(dir, 'package.json');
    if (existsSync(path)) {
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      if (manifest.name === name && typeof manifest.version === 'string')
        return manifest.version;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Cannot identify the installed ' + name + ' version');
}

export function getCases() {
  const cases = JSON.parse(readFileSync(fixturesPath, 'utf8'));
  if (!Array.isArray(cases)) throw new Error('Fixture file must be an array');
  const ids = new Set();
  for (const item of cases) {
    if (!Array.isArray(item) || item.length !== 3) throw new Error('Each fixture must be [id, schema, value]');
    if (typeof item[0] !== 'string' || ids.has(item[0])) throw new Error('Fixture names must be unique strings');
    ids.add(item[0]);
  }
  return cases;
}

export function getBaseline() {
  return JSON.parse(readFileSync(baselinePath, 'utf8'));
}

export function evaluate(cases = getCases()) {
  // Explicitly disable format assertions: Draft 2020-12 treats this as an optional vocabulary.
  const ajv = new Ajv2020({strict: false, validateFormats: false, allErrors: true, removeAdditional: false, coerceTypes: false, useDefaults: false});
  const baseline = getBaseline();
  const known = new Set(baseline.knownUpstreamDisagreements);
  const additional = new Set(baseline.additionalDisagreements);
  const formatDependent = new Set(baseline.formatDependentExcluded);
  const rows = [];
  for (const [id, schema, value] of cases) {
    const reference = ajv.compile(schema);
    const referenceValid = Boolean(reference(structuredClone(value)));
    // Exercise the real published A2UI public API, not a reimplementation of its converter.
    const catalog = Catalog.fromJson({
      catalogId: 'https://example.com/a2ui-compat-lab-catalog',
      protocolVersion: '1.0',
      components: {},
      functions: [{name: 'check', parameters: schema, returnType: 'string'}],
    });
    const fn = catalog.functions.get('check');
    if (!fn) throw new Error('A2UI catalog did not load the test function: ' + id);
    const webCoreValid = fn.schema.safeParse(structuredClone(value)).success;
    rows.push({
      id,
      referenceValid,
      webCoreValid,
      divergent: referenceValid !== webCoreValid,
      category: known.has(id) ? 'reported-upstream' : additional.has(id) ? 'additional' : formatDependent.has(id) ? 'format-opt-in' : 'control',
    });
  }
  const divergences = rows.filter(row => row.divergent).map(row => row.id).sort();
  return {
    reportVersion: 1,
    implementations: {webCore: installedPackageVersion('@a2ui/web_core/catalog', '@a2ui/web_core'),
      reference: 'Ajv ' + installedPackageVersion('ajv/dist/2020.js', 'ajv') + ' / JSON Schema Draft 2020-12, format assertions off'},
    fixtureCount: rows.length,
    divergenceCount: divergences.length,
    divergenceIds: divergences,
    rows,
  };
}

export function checkBaseline(report, baseline = getBaseline()) {
  const expected = [...baseline.knownUpstreamDisagreements, ...baseline.additionalDisagreements].sort();
  const actual = [...report.divergenceIds].sort();
  const observedWebCoreVersion = report.implementations?.webCore ?? null;
  const ok = report.fixtureCount === baseline.cases && JSON.stringify(actual) === JSON.stringify(expected) &&
    observedWebCoreVersion === baseline.webCoreVersion;
  return {
    ok,
    expectedWebCoreVersion: baseline.webCoreVersion,
    observedWebCoreVersion,
    expectedCount: baseline.cases,
    observedCount: report.fixtureCount,
    expectedDiscrepancies: expected,
    observedDiscrepancies: actual,
    newlyObserved: actual.filter(id => !expected.includes(id)),
    resolvedSinceBaseline: expected.filter(id => !actual.includes(id)),
  };
}
