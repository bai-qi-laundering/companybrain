import {searchOrganizations, queryNeedles, isWeakSearchTerm} from './search.mjs';
const normalize=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[\s·・．.（）()／/—–-]/g,'');
export function organizationNames(o){const names=[o.name,...(o.aliases||[]),...(o.keywords||[])];for(const name of [...names]){const short=String(name).replace(/(?:股份有限公司|有限公司|飯店|酒店|旅館|企業社|公司)$/,'');if(short!==name&&normalize(short).length>=2)names.push(short)}return [...new Set(names.filter(Boolean))]}
export function resolveOrganization(value,organizations,text='',linked={}){
 const id=organizations.find(o=>o.id===value);if(id)return id;
 const key=normalize(value),exact=key?organizations.filter(o=>organizationNames(o).some(name=>normalize(name)===key)):[];
 if(exact.length)return exact.length===1?exact[0]:null;
 const input=normalize(text),matches=organizations.map(o=>({o,score:Math.max(0,...organizationNames(o).map(name=>{const key=normalize(name);return key.length>=2&&input.includes(key)?key.length:0}))})).filter(x=>x.score>0);
 // Do not pick a party from a message mentioning multiple directory entries.
 if(matches.length>1)return null;
 if(matches.length===1)return matches[0].o;
 const q=String(value||text||'').trim();
 if(!q)return null;
 const needles=queryNeedles(q,{fromQuestion:true}).filter(term=>!isWeakSearchTerm(term));
 if(!needles.length)return null;
 const hits=searchOrganizations({organizations,records:linked.records||[],tasks:linked.tasks||[]},q,{needles,fromQuestion:true});
 const strong=hits.filter(h=>h.matchType==='keyword'||h.matchType==='name'||h.matchType==='alias'||h.matchType==='content');
 if(strong.length===1)return strong[0].org;
 return null;
}
export function clearResolvedOrganizationWarnings(warnings){return warnings.filter(w=>!(/對象|名錄|建檔|找不到.*(?:飯店|酒店)/.test(w)&&!/日期|年份|時間|金額|數量/.test(w)))}
