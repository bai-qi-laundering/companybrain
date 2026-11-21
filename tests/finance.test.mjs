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
import {reviewFields, normalizeDate, normalizeMonth, isInvoiceNumber, buildPnl, pnlCsv, EXPENSE_CATEGORIES, filedName, matchCompany, validateCompanies, DEFAULT_COMPANIES} from '../backend/finance.mjs';
import {decodeFields, summarizeMonth, fetchStatementMonth, startRevenueRefresh, recentMonths} from '../backend/finance-revenue.mjs';

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

  // 賣方是百麒 → 改判銷項；銷項發票只歸檔、不計入（收入以對帳單為準）
  const sale = reviewFields(invoice({sellerTaxId: '96842769', buyerTaxId: '87654321', counterpartyName: 'H2O', orgId: CLIENT, category: '原物料'}), {organizations: orgs});
  assert.equal(sale.fields.docType, '銷項發票');
  assert.equal(sale.fields.category, null);
  assert.equal(sale.fields.countInPnl, false);
  assert.equal(sale.fields.company, '百麒國際');
  assert.ok(sale.needsReview);

  // 薪資類文件只歸檔（薪資以人資為準）
  const pay = reviewFields(invoice({docType: '收據', category: '薪資', invoiceNumber: null}), {organizations: orgs});
  assert.equal(pay.fields.countInPnl, false);

  // 集團公司：依買方統編或名稱判斷；未設定統編的公司出現陌生統編時要問
  assert.equal(reviewFields(invoice(), {organizations: orgs}).fields.company, '百麒國際');
  const companies = validateCompanies([...DEFAULT_COMPANIES.slice(0, 1), {name: '百富', taxId: '11112222', aliases: []}]);
  const bf = reviewFields(invoice({buyerTaxId: '11112222'}), {organizations: orgs, companies});
  assert.equal(bf.fields.company, '百富');
  assert.equal(bf.needsReview, false, bf.questions.join());
  const stranger = reviewFields(invoice({buyerTaxId: '33334444', buyerName: '某某公司'}), {organizations: orgs, companies});
  assert.ok(stranger.questions.some((q) => q.includes('不是已設定的集團公司')));
  assert.equal(matchCompany(DEFAULT_COMPANIES, {name: '百麒洗衣實業有限公司'}).name, '百麒洗衣');
  assert.equal(matchCompany(DEFAULT_COMPANIES, {name: '日聖'}).name, '日聖');
  assert.throws(() => validateCompanies([{name: 'A', taxId: '123'}]), /8 位數字/);

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

test('P&L: revenue from sent statements + 其他收入, 薪資 = HR 實發 + manual adjustments only', () => {
  const revenue = {'2026-01': {total: 10500, net: 10000, tax: 500, cases: [{}, {}], unsent: ['X'], resendPending: [], fetchedAt: '2026-01-31T00:00:00Z', error: null}};
  const p = buildPnl({year: '2026', revenue, entries: [
    {month: '2026-01', category: '原物料', total: 1050, net: 1000, tax: 50, source: 'document'},
    {month: '2026-01', category: '其他收入', total: 300, net: null, tax: null, source: 'manual'},
    {month: '2026-02', category: '薪資', total: 300, net: null, tax: null, source: 'manual'},
    {month: '2026-02', category: '薪資', total: 777, net: null, tax: null, source: 'document'},
  ], payroll: {'2026-01': {total: 200, people: 2, expected: 5}, '2026-02': {total: 999, people: 3, expected: 3}}});
  assert.deepEqual(p.expenses.map((r) => r.category), EXPENSE_CATEGORIES);
  assert.equal(p.revenue['2026-01'], 10500);
  assert.equal(p.income['2026-01'], 10800);
  assert.equal(p.expenseTotal['2026-01'], 1250);
  assert.equal(p.profit['2026-01'], 9550);
  assert.equal(p.expenses.find((r) => r.category === '薪資').months['2026-02'], 1299, 'HR 999 + manual 300; document 薪資 ignored');
  assert.match(p.notes['薪資|2026-01'], /可能不完整/);
  assert.match(p.notes['收入|2026-01'], /1 家還沒寄出/);
  const net = buildPnl({year: '2026', basis: 'net', revenue, entries: [{month: '2026-01', category: '原物料', total: 1050, net: 1000, tax: 50}]});
  assert.equal(net.expenseTotal['2026-01'], 1000);
  assert.equal(net.revenue['2026-01'], 10000);
  assert.match(pnlCsv(p), /^\uFEFF項目,1月/);
  assert.match(pnlCsv(p), /收入（對帳單）/);
  assert.match(filedName({date: '2026-11-05', docType: '進項發票', invoiceNumber: 'AB12345678', total: 15435}, 'IMG_1.JPG'), /^2026-11-05_進項發票_AB12345678_15435元\.jpg$/);
});

const fsDoc = (key, end, versions, latest) => ({document: {fields: {
  customerKey: {stringValue: key}, startDate: {stringValue: end.slice(0, 8) + '01'}, endDate: {stringValue: end}, latestVersion: {integerValue: String(latest)},
  versions: {arrayValue: {values: versions.map((v) => ({mapValue: {fields: {
    version: {integerValue: String(v.version)}, ...(v.sentAt ? {sentAt: {stringValue: v.sentAt}} : {}),
    snapshot: {mapValue: {fields: {totals: {mapValue: {fields: {afterRebate: {integerValue: String(v.net)}, tax: {doubleValue: v.tax}}}}}}},
  }}}))}},
}}});

test('statement revenue = latest SENT version (afterRebate + tax), same rules as 應收帳款; read-only runQuery by endDate month', async () => {
  const docs = [
    fsDoc('H2O', '2026-10-31', [{version: 1, sentAt: '2026-11-01', net: 1000, tax: 50}, {version: 2, sentAt: '2026-11-03', net: 2000, tax: 100}], 2),
    fsDoc('然一', '2026-10-25', [{version: 1, sentAt: '2026-10-26', net: 500, tax: 25}, {version: 2, net: 900, tax: 45}], 2),
    fsDoc('良西+良一', '2026-10-31', [{version: 1, sentAt: 'x', net: 100, tax: 5}], 1),
    fsDoc('A+B', '2026-10-31', [{version: 1, sentAt: 'x', net: 9999, tax: 0}], 1),
    fsDoc('新客', '2026-10-31', [{version: 1, net: 300, tax: 15}], 1),
  ];
  let sent;
  const fakeFetch = async (url, init) => { sent = {url, body: JSON.parse(init.body), auth: init.headers.authorization}; return new Response(JSON.stringify([...docs, {readTime: 'x'}]), {status: 200}); };
  const r = await fetchStatementMonth({month: '2026-10', token: 'tok', fetchImpl: fakeFetch});
  assert.match(sent.url, /projects\/hotel-inventory-3a1ad\/databases\/\(default\)\/documents:runQuery$/);
  const filters = sent.body.structuredQuery.where.compositeFilter.filters;
  assert.deepEqual(filters.map((f) => [f.fieldFilter.field.fieldPath, f.fieldFilter.op, f.fieldFilter.value.stringValue]), [['endDate', 'GREATER_THAN_OR_EQUAL', '2026-10-01'], ['endDate', 'LESS_THAN_OR_EQUAL', '2026-10-31']]);
  assert.equal(r.total, 2100 + 525 + 105);
  assert.equal(r.net, 2000 + 500 + 100);
  assert.equal(r.cases.length, 3);
  assert.deepEqual(r.unsent, ['新客']);
  assert.deepEqual(r.resendPending, ['然一']);
  assert.equal(r.reads, 5);
  await assert.rejects(fetchStatementMonth({month: '2026-10', token: 't', fetchImpl: async () => new Response('{}', {status: 403})}), (e) => e.code === 'forbidden');
  assert.deepEqual(decodeFields({a: {nullValue: null}, b: {booleanValue: true}}), {a: null, b: true});
  assert.equal(summarizeMonth('2026-10', []).total, 0);
});

test('daily revenue refresh only re-reads 本月/上月 when the cache is older than 20h', async () => {
  const calls = [];
  const attempted = new Map();
  const fin = {
    async revenueAttemptedAt(m) { return attempted.has(m) ? {attempted_at: attempted.get(m)} : null; },
    async refreshRevenue(m) { calls.push(m); attempted.set(m, new Date().toISOString()); return {month: m}; },
  };
  const job = startRevenueRefresh({fin, logger: {log() {}}, intervalMs: 1e9});
  try {
    await job.tick();
    assert.deepEqual(calls, recentMonths());
    await job.tick();
    assert.equal(calls.length, 2, 'fresh cache → no Firestore reads');
  } finally { job.stop(); }
});

function multipart(name, body, boundary = '----FinBound') {
  return {boundary, body: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), Buffer.from(body), Buffer.from(`\r\n--${boundary}--\r\n`)])};
}

async function start(answers, revenueByMonth = {}) {
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
  const server = http.createServer(createHandler({store, hr, config: {origin, secure: false, key: '', model: 'm'}, htmlPath: path.join(root, 'index.html'), publicDir: path.join(root, 'public'), classifyFinance: classify, financeRevenue: async ({month}) => { if (revenueByMonth.fail) throw Object.assign(new Error('沒有權限'), {code: 'forbidden'}); return summarizeMonth(month, (revenueByMonth[month] || []).map((d) => decodeFields(d.document.fields))); }}));
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
  }, {'2026-11': [fsDoc('H2O', '2026-11-25', [{version: 1, sentAt: 'x', net: 100000, tax: 5000}], 1)]});
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

    // 收入只能來自對帳單；手動只能填「其他收入」
    assert.equal((await ctx.api('/api/finance/entries', 'POST', {month: '2026-11', category: '收入', total: 100000})).status, 400);
    const rev = await (await ctx.api('/api/finance/revenue/refresh', 'POST', {month: '2026-11'})).json();
    assert.equal(rev.results[0].total, 105000);
    assert.equal((await ctx.api('/api/finance/entries', 'POST', {month: '2026-11', category: '其他收入', total: 1000, description: '廢品出售'})).status, 200);
    const p = await (await ctx.api('/api/finance/pnl?year=2026')).json();
    assert.equal(p.expenses.find((r) => r.category === '原物料').months['2026-11'], 15435);
    assert.equal(p.expenses.find((r) => r.category === '其他費用').months['2026-11'], 2100);
    assert.equal(p.revenue['2026-11'], 105000);
    assert.equal(p.income['2026-11'], 106000);
    assert.equal(p.profit['2026-11'], 106000 - 15435 - 2100);

    // 集團公司設定（在 app 裡改，不用 env）
    const set = await (await ctx.api('/api/finance/settings', 'PUT', {companies: [{name: '百麒國際', taxId: '96842769'}, {name: '百富', taxId: '11112222', aliases: '百富洗衣'}]})).json();
    assert.equal(set.companies[1].aliases[0], '百富洗衣');
    assert.equal((await ctx.api('/api/finance/settings', 'PUT', {companies: [{name: 'X', taxId: '12'}]})).status, 400);
    const meta = await (await ctx.api('/api/finance/meta')).json();
    assert.equal(meta.companies.length, 2);
    assert.equal(doc.fields.company, '百麒國際');

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
