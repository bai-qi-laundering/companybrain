import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHmac} from 'node:crypto';
import {Readable} from 'node:stream';
import {Store} from '../backend/store.mjs';
import {createLineService} from '../backend/line.mjs';
import {retrieve,answerQuestion,describeMedia,expirySummary,taipeiDay} from '../backend/assistant.mjs';
const require=createRequire(new URL('../backend/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite');
async function fixture(t,extra={}){
 const db=new PGlite();t.after(()=>db.close());
 const pool={async query(sql,params){if(!params&&sql.trim().includes(';'))return (await db.exec(sql)).at(-1);const r=await db.query(sql,params?.map(p=>Buffer.isBuffer(p)?p:p&&typeof p==='object'?JSON.stringify(p):p));return {...r,rowCount:r.rows.length||r.affectedRows||0}},async connect(){return {...this,release(){}}}};
 const store=new Store(pool);await store.init('admin1','abcdefghijklmnop');
 const messages=[],pushes=[];let calls=0,clock=new Date('2026-10-09T01:00:00Z'),pushStatus=200;
 const line=createLineService({store,config:{origin:'https://company.test',key:'key',model:'model',lineSecret:'secret',lineToken:'token',lineAllowedUsers:'only-old-user',lineAccess:'friends',...extra},now:()=>clock,
 ai:async({text})=>{calls++;if(extra.failAI)throw new Error('AI temporarily unavailable');return text.includes('查詢')?{kind:'query',keywords:['客訴'],orgIds:[],warnings:[]}:{kind:'record',orgId:'baiqi',date:'2026-10-09',type:'一般紀錄',title:text.slice(0,80),note:text.slice(0,8000),warnings:[]}},
 mediaAI:async({type})=>({text:extra.longMedia?'字'.repeat(8000):type==='audio'?'2026/10/9紀錄秘書出差':'枕套有污漬',uncertain:Boolean(extra.mediaUncertain)}),
 answerAI:async()=>({answer:'依據公司紀錄',sources:[{id:'r1',date:'2026-10-09',title:'客訴',url:'https://company.test/?record=r1'}]}),
 fetchImpl:async(url,opts)=>{if(url.includes('/profile/'))return Response.json({displayName:url.includes('manager')?'經理':'秘書'});if(url.includes('api-data'))return new Response(Buffer.from('original attachment'),{headers:{'content-type':url.includes('/photo/')?'image/jpeg':'audio/mp4'}});const body=JSON.parse(opts.body);if(url.endsWith('/push')){pushes.push({body,key:opts.headers['X-Line-Retry-Key']});return new Response('',{status:pushStatus});}messages.push(body);return new Response('',{status:200});}});
 await line.init();
 async function send(id,user='secretary',message={type:'text',text:'2026/10/9 紀錄'},type='message',timestamp=clock.getTime()){
  const event={type,source:{type:'user',userId:user},message,webhookEventId:id,replyToken:'reply-'+id,timestamp};const raw=Buffer.from(JSON.stringify({events:[event]}));const req=Readable.from([raw]);req.headers={'x-line-signature':createHmac('sha256','secret').update(raw).digest('base64')};await line.webhook(req);await line.tick();
 }
 return {db,pool,store,line,send,messages,pushes,get calls(){return calls},setClock:v=>clock=v,setPushStatus:v=>pushStatus=v};
}
test('all friends share records; duplicate delivery, provenance, photo caption, audio and query',async t=>{
 const f=await fixture(t);await f.send('one');await f.send('two','manager');await f.send('one');
 let s=await f.store.read();assert.equal(s.records.length,2);assert.deepEqual(new Set(s.records.map(r=>r.createdBy)),new Set(['secretary','manager']));assert.equal(f.calls,2);
 await f.send('picture','secretary',{type:'image',id:'photo'});s=await f.store.read();const photo=s.records.find(r=>r.sourceKind==='photo');assert(photo);const media=await f.line.db.media(photo.attachments[0].id,true);assert.equal(Buffer.from(media.body).toString(),'original attachment');assert.equal(media.owner_id,'secretary');
 await f.send('caption','secretary',{type:'text',text:'這張照片是2026/10/9枕套髒污'});s=await f.store.read();assert.equal(s.records.length,3);assert.equal(s.records.find(r=>r.id===photo.id).sourceKind,'photo-caption');assert.equal(s.records.find(r=>r.id===photo.id).attachments.length,1);
 await f.send('voice','manager',{type:'audio',id:'voice',duration:3000});s=await f.store.read();assert.equal(s.records.length,4);assert(s.records.some(r=>r.sourceKind==='voice'&&r.sourceText.includes('秘書出差')));
 await f.send('question','manager',{type:'text',text:'查詢客訴'});assert.equal((await f.store.read()).records.length,4);assert(f.messages.at(-1).messages[0].text.includes('來源'));
 const audit=(await f.pool.query('SELECT * FROM cb_audit')).rows;assert.equal(audit.length,5);assert(audit.some(a=>a.before_data?.sourceKind==='photo'&&a.after_data?.sourceKind==='photo-caption'));
});
test('signed webhooks, optional allowlist and out-of-order unfollow',async t=>{
 const f=await fixture(t,{lineAccess:'allowlist'});await f.send('denied');assert.equal(f.messages.length,0);await f.send('accepted','only-old-user');assert.equal(f.messages.length,1);
 await f.send('unfollow','only-old-user',{},'unfollow',2000);await f.send('old','only-old-user',{type:'text',text:'說明'},'message',1000);assert.equal((await f.line.db.member('only-old-user')).active,true); // older than initial registration, so stale unfollow is ignored
 const req=Readable.from([Buffer.from('{"events":[]}')]);req.headers={'x-line-signature':'bad'};await assert.rejects(f.line.webhook(req),e=>e.status===401);
 const ms=Date.parse('2026-10-10T01:00:00Z');await f.send('blocked','only-old-user',{},'unfollow',ms);await f.send('stale','only-old-user',{type:'text',text:'說明'},'message',ms-1);assert.equal((await f.line.db.member('only-old-user')).active,false);assert.equal(f.messages.length,2);
});
test('daily Taipei reminders reach members once, opt-out and stable push retry keys',async t=>{
 const f=await fixture(t);await f.send('start');await f.send('start2','manager');
 await f.line.db.mutate(s=>({...s,tasks:[{id:'due',title:'確認人事',dueDate:'2026-10-09',org:'baiqi',note:'',done:false}]}),'test');
 f.setClock(new Date('2026-10-09T23:30:00Z'));await f.line.reminderTick();assert.equal(f.pushes.length,0);assert.equal(taipeiDay(new Date('2026-10-09T23:30:00Z')),'2026-10-10');
 f.setClock(new Date('2026-10-10T00:00:00Z'));await f.line.reminderTick();await f.line.reminderTick();await f.line.reminderTick();assert.equal(f.pushes.length,2);assert.equal(new Set(f.pushes.map(p=>p.body.to)).size,2);
 await f.send('off','manager',{type:'text',text:'關閉提醒'});f.setClock(new Date('2026-10-11T00:00:00Z'));f.setPushStatus(503);await f.line.reminderTick();const failed=f.pushes.at(-1);assert.equal(failed.body.to,'secretary');await f.pool.query("UPDATE cb_notifications SET next_attempt=now()-interval '1 minute' WHERE status='pending'");f.setPushStatus(200);await f.line.reminderTick();assert.equal(f.pushes.at(-1).key,failed.key);assert.equal(f.pushes.length,4);
});
test('retrieval filters dates and organizations, valid evidence required, audio MIME mapping',async()=>{
 const state={organizations:[{id:'hotel',name:'日航',contractEndDate:'2026-10-20'}],records:[{id:'old',org:'hotel',date:'2025-10-01',title:'客訴',note:'枕套污漬',amount:100},{id:'new',org:'hotel',date:'2026-10-01',title:'客訴',note:'枕套污漬',amount:200}],tasks:[]};
 const plan={keywords:['客訴'],orgIds:['hotel'],fromDate:'2026-01-01'};const found=retrieve(state,plan);assert.equal(found.total,1);assert.equal(found.amountTotal,200);assert.equal(found.items[0].id,'new');assert.equal(expirySummary(state,'2026-10-09').contracts.length,1);
 const fake=payload=>async()=>Response.json({candidates:[{content:{parts:[{text:JSON.stringify(payload)}]}}]});
 const invalid=await answerQuestion({text:'客訴',state,plan,key:'key',model:'model',origin:'https://company.test',fetchImpl:fake({answer:'捏造的答案',sourceIds:['missing']})});assert(!invalid.answer.includes('捏造'));assert.equal(invalid.sources[0].id,'new');
 let body;await describeMedia({body:Buffer.from('voice'),mime:'audio/mp4',type:'audio',key:'key',model:'model',fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return fake({text:'逐字稿',uncertain:false})()}});assert.equal(body.contents[0].parts[0].inlineData.mimeType,'audio/m4a');
});

test('audio analysis failures and long uncertain transcripts remain accessible as inbox records',async t=>{
 const f=await fixture(t,{failAI:true});await f.send('failed-voice','secretary',{type:'audio',id:'voice',duration:3000});const records=(await f.store.read()).records;assert.equal(records.length,1);assert.equal(records[0].attachments.length,1);assert(records[0].note.includes('AI 分類暫時失敗'));assert(f.messages.at(-1).messages[0].text.includes('已保存語音'));
 const g=await fixture(t,{longMedia:true,mediaUncertain:true});await g.send('long-voice','secretary',{type:'audio',id:'voice',duration:3000});await g.send('long-photo','secretary',{type:'image',id:'photo'});const saved=(await g.store.read()).records;assert.equal(saved.length,2);assert(saved.every(r=>r.note.length<=8000&&r.sourceText.length<=8000));
});
