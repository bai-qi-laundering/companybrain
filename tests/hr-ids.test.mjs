import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {nextPrefixedId, prefixForDepartment, prefixChoices, isUsableEmployeeId, AUTO_ID_RE, jobTitleOptions, STANDARD_JOBS, STANDARD_DEPARTMENTS, STANDARD_DEPARTMENT_JOBS, jobsForDepartment, normalizeDepartment} from '../backend/hr-ids.mjs';

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


test('洗滌 uses the same ID prefix as the typo 洗滓, including older stored maps', () => {
  assert.equal(normalizeDepartment('洗滓'), '洗滌');
  assert.equal(prefixForDepartment('洗滌'), 'W');
  assert.equal(prefixForDepartment('洗滓'), 'W');
  const oldMap = {物流: 'D', 摺疊: 'F', 撐開: 'H', 洗滓: 'W', 辦公室: 'O', 行政: 'O'};
  assert.equal(prefixForDepartment('洗滌', oldMap), 'W');
  assert.equal(prefixForDepartment('洗滓', oldMap), 'W');
  assert.deepEqual(prefixChoices('洗滌', oldMap), ['W', 'E']);
  assert.deepEqual(prefixChoices('洗滓', oldMap), ['W', 'E']);
  assert.deepEqual(prefixChoices('物流', oldMap), ['D']);
});

test('official jobs and departments follow payroll 部門預設值 order, and prefixes follow 員工資料', () => {
  assert.deepEqual(STANDARD_DEPARTMENTS, ['辦公室', '洗滌', '摺疊', '撐開', '物流']);
  assert.deepEqual(STANDARD_JOBS, ['行政', '洗滌人員', '現場作業員', '新進司機', '司機', '作業員', '早班作業員']);
  assert.equal(STANDARD_DEPARTMENT_JOBS.length, 9);
  assert.deepEqual(jobsForDepartment('物流'), ['新進司機', '司機']);
  assert.deepEqual(jobsForDepartment('洗滌'), ['洗滌人員', '早班作業員']);
  assert.deepEqual(jobsForDepartment('洗滓'), ['洗滌人員', '早班作業員']);
  assert.deepEqual(jobsForDepartment('辦公室'), ['行政']);
  assert.equal(prefixForDepartment('物流'), 'D');
  assert.equal(prefixForDepartment('摺疊'), 'F');
  assert.equal(prefixForDepartment('撐開'), 'H');
  assert.equal(prefixForDepartment('洗滌'), 'W');
  assert.deepEqual(prefixChoices('洗滌'), ['W', 'E']);
  assert.equal(prefixForDepartment('辦公室'), 'O');
  const titles = jobTitleOptions(
    [{job: '現場作業員'}, {job: ' 司機 '}, {job: ''}],
    [{job: '洗滌作業員', desiredPosition: '行政人員'}, {job: '司機'}],
  );
  assert.ok(titles.includes('司機'));
  assert.ok(titles.includes('新進司機'));
  assert.ok(titles.includes('洗滌人員'));
  assert.ok(titles.includes('現場作業員'));
  assert.ok(titles.includes('洗滌作業員')); // existing data, not official
  assert.ok(titles.includes('行政人員'));
  assert.ok(!STANDARD_JOBS.includes('物流助理'));
  assert.ok(!STANDARD_JOBS.includes('廠務'));
  assert.equal(titles.filter((t) => t === '司機').length, 1);
  assert.ok(titles.indexOf('行政') < titles.indexOf('洗滌人員'));
  assert.ok(titles.indexOf('新進司機') < titles.indexOf('司機'));
});


test('HR UI job pickers offer 司機 and user-facing copy uses 洗滌', async () => {
  const js = await readFile(new URL('../public/hr-app.js', import.meta.url), 'utf8');
  assert.match(js, /jobCombo\('job', '職稱'/);
  assert.match(js, /jobCombo\('job', '職缺'/);
  assert.match(js, /jobCombo\('desiredPosition', '希望職缺'/);
  assert.match(js, /data-job-filter/);
  assert.ok(js.includes("'司機'"));
  assert.ok(js.includes("'新進司機'"));
  assert.ok(js.includes("'洗滌人員'"));
  assert.doesNotMatch(js, /物流助理/);
  assert.doesNotMatch(js, /洗滓 W／E/);
  assert.match(js, /洗滌 W／E/);
});
