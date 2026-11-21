import test from 'node:test';
import assert from 'node:assert/strict';
import {HrStore} from '../backend/hr-store.mjs';
import {openPglite} from '../scripts/pglite-pool.mjs';
import {createSheetSync, parseEmployeeTab} from '../backend/hr-sheet-sync.mjs';
import {planNewcomers, goLiveDate, DEFAULT_IGNORE_IDS, createNewcomers} from '../backend/hr-sheet-newcomers.mjs';
import {createSheetWriter} from '../backend/hr-sheet-write.mjs';

// Never touch real Google credentials from tests (an env key once made a test append to the live sheet).
delete process.env.GOOGLE_SA_JSON; delete process.env.GOOGLE_SA_JSON_B64; delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
process.env.HR_SHEET_WRITE = 'off';
delete process.env.HR_SHEET_GO_LIVE;

const EMP_HEAD = ['員工編號', '姓名', 'LINE ID', '部門', '計薪型態', '到職日', '實際最後在職日', '', '', '', '', '組長身分', '職稱'];
const PAY_HEAD = ['員工編號', '姓名', '部門', '計薪型態', '職稱', '匯款類型'];
const GO_LIVE = '2026-11-22';

function sheet() {
  return {
    '員工資料': [EMP_HEAD,
      ['D001', '老員工', '', '物流', '正職', '2020/01/01'],
      ['F144', '阮氏明', '', '摺疊', '兼職', '2026/12/01'], // ignore list, even with a later 到職日
      ['B777', '蓓如', '', '', '', '2026/12/01'],
      ['F160', '阮文安', 'U123', '摺疊', '兼職', '2026/11/25'], // new foreign worker → auto-create
      ['W140', '黎氏花', '', '洗滌', '', '2026/11/22'], // payType blank here, 薪資設定 has it
      ['F161', '舊的人', '', '摺疊', '正職', '2026/11/10'], // before go-live → never
      ['F162', '老員工', '', '摺疊', '正職', '2026/11/30'], // same name as D001 → flag
      ['F163', '應徵中', '', '撐開', '正職', '2026/11/30'], // same name as an open applicant → flag
      ['F164', '沒日期', '', '撐開', '正職', ''],
    ],
    '薪資設定': [PAY_HEAD, ['W140', '黎氏花', '洗滌', '正職', '洗滌人員', '']],
  };
}

async function setup(env = {HR_SHEET_GO_LIVE: GO_LIVE}) {
  const {pool} = openPglite();
  const hr = new HrStore(pool);
  await hr.ensure();
  await hr.upsertEmployee('D001', {name: '老員工', department: '物流'}, 't', {create: true});
  await hr.upsertCandidate('C-1', {name: '應徵中', department: '撐開', status: '待聯絡'}, 't', {create: true});
  const tabs = sheet();
  const sync = createSheetSync({hr, env, loadValues: async () => tabs, statusImpl: async () => ({configured: true})});
  return {pool, hr, sync, tabs};
}

test('go-live date config: yyyy-mm-dd or yyyy/m/d, blank disables', () => {
  assert.equal(goLiveDate({HR_SHEET_GO_LIVE: '2026/11/2'}), '2026-11-02');
  assert.equal(goLiveDate({HR_SHEET_GO_LIVE: ''}), '');
  assert.equal(goLiveDate({}), '');
  assert.deepEqual(DEFAULT_IGNORE_IDS, ['B777', 'F144', 'O004', 'W132', 'F153']);
});

test('plan: only 員工資料 rows with 到職日 >= go-live, not in DB, not ignored, no same name', () => {
  const t = sheet();
  const plan = planNewcomers({sheetRows: parseEmployeeTab(t['員工資料']).rows, empValues: t['員工資料'], payValues: t['薪資設定'],
    employees: [{id: 'D001', name: '老員工'}], candidates: [{id: 'C-1', name: '應徵中'}], ignoreIds: DEFAULT_IGNORE_IDS, goLive: GO_LIVE});
  assert.deepEqual(plan.create.map((c) => c.id), ['F160', 'W140']);
  const f160 = plan.create[0].payload;
  assert.deepEqual([f160.department, f160.payType, f160.arrivalDate, f160.lineId], ['摺疊', '兼職', '2026-11-25', 'U123']);
  const w140 = plan.create[1];
  assert.equal(w140.payload.payType, '正職', 'blank 計薪型態 filled from 薪資設定');
  assert.equal(w140.payload.job, '洗滌人員');
  assert.equal(w140.inPayTab, true);
  assert.deepEqual(plan.flags.map((f) => f.type + ':' + f.employeeId), ['sheet-new-name-match:F162', 'sheet-new-candidate-match:F163']);
  assert.equal(plan.skipped.ignored, 2);
  assert.equal(plan.skipped.beforeGoLive, 2); // F161 before go-live, F164 no 到職日
  // No go-live configured → nothing at all.
  const off = planNewcomers({sheetRows: parseEmployeeTab(t['員工資料']).rows, empValues: t['員工資料'], employees: [], goLive: ''});
  assert.equal(off.create.length, 0);
});

test('hourly sync auto-creates source=sheet records as 待確認, audits, never writes the sheet, and is idempotent', async () => {
  const {pool, hr, sync} = await setup();
  const preview = await sync.run({dryRun: true, actor: 't'});
  assert.deepEqual(preview.newcomersPlanned.map((x) => x.employeeId), ['F160', 'W140']);
  assert.equal((await pool.query("SELECT count(*)::int n FROM hr_employees WHERE id IN ('F160','W140')")).rows[0].n, 0, 'preview creates nothing');
  const r = await sync.run({trigger: 'schedule', actor: 'system'});
  assert.deepEqual(r.newcomersCreated.map((x) => x.employeeId), ['F160', 'W140']);
  assert.ok(!r.flags.some((f) => f.type === 'sheet-only' && ['F160', 'W140'].includes(f.employeeId)), 'created rows are not also flagged sheet-only');
  assert.ok(r.flags.some((f) => f.type === 'sheet-new-name-match' && f.employeeId === 'F162'));
  const f160 = await hr.getEmployee('F160');
  assert.equal(f160.name, '阮文安'); assert.equal(f160.arrivalDate, '2026-11-25'); assert.equal(f160.payType, '兼職');
  const pending = await hr.sheetNewcomers.pending();
  assert.deepEqual(pending.map((p) => p.employeeId), ['F160', 'W140']);
  const audit = await pool.query("SELECT count(*)::int n FROM hr_audit WHERE action='試算表新增員工'");
  assert.equal(audit.rows[0].n, 2);
  const again = await sync.run({trigger: 'schedule', actor: 'system'});
  assert.equal(again.newcomersCreated.length, 0);
  // companybrain never claims these rows for writing back.
  const writer = createSheetWriter({hr, loadTabs: async () => { throw new Error('must not read'); }, append: async () => { throw new Error('must not write'); }, update: async () => { throw new Error('must not write'); }, statusImpl: async () => ({configured: true}), env: {}});
  assert.deepEqual(await writer.fillOwned(), {writes: 0});
  const status = await sync.status();
  assert.equal(status.goLive, GO_LIVE);
  assert.equal(status.pendingNewcomers.length, 2);
});

test('confirm clears the badge; dismiss removes the auto-created record and adds it to the ignore list', async () => {
  const {pool, hr, sync} = await setup();
  await sync.run({actor: 't'});
  const nc = hr.sheetNewcomers;
  await nc.confirm('F160', 'admin1');
  assert.deepEqual((await nc.pending()).map((p) => p.employeeId), ['W140']);
  assert.equal((await hr.getEmployee('F160')).name, '阮文安');
  await nc.dismiss('W140', 'admin1');
  assert.equal((await pool.query("SELECT count(*)::int n FROM hr_employees WHERE id='W140'")).rows[0].n, 0);
  assert.ok((await nc.ignoreIds()).includes('W140'));
  const r = await sync.run({actor: 't'});
  assert.equal(r.newcomersCreated.length, 0, 'dismissed rows are never recreated');
  await assert.rejects(nc.dismiss('F160', 'admin1'), /不在待確認名單/);
  const acts = (await pool.query("SELECT action FROM hr_audit WHERE action IN ('確認試算表新增員工','略過試算表新增員工') ORDER BY id")).rows.map((x) => x.action);
  assert.deepEqual(acts, ['確認試算表新增員工', '略過試算表新增員工']);
});

test('dismiss refuses when the record already has other data attached', async () => {
  const {hr, sync} = await setup();
  await sync.run({actor: 't'});
  await hr.upsertEmployeePii('F160', {accountLast4: '1', accountEnc: 'v1:x'}, 'bank');
  await assert.rejects(hr.sheetNewcomers.dismiss('F160', 'admin1'), /已經有其他資料/);
  assert.equal((await hr.getEmployee('F160')).name, '阮文安');
});

test('no go-live configured → hourly sync creates nothing', async () => {
  const {sync} = await setup({});
  const r = await sync.run({actor: 't'});
  assert.equal(r.newcomersCreated.length, 0);
  assert.ok(r.flags.some((f) => f.type === 'sheet-only' && f.employeeId === 'F160'));
});

test('轉員工 numbering is blocked when the sheet cannot be read (no fallback)', async () => {
  const {pool} = openPglite();
  const hr = new HrStore(pool); await hr.ensure();
  const w = createSheetWriter({hr, loadTabs: async () => { throw new Error('503 from Google'); }, statusImpl: async () => ({configured: true}), env: {}});
  await w.ensure();
  await hr.setSetting('sheetKnownIds', ['F200']);
  await assert.rejects(w.idsForNumbering({strict: true}), (e) => e.status === 503 && /讀不到打卡算薪水試算表，暫時不能轉員工/.test(e.message));
  assert.deepEqual(await w.idsForNumbering(), ['F200'], 'non-strict callers (preview) may still use the last seen list');
  const unconfigured = createSheetWriter({hr, loadTabs: async () => [], statusImpl: async () => ({configured: false}), env: {}});
  await assert.rejects(unconfigured.idsForNumbering({strict: true}), /暫時不能轉員工/);
  // A sheet row added between two conversions is seen by the next live read.
  const tabs = {'員工資料': [EMP_HEAD, ['F160', 'a']], '薪資設定': [PAY_HEAD]};
  const live = createSheetWriter({hr, loadTabs: async () => tabs, statusImpl: async () => ({configured: true}), env: {}});
  assert.equal(await hr.nextEmployeeId('摺疊', '', await live.idsForNumbering({strict: true})), 'F201');
  tabs['員工資料'].push(['F205', '外籍新人']);
  assert.equal(await hr.nextEmployeeId('摺疊', '', await live.idsForNumbering({strict: true})), 'F206');
});
