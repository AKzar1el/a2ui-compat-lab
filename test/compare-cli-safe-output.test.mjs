import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

function scan(id, version) {
  const row = {id, referenceValid: false, webCoreValid: true, divergent: true};
  return {
    reportVersion: 1,
    implementations: {webCore: version, reference: 'Ajv reference'},
    fixtureCount: 1,
    divergenceCount: 1,
    divergenceIds: [id],
    rows: [row],
  };
}

test('human scan comparison output escapes untrusted report lines and controls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-comparison-output-'));
  try {
    const before = join(dir, 'before.json');
    const after = join(dir, 'after.json');
    writeFileSync(before, JSON.stringify(scan(
      'old\n::error title=FORGED_ID::not-a-real-failure\x1b[31m\u202e',
      '0.15.0\n::warning title=FORGED_CORE::not-a-real-warning',
    )));
    writeFileSync(after, JSON.stringify(scan(
      'new\n::notice title=FORGED_ID::not-a-real-notice', '0.16.0',
    )));
    const run = spawnSync(process.execPath,
      [cli, 'compare', '--before', before, '--after', after],
      {encoding: 'utf8', timeout: 5000});
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /A2UI SDK parity comparison/);
    assert.doesNotMatch(run.stdout, /\n::(?:error|warning|notice)\b/,
      'Untrusted report metadata must not become CI workflow commands');
    assert.doesNotMatch(run.stdout, /\x1b|\u202e/,
      'Terminal controls and bidirectional formatting must not be emitted verbatim');
    assert.match(run.stdout, /\\n::warning title=FORGED_CORE/);
    assert.match(run.stdout, /\\n::error title=FORGED_ID/);
    assert.match(run.stdout, /\\u001b\[31m\\u202e/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
