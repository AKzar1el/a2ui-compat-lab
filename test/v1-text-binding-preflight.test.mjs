import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as v1 from '@a2ui/web_core/v1_0';
import {inspectV1TextBindings, parseCapture, possibleLegacyTextDirective} from
  '../src/v1-text-binding-preflight.mjs';

const cli = fileURLToPath(new URL('../src/v1-text-binding-preflight.mjs', import.meta.url));
const surface = {version: '1.0', createSurface: {surfaceId: 'PRIVATE-SURFACE', catalogId: 'catalog'}};
const components = texts => ({version: '1.0', updateComponents: {
  surfaceId: 'PRIVATE-SURFACE',
  components: texts.map((text, i) => ({id: 'PRIVATE-TEXT-' + i, component: 'Text', text})),
}});
const model = {version: '1.0', updateDataModel: {
  surfaceId: 'PRIVATE-SURFACE', path: '/', value: {name: 'PRIVATE-ADA'},
}};
const encode = messages => Buffer.from(messages.map(m => JSON.stringify(m)).join('\n') + '\n');

function inTemp(run) {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-v1-preflight-'));
  try { run(dir); } finally { rmSync(dir, {recursive: true, force: true}); }
}
function invoke(input, args = []) {
  const result = spawnSync(process.execPath, [cli, '--input', input, ...args], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

test('v1 local capture flags potential v0.9 Text directives without private values or IDs', () =>
  inTemp(dir => {
    const input = join(dir, 'PRIVATE-CAPTURE.jsonl');
    writeFileSync(input, encode([surface, components([
      {'@path': '/name'},
      {path: '/name'},
      {call: 'formatString', args: {value: 'PRIVATE-' + '$' + '{/name}'}},
      {path: '/name', annotation: 'intentional literal'},
      'ordinary text',
    ]), model]));
    const run = invoke(input);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.kind, 'a2ui-v1-text-binding-migration-preflight');
    assert.equal(report.surfaceMessages, 3);
    assert.equal(report.textComponents, 5);
    assert.equal(report.candidateCount, 2);
    assert.deepEqual(report.candidateKinds, {legacyPathLike: 1, legacyCallLike: 1});
    assert.deepEqual(report.candidateLocations, [
      {lineNumber: 2, componentIndex: 1, kind: 'path'},
      {lineNumber: 2, componentIndex: 2, kind: 'call'},
    ]);
    assert.equal(report.candidateLocationsOmitted, 0);
    assert.equal(report.result, 'review_ambiguous_legacy_shapes');
    assert.match(report.recommendation, /may be intentional/);
    for (const secret of ['PRIVATE-CAPTURE', 'PRIVATE-SURFACE', 'PRIVATE-TEXT', 'PRIVATE-ADA',
      '/name', 'formatString']) {
      assert.equal((run.stdout + run.stderr).includes(secret), false, secret);
    }
    const strict = invoke(input, ['--strict']);
    assert.equal(strict.status, 1, strict.stderr);
    assert.deepEqual(JSON.parse(strict.stdout), report);
    assert.equal(strict.stderr, '');
  }));

test('explicit v1 directives and unrelated literal objects pass the advisory preflight', () => {
  const messages = [surface, components([
    {'@path': '/name'}, {'@call': 'formatString', args: {value: 'Hello'}},
    {path: '/name', extra: 'literal'}, {call: 'hello', foo: true}, 'plain text',
  ]), model];
  const report = inspectV1TextBindings(messages);
  assert.equal(report.candidateCount, 0);
  assert.deepEqual(report.candidateLocations, []);
  assert.equal(report.candidateLocationsOmitted, 0);
  assert.equal(report.result, 'no_legacy_text_shapes_detected');
  assert.deepEqual(parseCapture(encode(messages)), messages);
  assert.equal(possibleLegacyTextDirective({path: '/name'}), 'path');
  assert.equal(possibleLegacyTextDirective({path: 42}), null);
  assert.equal(possibleLegacyTextDirective({call: 'fmt', args: {}}), 'call');
});

test('legacy relative Text paths are candidates without flagging valid ChildList paths', () => {
  const messages = [surface, {version: '1.0', updateComponents: {
    surfaceId: 'PRIVATE-SURFACE',
    components: [
      {id: 'col', component: 'Column', children: {path: '/guests', componentId: 'row'}},
      {id: 'row', component: 'Text', text: {path: 'firstName'}},
      {id: 'absolute', component: 'Text', text: {path: '/label'}},
      {id: 'valid', component: 'Text', text: {'@path': 'firstName'}},
      {id: 'empty', component: 'Text', text: {path: ''}},
    ],
  }}];
  const report = inspectV1TextBindings(messages);
  assert.equal(report.textComponents, 4);
  assert.equal(report.candidateCount, 2);
  assert.deepEqual(report.candidateLocations, [
    {lineNumber: 2, componentIndex: 1, kind: 'path'},
    {lineNumber: 2, componentIndex: 2, kind: 'path'},
  ]);
  assert.equal(possibleLegacyTextDirective({path: 'firstName'}), 'path');
  assert.equal(possibleLegacyTextDirective({path: ''}), null);
});

test('inline createSurface Text bindings get private coordinates and a real v1 SDK control', () =>
  inTemp(dir => {
    const inline = {version: '1.0', createSurface: {
      surfaceId: 'PRIVATE-SURFACE', catalogId: v1.basicCatalog.id,
      dataModel: {name: 'PRIVATE-ADA'},
      components: [
        {id: 'root', component: 'Text', text: {path: '/PRIVATE-NAME'}},
        {id: 'other', component: 'Text', text: {call: 'PRIVATE-FORMAT', args: {}}},
        {id: 'safe', component: 'Text', text: {'@path': '/PRIVATE-NAME'}},
      ],
    }};
    const capture = [surface, inline, components([{call: 'PRIVATE-FORMAT', args: {}}])];
    const report = inspectV1TextBindings(capture);
    assert.equal(report.surfaceMessages, 3);
    assert.equal(report.textComponents, 4);
    assert.equal(report.candidateCount, 3);
    assert.deepEqual(report.candidateKinds, {legacyPathLike: 1, legacyCallLike: 2});
    assert.deepEqual(report.candidateLocations, [
      {lineNumber: 2, componentIndex: 0, kind: 'path'},
      {lineNumber: 2, componentIndex: 1, kind: 'call'},
      {lineNumber: 3, componentIndex: 0, kind: 'call'},
    ]);
    assert.equal(report.candidateLocationsOmitted, 0);
    const input = join(dir, 'PRIVATE-INLINE.jsonl');
    writeFileSync(input, encode(capture));
    const strict = invoke(input, ['--strict']);
    assert.equal(strict.status, 1, strict.stderr);
    assert.deepEqual(JSON.parse(strict.stdout), report);
    assert.doesNotMatch(strict.stdout + strict.stderr, /PRIVATE-/);

    const processor = new v1.MessageProcessor([v1.basicCatalog], undefined, {
      validationConfig: v1.STRICT_VALIDATION,
    });
    try {
      processor.processMessages([{version: '1.0', createSurface: {
        surfaceId: 's', catalogId: v1.basicCatalog.id,
        components: [
          {id: 'root', component: 'Column', children: ['absolute', 'relative']},
          {id: 'absolute', component: 'Text', text: {path: '/name'}},
          {id: 'relative', component: 'Text', text: {path: 'name'}},
        ],
        dataModel: {name: 'Ada'},
      }}]);
      const state = processor.model.getSurface('s');
      const property = state.componentsModel.get('absolute').properties.text;
      assert.deepEqual(new v1.DataContext(state, '/').resolveDynamicValue(property),
        {path: '/name'});
      const relative = state.componentsModel.get('relative').properties.text;
      assert.deepEqual(new v1.DataContext(state, '/').resolveDynamicValue(relative),
        {path: 'name'});
    } finally {
      processor.model.dispose();
      processor.dispose();
    }
    assert.equal(inspectV1TextBindings([surface]).candidateCount, 0);
    assert.throws(() => inspectV1TextBindings([
      {version: '1.0', createSurface: {components: 'PRIVATE-INVALID'}},
    ]), /Unsupported v1.0 component list/);
  }));

test('candidate coordinates are bounded and contain only local structural indices', () => {
  const texts = Array.from({length: 36}, (_, i) =>
    i % 2 ? {call: 'PRIVATE-FORMAT', args: {}} : {path: '/PRIVATE-NAME'});
  const report = inspectV1TextBindings([surface, components(texts), model]);
  assert.equal(report.candidateCount, 36);
  assert.deepEqual(report.candidateKinds, {legacyPathLike: 18, legacyCallLike: 18});
  assert.equal(report.candidateLocations.length, 32);
  assert.equal(report.candidateLocationsOmitted, 4);
  assert.deepEqual(report.candidateLocations[0],
    {lineNumber: 2, componentIndex: 0, kind: 'path'});
  assert.deepEqual(report.candidateLocations[31],
    {lineNumber: 2, componentIndex: 31, kind: 'call'});
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('PRIVATE-'), false);
  assert.deepEqual(new Set(report.candidateLocations.map(location =>
    Object.keys(location).join(','))), new Set(['lineNumber,componentIndex,kind']));
});

test('invalid, mixed-generation, oversized and malformed local input fail without leaks', () =>
  inTemp(dir => {
    const input = join(dir, 'PRIVATE-INPUT.jsonl');
    const invalid = [
      Buffer.from([0xff, 0x0a]),
      Buffer.from('{"secret":"PRIVATE-SECRET"'),
      encode([{version: 'v0.9', updateComponents: {components: []}}]),
      encode([{version: '1.0', updateComponents: {components: 'PRIVATE-SECRET'}}]),
      encode([surface, {version: '1.0', updateDataModel: {}, deleteSurface: {}}]),
      Buffer.from(' '.repeat(128 * 1024 + 1) + '\n'),
      Buffer.from('{}\n'.repeat(1001)),
      Buffer.alloc(1024 * 1024 + 1, 0x0a),
    ];
    for (const content of invalid) {
      writeFileSync(input, content);
      const result = invoke(input);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /contents omitted|path omitted/);
      assert.doesNotMatch(result.stderr, /PRIVATE-|a2ui-v1-preflight-/);
    }
    const badFlags = spawnSync(process.execPath, [cli, '--strict', '--strict'], {
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(badFlags.status, 2);
    assert.match(badFlags.stderr, /Usage:/);
  }));

test('the actual pinned published v1 core treats old path as literal, not as binding', () => {
  function resolveText(text) {
    const processor = new v1.MessageProcessor([v1.basicCatalog], undefined, {
      validationConfig: v1.STRICT_VALIDATION,
    });
    try {
      processor.processMessages([
        {version: '1.0', createSurface: {surfaceId: 's', catalogId: v1.basicCatalog.id}},
        {version: '1.0', updateComponents: {surfaceId: 's',
          components: [{id: 'root', component: 'Text', text}]}},
        {version: '1.0', updateDataModel: {surfaceId: 's', path: '/',
          value: {name: 'Ada'}}},
      ]);
      const state = processor.model.getSurface('s');
      const property = state.componentsModel.get('root').properties.text;
      return new v1.DataContext(state, '/').resolveDynamicValue(property);
    } finally {
      processor.model.dispose();
      processor.dispose();
    }
  }
  assert.equal(resolveText({'@path': '/name'}), 'Ada');
  assert.deepEqual(resolveText({path: '/name'}), {path: '/name'});
  const args = {value: 'Hi ' + String.fromCharCode(36) + '{/name}'};
  assert.equal(resolveText({'@call': 'formatString', args}), 'Hi Ada');
  assert.deepEqual(resolveText({call: 'formatString', args}), {call: 'formatString', args});
  assert.equal(possibleLegacyTextDirective({path: '/name'}), 'path');
  assert.equal(possibleLegacyTextDirective({call: 'formatString', args}), 'call');
});


test('opt-in input value scan covers five published components without changing Text-only API', () => {
  const inline = {version: '1.0', createSurface: {
    surfaceId: 'PRIVATE-SURFACE', catalogId: 'catalog',
    components: [
      {id: 'PRIVATE-FIELD', component: 'TextField', value: {path: '/PRIVATE-VALUE'}},
      {id: 'PRIVATE-SAFE', component: 'CheckBox', value: {'@path': '/PRIVATE-VALUE'}},
      {id: 'PRIVATE-COLUMN', component: 'Column',
        children: {path: '/PRIVATE-LIST', componentId: 'PRIVATE-ROW'}},
    ],
  }};
  const update = {version: '1.0', updateComponents: {
    surfaceId: 'PRIVATE-SURFACE',
    components: [
      {id: 'PRIVATE-CHECK', component: 'CheckBox', value: {path: 'enabled'}},
      {id: 'PRIVATE-SLIDER', component: 'Slider', value: {path: '/PRIVATE-VALUE'}},
      {id: 'PRIVATE-PICKER', component: 'ChoicePicker', value: {path: 'choice'}},
      {id: 'PRIVATE-DATE', component: 'DateTimeInput', value: {path: '/date'}},
      {id: 'PRIVATE-TEXT', component: 'Text', text: {call: 'PRIVATE-FMT', args: {}}},
      {id: 'PRIVATE-LITERAL', component: 'TextField',
        value: {path: '/PRIVATE-VALUE', literal: true}},
      {id: 'PRIVATE-EMPTY', component: 'Slider', value: {path: ''}},
      {id: 'PRIVATE-BUTTON', component: 'Button', value: {path: '/PRIVATE-VALUE'}},
    ],
  }};
  const frames = [inline, update];
  const legacy = inspectV1TextBindings(frames);
  assert.equal(legacy.schemaVersion, 1);
  assert.equal(legacy.kind, 'a2ui-v1-text-binding-migration-preflight');
  assert.equal(legacy.candidateCount, 1);
  assert.deepEqual(legacy.candidateKinds, {legacyPathLike: 0, legacyCallLike: 1});
  assert.equal(Object.hasOwn(legacy, 'inputValueCandidateCount'), false);

  const report = inspectV1TextBindings(frames, {includeInputValues: true});
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.kind, 'a2ui-v1-binding-migration-preflight');
  assert.equal(report.textComponents, 1);
  assert.equal(report.textCandidateCount, 1);
  assert.deepEqual(report.textCandidateKinds, {legacyPathLike: 0, legacyCallLike: 1});
  assert.equal(report.inputValueComponents, 8);
  assert.equal(report.inputValueCandidateCount, 5);
  assert.deepEqual(report.inputValueCandidatesByComponent, {
    TextField: 1, CheckBox: 1, Slider: 1, ChoicePicker: 1, DateTimeInput: 1,
  });
  assert.equal(report.candidateCount, 6);
  assert.deepEqual(report.candidateKinds, {legacyPathLike: 5, legacyCallLike: 1});
  assert.deepEqual(report.candidateLocations, [
    {lineNumber: 1, componentIndex: 0, kind: 'inputValuePath'},
    {lineNumber: 2, componentIndex: 0, kind: 'inputValuePath'},
    {lineNumber: 2, componentIndex: 1, kind: 'inputValuePath'},
    {lineNumber: 2, componentIndex: 2, kind: 'inputValuePath'},
    {lineNumber: 2, componentIndex: 3, kind: 'inputValuePath'},
    {lineNumber: 2, componentIndex: 4, kind: 'call'},
  ]);
  const serialized = JSON.stringify(report);
  for (const privateData of ['PRIVATE-', '/date', 'choice', 'enabled']) {
    assert.equal(serialized.includes(privateData), false, privateData);
  }
});

test('opt-in CLI is bounded, privacy-preserving, and strict only for review candidates', () =>
  inTemp(dir => {
    const input = join(dir, 'PRIVATE-INPUT-VALUES.jsonl');
    const frame = {version: '1.0', updateComponents: {
      surfaceId: 'PRIVATE-SURFACE',
      components: Array.from({length: 38}, (_, i) => ({
        id: 'PRIVATE-ID-' + i, component: 'TextField',
        value: {path: 'PRIVATE-RELATIVE-' + i},
      })),
    }};
    writeFileSync(input, encode([surface, frame]));
    const old = invoke(input);
    assert.equal(old.status, 0, old.stderr);
    assert.equal(JSON.parse(old.stdout).candidateCount, 0);
    const run = invoke(input, ['--include-input-values', '--strict']);
    assert.equal(run.status, 1, run.stderr);
    assert.equal(run.stderr, '');
    const report = JSON.parse(run.stdout);
    assert.equal(report.candidateCount, 38);
    assert.equal(report.textCandidateCount, 0);
    assert.equal(report.inputValueCandidateCount, 38);
    assert.equal(report.candidateLocations.length, 32);
    assert.equal(report.candidateLocationsOmitted, 6);
    assert.equal(report.candidateLocations[0].kind, 'inputValuePath');
    assert.equal(report.candidateLocations[31].componentIndex, 31);
    assert.equal((run.stdout + run.stderr).includes('PRIVATE-'), false);
    const relaxed = invoke(input, ['--include-input-values']);
    assert.equal(relaxed.status, 0, relaxed.stderr);
    assert.deepEqual(JSON.parse(relaxed.stdout), report);
  }));

test('published v1 SDK resolves five input @path values while legacy path remains literal', () => {
  const cases = [
    ['TextField', 'Ada'],
    ['CheckBox', true],
    ['Slider', 42],
    ['ChoicePicker', ['red']],
    ['DateTimeInput', '2026-11-23'],
  ];
  function resolveInputValue(type, value, dataValue) {
    const processor = new v1.MessageProcessor([v1.basicCatalog], undefined, {
      validationConfig: v1.STRICT_VALIDATION,
    });
    try {
      processor.processMessages([{version: '1.0', createSurface: {
        surfaceId: 's', catalogId: v1.basicCatalog.id,
        components: [
          {id: 'root', component: 'Column', children: ['input']},
          {id: 'input', component: type, value},
        ],
        dataModel: {value: dataValue},
      }}]);
      const state = processor.model.getSurface('s');
      return new v1.DataContext(state, '/').resolveDynamicValue(
        state.componentsModel.get('input').properties.value);
    } finally {
      processor.model.dispose();
      processor.dispose();
    }
  }
  for (const [type, expected] of cases) {
    assert.deepEqual(resolveInputValue(type, {'@path': '/value'}, expected),
      expected, type + ' @path');
    assert.deepEqual(resolveInputValue(type, {path: '/value'}, expected),
      {path: '/value'}, type + ' legacy path');
  }
});
