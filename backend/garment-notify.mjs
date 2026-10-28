import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {AppError} from './domain.mjs';

function safeTokenEquals(provided, expected) {
 if(typeof provided!=='string'||typeof expected!=='string'||!expected)return false;
 const a=createHash('sha256').update(provided).digest();
 const b=createHash('sha256').update(expected).digest();
 return timingSafeEqual(a,b);
}

export async function garmentNotify(req, {line,config}) {
 const expected=config.garmentNotifyToken;
 if(!expected||expected.length<32)throw new AppError(503,'客衣通知 API 尚未設定');
 const authorization=req.headers.authorization||'';
 const provided=/^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(authorization)?.[1]||'';
 if(!safeTokenEquals(provided,expected))throw new AppError(401,'通知授權失敗');
 let size=0;
 const chunks=[];
 for await(const chunk of req) {
  size+=chunk.length;
  if(size>4096)throw new AppError(413,'通知內容過大');
  chunks.push(chunk);
 }
 let payload;
 try{payload=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw new AppError(400,'通知 JSON 格式不正確')}
 const eventId=payload?.eventId;
 const message=payload?.message;
 if(typeof eventId!=='string'||! /^[a-zA-Z0-9_-]{8,100}$/.test(eventId))throw new AppError(400,'eventId 格式不正確');
 if(typeof message!=='string'||message.length<1||message.length>1000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(message))throw new AppError(400,'通知文字不正確');
 const binding=await line.db.pool.query("SELECT group_id FROM cb_garment_group_binding WHERE kind='garment'");
 const groupId=binding.rows[0]?.group_id;
 if(!groupId)throw new AppError(409,'尚未綁定客衣群組');
 await line.db.notify('garment-notify:'+eventId,groupId,{messages:[{type:'text',text:message}]},randomUUID());
 return {ok:true,queued:true};
}
