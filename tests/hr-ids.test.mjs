import test from 'node:test';
import assert from 'node:assert/strict';
import {nextPrefixedId, prefixForDepartment, isUsableEmployeeId, AUTO_ID_RE} from '../backend/hr-ids.mjs';

test('dept prefixes match the 打卡算薪水 sheet letters', () => {
  assert.equal(prefixForDepartment('物流'), 'D');
  assert.equal(prefixForDepartment('摺疊'), 'F');
  assert.equal(prefixForDepartment('撐開'), 'H');
  assert.equal(prefixForDepartment('洗滓'), 'W');
  assert.equal(prefixForDepartment('辦公室'), 'O');
  assert.equal(prefixForDepartment('行政'), 'O');
});

test('next id uses prefix + number and does not rewrite other styles', () => {
  assert.equal(nextPrefixedId('D', []), 'D001');
  assert.equal(nextPrefixedId('D', ['D001', 'D002', 'EMP-015', 'F113']), 'D003');
  assert.equal(nextPrefixedId('F', ['F113']), 'F114');
  assert.equal(nextPrefixedId('W', ['E020', 'W007']), 'W008');
  assert.equal(nextPrefixedId('E', ['E020', 'W007']), 'E021');
  assert.ok(AUTO_ID_RE.test('D001') && AUTO_ID_RE.test('F113'));
  assert.ok(isUsableEmployeeId('EMP-001') && isUsableEmployeeId('D001') && isUsableEmployeeId('F113'));
});
