// 收件匣（分揀員）：什麼檔案都收 → 判斷是什麼 → 財務文件／名片照舊自動歸檔（有把握才自動），
// 身分證、居留證、駕照、存摺、履歷、離職單、薪資檔一律先加密暫存，等老闆確認後才歸到原本的人資資料夾。
// 不開立發票、不寄對帳單、不傳 LINE；個資內容不寫進稽核紀錄。
import {createCipheriv, createDecipheriv, randomBytes, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdir, readFile, unlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AppError} from './domain.mjs';
import {piiKey} from './hr-crypto.mjs';
import {
  CLASSIFY_SCHEMA, DOC_TYPES, AUTO_CONFIDENCE, classifyPrompt, classifyWithGemini, matchOrganization,
  financeRoot, normalizeDate, normalizeMonth, taipeiToday, moveFile, saveToInbox,
} from './finance.mjs';
import {orgDirectoryKind, resolveEntityFolder, safeJoinRoot, uniqueDest, safeFileName} from './directory-docs.mjs';
import {parseCsv, parseSheetRows, baiqiSalaryId} from './hr-salary-import.mjs';
import {normName} from './hr-sheet-sync.mjs';

export const CARD_TYPE = '名片';
export const HR_TYPE_CATEGORY = {'身分證': 'identity', '居留證': 'identity', '駕照': 'license', '存摺': 'bank', '履歷': 'resume'};
export const PERSONAL_TYPES = ['身分證', '居留證', '駕照', '存摺', '履歷', '離職單', '薪資檔'];
export const INBOX_TYPES = [...DOC_TYPES.filter((t) => t !== '其他'), CARD_TYPE, ...PERSONAL_TYPES, '其他'];
export const PII_TYPES = new Set(PERSONAL_TYPES);
export const SALARY_COMPANIES = ['百麒', '百富', '日聖', '百銘', '百麒國際', '百麒洗衣'];
export const DEFAULT_SALARY_COMPANY = '百麒';
export const SALARY_FOLDER = '薪資表';
export const PURGE_DAYS = Math.max(1, Number(process.env.INBOX_PII_PURGE_DAYS || 30));
const SHEET_EXT = new Set(['.xlsx', '.xlsm', '.xls', '.csv']);
const HR_MIME = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf'};

export function routeOf(docType) {
  if (HR_TYPE_CATEGORY[docType]) return 'hr';
  if (docType === CARD_TYPE) return 'card';
  if (docType === '離職單') return 'resignation';
  if (docType === '薪資檔') return 'salary';
  return 'finance';
}

export const INBOX_SCHEMA = {
  ...CLASSIFY_SCHEMA,
  properties: {
    ...CLASSIFY_SCHEMA.properties,
    docType: {type: 'string', enum: INBOX_TYPES},
    personName: {type: ['string', 'null']},
    employeeNo: {type: ['string', 'null']},
    contactName: {type: ['string', 'null']},
    contactTitle: {type: ['string', 'null']},
    contactPhones: {type: 'array', items: {type: 'string'}},
    contactEmail: {type: ['string', 'null']},
    contactAddress: {type: ['string', 'null']},
    departureDate: {type: ['string', 'null']},
  },
  required: [...CLASSIFY_SCHEMA.required, 'personName', 'employeeNo', 'contactName', 'contactTitle', 'contactPhones', 'contactEmail', 'contactAddress', 'departureDate'],
};

export function inboxPrompt(opts) {
  return classifyPrompt(opts) + `
這個收件匣什麼檔案都收，docType 也可以是：
- 名片：公司名片。counterpartyName 填名片上的公司名稱、counterpartyTaxId 填統編（有才填）；contactName、contactTitle、contactPhones（電話、手機都放進陣列）、contactEmail、contactAddress 填名片上的人與聯絡方式。orgId 只在公司名稱和「已知對象」完全一樣時才填。
- 身分證（中華民國國民身分證正面或反面）、居留證（外籍人士居留證）、駕照、存摺（銀行存摺封面／帳戶資料頁）、履歷（應徵履歷表）。
- 離職單：離職申請書、離職證明、離職切結書等員工離職文件；departureDate 填文件上的最後在職日或離職日（YYYY-MM-DD，民國年換成西元）。
- 薪資檔：多位員工的薪資明細或薪資表。
個人文件：personName 填文件上的人名，employeeNo 填文件上看得到的員工編號（沒有填 null）。不要抄寫身分證字號、居留證號、銀行帳號等號碼到任何欄位。
非財務文件的 category、金額、發票號碼欄位一律填 null。`;
}

/* ---------- 個資加密暫存 ---------- */
const MAGIC = Buffer.from('IB1');
export function encryptBlob(buf) {
  const key = piiKey();
  if (!key) throw new AppError(503, '尚未設定 HR_PII_KEY，個資文件無法安全暫存');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}
export function decryptBlob(enc) {
  const key = piiKey();
  if (!key) throw new AppError(503, '尚未設定 HR_PII_KEY，無法讀取暫存的個資文件');
  const b = Buffer.from(enc);
  if (!b.subarray(0, 3).equals(MAGIC)) throw new AppError(500, '暫存檔格式不正確');
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(3, 15));
  d.setAuthTag(b.subarray(15, 31));
  try { return Buffer.concat([d.update(b.subarray(31)), d.final()]); }
  catch { throw new AppError(500, '暫存檔無法解密（HR_PII_KEY 可能被更換）'); }
}

export class InboxStore {
  constructor(pool) { this.pool = pool; }
  async putBlob(docId, buf) {
    await this.pool.query('INSERT INTO inbox_pii_blobs(doc_id, enc) VALUES($1,$2) ON CONFLICT(doc_id) DO UPDATE SET enc=excluded.enc', [docId, encryptBlob(buf)]);
  }
  async hasBlob(docId) { return Boolean((await this.pool.query('SELECT 1 FROM inbox_pii_blobs WHERE doc_id=$1', [docId])).rows[0]); }
  async getBlob(docId) {
    const row = (await this.pool.query('SELECT enc FROM inbox_pii_blobs WHERE doc_id=$1', [docId])).rows[0];
    return row ? decryptBlob(row.enc) : null;
  }
  async dropBlob(docId) { await this.pool.query('DELETE FROM inbox_pii_blobs WHERE doc_id=$1', [docId]); }
  async setDoc(id, {route, pii, target} = {}) {
    const sets = [], vals = [];
    if (route !== undefined) { vals.push(route); sets.push(`route=$${vals.length}`); }
    if (pii !== undefined) { vals.push(Boolean(pii)); sets.push(`pii=$${vals.length}`); }
    if (target !== undefined) { vals.push(target === null ? null : JSON.stringify(target)); sets.push(`target=$${vals.length}::jsonb`); }
    if (!sets.length) return;
    vals.push(id);
    await this.pool.query(`UPDATE fin_documents SET ${sets.join(',')}, updated_at=now() WHERE id=$${vals.length}`, vals);
  }
  /** 稽核紀錄：只記動作與種類，不記個資內容。 */
  async audit(docId, action, actor, detail = '') {
    await this.pool.query('INSERT INTO inbox_audit(doc_id, action, actor, detail) VALUES($1,$2,$3,$4)', [docId || null, action, actor || 'system', String(detail || '').slice(0, 300)]);
  }
  async auditLog(limit = 100) {
    return (await this.pool.query('SELECT doc_id, action, actor, detail, created_at FROM inbox_audit ORDER BY id DESC LIMIT $1', [Math.min(Number(limit) || 100, 500)])).rows;
  }
  async pending(limit = 200) {
    return (await this.pool.query("SELECT * FROM fin_documents WHERE status IN ('needs_review','error') ORDER BY created_at DESC LIMIT $1", [limit])).rows;
  }
  async recent(limit = 40) {
    return (await this.pool.query("SELECT * FROM fin_documents WHERE status NOT IN ('needs_review','error') ORDER BY updated_at DESC LIMIT $1", [limit])).rows;
  }
  async pendingCount() {
    return Number((await this.pool.query("SELECT count(*)::int AS n FROM fin_documents WHERE status IN ('needs_review','error')")).rows[0].n);
  }
  /** 超過 PURGE_DAYS 天沒確認的個資暫存檔直接刪除。 */
  async purgeExpired(days = PURGE_DAYS) {
    const rows = (await this.pool.query(`SELECT d.id FROM fin_documents d JOIN inbox_pii_blobs b ON b.doc_id=d.id
      WHERE d.status <> 'filed' AND b.created_at < now() - ($1::int * interval '1 day')`, [days])).rows;
    for (const r of rows) {
      await this.dropBlob(r.id);
      await this.pool.query("UPDATE fin_documents SET status='purged', questions='[]'::jsonb, error=$2, updated_at=now() WHERE id=$1", [r.id, `超過 ${days} 天未確認，暫存的個資檔已刪除`]);
      await this.audit(r.id, 'purge', 'system', `${days} 天未確認`);
    }
    return rows.length;
  }
}

export function startInboxPurge({pool, log = console.log}) {
  const inbox = new InboxStore(pool);
  const run = () => inbox.purgeExpired().then((n) => { if (n) log(`收件匣：已刪除 ${n} 份逾期未確認的個資暫存檔`); }).catch((e) => console.error('Inbox purge failed:', e.name));
  setTimeout(run, 60_000).unref();
  setInterval(run, 24 * 3600_000).unref();
  return inbox;
}

/* ---------- 試算表：薪資檔在本機判斷，不送 AI ---------- */
export function readSheetValues(absPath, {timeoutMs = 30000} = {}) {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.csv') return readFile(absPath).then((b) => [{name: 'CSV', rows: parseCsv(b.toString('utf8'))}]);
  const script = fileURLToPath(new URL('./finance-excel/sheet_values.py', import.meta.url));
  return new Promise((resolve, reject) => {
    execFile('python3', [script, absPath], {timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024}, (err, stdout) => {
      if (err) return reject(new AppError(422, '無法讀取這個試算表，請另存成 .xlsx 或 CSV 後再上傳'));
      try { resolve(JSON.parse(stdout).sheets || []); } catch { reject(new AppError(422, '無法讀取這個試算表')); }
    });
  });
}

const SALARY_WORDS = ['實領', '實發', '應發', '薪資', '薪水', '本薪', '底薪', '勞保', '健保'];
/** 找出可以匯入的薪資分頁；表頭看起來像薪資但對不上欄位時也標成薪資檔（一樣不送 AI）。 */
export function detectSalary(sheets) {
  let looksLike = false;
  for (const sh of sheets || []) {
    const rows = sh.rows || [];
    if (!rows.length) continue;
    try {
      const parsed = parseSheetRows(rows, null);
      if (parsed.rows.length) {
        const months = [...new Set(parsed.rows.map((r) => r.month).filter(Boolean))].sort();
        return {isSalary: true, sheet: sh.name, rows: parsed.rows, months, warnings: parsed.warnings || []};
      }
    } catch { /* 不是可匯入的格式 */ }
    const head = rows.slice(0, 6).flat().map((c) => String(c || ''));
    const hits = SALARY_WORDS.filter((w) => head.some((c) => c.includes(w))).length;
    if (hits >= 2) looksLike = true;
  }
  return looksLike ? {isSalary: true, sheet: null, rows: [], months: [], warnings: ['看起來是薪資表，但找不到「月份／員工編號／實領」欄位，只能歸檔原檔']} : {isSalary: false};
}

/* ---------- 員工、名片 ---------- */
export async function employeeList(hr) {
  if (!hr?.pool) return [];
  const rows = (await hr.pool.query('SELECT id, payload FROM hr_employees ORDER BY id')).rows;
  return rows.map((r) => ({id: r.id, name: r.payload?.name || '', departureDate: r.payload?.departureDate || '', status: r.payload?.status || ''}));
}

/** 只在本機比對：員工編號完全相同，或姓名唯一完全相同。名單不送 AI。 */
export function suggestEmployee(employees, {personName, employeeNo} = {}) {
  const key = employeeNo ? baiqiSalaryId(employeeNo) : '';
  if (key) {
    const hits = employees.filter((e) => baiqiSalaryId(e.id) === key);
    if (hits.length === 1) return {employeeId: hits[0].id, how: 'id'};
  }
  const nm = normName(personName);
  if (nm) {
    const hits = employees.filter((e) => normName(e.name) === nm);
    if (hits.length === 1) return {employeeId: hits[0].id, how: 'name'};
    if (hits.length > 1) return {employeeId: null, how: 'ambiguous'};
  }
  return {employeeId: null, how: null};
}

const clip = (v, n = 120) => (v === null || v === undefined ? '' : String(v).trim().slice(0, n));
export function cleanContact(c = {}) {
  const phones = (Array.isArray(c.phones) ? c.phones : String(c.phones || '').split(/[、,，\n]/)).map((p) => clip(p, 40)).filter(Boolean).slice(0, 4);
  const email = clip(c.email, 120);
  return {name: clip(c.name, 60), title: clip(c.title, 60), phones, email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '', address: clip(c.address, 160)};
}
export function contactLine(c) {
  return [c.name + (c.title ? `（${c.title}）` : ''), ...c.phones, c.email, c.address].filter(Boolean).join(' ');
}
const PLACEHOLDER = /^(—|-|－|尚未提供|無|未提供|n\/a)?$/i;
const digits = (s) => String(s || '').replace(/\D/g, '');
/** 把名片聯絡人加到對象的「聯絡人」欄；同電話或同 email 已存在就不重複加。 */
export function mergeContact(existing, c) {
  const cur = String(existing || '').trim();
  if (PLACEHOLDER.test(cur)) return {contact: contactLine(c), added: true};
  const curDigits = digits(cur);
  const dup = (c.email && cur.toLowerCase().includes(c.email.toLowerCase())) || c.phones.some((p) => digits(p).length >= 6 && curDigits.includes(digits(p)));
  if (dup) return {contact: cur, added: false};
  return {contact: (cur + '\n' + contactLine(c)).slice(0, 2000), added: true};
}

export function cardFields(raw, organizations, rules) {
  const contact = cleanContact({name: raw?.contactName, title: raw?.contactTitle, phones: raw?.contactPhones, email: raw?.contactEmail, address: raw?.contactAddress});
  const company = clip(raw?.counterpartyName);
  const taxId = /^\d{8}$/.test(String(raw?.counterpartyTaxId || '')) ? String(raw.counterpartyTaxId) : null;
  const m = matchOrganization({counterpartyName: company, counterpartyTaxId: taxId, orgId: raw?.orgId || null}, organizations, rules);
  const exact = ['taxId', 'rule', 'name'].includes(m.how);
  return {docType: CARD_TYPE, counterpartyName: company || null, counterpartyTaxId: taxId, contact, orgId: m.org?.id || null, orgName: m.org?.name || null, orgKind: m.org?.kind || null, match: m.how, exact};
}

/** 個人文件的建議欄位（不含任何證號）。 */
export function personFields(raw, employees) {
  const docType = raw.docType;
  const s = suggestEmployee(employees, {personName: raw.personName, employeeNo: raw.employeeNo});
  const f = {docType, personName: clip(raw.personName, 60) || null, employeeNo: clip(raw.employeeNo, 20) || null, employeeId: s.employeeId, employeeMatch: s.how};
  if (docType === '離職單') f.departureDate = normalizeDate(raw.departureDate);
  return f;
}

/* ---------- 歸檔 ---------- */
export async function writeUnique(dirRel, filename, buf) {
  const root = financeRoot();
  const dirAbs = safeJoinRoot(root, dirRel);
  if (!dirAbs) throw new AppError(500, '歸檔路徑無效');
  await mkdir(dirAbs, {recursive: true});
  const u = await uniqueDest(dirAbs, safeFileName(filename) || '文件');
  await writeFile(u.dest, buf, {flag: 'wx', mode: 0o644});
  return path.posix.join(dirRel, u.filename);
}

/** 名片：圖片放到對象資料夾的「名片」，聯絡人加進名錄。 */
export async function fileCard({store, org, contact, buf, srcRel, originalName, actor}) {
  const entity = await resolveEntityFolder({store, kind: orgDirectoryKind(org), entityId: org.id, entityName: org.name, create: true});
  const ext = path.extname(originalName || '').toLowerCase() || '.jpg';
  const name = `${taipeiToday()}_${contact.name || '名片'}${ext}`;
  const dirRel = path.posix.join(entity.relativePath, '名片');
  let storedPath;
  if (srcRel) {
    const root = financeRoot();
    const dirAbs = safeJoinRoot(root, dirRel);
    await mkdir(dirAbs, {recursive: true});
    const u = await uniqueDest(dirAbs, safeFileName(name) || '名片' + ext);
    await moveFile(safeJoinRoot(root, srcRel), u.dest);
    storedPath = path.posix.join(dirRel, u.filename);
  } else {
    storedPath = await writeUnique(dirRel, name, buf);
  }
  let added = false;
  if (contact.name || contact.phones.length || contact.email) {
    const state = await store.read();
    const orgs = state.organizations.map((o) => {
      if (o.id !== org.id) return o;
      const r = mergeContact(o.contact, contact);
      added = r.added;
      return r.added ? {...o, contact: r.contact} : o;
    });
    if (added) await store.save(state.revision, {...state, organizations: orgs}, actor);
  }
  return {storedPath, contactAdded: added};
}

export function salaryDest(company, month, originalName) {
  const c = SALARY_COMPANIES.includes(company) ? company : DEFAULT_SALARY_COMPANY;
  return {company: c, dirRel: path.posix.join(SALARY_FOLDER, c), filename: `${month || taipeiToday()}_${safeFileName(originalName) || '薪資檔'}`};
}

export function hrMime(name) { return HR_MIME[path.extname(String(name || '')).toLowerCase()] || ''; }
export function isSheet(name) { return SHEET_EXT.has(path.extname(String(name || '')).toLowerCase()); }

/** 把暫存的內容寫到暫存檔交給辨識（離開函式就刪掉）。 */
export async function withTemp(buf, originalName, fn) {
  const ext = path.extname(originalName || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
  const tmp = path.join(os.tmpdir(), `inbox-${randomUUID()}${ext}`);
  await writeFile(tmp, buf, {mode: 0o600});
  try { return await fn(tmp); } finally { await unlink(tmp).catch(() => {}); }
}

/** 辨識：試算表先在本機判斷是不是薪資檔（薪資檔不送 AI）；其他交給 AI。 */
export async function classifyInbox({absPath, filename, organizations, rules, companies, config, classify}) {
  if (isSheet(filename)) {
    let sheets = null;
    try { sheets = await readSheetValues(absPath); } catch { sheets = null; }
    const sal = sheets ? detectSalary(sheets) : {isSalary: false};
    if (sal.isSalary) {
      return {raw: {docType: '薪資檔', confidence: 1, description: sal.months.length ? `薪資 ${sal.months.join('、')}，${sal.rows.length} 筆` : '薪資表', uncertainties: sal.warnings}, salary: sal};
    }
  }
  const raw = classify
    ? await classify({absPath, filename, organizations, inbox: true})
    : await classifyWithGemini({absPath, filename, organizations, rules, companies, config, prompt: inboxPrompt({organizations, rules, companies}), schema: INBOX_SCHEMA});
  return {raw: {...raw, docType: INBOX_TYPES.includes(raw?.docType) ? raw.docType : (raw?.docType ? '其他' : '其他')}, salary: null};
}

export function needsAsk(docType) { return PII_TYPES.has(docType); }
export function lastMonth() {
  const [y, m] = taipeiToday().split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
export {normalizeMonth, AUTO_CONFIDENCE};
