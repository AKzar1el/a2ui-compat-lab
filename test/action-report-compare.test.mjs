import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compareActionReports} from '../src/action-report-compare.mjs';

const replay = fileURLToPath(new URL('../src/replay-action-report.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../src/capture-compare-cli.mjs', import.meta.url));
function run(path,args=[]) {
  const p = spawnSync(process.execPath, [path,...args],
    {encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024});
  if(p.error)throw p.error;
  return p;
}
function actual() {
  const p=run(replay);
  assert.equal(p.status,0,p.stderr);
  const r=JSON.parse(p.stdout);
  assert.ok(r.actionCount>0,'published SDK must emit actual Button events');
  return r;
}
test('same published SDK Button replay has identical actions and snapshots',()=>{
  const before=actual();
  const result=compareActionReports(before,structuredClone(before));
  assert.equal(result.ok,true);
  assert.deepEqual(result.changedActionIndices,[]);
  assert.deepEqual(result.differences,[]);
});
test('equal counts still detect changed action routing/context without disclosure',()=>{
  const before=actual(), after=structuredClone(before);
  after.trace.actions[0].context={test:'PRIVATE_ACTION_TEST_SENTINEL'};
  assert.equal(before.actionCount,after.actionCount);
  const result=compareActionReports(before,after);
  assert.equal(result.ok,false);
  assert.deepEqual(result.changedActionIndices,[0]);
  assert.equal(result.differingSteps,0);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_ACTION_TEST_SENTINEL/);
});
test('state drift and bad action evidence are detected or refused',()=>{
  const before=actual(), after=structuredClone(before);
  after.trace.snapshots[2].data={test:'PRIVATE_DATA_TEST_SENTINEL'};
  const result=compareActionReports(before,after);
  assert.deepEqual(result.differences,[{index:2,fields:['data']}]);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_DATA_TEST_SENTINEL/);
  for(const edit of [
    r=>{r.fixtureSha256='f'.repeat(64);},
    r=>{r.steps++;},
    r=>{r.actionCount--;},
    r=>{r.trace.actions.pop();},
    r=>{r.trace.snapshots[3].actionCount=0;},
    r=>{r.chunkTrials[0].matches=false;},
  ]){
    const bad=structuredClone(before);edit(bad);
    assert.throws(()=>compareActionReports(before,bad),/different fixtures|invalid|incomplete|inconsistent|malformed|disagrees/);
  }
});
test('missing data in both action reports is refused rather than MATCH', () => {
  const observed = actual();
  assert.ok(observed.trace.snapshots.every(s => Object.hasOwn(s, 'data')),
    'published-SDK action producer must serialize data even before initialization');
  for (const index of [0, 2, observed.trace.snapshots.length - 1]) {
    const incomplete = structuredClone(observed);
    delete incomplete.trace.snapshots[index].data;
    assert.throws(() => compareActionReports(incomplete, structuredClone(incomplete)),
      /malformed action snapshot/, 'missing action state at step ' + index);
  }
  const undefinedData = structuredClone(observed);
  undefinedData.trace.snapshots[2].data = undefined;
  assert.throws(() => compareActionReports(undefinedData, structuredClone(undefinedData)),
    /malformed action snapshot/);
});

test('CLI action mode is strict and redacts action payloads',()=>{
  const dir=mkdtempSync(join(tmpdir(),'a2ui-action-diff-'));
  try{
    const before=actual(),after=structuredClone(before);
    const a=join(dir,'a.json'),b=join(dir,'b.json');
    writeFileSync(a,JSON.stringify(before));writeFileSync(b,JSON.stringify(after));
    let p=run(cli,['--actions','--before',a,'--after',b,'--json','--strict']);
    assert.equal(p.status,0,p.stderr);
    after.trace.actions[0].context={test:'PRIVATE_ACTION_TEST_SENTINEL'};
    writeFileSync(b,JSON.stringify(after));
    p=run(cli,['--actions','--before',a,'--after',b,'--json','--strict']);
    assert.equal(p.status,1,p.stderr);
    assert.deepEqual(JSON.parse(p.stdout).changedActionIndices,[0]);
    assert.doesNotMatch(p.stdout+p.stderr,/PRIVATE_ACTION_TEST_SENTINEL/);
    after.fixtureSha256='f'.repeat(64);writeFileSync(b,JSON.stringify(after));
    p=run(cli,['--actions','--before',a,'--after',b,'--strict']);
    assert.equal(p.status,2);
    assert.equal(p.stdout,'');
    assert.match(p.stderr,/different fixtures/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});


test('action comparison refuses byte-corrupted but parseable JSON reports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-action-utf8-'));
  try {
    const report = actual();
    const good = join(dir, 'good.json');
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(good, JSON.stringify(report));
    const bytes = Buffer.from(JSON.stringify({
      ...report, implementation: 'PRIVATE_ACTION_UTF8_MARKER',
    }));
    const index = bytes.indexOf(Buffer.from('PRIVATE_ACTION_UTF8_MARKER'));
    assert.ok(index > 0);
    bytes[index] = 0xff;
    writeFileSync(corrupt, bytes);
    for (const [before, after] of [[corrupt, good], [good, corrupt], [corrupt, corrupt]]) {
      const p = run(cli, ['--actions', '--before', before, '--after', after, '--strict', '--json']);
      assert.equal(p.status, 2, p.stderr);
      assert.equal(p.stdout, '');
      assert.match(p.stderr, /Report is not valid UTF-8/);
      assert.doesNotMatch(p.stderr, /RIVATE_ACTION_UTF8_MARKER/);
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
