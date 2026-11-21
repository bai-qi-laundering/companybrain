import test from 'node:test';
import assert from 'node:assert/strict';
import {HrStore} from '../backend/hr-store.mjs';
import {openPglite} from '../scripts/pglite-pool.mjs';
import {parseSheetDate, parseEmployeeTab, planEmployeeSync, planSalarySync, createSheetSync, syncIntervalMinutes} from '../backend/hr-sheet-sync.mjs';

// Never touch real Google credentials from tests (an env key once made a test append to the live sheet).
delete process.env.GOOGLE_SA_JSON; delete process.env.GOOGLE_SA_JSON_B64; delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
process.env.HR_SHEET_WRITE = 'off';

const EMP_HEAD = ['員工編號', '姓名', 'LINE ID', '部門', '計薪型態', '到職日', '實際最後在職日', '', '', '', '', '組長身分', '職稱'];
const SAL_HEAD = ['計算月份', '最後打卡日期', '員工編號', '員工姓名', '員工部門', '職稱', '匯款類型', '薪資類型', '實領薪資'];

test('sheet dates: yyyy/mm/dd variants parse, partial or impossible dates are flagged not thrown', () => {
  assert.deepEqual(parseSheetDate('2026/10/21'), {date: '2026-10-21'});
  assert.deepEqual(parseSheetDate('2026-1-5'), {date: '2026-01-05'});
  assert.deepEqual(parseSheetDate('2026年11月2日'), {date: '2026-11-02'});
  assert.deepEqual(parseSheetDate('2026/11/19 18:00'), {date: '2026-11-19'});
  assert.deepEqual(parseSheetDate(''), {date: ''});
  assert.deepEqual(parseSheetDate('2026/10'), {error: '2026/10'});
  assert.deepEqual(parseSheetDate('10/21'), {error: '10/21'});
  assert.deepEqual(parseSheetDate('2026/02/30'), {error: '2026/02/30'});
});

test('員工資料 is parsed by header name, not column letter', () => {
  const t = parseEmployeeTab([['職稱', '姓名', '員工編號', '實際最後在職日'], ['司機', '甲', 'D001', '2026/11/01']]);
  assert.equal(t.rows[0].id, 'D001');
  assert.equal(t.rows[0].job, '司機');
  assert.equal(t.rows[0].departureRaw, '2026/11/01');
  assert.equal(t.rows[0].hasArrival, false);
  assert.throws(() => parseEmployeeTab([['姓名'], ['甲']]), /員工編號/);
});

test('employee plan: sheet wins for 離職日/職稱, 到職日 fills blanks only, bad dates are flagged', () => {
  const sheetRows = parseEmployeeTab([
    EMP_HEAD,
    ['D001', '甲', 'U1', '物流', '正職', '', '', '', '', '', '', '是', '物流司機'],
    ['F011', '乙', '', '摺疊', '兼職', '2026/10/05', '2026/10/11'],
    ['F109', '丙', '', '摺疊', '兼職', '', '2026/10'],
    ['F151', '丁', '', '摺疊', '兼職', '2026/10/22', '2026/11/18'],
    ['W200', '新人', '', '洗滌', '正職'],
    ['O002', '戊', '', '辦公室', '正職', '2025/03/20', ''],
    ['H122', '己', '', '整燙', '正職', '2026/11/20', '2026/11/01'],
  ]).rows;
  const employees = [
    {id: 'D001', name: '甲', job: '司機', arrivalDate: '2021-12-20', departureDate: ''},
    {id: 'F011', name: '乙', job: '', arrivalDate: '', departureDate: ''},
    {id: 'F109', name: '丙', job: '', arrivalDate: '', departureDate: ''},
    {id: 'F151', name: '丁', job: '', arrivalDate: '2026-10-22', departureDate: '2026-10-22'},
    {id: 'O002', name: '戊', job: '', arrivalDate: '2026-03-20', departureDate: '2026-11-30'},
    {id: 'H122', name: '己', job: '', arrivalDate: '2026-11-16', departureDate: ''},
    {id: 'X999', name: '只在大腦', job: '', arrivalDate: '', departureDate: ''},
  ];
  const {changes, flags} = planEmployeeSync({sheetRows, employees});
  const ch = (id, f) => changes.find((c) => c.employeeId === id && c.field === f);
  assert.equal(ch('D001', 'job').to, '物流司機');
  assert.equal(ch('F011', 'arrivalDate').to, '2026-10-05');
  assert.equal(ch('F011', 'departureDate').to, '2026-10-11');
  assert.equal(ch('F151', 'departureDate').from, '2026-10-22');
  assert.equal(ch('F151', 'departureDate').to, '2026-11-18');
  assert.equal(ch('F109', 'departureDate'), undefined);
  assert.equal(ch('O002', 'arrivalDate'), undefined, 'existing 到職日 is not overwritten');
  const fl = (type, id) => flags.find((f) => f.type === type && f.employeeId === id);
  assert.equal(fl('bad-date', 'F109').raw, '2026/10');
  assert.ok(fl('sheet-only', 'W200'));
  assert.ok(fl('cb-only', 'X999'));
  assert.ok(fl('arrival-mismatch', 'O002'));
  assert.ok(fl('cb-departure-only', 'O002'), 'blank sheet 離職日 does not clear companybrain');
  assert.ok(fl('departure-before-arrival', 'H122'));
});

test('employee plan: letter O and digit 0 match like the payroll script; duplicate sheet ids are skipped', () => {
  const rows = parseEmployeeTab([EMP_HEAD, ['0002', 'NANA', '', '辦公室', '正職', '', '2026/12/01'], ['D005', 'a'], ['d005', 'b']]).rows;
  const {changes, flags} = planEmployeeSync({sheetRows: rows, employees: [{id: 'O002', name: 'NANA'}, {id: 'D005', name: 'a'}]});
  assert.equal(changes[0].employeeId, 'O002');
  assert.equal(changes[0].to, '2026-12-01');
  assert.equal(flags.filter((f) => f.type === 'duplicate-sheet-id').length, 2);
});

test('salary plan: summary rows only, paid months are never overwritten', () => {
  const values = [
    SAL_HEAD,
    ['2026/11', '2026/11/16', 'F103', '吳', '摺疊', '作業員', '現金', '兼職', '8,229'],
    ['2026/11', '2026/11/10', '⏱️ 上班 09:56:59', '⏱️ 下班 16:52:26', '當日工時: 6.42 H', '', '', '狀態: 已下班', ''],
    ['2026/10', '2026/10/31', 'D001', '甲', '物流', '', '匯款', '正職', '43000'],
    ['2026/10', '2026/10/31', 'D002', '乙', '物流', '', '匯款', '正職', '36000'],
    ['2026/10', '2026/10/31', 'Z001', '誰', '物流', '', '匯款', '正職', '1'],
  ];
  const employees = [{id: 'F103', name: '吳'}, {id: 'D001', name: '甲'}, {id: 'D002', name: '乙'}];
  const salaries = [
    {id: 'S1', employeeId: 'D001', month: '2026-10', netPay: 42000, remittance: '已匯'},
    {id: 'S2', employeeId: 'D002', month: '2026-10', netPay: 35000, remittance: '未匯'},
  ];
  const plan = planSalarySync({values, employees, salaries});
  assert.deepEqual(plan.writes.map((w) => [w.employeeId, w.month, w.action, w.netPay]).sort(), [['D002', '2026-10', 'update', 36000], ['F103', '2026-11', 'insert', 8229]]);
  assert.ok(plan.flags.find((f) => f.type === 'salary-paid-changed' && f.employeeId === 'D001'));
  assert.ok(plan.flags.find((f) => f.type === 'salary-unmatched' && f.employeeId === 'Z001'));
});

test('sync interval env: default every 10 minutes, 0 disables', () => {
  assert.equal(syncIntervalMinutes({}), 10);
  assert.equal(syncIntervalMinutes({HR_SHEET_SYNC_MINUTES: '0'}), 0);
  assert.equal(syncIntervalMinutes({HR_SHEET_SYNC_MINUTES: '15'}), 15);
  assert.equal(syncIntervalMinutes({HR_SHEET_SYNC_MINUTES: 'x'}), 10);
});

test('runSync writes employees + ledger, logs each run, and a second run is a no-op', async () => {
  const {pool} = openPglite();
  const hr = new HrStore(pool);
  await hr.ensure();
  await hr.upsertEmployee('D001', {name: '甲', department: '物流', job: '司機'}, 'admin1', {create: true});
  await hr.upsertEmployee('F011', {name: '乙', department: '摺疊'}, 'admin1', {create: true});
  await hr.upsertSalary({employeeId: 'D001', month: '2026-10', netPay: 42000, remittance: '已匯'}, 'admin1');
  const tabs = {
    '員工資料': [EMP_HEAD, ['D001', '甲', '', '物流', '正職', '', '', '', '', '', '', '', '物流司機'], ['F011', '乙', '', '摺疊', '兼職', '2026/10/05', '2026/10/11'], ['F109', '丙', '', '摺疊', '兼職', '', '2026/10']],
    '薪資計算明細': [SAL_HEAD, ['2026/10', '2026/10/31', 'D001', '甲', '物流', '', '匯款', '正職', '43000'], ['2026/10', '2026/10/11', 'F011', '乙', '摺疊', '', '現金', '兼職', '5000']],
  };
  const sync = createSheetSync({hr, loadValues: async () => tabs, statusImpl: async () => ({configured: true, source: 'test'})});
  const preview = await sync.run({dryRun: true, actor: 'admin1'});
  assert.equal(preview.employeeApplied, 0);
  assert.equal((await hr.getEmployee('F011')).departureDate, '');
  const r = await sync.run({actor: 'admin1'});
  assert.equal(r.employeeApplied, 3);
  assert.equal(r.salaryApplied, 0);
  const f011 = await hr.getEmployee('F011');
  assert.equal(f011.departureDate, '2026-10-11');
  assert.equal(f011.arrivalDate, '2026-10-05');
  assert.equal((await hr.getEmployee('D001')).job, '物流司機');
  const state = await hr.state();
  assert.equal(state.salaries.find((s) => s.employeeId === 'D001' && s.month === '2026-10').netPay, 42000);
  assert.equal(state.salaries.filter((s) => s.employeeId === 'F011').length, 0, 'salary sync is off');
  assert.ok(r.flags.find((f) => f.type === 'bad-date' && f.employeeId === 'F109') || r.flags.find((f) => f.type === 'sheet-only' && f.employeeId === 'F109'));
  const again = await sync.run({trigger: 'schedule'});
  assert.equal(again.employeeApplied, 0);
  assert.equal(again.salaryApplied, 0);
  const st = await sync.status();
  assert.equal(st.logs.length, 3);
  assert.equal(st.lastSuccess.trigger, 'schedule');
  const audit = await pool.query("SELECT count(*)::int AS n FROM hr_audit WHERE action LIKE '試算表同步%'");
  assert.ok(audit.rows[0].n >= 2);
});

test('runSync failure is logged and reported, unconfigured is a clear 400', async () => {
  const {pool} = openPglite();
  const hr = new HrStore(pool);
  await hr.ensure();
  const broken = createSheetSync({hr, loadValues: async () => { throw new Error('讀取試算表失敗（500）'); }, statusImpl: async () => ({configured: true})});
  await assert.rejects(broken.run(), /500/);
  const st = await broken.status();
  assert.equal(st.logs[0].ok, false);
  const off = createSheetSync({hr, statusImpl: async () => ({configured: false, instructions: '請設定 GOOGLE_SA_JSON_B64'})});
  await assert.rejects(off.run(), (e) => e.status === 400 && /GOOGLE_SA_JSON_B64/.test(e.instructions));
});

test('same 編號 with a different name is never synced and suggests the sheet id with that name', () => {
  const rows = parseEmployeeTab([EMP_HEAD,
    ['F146', '胡純雅', '', '摺疊', '兼職', '', '2026/10/22'],
    ['F151', '林亜琪', '', '摺疊', '兼職', '2026/11/16', '2026/11/18'],
  ]).rows;
  const employees = [{id: 'F151', name: '胡純雅', arrivalDate: '2026-10-22', departureDate: '2026-10-22'}];
  const {changes, flags} = planEmployeeSync({sheetRows: rows, employees});
  assert.equal(changes.length, 0);
  const f = flags.find((x) => x.type === 'name-mismatch');
  assert.equal(f.employeeId, 'F151');
  assert.equal(f.suggestedId, 'F146');
  const sal = planSalarySync({values: [SAL_HEAD, ['2026/11', '2026/11/18', 'F151', '林亜琪', '摺疊', '', '現金', '兼職', '3000']], employees, salaries: []});
  assert.equal(sal.writes.length, 0);
  assert.equal(sal.flags[0].type, 'name-mismatch');
});

test('GOOGLE_SA_JSON_B64 is decoded and preferred over GOOGLE_SA_JSON', async () => {
  const {loadServiceAccount} = await import('../backend/google-sa.mjs');
  const prev = {b: process.env.GOOGLE_SA_JSON_B64, j: process.env.GOOGLE_SA_JSON};
  try {
    process.env.GOOGLE_SA_JSON = '';
    process.env.GOOGLE_SA_JSON_B64 = Buffer.from(JSON.stringify({client_email: 'sync@example.iam.gserviceaccount.com', private_key: 'k'})).toString('base64');
    assert.equal((await loadServiceAccount()).client_email, 'sync@example.iam.gserviceaccount.com');
    process.env.GOOGLE_SA_JSON_B64 = 'not-base64-json';
    assert.equal(await loadServiceAccount(), null);
  } finally {
    if (prev.b === undefined) delete process.env.GOOGLE_SA_JSON_B64; else process.env.GOOGLE_SA_JSON_B64 = prev.b;
    if (prev.j === undefined) delete process.env.GOOGLE_SA_JSON; else process.env.GOOGLE_SA_JSON = prev.j;
  }
});

test('實領薪資 is no longer synced from the sheet (owner uploads pay himself)', async () => {
  const {pool} = openPglite();
  const hr = new HrStore(pool);
  await hr.ensure();
  await hr.upsertEmployee('D001', {name: '甲', department: '物流'}, 'admin1', {create: true});
  const emp = [EMP_HEAD, ['D001', '甲', '', '物流', '正職']];
  const tab = [SAL_HEAD, ['2026/09', '2026/09/30', 'D001', '甲', '物流', '', '匯款', '正職', '40000']];
  const sync = createSheetSync({hr, loadValues: async () => ({'員工資料': emp, '薪資計算明細': tab}), statusImpl: async () => ({configured: true})});
  const r = await sync.run({actor: 't'});
  assert.equal(r.salaryApplied, 0);
  assert.deepEqual(r.salaryWrites, []);
  assert.equal((await hr.state()).salaries.length, 0);
});
