import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {lstatSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

const usage = 'Usage: npm test -- [--out-dir NEW_DIRECTORY_NAME]';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_BYTES = 32 * 1024 * 1024;
const MAX_PNG_RAW_BYTES = 128 * 1024 * 1024;
const PNG_CRITICAL_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);

const PNG_CRC_TABLE = Uint32Array.from({length: 256}, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function chunkCrc32(buffer, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++)
    crc = PNG_CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Bound zlib output and check PNG scanline framing before publishing screenshots.
// This is not a color decoder; the browser still supplies the image bytes.
function pngScanlines(width, height, bitsPerPixel, interlace) {
  const passes = interlace === 0 ? [[0, 0, 1, 1]] : [
    [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
    [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
  ];
  const strides = [];
  let byteCount = 0;
  for (const [x, y, dx, dy] of passes) {
    const columns = Math.max(0, Math.ceil((width - x) / dx));
    const rows = Math.max(0, Math.ceil((height - y) / dy));
    if (!columns || !rows) continue;
    const stride = Math.ceil(columns * bitsPerPixel / 8) + 1;
    const count = stride * rows;
    if (!Number.isSafeInteger(count) || count > MAX_PNG_RAW_BYTES - byteCount)
      return null;
    byteCount += count;
    strides.push({stride, rows});
  }
  return {strides, byteCount};
}

// Validate chunk CRC, bounded IDAT decompression and PNG scanline filter bytes.
// This is intentionally a browser-evidence preflight, not a full PNG decoder.
function hasCompletePng(png) {
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
    return false;
  let offset = PNG_SIGNATURE.length;
  let layout;
  let bitDepth, colorType, sawPalette = false;
  let sawData = false;
  let dataEnded = false;
  const idat = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    if (length > png.length - offset - 12) return false;
    const type = png.toString('ascii', offset + 4, offset + 8);
    // An unknown critical chunk may change pixel interpretation. PNG decoders
    // must not silently ignore it even when the chunk and IDAT CRCs are valid.
    if (!/^[A-Za-z]{4}$/.test(type) ||
        (type[0] >= 'A' && type[0] <= 'Z' && !PNG_CRITICAL_CHUNKS.has(type)))
      return false;
    const dataEnd = offset + 8 + length;
    const after = dataEnd + 4;
    if (chunkCrc32(png, offset + 4, dataEnd) !== png.readUInt32BE(dataEnd))
      return false;
    if (!layout) {
      if (type !== 'IHDR' || length !== 13) return false;
      const width = png.readUInt32BE(offset + 8);
      const height = png.readUInt32BE(offset + 12);
      bitDepth = png[offset + 16];
      colorType = png[offset + 17];
      const channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colorType];
      const depths = {0: [1, 2, 4, 8, 16], 2: [8, 16],
        3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16]}[colorType];
      const interlace = png[offset + 20];
      if (!width || !height || !channels || !depths.includes(bitDepth) ||
          png[offset + 18] !== 0 || png[offset + 19] !== 0 || interlace > 1)
        return false;
      layout = pngScanlines(width, height, channels * bitDepth, interlace);
      if (!layout || layout.byteCount === 0) return false;
    } else if (type === 'IHDR') {
      return false;
    }
    if (type === 'PLTE') {
      // Indexed PNGs require a palette before IDAT. Permitted palette
      // chunks must be unique, bounded and made of complete RGB triples.
      if (sawPalette || sawData || ![2, 3, 6].includes(colorType) ||
          length < 3 || length > 768 || length % 3 !== 0 ||
          (colorType === 3 && length / 3 > (1 << bitDepth))) return false;
      sawPalette = true;
    }
    if (type === 'IDAT') {
      if (dataEnded || (colorType === 3 && !sawPalette)) return false;
      sawData = true;
      idat.push(png.subarray(offset + 8, dataEnd));
    } else if (sawData) {
      dataEnded = true;
    }
    if (type === 'IEND') {
      if (length !== 0 || !sawData || after !== png.length) return false;
      try {
        const raw = inflateSync(Buffer.concat(idat),
          {maxOutputLength: layout.byteCount});
        if (raw.length !== layout.byteCount) return false;
        let position = 0;
        for (const {stride, rows} of layout.strides) {
          for (let row = 0; row < rows; row++, position += stride)
            if (raw[position] > 4) return false;
        }
        return true;
      } catch {
        return false;
      }
    }
    offset = after;
  }
  return false;
}

/** Keep browser artifacts in a new, predictable directory inside renderer-react. */
export function resolveBrowserEvidenceDir(root, args) {
  if (args.length === 0) return resolve(root, 'out');
  if (args.length !== 2 || args[0] !== '--out-dir' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(args[1]))
    throw new Error(usage);
  return resolve(root, args[1]);
}

export function assertBrowserEvidenceUnused(outputDir) {
  try {
    lstatSync(outputDir); // lstat also detects a pre-existing symlink.
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new Error('Cannot inspect browser evidence output directory; path omitted');
  }
  throw new Error('Browser evidence directory already exists; use --out-dir with a fresh name');
}

/** Publish only an entirely successful browser replay; never clobber prior evidence. */
export function publishBrowserEvidence(outputDir, screenshot, report) {
  // Preflight the same digest checked by the offline comparison CLI. Never
  // publish a successful report paired with missing, corrupt or mismatched PNG evidence.
  if (!Buffer.isBuffer(screenshot) || screenshot.length < PNG_SIGNATURE.length ||
      screenshot.length > MAX_PNG_BYTES ||
      !hasCompletePng(screenshot) ||
      report?.passed !== true ||
      typeof report.screenshotSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(report.screenshotSha256) ||
      createHash('sha256').update(screenshot).digest('hex') !== report.screenshotSha256.toLowerCase())
    throw new Error('Browser evidence requires a passing replay, valid PNG and matching SHA-256');
  let traceJson;
  try {
    // Serialize before creating output directories so invalid reports leave no artifact.
    traceJson = JSON.stringify(report, null, 2) + '\n';
  } catch {
    throw new Error('Browser evidence report is not JSON-serializable');
  }
  assertBrowserEvidenceUnused(outputDir);
  try {
    mkdirSync(dirname(outputDir), {recursive: true});
  } catch {
    throw new Error('Cannot prepare browser evidence parent directory; path omitted');
  }
  try {
    // Exclusive directory creation prevents overwrites even if another run raced preflight.
    mkdirSync(outputDir);
  } catch (error) {
    if (error?.code === 'EEXIST')
      throw new Error('Browser evidence directory already exists; use --out-dir with a fresh name');
    throw new Error('Cannot create browser evidence output directory; path omitted');
  }
  const screenshotPath = resolve(outputDir, 'react-browser.png');
  const tracePath = resolve(outputDir, 'react-browser-trace.json');
  try {
    writeFileSync(screenshotPath, screenshot, {flag: 'wx'});
    writeFileSync(tracePath, traceJson, {flag: 'wx'});
  } catch {
    // Keep partial files for postmortem without reporting false publication success.
    throw new Error('Cannot write browser evidence artifacts; path omitted');
  }
  return {screenshotPath, tracePath};
}
