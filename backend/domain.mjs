import {resolveOrganization,clearResolvedOrganizationWarnings} from './organizations.mjs';
export class AppError extends Error { constructor(status,message){super(message);this.status=status;} }
export function requireText(value,name,max=1000){if(typeof value!=='string'||!value.trim()||value.length>max)throw new AppError(400,`${name}格式不正確`);return value.trim();}
export function dateOK(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
export const recordTypes=['客訴','人情往來','會議','報價','一般紀錄','出差／展覽','公司事項','人事'];
export function validateState(value){
 if(!value||!Array.isArray(value.organizations)||!Array.isArray(value.records)||!Array.isArray(value.tasks))throw new AppError(400,'資料格式不正確');
 if(value.organizations.length>1000||value.records.length>5000||value.tasks.length>5000)throw new AppError(400,'資料量已超過第一版容量，請先聯絡維護者');
 const ids=new Set();for(const o of value.organizations){requireText(o.id,'對象 ID',100);if(ids.has(o.id))throw new AppError(400,'對象 ID 重複');ids.add(o.id);requireText(o.name,'對象名稱',100);requireText(o.kind,'對象類別',50);if(o.aliases!==undefined&&(!Array.isArray(o.aliases)||o.aliases.length>20||o.aliases.some(a=>typeof a!=='string'||!a.trim()||a.length>100)))throw new AppError(400,'對象別名格式不正確');if(o.contractEndDate&&!dateOK(o.contractEndDate))throw new AppError(400,'合約到期日期不正確');for(const k of ['mark','en','contact','role','manager','contract','memo'])if(typeof o[k]!=='string'||o[k].length>2000)throw new AppError(400,'對象欄位不正確');if(o.priceNotes!==undefined&&(typeof o.priceNotes!=='string'||o.priceNotes.length>8000))throw new AppError(400,'價格說明太長或格式不正確');if(!Array.isArray(o.prices)||o.prices.length>500)throw new AppError(400,'價格格式不正確');for(const p of o.prices)if(!Array.isArray(p)||p.length!==3||typeof p[0]!=='string'||p[0].length>100||!Number.isFinite(p[1])||p[1]<0||typeof p[2]!=='string'||p[2].length>50)throw new AppError(400,'價格格式不正確');}
 for(const [kind,list] of [['records',value.records],['tasks',value.tasks]]){const seen=new Set();for(const r of list){requireText(r.id,'紀錄 ID',100);if(seen.has(r.id))throw new AppError(400,'紀錄 ID 重複');seen.add(r.id);requireText(r.title,'標題',120);if(r.attachments!==undefined){if(!Array.isArray(r.attachments)||r.attachments.length>20)throw new AppError(400,'附件數量不正確');for(const a of r.attachments)if(!a||!/^media-[a-f0-9]{64}$/.test(a.id)||typeof a.mime!=='string'||!a.mime.startsWith('image/')&&!a.mime.startsWith('audio/')||typeof a.name!=='string'||a.name.length>200)throw new AppError(400,'附件格式不正確');}if(r.createdBy!==undefined&&(typeof r.createdBy!=='string'||r.createdBy.length>100))throw new AppError(400,'提交人不正確');if(r.sourceText!==undefined&&(typeof r.sourceText!=='string'||r.sourceText.length>8000))throw new AppError(400,'原始文字不正確');if(typeof r.note!=='string'||r.note.length>8000)throw new AppError(400,'備註太長');if(r.org&&!ids.has(r.org))throw new AppError(400,'對象不存在');if(kind==='records'){if(!ids.has(r.org)||!dateOK(r.date)||!recordTypes.includes(r.type))throw new AppError(400,'紀錄欄位不正確');if(r.endDate&&(!dateOK(r.endDate)||r.endDate<r.date))throw new AppError(400,'日期區間不正確');if(r.relatedOrg&&(!ids.has(r.relatedOrg)||r.relatedOrg===r.org))throw new AppError(400,'關聯對象不正確');if(r.amount!==null&&(!Number.isFinite(r.amount)||r.amount<0))throw new AppError(400,'金額不正確');if(r.sourceText!==undefined&&(typeof r.sourceText!=='string'||r.sourceText.length>8000))throw new AppError(400,'原始文字不正確');}else{if(typeof r.done!=='boolean'||(r.dueDate&&!dateOK(r.dueDate)))throw new AppError(400,'待辦欄位不正確');}}}
 return JSON.parse(JSON.stringify(value));
}
export const initialState={organizations:[{id:'baiqi',name:'百麒',kind:'內部',mark:'百',en:'INTERNAL · COMPANY',contact:'尚未提供',role:'公司內部',manager:'尚未提供',contract:'尚未提供',memo:'出差、展覽、公司事項與內部紀錄',prices:[]}],records:[],tasks:[]};
export function sourceDates(text,now=new Date()){
 const input=String(text).normalize('NFKC'),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 const matches=[...input.matchAll(/(?:\d{4}[\/-])?\d{1,2}[\/-]\d{1,2}|(?:\d{4}年)?\d{1,2}月\d{1,2}[日號]?|大後天|後天|明天|今天/g)];
 if(!matches.length||matches.length>2)return [];
 if(matches.length===2&&!/^[\s—–~～至到-]+$/.test(input.slice(matches[0].index+matches[0][0].length,matches[1].index)))return [];
 return matches.map(m=>{const token=m[0];let value;if(['今天','明天','後天','大後天'].includes(token)){const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+['今天','明天','後天','大後天'].indexOf(token));value=d.toISOString().slice(0,10)}else{const parts=token.replace(/[年月]/g,'/').replace(/[日號]$/,'').split(/[\/-]/);if(parts.length===2)parts.unshift(day.slice(0,4));value=parts[0]+'-'+parts[1].padStart(2,'0')+'-'+parts[2].padStart(2,'0')}return dateOK(value)?value:null});
}
export function normalizeDraft(raw,organizations,text='',now=new Date()){
 if(!raw||!['record','task'].includes(raw.kind))throw new AppError(502,'AI 回傳格式不正確，請改用手動新增');
 const dates=sourceDates(text,now),named=resolveOrganization(null,organizations,text);
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 const operation=named&&dates[0]&&dates[0]>=today&&/送.*(?:布品|清洗)|送洗/.test(text)&&!/已經|已送|完成|送來|收到/.test(text);
 const kind=operation?'task':raw.kind;
 const org=named||resolveOrganization(raw.orgId,organizations,text);let warnings=Array.isArray(raw.warnings)?raw.warnings.filter(x=>typeof x==='string').slice(0,10).map(x=>x.slice(0,300)):[];
 if(org)warnings=clearResolvedOrganizationWarnings(warnings);
 const date=dates.length?dates[0]:dateOK(raw.date)?raw.date:null,endDate=dates.length===2?dates[1]:dateOK(raw.endDate)?raw.endDate:null;
 if(date)warnings=warnings.filter(w=>!(/年份|缺少年|未提供年|沒有.*年|日期不明|日期.*未提供/.test(w)&&!/金額|數量|對象|結束|起訖|多個/.test(w)));
 if(dates.some(d=>!d))warnings.push('日期不正確，請確認月日。');
 if(!org&&kind==='record')warnings.push('對象尚未建檔或不明確，請先確認對象。');if(kind==='record'&&!date)warnings.push('事件日期不明，請補填。');
 if(endDate&&date&&endDate<date)warnings.push('結束日期早於開始日期，請確認。');
 return {kind,orgId:org?.id||null,type:recordTypes.includes(raw.type)?raw.type:'一般紀錄',title:requireText(raw.title,'AI 標題',120),note:typeof raw.note==='string'?raw.note.slice(0,8000):'',date,endDate:endDate&&(!date||endDate>=date)?endDate:null,amount:Number.isFinite(raw.amount)&&raw.amount>=0?raw.amount:null,warnings};
}

export function taskHistory(task){if(!task.org||!dateOK(task.dueDate))return null;return {...task,id:task.id,linkedTaskId:task.id,date:task.dueDate,endDate:null,relatedOrg:null,type:'一般紀錄',amount:null,note:('待辦安排（不代表已完成）\n'+(task.note||'')).slice(0,8000)};}
