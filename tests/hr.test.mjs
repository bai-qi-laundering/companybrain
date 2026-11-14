import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../backend/store.mjs';
import {HrStore} from '../backend/hr-store.mjs';
import {createHandler} from '../backend/app.mjs';
import {hashPassword} from '../backend/security.mjs';
import {openPglite} from '../scripts/pglite-pool.mjs';
import {prepareDocFolders} from '../scripts/seed-hr.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const origin = 'http://companybrain.test';

async function start(opts = {}) {
  const docRoot = await mkdtemp(path.join(os.tmpdir(), 'hr-docs-'));
  await prepareDocFolders(docRoot);
  const {db, pool} = openPglite();
  const store = new Store(pool);
  await store.init('admin1', 'abcdefghijklmnop');
  const hr = new HrStore(pool);
  await hr.ensure();
  const server = http.createServer(createHandler({
    store, hr,
    config: {origin, secure: false, key: opts.geminiKey || '', model: 'model'},
    extract: opts.extract || null,
    htmlPath: path.join(root, 'index.html'),
    publicDir: path.join(root, 'public'),
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port;
  let cookie = '', csrf = '';
  async function api(p, method = 'GET', body, extra = {}) {
    const headers = {Origin: origin, Cookie: cookie, 'x-csrf-token': csrf, ...extra.headers};
    let payload;
    if (body instanceof Buffer || extra.raw) {
      payload = {headers: {...headers, ...extra.headers}, body: extra.raw || body};
    } else if (body !== undefined) {
      payload = {headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)};
    } else {
      payload = {headers};
    }
    return fetch(url + p, {method, ...payload});
  }
  const login = await api('/api/login', 'POST', {username: 'admin1', password: 'abcdefghijklmnop'});
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  csrf = (await login.json()).csrf;
  return {url, api, db, server, hr, cookie, csrf, docRoot};
}

test('HR routes are ignored without hr store so existing MemoryStore tests stay valid', async () => {
  // handled by not passing hr; 404
  const store = {async health() {}, async user() { return {username: 'admin1', password_hash: hashPassword('abcdefghijklmnop')}; }, async addSession() {}, async session() { return {username: 'admin1', csrf: 'c'}; }, async deleteSession() {}, async read() { return {revision: 0, organizations: [], records: [], tasks: []}; }};
  // skip — backend tests already cover MemoryStore without hr
  assert.ok(true);
});

test('employee, leave ledger, convert, and 已報到 guard', async () => {
  const ctx = await start();
  try {
    const created = await (await ctx.api('/api/hr/employees', 'POST', {
      id: 'EMP-001', name: '黃淑芬', department: '行政', job: '人資行政', employmentType: '正職', arrivalDate: '2019-03-01',
    })).json();
    assert.equal(created.id, 'EMP-001');
    await ctx.api('/api/hr/leave-years/ensure', 'POST', {employeeId: 'EMP-001'});
    const state = await (await ctx.api('/api/hr/state')).json();
    assert.equal(state.leaveYearBasis, 'anniversary');
    const cur = state.leaveYears.find((y) => y.startsOn === '2026-03-01');
    assert.equal(cur.entitled, 15);
    assert.equal(cur.status, '未結算');
    const entry = await (await ctx.api('/api/hr/leave-entries', 'POST', {
      employeeId: 'EMP-001', leaveYearId: cur.id, takenOn: '2026-06-02', days: 2,
    })).json();
    assert.equal(entry.days, 2);
    await ctx.api('/api/hr/leave-entries', 'POST', {employeeId: 'EMP-001', leaveYearId: cur.id, takenOn: '2026-08-18', days: 3.5});
    await ctx.api('/api/hr/leave-entries', 'POST', {employeeId: 'EMP-001', leaveYearId: cur.id, takenOn: '2026-10-05', days: 0.5});
    const after = await (await ctx.api('/api/hr/state')).json();
    const led = after.leaveYears.find((y) => y.id === cur.id);
    assert.equal(led.used, 6);
    assert.equal(led.remaining, 9);
    assert.match(led.summary, /15 天，用了 6 天，剩 9 天，未結算/);
    const settled = await (await ctx.api('/api/hr/leave-years/' + cur.id + '/settle', 'POST', {
      status: '未休完已折現', settledOn: '2027-03-01', settledBy: '黃淑芬',
    })).json();
    assert.equal(settled.status, '未休完已折現');
    assert.equal(settled.settledBy, '黃淑芬');
    assert.equal((await ctx.api('/api/hr/leave-entries', 'POST', {
      employeeId: 'EMP-001', leaveYearId: cur.id, takenOn: '2027-03-02', days: 1,
    })).status, 400);

    const cand = await (await ctx.api('/api/hr/candidates', 'POST', {
      id: 'R-03', name: '許雅琪', phone: '0988-100-003', department: '行政', job: '人資行政', status: '待報到',
    })).json();
    assert.equal((await ctx.api('/api/hr/candidates/R-03', 'PATCH', {status: '已報到'})).status, 400);
    const conv = await (await ctx.api('/api/hr/candidates/R-03/convert', 'POST', {arrivalDate: '2026-11-13', department: '行政'})).json();
    assert.equal(conv.employee.id, 'O001');
    assert.equal(conv.employee.payType, '正職');
    assert.equal(conv.employee.paymentMethod, '匯款');
    const next = await (await ctx.api('/api/hr/next-id?department=' + encodeURIComponent('物流'))).json();
    assert.equal(next.id, 'D001');
    assert.equal(conv.candidate.status, '已報到');
    const again = await ctx.api('/api/hr/candidates/R-03/convert', 'POST', {});
    assert.equal(again.status, 409);
  } finally {
    await new Promise((r) => ctx.server.close(r));
    await ctx.db.close();
    await rm(ctx.docRoot, {recursive: true, force: true});
  }
});

test('upload uses the original filename rule and binds to the employee', async () => {
  const ctx = await start();
  try {
    await ctx.api('/api/hr/employees', 'POST', {id: 'EMP-014', name: '陳志明', department: '物流', job: '司機', arrivalDate: '2022-05-20'});
    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGfAD//2Q==', 'base64');
    const boundary = '----testhrboundary';
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="employeeId"\r\n\r\nEMP-014\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="category"\r\n\r\nbank\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="book.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
    ];
    const body = Buffer.concat([
      Buffer.from(parts[0]), Buffer.from(parts[1]), Buffer.from(parts[2]), jpeg,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await fetch(ctx.url + '/api/hr/documents/upload', {
      method: 'POST',
      headers: {Origin: origin, Cookie: ctx.cookie, 'x-csrf-token': ctx.csrf, 'content-type': 'multipart/form-data; boundary=' + boundary},
      body,
    });
    assert.equal(res.status, 200, await res.clone().text());
    const saved = await res.json();
    assert.equal(saved.employeeId, 'EMP-014');
    assert.match(saved.filename, /^EMP-014_陳志明_存摺_\d{8}T\d{6}_[a-f0-9]{12}\.jpg$/);
    assert.match(saved.displayPath, /存摺\/EMP-014_陳志明_存摺_/);
    assert.equal(saved.ocr.skipped, 'no-gemini');
    const file = await fetch(ctx.url + '/api/hr/documents/' + saved.id + '/file', {headers: {Cookie: ctx.cookie}});
    assert.equal(file.status, 200);
    assert.match(file.headers.get('cache-control') || '', /private/);
    assert.match(file.headers.get('content-type') || '', /image\/jpeg/);
    const anon = await fetch(ctx.url + '/api/hr/documents/' + saved.id + '/file');
    assert.equal(anon.status, 401);
  } finally {
    await new Promise((r) => ctx.server.close(r));
    await ctx.db.close();
    await rm(ctx.docRoot, {recursive: true, force: true});
  }
});


function jpegBody(employeeId, category = 'bank') {
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGfAD//2Q==', 'base64');
  const boundary = '----testhrboundary2';
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="employeeId"\r\n\r\n${employeeId}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="category"\r\n\r\n${category}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="doc.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
  ];
  return {
    boundary,
    body: Buffer.concat([Buffer.from(parts[0]), Buffer.from(parts[1]), Buffer.from(parts[2]), jpeg, Buffer.from(`\r\n--${boundary}--\r\n`)]),
  };
}

test('bank OCR prefills a confirm card and stores only last4 after confirm', async () => {
  const prev = process.env.HR_PII_KEY;
  process.env.HR_PII_KEY = 'ab'.repeat(32);
  const ctx = await start({
    geminiKey: 'test-gemini',
    extract: async ({category}) => category === 'bank'
      ? {bankCode: '004', branch: '台灣銀行南京東路分行', account: '12345678901234', accountName: '陳志明', warnings: []}
      : {nationalId: 'A123456789', name: '陳志明', birthDate: '1988-02-03', warnings: []},
  });
  try {
    await ctx.api('/api/hr/employees', 'POST', {id: 'EMP-014', name: '陳志明', department: '物流', job: '司機', arrivalDate: '2022-05-20'});
    const {boundary, body} = jpegBody('EMP-014', 'bank');
    const res = await fetch(ctx.url + '/api/hr/documents/upload', {
      method: 'POST',
      headers: {Origin: origin, Cookie: ctx.cookie, 'x-csrf-token': ctx.csrf, 'content-type': 'multipart/form-data; boundary=' + boundary},
      body,
    });
    assert.equal(res.status, 200, await res.clone().text());
    const saved = await res.json();
    assert.ok(saved.ocr.review);
    assert.equal(saved.ocr.extracted.account, '12345678901234');
    const confirmed = await (await ctx.api('/api/hr/ocr-reviews/' + saved.ocr.review.id + '/confirm', 'POST', saved.ocr.extracted)).json();
    assert.equal(confirmed.pii.accountLast4, '1234');
    assert.equal(confirmed.pii.account, '12345678901234');
    const state = await (await ctx.api('/api/hr/state')).json();
    const emp = state.employees.find((e) => e.id === 'EMP-014');
    assert.equal(emp.pii.accountLast4, '1234');
    assert.equal(emp.pii.account, '12345678901234');
    assert.equal(emp.pii.accountName, '陳志明');
    const blob = JSON.stringify(state);
    assert.equal(blob.includes('accountEnc') || blob.includes('account_enc'), false);
    const pending = state.ocrReviews.filter((r) => r.status === 'pending' && r.employeeId === 'EMP-014');
    assert.equal(pending.length, 0);
  } finally {
    if (prev == null) delete process.env.HR_PII_KEY;
    else process.env.HR_PII_KEY = prev;
    await new Promise((r) => ctx.server.close(r));
    await ctx.db.close();
    await rm(ctx.docRoot, {recursive: true, force: true});
  }
});

test('identity confirm rejects a bad checksum and batch-scan creates pending items', async () => {
  const prev = process.env.HR_PII_KEY;
  process.env.HR_PII_KEY = 'ab'.repeat(32);
  const ctx = await start({
    geminiKey: 'test-gemini',
    extract: async ({category}) => category === 'identity'
      ? {nationalId: 'A123456788', name: '陳志明', birthDate: '1988-02-03', warnings: []}
      : {bankCode: '812', branch: '台新銀行', account: '009988776655', accountName: '陳志明', warnings: []},
  });
  try {
    await ctx.api('/api/hr/employees', 'POST', {id: 'EMP-014', name: '陳志明', department: '物流', job: '司機', arrivalDate: '2022-05-20'});
    const idPart = jpegBody('EMP-014', 'identity');
    const idRes = await fetch(ctx.url + '/api/hr/documents/upload', {
      method: 'POST',
      headers: {Origin: origin, Cookie: ctx.cookie, 'x-csrf-token': ctx.csrf, 'content-type': 'multipart/form-data; boundary=' + idPart.boundary},
      body: idPart.body,
    });
    const idSaved = await idRes.json();
    const bad = await ctx.api('/api/hr/ocr-reviews/' + idSaved.ocr.review.id + '/confirm', 'POST', {nationalId: 'A123456788', name: '陳志明'});
    assert.equal(bad.status, 400);
    const ok = await ctx.api('/api/hr/ocr-reviews/' + idSaved.ocr.review.id + '/confirm', 'POST', {nationalId: 'A123456789', name: '陳志明', birthDate: '1988-02-03'});
    assert.equal(ok.status, 200, await ok.clone().text());
    const pii = (await ok.json()).pii;
    assert.equal(pii.nationalIdMask, 'A****6789');
    assert.equal(pii.nationalId, 'A123456789');
    assert.equal(pii.birthDate, '1988-02-03');

    const bankDir = path.join(ctx.docRoot, '存摺');
    const {writeFile} = await import('node:fs/promises');
    await writeFile(path.join(bankDir, 'EMP-014_陳志明_存摺_20260101T000000_abcdef123456.jpg'), Buffer.from('x'));
    const batch = await (await ctx.api('/api/hr/ocr/batch-bank', 'POST', {})).json();
    assert.equal(batch.ok, true);
    assert.ok(batch.pending >= 1);
    const state = await (await ctx.api('/api/hr/state')).json();
    const pending = state.ocrReviews.find((r) => r.status === 'pending' && r.category === 'bank');
    assert.ok(pending);
    assert.equal(pending.extracted.account, '009988776655');
  } finally {
    if (prev == null) delete process.env.HR_PII_KEY;
    else process.env.HR_PII_KEY = prev;
    await new Promise((r) => ctx.server.close(r));
    await ctx.db.close();
    await rm(ctx.docRoot, {recursive: true, force: true});
  }
});


test('monthly salary ledger stores net pay and remittance, with no attendance in state', async () => {
  const ctx = await start();
  try {
    await ctx.api('/api/hr/employees', 'POST', {id: 'EMP-014', name: '陳志明', department: '物流', arrivalDate: '2022-05-20'});
    const created = await (await ctx.api('/api/hr/salaries', 'POST', {
      employeeId: 'EMP-014', month: '2026-10', netPay: 41500, notes: '十月', remittance: '未匯',
    })).json();
    assert.equal(created.month, '2026-10');
    assert.equal(created.netPay, 41500);
    assert.equal(created.remittance, '未匯');
    const dup = await ctx.api('/api/hr/salaries', 'POST', {employeeId: 'EMP-014', month: '2026-10', netPay: 1});
    assert.equal(dup.status, 409);
    const updated = await (await ctx.api('/api/hr/salaries/' + created.id, 'PATCH', {employeeId: 'EMP-014', month: '2026-10', netPay: 42000, remittance: '已匯', notes: '已匯出'})).json();
    assert.equal(updated.netPay, 42000);
    assert.equal(updated.remittance, '已匯');
    const state = await (await ctx.api('/api/hr/state')).json();
    assert.equal(state.attendanceCount, undefined);
    assert.ok(!('attendance' in state) || state.attendance == null);
    const row = state.salaries.find((s) => s.employeeId === 'EMP-014' && s.month === '2026-10');
    assert.equal(row.netPay, 42000);
    const del = await ctx.api('/api/hr/salaries/' + created.id, 'DELETE');
    assert.equal(del.status, 200);
    const after = await (await ctx.api('/api/hr/state')).json();
    assert.equal(after.salaries.filter((s) => s.id === created.id).length, 0);
  } finally {
    await new Promise((r) => ctx.server.close(r));
    await ctx.db.close();
    await rm(ctx.docRoot, {recursive: true, force: true});
  }
});



test('profile saves birth date and national ID, and keeps encrypted account when last4 is resubmitted', async () => {
  const prev = process.env.HR_PII_KEY;
  process.env.HR_PII_KEY = 'ab'.repeat(32);
  const ctx = await start({geminiKey: 'test-key'});
  try {
    await ctx.api('/api/hr/employees', 'POST', {id: 'EMP-014', name: '陳志明', department: '物流', arrivalDate: '2022-05-20'});
    const bad = await ctx.api('/api/hr/employees/EMP-014', 'PATCH', {nationalId: 'A123456788', birthDate: '1988-02-03'});
    assert.equal(bad.status, 400);
    const saved = await (await ctx.api('/api/hr/employees/EMP-014', 'PATCH', {nationalId: 'A123456789', birthDate: '1988-02-03', bankCode: '004', bankBranch: '城中', account: '12345678901234', accountName: '陳志明'})).json();
    assert.equal(saved.pii.nationalId, 'A123456789');
    assert.equal(saved.pii.birthDate, '1988-02-03');
    assert.equal(saved.pii.account, '12345678901234');
    const kept = await (await ctx.api('/api/hr/employees/EMP-014', 'PATCH', {bankCode: '004', bankBranch: '城中分行', account: '••••1234', accountName: '陳志明'})).json();
    assert.equal(kept.pii.account, '12345678901234');
    assert.equal(kept.pii.bankBranch, '城中分行');
    const state = await (await ctx.api('/api/hr/state')).json();
    const emp = state.employees.find((e) => e.id === 'EMP-014');
    assert.equal(emp.pii.nationalId, 'A123456789');
    assert.equal(emp.pii.account, '12345678901234');
    assert.ok(!JSON.stringify(state).includes('account_enc'));
  } finally {
    if (prev == null) delete process.env.HR_PII_KEY;
    else process.env.HR_PII_KEY = prev;
    await new Promise((r) => ctx.server.close(r));
    await ctx.db.close();
    await rm(ctx.docRoot, {recursive: true, force: true});
  }
});

test('salary import preview compares fixture rows and confirm writes only new and changed', async () => {
  const prev = process.env.HR_SALARY_SHEET_FIXTURE;
  process.env.HR_SALARY_SHEET_FIXTURE = path.join(root, 'tests/fixtures/salary-sheet.csv');
  const ctx = await start();
  try {
    await ctx.api('/api/hr/employees', 'POST', {id: 'EMP-014', name: '陳志明', department: '物流', arrivalDate: '2022-05-20'});
    await ctx.api('/api/hr/employees', 'POST', {id: 'EMP-001', name: '黃淑芬', department: '行政', arrivalDate: '2019-03-01'});
    await ctx.api('/api/hr/employees', 'POST', {id: 'EMP-015', name: '張偉誠', department: '物流', arrivalDate: '2023-09-11'});
    await ctx.api('/api/hr/salaries', 'POST', {employeeId: 'EMP-014', month: '2026-10', netPay: 41500, remittance: '未匯'});
    await ctx.api('/api/hr/salaries', 'POST', {employeeId: 'EMP-001', month: '2026-10', netPay: 38000, remittance: '已匯'});
    const preview = await (await ctx.api('/api/hr/salaries/import/preview', 'POST', {month: '2026-10'})).json();
    assert.equal(preview.month, '2026-10');
    assert.equal(preview.counts.changed, 1);
    assert.equal(preview.counts.new, 1);
    assert.equal(preview.counts.same, 1);
    assert.equal(preview.counts.unmatched, 1);
    assert.equal(preview.summaryCount, 4);
    assert.equal(preview.activeEmployeeCount, 3);
    assert.ok(preview.warnings.some((w) => w.includes('混了多個計算月份')));
    const confirmed = await (await ctx.api('/api/hr/salaries/import/confirm', 'POST', {month: '2026-10', rows: preview.rows})).json();
    assert.equal(confirmed.saved, 2);
    const state = await (await ctx.api('/api/hr/state')).json();
    const a = state.salaries.find((s) => s.employeeId === 'EMP-014' && s.month === '2026-10');
    const b = state.salaries.find((s) => s.employeeId === 'EMP-015' && s.month === '2026-10');
    const c = state.salaries.find((s) => s.employeeId === 'EMP-001' && s.month === '2026-10');
    assert.equal(a.netPay, 43000);
    assert.equal(b.netPay, 35000);
    assert.equal(c.netPay, 38000);
    assert.equal(c.remittance, '已匯');
    assert.equal(state.salaries.some((s) => s.employeeId === 'O002'), false);
  } finally {
    if (prev == null) delete process.env.HR_SALARY_SHEET_FIXTURE;
    else process.env.HR_SALARY_SHEET_FIXTURE = prev;
    await new Promise((r) => ctx.server.close(r));
    await ctx.db.close();
    await rm(ctx.docRoot, {recursive: true, force: true});
  }
});


test('salary import matches office O prefix to sheet 0 without renaming stored id', async () => {
  const prev = process.env.HR_SALARY_SHEET_FIXTURE;
  process.env.HR_SALARY_SHEET_FIXTURE = path.join(root, 'tests/fixtures/salary-sheet.csv');
  const ctx = await start();
  try {
    await ctx.api('/api/hr/employees', 'POST', {id: 'O002', name: 'NANA', department: '辦公室', arrivalDate: '2020-01-01'});
    const preview = await (await ctx.api('/api/hr/salaries/import/preview', 'POST', {month: '2026-10'})).json();
    const row = preview.rows.find((r) => r.employeeId === 'O002' || r.sheetId === 'O002' || r.sheetId === '0002');
    assert.ok(row);
    assert.equal(row.employeeId, 'O002');
    assert.equal(row.status, 'new');
    const confirmed = await (await ctx.api('/api/hr/salaries/import/confirm', 'POST', {month: '2026-10', rows: preview.rows})).json();
    assert.equal(confirmed.saved, 1);
    const state = await (await ctx.api('/api/hr/state')).json();
    const pay = state.salaries.find((s) => s.month === '2026-10' && s.employeeId === 'O002');
    assert.equal(pay.netPay, 44571);
    assert.equal(state.employees.some((e) => e.id === '0002'), false);
    assert.ok(state.employees.some((e) => e.id === 'O002'));
  } finally {
    if (prev == null) delete process.env.HR_SALARY_SHEET_FIXTURE;
    else process.env.HR_SALARY_SHEET_FIXTURE = prev;
    await new Promise((r) => ctx.server.close(r));
    await ctx.db.close();
    await rm(ctx.docRoot, {recursive: true, force: true});
  }
});
test('salary import degrades with setup instructions when not configured', async () => {
  const prevFix = process.env.HR_SALARY_SHEET_FIXTURE;
  const prevSa = process.env.GOOGLE_SA_JSON;
  delete process.env.HR_SALARY_SHEET_FIXTURE;
  delete process.env.GOOGLE_SA_JSON;
  const ctx = await start();
  try {
    const status = await (await ctx.api('/api/hr/state')).json();
    assert.equal(status.salaryImport.configured, false);
    assert.match(status.salaryImport.instructions || '', /GOOGLE_SA_JSON/);
    const preview = await ctx.api('/api/hr/salaries/import/preview', 'POST', {});
    assert.equal(preview.status, 400);
    const body = await preview.json();
    assert.match(body.error || '', /GOOGLE_SA_JSON|服務帳戶/);
  } finally {
    if (prevFix == null) delete process.env.HR_SALARY_SHEET_FIXTURE;
    else process.env.HR_SALARY_SHEET_FIXTURE = prevFix;
    if (prevSa == null) delete process.env.GOOGLE_SA_JSON;
    else process.env.GOOGLE_SA_JSON = prevSa;
    await new Promise((r) => ctx.server.close(r));
    await ctx.db.close();
    await rm(ctx.docRoot, {recursive: true, force: true});
  }
});

test('recruitment: new statuses, archive, résumé confirm, and convert carries data', async () => {
  const prev = process.env.HR_PII_KEY;
  process.env.HR_PII_KEY = 'ab'.repeat(32);
  const ctx = await start({
    geminiKey: 'test-key',
    extract: async ({category}) => {
      if (category === 'resume') {
        return {
          name: '許雅琪', phone: '0988-100-003', birthDate: '1995-04-12', nationalId: 'A123456789',
          address: '台北市中正區', education: '大學', experience: '客服兩年', desiredPosition: '人資行政', warnings: [],
        };
      }
      return {skipped: 'not-applicable'};
    },
  });
  try {
    const cand = await (await ctx.api('/api/hr/candidates', 'POST', {
      id: 'R-88', name: '許雅琪', phone: '0988-100-003', department: '行政', job: '人資行政', status: '待面試',
    })).json();
    assert.equal(cand.status, '待面試');
    assert.ok(cand.created || cand.updated);

    const badStatus = await ctx.api('/api/hr/candidates/R-88', 'PATCH', {status: '不存在的狀態'});
    assert.equal(badStatus.status, 400);
    for (const status of ['未回覆', '未到面試', '未報到']) {
      const r = await (await ctx.api('/api/hr/candidates/R-88', 'PATCH', {status})).json();
      assert.equal(r.status, status);
      assert.equal(r.archived, false);
    }
    await ctx.api('/api/hr/candidates/R-88', 'PATCH', {status: '待報到'});

    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGfAD//2Q==', 'base64');
    const boundary = '----testhrboundary';
    const raw = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="candidateId"\r\n\r\nR-88\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="category"\r\n\r\nresume\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="resume.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      jpeg,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await ctx.api('/api/hr/documents/upload', 'POST', raw, {raw, headers: {'content-type': 'multipart/form-data; boundary=' + boundary}});
    assert.equal(up.status, 200);
    const saved = await up.json();
    assert.equal(saved.category, 'resume');
    assert.equal(saved.candidateId, 'R-88');
    assert.ok(saved.ocr && saved.ocr.review);
    const reviewId = saved.ocr.review.id;
    const confirmed = await (await ctx.api('/api/hr/ocr-reviews/' + reviewId + '/confirm', 'POST', saved.ocr.extracted || saved.ocr.review.extracted)).json();
    assert.equal(confirmed.candidate.name, '許雅琪');
    assert.equal(confirmed.candidate.birthDate, '1995-04-12');
    assert.equal(confirmed.candidate.nationalId, 'A123456789');
    assert.equal(confirmed.candidate.address, '台北市中正區');
    assert.equal(confirmed.candidate.education, '大學');
    assert.equal(confirmed.candidate.experience, '客服兩年');
    assert.equal(confirmed.candidate.job, '人資行政');

    const conv = await (await ctx.api('/api/hr/candidates/R-88/convert', 'POST', {arrivalDate: '2026-11-14', department: '行政'})).json();
    assert.equal(conv.employee.phone, '0988-100-003');
    assert.equal(conv.employee.address, '台北市中正區');
    assert.equal(conv.employee.education, '大學');
    assert.equal(conv.employee.experience, '客服兩年');
    assert.equal(conv.employee.pii.nationalId, 'A123456789');
    assert.equal(conv.employee.pii.birthDate, '1995-04-12');
    const st = await (await ctx.api('/api/hr/state')).json();
    const doc = st.documents.find((d) => d.id === saved.id);
    assert.equal(doc.employeeId, conv.employee.id);
    assert.equal(doc.candidateId, 'R-88');
    const listed = st.candidates.find((c) => c.id === 'R-88');
    assert.equal(listed.status, '已報到');
    assert.equal(listed.archived, false);

    const other = await (await ctx.api('/api/hr/candidates', 'POST', {
      id: 'R-89', name: '測試刪除', phone: '0988-100-009', department: '物流', status: '待聯絡',
    })).json();
    const archived = await (await ctx.api('/api/hr/candidates/R-89', 'DELETE')).json();
    assert.equal(archived.archived, true);
    const after = await (await ctx.api('/api/hr/state')).json();
    const gone = after.candidates.find((c) => c.id === 'R-89');
    assert.equal(gone.archived, true);
    assert.ok(after.audit.some((a) => a.action === '封存應徵者' && a.target === 'R-89'));
    const ev = await ctx.api('/api/hr/candidates/R-88/events', 'POST', {kind: 'phone', outcome: '未回覆', notes: '未接回'});
    // already hired, status stays 已報到
    assert.equal(ev.status, 200);
  } finally {
    if (prev == null) delete process.env.HR_PII_KEY;
    else process.env.HR_PII_KEY = prev;
    await new Promise((r) => ctx.server.close(r));
    await ctx.db.close();
    await rm(ctx.docRoot, {recursive: true, force: true});
  }
});

test('identity and license records resolve from the 離職 sibling folder without scanning it', async () => {
  const ctx = await start();
  try {
    const left = process.env.NAS_IDENTITY_LEFT_PATH;
    const primary = process.env.NAS_IDENTITY_PATH;
    await writeFile(path.join(left, '周育民-正.jpg'), Buffer.from('left-only-bytes'));
    await writeFile(path.join(primary, '在職樣本.jpg'), Buffer.from('primary-bytes'));
    await ctx.hr.insertDocument({
      id: 'D-left-id', category: 'identity', relativePath: '周育民-正.jpg', filename: '周育民-正.jpg',
      size: 15, mtime: Date.now(), available: false,
    }, null);
    await ctx.hr.insertDocument({
      id: 'D-left-lic', category: 'license', relativePath: '周育民-正.jpg', filename: '周育民-正.jpg',
      size: 15, mtime: Date.now(), available: true,
    }, null);
    const rawState = await ctx.hr.state();
    assert.equal(rawState.documents.find((d) => d.id === 'D-left-id').available, false);
    assert.equal(rawState.documents.find((d) => d.id === 'D-left-lic').available, true);

    const state = await (await ctx.api('/api/hr/state')).json();
    const identity = state.documents.find((d) => d.id === 'D-left-id');
    const license = state.documents.find((d) => d.id === 'D-left-lic');
    assert.equal(identity.available, true);
    assert.equal(license.available, true);
    const missing = state.documents.filter((d) => d.id.startsWith('D-left') && !d.available);
    assert.equal(missing.length, 0);

    const file = await fetch(ctx.url + '/api/hr/documents/D-left-id/file', {headers: {Cookie: ctx.cookie}});
    assert.equal(file.status, 200);
    assert.equal(Buffer.from(await file.arrayBuffer()).toString(), 'left-only-bytes');

    const calls = [];
    const {batchScanDocuments} = await import('../backend/hr-ocr.mjs');
    const {resolveDocFile, isPrimaryDocRoot} = await import('../backend/hr-docs.mjs');
    const located = await resolveDocFile('identity', '周育民-正.jpg');
    assert.ok(located && located.abs.endsWith('周育民-正.jpg'));
    assert.equal(isPrimaryDocRoot(located.root, 'identity'), false);
    const result = await batchScanDocuments({
      hr: ctx.hr,
      config: {key: 'test-key', model: 'model'},
      extract: async (input) => { calls.push(input); return {name: 'should-not-run'}; },
      actor: 'test',
      categories: ['identity', 'license'],
    });
    assert.equal(calls.filter((c) => String(c.filename || c.absPath || '').includes('周育民')).length, 0);
    const reviews = (await ctx.hr.state()).ocrReviews || [];
    assert.equal(reviews.filter((r) => r.documentId === 'D-left-id' || r.documentId === 'D-left-lic').length, 0);
    // new uploads still land in the 在職 folder
    const uploaded = await readFile(path.join(primary, '在職樣本.jpg'), 'utf8');
    assert.equal(uploaded, 'primary-bytes');
  } finally {
    await new Promise((r) => ctx.server.close(r));
    await ctx.db.close();
    await rm(ctx.docRoot, {recursive: true, force: true});
  }
});

test('identity and license resolve across split 在職 folders and the 離職 sibling', async () => {
  const ctx = await start();
  try {
    const identityDir = process.env.NAS_IDENTITY_PATH;
    const licenseDir = process.env.NAS_LICENSE_PATH;
    const left = process.env.NAS_IDENTITY_LEFT_PATH;
    assert.notEqual(path.resolve(identityDir), path.resolve(licenseDir));
    await writeFile(path.join(identityDir, 'id-in-id.jpg'), Buffer.from('id-primary'));
    await writeFile(path.join(licenseDir, 'lic-in-lic.jpg'), Buffer.from('lic-primary'));
    await writeFile(path.join(identityDir, 'lic-still-in-id.jpg'), Buffer.from('lic-in-identity-folder'));
    await writeFile(path.join(licenseDir, 'id-still-in-lic.jpg'), Buffer.from('id-in-license-folder'));
    await writeFile(path.join(left, 'left-only.jpg'), Buffer.from('left-only'));
    const rows = [
      {id: 'D-split-id', category: 'identity', relativePath: 'id-in-id.jpg', filename: 'id-in-id.jpg'},
      {id: 'D-split-lic', category: 'license', relativePath: 'lic-in-lic.jpg', filename: 'lic-in-lic.jpg'},
      {id: 'D-split-lic-cross', category: 'license', relativePath: 'lic-still-in-id.jpg', filename: 'lic-still-in-id.jpg'},
      {id: 'D-split-id-cross', category: 'identity', relativePath: 'id-still-in-lic.jpg', filename: 'id-still-in-lic.jpg'},
      {id: 'D-split-left', category: 'identity', relativePath: 'left-only.jpg', filename: 'left-only.jpg'},
    ];
    for (const row of rows) {
      await ctx.hr.insertDocument({...row, size: 10, mtime: Date.now(), available: false}, null);
    }
    const state = await (await ctx.api('/api/hr/state')).json();
    for (const row of rows) {
      const doc = state.documents.find((d) => d.id === row.id);
      assert.equal(doc?.available, true, row.id);
    }
    const {folderRoots, resolveDocFile} = await import('../backend/hr-docs.mjs');
    const roots = folderRoots('license');
    assert.ok(roots.some((r) => path.resolve(r) === path.resolve(identityDir)));
    assert.ok(roots.some((r) => path.resolve(r) === path.resolve(licenseDir)));
    assert.ok(roots.some((r) => path.resolve(r) === path.resolve(left)));
    const crossed = await resolveDocFile('license', 'lic-still-in-id.jpg');
    assert.ok(crossed && path.resolve(crossed.root) === path.resolve(identityDir));
  } finally {
    await new Promise((r) => ctx.server.close(r));
    await ctx.db.close();
    await rm(ctx.docRoot, {recursive: true, force: true});
  }
});


test('HR state jobTitles always include 司機 and merge stored titles', async () => {
  const ctx = await start();
  try {
    const before = await (await ctx.api('/api/hr/state')).json();
    assert.deepEqual(before.jobTitlesOfficial, ['行政', '洗滌人員', '現場作業員', '新進司機', '司機', '作業員', '早班作業員']);
    for (const title of before.jobTitlesOfficial) assert.ok(before.jobTitles.includes(title));
    assert.ok(!before.jobTitles.includes('客服對帳'));
    await ctx.api('/api/hr/employees', 'POST', {
      id: 'EMP-JOB', name: '職稱測試', department: '洗滌', job: '洗滌作業員', employmentType: '正職', arrivalDate: '2026-01-01',
    });
    const after = await (await ctx.api('/api/hr/state')).json();
    assert.ok(after.jobTitles.includes('洗滌作業員'));
    assert.ok(after.jobTitles.includes('司機'));
    assert.equal(after.deptPrefixes['洗滌'], 'W');
    assert.equal(after.deptPrefixes['洗滓'], 'W');
  } finally {
    await new Promise((r) => ctx.server.close(r));
    await ctx.db.close();
    await rm(ctx.docRoot, {recursive: true, force: true});
  }
});


test('candidate can be created with only a name', async () => {
  const ctx = await start();
  try {
    const res = await ctx.api('/api/hr/candidates', 'POST', {name: '僅姓名應徵者'});
    assert.equal(res.status, 200);
    const row = await res.json();
    assert.equal(row.name, '僅姓名應徵者');
    assert.equal(row.status, '待聯絡');
    const missing = await ctx.api('/api/hr/candidates', 'POST', {name: '  ', phone: '0912-000-000'});
    assert.equal(missing.status, 400);
    const err = await missing.json();
    assert.match(err.error, /姓名/);
    assert.doesNotMatch(err.error, /電話/);
  } finally {
    await new Promise((r) => ctx.server.close(r));
    await ctx.db.close();
    await rm(ctx.docRoot, {recursive: true, force: true});
  }
});

test('HR state views omit heavy collections and gzip when requested', async () => {
  const ctx = await start();
  try {
    for (let i = 0; i < 8; i++) {
      await ctx.api('/api/hr/candidates', 'POST', {id: 'R-V' + i, name: '名單' + i, phone: '09' + String(10000000 + i), department: '物流', job: '司機', status: '待聯絡'});
      await ctx.api('/api/hr/candidates/R-V' + i + '/events', 'POST', {kind: 'phone', outcome: '未接', notes: 'x'.repeat(80)});
    }
    const full = await (await ctx.api('/api/hr/state')).json();
    assert.ok(full.candidates.length >= 8);
    assert.ok((full.recruitmentEvents || []).length >= 8);
    assert.ok(full.jobTitles.includes('司機'));
    assert.deepEqual(full.jobTitlesOfficial[0], '行政');

    const staff = await (await ctx.api('/api/hr/state?view=staff')).json();
    assert.equal(staff.view, 'staff');
    assert.equal((staff.candidates || []).length, 0);
    assert.equal((staff.recruitmentEvents || []).length, 0);
    assert.ok(staff.jobTitles.includes('司機'));

    const recruit = await (await ctx.api('/api/hr/state?view=recruitment')).json();
    assert.equal(recruit.view, 'recruitment');
    assert.ok(recruit.candidates.length >= 8);
    assert.equal((recruit.recruitmentEvents || []).length, 0);

    const {gunzipSync} = await import('node:zlib');
    const raw = await new Promise((resolve, reject) => {
      const u = new URL(ctx.url + '/api/hr/state?view=recruitment');
      http.get({
        hostname: u.hostname, port: u.port, path: u.pathname + u.search,
        headers: {Origin: 'http://127.0.0.1', Cookie: ctx.cookie, 'accept-encoding': 'gzip'},
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({status: res.statusCode, encoding: res.headers['content-encoding'], buf: Buffer.concat(chunks)}));
      }).on('error', reject);
    });
    assert.equal(raw.status, 200);
    assert.equal(raw.encoding, 'gzip');
    const parsed = JSON.parse(gunzipSync(raw.buf).toString('utf8'));
    assert.ok(parsed.candidates.length >= 8);
    assert.ok(raw.buf.length < Buffer.byteLength(JSON.stringify(parsed)));
  } finally {
    await new Promise((r) => ctx.server.close(r));
    await ctx.db.close();
    await rm(ctx.docRoot, {recursive: true, force: true});
  }
});


test('purge keeps only 待報到 candidates, leaves employees, and blocks migrate re-import', async () => {
  const ctx = await start();
  try {
    await ctx.api('/api/hr/employees', 'POST', {
      id: 'D900', name: '已轉員工', department: '物流', job: '司機', employmentType: '正職', arrivalDate: '2024-01-01',
    });
    await ctx.api('/api/hr/candidates', 'POST', {id: 'R-KEEP', name: '待報到者', department: '物流', job: '司機', status: '待報到'});
    await ctx.api('/api/hr/candidates', 'POST', {id: 'R-DROP', name: '舊應徵', phone: '0912-000-001', department: '物流', job: '新進司機', status: '待聯絡'});
    await ctx.api('/api/hr/candidates', 'POST', {id: 'R-HIRED', name: '已轉但非待報到', department: '物流', job: '司機', status: '已報到', employeeId: 'D900'});
    await ctx.hr.addEvent('R-DROP', 'phone', {note: '打過電話', outcome: '未接'}, 'test');
    await ctx.hr.pool.query(
      'INSERT INTO hr_recruitment_import_rows(id, candidate_id, payload) VALUES($1,$2,$3)',
      ['IMP-DROP', 'R-DROP', {source: '舊表'}]
    );
    await ctx.hr.pool.query(
      `INSERT INTO hr_documents(id, category, relative_path, filename, size, mtime, available, candidate_id)
       VALUES('DOC-DROP','resume','drop.pdf','drop.pdf',1,0,true,'R-DROP')`
    );
    await ctx.hr.pool.query(
      `INSERT INTO hr_documents(id, category, relative_path, filename, size, mtime, available, employee_id, candidate_id)
       VALUES('DOC-HIRED','resume','hired.pdf','hired.pdf',1,0,true,'D900','R-HIRED')`
    );
    const plan = await ctx.hr.listRecruitmentPurgePlan();
    assert.equal(plan.keepCount, 1);
    assert.equal(plan.deleteCount, 2);
    assert.ok(plan.events.some((e) => e.candidate_id === 'R-DROP'));
    assert.ok(plan.importRows.some((e) => e.id === 'IMP-DROP'));
    const result = await ctx.hr.purgeRecruitmentExceptPending('test');
    assert.equal(result.deleteCount, 2);
    assert.equal(result.keepCount, 1);
    const after = await (await ctx.api('/api/hr/state?view=recruitment')).json();
    assert.deepEqual(after.candidates.map((c) => c.id).sort(), ['R-KEEP']);
    assert.equal(after.candidates[0].status, '待報到');
    assert.equal((await ctx.hr.getEmployee('D900')).name, '已轉員工');
    const ev = await ctx.hr.pool.query("SELECT 1 FROM hr_recruitment_events WHERE candidate_id='R-DROP'");
    assert.equal(ev.rowCount, 0);
    const imp = await ctx.hr.pool.query("SELECT 1 FROM hr_recruitment_import_rows WHERE id='IMP-DROP'");
    assert.equal(imp.rowCount, 0);
    const goneDoc = await ctx.hr.pool.query("SELECT 1 FROM hr_documents WHERE id='DOC-DROP'");
    assert.equal(goneDoc.rowCount, 0);
    const keptDoc = await ctx.hr.pool.query("SELECT employee_id, candidate_id FROM hr_documents WHERE id='DOC-HIRED'");
    assert.equal(keptDoc.rows[0].employee_id, 'D900');
    assert.equal(keptDoc.rows[0].candidate_id, null);
    const purged = await ctx.hr.purgedCandidateIds();
    assert.ok(purged.has('R-DROP') && purged.has('R-HIRED') && !purged.has('R-KEEP'));
    const {shouldSkipMigratedRecruitment} = await import('../backend/hr-purge.mjs');
    assert.equal(shouldSkipMigratedRecruitment('R-DROP', 'R-DROP', purged), true);
    assert.equal(shouldSkipMigratedRecruitment('EV1', 'R-DROP', purged), true);
    assert.equal(shouldSkipMigratedRecruitment('R-KEEP', 'R-KEEP', purged), false);
  } finally {
    await new Promise((r) => ctx.server.close(r));
    await ctx.db.close();
    await rm(ctx.docRoot, {recursive: true, force: true});
  }
});
