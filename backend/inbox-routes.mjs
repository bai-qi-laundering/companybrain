// 收件匣 API（只限登入的管理者）。/api/finance/inbox 舊網址也走這裡。
import {randomUUID} from 'node:crypto';
import {readFile, unlink} from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {AppError} from './domain.mjs';
import {sendJson} from './http-send.mjs';
import {parseMultipart} from './directory-routes.mjs';
import {
  FinanceStore, publicDoc, sha256, isAllowedFinanceUpload, financeMime, financeRoot, FINANCE_UPLOAD_LIMIT, FINANCE_MAX_FILES,
  saveToInbox, fileDocument, normalizeDate, normalizeMonth, AUTO_CONFIDENCE, DOC_TYPES, EXPENSE_CATEGORIES, INCOME_CATEGORIES, INBOX_FOLDER,
} from './finance.mjs';
import {editedFields, processDocument} from './finance-routes.mjs';
import {safeJoinRoot, orgDirectoryKind, resolveEntityFolder} from './directory-docs.mjs';
import {saveUpload, fileId} from './hr-docs.mjs';
import {runAfterUpload} from './hr-ocr.mjs';
import {hasPiiKey} from './hr-crypto.mjs';
import {compareSalaryRows, applySalaryImport} from './hr-salary-import.mjs';
import {createResignationSheet} from './inbox-resign.mjs';
import {
  InboxStore, INBOX_TYPES, HR_TYPE_CATEGORY, PII_TYPES, SALARY_COMPANIES, DEFAULT_SALARY_COMPANY, PURGE_DAYS, CARD_TYPE,
  routeOf, classifyInbox, withTemp, cardFields, personFields, employeeList, fileCard, cleanContact, writeUnique, salaryDest,
  readSheetValues, detectSalary, hrMime, lastMonth,
} from './inbox.mjs';

const send = (req, res, status, body) => sendJson(res, status, body, req);
const MAX_FILES = Math.max(FINANCE_MAX_FILES, Number(process.env.INBOX_MAX_FILES || 20));

async function readRaw(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new AppError(413, '單次上傳總量太大，請分批上傳');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
async function readJson(req) {
  const raw = (await readRaw(req, 200_000)).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new AppError(400, '請提供有效的 JSON'); }
}
const pendingStatus = (s) => s === 'needs_review' || s === 'error';
const isStaging = (rel) => String(rel || '').startsWith(INBOX_FOLDER + '/待確認/');

/** 取得原始檔案內容：個資暫存檔（解密）或 NAS 上的檔案。 */
async function docBuffer(inbox, doc) {
  const blob = await inbox.getBlob(doc.id);
  if (blob) return blob;
  if (!doc.stored_path) throw new AppError(410, '暫存檔已刪除，請重新上傳');
  const abs = safeJoinRoot(financeRoot(), doc.stored_path);
  try { return await readFile(abs); } catch { throw new AppError(404, '檔案已不在 NAS 上（可能被移動或刪除）'); }
}

/** 非個資的歸檔需要檔案在 NAS 收件匣裡；個資暫存的要先解密寫到收件匣。 */
async function ensureOnNas({fin, inbox, doc}) {
  if (doc.stored_path) return doc;
  const buf = await docBuffer(inbox, doc);
  const saved = await saveToInbox({buf, originalName: doc.original_name});
  await fin.update(doc.id, {stored_path: saved.storedPath});
  await inbox.dropBlob(doc.id);
  await inbox.setDoc(doc.id, {pii: false});
  return fin.get(doc.id);
}

/** 個資文件歸檔後：清掉暫存（加密檔或 NAS 收件匣暫存）。 */
async function clearStaging({inbox, doc}) {
  await inbox.dropBlob(doc.id);
  if (doc.stored_path && isStaging(doc.stored_path)) {
    const abs = safeJoinRoot(financeRoot(), doc.stored_path);
    if (abs) await unlink(abs).catch(() => {});
  }
}

function personQuestions(f, raw) {
  const q = ['個人文件一律要你確認後才歸檔'];
  if (f.docType === '離職單' && !f.departureDate) q.push('看不出離職日，請填寫');
  if (f.employeeMatch === 'ambiguous') q.push('同名員工不只一位，請選擇');
  else if (!f.employeeId && f.docType !== '薪資檔') q.push('對不到員工，請選擇是誰的文件');
  for (const u of (raw?.uncertainties || []).slice(0, 4)) q.push(String(u).slice(0, 160));
  return q;
}

async function listMeta({store, fin, inbox, hr, classify, config}) {
  const state = await store.read();
  const employees = await employeeList(hr);
  return {
    types: INBOX_TYPES, piiTypes: [...PII_TYPES], salaryCompanies: SALARY_COMPANIES, defaultSalaryCompany: DEFAULT_SALARY_COMPANY, purgeDays: PURGE_DAYS,
    docTypes: DOC_TYPES, expenseCategories: EXPENSE_CATEGORIES, incomeCategories: INCOME_CATEGORIES, autoConfidence: AUTO_CONFIDENCE,
    organizations: (state.organizations || []).filter((o) => o.kind !== '內部').map((o) => ({id: o.id, name: o.name, kind: o.kind, folder: orgDirectoryKind(o)})),
    kinds: [...new Set(['飯店', '餐廳', '設備商', '原料商', '維修工程', '其他', ...(state.organizations || []).map((o) => o.kind)].filter((k) => k && k !== '內部'))],
    employees: employees.map((e) => ({id: e.id, name: e.name, left: Boolean(e.departureDate)})),
    companies: await fin.companies(),
    counts: await fin.counts(), pending: await inbox.pendingCount(),
    piiKeyConfigured: hasPiiKey(), hrReady: Boolean(hr),
    aiReady: Boolean(classify || (config.key && config.key !== 'PASTE_YOUR_KEY_HERE')),
  };
}

/** 一份檔案：去重 → 辨識 → 個資加密暫存／財務照舊處理／名片完全相符才自動歸檔。 */
async function intake({part, store, fin, inbox, hr, config, classify, actor, organizations, companies, employees}) {
  const hash = sha256(part.body);
  const existing = await fin.bySha(hash);
  if (existing) return {...publicDoc(existing), duplicate: true};
  const rules = await fin.rules();
  let result, error = null;
  try {
    result = await withTemp(part.body, part.filename, (tmp) => classifyInbox({absPath: tmp, filename: part.filename, organizations, rules, companies, config, classify}));
  } catch (e) { error = e; }
  const docType = result?.raw?.docType || null;
  const route = docType ? routeOf(docType) : null;
  const personal = docType ? PII_TYPES.has(docType) : hasPiiKey(); // 辨識失敗時不知道是什麼：有金鑰就先加密暫存
  const id = randomUUID();
  const base = {id, sha256: hash, originalName: part.filename, mime: financeMime(part.filename), size: part.body.length, createdBy: actor};

  if (personal) {
    if (!hasPiiKey()) throw new AppError(503, `「${part.filename}」看起來是${docType}，但 NAS 尚未設定 HR_PII_KEY，無法安全暫存；請先設定後再上傳`);
    await fin.insert({...base, status: 'processing', storedPath: ''});
    await inbox.setDoc(id, {route: route || 'unknown', pii: true});
    await inbox.putBlob(id, part.body);
    if (error || !result) {
      await fin.update(id, {status: 'error', error: error?.status ? error.message : '辨識失敗', questions: ['AI 沒辦法辨識這份文件，請選擇文件種類或稍後重新辨識']});
    } else {
      const raw = result.raw;
      let fields = personFields(raw, employees);
      if (route === 'salary') fields = {...fields, months: result.salary?.months || [], salaryRows: result.salary?.rows?.length || 0, month: result.salary?.months?.at(-1) || lastMonth(), company: DEFAULT_SALARY_COMPANY};
      await fin.update(id, {status: 'needs_review', ai: {docType: raw.docType, confidence: raw.confidence ?? null}, fields, questions: personQuestions(fields, raw), confidence: raw.confidence ?? null, error: null});
    }
    await inbox.audit(id, 'upload', actor, `${docType || '未辨識'}（加密暫存）`);
    return publicDoc(await fin.get(id));
  }

  const saved = await saveToInbox({buf: part.body, originalName: part.filename});
  await fin.insert({...base, status: 'processing', storedPath: saved.storedPath, size: saved.size});
  await inbox.setDoc(id, {route: route || 'finance', pii: false});
  if (error || !result) {
    await fin.update(id, {status: 'error', error: error?.status ? error.message : '辨識失敗，請稍後按「重新辨識」或手動填寫', questions: ['AI 沒辦法辨識這份文件，請手動填寫或稍後重新辨識']});
    await inbox.audit(id, 'upload', actor, '辨識失敗');
    return publicDoc(await fin.get(id));
  }
  if (route === 'card') {
    const f = cardFields(result.raw, organizations, rules);
    const conf = Number(result.raw.confidence || 0);
    const auto = f.exact && conf >= AUTO_CONFIDENCE && (f.contact.name || f.contact.phones.length) && !(result.raw.uncertainties || []).length;
    if (auto) {
      try {
        const org = organizations.find((o) => o.id === f.orgId);
        const r = await fileCard({store, org, contact: f.contact, srcRel: saved.storedPath, originalName: part.filename, actor});
        await fin.update(id, {status: 'filed', ai: {docType: CARD_TYPE, confidence: conf}, fields: f, questions: [], confidence: conf, stored_path: r.storedPath, filed_at: new Date().toISOString(), error: null});
        await inbox.setDoc(id, {target: {type: 'card', orgId: org.id, orgName: org.name, contactAdded: r.contactAdded, storedPath: r.storedPath}});
        await inbox.audit(id, 'auto-file', actor, `名片 → ${org.name}`);
        return publicDoc(await fin.get(id));
      } catch (e) {
        (result.raw.uncertainties ||= []).push('自動歸檔失敗：' + (e?.status ? e.message : '無法搬移檔案'));
      }
    }
    const q = [];
    if (!f.orgId) q.push(f.counterpartyName ? `名錄裡找不到「${f.counterpartyName}」，要新增對象還是歸到既有對象？` : '看不出公司名稱，請選擇對象');
    else if (!f.exact) q.push(`公司名稱和「${f.orgName}」不完全一樣，請確認`);
    for (const u of (result.raw.uncertainties || []).slice(0, 4)) q.push(String(u).slice(0, 160));
    if (!q.length) q.push('AI 把握度不夠高，請確認內容');
    await fin.update(id, {status: 'needs_review', ai: result.raw, fields: f, questions: q, confidence: conf, error: null});
    await inbox.audit(id, 'upload', actor, '名片（待確認）');
    return publicDoc(await fin.get(id));
  }
  const row = await processDocument({store, fin, id, absPath: saved.abs, organizations, config, classify, actor, companies, raw: result.raw});
  await inbox.audit(id, row.status === 'filed' ? 'auto-file' : 'upload', actor, row.fields?.docType || '財務文件');
  return publicDoc(row);
}

export async function handleInbox(req, res, {store, hr, session, method, path: p, config, classify, extract, sheet}) {
  const fin = store.finance || (store.finance = new FinanceStore(store.pool));
  if (!store.financeReady) { await fin.ensure(); store.financeReady = true; }
  const inbox = store.inbox || (store.inbox = new InboxStore(store.pool));
  const actor = session.username;
  const url = new URL(req.url, 'http://localhost');
  const resign = sheet || (hr ? createResignationSheet({hr}) : null);

  if (p === '/api/inbox/meta' && method === 'GET') {
    return send(req, res, 200, await listMeta({store, fin, inbox, hr, classify, config})), true;
  }
  if (p === '/api/inbox' && method === 'GET') {
    const which = url.searchParams.get('status') || 'pending';
    const rows = which === 'recent' ? await inbox.recent() : await inbox.pending();
    return send(req, res, 200, {documents: rows.map(publicDoc), counts: await fin.counts(), pending: await inbox.pendingCount()}), true;
  }
  if (p === '/api/inbox/audit' && method === 'GET') {
    return send(req, res, 200, {entries: await inbox.auditLog(url.searchParams.get('limit'))}), true;
  }
  if ((p === '/api/inbox/upload' || p === '/api/finance/inbox') && method === 'POST') {
    const boundary = /multipart\/form-data;\s*boundary=([^;]+)/i.exec(req.headers['content-type'] || '')?.[1]?.trim().replace(/^"|"$/g, '');
    if (!boundary) throw new AppError(400, '請用檔案上傳');
    const parts = parseMultipart(await readRaw(req, 120 * 1024 * 1024), boundary).filter((x) => x.filename && x.body?.length);
    if (!parts.length) throw new AppError(400, '請選擇檔案');
    if (parts.length > MAX_FILES) throw new AppError(400, `一次最多 ${MAX_FILES} 個檔案`);
    for (const part of parts) {
      if (!isAllowedFinanceUpload(part.filename)) throw new AppError(400, `「${part.filename}」格式不支援，請上傳照片、PDF、Excel 或 CSV`);
      if (part.body.length > FINANCE_UPLOAD_LIMIT) throw new AppError(400, `「${part.filename}」超過 20MB`);
    }
    financeRoot();
    const state = await store.read();
    const organizations = state.organizations || [];
    const companies = await fin.companies();
    const employees = await employeeList(hr);
    const results = [];
    for (const part of parts) {
      try {
        results.push(await intake({part, store, fin, inbox, hr, config, classify, actor, organizations, companies, employees}));
      } catch (e) {
        if (!e?.status || parts.length === 1) throw e;
        results.push({originalName: part.filename, status: 'rejected', error: e.message});
      }
    }
    return send(req, res, 200, {documents: results, counts: await fin.counts(), pending: await inbox.pendingCount()}), true;
  }

  const m = p.match(/^\/api\/inbox\/([0-9a-f-]{36})(?:\/(file|confirm|ignore|retry|resignation-preview|salary-preview))?$/);
  if (!m) return false;
  const doc = await fin.get(m[1]);
  const action = m[2] || '';

  if (action === 'file' && method === 'GET') {
    const buf = await docBuffer(inbox, doc);
    if (doc.pii && url.searchParams.get('thumb') !== '1') await inbox.audit(doc.id, 'view', actor, '開啟原檔');
    const ascii = doc.original_name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
    res.writeHead(200, {'Content-Type': doc.mime, 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'Content-Disposition': `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.original_name)}`});
    res.end(buf);
    return true;
  }
  if (!action && method === 'GET') return send(req, res, 200, publicDoc(doc)), true;

  if (action === 'resignation-preview' && method === 'GET') {
    if (!hr) throw new AppError(503, '人資模組尚未啟用');
    const employeeId = url.searchParams.get('employeeId') || doc.fields?.employeeId;
    if (!employeeId) throw new AppError(400, '請先選擇員工');
    const emp = await hr.getEmployee(employeeId);
    const st = resign ? await resign.read(employeeId) : {ok: false, error: '未設定試算表'};
    return send(req, res, 200, {employee: {id: emp.id, name: emp.name, departureDate: emp.departureDate || ''},
      sheet: {ok: Boolean(st.ok), writeEnabled: st.writeEnabled !== false, current: st.current || '', raw: st.raw || '', cell: st.cell || '', header: st.header || '', error: st.error || ''}}), true;
  }
  if (action === 'salary-preview' && method === 'GET') {
    if (!hr) throw new AppError(503, '人資模組尚未啟用');
    const buf = await docBuffer(inbox, doc);
    const sal = await withTemp(buf, doc.original_name, async (tmp) => detectSalary(await readSheetValues(tmp)));
    const month = normalizeMonth(url.searchParams.get('month') || '') || doc.fields?.month || sal.months?.at(-1) || lastMonth();
    let summary = {new: 0, changed: 0, same: 0, unmatched: 0, ambiguous: 0, total: 0};
    let unmatched = [];
    if (sal.rows?.length) {
      const state = await hr.state();
      const cmp = compareSalaryRows(sal.rows, {employees: state.employees, salaries: state.salaries, month});
      for (const r of cmp.rows) { summary[r.status] = (summary[r.status] || 0) + 1; summary.total += 1; }
      unmatched = cmp.rows.filter((r) => r.status === 'unmatched' || r.status === 'ambiguous').map((r) => r.employeeId).slice(0, 30);
    }
    return send(req, res, 200, {months: sal.months || [], month, summary, unmatched, importable: Boolean(sal.rows?.length), warnings: sal.warnings || [], companies: SALARY_COMPANIES, defaultCompany: DEFAULT_SALARY_COMPANY}), true;
  }

  if (action === 'ignore' && method === 'POST') {
    if (doc.status === 'filed') throw new AppError(409, '已歸檔的文件請到「財務 › 已歸檔」重新確認');
    await fin.update(doc.id, {status: 'ignored'});
    if (doc.pii || (doc.route && doc.route !== 'finance')) await clearStaging({inbox, doc});
    else await fin.replaceEntry(doc, {countInPnl: false}, actor);
    await inbox.audit(doc.id, 'ignore', actor, doc.fields?.docType || '');
    return send(req, res, 200, {document: publicDoc(await fin.get(doc.id)), pending: await inbox.pendingCount()}), true;
  }

  if (action === 'retry' && method === 'POST') {
    if (!pendingStatus(doc.status)) throw new AppError(409, '只有待確認或辨識失敗的文件可以重新辨識');
    const buf = await docBuffer(inbox, doc);
    const state = await store.read();
    const organizations = state.organizations || [];
    const companies = await fin.companies();
    let result;
    try {
      result = await withTemp(buf, doc.original_name, (tmp) => classifyInbox({absPath: tmp, filename: doc.original_name, organizations, rules: [], companies, config, classify}));
    } catch (e) {
      await fin.update(doc.id, {status: 'error', error: e?.status ? e.message : '辨識失敗'});
      return send(req, res, 200, {document: publicDoc(await fin.get(doc.id))}), true;
    }
    const docType = result.raw.docType;
    const route = routeOf(docType);
    if (PII_TYPES.has(docType)) {
      if (!doc.pii) {
        // 原本放在 NAS 收件匣暫存的，改成加密暫存並刪掉 NAS 上的暫存檔
        await inbox.putBlob(doc.id, buf);
        if (doc.stored_path && isStaging(doc.stored_path)) { const abs = safeJoinRoot(financeRoot(), doc.stored_path); if (abs) await unlink(abs).catch(() => {}); await fin.update(doc.id, {stored_path: ''}); }
      }
      let fields = personFields(result.raw, await employeeList(hr));
      if (route === 'salary') fields = {...fields, months: result.salary?.months || [], salaryRows: result.salary?.rows?.length || 0, month: result.salary?.months?.at(-1) || lastMonth(), company: DEFAULT_SALARY_COMPANY};
      await fin.update(doc.id, {status: 'needs_review', fields, questions: personQuestions(fields, result.raw), confidence: result.raw.confidence ?? null, error: null});
      await inbox.setDoc(doc.id, {route, pii: true});
    } else if (route === 'card') {
      const f = cardFields(result.raw, organizations, await fin.rules());
      await fin.update(doc.id, {status: 'needs_review', fields: f, questions: ['請確認名片要歸到哪個對象'], confidence: result.raw.confidence ?? null, error: null});
      await inbox.setDoc(doc.id, {route});
    } else {
      const d = await ensureOnNas({fin, inbox, doc});
      await inbox.setDoc(doc.id, {route: 'finance'});
      await processDocument({store, fin, id: d.id, absPath: safeJoinRoot(financeRoot(), d.stored_path), organizations, config, classify, actor, allowAuto: false, companies, raw: result.raw});
    }
    await inbox.audit(doc.id, 'retry', actor, docType);
    return send(req, res, 200, {document: publicDoc(await fin.get(doc.id))}), true;
  }

  if (action === 'confirm' && method === 'POST') {
    if (!pendingStatus(doc.status)) throw new AppError(409, '這份文件已處理過');
    const body = await readJson(req);
    const docType = INBOX_TYPES.includes(body.docType) ? body.docType : (doc.fields?.docType || '');
    if (!docType) throw new AppError(400, '請選擇文件種類');
    const route = routeOf(docType);
    let out;
    if (route === 'finance') out = await confirmFinance({store, fin, inbox, doc, body: {...body, docType}, actor});
    else if (route === 'card') out = await confirmCard({store, fin, inbox, doc, body, actor});
    else {
      if (!hr) throw new AppError(503, '人資模組尚未啟用');
      if (route === 'hr') out = await confirmHr({fin, inbox, doc, body, docType, hr, config, extract, actor});
      else if (route === 'resignation') out = await confirmResignation({store, fin, inbox, doc, body, hr, resign, actor});
      else if (route === 'salary') out = await confirmSalary({fin, inbox, doc, body, hr, actor});
    }
    await inbox.audit(doc.id, 'confirm', actor, `${docType}${out?.auditNote ? '：' + out.auditNote : ''}`);
    return send(req, res, 200, {document: publicDoc(await fin.get(doc.id)), result: out?.result || null, pending: await inbox.pendingCount(), counts: await fin.counts()}), true;
  }
  return false;
}

async function confirmFinance({store, fin, inbox, doc, body, actor}) {
  const d = await ensureOnNas({fin, inbox, doc});
  const state = await store.read();
  const fields = editedFields(body, d.fields?.docType && DOC_TYPES.includes(d.fields.docType) ? d.fields : {}, state.organizations || [], await fin.companies());
  const storedPath = await fileDocument({store, doc: d, fields, organizations: state.organizations || []});
  await fin.update(d.id, {status: 'filed', fields, stored_path: storedPath, questions: [], filed_at: new Date().toISOString(), error: null});
  await inbox.setDoc(d.id, {route: 'finance', pii: false, target: {type: 'finance', storedPath}});
  await fin.replaceEntry(d, fields, actor);
  await fin.learn(fields);
  return {result: {storedPath}, auditNote: fields.orgName || ''};
}

async function confirmCard({store, fin, inbox, doc, body, actor}) {
  const contact = cleanContact(body.contact || doc.fields?.contact || {});
  let state = await store.read();
  let org = body.orgId ? (state.organizations || []).find((o) => o.id === body.orgId) : null;
  if (body.orgId && !org) throw new AppError(400, '找不到這個對象');
  if (!org) {
    const name = String(body.newOrg?.name || '').trim().slice(0, 100);
    const kind = String(body.newOrg?.kind || '').trim().slice(0, 50);
    if (!name || !kind) throw new AppError(400, '請選擇既有對象，或填寫新對象的名稱與種類');
    if ((state.organizations || []).some((o) => o.name === name)) throw new AppError(409, `名錄已有「${name}」，請直接選擇`);
    org = {id: randomUUID(), name, kind, mark: name.slice(0, 1), en: '', contact: '尚未提供', role: '', manager: '尚未提供', contract: '尚未提供', memo: '由名片建立', prices: [], aliases: []};
    state = await store.save(state.revision, {...state, organizations: [...state.organizations, org]}, actor);
  }
  const d = doc.stored_path ? doc : await ensureOnNas({fin, inbox, doc});
  const r = await fileCard({store, org, contact, srcRel: d.stored_path, originalName: doc.original_name, actor});
  const fields = {...(doc.fields || {}), docType: CARD_TYPE, contact, orgId: org.id, orgName: org.name, orgKind: org.kind};
  await fin.update(doc.id, {status: 'filed', fields, stored_path: r.storedPath, questions: [], filed_at: new Date().toISOString(), error: null});
  await inbox.setDoc(doc.id, {route: 'card', pii: false, target: {type: 'card', orgId: org.id, orgName: org.name, contactAdded: r.contactAdded, storedPath: r.storedPath, newOrg: !body.orgId}});
  return {result: {orgId: org.id, orgName: org.name, contactAdded: r.contactAdded, storedPath: r.storedPath}, auditNote: org.name};
}

async function confirmHr({fin, inbox, doc, body, docType, hr, config, extract, actor}) {
  const category = HR_TYPE_CATEGORY[docType];
  const employeeId = String(body.employeeId || '').trim();
  if (!employeeId) throw new AppError(400, '請選擇員工');
  const emp = await hr.getEmployee(employeeId);
  const mime = hrMime(doc.original_name);
  if (!mime) throw new AppError(400, '證件、存摺、履歷請上傳 JPG／PNG／WEBP 照片或 PDF');
  const expiresOn = body.expiresOn ? normalizeDate(body.expiresOn) : null;
  if (body.expiresOn && !expiresOn) throw new AppError(400, '到期日格式不正確');
  const buf = await docBuffer(inbox, doc);
  const saved = await saveUpload({category, employeeId: emp.id, employeeName: emp.name, mime, stream: Readable.from(buf), size: buf.length});
  const row = {id: fileId(), category, relativePath: saved.filename, filename: saved.filename, size: saved.size, mtime: saved.mtime, available: true, employeeId: emp.id, candidateId: null, suggestions: [], expiresOn};
  await hr.insertDocument(row, actor);
  let ocr = null;
  try { ocr = await runAfterUpload({hr, row, dest: saved.dest, category, config, extract, actor}); } catch { ocr = {skipped: 'ocr-failed'}; }
  await clearStaging({inbox, doc});
  const fields = {...(doc.fields || {}), docType, employeeId: emp.id};
  await fin.update(doc.id, {status: 'filed', fields, stored_path: '', questions: [], filed_at: new Date().toISOString(), error: null});
  const target = {type: 'hr', category, employeeId: emp.id, employeeName: emp.name, hrDocumentId: row.id, displayPath: saved.displayPath, ocrReviewId: ocr?.review?.id || null, ocr: ocr?.review ? 'pending' : (ocr?.skipped || null)};
  await inbox.setDoc(doc.id, {route: 'hr', pii: false, target});
  return {result: target, auditNote: `${category} → ${emp.id}`};
}

async function confirmResignation({store, fin, inbox, doc, body, hr, resign, actor}) {
  const employeeId = String(body.employeeId || '').trim();
  if (!employeeId) throw new AppError(400, '請選擇員工');
  const date = normalizeDate(body.departureDate);
  if (!date) throw new AppError(400, '請填寫離職日（實際最後在職日）');
  const emp = await hr.getEmployee(employeeId);
  const overwrite = Boolean(body.overwriteSheet);
  const pre = resign ? await resign.read(emp.id) : {ok: false, error: '未設定試算表'};
  const existing = pre.ok ? (pre.current || pre.raw || '') : '';
  if (existing && existing !== date && !overwrite) throw new AppError(409, `試算表「員工資料」${pre.cell} 已有 ${existing}，要覆蓋請勾選「覆蓋試算表的離職日」`);
  const buf = await docBuffer(inbox, doc);
  const entity = await resolveEntityFolder({store, kind: 'employees', entityId: emp.id, entityName: emp.name, create: true});
  const ext = path.extname(doc.original_name || '').toLowerCase() || '.pdf';
  const storedPath = await writeUnique(path.posix.join(entity.relativePath, '離職單'), `${date}_離職單${ext}`, buf);
  const sheetResult = resign ? await resign.write(emp.id, date, {overwrite}) : {written: false, reason: '未設定試算表'};
  const saved = await hr.setDepartureDate(emp.id, date, actor);
  await clearStaging({inbox, doc});
  const sheetInfo = {written: Boolean(sheetResult.written), reason: sheetResult.reason || '', previous: sheetResult.previous || '', cell: sheetResult.cell || ''};
  const fields = {...(doc.fields || {}), docType: '離職單', employeeId: emp.id, departureDate: date};
  await fin.update(doc.id, {status: 'filed', fields, stored_path: storedPath, questions: sheetInfo.written ? [] : ['離職日未寫入試算表：' + sheetInfo.reason], filed_at: new Date().toISOString(), error: null});
  const target = {type: 'resignation', employeeId: emp.id, employeeName: emp.name, departureDate: date, previousDeparture: saved.previous, storedPath, sheet: sheetInfo};
  await inbox.setDoc(doc.id, {route: 'resignation', pii: false, target});
  return {result: target, auditNote: `${emp.id} 離職日 ${date}；試算表${sheetInfo.written ? '已寫入' : '未寫入'}`};
}

async function confirmSalary({fin, inbox, doc, body, hr, actor}) {
  const buf = await docBuffer(inbox, doc);
  const sal = await withTemp(buf, doc.original_name, async (tmp) => { try { return detectSalary(await readSheetValues(tmp)); } catch { return {isSalary: false, rows: [], months: []}; } });
  const month = normalizeMonth(body.month || '') || doc.fields?.month || sal.months?.at(-1) || lastMonth();
  const company = SALARY_COMPANIES.includes(body.company) ? body.company : DEFAULT_SALARY_COMPANY;
  const importRows = body.importRows !== false && sal.rows?.length;
  let imported = {saved: 0, skipped: 0, protected: []};
  if (importRows) {
    const state = await hr.state();
    const cmp = compareSalaryRows(sal.rows, {employees: state.employees, salaries: state.salaries, month});
    imported = await applySalaryImport({hr, rows: cmp.rows, month, actor, protectPaid: true});
  }
  const dest = salaryDest(company, month, doc.original_name);
  const storedPath = await writeUnique(dest.dirRel, dest.filename, buf);
  await clearStaging({inbox, doc});
  const fields = {...(doc.fields || {}), docType: '薪資檔', month, company};
  await fin.update(doc.id, {status: 'filed', fields, stored_path: storedPath, questions: [], filed_at: new Date().toISOString(), error: null});
  const target = {type: 'salary', company, month, storedPath, saved: imported.saved, skipped: imported.skipped, protected: imported.protected.length, imported: Boolean(importRows)};
  await inbox.setDoc(doc.id, {route: 'salary', pii: false, target});
  return {result: target, auditNote: `${company} ${month}，寫入 ${imported.saved} 筆`};
}
