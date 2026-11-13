import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {generateJson} from './gemini.mjs';
import {isValidTaiwanId, maskTaiwanId, normalizeTaiwanId} from './hr-twid.mjs';
import {encryptSecret, last4, hasPiiKey, decryptSecret} from './hr-crypto.mjs';
import {AppError} from './domain.mjs';
import {access} from 'node:fs/promises';
import {folderConfig, scanFolders} from './hr-docs.mjs';

const BANK_SCHEMA = {
  type: 'object',
  properties: {
    bankCode: {type: ['string', 'null']},
    branch: {type: ['string', 'null']},
    account: {type: ['string', 'null']},
    accountName: {type: ['string', 'null']},
    warnings: {type: 'array', items: {type: 'string'}},
  },
  required: ['bankCode', 'branch', 'account', 'accountName', 'warnings'],
};
const ID_SCHEMA = {
  type: 'object',
  properties: {
    nationalId: {type: ['string', 'null']},
    name: {type: ['string', 'null']},
    birthDate: {type: ['string', 'null']},
    warnings: {type: 'array', items: {type: 'string'}},
  },
  required: ['nationalId', 'name', 'birthDate', 'warnings'],
};

export function geminiReady(config) {
  return Boolean(config?.key && config.key !== 'PASTE_YOUR_KEY_HERE');
}

function mimeOf(filename, fallback) {
  const ext = path.extname(filename || '').toLowerCase();
  return {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf'}[ext] || fallback || 'image/jpeg';
}

export async function extractFromFile({absPath, category, filename, mime, config, extract}) {
  if (extract) return extract({category, absPath, filename});
  if (!geminiReady(config)) return {skipped: 'no-gemini'};
  const buf = await readFile(absPath);
  const parts = [
    {inlineData: {mimeType: mimeOf(filename, mime), data: buf.toString('base64')}},
    {text: category === 'bank'
      ? '這是台灣存摺或帳戶資料頁的影像或 PDF。請只讀出畫面上看得到的銀行代碼（3位）、分行名稱、帳號、戶名。看不清楚的欄位填 null，不要臆測。warnings 列出無法辨識或模糊的項目。'
      : '這是台灣身分證影像或 PDF。請只讀出畫面上看得到的身分證字號、姓名、出生年月日（YYYY-MM-DD）。看不清楚的欄位填 null，不要臆測。warnings 列出無法辨識或模糊的項目。'},
  ];
  const system = '你是證件辨識助手，使用繁體中文。只擷取影像中實際可見的文字，不得補造帳號、身分證字號或姓名。回傳指定 JSON。';
  const schema = category === 'bank' ? BANK_SCHEMA : ID_SCHEMA;
  const raw = await generateJson({system, parts, schema, key: config.key, model: config.model || 'gemini-3.1-flash-lite'});
  return normalizeExtract(category, raw);
}

export function normalizeExtract(category, raw = {}) {
  if (category === 'bank') {
    return {
      bankCode: raw.bankCode ? String(raw.bankCode).replace(/\D/g, '').slice(0, 3) : '',
      branch: String(raw.branch || '').slice(0, 80),
      account: String(raw.account || '').replace(/[^\d-]/g, '').slice(0, 32),
      accountName: String(raw.accountName || '').slice(0, 80),
      warnings: Array.isArray(raw.warnings) ? raw.warnings.map((w) => String(w).slice(0, 200)) : [],
    };
  }
  const nationalId = normalizeTaiwanId(raw.nationalId || '');
  const birth = String(raw.birthDate || '').replace(/\//g, '-').slice(0, 10);
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.map((w) => String(w).slice(0, 200)) : [];
  if (nationalId && !isValidTaiwanId(nationalId)) warnings.push('身分證字號檢查碼不正確，請核對後再確認');
  return {nationalId, name: String(raw.name || '').slice(0, 80), birthDate: /^\d{4}-\d{2}-\d{2}$/.test(birth) ? birth : '', warnings};
}

export function publicReview(row, {revealSecrets = false} = {}) {
  const extracted = {...(row.extracted || {})};
  if (!revealSecrets) {
    if (extracted.account) extracted.accountMasked = last4(extracted.account), delete extracted.account;
    if (extracted.nationalId) extracted.nationalIdMasked = maskTaiwanId(extracted.nationalId), delete extracted.nationalId;
  }
  return {
    id: row.id, documentId: row.documentId || row.document_id, employeeId: row.employeeId || row.employee_id,
    category: row.category, status: row.status, extracted, warnings: extracted.warnings || row.warnings || [],
    created: row.created || row.created_at,
  };
}

export function confirmedPublic(pii) {
  if (!pii) return null;
  return {
    bankCode: pii.bank_code || pii.bankCode || '',
    bankBranch: pii.bank_branch || pii.bankBranch || '',
    accountName: pii.account_name || pii.accountName || '',
    accountLast4: pii.account_last4 || pii.accountLast4 || '',
    nationalIdMask: pii.national_id_mask || pii.nationalIdMask || '',
    nationalName: pii.national_name || pii.nationalName || '',
    birthDate: pii.birth_date || pii.birthDate || '',
  };
}

export function packConfirmed(category, fields) {
  if (category === 'bank') {
    const account = String(fields.account || '').replace(/[^\d-]/g, '');
    if (!account) throw new AppError(400, '請填帳號後再確認');
    if (!hasPiiKey()) throw new AppError(400, '尚未設定 HR_PII_KEY，無法保存完整銀行帳號。請先在 NAS 的 settings.env 填入後再確認。');
    return {
      bankCode: String(fields.bankCode || '').replace(/\D/g, '').slice(0, 3),
      bankBranch: String(fields.branch || fields.bankBranch || '').slice(0, 80),
      accountName: String(fields.accountName || '').slice(0, 80),
      accountLast4: last4(account),
      accountEnc: encryptSecret(account),
    };
  }
  const nationalId = normalizeTaiwanId(fields.nationalId);
  if (!nationalId) throw new AppError(400, '請填身分證字號後再確認');
  if (!isValidTaiwanId(nationalId)) throw new AppError(400, '身分證字號檢查碼不正確');
  const out = {
    nationalIdMask: maskTaiwanId(nationalId),
    nationalName: String(fields.name || fields.nationalName || '').slice(0, 80),
    birthDate: String(fields.birthDate || '').slice(0, 10),
  };
  if (hasPiiKey()) out.nationalIdEnc = encryptSecret(nationalId);
  else out.nationalIdEnc = null;
  return out;
}

export {decryptSecret, hasPiiKey, last4, isValidTaiwanId};

export async function runAfterUpload({hr, row, dest, category, config, extract, actor}) {
  if (category !== 'bank' && category !== 'identity') return {skipped: 'not-applicable'};
  try {
    const extracted = await extractFromFile({absPath: dest, category, filename: row.filename, config, extract});
    if (extracted?.skipped) return extracted;
    const review = await hr.insertOcrReview({
      documentId: row.id, employeeId: row.employeeId, category, extracted, status: 'pending',
    }, actor);
    return {review, extracted: review.extracted};
  } catch (e) {
    console.error('hr ocr failed:', e.code || e.name || e.message);
    return {skipped: 'ocr-error', message: '檔案已存，自動辨識暫時無法使用，請稍後再批次辨識或手動核對。'};
  }
}

export async function batchScanBank({hr, config, extract, actor}) {
  if (!geminiReady(config) && !extract) {
    return {ok: false, skipped: 'no-gemini', message: '尚未設定 Gemini，無法批次辨識。上傳與資料夾掃描仍可使用。', scanned: 0, pending: 0, failed: 0, skippedFiles: 0};
  }
  const state = await hr.state();
  await scanFolders(hr, state.employees);
  const after = await hr.state();
  const docs = after.documents.filter((d) => d.category === 'bank' && d.available !== false);
  const already = new Set((after.ocrReviews || []).filter((r) => r.status === 'pending' || r.status === 'confirmed').map((r) => r.documentId));
  let scanned = 0, pending = 0, failed = 0, skippedFiles = 0;
  const reviews = [];
  const errors = [];
  const root = folderConfig().bank;
  for (const doc of docs) {
    if (already.has(doc.id)) { skippedFiles += 1; continue; }
    const abs = path.join(root, doc.relativePath || doc.filename);
    try {
      await access(abs);
      const extracted = await extractFromFile({absPath: abs, category: 'bank', filename: doc.filename, config, extract});
      scanned += 1;
      if (extracted?.skipped) {
        skippedFiles += 1;
        errors.push({file: doc.filename, reason: extracted.skipped});
        continue;
      }
      const review = await hr.insertOcrReview({
        documentId: doc.id, employeeId: doc.employeeId, category: 'bank', extracted, status: 'pending',
      }, actor);
      pending += 1;
      reviews.push({id: review.id, employeeId: review.employeeId, documentId: doc.id, filename: doc.filename});
    } catch (e) {
      failed += 1;
      errors.push({file: doc.filename, reason: e.message || 'ocr-error'});
    }
  }
  return {ok: true, scanned, pending, failed, skippedFiles, reviews, errors};
}
