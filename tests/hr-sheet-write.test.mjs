import test from 'node:test';
import assert from 'node:assert/strict';
import {HrStore} from '../backend/hr-store.mjs';
import {openPglite} from '../scripts/pglite-pool.mjs';
import {createSheetWriter, findConflicts, planFill, buildRow, desiredValues, defaultsFor, cellText, colLetter, EMP_TAB, PAY_TAB, DEFAULTS_TAB} from '../backend/hr-sheet-write.mjs';

// Never touch real Google credentials from tests.
delete process.env.GOOGLE_SA_JSON; delete process.env.GOOGLE_SA_JSON_B64; delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

const EMP_HEAD = ['員工編號', '姓名', 'LINE ID', '部門', '計薪型態', '到職日', '實際最後在職日', '', '', '', '', '組長身分', '職稱'];
const PAY_HEAD = ['員工編號', '姓名', '部門', '計薪型態', '職稱', '匯款類型', '薪資底薪 / 時薪額', '加班前2小時費率', '加班後2小時費率', '勞保個人負擔額', '健保個人負擔額', '每日扣除休息', '本月應上班天數', '伙食津貼', '激勵獎金', ' 預借薪資'];
const DEF_HEAD = ['部門', '職稱', '薪資底薪 / 時薪額', '加班前2小時費率', '加班後2小時費率', '勞保個人負擔額', '健保個人負擔額', '每日扣除休息', '本月應上班天數', '伙食津貼', '職務加給', '主管加給', '業績獎金', '特休', '營運獎金', '激勵獎金'];
const DEFAULTS = [DEF_HEAD,
  ['辦公室', '行政', '30000', '1.34', '1.67', '758', '470', '1', '', '2000'],
  ['摺疊', '現場作業員', '31000', '1.34', '1.67', '795', '493', '0.5', '', '2000', '', '', '', '', '', '2500'],
  ['撐開', '現場作業員', '31000', '1.34', '1.67', '795', '493', '0.5', '', '2000', '', '', '', '', '', '2500'],
  ['兼職', '兼職', '196', '1.34', '1.67', '', '', '0.5']];

/** In-memory fake of the two tabs: append adds a row, update sets a cell. */
function fakeSheet(initial) {
  const tabs = {[EMP_TAB]: initial[EMP_TAB].map((r) => [...r]), [PAY_TAB]: initial[PAY_TAB].map((r) => [...r]), [DEFAULTS_TAB]: (initial[DEFAULTS_TAB] || DEFAULTS).map((r) => [...r])};
  const calls = [];
  const strip = (v) => (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v);
  return {
    tabs, calls,
    loadTabs: async () => JSON.parse(JSON.stringify(tabs)),
    append: async ({tab, row}) => { calls.push({op: 'append', tab, row}); tabs[tab].push(row.map(strip)); return "'" + tab + "'!A" + tabs[tab].length + ':M' + tabs[tab].length; },
    update: async ({tab, cell, value}) => {
      calls.push({op: 'update', tab, cell, value});
      const m = cell.match(/^([A-Z]+)(\d+)$/); const col = m[1].charCodeAt(0) - 65, row = Number(m[2]) - 1;
      while (tabs[tab][row].length <= col) tabs[tab][row].push('');
      tabs[tab][row][col] = strip(value);
      return cell;
    },
  };
}

async function setup(sheetInit, envExtra = {}) {
  const {pool} = openPglite();
  const hr = new HrStore(pool);
  await hr.ensure();
  const sheet = fakeSheet(sheetInit);
  const writer = createSheetWriter({hr, loadTabs: sheet.loadTabs, append: sheet.append, update: sheet.update, statusImpl: async () => ({configured: true}), env: envExtra});
  await writer.ensure();
  hr.onBankSaved = (id) => writer.fillOwned({employeeId: id});
  return {pool, hr, sheet, writer};
}

const baseSheet = () => ({
  [EMP_TAB]: [EMP_HEAD, ['F151', '林亜琪', 'U1', '摺疊', '正職', '2026/11/16', '2026/11/18', '離職'], ['', '曾家煌', '', '摺疊', '正職'], ['W132', '賴立家', '', '洗滌', '正職']],
  [PAY_TAB]: [PAY_HEAD, ['F153', '曾家煌', '摺疊', '正職', '現場作業員', '', '31000'], ['W132', '賴立家', '洗滌', '正職', '洗滌人員', '', '33000']],
});

test('helpers: literal text, column letters, header mapping with 部門/計薪型態 aliases', () => {
  assert.equal(cellText('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(cellText('0002'), "'0002");
  assert.equal(cellText('F154'), 'F154');
  assert.equal(colLetter(0), 'A'); assert.equal(colLetter(12), 'M'); assert.equal(colLetter(26), 'AA');
  const {row} = buildRow(PAY_HEAD, {id: ['員工編號'], name: ['姓名'], department: ['部門'], payType: ['計薪型態'], job: ['職稱'], remittance: ['匯款類型']},
    {id: 'F154', name: '新人', department: '摺疊', payType: '', job: '', remittance: '現金'});
  assert.deepEqual(row.slice(0, 7), ['F154', '新人', '摺疊', '', '', '現金', '']);
  const d = desiredValues({id: 'W133', name: 'x', department: '洗滓', employmentType: '兼職', arrivalDate: '2026-11-21'}, {hasBank: false});
  assert.equal(d.department, '兼職', 'part-timers use the 兼職／兼職 profile'); assert.equal(d.job, '兼職'); assert.equal(d.payType, '兼職');
  assert.equal(desiredValues({department: '洗滓', payType: '正職'}).department, '洗滌');
  assert.equal(desiredValues({department: '行政', payType: '正職'}).department, '辦公室');
  assert.deepEqual(defaultsFor(DEFAULTS, '兼職', '兼職'), {'薪資底薪 / 時薪額': '196', '加班前2小時費率': '1.34', '加班後2小時費率': '1.67', '每日扣除休息': '0.5'});
  assert.equal(defaultsFor(DEFAULTS, '摺疊', '主管'), null); assert.equal(d.arrivalDate, '2026/11/21'); assert.equal(d.remittance, '現金');
});

test('conflicts: same 編號 (O/0 normalized) or same name (even with a blank 編號) blocks the write', () => {
  const tabs = baseSheet();
  assert.equal(findConflicts(tabs, {id: 'W132', name: '別人'})[0].reason, 'id');
  assert.equal(findConflicts(tabs, {id: 'F154', name: '曾家煌'})[0].reason, 'name');
  assert.deepEqual(findConflicts(tabs, {id: 'F154', name: '新人'}), []);
});

test('numbering uses the sheet: max over companybrain ∪ 員工資料 ∪ 薪資設定 (+1), gaps never reused; 洗滌 always W', async () => {
  const {hr, writer} = await setup(baseSheet());
  await hr.upsertEmployee('F150', {name: 'a', department: '摺疊'}, 't', {create: true});
  const ids = await writer.idsForNumbering();
  assert.ok(ids.includes('F153'));
  assert.equal(await hr.nextEmployeeId('摺疊', '', ids), 'F154');
  assert.equal(await hr.nextEmployeeId('洗滌', 'W', ids), 'W133');
  await hr.upsertCandidate('C-1', {name: '阿洗', department: '洗滌', status: '待報到'}, 't', {create: true});
  const conv = await hr.convert('C-1', {department: '洗滌', prefix: 'E'}, 't', {extraIds: ids});
  assert.equal(conv.employee.id, 'W133', 'E is ignored for new 洗滌 numbers');
});

test('convert writes both rows immediately with blanks; later data fills only blank cells; passbook flips 現金→匯款', async () => {
  const {hr, sheet, writer, pool} = await setup(baseSheet());
  await hr.upsertCandidate('C-2', {name: '新人甲', department: '摺疊', status: '待報到'}, 't', {create: true});
  const ids = await writer.idsForNumbering();
  const conv = await hr.convert('C-2', {department: '摺疊', job: '', payType: '正職', arrivalDate: ''}, 't', {extraIds: ids});
  // convert() defaults 到職日 to today when empty; clear it to simulate a missing field.
  await hr.upsertEmployee(conv.employee.id, {arrivalDate: ''}, 't');
  const id = conv.employee.id;
  assert.equal(id, 'F154');
  await pool.query("UPDATE hr_sheet_rows SET status='pending' WHERE employee_id=$1", [id]).catch(() => {});
  const res = await writer.writeNew(id, 't');
  assert.equal(res.status, 'written');
  const empRow = sheet.tabs[EMP_TAB].at(-1), payRow = sheet.tabs[PAY_TAB].at(-1);
  assert.deepEqual(empRow.slice(0, 6), ['F154', '新人甲', '', '摺疊', '正職', '']);
  assert.equal(empRow[12], '');
  assert.deepEqual(payRow.slice(0, 7), ['F154', '新人甲', '摺疊', '正職', '', '現金', '']);
  assert.ok(payRow.slice(6).every((v) => v === ''), 'no 職稱 yet → no pay');
  assert.match((await writer.forEmployee(id)).error, /部門或職稱未填/);
  assert.equal(sheet.calls.filter((c) => c.op === 'append').length, 2);
  // second writeNew is a no-op
  await writer.writeNew(id, 't');
  assert.equal(sheet.calls.filter((c) => c.op === 'append').length, 2);
  // Later companybrain fills 職稱 and 到職日; a person typed a different 計薪型態 in 薪資設定 → kept.
  sheet.tabs[PAY_TAB].at(-1)[3] = '兼職';
  await hr.upsertEmployee(id, {job: '現場作業員', arrivalDate: '2026-11-24', payType: '正職'}, 't');
  // 到職日 + 職稱×2 + 9 pay cells from 部門預設值 摺疊／現場作業員 (預借薪資 has no default; 本月應上班天數 is blank).
  sheet.tabs[PAY_TAB].at(-1)[13] = '1500'; // a person already typed 伙食津貼 → kept
  const f = await writer.tick();
  assert.equal(f.writes, 3 + 7, JSON.stringify([f, await writer.forEmployee(id)]));
  const paid = sheet.tabs[PAY_TAB].at(-1);
  assert.deepEqual(paid.slice(6, 16), ['31000', '1.34', '1.67', '795', '493', '0.5', '', '1500', '2500', '']);
  const payCalls = sheet.calls.filter((c) => c.op === 'update' && c.tab === PAY_TAB && /^G/.test(c.cell));
  assert.equal(payCalls[0].value, '31000', 'numbers are written as numbers, not text');
  // Clearing a pay cell later is respected (each pay cell is filled at most once).
  sheet.tabs[PAY_TAB].at(-1)[6] = '';
  assert.equal((await writer.fillOwned({employeeId: id})).writes, 0);
  sheet.tabs[PAY_TAB].at(-1)[6] = '31000';
  assert.equal(sheet.tabs[EMP_TAB].at(-1)[5], '2026/11/24');
  assert.equal(sheet.tabs[EMP_TAB].at(-1)[12], '現場作業員');
  assert.equal(sheet.tabs[PAY_TAB].at(-1)[4], '現場作業員');
  assert.equal(sheet.tabs[PAY_TAB].at(-1)[3], '兼職', 'non-blank edited cell never overwritten');
  // Passbook confirmed → 匯款類型 現金 → 匯款 via the bank hook.
  await hr.upsertEmployeePii(id, {bankCode: '812', bankBranch: 'x', accountName: '新人甲', accountLast4: '1234', accountEnc: 'v1:fake'}, 'bank');
  await new Promise((r) => setTimeout(r, 50));
  await writer.fillOwned({employeeId: id});
  assert.equal(sheet.tabs[PAY_TAB].at(-1)[5], '匯款');
  // Pre-existing rows untouched.
  assert.deepEqual(sheet.tabs[PAY_TAB][1], ['F153', '曾家煌', '摺疊', '正職', '現場作業員', '', '31000']);
  const audit = await pool.query("SELECT count(*)::int n FROM hr_audit WHERE action IN ('新員工寫入試算表','試算表補欄')");
  assert.ok(audit.rows[0].n >= 4);
  const info = await writer.forEmployee(id);
  assert.ok(info.logs.length >= 5);
});

test('匯款類型 changed by a person is not flipped; deleted or renamed rows pause auto-fill', async () => {
  const {hr, sheet, writer} = await setup(baseSheet());
  await hr.upsertCandidate('C-3', {name: '新人乙', department: '撐開', status: '待報到'}, 't', {create: true});
  const conv = await hr.convert('C-3', {department: '撐開'}, 't', {extraIds: await writer.idsForNumbering()});
  const id = conv.employee.id;
  await writer.writeNew(id, 't');
  sheet.tabs[PAY_TAB].at(-1)[5] = '其他';
  await hr.upsertEmployeePii(id, {accountLast4: '9', accountEnc: 'v1:x'}, 'bank');
  await writer.fillOwned({employeeId: id});
  assert.equal(sheet.tabs[PAY_TAB].at(-1)[5], '其他');
  sheet.tabs[EMP_TAB].at(-1)[1] = '改名';
  await writer.fillOwned({employeeId: id});
  const info = await writer.forEmployee(id);
  assert.equal(info.status, 'attention');
  assert.match(info.error, /姓名已改/);
});

test('conflict writes nothing; write failure keeps the conversion and is retried', async () => {
  const init = baseSheet();
  const {hr, sheet, writer} = await setup(init);
  await hr.upsertCandidate('C-4', {name: '曾家煌', department: '摺疊', status: '待報到'}, 't', {create: true});
  const conv = await hr.convert('C-4', {department: '摺疊'}, 't', {extraIds: await writer.idsForNumbering()});
  const r = await writer.writeNew(conv.employee.id, 't');
  assert.equal(r.status, 'conflict');
  assert.match(r.error, /姓名 曾家煌/);
  assert.equal(sheet.calls.length, 0);

  // Failure path
  const {pool} = openPglite();
  const hr2 = new HrStore(pool); await hr2.ensure();
  let fail = true;
  const s2 = fakeSheet(baseSheet());
  const w2 = createSheetWriter({hr: hr2, loadTabs: s2.loadTabs, statusImpl: async () => ({configured: true}), env: {},
    append: async (a) => { if (fail) throw new Error('服務帳戶沒有編輯權限'); return s2.append(a); }, update: s2.update});
  await hr2.upsertCandidate('C-5', {name: '新人丙', department: '物流', status: '待報到'}, 't', {create: true});
  const c5 = await hr2.convert('C-5', {department: '物流'}, 't', {extraIds: await w2.idsForNumbering()});
  assert.ok(c5.employee.id.startsWith('D'));
  const f1 = await w2.writeNew(c5.employee.id, 't');
  assert.equal(f1.status, 'failed');
  assert.equal(f1.label, '未寫入試算表');
  fail = false;
  await w2.tick();
  const i5 = await w2.forEmployee(c5.employee.id); assert.equal(i5.status, 'written', i5.error);
  assert.equal(s2.tabs[EMP_TAB].at(-1)[0], c5.employee.id);
});

test('HR_SHEET_WRITE=off records a failure and never calls the sheet', async () => {
  const {hr, sheet, writer} = await setup(baseSheet(), {HR_SHEET_WRITE: 'off'});
  await hr.upsertEmployee('D010', {name: 'z', department: '物流'}, 't', {create: true});
  const r = await writer.writeNew('D010', 't');
  assert.equal(r.status, 'failed');
  assert.equal(sheet.calls.length, 0);
});

test('planFill refuses ambiguous rows', () => {
  const values = [PAY_HEAD, ['F154', 'a', '', '', '', '現金'], ['F154', 'a', '', '', '', '現金']];
  const p = planFill({tab: PAY_TAB, values, owned: {sheetId: 'F154', name: 'a', cells: {}}, desired: {department: '摺疊'}});
  assert.match(p.error, /2 列/);
});

test('兼職 convert: 編號 from the work area, sheet gets 部門 兼職／職稱 兼職 and the 時薪 profile from 部門預設值', async () => {
  const {hr, sheet, writer} = await setup(baseSheet());
  await hr.upsertCandidate('C-6', {name: '兼職丁', department: '撐開', job: '打雜', status: '待報到'}, 't', {create: true});
  const conv = await hr.convert('C-6', {department: '撐開', payType: '兼職', employmentType: '兼職'}, 't', {extraIds: await writer.idsForNumbering()});
  assert.ok(conv.employee.id.startsWith('H'));
  assert.equal(conv.employee.job, '兼職');
  assert.equal(conv.employee.department, '撐開');
  const r = await writer.writeNew(conv.employee.id, 't');
  assert.equal(r.status, 'written'); assert.equal(r.error, '');
  const emp = sheet.tabs[EMP_TAB].at(-1), pay = sheet.tabs[PAY_TAB].at(-1);
  assert.deepEqual([emp[3], emp[4], emp[12]], ['兼職', '兼職', '兼職']);
  assert.deepEqual(pay.slice(2, 12), ['兼職', '兼職', '兼職', '現金', '196', '1.34', '1.67', '', '', '0.5']);
  const append = sheet.calls.find((c) => c.op === 'append' && c.tab === PAY_TAB);
  assert.equal(append.row[6], '196', 'pay numbers are not quoted as text');
});

test('no 部門預設值 match → identity only + note; convert rejects 部門＋職稱 pairs not in 部門預設值', async () => {
  const init = baseSheet();
  init[DEFAULTS_TAB] = [DEF_HEAD, ['辦公室', '行政', '30000']];
  const {hr, sheet, writer} = await setup(init);
  await hr.upsertCandidate('C-7', {name: '新人戊', department: '摺疊', status: '待報到'}, 't', {create: true});
  await assert.rejects(hr.convert('C-7', {department: '摺疊', job: '主管'}, 't'), /職稱必須是/);
  await assert.rejects(hr.convert('C-7', {department: '倉庫', job: ''}, 't'), /部門必須是/);
  const conv = await hr.convert('C-7', {department: '摺疊', job: '作業員'}, 't', {extraIds: await writer.idsForNumbering()});
  const r = await writer.writeNew(conv.employee.id, 't');
  assert.equal(r.status, 'written');
  assert.match(r.error, /部門預設值沒有「摺疊／作業員」/);
  assert.ok(sheet.tabs[PAY_TAB].at(-1).slice(6).every((v) => v === ''));
  // Applicant free-text 職稱 is dropped (left blank) instead of blocking the conversion.
  await hr.upsertCandidate('C-8', {name: '新人己', department: '物流', job: '開車的', status: '待報到'}, 't', {create: true});
  const c8 = await hr.convert('C-8', {department: '物流'}, 't');
  assert.equal(c8.employee.job, '');
});
