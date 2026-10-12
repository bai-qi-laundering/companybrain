import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTaskCommand} from '../backend/tasks.mjs';
import {extractDraft} from '../backend/gemini.mjs';
import {understand} from '../backend/assistant.mjs';
import {initialState} from '../backend/domain.mjs';

const now=new Date('2026-10-12T02:00:00Z');
test('explicit dated tasks do not require a directory or Gemini key',async()=>{
 for(const [text,date,title] of [['幫我加入10/15待辦：確認員工排班','2026-10-15','確認員工排班'],['10月15日待辦：去郵局','2026-10-15','去郵局'],['明天待辦：跟媽媽吃飯','2026-10-13','跟媽媽吃飯'],['請幫我把拜訪洲際加到2027/01/03待辦','2027-01-03','拜訪洲際']]){
  const options={text,organizations:initialState.organizations,key:'',model:'model',now,fetchImpl:()=>{throw new Error('must not use AI')}};
  for(const draft of [parseTaskCommand(text,now),await extractDraft(options),await understand(options)]){assert.equal(draft.kind,'task');assert.equal(draft.orgId,null);assert.equal(draft.date,date);assert.equal(draft.title,title);assert.equal(draft.warnings.length,0)}
 }
 assert.equal(parseTaskCommand('明天待辦：拜訪親友',new Date('2026-12-31T15:30:00Z')).date,'2027-01-01');
 assert.equal(parseTaskCommand('今天待辦：接家人',new Date('2026-10-12T16:30:00Z')).date,'2026-10-13');
});
test('queries and historical records are not converted to tasks; invalid dates are reported',()=>{
 for(const text of ['查看今天待辦','明天有哪些待辦？','10/15 日航客訴','2026/10/15 紀錄出差','10/15和10/16待辦：會議'])assert.equal(parseTaskCommand(text,now),null);
 assert.throws(()=>parseTaskCommand('2/30待辦：會議',now),/待辦日期不正確/);
 assert.equal(parseTaskCommand('2028/2/29待辦：會議',now).date,'2028-02-29');
});
