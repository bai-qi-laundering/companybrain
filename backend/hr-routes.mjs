import {spawn} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AppError} from './domain.mjs';
import {newId, DOC_TYPES} from './hr-store.mjs';
import {folderConfig, saveUpload, scanFolders, fileId, savedPath, UPLOAD_LIMIT, MIMES} from './hr-docs.mjs';
import {runAfterUpload, batchScanBank, geminiReady} from './hr-ocr.mjs';
import {hasPiiKey} from './hr-crypto.mjs';
import {importStatus, loadSheetValues, parseSheetRows, compareSalaryRows, normalizeColumns, SETUP_INSTRUCTIONS} from './hr-salary-import.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXCEL_CLI = path.join(HERE, 'hr-excel', 'cli.py');

function send(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'content-length': data.length});
  res.end(data);
}

function parseUrl(req) {
  return new URL(req.url, 'http://localhost');
}

function actorOf(session) {
  return session?.username || session?.user || 'admin';
}

async function readRaw(req, limit = UPLOAD_LIMIT) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new AppError(400, '檔案請小於 12MB');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function boundaryOf(req) {
  const ct = req.headers['content-type'] || '';
  const m = ct.match(/multipart\/form-data;\s*boundary=([^;]+)/i);
  return m ? m[1].trim().replace(/^"|"$/g, '') : '';
}

function parseMultipart(buf, boundary) {
  const sep = Buffer.from('--' + boundary);
  const parts = [];
  let start = buf.indexOf(sep);
  while (start >= 0) {
    const after = start + sep.length;
    if (buf.slice(after, after + 2).toString() === '--') break;
    const headEnd = buf.indexOf('\r\n\r\n', after);
    if (headEnd < 0) break;
    const next = buf.indexOf(sep, headEnd);
    if (next < 0) break;
    const header = buf.slice(after, headEnd).toString('utf8');
    let body = buf.slice(headEnd + 4, next);
    if (body.slice(-2).toString() === '\r\n') body = body.slice(0, -2);
    const name = /name="([^"]+)"/.exec(header)?.[1] || '';
    const filename = /filename="([^"]*)"/.exec(header)?.[1] || '';
    const mime = /content-type:\s*([^\r\n]+)/i.exec(header)?.[1]?.trim() || '';
    parts.push({name, filename, mime, body});
    start = next;
  }
  return parts;
}

function runExcel(args, raw) {
  return new Promise((resolve, reject) => {
    const py = process.env.HR_PYTHON || 'python3';
    const child = spawn(py, [EXCEL_CLI, ...args], {stdio: ['pipe', 'pipe', 'pipe']});
    const out = [], err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new AppError(400, Buffer.concat(err).toString('utf8').slice(0, 500) || 'Excel 解析失敗'));
      try { resolve(JSON.parse(Buffer.concat(out).toString('utf8'))); }
      catch { reject(new AppError(400, 'Excel 解析結果不是 JSON')); }
    });
    child.stdin.end(raw);
  });
}

export async function handleHr(req, res, {hr, session, method, path: p, config = {}, extract} = {}) {
  if (!hr) return false;
  if (!p.startsWith('/api/hr')) return false;
  const url = parseUrl(req);
  const pathname = url.pathname;
  const actor = actorOf(session);

  if (method === 'GET' && pathname === '/api/hr/state') {
    const state = await hr.state();
    state.ocr = {geminiConfigured: geminiReady(config), piiKeyConfigured: hasPiiKey()};
    const sheet = await hr.getSalaryImport();
    state.salaryImport = {...sheet, ...(await importStatus())};
    send(res, 200, state);
    return true;
  }
  if (method === 'GET' && pathname === '/api/hr/folders') {
    const folders = folderConfig();
    send(res, 200, {folders, labels: DOC_TYPES});
    return true;
  }
  if (method === 'GET' && pathname === '/api/hr/next-id') {
    const department = url.searchParams.get('department') || '';
    const prefix = url.searchParams.get('prefix') || '';
    const id = await hr.nextEmployeeId(department, prefix);
    send(res, 200, {id, department, prefix: prefix || undefined});
    return true;
  }

  if (method === 'POST' && pathname === '/api/hr/employees') {
    const body = JSON.parse(await readRaw(req, 200_000));
    const id = (body.id || await hr.nextEmployeeId()).toUpperCase();
    send(res, 200, await hr.upsertEmployee(id, body, actor, {create: true}));
    return true;
  }
  let m;
  if (method === 'PATCH' && (m = pathname.match(/^\/api\/hr\/employees\/([^/]+)$/))) {
    const body = JSON.parse(await readRaw(req, 200_000));
    send(res, 200, await hr.upsertEmployee(decodeURIComponent(m[1]), body, actor));
    return true;
  }
  if (method === 'POST' && pathname === '/api/hr/records') {
    const body = JSON.parse(await readRaw(req, 200_000));
    send(res, 200, await hr.addRecord(body.kind, body, actor));
    return true;
  }

  if (method === 'POST' && pathname === '/api/hr/candidates') {
    const body = JSON.parse(await readRaw(req, 200_000));
    const id = body.id || newId('R-');
    send(res, 200, await hr.upsertCandidate(id, body, actor, {create: true}));
    return true;
  }
  if (method === 'PATCH' && (m = pathname.match(/^\/api\/hr\/candidates\/([^/]+)$/))) {
    const body = JSON.parse(await readRaw(req, 200_000));
    send(res, 200, await hr.upsertCandidate(decodeURIComponent(m[1]), body, actor));
    return true;
  }
  if (method === 'POST' && (m = pathname.match(/^\/api\/hr\/candidates\/([^/]+)\/events$/))) {
    const body = JSON.parse(await readRaw(req, 200_000));
    send(res, 200, await hr.addEvent(decodeURIComponent(m[1]), body.kind, body, actor));
    return true;
  }
  if (method === 'POST' && (m = pathname.match(/^\/api\/hr\/candidates\/([^/]+)\/convert$/))) {
    const body = JSON.parse(await readRaw(req, 200_000) || '{}');
    send(res, 200, await hr.convert(decodeURIComponent(m[1]), body || {}, actor));
    return true;
  }
  if (method === 'DELETE' && (m = pathname.match(/^\/api\/hr\/candidates\/([^/]+)$/))) {
    send(res, 200, await hr.archiveCandidate(decodeURIComponent(m[1]), actor));
    return true;
  }

  if (method === 'POST' && pathname === '/api/hr/goals') {
    const body = JSON.parse(await readRaw(req, 200_000));
    send(res, 200, await hr.upsertGoal(body.department, body, actor));
    return true;
  }

  if (method === 'GET' && pathname === '/api/hr/salaries/import/status') {
    const sheet = await hr.getSalaryImport();
    send(res, 200, {...sheet, ...(await importStatus())});
    return true;
  }
  if (method === 'PATCH' && pathname === '/api/hr/settings/salaryImport') {
    const body = JSON.parse(await readRaw(req, 50_000) || '{}');
    send(res, 200, await hr.saveSalaryImport(body, actor));
    return true;
  }
  if (method === 'POST' && pathname === '/api/hr/salaries/import/preview') {
    const body = JSON.parse(await readRaw(req, 50_000) || '{}');
    const cfg = await hr.getSalaryImport();
    const columns = normalizeColumns(body.columns || cfg.columns);
    const values = await loadSheetValues({spreadsheetId: cfg.spreadsheetId, sheetTab: cfg.sheetTab});
    const parsed = parseSheetRows(values, columns);
    const month = body.month || parsed.months.at(-1) || '';
    const state = await hr.state();
    const compared = compareSalaryRows(parsed.rows, {employees: state.employees, salaries: state.salaries, month});
    send(res, 200, {month: compared.month, months: parsed.months, columns: parsed.columns, headers: parsed.headers, rows: compared.rows, counts: compared.counts, skipped: parsed.skipped, configured: true, summaryCount: compared.summaryCount, activeEmployeeCount: compared.activeEmployeeCount, warnings: compared.warnings});
    return true;
  }
  if (method === 'POST' && pathname === '/api/hr/salaries/import/confirm') {
    const body = JSON.parse(await readRaw(req, 50_000) || '{}');
    const month = String(body.month || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new AppError(400, '請指定要匯入的月份');
    const incoming = Array.isArray(body.rows) ? body.rows : null;
    let rows;
    if (incoming) {
      rows = incoming.map((r) => ({employeeId: r.employeeId, month: r.month || month, netPay: r.netPay, name: r.name || '', status: r.status}));
    } else {
      const cfg = await hr.getSalaryImport();
      const parsed = parseSheetRows(await loadSheetValues({spreadsheetId: cfg.spreadsheetId, sheetTab: cfg.sheetTab}), body.columns || cfg.columns);
      const state = await hr.state();
      rows = compareSalaryRows(parsed.rows, {employees: state.employees, salaries: state.salaries, month}).rows;
    }
    const state = await hr.state();
    const empIds = new Set(state.employees.map((e) => e.id));
    const existing = state.salaries.filter((s) => s.month === month);
    let saved = 0, skipped = 0;
    const written = [];
    for (const r of rows) {
      const status = r.status || (empIds.has(r.employeeId) ? (existing.find((s) => s.employeeId === r.employeeId) ? 'changed' : 'new') : 'unmatched');
      if (status === 'unmatched' || status === 'same' || status === 'ambiguous') { skipped += 1; continue; }
      if (!empIds.has(r.employeeId)) { skipped += 1; continue; }
      const cur = existing.find((s) => s.employeeId === r.employeeId);
      const notes = cur?.notes || '由薪資計算明細匯入';
      const remittance = cur?.remittance || '未匯';
      if (cur) {
        written.push(await hr.upsertSalary({id: cur.id, employeeId: r.employeeId, month, netPay: r.netPay, notes, remittance}, actor));
      } else {
        written.push(await hr.upsertSalary({employeeId: r.employeeId, month, netPay: r.netPay, notes, remittance}, actor));
      }
      saved += 1;
    }
    send(res, 200, {ok: true, month, saved, skipped, rows: written});
    return true;
  }

  if (method === 'POST' && pathname === '/api/hr/salaries') {
    const body = JSON.parse(await readRaw(req, 50_000));
    send(res, 200, await hr.upsertSalary(body, actor));
    return true;
  }
  if (method === 'PATCH' && (m = pathname.match(/^\/api\/hr\/salaries\/([^/]+)$/))) {
    const body = JSON.parse(await readRaw(req, 50_000));
    send(res, 200, await hr.upsertSalary({...body, id: decodeURIComponent(m[1])}, actor));
    return true;
  }
  if (method === 'DELETE' && (m = pathname.match(/^\/api\/hr\/salaries\/([^/]+)$/))) {
    send(res, 200, await hr.deleteSalary(decodeURIComponent(m[1]), actor));
    return true;
  }

  if (method === 'POST' && pathname === '/api/hr/documents/scan') {
    const state = await hr.state();
    send(res, 200, await scanFolders(hr, state.employees));
    return true;
  }
  if (method === 'POST' && pathname === '/api/hr/documents/upload') {
    const boundary = boundaryOf(req);
    if (!boundary) throw new AppError(400, '請用表單上傳檔案');
    const parts = parseMultipart(await readRaw(req), boundary);
    const file = parts.find((p) => p.name === 'file' || p.filename);
    if (!file?.body?.length) throw new AppError(400, '請選擇檔案');
    const field = (n) => parts.find((p) => p.name === n)?.body.toString('utf8').trim() || '';
    const employeeId = field('employeeId');
    const candidateId = field('candidateId');
    const category = field('category');
    const expiresOn = field('expiresOn');
    if (!DOC_TYPES[category]) throw new AppError(400, '文件種類不正確');
    if (category === 'resume' && !candidateId && !employeeId) throw new AppError(400, '請先選擇應徵者或員工再上傳履歷');
    if (category !== 'resume' && !employeeId) throw new AppError(400, '請先選擇員工再上傳文件');
    let ownerName = '';
    let empId = employeeId || '';
    if (empId) {
      const emp = await hr.getEmployee(empId);
      ownerName = emp.name;
    }
    if (candidateId) {
      const st = await hr.state();
      const cand = st.candidates.find((c) => c.id === candidateId);
      if (!cand) throw new AppError(404, '找不到應徵者');
      ownerName = ownerName || cand.name;
    }
    const {Readable} = await import('node:stream');
    const saved = await saveUpload({
      category, employeeId: empId || candidateId, employeeName: ownerName,
      mime: file.mime || mimeFromName(file.filename),
      stream: Readable.from(file.body),
      size: file.body.length,
    });
    const row = {
      id: fileId(), category, relativePath: saved.filename, filename: saved.filename,
      size: saved.size, mtime: saved.mtime, available: true, employeeId: empId || null, candidateId: candidateId || null, suggestions: [],
      expiresOn: expiresOn || null,
    };
    await hr.insertDocument(row, actor);
    const ocr = await runAfterUpload({hr, row, dest: saved.dest, category, config, extract, actor});
    send(res, 200, {...row, displayPath: saved.displayPath, path: saved.displayPath, ocr});
    return true;
  }
  if (method === 'POST' && pathname === '/api/hr/ocr/batch-bank') {
    req.setTimeout(0);
    res.setTimeout(0);
    send(res, 200, await batchScanBank({hr, config, extract, actor}));
    return true;
  }
  if (method === 'GET' && (m = pathname.match(/^\/api\/hr\/ocr-reviews\/([^/]+)$/))) {
    send(res, 200, await hr.getOcrReview(decodeURIComponent(m[1]), {reveal: true}));
    return true;
  }
  if (method === 'POST' && (m = pathname.match(/^\/api\/hr\/ocr-reviews\/([^/]+)\/confirm$/))) {
    const body = JSON.parse(await readRaw(req, 50_000) || '{}');
    send(res, 200, await hr.confirmOcrReview(decodeURIComponent(m[1]), body, actor));
    return true;
  }
  if (method === 'POST' && (m = pathname.match(/^\/api\/hr\/ocr-reviews\/([^/]+)\/dismiss$/))) {
    send(res, 200, await hr.dismissOcrReview(decodeURIComponent(m[1]), actor));
    return true;
  }
  if (method === 'PATCH' && (m = pathname.match(/^\/api\/hr\/documents\/([^/]+)$/))) {
    const body = JSON.parse(await readRaw(req, 50_000));
    if (body.employeeId) await hr.bindDocument(decodeURIComponent(m[1]), body.employeeId, actor);
    if (body.expiresOn !== undefined) await hr.setDocumentExpiry(decodeURIComponent(m[1]), body.expiresOn, actor);
    send(res, 200, {ok: true});
    return true;
  }
  if (method === 'GET' && (m = pathname.match(/^\/api\/hr\/documents\/([^/]+)\/file$/))) {
    const doc = await hr.getDocument(decodeURIComponent(m[1]));
    const root = folderConfig()[doc.category];
    if (!root) throw new AppError(404, '資料夾未設定');
    const abs = path.join(root, doc.relative_path);
    if (!abs.startsWith(path.resolve(root))) throw new AppError(400, '路徑不正確');
    try {
      const st = await stat(abs);
      const type = extMime(path.extname(abs));
      res.writeHead(200, {
        'content-type': type,
        'content-length': st.size,
        'content-disposition': 'inline; filename="' + encodeURIComponent(doc.filename) + '"',
        'cache-control': 'private, max-age=3600',
      });
      createReadStream(abs).pipe(res);
    } catch {
      throw new AppError(404, '檔案不在資料夾裡');
    }
    return true;
  }

  if (method === 'POST' && pathname === '/api/hr/recruitment/excel/preview') {
    const {filename, raw, start, end} = await readExcelUpload(req, url);
    const data = await runExcel(['recruitment-preview', start, end, filename], raw);
    send(res, 200, data);
    return true;
  }
  if (method === 'POST' && pathname === '/api/hr/recruitment/excel/import') {
    const body = JSON.parse(await readRaw(req, 8_000_000));
    send(res, 200, await importRecruitment(hr, body, actor));
    return true;
  }
  if (method === 'POST' && pathname === '/api/hr/leave/excel/preview') {
    const {filename, raw} = await readExcelUpload(req, url);
    const data = await runExcel(['leave-preview', filename], raw);
    send(res, 200, data);
    return true;
  }
  if (method === 'POST' && pathname === '/api/hr/leave/excel/import') {
    const body = JSON.parse(await readRaw(req, 8_000_000));
    send(res, 200, await importLeave(hr, body, actor));
    return true;
  }
  if (method === 'POST' && (m = pathname.match(/^\/api\/hr\/leave\/excel\/([^/]+)\/bind$/))) {
    const body = JSON.parse(await readRaw(req, 50_000));
    await hr.bindLeave(decodeURIComponent(m[1]), body.employeeId, actor);
    send(res, 200, {ok: true});
    return true;
  }
  if (method === 'POST' && (m = pathname.match(/^\/api\/hr\/leave\/excel\/([^/]+)\/apply-arrival$/))) {
    send(res, 200, await hr.applyLeaveArrival(decodeURIComponent(m[1]), actor));
    return true;
  }

  if (method === 'POST' && pathname === '/api/hr/leave-years/ensure') {
    const body = JSON.parse((await readRaw(req, 50_000)).toString('utf8') || '{}');
    if (body.employeeId) send(res, 200, {years: await hr.ensureEmployeeYears(body.employeeId)});
    else { await hr.ensureAllYears(); send(res, 200, {ok: true}); }
    return true;
  }
  if (method === 'PATCH' && (m = pathname.match(/^\/api\/hr\/leave-years\/([^/]+)$/))) {
    const body = JSON.parse(await readRaw(req, 50_000));
    const id = decodeURIComponent(m[1]);
    if (body.entitled != null && body.status == null) send(res, 200, await hr.overrideEntitled(id, body.entitled, actor));
    else if (body.status) send(res, 200, await hr.settleYear(id, body, actor));
    else throw new AppError(400, '請提供應有天數或結算狀態');
    return true;
  }
  if (method === 'POST' && (m = pathname.match(/^\/api\/hr\/leave-years\/([^/]+)\/settle$/))) {
    const body = JSON.parse(await readRaw(req, 50_000));
    send(res, 200, await hr.settleYear(decodeURIComponent(m[1]), body, actor));
    return true;
  }
  if (method === 'POST' && pathname === '/api/hr/leave-entries') {
    const body = JSON.parse(await readRaw(req, 50_000));
    send(res, 200, await hr.addLeaveEntry(body, actor));
    return true;
  }
  if (method === 'DELETE' && (m = pathname.match(/^\/api\/hr\/leave-entries\/([^/]+)$/))) {
    await hr.deleteLeaveEntry(decodeURIComponent(m[1]), actor);
    send(res, 200, {ok: true});
    return true;
  }

  return false;
}

function mimeFromName(name) {
  const ext = path.extname(name || '').toLowerCase();
  return {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf'}[ext] || '';
}
function extMime(ext) {
  return {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf'}[ext.toLowerCase()] || 'application/octet-stream';
}

async function readExcelUpload(req, url) {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('multipart/form-data')) {
    const parts = parseMultipart(await readRaw(req, 12 * 1024 * 1024), boundaryOf(req));
    const file = parts.find((p) => p.filename);
    if (!file) throw new AppError(400, '請選擇 Excel 檔');
    const field = (n) => parts.find((p) => p.name === n)?.body.toString('utf8').trim() || '';
    return {filename: file.filename, raw: file.body, start: field('start') || url.searchParams.get('start') || '', end: field('end') || url.searchParams.get('end') || ''};
  }
  const raw = await readRaw(req, 12 * 1024 * 1024);
  return {
    filename: decodeURIComponent(url.searchParams.get('filename') || 'upload.xlsx'),
    raw, start: url.searchParams.get('start') || '', end: url.searchParams.get('end') || '',
  };
}

async function importRecruitment(hr, body, actor) {
  const rows = body.rows || [];
  let created = 0, skipped = 0, linked = 0;
  for (const row of rows) {
    const rid = row.id || row.digest || newId('X-');
    if (await hr.importRowExists(rid)) { skipped += 1; continue; }
    let candidateId = row.candidateId;
    if (!candidateId) {
      const state = await hr.state();
      const hit = state.candidates.find((c) => c.phone && c.phone === row.phone && c.name === row.name);
      if (hit) candidateId = hit.id;
    }
    if (!candidateId) {
      const createdCand = await hr.upsertCandidate(newId('R-'), {
        name: row.name, phone: row.phone, department: row.department, job: row.job,
        source: row.source || 'Excel', contactPerson: row.contactPerson,
        availableDate: row.availableDate, interviewAt: row.interviewAt,
        followupDate: row.followupDate, status: row.status || '待聯絡', notes: row.notes || '',
      }, actor, {create: true});
      candidateId = createdCand.id;
      created += 1;
    } else linked += 1;
    await hr.insertImportRow(rid, candidateId, row);
  }
  await hr.setSetting('lastImport', {at: new Date().toISOString(), kind: 'recruitment', created, skipped, linked, total: rows.length});
  return {created, skipped, linked, total: rows.length};
}

async function importLeave(hr, body, actor) {
  const rows = body.rows || [];
  const state = await hr.state();
  let created = 0, bound = 0;
  for (const row of rows) {
    const id = row.id || newId('L-');
    let employeeId = row.employeeId || null;
    if (!employeeId && row.name) {
      const hits = state.employees.filter((e) => e.name === row.name);
      if (hits.length === 1) employeeId = hits[0].id;
    }
    await hr.insertLeaveRow(id, employeeId, row);
    created += 1;
    if (employeeId) bound += 1;
  }
  await hr.setSetting('lastImport', {at: new Date().toISOString(), kind: 'leave', created, bound, total: rows.length});
  return {created, bound, total: rows.length};
}
