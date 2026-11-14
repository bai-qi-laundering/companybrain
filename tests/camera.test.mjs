import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHmac,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {createHandler} from '../backend/app.mjs';
import {createLineService} from '../backend/line.mjs';
import {AssistantStore} from '../backend/assistant-store.mjs';
import {Store} from '../backend/store.mjs';
import {openPglite} from '../scripts/pglite-pool.mjs';
import {cameraDestination,cameraPhotoCommand,cameraBindCommand,pendingPhotoHeader,signedCameraImageUrl,cameraReplyMessages} from '../backend/camera-routing.mjs';

const jpeg=Buffer.concat([Buffer.from([0xff,0xd8]),Buffer.alloc(120,1),Buffer.from([0xff,0xd9])]);
const GROUP='C'+'a'.repeat(32);
const KEY='camera-link-key-for-tests-32b-minimum';

function jpegB64(){return jpeg.toString('base64');}

test('camera destination and staff commands',()=>{
 assert.deepEqual(cameraDestination('H2O客衣'),{hotel:'H2O',label:'H2O客衣',kind:'客衣'});
 assert.deepEqual(cameraDestination(' H2O 制服 '),{hotel:'H2O',label:'H2O制服',kind:'制服'});
 assert.equal(cameraDestination('H2O').kind,null);
 assert.deepEqual(cameraPhotoCommand('#洗前客衣'),{stage:'洗前',kind:'客衣'});
 assert.deepEqual(cameraPhotoCommand('＃洗後制服'),{stage:'洗後',kind:'制服'});
 assert.deepEqual(cameraPhotoCommand(' # 洗前 客衣 '),{stage:'洗前',kind:'客衣'});
 assert.equal(cameraPhotoCommand('洗前客衣'),null);
 assert.equal(cameraPhotoCommand('#洗前客衣照片'),null);
 assert.equal(cameraPhotoCommand('#洗前客衣照片'.normalize('NFKC')),null);
 assert.deepEqual(cameraBindCommand('綁定H2O'),{action:'bind',hotel:'H2O'});
 assert.equal(cameraBindCommand('綁定客衣群組'),null);
 assert.match(pendingPhotoHeader({hotels:['H2O'],stage:'洗前',kind:'客衣',sent:0,remaining:0}),/目前沒有待傳送的H2O 洗前客衣照片/);
 assert.match(pendingPhotoHeader({hotels:['H2O'],stage:'洗前',kind:'客衣',sent:4,remaining:3}),/還有 3 張，請再傳一次「#洗前客衣」/);
 assert.match(pendingPhotoHeader({hotels:['H2O'],stage:'洗前',kind:'客衣',sent:2,remaining:0}),/共 2 張/);
 const url=signedCameraImageUrl('https://fileserver.example', '11111111-1111-4111-8111-111111111111', 1700000000, KEY);
 assert.match(url,/^https:\/\/fileserver\.example\/api\/camera\/image\//);
 assert.throws(()=>cameraReplyMessages('x',['http://insecure.example/a.jpg']),e=>e.status===400);
});

async function fixture(t){
 const {db,pool}=openPglite();
 t.after(()=>db.close());
 const store=new Store(pool);await store.init('admin1','abcdefghijklmnop');
 const assistant=new AssistantStore(store);await assistant.init();
 const replies=[],pushes=[];
 const config={origin:'https://fileserver.example',lineSecret:'secret',lineToken:'token',lineAccess:'friends',garmentAdminUserIds:'U-admin',cameraAdminUserIds:'U-admin',cameraApiKey:'api-key',cameraLinkKey:KEY};
 const fetchImpl=async(url,opts)=>{
  const body=opts?.body?JSON.parse(opts.body):null;
  if(String(url).endsWith('/reply')){replies.push(body);return new Response('',{status:200});}
  if(String(url).endsWith('/push')){pushes.push(body);return new Response('',{status:200});}
  return new Response('',{status:200});
 };
 const line=createLineService({store,config,assistantStore:assistant,fetchImpl});
 const server=http.createServer(createHandler({store,config,htmlPath:new URL('../index.html',import.meta.url),line}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port;
 async function webhook(text,user='U-admin',id=randomUUID(),replyToken='reply-'+id){
  const event={type:'message',source:{type:'group',userId:user,groupId:GROUP},message:{type:'text',text},webhookEventId:id,replyToken};
  const raw=Buffer.from(JSON.stringify({events:[event]}));
  const req=Readable.from([raw]);
  req.headers={'x-line-signature':createHmac('sha256','secret').update(raw).digest('base64')};
  return line.webhook(req);
 }
 async function postPhoto({photoId=randomUUID(),label='H2O客衣',stage='洗前',key='api-key'}={}){
  const res=await fetch(base+'/api/camera/photo',{method:'POST',headers:{Authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({photoId,label,stage,imageBase64:jpegB64()})});
  return {status:res.status,body:await res.json().catch(()=>({}))};
 }
 return {store,assistant,line,replies,pushes,webhook,postPhoto,base,config};
}

test('camera photos stay pending and never push to LINE',async t=>{
 const f=await fixture(t);
 const missing=await f.postPhoto();
 assert.equal(missing.status,409);
 assert.match(String(missing.body.error||''), /尚未綁定/);
 await f.webhook('綁定H2O');
 assert.equal(f.pushes.length,0);
 assert.equal(f.replies.length,1);
 assert.equal(f.replies[0].messages[0].text,'✅ 已綁定：H2O');
 const id=randomUUID();
 const saved=await f.postPhoto({photoId:id,label:'H2O客衣',stage:'洗前'});
 assert.equal(saved.status,200);
 assert.deepEqual(saved.body,{ok:true,duplicate:false,photoId:id,hotel:'H2O',stage:'洗前',kind:'客衣'});
 assert.equal(f.pushes.length,0);
 const row=(await f.assistant.pool.query("SELECT status,hotel,stage,kind FROM cb_camera_photos WHERE id=$1",[id])).rows[0];
 assert.equal(row.status,'pending');
 assert.equal(row.hotel,'H2O');
 assert.equal(row.stage,'洗前');
 assert.equal(row.kind,'客衣');
 const notices=(await f.assistant.pool.query("SELECT id FROM cb_notifications")).rows;
 assert.equal(notices.length,0);
 const rejected=await f.postPhoto({label:'H2O客衣'}); // default stage 洗前 but wait we always send stage
 const noStage=await fetch(f.base+'/api/camera/photo',{method:'POST',headers:{Authorization:'Bearer api-key','content-type':'application/json'},body:JSON.stringify({photoId:randomUUID(),label:'H2O客衣',imageBase64:jpegB64()})});
 assert.equal(noStage.status,400);
});

test('hash commands reply up to four pending photos and leave the rest',async t=>{
 const f=await fixture(t);
 await f.webhook('綁定H2O');
 f.replies.length=0;
 const ids=[];
 for(let i=0;i<5;i++){
  const id=randomUUID();
  ids.push(id);
  assert.equal((await f.postPhoto({photoId:id,label:'H2O客衣',stage:'洗前'})).status,200);
 }
 await f.webhook('#洗前客衣','U-staff','pull-1');
 assert.equal(f.pushes.length,0);
 assert.equal(f.replies.length,1);
 const msg=f.replies[0].messages;
 assert.equal(msg.length,5);
 assert.equal(msg[0].type,'text');
 assert.match(msg[0].text,/先傳送 4 張，還有 1 張，請再傳一次「#洗前客衣」/);
 assert.ok(msg.slice(1).every(m=>m.type==='image'&&m.originalContentUrl.startsWith('https://fileserver.example/api/camera/image/')));
 const first=(await f.assistant.pool.query("SELECT status FROM cb_camera_photos ORDER BY created_at,id")).rows;
 assert.equal(first.filter(r=>r.status==='delivered').length,4);
 assert.equal(first.filter(r=>r.status==='pending').length,1);
 f.replies.length=0;
 await f.webhook('＃洗前客衣','U-staff','pull-2');
 assert.equal(f.replies[0].messages.length,2);
 assert.match(f.replies[0].messages[0].text,/共 1 張/);
 const after=(await f.assistant.pool.query("SELECT status FROM cb_camera_photos")).rows;
 assert.ok(after.every(r=>r.status==='delivered'));
 f.replies.length=0;
 await f.webhook('#洗前客衣','U-staff','pull-3');
 assert.match(f.replies[0].messages[0].text,/目前沒有待傳送的H2O 洗前客衣照片/);
 await f.webhook('洗前客衣','U-staff','ignored');
 assert.equal(f.replies.length,1); // ignored, no extra reply
 // other stage/kind stay untouched
 const other=randomUUID();
 assert.equal((await f.postPhoto({photoId:other,label:'H2O制服',stage:'洗後'})).status,200);
 f.replies.length=0;
 await f.webhook('#洗前客衣','U-staff','pull-4');
 assert.match(f.replies[0].messages[0].text,/目前沒有待傳送/);
 const leftover=(await f.assistant.pool.query("SELECT status,stage,kind FROM cb_camera_photos WHERE id=$1",[other])).rows[0];
 assert.equal(leftover.status,'pending');
});

test('bind confirmations use reply and photo commands are idempotent per event',async t=>{
 const f=await fixture(t);
 await f.webhook('綁定H2O','U-admin','bind-1');
 await f.webhook('綁定H2O','U-admin','bind-1');
 assert.equal(f.replies.length,1);
 f.replies.length=0;
 const id=randomUUID();
 await f.postPhoto({photoId:id});
 await f.webhook('#洗前客衣','U-staff','same-event');
 await f.webhook('#洗前客衣','U-staff','same-event');
 assert.equal(f.replies.length,1);
 const status=(await f.assistant.pool.query("SELECT status FROM cb_camera_photos WHERE id=$1",[id])).rows[0].status;
 assert.equal(status,'delivered');
});
