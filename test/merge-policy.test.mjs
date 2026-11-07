import {test} from 'node:test';
import assert from 'node:assert/strict';
import {preliminary,permittedPath,repo} from '../scripts/merge-policy.mjs';
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
