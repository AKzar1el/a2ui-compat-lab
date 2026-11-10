import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const scripts = [
  'replay-report.mjs',
  'replay-action-report.mjs',
  'recovery-report.mjs',
];

function invoke(script, args) {
  const cli = fileURLToPath(new URL('../src/' + script, import.meta.url));
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

for (const script of scripts) {
  test(script + ' preserves existing evidence and rejects ambiguous output flags', () => {
    const dir = mkdtempSync(join(tmpdir(), 'a2ui-fixture-output-'));
    try {
      const output = join(dir, 'nested', 'report.json');
      const absent = join(dir, 'must-not-exist.json');
      const stdout = invoke(script, []);
      assert.equal(stdout.status, 0, stdout.stderr);
      assert.equal(JSON.parse(stdout.stdout).schemaVersion, 1);

      for (const flags of [
        ['--unknown'], ['--out'], ['--out', '--strict'],
        ['--out', absent, 'extra'], ['--out', absent, '--out', absent],
      ]) {
        const failed = invoke(script, flags);
        assert.equal(failed.status, 1, script + ': ' + failed.stderr);
        assert.equal(failed.stdout, '');
        assert.match(failed.stderr, /Usage:/);
        assert.equal(existsSync(absent), false, 'Bad flags must not publish evidence');
      }

      const first = invoke(script, ['--out', output]);
      assert.equal(first.status, 0, first.stderr);
      assert.equal(first.stdout, '');
      assert.equal(first.stderr.includes(dir), false,
        'Successful writes must not disclose the private report directory');
      assert.match(first.stderr, /Wrote replay report/);
      assert.equal(readFileSync(output, 'utf8'), stdout.stdout,
        'CLI stdout and file output must contain the same published SDK trace');

      const second = invoke(script, ['--out', output]);
      assert.equal(second.status, 1);
      assert.equal(second.stdout, '');
      assert.match(second.stderr, /already exists/);
      assert.equal(second.stderr.includes(dir), false,
        'Existing-output failures must not disclose the private report directory');
      assert.equal(readFileSync(output, 'utf8'), stdout.stdout,
        'A repeated replay must not replace existing evidence');

      const blockedParent = join(dir, 'blocking-file');
      writeFileSync(blockedParent, 'block directory creation');
      const blocked = invoke(script, ['--out', join(blockedParent, 'report.json')]);
      assert.equal(blocked.status, 1);
      assert.equal(blocked.stdout, '');
      assert.equal(blocked.stderr.includes(dir), false,
        'Parent-directory failures must not disclose the private report directory');
      assert.match(blocked.stderr, /Cannot prepare replay report directory/);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
}
