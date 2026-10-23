import test from 'node:test';
import assert from 'node:assert/strict';
import {bindingCommand} from '../backend/garment-routing.mjs';
const group=(text)=>({source:{type:'group',groupId:'C'+'a'.repeat(32),userId:'U'+'b'.repeat(32)},type:'message',message:{type:'text',text}});
test('飯店群組指令',()=>assert.deepEqual(bindingCommand(group('綁定飯店 nikko')),{kind:'hotel',code:'NIKKO'}));
test('工作群組指令',()=>assert.deepEqual(bindingCommand(group('綁定客衣通知')),{kind:'work'}));
test('不處理私人對話',()=>assert.equal(bindingCommand({...group('綁定飯店 NIKKO'),source:{type:'user',userId:'U'+'b'.repeat(32)}}),null));
test('不接受不合法代碼',()=>assert.equal(bindingCommand(group('綁定飯店 ../abc')),null));
