import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {analyzeAudit,exception} from './security-audit-core.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const checks=[['sdk',root],['renderer',join(root,'renderer-react')]];
const reports=[];
try {
 for (const [name,cwd] of checks) {
  const npm=process.platform==='win32'?'npm.cmd':'npm';
  const run=spawnSync(npm,['audit','--json','--audit-level=low'],{
   cwd,encoding:'utf8',shell:process.platform==='win32',timeout:90000,maxBuffer:6000000});
  if(run.error||(run.status!==0&&run.status!==1))throw Error(name+' audit could not run: '+String(run.error?.code||run.status));
  let report;
  try{report=JSON.parse(run.stdout)}catch{throw Error(name+' registry returned invalid audit JSON')}
  if(report.error||!report.vulnerabilities)throw Error(name+' audit failed / registry unreachable');
  const lock=JSON.parse(readFileSync(join(cwd,'package-lock.json'),'utf8'));
  reports.push({name,...analyzeAudit(report,lock)});
 }
 const output={version:1,ok:reports.every(x=>x.ok),unresolvedAdvisory:exception.advisory,note:'Zod3 vulnerability is NOT resolved. See SECURITY.md.',reports};
 const index=process.argv.indexOf('--out');
 if(index>=0){if(!process.argv[index+1])throw Error('--out requires path');const file=resolve(process.argv[index+1]);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(output,null,2)+'\n')}
 console.log(JSON.stringify(output,null,2));
 if(process.argv.includes('--strict')&&!output.ok)process.exitCode=1;
}catch(e){console.error('Security audit refused: '+e.message);process.exitCode=2}
