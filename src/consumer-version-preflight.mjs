#!/usr/bin/env node
// Offline declaration preflight. This cannot establish that an app's installed
// dependency graph or private capture actually matches the lab's renderer.
import {readFileSync, statSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const MAX_MANIFEST_BYTES = 128 * 1024;
const SDK = ['@a2ui/react', '@a2ui/web_core'];
const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function declaredSpecs(manifest, name) {
  const specs = [];
  for (const section of SECTIONS) {
    if (manifest[section] === undefined) continue;
    if (!isRecord(manifest[section]))
      throw new Error('Invalid dependency section; input contents omitted');
    if (Object.hasOwn(manifest[section], name)) {
      const spec = manifest[section][name];
      specs.push(typeof spec === 'string' ? spec : '');
    }
  }
  return specs;
}

function category(specs) {
  if (!specs.length) return 'missing';
  if (specs.every(spec => spec === '0.14.0')) return 'exact-0.14.0';
  if (specs.some(spec => /^(?:\^|~)?0\.15(?:\.|$)/.test(spec))) return '0.15-family';
  return 'other-or-range';
}

function result(reason, protocol, classifications) {
  const definitions = {
    eligible_declared_pair: [
      true, 'Exact published 0.14.0 declarations and v0.9 protocol match the lab test lane.',
      'Check the installed lockfile and actual captured protocol before interpreting replay results.',
    ],
    protocol_outside_test_lane: [
      false, 'The lab Chromium consumer example validates only explicit v0.9 captures.',
      'Use a separately verified renderer/protocol test lane; do not treat v0.9 CI as v1.0 coverage.',
    ],
    missing_sdk_declaration: [
      false, 'Both A2UI renderer packages must be declared to establish a version-lane match.',
      'Inspect the application lockfile or workspace resolution and select a verified renderer pair.',
    ],
    conflicting_declarations: [
      false, 'A2UI package declarations conflict across dependency sections.',
      'Resolve the application package graph without force or peer-dependency overrides.',
    ],
    sdk_generation_not_tested: [
      false, 'At least one A2UI package targets the 0.15 family, outside this v0.9/0.14 lab lane.',
      'Test with an independently strict-peer-resolved v0.15/v1.0 renderer lane when available.',
    ],
    non_exact_sdk_pin: [
      false, 'A manifest range or alternate version cannot prove the lab-tested exact SDK pair.',
      'Verify installed lockfile resolutions and explicit v0.9 capture provenance.',
    ],
  };
  const [eligible, explanation, nextStep] = definitions[reason];
  return {
    reportVersion: 1,
    eligible,
    reason,
    protocol,
    sdkDeclarations: classifications,
    explanation,
    nextStep,
    limitations: 'Declarations only; no npm resolution, installed-package verification, capture validation, or customer compatibility claim.',
  };
}

export function evaluateManifest(manifest, protocol) {
  if (!isRecord(manifest)) throw new Error('Manifest must be a JSON object; input contents omitted');
  const react = declaredSpecs(manifest, SDK[0]);
  const core = declaredSpecs(manifest, SDK[1]);
  const classifications = {react: category(react), webCore: category(core)};
  let reason;
  if (protocol !== 'v0.9') reason = 'protocol_outside_test_lane';
  else if (!react.length || !core.length) reason = 'missing_sdk_declaration';
  else if ([react, core].some(specs => new Set(specs).size !== 1))
    reason = 'conflicting_declarations';
  else if (react[0] === '0.14.0' && core[0] === '0.14.0')
    reason = 'eligible_declared_pair';
  else if (Object.values(classifications).includes('0.15-family'))
    reason = 'sdk_generation_not_tested';
  else reason = 'non_exact_sdk_pin';
  return result(reason, protocol, classifications);
}

export function readManifest(path) {
  let bytes;
  try {
    const target = resolve(path);
    const stat = statSync(target);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_MANIFEST_BYTES)
      throw new RangeError('Manifest must be a regular JSON file of 1 byte to 128 KiB');
    bytes = readFileSync(target);
  } catch (error) {
    if (error instanceof RangeError) throw error;
    throw new Error('Cannot read manifest; path omitted');
  }
  let data;
  try {
    data = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    throw new Error('Invalid manifest UTF-8; input contents omitted');
  }
  try {
    return JSON.parse(data);
  } catch {
    throw new Error('Invalid manifest JSON; input contents omitted');
  }
}

function parseArgs(argv) {
  let manifest, protocol;
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!['--manifest', '--protocol'].includes(token) || seen.has(token))
      throw new Error('Unknown or duplicate option');
    seen.add(token);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error('Missing option value');
    if (token === '--manifest') manifest = value;
    else protocol = value;
  }
  if (!manifest || !protocol) throw new Error('Usage: --manifest FILE --protocol v0.9');
  return {manifest, protocol};
}

function run() {
  try {
    const {manifest, protocol} = parseArgs(process.argv.slice(2));
    const report = evaluateManifest(readManifest(manifest), protocol);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.eligible ? 0 : 1;
  } catch (error) {
    // Never emit original manifest strings, private paths, or JSON parser excerpts.
    console.error(error.message);
    process.exitCode = 2;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) run();
