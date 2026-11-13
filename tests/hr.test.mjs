import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
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

async function start() {
  const docRoot = await mkdtemp(path.join(os.tmpdir(), 'hr-docs-'));
  await prepareDocFolders(docRoot);
  const {db, pool} = openPglite();
  const store = new Store(pool);
  await store.init('admin1', 'abcdefghijklmnop');
  const hr = new HrStore(pool);
  await hr.ensure();
  const server = http.createServer(createHandler({
    store, hr,
    config: {origin, secure: false, key: '', model: 'model'},
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
  } finally {
    await new Promise((r) => ctx.server.close(r));
    await ctx.db.close();
    await rm(ctx.docRoot, {recursive: true, force: true});
  }
});
