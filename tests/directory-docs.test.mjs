import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../backend/store.mjs';
import {HrStore} from '../backend/hr-store.mjs';
import {createHandler} from '../backend/app.mjs';
import {openPglite} from '../scripts/pglite-pool.mjs';
import {prepareDocFolders} from '../scripts/seed-hr.mjs';
import {
  canonicalKind, orgDirectoryKind, inferDirectoryRoot,
  defaultRelativePath, isValidStoredPath, safeJoinRoot, safeFileName,
  folderBaseName, RESERVED_EMPLOYEE_FOLDERS, KIND_FOLDERS,
} from '../backend/directory-docs.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const origin = 'http://companybrain.test';

function multipart(files, boundary = '----DirDocBound') {
  const chunks = [];
  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`
    ));
    chunks.push(Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {body: Buffer.concat(chunks), boundary};
}

async function start() {
  const docRoot = await mkdtemp(path.join(os.tmpdir(), 'dir-docs-'));
  await prepareDocFolders(path.join(docRoot, 'hr'));
  // Share layout mirrors NAS: <root>/百麒/員工/<pii folders>
  const share = path.join(docRoot, '百麒');
  await mkdir(path.join(share, '員工'), {recursive: true});
  process.env.NAS_DIRECTORY_ROOT = share;
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
    if (extra.raw) payload = {headers: {...headers, ...extra.headers}, body: extra.raw};
    else if (body !== undefined) payload = {headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)};
    else payload = {headers};
    return fetch(url + p, {method, ...payload});
  }
  const login = await api('/api/login', 'POST', {username: 'admin1', password: 'abcdefghijklmnop'});
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  csrf = (await login.json()).csrf;
  return {url, api, db, server, store, hr, cookie, csrf, docRoot, share};
}

async function stop(ctx) {
  await new Promise((r) => ctx.server.close(r));
  await ctx.db.close();
  await rm(ctx.docRoot, {recursive: true, force: true});
}

test('kind mapping, path inference, sanitization and reserved employee folders', () => {
  assert.equal(canonicalKind('廠商'), 'vendors');
  assert.equal(canonicalKind('客人'), 'clients');
  assert.equal(canonicalKind('員工'), 'employees');
  assert.equal(orgDirectoryKind({kind: '飯店'}), 'clients');
  assert.equal(orgDirectoryKind({kind: '設備商'}), 'vendors');
  assert.equal(orgDirectoryKind({kind: '內部'}), 'vendors');
  assert.equal(orgDirectoryKind({}), 'vendors');
  assert.equal(
    inferDirectoryRoot('/volume1/共用資料匣/百麒(共用)/百麒/員工/員工身分證(在職)'),
    '/volume1/共用資料匣/百麒(共用)/百麒',
  );

  const rel = defaultRelativePath('vendors', 'abc-123', '日澤洗衣');
  assert.equal(rel, '廠商/abc-123_日澤洗衣');
  assert.ok(isValidStoredPath('vendors', 'abc-123', rel));
  assert.ok(!isValidStoredPath('vendors', 'abc-123', '廠商/../員工/員工身分證(在職)'));
  assert.ok(!isValidStoredPath('employees', 'EMP-001', '員工/員工身分證(在職)'));
  assert.ok(!isValidStoredPath('employees', 'EMP-001', '員工/EMP-001_員工身分證(在職)'.replace('EMP-001_', '')));
  for (const name of RESERVED_EMPLOYEE_FOLDERS) {
    assert.ok(!isValidStoredPath('employees', 'EMP-001', KIND_FOLDERS.employees + '/' + name));
  }
  const empRel = defaultRelativePath('employees', 'EMP-001', '黃淑芬');
  assert.equal(empRel, '員工/EMP-001_黃淑芬');
  assert.ok(isValidStoredPath('employees', 'EMP-001', empRel));
  assert.equal(safeFileName('../secret.pdf'), 'secret.pdf');
  assert.equal(safeFileName('合約 書.pdf'), '合約 書.pdf');
  assert.equal(safeJoinRoot('/share/百麒', '../etc/passwd'), null);
  assert.equal(folderBaseName('baiqi', '百麒'), 'baiqi_百麒');
});

test('vendor, client and employee folders: upload, NAS-dropped files, download, delete, isolation, auth', async () => {
  const ctx = await start();
  try {
    const state = await (await ctx.api('/api/state')).json();
    const vendorId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const clientId = 'ffffffff-0000-4111-8222-333333333333';
    const next = {
      ...state,
      organizations: [
        ...state.organizations,
        {id: vendorId, name: '日澤', kind: '設備商', mark: '日', en: 'VENDOR', contact: '窗口', role: '窗口', manager: '—', contract: '—', memo: '', prices: []},
        {id: clientId, name: 'H2O', kind: '飯店', mark: 'H', en: 'HOTEL', contact: '窗口', role: '窗口', manager: '—', contract: '—', memo: '', prices: []},
      ],
    };
    assert.equal((await ctx.api('/api/state', 'PUT', next)).status, 200);

    const emp = await (await ctx.api('/api/hr/employees', 'POST', {
      id: 'EMP-014', name: '陳志明', department: '行政', job: '人資行政', employmentType: '正職', arrivalDate: '2019-03-01',
    })).json();
    assert.equal(emp.id, 'EMP-014');

    // Lazy create on first list
    const listed = await (await ctx.api(`/api/directory/vendors/${vendorId}/documents`)).json();
    assert.equal(listed.folder, `廠商/${vendorId}_日澤`);
    assert.equal(listed.files.length, 0);
    assert.ok(existsSync(path.join(ctx.share, listed.folder)));

    // Files dropped directly on the NAS appear without an upload record
    await writeFile(path.join(ctx.share, listed.folder, '報價單-現場放入.pdf'), 'from-nas');
    const afterDrop = await (await ctx.api(`/api/directory/vendors/${vendorId}/documents`)).json();
    assert.equal(afterDrop.files.length, 1);
    assert.equal(afterDrop.files[0].name, '報價單-現場放入.pdf');
    assert.equal(afterDrop.files[0].size, Buffer.byteLength('from-nas'));

    const {body, boundary} = multipart([
      {name: '合約.pdf', type: 'application/pdf', body: '%PDF-1.4 vendor-contract'},
      {name: '說明.txt', type: 'text/plain', body: 'hello vendor'},
    ]);
    const uploaded = await ctx.api(`/api/directory/vendors/${vendorId}/documents`, 'POST', undefined, {
      raw: body,
      headers: {'content-type': 'multipart/form-data; boundary=' + boundary},
    });
    const up = await uploaded.json();
    assert.equal(uploaded.status, 200, up.error || JSON.stringify(up));
    assert.equal(up.files.length, 2);

    const all = await (await ctx.api(`/api/directory/vendors/${vendorId}/documents`)).json();
    assert.equal(all.files.length, 3);
    const names = all.files.map((f) => f.name).sort();
    assert.deepEqual(names, ['合約.pdf', '報價單-現場放入.pdf', '說明.txt'].sort());

    const downloaded = await ctx.api(`/api/directory/vendors/${vendorId}/documents/file?name=${encodeURIComponent('報價單-現場放入.pdf')}`);
    assert.equal(downloaded.status, 200);
    assert.equal(await downloaded.text(), 'from-nas');

    // Rename the org: stored path stays stable
    const renamed = {
      ...next,
      revision: (await (await ctx.api('/api/state')).json()).revision,
      organizations: next.organizations.map((o) => o.id === vendorId ? {...o, name: '日澤更新名'} : o),
    };
    assert.equal((await ctx.api('/api/state', 'PUT', renamed)).status, 200);
    const still = await (await ctx.api(`/api/directory/vendors/${vendorId}/documents`)).json();
    assert.equal(still.folder, `廠商/${vendorId}_日澤`);
    assert.equal(still.files.length, 3);

    // Kind isolation: hotel is clients, not vendors
    assert.equal((await ctx.api(`/api/directory/vendors/${clientId}/documents`)).status, 400);
    const hotel = await (await ctx.api(`/api/directory/clients/${clientId}/documents`)).json();
    assert.equal(hotel.folder, `客戶/${clientId}_H2O`);
    assert.equal(hotel.files.length, 0);

    const empDocs = await (await ctx.api('/api/directory/employees/EMP-014/documents')).json();
    assert.equal(empDocs.folder, '員工/EMP-014_陳志明');
    const empUpload = multipart([{name: '切結書.pdf', type: 'application/pdf', body: '%PDF employee'}]);
    assert.equal((await ctx.api('/api/directory/employees/EMP-014/documents', 'POST', undefined, {
      raw: empUpload.body,
      headers: {'content-type': 'multipart/form-data; boundary=' + empUpload.boundary},
    })).status, 200);
    const empListed = await (await ctx.api('/api/directory/employees/EMP-014/documents')).json();
    assert.equal(empListed.files.length, 1);
    // Must not write into the existing PII folders
    const identityDir = process.env.NAS_IDENTITY_PATH;
    const piiFiles = await (await import('node:fs/promises')).readdir(identityDir);
    assert.ok(!piiFiles.includes('切結書.pdf'));
    assert.ok(existsSync(path.join(ctx.share, '員工', 'EMP-014_陳志明', '切結書.pdf')));

    // Path traversal on file name
    assert.equal((await ctx.api(`/api/directory/vendors/${vendorId}/documents/file?name=${encodeURIComponent('../員工/秘密.pdf')}`)).status, 400);
    assert.equal((await ctx.api(`/api/directory/vendors/${vendorId}/documents/file?name=${encodeURIComponent('合約.pdf')}`, 'DELETE')).status, 200);
    const afterDel = await (await ctx.api(`/api/directory/vendors/${vendorId}/documents`)).json();
    assert.ok(!afterDel.files.some((f) => f.name === '合約.pdf'));
    assert.ok(afterDel.files.some((f) => f.name === '說明.txt'));

    // Missing entity
    assert.equal((await ctx.api('/api/directory/employees/NOPE-1/documents')).status, 404);
    // Auth required
    const naked = await fetch(ctx.url + `/api/directory/vendors/${vendorId}/documents`, {headers: {Origin: origin}});
    assert.equal(naked.status, 401);
    // Reject executable upload
    const exe = multipart([{name: 'evil.exe', type: 'application/octet-stream', body: 'MZ'}]);
    const rejected = await ctx.api(`/api/directory/vendors/${vendorId}/documents`, 'POST', undefined, {
      raw: exe.body,
      headers: {'content-type': 'multipart/form-data; boundary=' + exe.boundary},
    });
    assert.equal(rejected.status, 400);
  } finally {
    await stop(ctx);
  }
});

test('old folders can be linked without moving files; PII folders stay blocked; apply-exact is idempotent', async () => {
  const ctx = await start();
  try {
    const state = await (await ctx.api('/api/state')).json();
    const clientId = 'ffffffff-0000-4111-8222-333333333333';
    const next = {
      ...state,
      organizations: [
        ...state.organizations,
        {id: clientId, name: 'H2O', kind: '飯店', mark: 'H', en: 'HOTEL', contact: '窗口', role: '窗口', manager: '—', contract: '—', memo: '', prices: [], aliases: ['H2O']},
        {id: 'indigo-id', name: '英迪格', kind: '飯店', mark: 'I', en: 'HOTEL', contact: '窗口', role: '窗口', manager: '—', contract: '—', memo: '', prices: [], aliases: []},
      ],
    };
    assert.equal((await ctx.api('/api/state', 'PUT', next)).status, 200);

    const old = path.join(ctx.share, '合約書、報價單', 'H2O');
    await mkdir(path.join(old, '舊合約'), {recursive: true});
    await writeFile(path.join(old, '合約.pdf'), 'old-contract');
    await writeFile(path.join(old, '舊合約', '附約.pdf'), 'old-annex');
    await mkdir(path.join(ctx.share, '合約書、報價單', 'INDIGO'), {recursive: true});
    await writeFile(path.join(ctx.share, '合約書、報價單', 'INDIGO', '報價.xlsx'), 'indigo-quote');

    // Manual link
    const linked = await ctx.api(`/api/directory/clients/${clientId}/folders`, 'POST', {relativePath: '合約書、報價單/H2O'});
    assert.equal(linked.status, 200, await linked.text());
    const listed = await (await ctx.api(`/api/directory/clients/${clientId}/documents`)).json();
    assert.ok(listed.folders.some((f) => f.role === 'primary'));
    assert.ok(listed.folders.some((f) => f.relativePath === '合約書、報價單/H2O' && f.role === 'linked'));
    const names = listed.files.map((f) => f.path);
    assert.ok(names.includes('合約.pdf'));
    assert.ok(names.includes('舊合約/附約.pdf'));
    assert.ok(listed.dirs.some((d) => d.path === '舊合約'));

    const downloaded = await ctx.api(`/api/directory/clients/${clientId}/documents/file?folder=${encodeURIComponent('合約書、報價單/H2O')}&path=${encodeURIComponent('舊合約/附約.pdf')}`);
    assert.equal(downloaded.status, 200);
    assert.equal(await downloaded.text(), 'old-annex');
    // Original file still in the old folder — nothing was moved
    assert.ok(existsSync(path.join(old, '舊合約', '附約.pdf')));

    // PII folder cannot be linked
    const piiRel = '員工/員工身分證(在職)';
    await mkdir(path.join(ctx.share, '員工', '員工身分證(在職)'), {recursive: true});
    const pii = await ctx.api(`/api/directory/clients/${clientId}/folders`, 'POST', {relativePath: piiRel});
    assert.equal(pii.status, 400);

    // Scan + apply exact (INDIGO synonym)
    const scan = await (await ctx.api('/api/directory/links/scan')).json();
    assert.ok(scan.exact.some((r) => r.path === '合約書、報價單/INDIGO'));
    const applied = await (await ctx.api('/api/directory/links/apply-exact', 'POST', {})).json();
    assert.ok(applied.added >= 1);
    const again = await (await ctx.api('/api/directory/links/apply-exact', 'POST', {})).json();
    assert.equal(again.added, 0);
    const indigo = await (await ctx.api('/api/directory/clients/indigo-id/documents')).json();
    assert.ok(indigo.folders.some((f) => f.relativePath === '合約書、報價單/INDIGO'));
    assert.ok(indigo.files.some((f) => f.name === '報價.xlsx' || f.path === '報價.xlsx'));
  } finally {
    await stop(ctx);
  }
});
