import {preliminary,permittedPath,repo,checksGreen,latestMainCiRun,mainChecksGreen} from './merge-policy.mjs';
const token=process.env.GITHUB_TOKEN;
const dry=process.env.A2UI_AUTO_MERGE_DRY_RUN==='true';
if(process.env.GITHUB_REPOSITORY!==repo||!token)throw Error('Exact repo binding and GITHUB_TOKEN required');
const base='https://api.github.com';
async function api(endpoint,method='GET',payload){
 const r=await fetch(base+endpoint,{method,headers:{Accept:'application/vnd.github+json',
  Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28',
  'User-Agent':'a2ui-guarded-merger'},body:payload===undefined?undefined:JSON.stringify(payload),
  signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw Error('GitHub '+method+' '+endpoint.split('?')[0]+' returned '+r.status);
 return r.status===204?null:r.json();
}
const root='/repos/'+repo;
async function threadsClear(number){
 const query='query($number:Int!){repository(owner:"AKzar1el",name:"a2ui-compat-lab"){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}pageInfo{hasNextPage}}}}}';
 const r=await api('/graphql','POST',{query,variables:{number}});
 const t=r.data?.repository?.pullRequest?.reviewThreads;
 return !r.errors?.length&&t&&!t.pageInfo.hasNextPage&&t.nodes.every(x=>x.isResolved);
}
async function run(){
 const required=['sdk-parity','react-browser','dependency-audit'];
 const main=(await api(root+'/branches/main')).commit.sha;
 // Branch-creation CI may be cancelled on the exact same SHA as main.
 // Inspect the latest exact-main CI run and its own jobs, not mixed ref checks.
 const mainRuns=await api(root+'/actions/workflows/ci.yml/runs?branch=main&head_sha='+main+'&per_page=100');
 const latest=latestMainCiRun(mainRuns,main);
 if(!latest||latest.status!=='completed'||latest.conclusion!=='success'){
  console.log('SKIP: latest exact-main CI workflow has not succeeded');return;
 }
 const mainJobs=await api(root+'/actions/runs/'+latest.id+'/jobs?per_page=100');
 if(!mainChecksGreen(await api(root+'/commits/'+main+'/check-runs?per_page=100'),mainJobs,required)){
  console.log('SKIP: exact-main CI jobs or unrelated security checks not green');return;
 }
 const prs=await api(root+'/pulls?state=open&per_page=100&sort=created&direction=asc');
 if(prs.length>=100)throw Error('Pull list requires pagination; refuse incomplete scan');
 for(const entry of prs){
  const pr=await api(root+'/pulls/'+entry.number);
  const prelim=preliminary(pr);
  if(prelim){console.log('SKIP #'+pr.number+': '+prelim);continue;}
  if(pr.base.sha!==main){console.log('SKIP #'+pr.number+': stale base');continue;}
  const files=await api(root+'/pulls/'+pr.number+'/files?per_page=100');
  if(pr.changed_files>=100||files.length!==pr.changed_files||files.some(x=>!permittedPath(x.filename))){
   console.log('SKIP #'+pr.number+': unsafe or unreviewed path');continue;
  }
  const cmp=await api(root+'/compare/main...'+pr.head.sha);
  if(cmp.behind_by!==0||cmp.ahead_by<1){console.log('SKIP #'+pr.number+': stale history');continue;}
  const reviews=await api(root+'/pulls/'+pr.number+'/reviews?per_page=100');
  if(reviews.length>=100||reviews.some(x=>x.state==='CHANGES_REQUESTED')||!await threadsClear(pr.number)){
   console.log('SKIP #'+pr.number+': review hold');continue;
  }
  if(!checksGreen(await api(root+'/commits/'+pr.head.sha+'/check-runs?per_page=100'),required)){
   console.log('SKIP #'+pr.number+': exact-head CI not green');continue;
  }
  const status=await api(root+'/commits/'+pr.head.sha+'/status');
  if(status.statuses?.length&&status.state!=='success'){console.log('SKIP #'+pr.number+': commit status');continue;}
  const final=await api(root+'/pulls/'+pr.number);
  if(final.head.sha!==pr.head.sha||preliminary(final)||(await api(root+'/branches/main')).commit.sha!==main){
   console.log('SKIP #'+pr.number+': head or main changed');continue;
  }
  if(dry){console.log('DRY RUN eligible #'+pr.number+' sha='+pr.head.sha);return;}
  const result=await api(root+'/pulls/'+pr.number+'/merge','PUT',{
   sha:pr.head.sha,merge_method:'merge',commit_title:'Merge A2UI Revenue Shot PR #'+pr.number});
  if(result?.merged!==true)throw Error('GitHub did not confirm merge');
  console.log('MERGED PR #'+pr.number+' sha='+result.sha);
  await api(root+'/actions/workflows/ci.yml/dispatches','POST',{ref:'main'});
  console.log('Dispatched fresh main CI');
  return;
 }
 console.log('No eligible PRs: review holds preserved');
}
run().catch(e=>{console.error('Guarded merger REFUSED: '+e.message);process.exitCode=1;});
