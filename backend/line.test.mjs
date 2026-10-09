import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createHmac} from 'node:crypto';
import {createLineService,validSignature,draftEntry} from './line.mjs';
import {initialState,AppError} from './domain.mjs';
const config={lineSecret:'test-secret',lineToken:'test-token',lineAllowedUsers:'Uowner',origin:'https://example.test',key:'fake',model:'fake'};
function request(events,signature){const raw=Buffer.from(JSON.stringify({events}));const req=Readable.from([raw]);req.headers={'x-line-signature':signature??createHmac('sha256',config.lineSecret).update(raw).digest('base64')};return req;}
const event=(id,text='出差')=>({webhookEventId:id,type:'message',source:{type:'user',userId:'Uowner'},replyToken:'test-reply',message:{type:'text',text}});
let state={...structuredClone(initialState),revision:0},saves=0,aiCalls=0,conflict=true;const jobs=new Map(),replies=[];
const pool={async connect(){return {query:pool.query,release(){}};},async query(sql,args=[]){if(sql.startsWith('INSERT INTO cb_line_jobs')){if(!jobs.has(args[0]))jobs.set(args[0],{id:args[0],event:args[1],status:'pending'});}
 if(sql.startsWith("UPDATE cb_line_jobs SET status='processing'")){const j=[...jobs.values()].find(j=>j.status==='pending');if(j)j.status='processing';return {rows:j?[j]:[]};}
 if(sql.startsWith('UPDATE cb_line_jobs SET reply_text'))jobs.get(args[0]).reply_text=args[1];
 if(sql.includes("SET status='done'"))jobs.get(args[0]).status='done';
 if(sql.includes("SET status='reply_failed'"))jobs.get(args[0]).status='reply_failed';
 return {rows:[]};}};
const store={pool,async read(){return structuredClone(state);},async save(expected,next){if(conflict){conflict=false;throw new AppError(409,'conflict');}assert.equal(expected,state.revision);saves++;state={...next,revision:expected+1};}};
const draft={kind:'record',orgId:'baiqi',date:'2026-10-18',endDate:'2026-10-23',title:'金澤出差',note:'華航商務艙',type:'出差／展覽',amount:null,warnings:[]};
const line=createLineService({store,config,ai:async()=>{aiCalls++;return draft;},fetchImpl:async(url,o)=>{assert.equal(url,'https://api.line.me/v2/bot/message/reply');replies.push(JSON.parse(o.body));return {ok:true};}});
await line.init();assert.equal(validSignature(Buffer.from('tampered'),'bad',config.lineSecret),false);
await assert.rejects(()=>line.webhook(request([], 'bad')),e=>e.status===401);
await line.webhook(request([]));assert.equal(jobs.size,0);
await line.webhook(request([{...event('unauthorized'),source:{type:'user',userId:'Uother'}},{...event('group'),source:{type:'group',userId:'Uowner'}}]));assert.equal(jobs.size,0);
await line.webhook(request([event('one'),event('one')]));assert.equal(jobs.size,1);
await line.tick();assert.equal(state.records.length,1);assert.equal(saves,1);assert.equal(aiCalls,1);assert.match(replies[0].messages[0].text,/已記錄事項/);
await line.webhook(request([event('one')]));await line.tick();assert.equal(saves,1);
jobs.get('one').status='pending';jobs.get('one').reply_text=null;await line.tick();assert.equal(saves,1);assert.equal(aiCalls,1);
assert.equal(draftEntry({...draft,warnings:['年份不明']},'text','two'),null);
assert.equal(draftEntry({...draft,date:null},'text','two'),null);
assert.equal(draftEntry({...draft,kind:'task',date:null},'text','two').done,false);
const warn=createLineService({store,config,ai:async()=>({...draft,warnings:['年份不明']}),fetchImpl:async()=>({ok:true})});
await warn.webhook(request([event('warning')]));await warn.tick();assert.equal(saves,1);assert.match(jobs.get('warning').reply_text,/尚未儲存/);
const failed=createLineService({store,config,ai:async()=>draft,fetchImpl:async()=>({ok:false,status:400})});await failed.webhook(request([event('reply-failed')]));await failed.tick();assert.equal(saves,2);assert.equal(jobs.get('reply-failed').status,'reply_failed');
console.log('LINE signature, allowlist, empty verify, duplicate recovery, conflict, clarification and reply failure tests passed');
