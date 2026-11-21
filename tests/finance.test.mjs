import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, rm, mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../backend/store.mjs';
import {HrStore} from '../backend/hr-store.mjs';
import {createHandler} from '../backend/app.mjs';
import {openPglite} from '../scripts/pglite-pool.mjs';
import {reviewFields, normalizeDate, normalizeMonth, isInvoiceNumber, buildPnl, pnlCsv, EXPENSE_CATEGORIES, filedName} from '../backend/finance.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const origin = 'http://companybrain.test';
const VENDOR = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002';
const orgs = [
  {id: VENDOR, name: '永福化工', kind: '原料商', aliases: ['永福']},
  {id: CLIENT, name: 'H2O', kind: '飯店', aliases: []},
  {id: 'baiqi', name: '百麒', kind: '內部'},
];

const invoice = (o = {}) => ({docType: '進項發票', counterpartyName: '永福化工有限公司', counterpartyTaxId: '12345678', sellerTaxId: '12345678', buyerTaxId: '96842769', orgId: VENDOR, invoiceNumber: 'AB12345678', date: '2026-11-05', month: '2026-11', net: 14700, tax: 735, total: 15435, category: '原物料', description: '漿王16瓶', confidence: 0.95, uncertainties: [], ...o});

test('date, month and invoice number normalisation (民國年 included)', () => {
  assert.equal(normalizeDate('115/11/05'), '2026-11-05');
  assert.equal(normalizeDate('2026-02-30'), null);
  assert.equal(normalizeMonth('115年11月'), '2026-11');
  assert.equal(normalizeMonth('2026-13'), null);
  assert.ok(isInvoiceNumber('AB-12345678'));
  assert.ok(!isInvoiceNumber('A123456789'));
});

test('confident, matched purchase invoice needs no review; doubts become questions', () => {
  const ok = reviewFields(invoice(), {organizations: orgs});
  assert.equal(ok.needsReview, false, ok.questions.join());
  assert.equal(ok.fields.orgName, '永福化工');
  assert.equal(ok.fields.countInPnl, true);

  const unknown = reviewFields(invoice({counterpartyName: '不知名商行', orgId: null}), {organizations: orgs});
  assert.ok(unknown.needsReview);
  assert.ok(unknown.questions.some((q) => q.includes('名錄裡找不到')));

  const mismatch = reviewFields(invoice({total: 16000}), {organizations: orgs});
  assert.ok(mismatch.questions.some((q) => q.includes('不等於總額')));

  const low = reviewFields(invoice({confidence: 0.5}), {organizations: orgs});
  assert.ok(low.needsReview);

  // AI 選了不存在的 orgId 也不會被採用
  const fake = reviewFields(invoice({counterpartyName: '陌生公司', orgId: 'nope'}), {organizations: orgs});
  assert.equal(fake.fields.orgId, null);

  // 賣方是百麒 → 改判銷項，科目一定是收入
  const sale = reviewFields(invoice({sellerTaxId: '96842769', buyerTaxId: '87654321', counterpartyName: 'H2O', orgId: CLIENT, category: '原物料'}), {organizations: orgs});
  assert.equal(sale.fields.docType, '銷項發票');
  assert.equal(sale.fields.category, '收入');
  assert.ok(sale.needsReview);

  // 客人的對帳單只歸檔、不計入
  const stmt = reviewFields(invoice({docType: '貨款明細／對帳單', counterpartyName: 'H2O', orgId: CLIENT, invoiceNumber: null}), {organizations: orgs});
  assert.equal(stmt.fields.countInPnl, false);

  // 報價單不計入損益
  const quote = reviewFields(invoice({docType: '報價單', invoiceNumber: null}), {organizations: orgs});
  assert.equal(quote.fields.countInPnl, false);
  assert.equal(quote.fields.category, null);

  // 學過的科目優先
  const learned = reviewFields(invoice({category: '其他費用'}), {organizations: orgs, rules: [{name_key: 'x', org_id: VENDOR, category: '原物料'}]});
  assert.equal(learned.fields.category, '原物料');
});

test('P&L follows the 年度損益表 layout and only falls back to HR payroll when no 薪資 entry exists', () => {
  const p = buildPnl({year: '2026', entries: [
    {month: '2026-01', category: '原物料', total: 1050, net: 1000, tax: 50},
    {month: '2026-01', category: '收入', total: 5000, net: null, tax: null},
    {month: '2026-02', category: '薪資', total: 300, net: null, tax: null},
  ], payroll: {'2026-01': {total: 200, people: 2}, '2026-02': {total: 999, people: 3}}});
  assert.deepEqual(p.expenses.map((r) => r.category), EXPENSE_CATEGORIES);
  assert.equal(p.expenseTotal['2026-01'], 1250);
  assert.equal(p.profit['2026-01'], 3750);
  assert.equal(p.expenses.find((r) => r.category === '薪資').months['2026-02'], 300);
  assert.ok(p.notes['薪資|2026-01']);
  const net = buildPnl({year: '2026', basis: 'net', entries: [{month: '2026-01', category: '原物料', total: 1050, net: 1000, tax: 50}]});
  assert.equal(net.expenseTotal['2026-01'], 1000);
  assert.match(pnlCsv(p), /^\uFEFF項目,1月/);
  assert.match(filedName({date: '2026-11-05', docType: '進項發票', invoiceNumber: 'AB12345678', total: 15435}, 'IMG_1.JPG'), /^2026-11-05_進項發票_AB12345678_15435元\.jpg$/);
});

function multipart(name, body, boundary = '----FinBound') {
  return {boundary, body: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), Buffer.from(body), Buffer.from(`\r\n--${boundary}--\r\n`)])};
}

async function start(answers) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'fin-'));
  const share = path.join(tmp, '百麒');
  await mkdir(path.join(share, '員工'), {recursive: true});
  process.env.NAS_DIRECTORY_ROOT = share;
  const {db, pool} = openPglite();
  const store = new Store(pool);
  await store.init('admin1', 'abcdefghijklmnop');
  const hr = new HrStore(pool);
  await hr.ensure();
  const classify = async ({filename}) => {
    const a = answers[filename];
    if (a instanceof Error) throw a;
    return a;
  };
  const server = http.createServer(createHandler({store, hr, config: {origin, secure: false, key: '', model: 'm'}, htmlPath: path.join(root, 'index.html'), publicDir: path.join(root, 'public'), classifyFinance: classify}));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port;
  let cookie = '', csrf = '';
  const api = async (p, method = 'GET', body, raw) => {
    const headers = {Origin: origin, Cookie: cookie, 'x-csrf-token': csrf};
    if (raw) return fetch(url + p, {method, headers: {...headers, 'content-type': 'multipart/form-data; boundary=' + raw.boundary}, body: raw.body});
    if (body !== undefined) return fetch(url + p, {method, headers: {...headers, 'content-type': 'application/json'}, body: JSON.stringify(body)});
    return fetch(url + p, {method, headers});
  };
  const login = await api('/api/login', 'POST', {username: 'admin1', password: 'abcdefghijklmnop'});
  cookie = login.headers.get('set-cookie').split(';')[0];
  csrf = (await login.json()).csrf;
  const state = await (await api('/api/state')).json();
  const base = {mark: 'x', en: 'X', contact: '—', role: '—', manager: '—', contract: '—', memo: '', prices: []};
  assert.equal((await api('/api/state', 'PUT', {...state, organizations: [...state.organizations, {...base, ...orgs[0]}, {...base, ...orgs[1]}]})).status, 200);
  return {api, share, url, stop: async () => { await new Promise((r) => server.close(r)); await db.close(); await rm(tmp, {recursive: true, force: true}); }};
}

test('upload → auto-file confident docs, ask about unsure ones, P&L, duplicates and auth', async () => {
  const ctx = await start({
    'inv.jpg': invoice(),
    'unknown.pdf': invoice({counterpartyName: '不知名商行', counterpartyTaxId: null, orgId: null, invoiceNumber: 'CD87654321', confidence: 0.6, total: 2100, net: 2000, tax: 100, category: '其他費用', uncertainties: ['金額有點模糊']}),
    'stmt.xlsx': invoice({docType: '貨款明細／對帳單', invoiceNumber: null, total: 50000, net: null, tax: null}),
    'broken.png': new Error('boom'),
  });
  try {
    const up = async (name, bytes) => (await ctx.api('/api/finance/inbox', 'POST', undefined, multipart(name, bytes))).json();

    // 未登入不能用
    assert.equal((await fetch(ctx.url + '/api/finance/pnl')).status, 401);

    const a = await up('inv.jpg', 'invoice-bytes');
    const doc = a.documents[0];
    assert.equal(doc.status, 'filed');
    assert.equal(doc.storedPath, `廠商/${VENDOR}_永福化工/發票收據/2026/2026-11-05_進項發票_AB12345678_15435元.jpg`);
    assert.ok(existsSync(path.join(ctx.share, doc.storedPath)));

    // 同一個檔案再傳一次：不重複辨識
    const again = await up('inv.jpg', 'invoice-bytes');
    assert.equal(again.documents[0].duplicate, true);

    // 沒把握的：進待確認，帶問題
    const b = (await up('unknown.pdf', 'pdf-bytes')).documents[0];
    assert.equal(b.status, 'needs_review');
    assert.ok(b.questions.some((q) => q.includes('名錄裡找不到')));
    assert.ok(b.questions.includes('金額有點模糊'));

    // 辨識失敗也留在待確認
    const c = (await up('broken.png', 'png')).documents[0];
    assert.equal(c.status, 'error');

    // 同廠商同月已有發票 → 對帳單要問會不會重複
    const s = (await up('stmt.xlsx', 'xlsx-bytes')).documents[0];
    assert.equal(s.status, 'needs_review');
    assert.ok(s.questions.some((q) => q.includes('可能和發票重複')));

    // 老闆確認：沒有對象 → 放財務收件匣/<月份>/
    const conf = await (await ctx.api(`/api/finance/documents/${b.id}/confirm`, 'POST', {orgId: null, category: '其他費用', countInPnl: true})).json();
    assert.equal(conf.document.status, 'filed');
    assert.match(conf.document.storedPath, /^財務收件匣\/2026-11\/發票收據\//);
    // 對帳單決定不計入
    const st = await (await ctx.api(`/api/finance/documents/${s.id}/confirm`, 'POST', {countInPnl: false})).json();
    assert.equal(st.document.fields.countInPnl, false);
    // 計入損益卻沒有金額 → 擋下
    assert.equal((await ctx.api(`/api/finance/documents/${c.id}/confirm`, 'POST', {docType: '收據', countInPnl: true, category: '電費'})).status, 400);
    assert.equal((await ctx.api(`/api/finance/documents/${c.id}/ignore`, 'POST', {})).status, 200);

    // 手動項目（例如收入、房租）
    assert.equal((await ctx.api('/api/finance/entries', 'POST', {month: '2026-11', category: '收入', total: 100000})).status, 200);
    const p = await (await ctx.api('/api/finance/pnl?year=2026')).json();
    assert.equal(p.expenses.find((r) => r.category === '原物料').months['2026-11'], 15435);
    assert.equal(p.expenses.find((r) => r.category === '其他費用').months['2026-11'], 2100);
    assert.equal(p.income['2026-11'], 100000);
    assert.equal(p.profit['2026-11'], 100000 - 15435 - 2100);

    // 重新確認會先拿掉損益項目
    assert.equal((await ctx.api(`/api/finance/documents/${doc.id}/reopen`, 'POST', {})).status, 200);
    const p2 = await (await ctx.api('/api/finance/pnl?year=2026')).json();
    assert.equal(p2.expenses.find((r) => r.category === '原物料').months['2026-11'], 0);

    // 文件產生的項目不能直接刪
    const entries = (await (await ctx.api('/api/finance/entries?month=2026-11')).json()).entries;
    const fromDoc = entries.find((e) => e.source === 'document');
    assert.equal((await ctx.api('/api/finance/entries/' + fromDoc.id, 'DELETE')).status, 404);
    const manual = entries.find((e) => e.source === 'manual');
    assert.equal((await ctx.api('/api/finance/entries/' + manual.id, 'DELETE')).status, 200);

    const csv = await ctx.api('/api/finance/pnl.csv?year=2026');
    assert.equal(csv.status, 200);
    assert.match(await csv.text(), /總支出/);

    // 原檔可以開
    const file = await ctx.api(`/api/finance/documents/${doc.id}/file`);
    assert.equal(file.status, 200);
    assert.equal(await file.text(), 'invoice-bytes');

    // 不支援的格式
    assert.equal((await ctx.api('/api/finance/inbox', 'POST', undefined, multipart('x.exe', 'MZ'))).status, 400);
    const html = await (await fetch(ctx.url + '/')).text();
    assert.match(html, /data-view="finance"/);
    assert.match(html, /finance-app\.js\?v=/);
  } finally { await ctx.stop(); }
});
