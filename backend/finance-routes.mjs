import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {AppError} from './domain.mjs';
import {sendJson} from './http-send.mjs';
import {parseMultipart} from './directory-routes.mjs';
import {safeJoinRoot} from './directory-docs.mjs';
import {
  FinanceStore, reviewFields, classifyWithGemini, saveToInbox, fileDocument, publicDoc, sha256,
  isAllowedFinanceUpload, financeMime, financeRoot, FINANCE_UPLOAD_LIMIT, FINANCE_MAX_FILES,
  buildPnl, pnlCsv, validateManualEntry, DOC_TYPES, EXPENSE_CATEGORIES, INCOME_CATEGORIES, AUTO_CONFIDENCE,
  normalizeDate, normalizeMonth, cleanInvoiceNumber, ALL_CATEGORIES,
} from './finance.mjs';
import {orgDirectoryKind} from './directory-docs.mjs';

const send = (req, res, status, body) => sendJson(res, status, body, req);

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

/** 老闆手動修改後的欄位，重新整理並驗證。 */
function editedFields(body, current, organizations) {
  const f = {...current};
  if (body.docType !== undefined) {
    if (!DOC_TYPES.includes(body.docType)) throw new AppError(400, '文件類型不正確');
    f.docType = body.docType;
  }
  if (body.orgId !== undefined) {
    if (body.orgId) {
      const org = organizations.find((o) => o.id === body.orgId && o.kind !== '內部');
      if (!org) throw new AppError(400, '找不到這個對象');
      f.orgId = org.id; f.orgName = org.name; f.orgKind = orgDirectoryKind(org);
    } else { f.orgId = null; f.orgName = null; f.orgKind = null; }
  }
  if (body.counterpartyName !== undefined) f.counterpartyName = String(body.counterpartyName || '').trim().slice(0, 120) || null;
  if (body.invoiceNumber !== undefined) f.invoiceNumber = cleanInvoiceNumber(body.invoiceNumber);
  if (body.date !== undefined) {
    f.date = body.date ? normalizeDate(body.date) : null;
    if (body.date && !f.date) throw new AppError(400, '日期格式不正確');
  }
  if (body.month !== undefined) {
    f.month = body.month ? normalizeMonth(body.month) : null;
    if (body.month && !f.month) throw new AppError(400, '月份格式不正確');
  }
  for (const k of ['net', 'tax', 'total']) {
    if (body[k] === undefined) continue;
    if (body[k] === null || body[k] === '') f[k] = null;
    else if (!Number.isFinite(Number(body[k]))) throw new AppError(400, '金額格式不正確');
    else f[k] = Math.round(Number(body[k]) * 100) / 100;
  }
  if (body.category !== undefined) {
    if (body.category && !ALL_CATEGORIES.includes(body.category)) throw new AppError(400, '科目不正確');
    f.category = body.category || null;
  }
  if (body.description !== undefined) f.description = String(body.description || '').slice(0, 300);
  if (body.countInPnl !== undefined) f.countInPnl = Boolean(body.countInPnl);
  if (f.docType === '銷項發票' && f.countInPnl) f.category = '收入';
  if (['報價單', '合約', '其他'].includes(f.docType)) { f.countInPnl = false; f.category = null; }
  if (f.countInPnl) {
    if (f.total === null || f.total === undefined) throw new AppError(400, '要計入損益請填總金額');
    if (!f.month) throw new AppError(400, '要計入損益請填月份');
    if (!f.category) throw new AppError(400, '要計入損益請選科目');
  }
  return f;
}

export async function handleFinance(req, res, {store, session, method, path: p, config, classify}) {
  const fin = store.finance || (store.finance = new FinanceStore(store.pool));
  if (!store.financeReady) { await fin.ensure(); store.financeReady = true; }
  const url = new URL(req.url, 'http://localhost');
  const actor = session.username;

  if (p === '/api/finance/meta' && method === 'GET') {
    const state = await store.read();
    return send(req, res, 200, {
      docTypes: DOC_TYPES, expenseCategories: EXPENSE_CATEGORIES, incomeCategories: INCOME_CATEGORIES, autoConfidence: AUTO_CONFIDENCE,
      organizations: (state.organizations || []).filter((o) => o.kind !== '內部').map((o) => ({id: o.id, name: o.name, kind: o.kind, folder: orgDirectoryKind(o)})),
      counts: await fin.counts(),
      aiReady: Boolean(classify || (config.key && config.key !== 'PASTE_YOUR_KEY_HERE')),
    }), true;
  }

  if (p === '/api/finance/inbox' && method === 'POST') {
    const boundary = /multipart\/form-data;\s*boundary=([^;]+)/i.exec(req.headers['content-type'] || '')?.[1]?.trim().replace(/^"|"$/g, '');
    if (!boundary) throw new AppError(400, '請用檔案上傳');
    const parts = parseMultipart(await readRaw(req, 60 * 1024 * 1024), boundary).filter((x) => x.filename && x.body?.length);
    if (!parts.length) throw new AppError(400, '請選擇檔案');
    if (parts.length > FINANCE_MAX_FILES) throw new AppError(400, `一次最多 ${FINANCE_MAX_FILES} 個檔案`);
    for (const part of parts) {
      if (!isAllowedFinanceUpload(part.filename)) throw new AppError(400, `「${part.filename}」格式不支援，請上傳照片、PDF、Excel 或 CSV`);
      if (part.body.length > FINANCE_UPLOAD_LIMIT) throw new AppError(400, `「${part.filename}」超過 20MB`);
    }
    financeRoot();
    const state = await store.read();
    const organizations = state.organizations || [];
    const results = [];
    for (const part of parts) {
      const hash = sha256(part.body);
      const existing = await fin.bySha(hash);
      if (existing) { results.push({...publicDoc(existing), duplicate: true}); continue; }
      const saved = await saveToInbox({buf: part.body, originalName: part.filename});
      const doc = {id: crypto.randomUUID(), sha256: hash, status: 'processing', originalName: part.filename, storedPath: saved.storedPath, mime: financeMime(part.filename), size: saved.size, createdBy: actor};
      await fin.insert(doc);
      results.push(publicDoc(await processDocument({store, fin, id: doc.id, absPath: saved.abs, organizations, config, classify, actor})));
    }
    return send(req, res, 200, {documents: results, counts: await fin.counts()}), true;
  }

  if (p === '/api/finance/documents' && method === 'GET') {
    const rows = await fin.list({status: url.searchParams.get('status') || 'all', month: url.searchParams.get('month') || '', limit: url.searchParams.get('limit')});
    return send(req, res, 200, {documents: rows.map(publicDoc), counts: await fin.counts()}), true;
  }

  const m = p.match(/^\/api\/finance\/documents\/([0-9a-f-]{36})(?:\/(file|confirm|ignore|reopen|retry))?$/);
  if (m) {
    const doc = await fin.get(m[1]);
    const action = m[2] || '';
    if (action === 'file' && method === 'GET') {
      const abs = safeJoinRoot(financeRoot(), doc.stored_path);
      let st;
      try { st = await stat(abs); } catch { throw new AppError(404, '檔案已不在 NAS 上（可能被移動或刪除）'); }
      const ascii = doc.original_name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
      res.writeHead(200, {'Content-Type': doc.mime, 'Content-Length': st.size, 'Content-Disposition': `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.original_name)}`});
      createReadStream(abs).pipe(res);
      return true;
    }
    if (!action && method === 'GET') return send(req, res, 200, publicDoc(doc)), true;
    if (action === 'confirm' && method === 'POST') {
      if (!['needs_review', 'error'].includes(doc.status)) throw new AppError(409, '這份文件已處理過；要修改請先按「重新確認」');
      const body = await readJson(req);
      const state = await store.read();
      const fields = editedFields(body, doc.fields || {}, state.organizations || []);
      const storedPath = await fileDocument({store, doc, fields, organizations: state.organizations || []});
      await fin.update(doc.id, {status: 'filed', fields, stored_path: storedPath, questions: [], filed_at: new Date().toISOString(), error: null});
      await fin.replaceEntry(doc, fields, actor);
      await fin.learn(fields);
      return send(req, res, 200, {document: publicDoc(await fin.get(doc.id)), counts: await fin.counts()}), true;
    }
    if (action === 'ignore' && method === 'POST') {
      if (doc.status === 'filed') throw new AppError(409, '已歸檔的文件請先「重新確認」');
      await fin.update(doc.id, {status: 'ignored'});
      await fin.replaceEntry(doc, {countInPnl: false}, actor);
      return send(req, res, 200, {document: publicDoc(await fin.get(doc.id)), counts: await fin.counts()}), true;
    }
    if (action === 'reopen' && method === 'POST') {
      // 檔案留在已歸檔的位置，只把損益項目拿掉，等重新確認。
      await fin.replaceEntry(doc, {countInPnl: false}, actor);
      await fin.update(doc.id, {status: 'needs_review', filed_at: null});
      return send(req, res, 200, {document: publicDoc(await fin.get(doc.id)), counts: await fin.counts()}), true;
    }
    if (action === 'retry' && method === 'POST') {
      if (doc.status !== 'error' && doc.status !== 'needs_review') throw new AppError(409, '只有待確認或辨識失敗的文件可以重新辨識');
      const abs = safeJoinRoot(financeRoot(), doc.stored_path);
      const state = await store.read();
      const row = await processDocument({store, fin, id: doc.id, absPath: abs, organizations: state.organizations || [], config, classify, actor, allowAuto: false});
      return send(req, res, 200, {document: publicDoc(row), counts: await fin.counts()}), true;
    }
  }

  if (p === '/api/finance/entries' && method === 'GET') {
    const rows = await fin.entries({month: normalizeMonth(url.searchParams.get('month') || '') || undefined, year: /^\d{4}$/.test(url.searchParams.get('year') || '') ? url.searchParams.get('year') : undefined});
    return send(req, res, 200, {entries: rows.map((r) => ({id: r.id, month: r.month, kind: r.kind, category: r.category, counterparty: r.counterparty, description: r.description, net: r.net === null ? null : Number(r.net), tax: r.tax === null ? null : Number(r.tax), total: Number(r.total), source: r.source, docId: r.doc_id, docName: r.original_name || null, docType: r.doc_type || null}))}), true;
  }
  if (p === '/api/finance/entries' && method === 'POST') {
    const entry = validateManualEntry(await readJson(req));
    const id = await fin.addManual(entry, actor);
    return send(req, res, 200, {id}), true;
  }
  const em = p.match(/^\/api\/finance\/entries\/([0-9a-f-]{36})$/);
  if (em && method === 'DELETE') {
    await fin.deleteManual(em[1]);
    return send(req, res, 200, {ok: true}), true;
  }

  if ((p === '/api/finance/pnl' || p === '/api/finance/pnl.csv') && method === 'GET') {
    const year = /^\d{4}$/.test(url.searchParams.get('year') || '') ? url.searchParams.get('year') : new Date().getFullYear().toString();
    const basis = url.searchParams.get('basis') === 'net' ? 'net' : 'total';
    const pnl = buildPnl({year, basis, entries: (await fin.entries({year})).map((e) => ({...e, total: Number(e.total), net: e.net === null ? null : Number(e.net), tax: e.tax === null ? null : Number(e.tax)})), payroll: url.searchParams.get('payroll') === 'off' ? {} : await fin.payrollByMonth(year)});
    if (p.endsWith('.csv')) {
      const body = Buffer.from(pnlCsv(pnl), 'utf8');
      const name = `損益表_${year}${basis === 'net' ? '_未稅' : ''}.csv`;
      res.writeHead(200, {'Content-Type': 'text/csv; charset=utf-8', 'Content-Length': body.length, 'Content-Disposition': `attachment; filename="pnl_${year}.csv"; filename*=UTF-8''${encodeURIComponent(name)}`});
      res.end(body);
      return true;
    }
    return send(req, res, 200, pnl), true;
  }
  return false;
}

/** 辨識一份已存進收件匣的文件；有把握就自動歸檔，否則留在「待確認」。 */
export async function processDocument({store, fin, id, absPath, organizations, config, classify, actor, allowAuto = true}) {
  const doc = await fin.get(id);
  let raw;
  try {
    raw = classify
      ? await classify({absPath, filename: doc.original_name, organizations})
      : await classifyWithGemini({absPath, filename: doc.original_name, organizations, rules: await fin.rules(), config});
  } catch (e) {
    await fin.update(id, {status: 'error', error: e?.status ? e.message : '辨識失敗，請稍後按「重新辨識」或手動填寫', questions: ['AI 沒辦法辨識這份文件，請手動填寫或稍後重新辨識']});
    return fin.get(id);
  }
  const rules = await fin.rules();
  let review = reviewFields(raw, {organizations, rules});
  const duplicates = {
    invoice: await fin.duplicateInvoice(review.fields.invoiceNumber, id),
    overlap: await fin.overlap(review.fields, id),
  };
  if (duplicates.invoice || duplicates.overlap) review = reviewFields(raw, {organizations, rules, duplicates});
  if (allowAuto && !review.needsReview) {
    try {
      const storedPath = await fileDocument({store, doc, fields: review.fields, organizations});
      await fin.update(id, {status: 'filed', ai: raw, fields: review.fields, questions: [], confidence: review.confidence, stored_path: storedPath, filed_at: new Date().toISOString(), error: null});
      await fin.replaceEntry(doc, review.fields, actor);
      return fin.get(id);
    } catch (e) {
      review.questions.push('自動歸檔失敗：' + (e?.status ? e.message : '無法搬移檔案'));
    }
  }
  await fin.update(id, {status: 'needs_review', ai: raw, fields: review.fields, questions: review.questions.length ? review.questions : ['AI 把握度不夠高，請確認內容'], confidence: review.confidence, error: null});
  return fin.get(id);
}
