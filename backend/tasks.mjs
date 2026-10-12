import {AppError,dateOK} from './domain.mjs';

// Explicit dated tasks can be saved without AI or a directory entry.
export function parseTaskCommand(text,now=new Date()) {
 const input=String(text).normalize('NFKC').trim();
 if(!/待辦(?:事項|清單)?/.test(input)||/查詢|查看|列出|有哪些|有什麼|有甚麼|幾件|[?？]/.test(input))return null;
 const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 const matches=[...input.matchAll(/(?:\d{4}[\/-])?\d{1,2}[\/-]\d{1,2}|(?:\d{4}年)?\d{1,2}月\d{1,2}[日號]?|大後天|後天|明天|今天/g)];
 if(matches.length!==1)return null;
 const token=matches[0][0];let date;
 if(['今天','明天','後天','大後天'].includes(token)){
  const value=new Date(day+'T00:00:00Z');value.setUTCDate(value.getUTCDate()+['今天','明天','後天','大後天'].indexOf(token));date=value.toISOString().slice(0,10);
 }else{
  const parts=token.replace(/[年月]/g,'/').replace(/[日號]$/,'').split(/[\/-]/);
  if(parts.length===2)parts.unshift(day.slice(0,4));
  date=parts[0]+'-'+parts[1].padStart(2,'0')+'-'+parts[2].padStart(2,'0');
 }
 if(!dateOK(date))throw new AppError(400,'待辦日期不正確，請使用例如「10/15 待辦：確認工作安排」。');
 let title=input.replace(token,'').replace(/(?:的)?待辦(?:事項|清單)?/,'').trim();
 title=title.replace(/^(?:(?:請|麻煩|幫我|新增|加入|加到|加在|安排在|安排|建立|設定|把|將)\s*)+/,'').replace(/(?:加入|加到|加在|安排在|排在|列入)\s*$/,'').replace(/^[\s:：,，、-]+|[\s:：,，、-]+$/g,'').trim();
 if(!title)return null;
 if(title.length>120)throw new AppError(400,'待辦事項請控制在120字以內，詳細內容可在網頁備註補充。');
 return {kind:'task',orgId:null,type:'一般紀錄',title,note:'',date,endDate:null,amount:null,warnings:[]};
}
