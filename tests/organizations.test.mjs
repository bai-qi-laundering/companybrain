import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveOrganization} from '../backend/organizations.mjs';
import {normalizeDraft,initialState} from '../backend/domain.mjs';
import {extractDraft} from '../backend/gemini.mjs';
import {understand,answerQuestion} from '../backend/assistant.mjs';
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

test('recent complaints use stored records newest first without guessed time windows or exact complaint keywords',async()=>{
 const orgs=[{id:'jiahe',name:'家和飯店',kind:'飯店'}, {id:'other',name:'其他飯店',kind:'飯店'}];
 const plan=await understand({text:'最近家和客訴',organizations:orgs,fetchImpl:()=>{throw Error('short complaint query should not need AI')}});
 assert.equal(plan.kind,'query');assert.deepEqual(plan.orgIds,['jiahe']);assert.equal(plan.fromDate,null);
 const records=Array.from({length:7},(_,i)=>({id:'r'+i,org:'jiahe',date:'2026-09-'+String(i+1).padStart(2,'0'),type:'一般紀錄',title:'飯店反映床單髒污',note:'需改善',sourceText:''}));
 records.push({id:'unrelated',org:'other',date:'2026-10-14',type:'客訴',title:'其他客訴',note:''},{id:'meeting',org:'jiahe',date:'2026-10-13',type:'一般紀錄',title:'會議',note:''});
 const result=await answerQuestion({text:'最近家和客訴',state:{organizations:orgs,records,tasks:[]},plan,fetchImpl:()=>{throw Error('complaint answer should use database directly')}});
 assert.equal(result.sources.length,5);assert.equal(result.sources[0].id,'r6');assert.equal(result.sources[4].id,'r2');assert(result.answer.startsWith('資料庫紀錄'));assert(result.answer.includes('共 7 筆'));assert(!result.answer.includes('其他客訴'));
 const explicit=await answerQuestion({text:'最近家和客訴',state:{organizations:orgs,records:[],tasks:[]},plan});assert(explicit.answer.includes('尚無家和飯店客訴紀錄'));
});
