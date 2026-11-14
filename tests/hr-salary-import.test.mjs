import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {guessMapping, parseCsv, parseSheetRows, compareSalaryRows, parseMonth, parseAmount, isSummaryEmployeeId, isSalarySummaryRow, baiqiSalaryId, baiqiSalaryColumnKey, salaryColumnMap, salaryImportCoverage, SETUP_INSTRUCTIONS} from '../backend/hr-salary-import.mjs';

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
  assert.deepEqual(compared.counts, {new: 1, changed: 1, same: 1, unmatched: 1, ambiguous: 0});
});

test('setup instructions are Traditional Chinese when unconfigured', () => {
  assert.match(SETUP_INSTRUCTIONS, /服務帳戶/);
  assert.match(SETUP_INSTRUCTIONS, /GOOGLE_SA_JSON/);
  assert.match(SETUP_INSTRUCTIONS, /檢視者/);
  assert.match(SETUP_INSTRUCTIONS, /薪資計算明細/);
});

test('baiqiSalaryId matches payroll script: trim, uppercase, letter O to 0', () => {
  assert.equal(baiqiSalaryId(' o002 '), '0002');
  assert.equal(baiqiSalaryId('O002'), '0002');
  assert.equal(baiqiSalaryId('0002'), '0002');
  assert.equal(baiqiSalaryId('D001'), 'D001');
  assert.equal(baiqiSalaryId('EMP-014'), 'EMP-014');
  assert.equal(baiqiSalaryId('f113'), 'F113');
});

test('office O prefix matches digit 0 without changing the stored employee id', () => {
  const compared = compareSalaryRows(
    [{month: '2026-10', employeeId: '0002', name: 'NANA', netPay: 44571}],
    {employees: [{id: 'O002', name: 'NANA'}], salaries: [], month: '2026-10'},
  );
  assert.equal(compared.rows[0].status, 'new');
  assert.equal(compared.rows[0].employeeId, 'O002');
  assert.equal(compared.rows[0].sheetId, '0002');
});

test('ambiguous when two stored ids normalize to the same key', () => {
  const compared = compareSalaryRows(
    [{month: '2026-10', employeeId: 'O002', name: 'NANA', netPay: 1}],
    {employees: [{id: 'O002', name: 'A'}, {id: '0002', name: 'B'}], month: '2026-10'},
  );
  assert.equal(compared.rows[0].status, 'ambiguous');
  assert.equal(compared.counts.ambiguous, 1);
});

test('summary-row detection matches remittance rule: yyyy/mm month, no clock, not dash', () => {
  assert.equal(isSalarySummaryRow('2026/10', 'O002'), true);
  assert.equal(isSalarySummaryRow('2026-10', '0002'), true);
  assert.equal(isSalarySummaryRow('2026/10', '⏱️ 上班 10:00:44'), false);
  assert.equal(isSalarySummaryRow('2026/10', '⏱ 下班 18:00:00'), false);
  assert.equal(isSalarySummaryRow('2026/10', '—'), false);
  assert.equal(isSalarySummaryRow('2026/10/01', 'O002'), false);
  assert.equal(isSalarySummaryRow('本月結算', 'O002'), false);
  assert.equal(isSummaryEmployeeId('0002'), true);
});

test('maps visible headers by name and ignores hidden helper columns', () => {
  const headers = ['計算月份', '員工編號', '姓名', '實領薪資', '輔助加總', '內部鍵'];
  assert.equal(baiqiSalaryColumnKey('姓名'), '員工姓名');
  const map = salaryColumnMap(headers);
  assert.equal(map.get('員工姓名'), 2);
  assert.equal(map.has('輔助加總'), false);
  const values = [
    headers,
    ['2026/10', 'O002', 'NANA', '44,571', '999999', 'ignore'],
    ['2026/10', '⏱️ 上班 10:00:44', 'NANA', '0', '0', 'x'],
    ['2026/10', '—', '本月結算', '100', '100', 'x'],
  ];
  const parsed = parseSheetRows(values);
  assert.equal(parsed.columns.name, '姓名');
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].employeeId, 'O002');
  assert.equal(parsed.rows[0].netPay, 44571);
  assert.equal(parsed.skipped, 2);
});

test('preview coverage warns when the sheet looks partial or mixes months', () => {
  const employees = [
    {id: 'EMP-001', name: 'A', arrivalDate: '2019-03-01'},
    {id: 'EMP-014', name: 'B', arrivalDate: '2022-05-20'},
    {id: 'EMP-015', name: 'C', arrivalDate: '2023-09-11'},
    {id: 'O002', name: 'D', arrivalDate: '2020-01-01'},
  ];
  const mixed = compareSalaryRows([
    {month: '2026-09', employeeId: 'EMP-001', name: 'A', netPay: 1},
    {month: '2026-10', employeeId: 'EMP-014', name: 'B', netPay: 2},
  ], {employees, month: '2026-10', today: '2026-11-13'});
  assert.equal(mixed.summaryCount, 1);
  assert.equal(mixed.activeEmployeeCount, 4);
  assert.equal(mixed.warnings.length, 2);
  assert.match(mixed.warnings[0], /混了多個計算月份/);
  assert.match(mixed.warnings[1], /少於目前在職員工/);
  const full = salaryImportCoverage({month: '2026-10', months: ['2026-10'], summaryCount: 4, employees, today: '2026-11-13'});
  assert.equal(full.warnings.length, 0);
});
