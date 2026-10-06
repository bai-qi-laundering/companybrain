export class AppError extends Error { constructor(status,message){super(message);this.status=status;} }
export function requireText(value,name,max=1000){if(typeof value!=='string'||!value.trim()||value.length>max)throw new AppError(400,`${name}格式不正確`);return value.trim();}
export function dateOK(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
export const recordTypes=['客訴','人情往來','會議','報價','一般紀錄','出差／展覽','公司事項'];
export function validateState(value){
 if(!value||!Array.isArray(value.organizations)||!Array.isArray(value.records)||!Array.isArray(value.tasks))throw new AppError(400,'資料格式不正確');
 if(value.organizations.length>1000||value.records.length>5000||value.tasks.length>5000)throw new AppError(400,'資料量已超過第一版容量，請先聯絡維護者');
 const ids=new Set();for(const o of value.organizations){requireText(o.id,'對象 ID',100);if(ids.has(o.id))throw new AppError(400,'對象 ID 重複');ids.add(o.id);requireText(o.name,'對象名稱',100);requireText(o.kind,'對象類別',50);for(const k of ['mark','en','contact','role','manager','contract','memo'])if(typeof o[k]!=='string'||o[k].length>2000)throw new AppError(400,'對象欄位不正確');if(!Array.isArray(o.prices)||o.prices.length>500)throw new AppError(400,'價格格式不正確');for(const p of o.prices)if(!Array.isArray(p)||p.length!==3||typeof p[0]!=='string'||p[0].length>100||!Number.isFinite(p[1])||p[1]<0||typeof p[2]!=='string'||p[2].length>50)throw new AppError(400,'價格格式不正確');}
 for(const [kind,list] of [['records',value.records],['tasks',value.tasks]]){const seen=new Set();for(const r of list){requireText(r.id,'紀錄 ID',100);if(seen.has(r.id))throw new AppError(400,'紀錄 ID 重複');seen.add(r.id);requireText(r.title,'標題',120);if(typeof r.note!=='string'||r.note.length>8000)throw new AppError(400,'備註太長');if(r.org&&!ids.has(r.org))throw new AppError(400,'對象不存在');if(kind==='records'){if(!ids.has(r.org)||!dateOK(r.date)||!recordTypes.includes(r.type))throw new AppError(400,'紀錄欄位不正確');if(r.endDate&&(!dateOK(r.endDate)||r.endDate<r.date))throw new AppError(400,'日期區間不正確');if(r.relatedOrg&&(!ids.has(r.relatedOrg)||r.relatedOrg===r.org))throw new AppError(400,'關聯對象不正確');if(r.amount!==null&&(!Number.isFinite(r.amount)||r.amount<0))throw new AppError(400,'金額不正確');if(r.sourceText!==undefined&&(typeof r.sourceText!=='string'||r.sourceText.length>8000))throw new AppError(400,'原始文字不正確');}else{if(typeof r.done!=='boolean'||(r.dueDate&&!dateOK(r.dueDate)))throw new AppError(400,'待辦欄位不正確');}}}
 return JSON.parse(JSON.stringify(value));
}
export const initialState={organizations:[{id:'baiqi',name:'百麒',kind:'內部',mark:'百',en:'INTERNAL · COMPANY',contact:'尚未提供',role:'公司內部',manager:'尚未提供',contract:'尚未提供',memo:'出差、展覽、公司事項與內部紀錄',prices:[]}],records:[],tasks:[]};
export function normalizeDraft(raw,organizations){
 if(!raw||!['record','task'].includes(raw.kind))throw new AppError(502,'AI 回傳格式不正確，請改用手動新增');
 const org=organizations.find(o=>o.id===raw.orgId);const warnings=Array.isArray(raw.warnings)?raw.warnings.filter(x=>typeof x==='string').slice(0,10).map(x=>x.slice(0,300)):[];
 const date=dateOK(raw.date)?raw.date:null,endDate=dateOK(raw.endDate)?raw.endDate:null;
 if(!org)warnings.push('對象尚未建檔或不明確，請先確認對象。');if(raw.kind==='record'&&!date)warnings.push('事件日期或年份不明，請補填。');
 if(endDate&&date&&endDate<date)warnings.push('結束日期早於開始日期，請確認。');
 return {kind:raw.kind,orgId:org?.id||null,type:recordTypes.includes(raw.type)?raw.type:'一般紀錄',title:requireText(raw.title,'AI 標題',120),note:typeof raw.note==='string'?raw.note.slice(0,8000):'',date,endDate:endDate&&(!date||endDate>=date)?endDate:null,amount:Number.isFinite(raw.amount)&&raw.amount>=0?raw.amount:null,warnings};
}
