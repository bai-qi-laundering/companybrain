import test from 'node:test';
import assert from 'node:assert/strict';
import {garmentNotify} from '../backend/garment-notify.mjs';

const token='a'.repeat(40);
function request(data,authorization='Bearer '+token){
 const req=(async function*(){yield Buffer.from(JSON.stringify(data))})();
 req.headers={authorization};
 return req;
}
test('authorized garment notification queues bound group',async()=>{
 const calls=[];
 const line={db:{pool:{query:async()=>({rows:[{group_id:'C'+'1'.repeat(32)}]})},notify:async(...args)=>calls.push(args)}};
 const result=await garmentNotify(request({eventId:'photo_12345678',message:'客衣拍照成功'}),{line,config:{garmentNotifyToken:token}});
 assert.equal(result.queued,true);
 assert.equal(calls.length,1);
 assert.equal(calls[0][0],'garment-notify:photo_12345678');
 assert.equal(calls[0][1],'C'+'1'.repeat(32));
});
test('rejects invalid authorization before DB access',async()=>{
 const line={db:{pool:{query:()=>{throw Error('must not query DB')}}}};
 await assert.rejects(garmentNotify(request({eventId:'photo_12345678',message:'test'},'Bearer invalid'),{line,config:{garmentNotifyToken:token}}),{status:401});
});
test('requires group binding',async()=>{
 const line={db:{pool:{query:async()=>({rows:[]})},notify:()=>{throw Error('must not notify')}}};
 await assert.rejects(garmentNotify(request({eventId:'photo_12345678',message:'test'}),{line,config:{garmentNotifyToken:token}}),{status:409});
});
