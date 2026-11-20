import {AppError} from './domain.mjs';
import {createHmac} from 'node:crypto';

/** QR labels may end in 客衣 or 制服; photos still go to the same hotel group. */
export function cameraDestination(raw){
 const value=String(raw||'').normalize('NFKC').trim().replace(/\s+/g,'');
 if(!value||value.length>80)return null;
 if(value==='客衣')return {hotel:'客衣',label:'客衣',kind:null};
 const kind=/(?:制服)$/u.test(value)?'制服':/(?:客衣)$/u.test(value)?'客衣':null;
 const hotel=value.replace(/(?:制服|客衣)$/u,'');
 if(!hotel||hotel.length>40||!(/^[\p{L}\p{N}_-]+$/u.test(hotel)))return null;
 return {hotel,label:value,kind};
}

/** Staff pull commands: #洗前客衣 / #洗後客衣 / #洗前制服 / #洗後制服 (fullwidth ＃ accepted via NFKC). */
export function cameraPhotoCommand(text){
 const normalized=String(text||'').normalize('NFKC').replace(/\s+/g,'').trim();
 if(!/^#(?:洗前|洗後)(?:客衣|制服)$/u.test(normalized))return null;
 return {stage:normalized.includes('洗前')?'洗前':'洗後',kind:normalized.includes('客衣')?'客衣':'制服'};
}

export function cameraBindCommand(text){
 const normalized=String(text||'').normalize('NFKC').replace(/\s+/g,'').trim();
 if(normalized==='綁定客衣群組'||normalized==='查詢客衣群組')return null;
 const bind=/^綁定([\p{L}\p{N}_-]{1,40})$/u.exec(normalized);
 if(bind)return {action:'bind',hotel:bind[1]};
 const unbind=/^解除綁定([\p{L}\p{N}_-]{1,40})$/u.exec(normalized);
 if(unbind)return {action:'unbind',hotel:unbind[1]};
 if(normalized==='查詢綁定'||normalized==='綁定查詢')return {action:'lookup'};
 return null;
}

export function signedCameraImageUrl(origin,id,expiry,key,kind='original'){
 const sig=createHmac('sha256',key).update(id+':'+expiry).digest('hex');
 const preview=kind==='preview'?'&preview=1':'';
 return String(origin)+'/api/camera/image/'+id+'?expires='+expiry+'&sig='+sig+preview;
}

export function cameraImageMessages(url,label){
 return cameraReplyMessages('📷 '+label,[url]);
}

export function cameraReplyMessages(header,urls){
 const messages=[{type:'text',text:String(header)}];
 for(const url of urls){
  const original=typeof url==='string'?url:url.original;
  const preview=typeof url==='string'?url:(url.preview||url.original);
  const parsed=new URL(original);
  const previewParsed=new URL(preview);
  if(parsed.protocol!=='https:'||previewParsed.protocol!=='https:')throw new AppError(400,'照片網址必須使用 HTTPS');
  messages.push({type:'image',originalContentUrl:parsed.href,previewImageUrl:previewParsed.href});
 }
 return messages;
}

export function pendingPhotoHeader({hotels,stage,kind,sent,remaining}){
 const who=(hotels||[]).filter(Boolean).join('、')||'本群組';
 const label=String(stage)+String(kind);
 if(!sent)return '目前沒有待傳送的'+who+' '+label+'照片。';
 if(remaining>0)return '📷 '+who+' '+label+'，先傳送 '+sent+' 張，還有 '+remaining+' 張，請再傳一次「#'+label+'」。';
 return '📷 '+who+' '+label+'，共 '+sent+' 張。';
}
