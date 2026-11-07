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
 if(pr.head?.repo?.full_name!==repo||!pr.head?.ref?.startsWith('revshot/'))return 'unexpected source branch';
 if(pr.user?.login!=='AKzar1el')return 'not owner authored';
 if(pr.mergeable!==true||pr.mergeable_state!=='clean')return 'unresolved mergeability';
 if(pr.requested_reviewers?.length||pr.requested_teams?.length)return 'human review requested';
 if((pr.labels||[]).some(x=>['hold','do-not-merge','security-hold','manual-release','needs-owner-review'].includes(x.name?.toLowerCase())))return 'review hold label';
 const line='MERGER_HANDOFF: '+repo+'@'+pr.head.sha;
 const matches=(pr.body||'').split(/\r?\n/).map(x=>x.trim()).filter(x=>x.startsWith('MERGER_HANDOFF: '));
 if(matches.length!==1||matches[0]!==line)return 'missing or stale exact-SHA handoff';
 return null;
}

export function checksGreen(result, required) {
 if(!Array.isArray(result?.check_runs) || result.total_count >= 100) return false;
 // Ignore ONLY the current guarded merger's own job, which is necessarily
 // in progress while performing this check. Other security/CI jobs still gate.
 const relevant = result.check_runs.filter(x =>
  !(x.name === 'integrate' && x.app?.slug === 'github-actions'));
 if(relevant.some(x => x.status !== 'completed' ||
   !['success','neutral','skipped'].includes(x.conclusion))) return false;
 return required.every(name =>
  relevant.some(x => x.name === name && x.status === 'completed' && x.conclusion === 'success'));
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
    checks.total_count>=100||checks.check_runs.length!==checks.total_count||
    !Array.isArray(jobs?.jobs)||!Number.isSafeInteger(jobs.total_count)||
    jobs.total_count>=100||jobs.jobs.length!==jobs.total_count)return false;
 // Only the currently executing integration job may remain in progress.
 // Other historical integration jobs, including failures, still gate merges.
 const activeJobUrl='https://github.com/'+repo+'/actions/runs/'+activeIntegrationRunId+'/job/';
 const unrelated=checks.check_runs.filter(check=>
  !(check.app?.slug==='github-actions'&&
    (required.includes(check.name)||
      (check.name==='integrate'&&Number.isSafeInteger(check.id)&&
        check.details_url===activeJobUrl+check.id))));
 if(unrelated.some(check=>check.status!=='completed'||
    !['success','neutral','skipped'].includes(check.conclusion)))return false;
 if(jobs.jobs.some(job=>job.status!=='completed'||job.conclusion!=='success'))return false;
 return required.every(name=>jobs.jobs.some(job=>job.name===name));
}
