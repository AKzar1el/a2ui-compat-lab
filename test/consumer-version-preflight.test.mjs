import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateManifest, evaluateConsumer} from '../src/consumer-version-preflight.mjs';

const cli = fileURLToPath(new URL('../src/consumer-version-preflight.mjs', import.meta.url));
const realRenderer = fileURLToPath(new URL('../renderer-react/package.json', import.meta.url));
const pinned = {dependencies: {'@a2ui/react': '0.14.0', '@a2ui/web_core': '0.14.0'}};

function invoke(manifest, protocol = 'v0.9') {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-consumer-preflight-'));
  const path = join(dir, 'PRIVATE-PATH-package.json');
  try {
    writeFileSync(path, typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
    return spawnSync(process.execPath, [cli, '--manifest', path, '--protocol', protocol],
      {encoding: 'utf8', timeout: 5000});
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

test('lab real published 0.14 React/core renderer declarations are eligible for v0.9 lane', () => {
  const manifest = JSON.parse(readFileSync(realRenderer, 'utf8'));
  const report = evaluateManifest(manifest, 'v0.9');
  assert.equal(report.reason, 'eligible_declared_pair');
  assert.equal(report.eligible, true);
  assert.equal(report.sdkDeclarations.react, 'exact-0.14.0');
  assert.equal(report.sdkDeclarations.webCore, 'exact-0.14.0');
  assert.match(report.limitations, /Declarations only/);
});

test('Kaltura-style published 0.15 peer ranges are flagged without pretending an upstream defect', () => {
  const manifest = {
    name: 'PRIVATE-CLIENT-SECRET-NAME',
    peerDependencies: {'@a2ui/react': '^0.15.0', '@a2ui/web_core': '^0.15.0'},
    devDependencies: {'@a2ui/react': '^0.15.0', '@a2ui/web_core': '^0.15.0'},
  };
  const run = invoke(manifest);
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.eligible, false);
  assert.equal(report.reason, 'sdk_generation_not_tested');
  assert.deepEqual(report.sdkDeclarations, {react: '0.15-family', webCore: '0.15-family'});
  assert.equal(run.stdout.includes('PRIVATE-CLIENT-SECRET-NAME'), false);
  assert.equal(run.stdout.includes('PRIVATE-PATH'), false);
  assert.equal(run.stderr, '');
});

test('different declared React/core generations require a separate validated lane', () => {
  const report = evaluateManifest({
    dependencies: {'@a2ui/react': '0.14.0', '@a2ui/web_core': '0.15.0'},
  }, 'v0.9');
  assert.equal(report.eligible, false);
  assert.equal(report.reason, 'sdk_generation_not_tested');
});

test('v1.0 capture protocol cannot inherit a v0.9 green check', () => {
  const run = invoke(pinned, 'v1.0');
  assert.equal(run.status, 1, run.stderr);
  assert.equal(JSON.parse(run.stdout).reason, 'protocol_outside_test_lane');
  const privateProtocol = invoke(pinned, 'PRIVATE-PROTOCOL-SECRET');
  assert.equal(privateProtocol.status, 1);
  assert.equal(JSON.parse(privateProtocol.stdout).protocol, 'unverified');
  assert.equal(privateProtocol.stdout.includes('PRIVATE-PROTOCOL-SECRET'), false);
});

test('caret ranges and transitive-only manifests cannot pass a pinned-package preflight', () => {
  const ranged = evaluateManifest({
    dependencies: {'@a2ui/react': '^0.14.0', '@a2ui/web_core': '^0.14.0'},
  }, 'v0.9');
  assert.equal(ranged.reason, 'non_exact_sdk_pin');
  assert.equal(ranged.eligible, false);
  const absent = evaluateManifest({dependencies: {react: '19.2.0'}}, 'v0.9');
  assert.equal(absent.reason, 'missing_sdk_declaration');
});

test('conflicting dependency/peer declarations are not silently treated as exact pins', () => {
  const report = evaluateManifest({
    dependencies: {'@a2ui/react': '0.14.0', '@a2ui/web_core': '0.14.0'},
    peerDependencies: {'@a2ui/react': '^0.15.0'},
  }, 'v0.9');
  assert.equal(report.reason, 'conflicting_declarations');
  assert.equal(report.eligible, false);
});

test('fixed diagnostic omits all private package names, arbitrary metadata and paths', () => {
  const run = invoke({...pinned, name: 'PRIVATE-SECRET-CLIENT', scripts: {private: 'SECRET-PAYLOAD'}});
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).reason, 'eligible_declared_pair');
  assert.equal(run.stdout.includes('PRIVATE-SECRET'), false);
  assert.equal(run.stdout.includes('SECRET-PAYLOAD'), false);
  assert.equal(run.stdout.includes('PRIVATE-PATH'), false);
});

test('malformed input, duplicate flags and invalid dependency sections fail closed at exit 2', () => {
  const malformed = invoke('{ "name": "PRIVATE-SECRET", broken');
  assert.equal(malformed.status, 2);
  assert.equal(malformed.stdout, '');
  assert.equal(malformed.stderr.includes('PRIVATE-SECRET'), false);
  const invalid = invoke({dependencies: 'PRIVATE-SECRET'});
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stderr.includes('PRIVATE-SECRET'), false);
  const duplicate = spawnSync(process.execPath,
    [cli, '--manifest', 'path', '--manifest', 'path', '--protocol', 'v0.9'],
    {encoding: 'utf8', timeout: 5000});
  assert.equal(duplicate.status, 2);
  assert.equal(duplicate.stdout, '');
});

test('missing manifest and oversized manifest are rejected without leaking file paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-private-missing-'));
  try {
    const path = join(dir, 'PRIVATE-SECRET.json');
    const missing = spawnSync(process.execPath,
      [cli, '--manifest', path, '--protocol', 'v0.9'],
      {encoding: 'utf8', timeout: 5000});
    assert.equal(missing.status, 2);
    assert.equal(missing.stderr.includes(path), false);
    writeFileSync(path, JSON.stringify({ignored: 'x'.repeat(135000)}));
    const large = spawnSync(process.execPath,
      [cli, '--manifest', path, '--protocol', 'v0.9'],
      {encoding: 'utf8', timeout: 5000});
    assert.equal(large.status, 2);
    assert.equal(large.stderr.includes(path), false);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

const exactLock = {
  lockfileVersion: 3,
  packages: {
    '': {dependencies: {...pinned.dependencies}},
    'node_modules/@a2ui/react': {version: '0.14.0'},
    'node_modules/@a2ui/web_core': {version: '0.14.0'},
  },
};

test('optional npm v3 and v2 lockfile root and direct resolutions match exact 0.14 lane', () => {
  for (const lockfileVersion of [2, 3]) {
    const report = evaluateConsumer(pinned, 'v0.9', {...exactLock, lockfileVersion});
    assert.equal(report.eligible, true);
    assert.equal(report.reason, 'eligible_declared_pair');
    assert.deepEqual(report.lockfileCheck, {
      recordedExactPair: true, reason: 'lockfile_exact_pair',
    });
    assert.match(report.limitations, /no installed-files/);
  }
  assert.equal(Object.hasOwn(evaluateConsumer(pinned, 'v0.9'), 'lockfileCheck'), false);
});

test('stale npm lockfile root declarations cannot inherit green manifest pins', () => {
  const lockfile = structuredClone(exactLock);
  lockfile.packages[''].dependencies['@a2ui/web_core'] = '^0.14.0';
  const report = evaluateConsumer(pinned, 'v0.9', lockfile);
  assert.equal(report.eligible, false);
  assert.equal(report.reason, 'lockfile_root_mismatch');
  assert.equal(report.lockfileCheck.recordedExactPair, false);
});

test('SDK root declarations moved to another npm dependency section fail closed', () => {
  for (const section of ['devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const lockfile = structuredClone(exactLock);
    delete lockfile.packages[''].dependencies;
    lockfile.packages[''][section] = {...pinned.dependencies};
    const report = evaluateConsumer(pinned, 'v0.9', lockfile);
    assert.equal(report.eligible, false, section);
    assert.equal(report.reason, 'lockfile_root_mismatch', section);
    assert.equal(report.lockfileCheck.recordedExactPair, false, section);
  }
});

test('missing and unexpected direct package versions fail the optional lockfile check', () => {
  for (const badVersion of ['0.15.0', undefined]) {
    const lockfile = structuredClone(exactLock);
    if (badVersion) lockfile.packages['node_modules/@a2ui/react'].version = badVersion;
    else delete lockfile.packages['node_modules/@a2ui/react'];
    const report = evaluateConsumer(pinned, 'v0.9', lockfile);
    assert.equal(report.eligible, false);
    assert.equal(report.reason, 'lockfile_sdk_mismatch');
  }
  const linked = structuredClone(exactLock);
  linked.packages['node_modules/@a2ui/react'].link = true;
  assert.equal(evaluateConsumer(pinned, 'v0.9', linked).reason, 'lockfile_sdk_mismatch');
});

test('npm v1 or workspace-only lockfiles are unsupported, not verified installs', () => {
  const one = evaluateConsumer(pinned, 'v0.9', {...exactLock, lockfileVersion: 1});
  assert.equal(one.reason, 'lockfile_unsupported');
  assert.equal(one.eligible, false);
  const workspace = evaluateConsumer(pinned, 'v0.9', {lockfileVersion: 3,
    packages: {'packages/app': {dependencies: pinned.dependencies}}});
  assert.equal(workspace.reason, 'lockfile_unsupported');
  assert.equal(workspace.eligible, false);
});

test('lockfile input cannot rescue an unsupported SDK/protocol lane', () => {
  const v1 = evaluateConsumer(pinned, 'v1.0', exactLock);
  assert.equal(v1.reason, 'protocol_outside_test_lane');
  assert.equal(v1.eligible, false);
  const other = evaluateConsumer({dependencies: {
    '@a2ui/react': '^0.15.0', '@a2ui/web_core': '^0.15.0',
  }}, 'v0.9', exactLock);
  assert.equal(other.reason, 'sdk_generation_not_tested');
  assert.equal(other.eligible, false);
});

test('optional lockfile CLI has fixed redacted output and rejects malformed input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-private-lockfile-'));
  const manifest = join(dir, 'PRIVATE-MANIFEST-PATH.json');
  const lockPath = join(dir, 'PRIVATE-LOCK-PATH.json');
  try {
    writeFileSync(manifest, JSON.stringify({...pinned, name: 'PRIVATE-NAME'}));
    writeFileSync(lockPath, JSON.stringify({...exactLock,
      privateKey: 'SECRET-LOCK-VALUE',
      packages: {...exactLock.packages,
        'node_modules/@a2ui/react': {version: '0.14.0', resolved: 'SECRET-URL'}}}));
    const good = spawnSync(process.execPath,
      [cli, '--manifest', manifest, '--protocol', 'v0.9', '--lockfile', lockPath],
      {encoding: 'utf8', timeout: 5000});
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).lockfileCheck.recordedExactPair, true);
    for (const secret of ['PRIVATE-MANIFEST', 'PRIVATE-LOCK', 'PRIVATE-NAME',
      'SECRET-LOCK', 'SECRET-URL']) {
      assert.equal((good.stdout + good.stderr).includes(secret), false);
    }
    writeFileSync(lockPath, '{ "secret": "PRIVATE-SECRET", broken');
    const invalid = spawnSync(process.execPath,
      [cli, '--manifest', manifest, '--protocol', 'v0.9', '--lockfile', lockPath],
      {encoding: 'utf8', timeout: 5000});
    assert.equal(invalid.status, 2);
    assert.equal(invalid.stdout, '');
    assert.equal(invalid.stderr.includes('PRIVATE-SECRET'), false);
    assert.equal(invalid.stderr.includes('PRIVATE-LOCK-PATH'), false);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

const workspaceManifest = {...pinned, name: '@private/workspace-app'};
const workspaceLock = {
  lockfileVersion: 3,
  packages: {
    '': {workspaces: ['packages/*']},
    'packages/app': {name: '@private/workspace-app', dependencies: {...pinned.dependencies}},
    'node_modules/@private/workspace-app': {link: true, resolved: 'packages/app'},
    'node_modules/@a2ui/react': {version: '0.14.0'},
    'node_modules/@a2ui/web_core': {version: '0.14.0'},
  },
};

test('explicit named npm workspaces verify linked manifest and hoisted pinned SDKs offline', () => {
  const rootOnly = evaluateConsumer(workspaceManifest, 'v0.9', workspaceLock);
  assert.equal(rootOnly.eligible, false, 'root must not pretend it owns workspace SDK declarations');
  const selected = evaluateConsumer(workspaceManifest, 'v0.9', workspaceLock,
    {workspace: 'packages/app'});
  assert.equal(selected.eligible, true);
  assert.equal(selected.reason, 'eligible_declared_pair');
  assert.deepEqual(selected.lockfileCheck,
    {recordedExactPair: true, reason: 'lockfile_exact_pair', scope: 'npm-workspace'});
  assert.doesNotMatch(JSON.stringify(selected), /private|packages\/app/i,
    'consumer package name/path must not appear in the shareable report');
});

test('named workspace requires root membership, not merely a local file link', () => {
  const options = {workspace: 'packages/app'};
  for (const workspaces of [
    undefined, [], ['other/*'], ['packages/*', '!packages/app'],
    ['packages/{app,web}'], {packages: ['packages/*']},
  ]) {
    const lock = structuredClone(workspaceLock);
    if (workspaces === undefined) delete lock.packages[''].workspaces;
    else lock.packages[''].workspaces = workspaces;
    const report = evaluateConsumer(workspaceManifest, 'v0.9', lock, options);
    assert.equal(report.eligible, false, 'unverified workspace must fail closed');
    assert.equal(report.reason, 'lockfile_workspace_mismatch');
    assert.doesNotMatch(JSON.stringify(report), /@private|packages\/app/i);
  }
  for (const patterns of [
    ['packages/app'], ['packages/*'], ['packages/**'], ['./packages/*'],
  ]) {
    const lock = structuredClone(workspaceLock);
    lock.packages[''].workspaces = patterns;
    assert.equal(evaluateConsumer(workspaceManifest, 'v0.9', lock, options).eligible, true);
  }
});

test('workspace-local SDK resolution shadows a different hoisted version', () => {
  const lockfile = structuredClone(workspaceLock);
  lockfile.packages['packages/app/node_modules/@a2ui/react'] = {version: '0.15.0'};
  const report = evaluateConsumer(workspaceManifest, 'v0.9', lockfile,
    {workspace: 'packages/app'});
  assert.equal(report.reason, 'lockfile_sdk_mismatch');
  assert.equal(report.eligible, false);
});

test('nested workspaces reject ancestor-installed SDK drift before root hoists', () => {
  const lock = structuredClone(workspaceLock);
  lock.packages['packages/node_modules/@a2ui/react'] = {version: '0.15.0'};
  const mismatch = evaluateConsumer(workspaceManifest, 'v0.9', lock,
    {workspace: 'packages/app'});
  assert.equal(mismatch.eligible, false);
  assert.equal(mismatch.reason, 'lockfile_sdk_mismatch');
  // The nearest workspace-local installation takes precedence over its parent.
  lock.packages['packages/app/node_modules/@a2ui/react'] = {version: '0.14.0'};
  assert.equal(evaluateConsumer(workspaceManifest, 'v0.9', lock,
    {workspace: 'packages/app'}).eligible, true);
  delete lock.packages['packages/app/node_modules/@a2ui/react'];
  lock.packages['packages/node_modules/@a2ui/react'] = null;
  assert.equal(evaluateConsumer(workspaceManifest, 'v0.9', lock,
    {workspace: 'packages/app'}).eligible, false, 'malformed ancestor must not fall back');
});
test('npm workspace path, link and declaration mismatches fail closed without data disclosure', () => {
  const opts = {workspace: 'packages/app'};
  for (const change of [
    lock => {delete lock.packages['packages/app'];},
    lock => {delete lock.packages['node_modules/@private/workspace-app'];},
    lock => {lock.packages['node_modules/@private/workspace-app'].resolved = 'packages/other';},
  ]) {
    const lock = structuredClone(workspaceLock);
    change(lock);
    const report = evaluateConsumer(workspaceManifest, 'v0.9', lock, opts);
    assert.equal(report.eligible, false);
    assert.equal(report.reason, 'lockfile_workspace_mismatch');
  }
  const drift = structuredClone(workspaceLock);
  delete drift.packages['packages/app'].dependencies;
  drift.packages['packages/app'].devDependencies = {...pinned.dependencies};
  assert.equal(evaluateConsumer(workspaceManifest, 'v0.9', drift, opts).reason,
    'lockfile_root_mismatch');
  for (const path of ['../SECRET', '/tmp/SECRET', 'packages//app',
    'packages/../app', 'packages\\app', 'packages/node_modules/app']) {
    assert.throws(() => evaluateConsumer(workspaceManifest, 'v0.9', workspaceLock,
      {workspace: path}), /Invalid npm workspace path; input omitted/);
  }
  assert.throws(() => evaluateConsumer(workspaceManifest, 'v0.9', undefined, opts),
    /requires a lockfile/);
  const invalidName = {...workspaceManifest, name: ['@private/workspace-app']};
  assert.equal(evaluateConsumer(invalidName, 'v0.9', workspaceLock, opts).reason,
    'lockfile_workspace_mismatch');
});

test('workspace CLI checks metadata without exposing private package names or paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-private-npm-workspace-'));
  try {
    const manifest = join(dir, 'PRIVATE-MANIFEST.json');
    const lockfile = join(dir, 'PRIVATE-LOCK.json');
    writeFileSync(manifest, JSON.stringify(workspaceManifest));
    writeFileSync(lockfile, JSON.stringify(workspaceLock));
    const argv = ['--manifest', manifest, '--protocol', 'v0.9',
      '--lockfile', lockfile, '--workspace', 'packages/app'];
    const pass = spawnSync(process.execPath, [cli, ...argv],
      {encoding: 'utf8', timeout: 5000});
    assert.equal(pass.status, 0, pass.stderr);
    assert.equal(JSON.parse(pass.stdout).lockfileCheck.scope, 'npm-workspace');
    assert.doesNotMatch(pass.stdout + pass.stderr, /PRIVATE-|@private|packages\/app/);
    for (const bad of [
      [...argv.slice(0, -1), '../PRIVATE-PATH'],
      ['--manifest', manifest, '--protocol', 'v0.9', '--workspace', 'packages/app'],
    ]) {
      const rejected = spawnSync(process.execPath, [cli, ...bad],
        {encoding: 'utf8', timeout: 5000});
      assert.equal(rejected.status, 2);
      assert.equal(rejected.stdout, '');
      assert.doesNotMatch(rejected.stderr, /PRIVATE-|@private|packages\/app/);
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
