import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  resolveBrowserEvidenceDir, assertBrowserEvidenceUnused, publishBrowserEvidence,
} from '../src/browser-evidence.mjs';

test('browser evidence output names reject ambiguous and escaping CLI arguments', () => {
  const root = join(tmpdir(), 'a2ui-browser-root');
  assert.equal(resolveBrowserEvidenceDir(root, []), join(root, 'out'));
  assert.equal(resolveBrowserEvidenceDir(root, ['--out-dir', 'run-2']), join(root, 'run-2'));
  for (const args of [
    ['--out-dir'], ['--unknown'], ['--out-dir', '--another'], ['--out-dir', '.'],
    ['--out-dir', '..'], ['--out-dir', '../outside'], ['--out-dir', 'a/b'],
    ['--out-dir', 'C:\\external'], ['--out-dir', 'run', 'extra'],
  ]) assert.throws(() => resolveBrowserEvidenceDir(root, args), /Usage:/);
});

test('successful browser evidence is exclusive and preserves older artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'a2ui-browser-output-'));
  try {
    const target = join(root, 'out');
    const screenshot = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
      'base64');
    const report = {schemaVersion: 1, passed: true,
      screenshotSha256: createHash('sha256').update(screenshot).digest('hex'),
      actions: [{name: 'confirm'}]};
    assertBrowserEvidenceUnused(target);
    assert.throws(() => publishBrowserEvidence(join(root, 'not-published'),
      Buffer.alloc(0), report), /valid PNG/);
    assert.throws(() => publishBrowserEvidence(join(root, 'failed-run'),
      screenshot, {passed: false}), /passing replay/);
    assert.equal(existsSync(join(root, 'failed-run')), false);

    const first = publishBrowserEvidence(target, screenshot, report);
    assert.deepEqual(readFileSync(first.screenshotPath), screenshot);
    assert.deepEqual(JSON.parse(readFileSync(first.tracePath, 'utf8')), report);
    assert.throws(() => assertBrowserEvidenceUnused(target), /already exists/);
    const changedScreenshot = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
    const changedReport = {...report,
      screenshotSha256: createHash('sha256').update(changedScreenshot).digest('hex')};
    assert.throws(() => publishBrowserEvidence(target, changedScreenshot, changedReport),
      /already exists/);
    assert.deepEqual(readFileSync(first.screenshotPath), screenshot);
    assert.deepEqual(JSON.parse(readFileSync(first.tracePath, 'utf8')), report);

    const second = publishBrowserEvidence(join(root, 'run-2'), screenshot, report);
    assert.equal(existsSync(second.tracePath), true);
    assert.deepEqual(readFileSync(first.screenshotPath), screenshot);
    mkdirSync(join(root, 'reserved'));
    writeFileSync(join(root, 'reserved', 'user.txt'), 'keep');
    assert.throws(() => publishBrowserEvidence(join(root, 'reserved'), screenshot, report),
      /already exists/);
    assert.equal(readFileSync(join(root, 'reserved', 'user.txt'), 'utf8'), 'keep');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('browser evidence filesystem failures redact private paths and never overwrite user files', () => {
  const root = mkdtempSync(join(tmpdir(), 'a2ui-browser-private-'));
  try {
    const screenshot = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
      'base64');
    const report = {passed: true,
      screenshotSha256: createHash('sha256').update(screenshot).digest('hex')};
    const expectRedacted = (operation, diagnostic) => {
      assert.throws(operation, error => {
        assert.match(error.message, diagnostic);
        assert.equal(error.message.includes(root), false, 'No absolute path may leak');
        assert.equal(error.message.includes('private-'), false, 'No private name may leak');
        return true;
      });
    };

    const existing = join(root, 'private-existing-output');
    mkdirSync(existing);
    writeFileSync(join(existing, 'important.txt'), 'keep');
    expectRedacted(() => assertBrowserEvidenceUnused(existing), /already exists/);
    expectRedacted(() => publishBrowserEvidence(existing, screenshot, report),
      /already exists/);
    assert.equal(readFileSync(join(existing, 'important.txt'), 'utf8'), 'keep');

    // ENOTDIR is a native path-bearing error, unlike the ordinary ENOENT case.
    const blockedParent = join(root, 'private-ancestor-is-file');
    writeFileSync(blockedParent, 'retain');
    const blocked = join(blockedParent, 'run');
    expectRedacted(() => assertBrowserEvidenceUnused(blocked), /Cannot inspect/);
    expectRedacted(() => publishBrowserEvidence(blocked, screenshot, report),
      /Cannot inspect/);
    assert.equal(readFileSync(blockedParent, 'utf8'), 'retain');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('PNG and digest preflight refuses invalid evidence without creating output paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'a2ui-png-preflight-'));
  try {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
      'base64');
    const digest = createHash('sha256').update(png).digest('hex');
    const valid = {schemaVersion: 1, passed: true, screenshotSha256: digest};
    const digestFor = bytes => createHash('sha256').update(bytes).digest('hex');
    const badCrc = Buffer.from(png);
    badCrc[44] ^= 1; // Tamper with IDAT while matching the forged digest.
    const trailing = Buffer.concat([png, Buffer.from('trailing')]);
    // A valid chunk CRC and SHA are insufficient if IDAT is not a PNG image.
    // Mutate the known 1x1 RGBA fixture, rebuilding IDAT with a correct CRC.
    const crc32 = bytes => {
      let crc = 0xffffffff;
      for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
          crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
      return (crc ^ 0xffffffff) >>> 0;
    };
    const replaceIdat = data => {
      const offset = 33; // IHDR is always 13 bytes in this fixture.
      assert.equal(png.toString('ascii', offset + 4, offset + 8), 'IDAT');
      const previousLength = png.readUInt32BE(offset);
      const chunk = Buffer.alloc(12 + data.length);
      chunk.writeUInt32BE(data.length, 0);
      chunk.write('IDAT', 4, 'ascii');
      data.copy(chunk, 8);
      chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)),
        8 + data.length);
      return Buffer.concat([png.subarray(0, offset), chunk,
        png.subarray(offset + 12 + previousLength)]);
    };
    const makeChunk = (type, data) => {
      const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const result = Buffer.alloc(body.length + 8);
      result.writeUInt32BE(data.length, 0);
      body.copy(result, 4);
      result.writeUInt32BE(crc32(body), body.length + 4);
      return result;
    };
    const indexedHeader = Buffer.from(png.subarray(16, 29));
    indexedHeader[9] = 3; // Indexed-color instead of RGBA.
    const palette = makeChunk('PLTE', Buffer.from([0, 0, 0]));
    const indexedData = makeChunk('IDAT', deflateSync(Buffer.from([0, 0])));
    const indexedEnd = makeChunk('IEND', Buffer.alloc(0));
    const indexedImage = (before = [], after = []) => Buffer.concat([
      png.subarray(0, 8), makeChunk('IHDR', indexedHeader),
      ...before, indexedData, ...after, indexedEnd,
    ]);
    const validIndexed = indexedImage([palette]);
    const indexedMissingPalette = indexedImage();
    const indexedShortPalette = indexedImage([makeChunk('PLTE', Buffer.from([0, 0]))]);
    const indexedDuplicatePalette = indexedImage([palette, palette]);
    const indexedLatePalette = indexedImage([], [palette]);
    const invalidZlib = replaceIdat(Buffer.alloc(13));
    const invalidFilter = replaceIdat(deflateSync(Buffer.from([7, 0, 0, 0, 0])));
    const shortScanline = replaceIdat(deflateSync(Buffer.from([0, 0])));
    const cases = [
      ['signature-only', png.subarray(0, 8),
        {...valid, screenshotSha256: digestFor(png.subarray(0, 8))}, /valid PNG/],
      ['truncated-iend', png.subarray(0, -5),
        {...valid, screenshotSha256: digestFor(png.subarray(0, -5))}, /valid PNG/],
      ['invalid-idat-crc', badCrc,
        {...valid, screenshotSha256: digestFor(badCrc)}, /valid PNG/],
      ['trailing-bytes', trailing,
        {...valid, screenshotSha256: digestFor(trailing)}, /valid PNG/],
      ['invalid-idat-zlib-with-valid-crc', invalidZlib,
        {...valid, screenshotSha256: digestFor(invalidZlib)}, /valid PNG/],
      ['invalid-row-filter-with-valid-crc', invalidFilter,
        {...valid, screenshotSha256: digestFor(invalidFilter)}, /valid PNG/],
      ['short-inflated-scanline-with-valid-crc', shortScanline,
        {...valid, screenshotSha256: digestFor(shortScanline)}, /valid PNG/],
      ['indexed-missing-required-palette', indexedMissingPalette,
        {...valid, screenshotSha256: digestFor(indexedMissingPalette)}, /valid PNG/],
      ['indexed-incomplete-palette-triple', indexedShortPalette,
        {...valid, screenshotSha256: digestFor(indexedShortPalette)}, /valid PNG/],
      ['indexed-duplicate-palette', indexedDuplicatePalette,
        {...valid, screenshotSha256: digestFor(indexedDuplicatePalette)}, /valid PNG/],
      ['indexed-palette-after-idat', indexedLatePalette,
        {...valid, screenshotSha256: digestFor(indexedLatePalette)}, /valid PNG/],
      ['invalid-png', Buffer.from('not-a-png'), valid, /valid PNG/],
      ['wrong-digest', png, {...valid, screenshotSha256: '0'.repeat(64)}, /matching SHA-256/],
      ['missing-digest', png, {schemaVersion: 1, passed: true}, /matching SHA-256/],
      ['malformed-digest', png, {...valid, screenshotSha256: 'private-value'}, /matching SHA-256/],
      ['failed-replay', png, {...valid, passed: false}, /passing replay/],
    ];
    for (const [name, screenshot, report, error] of cases) {
      const output = join(root, name);
      assert.throws(() => publishBrowserEvidence(output, screenshot, report), error);
      assert.equal(existsSync(output), false, name + ' must not publish partial evidence');
    }

    const circular = {...valid};
    circular.self = circular;
    const path = join(root, 'not-serializable');
    assert.throws(() => publishBrowserEvidence(path, png, circular), /not JSON-serializable/);
    assert.equal(existsSync(path), false, 'Serialization failure must happen before mkdir');

    const validIndexedReport = {...valid, screenshotSha256: digestFor(validIndexed)};
    const indexedPublished = publishBrowserEvidence(join(root, 'indexed-valid'),
      validIndexed, validIndexedReport);
    assert.deepEqual(readFileSync(indexedPublished.screenshotPath), validIndexed);

    const upper = {...valid, screenshotSha256: digest.toUpperCase()};
    const created = publishBrowserEvidence(join(root, 'uppercase-digest'), png, upper);
    assert.deepEqual(readFileSync(created.screenshotPath), png);
    assert.equal(JSON.parse(readFileSync(created.tracePath, 'utf8')).screenshotSha256,
      digest.toUpperCase());
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
