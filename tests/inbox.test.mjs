import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, rm, mkdir, readdir, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../backend/store.mjs';
import {HrStore} from '../backend/hr-store.mjs';
import {createHandler} from '../backend/app.mjs';
import {openPglite} from '../scripts/pglite-pool.mjs';
import {InboxStore, routeOf, suggestEmployee, mergeContact, cleanContact, detectSalary, encryptBlob, decryptBlob, INBOX_TYPES} from '../backend/inbox.mjs';
import {createResignationSheet, locateDeparture} from '../backend/inbox-resign.mjs';
import {orgDirectoryKind, CLIENT_KINDS} from '../backend/directory-docs.mjs';
import {syncLinkedFolderKinds, applyOrgKindFixes, ORG_KIND_FIXES} from '../backend/directory-migrate.mjs';

// 測試絕不碰正式試算表：清掉服務帳戶、關閉寫入；離職單測試只用注入的假試算表。
delete process.env.GOOGLE_SA_JSON; delete process.env.GOOGLE_SA_JSON_B64; delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
process.env.HR_SHEET_WRITE = 'off';

const root = fileURLToPath(new URL('..', import.meta.url));
const origin = 'http://companybrain.test';
const VENDOR = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000011';
const REST = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000012';
const KEY = 'ab'.repeat(32);
const SECRET = 'SECRET-ID-BYTES-A123456789';

const blank = {docType: '其他', counterpartyName: null, counterpartyTaxId: null, sellerTaxId: null, buyerTaxId: null, sellerName: null, buyerName: null, orgId: null, invoiceNumber: null, date: null, month: null, net: null, tax: null, total: null, category: null, description: '', confidence: 0.95, uncertainties: [], personName: null, employeeNo: null, contactName: null, contactTitle: null, contactPhones: [], contactEmail: null, contactAddress: null, departureDate: null};

function multipart(files, boundary = '----InboxBound') {
  const chunks = [];
  for (const [name, body] of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), Buffer.from(body), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {boundary, body: Buffer.concat(chunks)};
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, {withFileTypes: true}).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p)); else out.push(p);
  }
  return out;
}

async function start({answers = {}, sheet = null, piiKey = KEY} = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'inbox-'));
  const share = path.join(tmp, '百麒');
  const env = {
    NAS_DIRECTORY_ROOT: share,
    NAS_IDENTITY_PATH: path.join(share, '員工', '員工身分證(在職)'),
    NAS_IDENTITY_LEFT_PATH: path.join(share, '員工', '員工身分證(離職)'),
    NAS_BANK_PATH: path.join(share, '員工', '存簿匯款資料'),
    NAS_LICENSE_PATH: path.join(share, '員工', '員工駕照'),
    NAS_RESUME_PATH: path.join(share, '員工', '履歷表'),
  };
  const prev = {};
  for (const [k, v] of Object.entries({...env, HR_PII_KEY: piiKey})) { prev[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  await mkdir(path.join(share, '員工'), {recursive: true});
  const {db, pool} = openPglite();
  const store = new Store(pool);
  await store.init('admin1', 'abcdefghijklmnop');
  const hr = new HrStore(pool);
  await hr.ensure();
  const calls = [];
  const classify = async ({filename}) => {
    calls.push(filename);
    const a = answers[filename];
    if (a instanceof Error) throw a;
    if (!a) throw new Error('unexpected classify ' + filename);
    return {...blank, ...a};
  };
  const extract = async ({category}) => category === 'bank' ? {bankCode: '004', branch: '台銀', account: '12345678901234', accountName: '陳志明', warnings: []} : {nationalId: null, name: '陳志明', birthDate: null, warnings: []};
  const server = http.createServer(createHandler({store, hr, config: {origin, secure: false, key: '', model: 'm'}, htmlPath: path.join(root, 'index.html'), publicDir: path.join(root, 'public'), classifyFinance: classify, extract, inboxSheet: sheet ? sheet(hr) : null}));
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
  assert.equal((await api('/api/state', 'PUT', {...state, organizations: [...state.organizations, {...base, id: VENDOR, name: '永福化工', kind: '原料商'}, {...base, id: REST, name: '鼎王', kind: '餐廳'}]})).status, 200);
  await api('/api/hr/employees', 'POST', {id: 'EMP-014', name: '陳志明', department: '物流', job: '司機', arrivalDate: '2022-05-20'});
  await api('/api/hr/employees', 'POST', {id: 'EMP-001', name: '林美玲', department: '廠務', arrivalDate: '2020-01-01'});
  const up = async (...files) => {
    const r = await api('/api/inbox/upload', 'POST', undefined, multipart(files));
    return {status: r.status, body: await r.json()};
  };
  return {api, up, share, url, pool, store, hr, calls, stop: async () => {
    await new Promise((r) => server.close(r)); await db.close(); await rm(tmp, {recursive: true, force: true});
    for (const [k, v] of Object.entries(prev)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }};
}

test('pure helpers: routes, employee match, contact merge, salary detection, blob crypto, restaurants are clients', () => {
  assert.equal(routeOf('進項發票'), 'finance');
  assert.equal(routeOf('名片'), 'card');
  assert.equal(routeOf('身分證'), 'hr');
  assert.equal(routeOf('居留證'), 'hr');
  assert.equal(routeOf('存摺'), 'hr');
  assert.equal(routeOf('離職單'), 'resignation');
  assert.equal(routeOf('薪資檔'), 'salary');
  for (const t of ['名片', '身分證', '居留證', '駕照', '存摺', '履歷', '離職單', '薪資檔']) assert.ok(INBOX_TYPES.includes(t));
  const emps = [{id: 'O002', name: 'NANA'}, {id: 'A1', name: '王 小明'}, {id: 'A2', name: '李四'}, {id: 'A3', name: '李四'}];
  assert.deepEqual(suggestEmployee(emps, {employeeNo: '0002'}), {employeeId: 'O002', how: 'id'});
  assert.deepEqual(suggestEmployee(emps, {personName: '王小明'}), {employeeId: 'A1', how: 'name'});
  assert.equal(suggestEmployee(emps, {personName: '李四'}).how, 'ambiguous');
  assert.equal(suggestEmployee(emps, {personName: '王小'}).employeeId, null);
  const c = cleanContact({name: '張三', title: '業務', phones: ['0912-345-678'], email: 'a@b.tw'});
  assert.equal(mergeContact('尚未提供', c).contact, '張三（業務） 0912-345-678 a@b.tw');
  assert.equal(mergeContact('王小姐 0912345678', c).added, false, 'same phone is not added twice');
  assert.match(mergeContact('王小姐', c).contact, /^王小姐\n張三/);
  assert.equal(detectSalary([{name: 'x', rows: [['計算月份', '員工編號', '員工姓名', '實領薪資'], ['2026-10', 'A1', '王', '30000']]}]).months[0], '2026-10');
  assert.equal(detectSalary([{name: 'x', rows: [['姓名', '本薪', '勞保', '實發']]}]).isSalary, true);
  assert.equal(detectSalary([{name: 'x', rows: [['品名', '數量']]}]).isSalary, false);
  const prev = process.env.HR_PII_KEY;
  process.env.HR_PII_KEY = KEY;
  try {
    const enc = encryptBlob(Buffer.from(SECRET));
    assert.equal(enc.includes(Buffer.from(SECRET)), false);
    assert.equal(decryptBlob(enc).toString(), SECRET);
  } finally { if (prev == null) delete process.env.HR_PII_KEY; else process.env.HR_PII_KEY = prev; }
  assert.deepEqual(CLIENT_KINDS, ['飯店', '餐廳']);
  assert.equal(orgDirectoryKind({kind: '餐廳'}), 'clients');
  assert.equal(orgDirectoryKind({kind: '飯店'}), 'clients');
  assert.equal(orgDirectoryKind({kind: '原料商'}), 'vendors');
  const values = [['員工編號', '員工姓名', '到職日', '實際最後在職日'], ['EMP-014', '陳志明', '2022/05/20', '2026/10/31'], ['EMP-001', '林美玲', '2020/01/01', '']];
  assert.deepEqual({...locateDeparture(values, 'EMP-014'), header: undefined}, {ok: true, row: 2, cell: 'D2', column: 'D', header: undefined, raw: '2026/10/31', current: '2026-10-31', currentInvalid: false});
  assert.equal(locateDeparture(values, 'EMP-001').current, '');
  assert.equal(locateDeparture(values, 'X9').ok, false);
});

test('PII is staged encrypted (never on the NAS) and always asks; confirm files to the existing HR folder', async () => {
  const ctx = await start({answers: {
    'id.jpg': {docType: '身分證', personName: '陳志明', confidence: 0.99},
    'bank.jpg': {docType: '存摺', personName: '陳志明', confidence: 0.99},
    'arc.png': {docType: '居留證', personName: '不認識', confidence: 0.9},
  }});
  try {
    const r = await ctx.up(['id.jpg', SECRET], ['bank.jpg', SECRET + '-bank'], ['arc.png', SECRET + '-arc']);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [id, bank, arc] = r.body.documents;
    for (const d of [id, bank, arc]) {
      assert.equal(d.status, 'needs_review', 'personal documents always ask');
      assert.equal(d.pii, true);
      assert.equal(d.storedPath, '');
    }
    assert.equal(id.route, 'hr');
    assert.equal(id.fields.employeeId, 'EMP-014');
    assert.equal(arc.fields.employeeId, null);
    // 沒有任何檔案寫到 NAS；資料庫裡只有加密內容
    assert.equal((await walk(ctx.share)).length, 0, 'nothing written to the NAS before confirm');
    const blobs = (await ctx.pool.query('SELECT enc FROM inbox_pii_blobs')).rows;
    assert.equal(blobs.length, 3);
    for (const b of blobs) assert.equal(Buffer.from(b.enc).includes(Buffer.from(SECRET)), false);
    // 原檔可以預覽（no-store），並留下稽核紀錄
    const f = await ctx.api(`/api/inbox/${id.id}/file`);
    assert.equal(f.headers.get('cache-control'), 'no-store');
    assert.equal(await f.text(), SECRET);
    // 財務的已歸檔清單看不到個資文件；財務動作被擋
    const finList = await (await ctx.api('/api/finance/documents?status=all&scope=finance')).json();
    assert.equal(finList.documents.length, 0);
    assert.equal((await ctx.api(`/api/finance/documents/${id.id}/confirm`, 'POST', {})).status, 409);

    const ok = await ctx.api(`/api/inbox/${id.id}/confirm`, 'POST', {docType: '身分證', employeeId: 'EMP-014'});
    assert.equal(ok.status, 200, await ok.clone().text());
    const done = await ok.json();
    assert.equal(done.document.status, 'filed');
    assert.equal(done.result.category, 'identity');
    const idFiles = await walk(process.env.NAS_IDENTITY_PATH);
    assert.equal(idFiles.length, 1);
    assert.match(path.basename(idFiles[0]), /^EMP-014_陳志明_身分證_/);
    assert.equal(await readFile(idFiles[0], 'utf8'), SECRET);
    assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM inbox_pii_blobs WHERE doc_id=$1', [id.id])).rows[0].n, 0, 'blob dropped after filing');
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM hr_documents WHERE category='identity' AND employee_id='EMP-014'")).rows[0].n, 1);

    // 存摺：走原本的 OCR 確認（加密帳號＋匯款類型），收件匣只建立待確認
    const b = await (await ctx.api(`/api/inbox/${bank.id}/confirm`, 'POST', {docType: '存摺', employeeId: 'EMP-014'})).json();
    assert.equal(b.result.category, 'bank');
    assert.ok(b.result.ocrReviewId, 'bank OCR review created for the existing confirm flow');
    const review = (await ctx.pool.query('SELECT status FROM hr_ocr_reviews WHERE id=$1', [b.result.ocrReviewId])).rows[0];
    assert.equal(review.status, 'pending');

    // 不要的個資：刪掉暫存
    const ig = await (await ctx.api(`/api/inbox/${arc.id}/ignore`, 'POST', {})).json();
    assert.equal(ig.document.status, 'ignored');
    assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM inbox_pii_blobs')).rows[0].n, 0);

    // 稽核紀錄沒有個資內容
    const audit = await (await ctx.api('/api/inbox/audit')).json();
    assert.ok(audit.entries.some((e) => e.action === 'confirm'));
    assert.ok(audit.entries.some((e) => e.action === 'view'));
    assert.equal(JSON.stringify(audit).includes('陳志明') || JSON.stringify(audit).includes(SECRET), false);

    // 同一個檔案再上傳 → 重複
    const dup = await ctx.up(['id-again.jpg', SECRET]);
    assert.equal(dup.body.documents[0].duplicate, true);
  } finally { await ctx.stop(); }
});

test('without HR_PII_KEY personal documents are refused and nothing is stored', async () => {
  const ctx = await start({piiKey: null, answers: {'id.jpg': {docType: '身分證', personName: '陳志明'}}});
  try {
    const r = await ctx.up(['id.jpg', SECRET]);
    assert.equal(r.status, 503);
    assert.match(r.body.error, /HR_PII_KEY/);
    assert.equal((await walk(ctx.share)).length, 0);
    assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM fin_documents')).rows[0].n, 0);
  } finally { await ctx.stop(); }
});

test('business cards: exact match auto-files into the org 名片 folder and adds the contact; unknown company asks', async () => {
  const ctx = await start({answers: {
    'card1.jpg': {docType: '名片', counterpartyName: '永福化工', contactName: '張三', contactTitle: '業務', contactPhones: ['0912-345-678'], contactEmail: 'zhang@yf.tw'},
    'card2.jpg': {docType: '名片', counterpartyName: '新開的餐廳', contactName: '李四', contactPhones: ['02-2222-3333']},
    'card3.jpg': {docType: '名片', counterpartyName: '永福化工', contactName: '王五', confidence: 0.6},
  }});
  try {
    const r = await ctx.up(['card1.jpg', 'c1'], ['card2.jpg', 'c2'], ['card3.jpg', 'c3']);
    const [c1, c2, c3] = r.body.documents;
    assert.equal(c1.status, 'filed', JSON.stringify(c1.questions));
    assert.match(c1.storedPath, new RegExp(`^廠商/${VENDOR}_永福化工/名片/.+_張三\\.jpg$`));
    const st = await (await ctx.api('/api/state')).json();
    assert.equal(st.organizations.find((o) => o.id === VENDOR).contact, '張三（業務） 0912-345-678 zhang@yf.tw');
    assert.equal(c2.status, 'needs_review');
    assert.ok(c2.questions.some((q) => q.includes('名錄裡找不到')));
    assert.equal(c3.status, 'needs_review', 'low confidence asks');
    // 新公司：建立對象（餐廳 → 客人資料夾）
    const done = await (await ctx.api(`/api/inbox/${c2.id}/confirm`, 'POST', {docType: '名片', newOrg: {name: '新開的餐廳', kind: '餐廳'}, contact: {name: '李四', phones: ['02-2222-3333']}})).json();
    assert.equal(done.document.status, 'filed');
    assert.match(done.document.storedPath, /^客戶\/[0-9a-f-]{36}_新開的餐廳\/名片\//);
    const st2 = await (await ctx.api('/api/state')).json();
    assert.equal(st2.organizations.find((o) => o.name === '新開的餐廳').contact, '李四 02-2222-3333');
    // 待確認的暫存檔已搬走
    assert.equal((await walk(path.join(ctx.share, '財務收件匣', '待確認'))).length, 1, 'only card3 left in staging');
  } finally { await ctx.stop(); }
});

test('resignation: shows the sheet value, guards overwrite, writes 實際最後在職日 to an injected fake sheet only', async () => {
  const values = [['員工編號', '員工姓名', '到職日', '實際最後在職日'], ['EMP-014', '陳志明', '2022/05/20', '2026/10/31'], ['EMP-001', '林美玲', '2020/01/01', '']];
  const updates = [];
  const sheet = (hr) => createResignationSheet({hr, env: {HR_SHEET_WRITE: 'on'}, loadTabs: async () => ({員工資料: values}), update: async (a) => { updates.push(a); }});
  const ctx = await start({sheet, answers: {
    'quit.pdf': {docType: '離職單', personName: '陳志明', departureDate: '2026-11-15'},
    'quit2.pdf': {docType: '離職單', personName: '林美玲', departureDate: '115/11/20'},
  }});
  try {
    const r = await ctx.up(['quit.pdf', 'q1'], ['quit2.pdf', 'q2']);
    const [q1, q2] = r.body.documents;
    assert.equal(q1.status, 'needs_review');
    assert.equal(q1.fields.departureDate, '2026-11-15');
    assert.equal(q2.fields.departureDate, '2026-11-20');
    const pv = await (await ctx.api(`/api/inbox/${q1.id}/resignation-preview?employeeId=EMP-014`)).json();
    assert.equal(pv.sheet.current, '2026-10-31');
    assert.equal(pv.sheet.cell, 'D2');
    const conflict = await ctx.api(`/api/inbox/${q1.id}/confirm`, 'POST', {docType: '離職單', employeeId: 'EMP-014', departureDate: '2026-11-15'});
    assert.equal(conflict.status, 409);
    assert.match((await conflict.json()).error, /覆蓋/);
    assert.equal(updates.length, 0);
    const ok = await (await ctx.api(`/api/inbox/${q1.id}/confirm`, 'POST', {docType: '離職單', employeeId: 'EMP-014', departureDate: '2026-11-15', overwriteSheet: true})).json();
    assert.equal(ok.document.status, 'filed');
    assert.equal(ok.result.sheet.written, true);
    assert.deepEqual(updates[0], {spreadsheetId: updates[0].spreadsheetId, tab: '員工資料', cell: 'D2', value: '2026/11/15'});
    assert.match(ok.document.storedPath, /^員工\/EMP-014_陳志明\/離職單\/2026-11-15_離職單\.pdf$/);
    const emp = await ctx.hr.getEmployee('EMP-014');
    assert.equal(emp.departureDate, '2026-11-15');
    // 試算表空白 → 直接寫
    const ok2 = await (await ctx.api(`/api/inbox/${q2.id}/confirm`, 'POST', {docType: '離職單', employeeId: 'EMP-001', departureDate: '2026-11-20'})).json();
    assert.equal(ok2.result.sheet.written, true);
    assert.equal(updates[1].cell, 'D3');
  } finally { await ctx.stop(); }
});

test('resignation with HR_SHEET_WRITE off still files the document and flags the date as not written', async () => {
  const sheet = (hr) => createResignationSheet({hr, env: {HR_SHEET_WRITE: 'off'}, loadTabs: async () => { throw new Error('must not read'); }, update: async () => { throw new Error('must not write'); }});
  const ctx = await start({sheet, answers: {'quit.jpg': {docType: '離職單', personName: '陳志明', departureDate: '2026-11-15'}}});
  try {
    const [q] = (await ctx.up(['quit.jpg', 'q'])).body.documents;
    const pv = await (await ctx.api(`/api/inbox/${q.id}/resignation-preview?employeeId=EMP-014`)).json();
    assert.equal(pv.sheet.writeEnabled, false);
    const ok = await (await ctx.api(`/api/inbox/${q.id}/confirm`, 'POST', {docType: '離職單', employeeId: 'EMP-014', departureDate: '2026-11-15'})).json();
    assert.equal(ok.document.status, 'filed');
    assert.equal(ok.result.sheet.written, false);
    assert.match(ok.result.sheet.reason, /HR_SHEET_WRITE/);
    assert.ok(ok.document.questions.some((x) => x.includes('未寫入試算表')));
    assert.equal((await ctx.hr.getEmployee('EMP-014')).departureDate, '2026-11-15');
  } finally { await ctx.stop(); }
});

test('salary file is detected locally (not sent to AI), previewed, imported without overwriting paid rows, original saved per company', async () => {
  const ctx = await start({answers: {}});
  try {
    await ctx.api('/api/hr/salaries', 'POST', {employeeId: 'EMP-001', month: '2026-10', netPay: 38000, remittance: '已匯'});
    const csv = '計算月份,員工編號,員工姓名,實領薪資\n2026-10,EMP-014,陳志明,41000\n2026-10,EMP-001,林美玲,39000\n2026-10,ZZZ,不存在,1000\n';
    const [s] = (await ctx.up(['薪資10月.csv', csv])).body.documents;
    assert.equal(ctx.calls.length, 0, 'salary files never go to the AI');
    assert.equal(s.route, 'salary');
    assert.equal(s.pii, true);
    assert.equal(s.status, 'needs_review');
    assert.equal(s.fields.month, '2026-10');
    const pv = await (await ctx.api(`/api/inbox/${s.id}/salary-preview`)).json();
    assert.equal(pv.summary.new, 1);
    assert.equal(pv.summary.changed, 1);
    assert.equal(pv.summary.unmatched, 1);
    assert.equal(pv.defaultCompany, '百麒');
    const done = await (await ctx.api(`/api/inbox/${s.id}/confirm`, 'POST', {docType: '薪資檔', month: '2026-10', company: '日聖'})).json();
    assert.equal(done.document.status, 'filed');
    assert.equal(done.result.saved, 1);
    assert.equal(done.result.protected, 1, 'already-paid salary with a different amount is not overwritten');
    assert.match(done.document.storedPath, /^薪資表\/日聖\/2026-10_薪資10月\.csv$/);
    const state = await (await ctx.api('/api/hr/state')).json();
    assert.equal(state.salaries.find((x) => x.employeeId === 'EMP-014' && x.month === '2026-10').netPay, 41000);
    assert.equal(state.salaries.find((x) => x.employeeId === 'EMP-001' && x.month === '2026-10').netPay, 38000);
  } finally { await ctx.stop(); }
});

test('finance documents still flow through the inbox; unreadable files are staged encrypted; purge removes old PII', async () => {
  const ctx = await start({answers: {
    'inv.jpg': {docType: '進項發票', counterpartyName: '永福化工', counterpartyTaxId: '12345678', sellerTaxId: '12345678', orgId: VENDOR, invoiceNumber: 'AB12345678', date: '2026-11-05', month: '2026-11', net: 1000, tax: 50, total: 1050, category: '原物料', description: '鹽'},
    'blur.jpg': new Error('boom'),
  }});
  try {
    const [inv, blur] = (await ctx.up(['inv.jpg', 'i'], ['blur.jpg', 'b'])).body.documents;
    assert.equal(inv.status, 'filed', JSON.stringify(inv.questions));
    assert.equal(inv.route, 'finance');
    assert.equal(blur.status, 'error');
    assert.equal(blur.pii, true, 'unknown documents are encrypted until someone looks');
    const list = await (await ctx.api('/api/inbox')).json();
    assert.deepEqual(list.documents.map((d) => d.id), [blur.id]);
    // 舊網址仍可上傳
    const old = await ctx.api('/api/finance/inbox', 'POST', undefined, multipart([['inv.jpg', 'i']]));
    assert.equal((await old.json()).documents[0].duplicate, true);
    // 30 天未確認 → 刪除暫存
    await ctx.pool.query("UPDATE inbox_pii_blobs SET created_at = now() - interval '31 days'");
    const n = await new InboxStore(ctx.pool).purgeExpired(30);
    assert.equal(n, 1);
    const row = (await ctx.pool.query('SELECT status FROM fin_documents WHERE id=$1', [blur.id])).rows[0];
    assert.equal(row.status, 'purged');
    assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM inbox_pii_blobs')).rows[0].n, 0);
    assert.equal((await ctx.api(`/api/inbox/${blur.id}/file`)).status, 410);
  } finally { await ctx.stop(); }
});

test('restaurant folder links move from 廠商 to 客人 without touching files; primary folders untouched; idempotent', async () => {
  const {db, pool} = openPglite();
  try {
    const store = new Store(pool);
    await store.init('admin1', 'abcdefghijklmnop');
    const st = await store.read();
    const base = {mark: 'x', en: 'X', contact: '—', role: '—', manager: '—', contract: '—', memo: '', prices: []};
    await store.save(st.revision, {...st, organizations: [...st.organizations, {...base, id: REST, name: '鼎王', kind: '餐廳'}, {...base, id: VENDOR, name: '永福化工', kind: '原料商'}]}, 'admin1');
    await store.saveDirectoryFolder('vendors', REST, '合約書、報價單/餐廳/鼎王', {role: 'linked', source: 'auto'});
    await store.saveDirectoryFolder('vendors', REST, '廠商/' + REST + '_鼎王', {role: 'primary', source: 'system'});
    await store.saveDirectoryFolder('vendors', VENDOR, '合約書、報價單/永福', {role: 'linked', source: 'auto'});
    const moved = await syncLinkedFolderKinds(store);
    assert.deepEqual(moved.map((m) => [m.from, m.to, m.relativePath]), [['vendors', 'clients', '合約書、報價單/餐廳/鼎王']]);
    assert.deepEqual((await store.directoryFolders('clients', REST)).map((r) => [r.relative_path, r.role, r.source]), [['合約書、報價單/餐廳/鼎王', 'linked', 'auto']]);
    assert.deepEqual((await store.directoryFolders('vendors', REST)).map((r) => r.role), ['primary'], 'primary rows are left alone');
    assert.equal((await store.directoryFolders('vendors', VENDOR)).length, 1);
    assert.equal((await syncLinkedFolderKinds(store)).length, 0, 'second run changes nothing');
  } finally { await db.close(); }
});

test('高廬 kind fix: 飯店 → 餐廳 once, by exact id and name, only if still 飯店', async () => {
  const {db, pool} = openPglite();
  try {
    const store = new Store(pool);
    await store.init('admin1', 'abcdefghijklmnop');
    const st = await store.read();
    const base = {mark: 'x', en: 'X', contact: '—', role: '—', manager: '—', contract: '—', memo: '', prices: []};
    const G = ORG_KIND_FIXES[0].id;
    const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000099';
    await store.save(st.revision, {...st, organizations: [...st.organizations, {...base, id: G, name: '高廬', kind: '飯店'}, {...base, id: OTHER, name: '高廬', kind: '飯店'}]}, 'admin1');
    await store.saveDirectoryFolder('clients', G, '合約書、報價單/餐廳/高廬', {role: 'linked', source: 'auto'});
    const logs = [];
    const changed = await applyOrgKindFixes(store, {log: (m) => logs.push(m)});
    assert.deepEqual(changed, [{id: G, name: '高廬', from: '飯店', to: '餐廳'}]);
    assert.match(logs[0], /高廬 飯店→餐廳（未搬動任何檔案）/);
    const after = await store.read();
    assert.equal(after.organizations.find((o) => o.id === G).kind, '餐廳');
    assert.equal(after.organizations.find((o) => o.id === OTHER).kind, '飯店', 'same name but different id is untouched');
    assert.equal(orgDirectoryKind(after.organizations.find((o) => o.id === G)), 'clients', 'still a customer');
    assert.equal((await syncLinkedFolderKinds(store)).length, 0, 'folder links stay under 客人');
    assert.deepEqual((await applyOrgKindFixes(store)), [], 'second run changes nothing');
    // 已被手動改成別的種類就不動
    const cur = await store.read();
    await store.save(cur.revision, {...cur, organizations: cur.organizations.map((o) => o.id === G ? {...o, kind: '飯店'} : o)}, 'admin1');
    assert.equal((await applyOrgKindFixes(store, {fixes: [{...ORG_KIND_FIXES[0], from: '其他'}]})).length, 0);
  } finally { await db.close(); }
});
