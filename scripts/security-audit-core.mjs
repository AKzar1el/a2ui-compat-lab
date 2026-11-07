export const exception={advisory:"GHSA-mrhx-c7xc-m3w5",package:"zod",version:"3.25.76",expires:"2026-12-07T00:00:00Z"};
export function analyzeAudit(audit,lock,now=new Date()){
 if(!audit||typeof audit!=="object"||!audit.vulnerabilities||!lock?.packages)throw Error("Incomplete npm audit/lockfile");
 const issues=audit.vulnerabilities, found=[],unapproved=[];
 const pins=Object.entries(lock.packages).filter(([k])=>k==="node_modules/zod"||k.endsWith("/node_modules/zod"));
 const match=pins.length===1 && pins[0][1].version===exception.version;
 const zod=issues.zod;
 const valid=zod?.severity==="high"&&zod?.via?.length===1&&typeof zod.via[0]==="object"&&zod.via[0].url?.includes(exception.advisory)&&match&&Number.isFinite(now.getTime())&&now<new Date(exception.expires);
 function allowed(name,visited=new Set()){
  if(name==="zod")return Boolean(valid);
  if(visited.has(name))return false;
  const item=issues[name];if(!Array.isArray(item?.via)||!item.via.length)return false;
  const next=new Set(visited);next.add(name);
  return item.via.every(v=>typeof v==="string"&&allowed(v,next));
 }
 for(const [name,issue] of Object.entries(issues)){
  if(!Array.isArray(issue?.via))throw Error("Malformed npm advisory "+name);
  (allowed(name)?found:unapproved).push({name,severity:issue.severity,explanation:allowed(name)?"Unresolved known Zod3 advisory / inherited impact":"Unapproved, expired or changed advisory"});
 }
 return {ok:unapproved.length===0,acceptedException:valid?[exception.advisory]:[],knownIssues:found,unapproved,exceptionExpires:exception.expires};
}