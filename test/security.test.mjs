import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeAudit,exception} from '../scripts/security-audit-core.mjs';
const lock={packages:{'node_modules/zod':{version:'3.25.76'}}};
const known={severity:'high',via:[{url:'https://github.com/advisories/'+exception.advisory}]};
const data=vulnerabilities=>({vulnerabilities});
test('known pinned Zod3 exposure is disclosed with transitive wrappers',()=>{
 const r=analyzeAudit(data({zod:known,'@a2ui/web_core':{severity:'high',via:['zod']}}),lock,new Date('2026-11-07'));
 assert.equal(r.ok,true);assert.equal(r.knownIssues.length,2);assert.deepEqual(r.acceptedException,[exception.advisory]);
});
test('unapproved new direct advisory and inherited advisory fail closed',()=>{
 const r=analyzeAudit(data({zod:known,vite:{severity:'high',via:[{url:'GHSA-new'}]}}),lock,new Date('2026-11-07'));
 assert.equal(r.ok,false);assert.equal(r.unapproved[0].name,'vite');
});
test('expired exception and unexpected Zod version cannot pass',()=>{
 assert.equal(analyzeAudit(data({zod:known}),lock,new Date('2026-12-08')).ok,false);
 assert.equal(analyzeAudit(data({zod:known}),{packages:{'node_modules/zod':{version:'3.25.75'}}},new Date('2026-11-07')).ok,false);
});
test('clean audit is valid while malformed reports are rejected',()=>{
 assert.equal(analyzeAudit(data({}),{packages:{}},new Date('2026-11-07')).ok,true);
 assert.throws(()=>analyzeAudit({},lock),/Incomplete/);
});
