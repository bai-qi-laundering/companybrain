import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, rm, mkdir, writeFile, readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../backend/store.mjs';
import {HrStore} from '../backend/hr-store.mjs';
import {createHandler} from '../backend/app.mjs';
import {openPglite} from '../scripts/pglite-pool.mjs';
import {buildPnl, EXPENSE_CATEGORIES} from '../backend/finance.mjs';
import {planExcelImport, parsePnlWorkbook, yearFromPath} from '../backend/finance-import.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const origin = 'http://companybrain.test';

// 模擬 pnl_import.py 的輸出：1–3 月已結帳，4 月還在記帳（收入 0）
function parsedFixture() {
  const cats = (k) => Object.fromEntries(EXPENSE_CATEGORIES.map((c, i) => [c, i === 4 ? 3000000 * k : (i < 3 ? 1000 * k : 0)]));
  return {
    summarySheet: '年度損益表', warnings: [],
    months: {
      1: {categories: {...cats(1), 展延稅額: null}, revenue: 10000000},
      2: {categories: {...cats(2), 雜項: 5}, revenue: 11000000},
      3: {categories: cats(3), revenue: 9000000},
      4: {categories: {房租: 223000}, revenue: 0},
    },
    details: {1: {rows: 10, categories: {...cats(1), 原物料: 999}}},
  };
}

test('Excel plan: only closed past months, 21 categories, salary totals, idempotent-ready entries', () => {
  assert.equal(yearFromPath('115年支出明細/月份_自動損益表.xlsx'), '2026');
  assert.equal(yearFromPath('116年支出明細/月份_自動損益表-116.xlsx'), '2027');
  assert.equal(yearFromPath('x/月份_自動損益表-116.xlsx'), '2027');
  const plan = planExcelImport(parsedFixture(), {year: '2026', now: '2026-11'});
  assert.deepEqual(plan.importMonths, ['2026-01', '2026-02', '2026-03']);
  assert.match(plan.months[3].reason, /收入是 0/);
  assert.match(plan.months[4].reason, /沒有這個月/);
  assert.equal(plan.totals.salary, 18000000);
  assert.equal(plan.totals.revenue, 30000000);
  assert.equal(plan.entries.filter((e) => e.month === '2026-01').length, 1 + 4, '收入 + 4 nonzero categories');
  assert.ok(plan.entries.every((e) => e.category === '收入' || EXPENSE_CATEGORIES.includes(e.category)));
  assert.ok(plan.warnings.some((w) => w.includes('雜項')));
  assert.deepEqual(plan.months[0].diffs.map((d) => d.category), ['原物料']);
  assert.deepEqual(planExcelImport(parsedFixture(), {year: '2026', until: '2026-02', now: '2026-11'}).importMonths, ['2026-01', '2026-02']);
  assert.deepEqual(planExcelImport(parsedFixture(), {year: '2026', now: '2026-02'}).importMonths, ['2026-01'], 'current month never comes from Excel');
  assert.throws(() => planExcelImport({warnings: ['找不到「年度損益表」工作表']}, {year: '2026'}), /年度損益表/);
});

test('P&L precedence: imported months use Excel only; later months use live revenue/payroll/documents', () => {
  const entries = [
    {month: '2026-01', category: '收入', total: 10000000, source: 'excel-import'},
    {month: '2026-01', category: '薪資', total: 3000000, source: 'excel-import'},
    {month: '2026-01', category: '原物料', total: 1000, source: 'excel-import'},
    {month: '2026-01', category: '原物料', total: 555, source: 'document'},
    {month: '2026-01', category: '其他收入', total: 7, source: 'manual'},
    {month: '2026-02', category: '原物料', total: 2000, source: 'document'},
  ];
  const revenue = {'2026-01': {total: 9999, net: 9000, cases: [], fetchedAt: null}, '2026-02': {total: 12000000, net: 11000000, cases: [{}], fetchedAt: null}};
  const payroll = {'2026-01': {total: 67458, people: 1, expected: 40}, '2026-02': {total: 2900000, people: 40, expected: 40}};
  const p = buildPnl({year: '2026', entries, revenue, payroll});
  assert.deepEqual(p.excelMonths, ['2026-01']);
  assert.equal(p.revenue['2026-01'], 10000000);
  assert.equal(p.income['2026-01'], 10000000, '其他收入 manual ignored in Excel month');
  assert.equal(p.expenses.find((r) => r.category === '薪資').months['2026-01'], 3000000, 'live payroll ignored');
  assert.equal(p.expenses.find((r) => r.category === '原物料').months['2026-01'], 1000, 'documents ignored');
  assert.match(p.notes['收入|2026-01'], /原 Excel.*9,999.*67,458.*2 筆/);
  assert.equal(p.revenue['2026-02'], 12000000);
  assert.equal(p.expenses.find((r) => r.category === '薪資').months['2026-02'], 2900000);
  assert.equal(p.expenseTotal['2026-02'], 2902000);
  assert.equal(buildPnl({year: '2026', basis: 'net', entries, revenue, payroll}).revenue['2026-01'], 10000000, 'Excel is 含稅 only');
});

const py = spawnSync('python3', ['-c', 'import openpyxl'], {encoding: 'utf8'});
test('pnl_import.py reads the 月份_自動損益表 layout read-only (cached values)', {skip: py.status !== 0 && 'python3/openpyxl not installed'}, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'finxl-'));
  try {
    const file = path.join(tmp, '月份_自動損益表.xlsx');
    const made = spawnSync('python3', ['-c', `
import openpyxl,sys
wb=openpyxl.Workbook();ws=wb.active;ws.title='年度損益表'
ws.append(['項目','1月',None,'2月',None])
ws.append(['原物料',663079,0.06,239772,0.02]);ws.append(['薪資',3166975,0.3,0,0]);ws.append(['展延稅額',None,0,None,0])
ws.append([None]);ws.append(['總支出',3830054,None,239772,None]);ws.append([None]);ws.append(['收入',10734221,None,0,None])
m=wb.create_sheet('1月');m.append(['月份','科目','廠商','期間/ 備註','金額','稅額','合計'])
m.append(['1','收入',None,None,10734221,None,10734221]);m.append([None,'原物料','永福','x',631504,31575,663079]);m.append([None,'薪資',None,'薪資',3166975,None,3166975])
wb.save(sys.argv[1])`, file]);
    assert.equal(made.status, 0, made.stderr);
    const before = await readFile(file);
    const parsed = await parsePnlWorkbook(file);
    assert.deepEqual(await readFile(file), before, 'workbook untouched');
    assert.equal(parsed.months['1'].revenue, 10734221);
    assert.equal(parsed.months['1'].categories['薪資'], 3166975);
    assert.equal(parsed.details['1'].categories['原物料'], 663079);
    const plan = planExcelImport(parsed, {year: '2026', now: '2026-11'});
    assert.deepEqual(plan.importMonths, ['2026-01']);
    assert.equal(plan.months[0].expenseTotal, 3830054);
  } finally { await rm(tmp, {recursive: true, force: true}); }
});

test('import API: dry-run writes nothing, apply is idempotent, path stays inside the NAS root', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'finimp-'));
  const share = path.join(tmp, '百麒');
  await mkdir(path.join(share, '115年支出明細'), {recursive: true});
  await writeFile(path.join(share, '115年支出明細', '月份_自動損益表.xlsx'), 'fake-xlsx');
  await writeFile(path.join(tmp, 'outside.xlsx'), 'x');
  process.env.NAS_DIRECTORY_ROOT = share;
  const {db, pool} = openPglite();
  const store = new Store(pool);
  await store.init('admin1', 'abcdefghijklmnop');
  const hr = new HrStore(pool);
  await hr.ensure();
  const seen = [];
  const server = http.createServer(createHandler({store, hr, config: {origin, secure: false, key: '', model: 'm'}, htmlPath: path.join(root, 'index.html'), publicDir: path.join(root, 'public'),
    financeRevenue: async () => { throw new Error('should not read Firestore'); }, financeExcel: async (abs) => { seen.push(abs); return parsedFixture(); }}));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port;
  try {
    const anon = await fetch(url + '/api/finance/import-excel', {method: 'POST', headers: {Origin: origin, 'content-type': 'application/json'}, body: '{}'});
    assert.equal(anon.status, 401);
    const login = await fetch(url + '/api/login', {method: 'POST', headers: {Origin: origin, 'content-type': 'application/json'}, body: JSON.stringify({username: 'admin1', password: 'abcdefghijklmnop'})});
    const cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).csrf;
    const api = (p, method = 'GET', body) => fetch(url + p, {method, headers: {Origin: origin, Cookie: cookie, 'x-csrf-token': csrf, 'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
    const count = async () => Number((await pool.query("SELECT count(*)::int AS n FROM fin_entries WHERE source='excel-import'")).rows[0].n);

    const dry = await (await api('/api/finance/import-excel', 'POST', {})).json();
    assert.equal(dry.dryRun, true);
    assert.equal(dry.year, '2026');
    assert.deepEqual(dry.importMonths.slice(0, 3), ['2026-01', '2026-02', '2026-03']);
    assert.equal(await count(), 0, 'dry-run writes nothing');
    assert.ok(seen[0].endsWith(path.join('115年支出明細', '月份_自動損益表.xlsx')));

    const applied = await (await api('/api/finance/import-excel', 'POST', {dryRun: false})).json();
    assert.equal(applied.inserted, 15);
    const again = await (await api('/api/finance/import-excel', 'POST', {dryRun: false})).json();
    assert.equal(again.deleted, 15);
    assert.equal(await count(), 15, 're-import replaces, never duplicates');
    const saved = (await pool.query("SELECT value FROM fin_settings WHERE key='excelImport:2026'")).rows[0].value;
    assert.match(saved.sha256, /^[0-9a-f]{64}$/);

    const p = await (await api('/api/finance/pnl?year=2026')).json();
    assert.equal(p.revenue['2026-02'], 11000000);
    assert.equal(p.expenses.find((r) => r.category === '薪資').months['2026-03'], 9000000);
    const entries = await (await api('/api/finance/entries?month=2026-01')).json();
    const id = entries.entries.find((e) => e.source === 'excel-import').id;
    assert.equal((await api('/api/finance/entries/' + id, 'DELETE')).status, 404, 'imported rows are not deletable as manual');

    assert.equal((await api('/api/finance/import-excel', 'POST', {path: '../outside.xlsx'})).status, 400);
    assert.equal((await api('/api/finance/import-excel', 'POST', {path: '115年支出明細/x.pdf'})).status, 400);
    assert.equal((await api('/api/finance/import-excel', 'POST', {path: '115年支出明細/沒有.xlsx'})).status, 404);
  } finally { await new Promise((r) => server.close(r)); await db.close(); await rm(tmp, {recursive: true, force: true}); }
});
