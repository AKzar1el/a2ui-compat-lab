export const repo='AKzar1el/a2ui-compat-lab';
const blocked=['.github/','worker/WORKER_PROMPT.md','AGENTS.md','SECURITY.md','package.json','package-lock.json',
 'renderer-react/package.json','renderer-react/package-lock.json','scripts/guarded-merge.mjs',
 'scripts/merge-policy.mjs','scripts/security-audit.mjs','scripts/security-audit-core.mjs',
 'test/merge-policy.test.mjs','test/security.test.mjs'];
const safePrefixes=['src/','test/','fixtures/','docs/','examples/','scripts/','renderer-react/src/','renderer-react/scripts/'];
const safeExact=new Set(['README.md','CHANGELOG.md','worker/RUN_LOG.md']);
export function permittedPath(path){
 if(typeof path!=='string'||!path||path.includes('..')||path.includes('\\'))return false;
 if(blocked.some(p=>path===p||p.endsWith('/')&&path.startsWith(p)))return false;
 return safeExact.has(path)||safePrefixes.some(p=>path.startsWith(p));
}
export function preliminary(pr){
 if(pr.draft)return 'draft PR';
 if(pr.state!=='open')return 'closed';
 if(pr.base?.ref!=='main'||pr.base?.repo?.full_name!==repo)return 'unexpected base';
 if(pr.head?.repo?.full_name!==repo)return 'unexpected source branch';
 const branch=pr.head?.ref;
 if(typeof branch!=='string')return 'unexpected source branch';
 if(!branch.startsWith('revshot/')){
  const bug=/^rs-bugfix\/([0-9a-f]{12})$/.exec(branch);
  if(!bug)return 'unexpected source branch';
  const markers=(pr.body||'').split(/\r?\n/).map(x=>x.trim())
   .filter(x=>x.startsWith('<!-- rs-bugfix:v1 bug_id='));
  if(markers.length!==1||markers[0]!=='<!-- rs-bugfix:v1 bug_id='+bug[1]+' -->')
   return 'missing or mismatched bug identity';
 }
 if(pr.user?.login!=='AKzar1el')return 'not owner authored';
 if(pr.mergeable!==true||pr.mergeable_state!=='clean')return 'unresolved mergeability';
 if(pr.requested_reviewers?.length||pr.requested_teams?.length)return 'human review requested';
 if((pr.labels||[]).some(x=>['hold','do-not-merge','security-hold','manual-release','needs-owner-review'].includes(x.name?.toLowerCase())))return 'review hold label';
 const line='MERGER_HANDOFF: '+repo+'@'+pr.head.sha;
 const matches=(pr.body||'').split(/\r?\n/).map(x=>x.trim()).filter(x=>x.startsWith('MERGER_HANDOFF: '));
 if(matches.length!==1||matches[0]!==line)return 'missing or stale exact-SHA handoff';
 return null;
}

// GitHub limits a check-run page to 100 and can cap check-suite history.
// Accept at most 999 distinct runs, never infer success from a truncated scan.
export const MAX_CHECK_RUNS = 999;
const CHECK_PAGE_SIZE = 100;
export async function completeCheckRuns(fetchPage) {
 const seen=new Set();
 const all=[];
 let count;
 for(let page=1;page<=Math.ceil(MAX_CHECK_RUNS/CHECK_PAGE_SIZE);page++){
  const result=await fetchPage(page);
  if(!Number.isSafeInteger(result?.total_count)||result.total_count<0||
     result.total_count>MAX_CHECK_RUNS||!Array.isArray(result.check_runs))
   throw Error('Incomplete or oversized check-run evidence');
  if(count===undefined)count=result.total_count;
  if(result.total_count!==count||result.check_runs.length!==Math.min(CHECK_PAGE_SIZE,count-all.length))
   throw Error('Check-run pagination changed or incomplete');
  for(const check of result.check_runs){
   if(!Number.isSafeInteger(check?.id)||check.id<1||seen.has(check.id))
    throw Error('Duplicate or invalid check-run identity');
   seen.add(check.id);
   all.push(check);
  }
  if(all.length===count)return {total_count:count,check_runs:all};
 }
 throw Error('Check-run pagination exceeded reviewed limit');
}

export function checksGreen(result, required) {
 if(!Array.isArray(result?.check_runs) || !Number.isSafeInteger(result.total_count) ||
    result.total_count < 0 || result.total_count > MAX_CHECK_RUNS || result.check_runs.length !== result.total_count) return false;
 // Source-PR head checks have no self-integration exemption: the currently
 // executing merger runs on main, not on the PR head. All other checks gate.
 const relevant = result.check_runs;
 if(relevant.some(x => x.status !== 'completed' ||
   !['success','neutral','skipped'].includes(x.conclusion))) return false;
 // A third-party Check Run may use the same display name as a required job.
 // Only actual GitHub Actions checks can satisfy our three SDK/browser/audit
 // gates. Other apps still participate in the all-checks-must-pass gate above.
 return required.every(name =>
  relevant.some(x => x.name === name && x.app?.slug === 'github-actions' &&
   x.status === 'completed' && x.conclusion === 'success'));
}

/**
 * A source-branch creation can start then cancel CI at the *same commit SHA*
 * as main. Find the latest CI run explicitly executed for main instead of
 * treating unrelated historical branch check-runs as current main failures.
 */
export function latestMainCiRun(result, mainSha) {
 if(!/^[a-f0-9]{40}$/.test(mainSha)||!Array.isArray(result?.workflow_runs)||
    !Number.isSafeInteger(result.total_count)||result.total_count>=100||
    result.workflow_runs.length!==result.total_count)return null;
 return result.workflow_runs.filter(run=>
   run.head_sha===mainSha&&run.head_branch==='main'&&
   ['push','workflow_dispatch'].includes(run.event)&&Number.isSafeInteger(run.id)&&
   typeof run.created_at==='string'&&!Number.isNaN(Date.parse(run.created_at)))
  .sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)||b.id-a.id)[0]??null;
}

/**
 * Required GitHub Actions jobs are proven by an exact-main workflow run.
 * Still fail closed on every unrelated check, including third-party security.
 */
export function mainChecksGreen(checks, jobs, required, activeIntegrationRunId) {
 if(!Number.isSafeInteger(activeIntegrationRunId)||activeIntegrationRunId<1)return false;
 if(!Array.isArray(checks?.check_runs)||!Number.isSafeInteger(checks.total_count)||
    checks.total_count<0||checks.total_count>MAX_CHECK_RUNS||checks.check_runs.length!==checks.total_count||
    !Array.isArray(jobs?.jobs)||!Number.isSafeInteger(jobs.total_count)||
    jobs.total_count>=100||jobs.jobs.length!==jobs.total_count)return false;
 // Only the currently executing integration job may remain in progress.
 // Other historical integration jobs, including failures, still gate merges.
 const activeJobUrl='https://github.com/'+repo+'/actions/runs/'+activeIntegrationRunId+'/job/';
 // A superseded branch run may leave cancelled checks at main's SHA.
 // Only waive those cancellations; failed/pending same-name checks still gate.
 const unrelated=checks.check_runs.filter(check=>
  !(check.app?.slug==='github-actions'&&
    ((required.includes(check.name)&&check.status==='completed'&&
       check.conclusion==='cancelled')||
      (check.name==='integrate'&&Number.isSafeInteger(check.id)&&
        check.details_url===activeJobUrl+check.id))));
 if(unrelated.some(check=>check.status!=='completed'||
    !['success','neutral','skipped'].includes(check.conclusion)))return false;
 if(jobs.jobs.some(job=>job.status!=='completed'||job.conclusion!=='success'))return false;
 return required.every(name=>jobs.jobs.some(job=>job.name===name));
}
