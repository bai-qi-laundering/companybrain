import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHmac} from 'node:crypto';
import {Readable} from 'node:stream';
import {Store} from '../backend/store.mjs';
import {createLineService} from '../backend/line.mjs';
import {retrieve,answerQuestion,understand,catalogPriceQuery,catalogPriceAnswer,describeMedia,expirySummary,expiryText,taipeiDay} from '../backend/assistant.mjs';
const require=createRequire(new URL('../backend/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite');
async function fixture(t,extra={}){
 const db=new PGlite();t.after(()=>db.close());
 const pool={async query(sql,params){if(!params&&sql.trim().includes(';'))return (await db.exec(sql)).at(-1);const r=await db.query(sql,params?.map(p=>Buffer.isBuffer(p)?p:p&&typeof p==='object'?JSON.stringify(p):p));return {...r,rowCount:r.rows.length||r.affectedRows||0}},async connect(){return {...this,release(){}}}};
 const store=new Store(pool);await store.init('admin1','abcdefghijklmnop');
 const messages=[],pushes=[];let calls=0,clock=new Date('2026-10-09T01:00:00Z'),pushStatus=200;
 const line=createLineService({store,config:{origin:'https://company.test',key:'key',model:'model',lineSecret:'secret',lineToken:'token',lineAllowedUsers:'only-old-user',lineAccess:'friends',...extra},now:()=>clock,
 ai:extra.ai||(extra.realAI?understand:async({text})=>{calls++;if(extra.failAI)throw new Error('AI temporarily unavailable');return text.includes('查詢')?{kind:'query',keywords:['客訴'],orgIds:[],warnings:[]}:{kind:'record',orgId:'baiqi',date:'2026-10-09',type:'一般紀錄',title:text.slice(0,80),note:text.slice(0,8000),warnings:[]}}),
 mediaAI:async({type})=>({text:extra.longMedia?'字'.repeat(8000):type==='audio'?'2026/10/9紀錄秘書出差':'枕套有污漬',uncertain:Boolean(extra.mediaUncertain)}),
 answerAI:extra.answerAI||(extra.realAI?answerQuestion:async()=>({answer:'依據公司紀錄',sources:[{id:'r1',date:'2026-10-09',title:'客訴',url:'https://company.test/?record=r1'}]})),
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
 await f.send('question','manager',{type:'text',text:'查詢客訴'});assert.equal((await f.store.read()).records.length,4);assert(!f.messages.at(-1).messages[0].text.includes('來源'));
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
 await f.line.db.mutate(s=>({...s,tasks:[{id:'due',title:'確認人事',dueDate:'2026-10-11',org:'baiqi',note:'',done:false}]}),'test');
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

test('dated LINE tasks save without an organization or AI, and redelivery is idempotent',async t=>{
 const f=await fixture(t,{failAI:true});await f.send('direct-task','secretary',{type:'text',text:'幫我加入10/15待辦：跟媽媽吃飯'});await f.send('direct-task','secretary',{type:'text',text:'幫我加入10/15待辦：跟媽媽吃飯'});
 const s=await f.store.read();assert.equal(s.tasks.length,1);assert.equal(s.records.length,0);assert.equal(s.tasks[0].org,null);assert.equal(s.tasks[0].dueDate,'2026-10-15');assert.equal(s.tasks[0].title,'跟媽媽吃飯');assert.equal(s.tasks[0].createdBy,'secretary');assert.equal(f.calls,0);assert(f.messages[0].messages[0].text.includes('已記錄待辦'));
});

test('supplier free-form price descriptions are searchable and retained in answer evidence',()=>{
 const state={organizations:[{id:'salt',name:'原料商',prices:[],priceNotes:'鹽 50kg/包 $245'}],records:[],tasks:[]};const found=retrieve(state,{keywords:['鹽'],orgIds:[]});assert.equal(found.organizationTotal,1);assert.equal(found.organizations[0].priceNotes,'鹽 50kg/包 $245');assert.equal(retrieve(state,{keywords:['價格'],orgIds:[]}).organizationTotal,1);
});
test('all hotel sheet prices are listed concisely even after the first 40 organizations',async()=>{
 const organizations=Array.from({length:45},(_,i)=>({id:'hotel-'+i,name:'飯店'+i,kind:'飯店',prices:[],priceNotes:''}));
 organizations[2]={...organizations[2],name:'然一',prices:[['床單',21.3,'2026-10-01']]};
 organizations[44]={...organizations[44],name:'驛館',priceNotes:'床單 $25.0\n浴巾 $18'};
 organizations.push({id:'supplier',name:'供應商',kind:'原料商',prices:[['床單',9,'2026-10-01']]});
 const state={organizations,records:[],tasks:[]},question='所有飯店床單價格';
 const expected='資料庫紀錄\n1. 然一：床單 $21.3\n2. 驛館：床單 $25.0';
 assert.equal(catalogPriceAnswer(question,state),expected);
 const answer=await answerQuestion({text:question,state,plan:{warnings:[],keywords:['飯店','床單','價格'],orgIds:[]},key:'key',model:'model',origin:'https://company.test',fetchImpl:()=>{throw Error('價格查詢應從完整名錄讀取')}});
 assert.equal(answer.answer,expected);assert.deepEqual(answer.sources,[]);
});

test('LINE sends links only for photo records; text, tasks, audio, help, queries and reminders omit URLs',async t=>{
 const f=await fixture(t);const last=()=>f.messages.at(-1).messages[0].text;
 await f.send('help','secretary',{type:'text',text:'說明'});assert(!last().includes('https://'));await f.send('text');assert(!last().includes('https://'));await f.send('task','secretary',{type:'text',text:'明天待辦：去郵局'});assert(!last().includes('https://'));await f.send('question','secretary',{type:'text',text:'查詢客訴'});assert(!last().includes('來源'));assert(!last().includes('https://'));
 await f.send('audio','secretary',{type:'audio',id:'voice',duration:3000});assert(!last().includes('https://'));await f.send('photo','secretary',{type:'image',id:'photo'});assert(last().includes('查看照片：https://'));await f.send('caption','secretary',{type:'text',text:'這張照片是2026/10/9枕套客訴'});assert(last().includes('查看照片：https://'));
 await f.send('expiry','secretary',{type:'text',text:'查看到期'});assert(!last().includes('https://'));
});

test('reminders include only incomplete today and tomorrow tasks, with unchanged 30-day contracts across year boundaries',()=>{
 const day='2026-12-31',state={organizations:[{id:'today-contract',name:'當日到期',contractEndDate:day},{id:'limit',name:'三十天',contractEndDate:'2027-01-30'},{id:'future',name:'三十一天',contractEndDate:'2027-01-31'},{id:'old',name:'舊合約',contractEndDate:'2026-12-30'}],records:[],tasks:[{id:'old',title:'逾期',dueDate:'2026-12-30',done:false},{id:'today',title:'今天工作',dueDate:day,done:false},{id:'tomorrow',title:'明天工作',dueDate:'2027-01-01',done:false},{id:'later',title:'後天',dueDate:'2027-01-02',done:false},{id:'done',title:'已完成',dueDate:day,done:true},{id:'none',title:'未定日期',dueDate:null,done:false}]};
 const s=expirySummary(state,day);assert.deepEqual(s.tasks.map(t=>t.id),['today','tomorrow']);assert.deepEqual(s.contracts.map(c=>c.id),['today-contract','limit']);const text=expiryText(s);assert(text.includes('今日到期｜2026-12-31｜今天工作'));assert(text.includes('明日到期｜2027-01-01｜明天工作'));assert(!text.includes('逾期'));assert(!text.includes('後天'));assert.equal(expirySummary({...state,tasks:[]},day).contracts.length,2);
 assert(expiryText(expirySummary({organizations:[],tasks:[],records:[]},day)).includes('今天／明天'));
});

test('a dated hotel LINE task and its history are saved together once and retained on completion',async t=>{
 const f=await fixture(t,{failAI:true});let state=await f.store.read();const org={...state.organizations[0],id:'boli',name:'鉑麗飯店',kind:'飯店'};await f.store.save(state.revision,{...state,organizations:[...state.organizations,org]},'test');
 await f.send('linked-task','secretary',{type:'text',text:'10/14 待辦：鉑麗送全部第一次布品清洗'});await f.send('linked-task','secretary',{type:'text',text:'10/14 待辦：鉑麗送全部第一次布品清洗'});
 state=await f.store.read();assert.equal(state.tasks.length,1);assert.equal(state.records.length,1);assert.equal(state.tasks[0].org,'boli');assert.equal(state.records[0].org,'boli');assert.equal(state.records[0].date,'2026-10-14');assert.equal(state.records[0].linkedTaskId,state.tasks[0].id);assert(state.records[0].note.includes('不代表已完成'));assert.equal(f.calls,0);assert.equal(retrieve(state,{orgIds:['boli'],keywords:[]}).total,1);
 await f.store.save(state.revision,{...state,tasks:state.tasks.map(x=>({...x,done:true}))},'test');assert.equal((await f.store.read()).records.length,1);
});

test('all bath towel prices bypass Gemini for planning and answers and search beyond 40 organizations',async()=>{
 const state={organizations:Array.from({length:65},(_,i)=>({id:'h'+i,name:'飯店'+i,kind:'飯店',prices:i===64?[['大浴巾',18,'2026-10-01']]:[],priceNotes:i===1?'浴巾 70×140cm $20/條\n床單 $22':''})),records:[],tasks:[]};
 state.organizations.push({id:'supplier',name:'原料商',kind:'供應商',prices:[['浴巾',9,'2026-10-01']]});
 const noAI=()=>{throw Error('查價不應呼叫 Gemini')};
 for(const text of ['所有飯店浴巾價格','幫我查所有飯店浴巾價格是多少？']){
  const plan=await understand({text,organizations:state.organizations,fetchImpl:noAI});assert.equal(plan.kind,'query');assert.equal(plan.item,'浴巾');assert.equal(plan.hotelOnly,true);
  const r=await answerQuestion({text,state,plan,fetchImpl:noAI});assert.equal(r.answer,'資料庫紀錄\n1. 飯店1：浴巾 70×140cm $20/條\n2. 飯店64：大浴巾 $18');assert.deepEqual(r.sources,[]);
 }
 const all=catalogPriceAnswer('所有浴巾價格',state);assert(all.includes('原料商：浴巾 $9'));
 assert.equal(catalogPriceQuery('紀錄所有飯店浴巾價格改成20'),null);assert.equal(catalogPriceQuery('所有飯店價格'),null);
 assert.equal(catalogPriceAnswer('所有飯店枕頭套價格',state),'資料庫紀錄\n尚無飯店枕頭套價格。');
 const many={...state,organizations:Array.from({length:200},(_,i)=>({id:'x'+i,name:'飯店名稱'.repeat(10)+i,kind:'飯店',prices:[['浴巾',18,'2026-10-01']]}))};
 const long=catalogPriceAnswer('所有飯店浴巾價格',many);assert(long.length<4900);assert(long.includes('共 200 家'));assert(long.includes('其餘請在網頁查看'));
});
test('LINE replies to all hotel bath towel prices even while Gemini is unavailable without writing records',async t=>{
 const f=await fixture(t,{realAI:true});let state=await f.store.read();await f.store.save(state.revision,{...state,organizations:[...state.organizations,{...state.organizations[0],id:'hotel',name:'測試飯店',kind:'飯店',prices:[['浴巾',18,'2026-10-01']]}]},'test');
 await f.send('price-query','secretary',{type:'text',text:'所有飯店浴巾價格'});
 assert.equal(f.messages.at(-1).messages[0].text,'資料庫紀錄\n1. 測試飯店：浴巾 $18');state=await f.store.read();assert.equal(state.records.length,0);assert.equal(state.tasks.length,0);
});

test('LINE conversations are per-user, limited to six recent rounds, survive a new service, and never save chat as records',async t=>{
 const seen=[],ai=async input=>{seen.push(input);return {kind:'chat',reply:'回覆：'+input.text,warnings:[]}},f=await fixture(t,{ai,answerAI:answerQuestion});
 await f.send('chat-a','secretary',{type:'text',text:'你好，幫我想一段問候語'});await f.send('chat-b','manager',{type:'text',text:'經理自己的對話'});
 await f.send('chat-c','secretary',{type:'text',text:'那幫我縮短一點'});assert.equal(seen.at(-1).history.length,1);assert.equal(seen.at(-1).history[0].text,'你好，幫我想一段問候語');assert(seen.at(-1).history[0].reply.includes('回覆：'));assert(!JSON.stringify(seen.at(-1).history).includes('經理自己的對話'));
 for(let i=0;i<7;i++)await f.send('more-chat-'+i,'secretary',{type:'text',text:'追問'+i});assert.equal(seen.at(-1).history.length,6);
 const before=seen.length;await f.send('more-chat-6','secretary',{type:'text',text:'追問6'});assert.equal(seen.length,before);
 const state=await f.store.read();assert.equal(state.records.length,0);assert.equal(state.tasks.length,0);
 // A fresh store instance reads persisted context; no in-memory conversation map.
 const {AssistantStore}=await import('../backend/assistant-store.mjs');const fresh=new AssistantStore(f.store);const current=await f.pool.query("INSERT INTO cb_line_jobs(id,event) VALUES('future-chat',$1) RETURNING id",[{type:'message',source:{userId:'secretary'},message:{type:'text',text:'接下來'}}]);assert.equal((await fresh.conversation('secretary',current.rows[0].id)).length,6);
 await f.pool.query("UPDATE cb_line_jobs SET created_at=now()-interval '25 hours' WHERE id<>'future-chat'");assert.equal((await fresh.conversation('secretary','future-chat')).length,0);
});
test('general chat uses one Gemini response and follow-up planning receives context without turning questions into writes',async()=>{
 const fake=payload=>async()=>Response.json({candidates:[{content:{parts:[{text:JSON.stringify(payload)}]}}]});
 const history=[{text:'老闆什麼時候去越南',reply:'董事長的候選行程為2026/11/7–11/9'}];let body;
 const plan=await understand({text:'那幾號回來？',organizations:[],history,key:'key',model:'model',fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return fake({kind:'query',keywords:['越南','出差'],orgIds:[],fromDate:null,toDate:null,warnings:[]})()}});
 assert.equal(plan.kind,'query');const sent=JSON.parse(body.contents[0].parts[0].text);assert.equal(sent.history[0].message,history[0].text);assert.equal(sent.message,'那幾號回來？');assert(plan.keywords.includes('越南'));
 const guarded=await understand({text:'老闆什麼時候去越南？',organizations:[],key:'key',model:'model',fetchImpl:fake({kind:'task',title:'越南出差',orgId:null,date:'2026-11-07',warnings:['缺少對象']})});assert.equal(guarded.kind,'query');assert.deepEqual(guarded.warnings,[]);
 const writingGuard=await understand({text:'幫我寫一句工作問候',organizations:[],key:'key',model:'model',fetchImpl:fake({kind:'record',title:'工作問候',orgId:'baiqi',date:'2026-10-25'})});assert.equal(writingGuard.kind,'chat');
 const chat=await understand({text:'幫我寫一句工作問候',organizations:[],key:'key',model:'model',fetchImpl:fake({kind:'chat',chatReply:'今天也一起把工作做好。'})});assert.equal(chat.kind,'chat');
 const r=await answerQuestion({text:'幫我寫一句工作問候',state:{organizations:[],records:[],tasks:[]},plan:chat,fetchImpl:()=>{throw Error('chat reply already generated')}});assert.equal(r.answer,'今天也一起把工作做好。');assert.deepEqual(r.sources,[]);
});
test('full-pool search ranks older Vietnam trip above generic boss mentions and invalid citations show grounded candidate dates',async()=>{
 const state={organizations:[{id:'baiqi',name:'百麒',kind:'內部'}],records:Array.from({length:75},(_,i)=>({id:'m'+i,org:'baiqi',date:'2026-10-25',type:'會議',title:'老闆開會',note:'討論日常工作',amount:null})),tasks:[]};
 state.records.push({id:'vietnam-trip',org:'baiqi',date:'2026-11-07',endDate:'2026-11-09',type:'出差／展覽',title:'董事長越南出差',note:'參訪洗滌廠',amount:null});
 const plan={kind:'query',keywords:['老闆','越南出差'],orgIds:[],warnings:[]},evidence=retrieve(state,plan,'老闆什麼時候去越南');assert.equal(evidence.items[0].id,'vietnam-trip');assert.equal(retrieve(state,{keywords:['客訴'],orgIds:[]}).total,0);
 const result=await answerQuestion({text:'老闆什麼時候去越南',state,plan,key:'key',model:'model',origin:'https://company.test',fetchImpl:async()=>Response.json({candidates:[{content:{parts:[{text:JSON.stringify({answer:'錯誤的捏造內容',sourceIds:['不是有效編號']})}]}}]})});
 assert(result.answer.includes('候選紀錄'));assert(result.answer.includes('2026-11-07～2026-11-09'));assert(result.answer.includes('董事長越南出差'));assert(!result.answer.includes('捏造'));assert(!result.answer.includes('請在網頁確認'));assert.equal(result.sources[0].id,'vietnam-trip');
});

test('short AI reference labels map back to real source IDs without discarding a grounded answer',async()=>{
 const state={organizations:[],records:[{id:'line-long-real-record-id',date:'2026-11-07',endDate:'2026-11-09',title:'越南出差',note:'11/9回國',type:'出差／展覽'}],tasks:[]};let sent;
 const r=await answerQuestion({text:'幾號回來',state,plan:{kind:'query',keywords:['越南'],orgIds:[],warnings:[]},key:'key',model:'model',origin:'https://company.test',fetchImpl:async(u,o)=>{sent=JSON.parse(JSON.parse(o.body).contents[0].parts[0].text);return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({answer:'資料庫紀錄\n越南出差於2026/11/9回國。',sourceIds:['R1']})}]}}]})}});
 assert.equal(sent.evidence.items[0].ref,'R1');assert(r.answer.includes('2026/11/9回國'));assert(!r.answer.includes('候選'));assert.equal(r.sources[0].id,'line-long-real-record-id');
});
