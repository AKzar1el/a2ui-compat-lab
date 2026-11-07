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
