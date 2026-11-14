// Camera QR labels are distinct, but their photos go to the same hotel group.
export function cameraDestination(raw){
 const value=String(raw||'').normalize('NFKC').trim().replace(/\s+/g,'');
 if(!value||value.length>80)return null;
 if(value==='客衣')return {hotel:'客衣',label:'客衣'};
 const hotel=value.replace(/(?:制服|客衣)$/u,'');
 if(!hotel||hotel.length>40||!(/^[\p{L}\p{N}_-]+$/u.test(hotel)))return null;
 return {hotel,label:value};
}
export function cameraImageMessages(url,label){
 const parsed=new URL(url);
 if(parsed.protocol!=='https:')throw new Error('LINE image requires HTTPS');
 return [{type:'text',text:'📷 '+label},{type:'image',originalContentUrl:parsed.href,previewImageUrl:parsed.href}];
}
