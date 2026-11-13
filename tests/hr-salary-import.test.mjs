import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {guessMapping, parseCsv, parseSheetRows, compareSalaryRows, parseMonth, parseAmount, isSummaryEmployeeId, SETUP_INSTRUCTIONS} from '../backend/hr-salary-import.mjs';

const fixture = fileURLToPath(new URL('./fixtures/salary-sheet.csv', import.meta.url));

test('guesses 薪資計算明細 headers and parses only employee summary rows', async () => {
  const values = parseCsv(await readFile(fixture, 'utf8'));
  assert.deepEqual(guessMapping(values[0]), {
    month: '計算月份', employeeId: '員工編號', name: '員工姓名', amount: '實領薪資',
  });
  const parsed = parseSheetRows(values);
  assert.ok(parsed.skipped >= 2);
  assert.deepEqual(parsed.months, ['2026-09', '2026-10']);
  const oct = parsed.rows.filter((r) => r.month === '2026-10');
  assert.equal(oct.length, 4);
  assert.equal(oct.find((r) => r.employeeId === 'EMP-014').netPay, 43000);
  assert.equal(oct.find((r) => r.employeeId === 'O002').netPay, 44571);
  assert.ok(!parsed.rows.some((r) => String(r.employeeId).includes('上班')));
});

test('month and amount and id filters match the real sheet conventions', () => {
  assert.equal(parseMonth('2026/10'), '2026-10');
  assert.equal(parseMonth('2026/10/31'), '2026-10');
  assert.equal(parseMonth('2026年10月'), '2026-10');
  assert.equal(parseAmount('44,571'), 44571);
  assert.equal(isSummaryEmployeeId('O002'), true);
  assert.equal(isSummaryEmployeeId('EMP-014'), true);
  assert.equal(isSummaryEmployeeId('⏱️ 上班 10:00:44'), false);
  assert.equal(isSummaryEmployeeId('—'), false);
});

test('compare marks new, changed, same, and unmatched', () => {
  const rows = [
    {month: '2026-10', employeeId: 'EMP-014', name: '陳志明', netPay: 43000},
    {month: '2026-10', employeeId: 'EMP-001', name: '黃淑芬', netPay: 38000},
    {month: '2026-10', employeeId: 'EMP-015', name: '張偉誠', netPay: 35000},
    {month: '2026-10', employeeId: 'O002', name: 'NANA', netPay: 44571},
  ];
  const employees = [{id: 'EMP-014', name: '陳志明'}, {id: 'EMP-001', name: '黃淑芬'}, {id: 'EMP-015', name: '張偉誠'}];
  const salaries = [
    {employeeId: 'EMP-014', month: '2026-10', netPay: 41500, remittance: '未匯'},
    {employeeId: 'EMP-001', month: '2026-10', netPay: 38000, remittance: '已匯'},
  ];
  const compared = compareSalaryRows(rows, {employees, salaries, month: '2026-10'});
  assert.equal(compared.rows.find((r) => r.employeeId === 'EMP-014').status, 'changed');
  assert.equal(compared.rows.find((r) => r.employeeId === 'EMP-001').status, 'same');
  assert.equal(compared.rows.find((r) => r.employeeId === 'EMP-015').status, 'new');
  assert.equal(compared.rows.find((r) => r.employeeId === 'O002').status, 'unmatched');
  assert.deepEqual(compared.counts, {new: 1, changed: 1, same: 1, unmatched: 1});
});

test('setup instructions are Traditional Chinese when unconfigured', () => {
  assert.match(SETUP_INSTRUCTIONS, /服務帳戶/);
  assert.match(SETUP_INSTRUCTIONS, /GOOGLE_SA_JSON/);
  assert.match(SETUP_INSTRUCTIONS, /檢視者/);
  assert.match(SETUP_INSTRUCTIONS, /薪資計算明細/);
});
