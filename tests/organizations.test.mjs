import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveOrganization} from '../backend/organizations.mjs';
import {normalizeDraft,initialState} from '../backend/domain.mjs';
import {extractDraft} from '../backend/gemini.mjs';
import {understand} from '../backend/assistant.mjs';
const organizations=[...initialState.organizations,{id:'uuid-intercontinental',name:'高雄洲際飯店',kind:'飯店',aliases:['洲際']}];
const record={kind:'record',orgId:null,date:'2026-10-12',type:'客訴',title:'枕套客訴',note:'同一車',warnings:['洲際不在名錄，請先建檔。']};
test('directory IDs, normalized names, hotel shorthand and explicit aliases resolve without guessing ambiguous parties',()=>{
 assert.equal(resolveOrganization('洲際',organizations).id,'uuid-intercontinental');assert.equal(resolveOrganization('高雄洲際飯店',organizations).id,'uuid-intercontinental');assert.equal(resolveOrganization(null,organizations,'今天洲際客訴').id,'uuid-intercontinental');assert.equal(resolveOrganization('日航',[{id:'hotel',name:'日航飯店'}]).id,'hotel');
 assert.equal(resolveOrganization(null,organizations,'百麒與洲際會議'),null);assert.equal(resolveOrganization('洲際',[...organizations,{id:'other',name:'台北洲際',aliases:['洲際']}]),null);assert.equal(resolveOrganization(null,organizations,'今天陌生飯店客訴'),null);
 const d=normalizeDraft(record,organizations,'今天洲際客訴');assert.equal(d.orgId,'uuid-intercontinental');assert.equal(d.warnings.length,0);const uncertain=normalizeDraft({...record,date:null,warnings:[...record.warnings,'年份不明']},organizations,'洲際客訴');assert(uncertain.warnings.some(w=>w.includes('年份')));assert.equal(normalizeDraft(record,organizations,'陌生對象客訴').orgId,null);
});
test('both draft and query AI results are grounded in the current directory including aliases',async()=>{
 const fake=payload=>async()=>Response.json({candidates:[{content:{parts:[{text:JSON.stringify(payload)}]}}]});const options={text:'2026/10/12洲際客訴',organizations,key:'key',model:'model',fetchImpl:fake(record)};
 assert.equal((await extractDraft(options)).orgId,'uuid-intercontinental');assert.equal((await understand(options)).orgId,'uuid-intercontinental');const q=await understand({...options,text:'洲際有什麼客訴？',fetchImpl:fake({kind:'query',orgIds:['洲際'],keywords:['客訴'],warnings:record.warnings})});assert.deepEqual(q.orgIds,['uuid-intercontinental']);assert.equal(q.warnings.length,0);
});
