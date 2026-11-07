import {test} from 'node:test';
import assert from 'node:assert/strict';
import {preliminary,permittedPath,repo,checksGreen,latestMainCiRun,mainChecksGreen} from '../scripts/merge-policy.mjs';
const sha='a'.repeat(40);
const good={draft:false,state:'open',mergeable:true,mergeable_state:'clean',
 base:{ref:'main',repo:{full_name:repo}},head:{sha,ref:'revshot/safe-change',repo:{full_name:repo}},
 user:{login:'AKzar1el'},body:'MERGER_HANDOFF: '+repo+'@'+sha,labels:[]};
test('exact SHA-bound same-repository owner PR is eligible for later independent gates',()=>assert.equal(preliminary(good),null));
test('stale handoff, wrong repo, draft, and reviewer request block',()=>{
 assert.match(preliminary({...good,body:'MERGER_HANDOFF: '+repo+'@'+'b'.repeat(40)}),/stale/);
 assert.match(preliminary({...good,head:{...good.head,repo:{full_name:'someone/fork'}}}),/unexpected/);
 assert.equal(preliminary({...good,draft:true}),'draft PR');
 assert.match(preliminary({...good,requested_reviewers:[{login:'reviewer'}]}),/human review/);
});
test('safe files limited to source/tests/docs, never workflow, dependency, or merger controls',()=>{
 assert.ok(permittedPath('src/replay.mjs'));
 assert.ok(permittedPath('worker/RUN_LOG.md'));
 for(const path of ['.github/workflows/ci.yml','package.json','renderer-react/package-lock.json',
 'scripts/guarded-merge.mjs','scripts/security-audit-core.mjs','worker/WORKER_PROMPT.md','../secret'])
  assert.equal(permittedPath(path),false,path);
});

test('PR-head CI refuses missing, unfinished, historical failed, or incomplete checks',()=>{
 const required=['sdk-parity','react-browser','dependency-audit'];
 const reports={total_count:3,check_runs:required.map(name=>({
  name,app:{slug:'github-actions'},status:'completed',conclusion:'success'
 }))};
 assert.equal(checksGreen(reports,required),true);
 const pending=structuredClone(reports);
 pending.check_runs[2].status='in_progress';pending.check_runs[2].conclusion=null;
 assert.equal(checksGreen(pending,required),false);
 const failedIntegration=structuredClone(reports);
 failedIntegration.check_runs.push({
  name:'integrate',app:{slug:'github-actions'},status:'completed',conclusion:'failure'
 });
 failedIntegration.total_count++;
 assert.equal(checksGreen(failedIntegration,required),false,
  'a historical failed integration job cannot bypass PR-head validation');
 const pendingIntegration=structuredClone(failedIntegration);
 pendingIntegration.check_runs[3].status='in_progress';
 pendingIntegration.check_runs[3].conclusion=null;
 assert.equal(checksGreen(pendingIntegration,required),false);
 const externalFailed=structuredClone(reports);
 externalFailed.check_runs.push({
  name:'Socket Security',app:{slug:'socket-security'},status:'completed',conclusion:'failure'
 });
 externalFailed.total_count++;
 assert.equal(checksGreen(externalFailed,required),false);
 assert.equal(checksGreen({...reports,total_count:4},required),false,
  'truncated CI check-runs must never look green');
 assert.equal(checksGreen({...reports,total_count:undefined},required),false,
  'missing pagination evidence must fail closed');
});

test('latest exact-main CI must be selected by branch and SHA, not mixed branch checks',()=>{
 const mainSha='b'.repeat(40);
 const runs={total_count:3,workflow_runs:[
  {id:42,head_sha:mainSha,head_branch:'revshot/test',event:'push',created_at:'2026-11-07T17:00:00Z',conclusion:'cancelled'},
  {id:41,head_sha:mainSha,head_branch:'main',event:'workflow_dispatch',created_at:'2026-11-07T13:00:00Z',status:'completed',conclusion:'success'},
  {id:40,head_sha:mainSha,head_branch:'main',event:'push',created_at:'2026-11-07T12:00:00Z',status:'completed',conclusion:'success'},
 ]};
 assert.equal(latestMainCiRun(runs,mainSha).id,41);
 assert.equal(latestMainCiRun(runs,'c'.repeat(40)),null);
 assert.equal(latestMainCiRun({...runs,total_count:100},mainSha),null);
 const newer={...runs,workflow_runs:[
  ...runs.workflow_runs,
  {id:43,head_sha:mainSha,head_branch:'main',event:'workflow_dispatch',created_at:'2026-11-07T18:00:00Z',status:'completed',conclusion:'failure'}
 ],total_count:4};
 assert.equal(latestMainCiRun(newer,mainSha).id,43);
 assert.equal(latestMainCiRun(newer,mainSha).conclusion,'failure');
});

test('main gate tolerates superseded foreign-branch cancellations but rejects missing or bad jobs',()=>{
 const required=['sdk-parity','react-browser','dependency-audit'];
 const ok=name=>({name,app:{slug:'github-actions'},status:'completed',conclusion:'success'});
 const canceled=name=>({name,app:{slug:'github-actions'},status:'completed',conclusion:'cancelled'});
 const checks={total_count:9,check_runs:[
  ...required.map(canceled),...required.map(ok),
  {name:'Socket Security',app:{slug:'socket-security'},status:'completed',conclusion:'success'},
  {id:1234,name:'integrate',app:{slug:'github-actions'},status:'in_progress',conclusion:null,
   details_url:'https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42/job/1234'},
  {name:'Other Gate',app:{slug:'github-actions'},status:'completed',conclusion:'success'},
 ]};
 const jobs={total_count:3,jobs:required.map(name=>({name,status:'completed',conclusion:'success'}))};
 assert.equal(checksGreen(checks,required),false,'old gate wrongly rejects unrelated canceled checks');
 assert.equal(mainChecksGreen(checks,jobs,required,42),true);
 assert.equal(mainChecksGreen(checks,{...jobs,jobs:jobs.jobs.slice(1),total_count:2},required,42),false);
 assert.equal(mainChecksGreen(checks,{...jobs,jobs:jobs.jobs.map(job=>
  job.name==='react-browser'?{...job,conclusion:'cancelled'}:job)},required,42),false);
 const externalFailed=structuredClone(checks);
 externalFailed.check_runs[6].conclusion='failure';
 assert.equal(mainChecksGreen(externalFailed,jobs,required,42),false);
 const otherFailed=structuredClone(checks);
 otherFailed.check_runs[8].status='in_progress';
 assert.equal(mainChecksGreen(otherFailed,jobs,required,42),false);
 assert.equal(mainChecksGreen(checks,jobs,required,0),false,'missing current run must fail closed');
 const failedOldIntegration=structuredClone(checks);
 failedOldIntegration.check_runs.push({id:9876,name:'integrate',app:{slug:'github-actions'},status:'completed',conclusion:'failure',
  details_url:'https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/41/job/9876'});
 failedOldIntegration.total_count++;
 assert.equal(mainChecksGreen(failedOldIntegration,jobs,required,42),false,
  'failed historical merger job is not the current in-progress job');
 const wrongSelfJob=structuredClone(checks);
 wrongSelfJob.check_runs[7].details_url='https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/41/job/1234';
 assert.equal(mainChecksGreen(wrongSelfJob,jobs,required,42),false,
  'only exact current run and job id may be ignored');
 assert.equal(mainChecksGreen({...checks,total_count:100},jobs,required,42),false);
});
