import test from 'node:test';
import assert from 'node:assert/strict';
import {garmentBindingCommand,createLineService} from '../backend/line.mjs';
import {createHmac} from 'node:crypto';

test('garment command normalization',()=>{
 assert.equal(garmentBindingCommand('綁定客衣群組'),'bind');
 assert.equal(garmentBindingCommand(' 綁定 客衣群組 '),'bind');
 assert.equal(garmentBindingCommand('查詢客衣群組'),'status');
 assert.equal(garmentBindingCommand('一般群組聊天'),null);
});

test('authorized group command never enters personal AI queue',async()=>{
 const sent=[],queued=[],bindings=[],config={lineSecret:'test-secret',lineToken:'token',garmentAdminUserIds:'U-admin',lineAccess:'friends'};
 const db={
  garmentGroupCommand:async(g,c,id,u)=>{bindings.push([g,c,id,u]);return {message:'ok'};},
  notify:async(...args)=>sent.push(args),
  register:async()=>{},enqueue:async e=>queued.push(...e)
 };
 const service=createLineService({store:{},config,assistantStore:db});
 async function fire(user,text,id,type='group'){
  const event={type:'message',source:{type,userId:user,groupId:'C'+'1'.repeat(32)},message:{type:'text',text},webhookEventId:id,replyToken:'reply'};
  const raw=Buffer.from(JSON.stringify({events:[event]}));
  const signature=createHmac('sha256','test-secret').update(raw).digest('base64');
  const req=(async function*(){yield raw;})();
  req.headers={'x-line-signature':signature};
  await service.webhook(req);
 }
 await fire('U-other','綁定客衣群組','one');
 await fire('U-admin','普通訊息','two');
 await fire('U-admin','綁定客衣群組','three');
 assert.equal(bindings.length,1);
 assert.equal(sent.length,1);
 assert.equal(queued.length,0);
 assert.equal(bindings[0][0],'C'+'1'.repeat(32));
});
