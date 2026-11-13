import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {AUTO_ID_RE, EXISTING_ID_RE} from './hr-ids.mjs';
import {fetchSheetValues, serviceAccountStatus} from './google-sa.mjs';
import {AppError} from './domain.mjs';

export const DEFAULT_SALARY_IMPORT = {
  spreadsheetId: '1DkB-tDXzO6PsUuyUE2EPO9e_7IjKYt2ZxlsUJfwdZxo',
  sheetTab: '薪資計算明細',
  columns: {month: '計算月份', employeeId: '員工編號', name: '員工姓名', amount: '實領薪資'},
};

const HEADER_ALIASES = {
  month: ['計算月份', '薪資月份', '發薪月份', '月份', '月分', '年月'],
  employeeId: ['員工編號', '編號', '工號', '員工代號'],
  name: ['員工姓名', '姓名', '名字'],
  amount: ['實領薪資', '實發金額', '實發薪資', '實領金額', '實發', '實領', '應發薪資', '實領月薪'],
};

export const SETUP_INSTRUCTIONS = [
  '尚未設定 Google 服務帳戶，所以現在不能從「打卡算薪水」試算表匯入薪資。請在 NAS 上完成以下步驟（只要讀取、不會寫回試算表）：',
  '1. 在 Google Cloud 建立一個服務帳戶，並下載 JSON 金鑰。',
  '2. 把 JSON 放到 NAS（例如 /volume1/docker/companybrain/google-sa.json），不要提交到 Git。',
  '3. 在 settings.env 新增 GOOGLE_SA_JSON=/volume1/docker/companybrain/google-sa.json（也可以把整份 JSON 貼在等號後面）。',
  '4. 開啟試算表，按「共用」，把 JSON 裡的 client_email 加成「檢視者」。',
  '5. 重啟 companybrain 後再按「匯入本月薪資」。',
  '預設讀取分頁「薪資計算明細」，以「員工編號」對應員工、「計算月份」對應月份、「實領薪資」對應實發金額。每日打卡明細列會自動略過。欄位名稱可在匯入畫面調整並存成預設。',
].join('\n');

export function guessMapping(headers = []) {
  const list = headers.map((h) => String(h || '').trim());
  const found = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const hit = list.find((h) => aliases.some((a) => h === a || h.replaceAll(/\s+/g, '') === a));
    if (hit) found[field] = hit;
  }
  return {...DEFAULT_SALARY_IMPORT.columns, ...found};
}

export function parseMonth(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})[\/.\-年](\d{1,2})(?:[\/.\-月]\d{1,2})?/);
  if (m) return m[1] + '-' + String(m[2]).padStart(2, '0');
  m = s.match(/^(\d{4})(\d{2})$/);
  if (m) return m[1] + '-' + m[2];
  return '';
}

export function parseAmount(value) {
  const s = String(value ?? '').trim().replace(/,/g, '').replace(/[^\d.\-]/g, '');
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function isSummaryEmployeeId(value) {
  const s = String(value || '').trim().toUpperCase();
  if (!s || s === '—' || s === '-' || s === '–') return false;
  if (/上班|下班|結算|工時|休息|狀態/.test(s) || /[⏱️]/.test(String(value || ''))) return false;
  if (AUTO_ID_RE.test(s)) return true;
  if (/^EMP[-_][A-Z0-9]+$/.test(s)) return true;
  if (EXISTING_ID_RE.test(s) && /[A-Z]/.test(s) && /\d/.test(s)) return true;
  return false;
}

export function normalizeColumns(columns = {}) {
  return {
    month: String(columns.month || DEFAULT_SALARY_IMPORT.columns.month).trim() || DEFAULT_SALARY_IMPORT.columns.month,
    employeeId: String(columns.employeeId || DEFAULT_SALARY_IMPORT.columns.employeeId).trim() || DEFAULT_SALARY_IMPORT.columns.employeeId,
    name: String(columns.name || DEFAULT_SALARY_IMPORT.columns.name).trim() || DEFAULT_SALARY_IMPORT.columns.name,
    amount: String(columns.amount || DEFAULT_SALARY_IMPORT.columns.amount).trim() || DEFAULT_SALARY_IMPORT.columns.amount,
  };
}

function headerIndex(headers, name) {
  const want = String(name || '').trim();
  return headers.findIndex((h) => String(h || '').trim() === want);
}

export function parseSheetRows(values, columns) {
  if (!values?.length) return {headers: [], rows: [], skipped: 0, months: []};
  const headers = values[0].map((h) => String(h || '').trim());
  const cols = normalizeColumns(columns && Object.keys(columns).length ? columns : guessMapping(headers));
  const iMonth = headerIndex(headers, cols.month);
  const iId = headerIndex(headers, cols.employeeId);
  const iName = headerIndex(headers, cols.name);
  const iAmt = headerIndex(headers, cols.amount);
  if (iMonth < 0 || iId < 0 || iAmt < 0) {
    throw new AppError(400, '找不到必要欄位（需要月份、員工編號、實領／實發金額）。請檢查欄位對應。目前表頭：' + headers.filter(Boolean).join('、'));
  }
  const rows = [];
  let skipped = 0;
  const months = new Set();
  for (const raw of values.slice(1)) {
    const id = iId >= 0 ? String(raw[iId] || '').trim() : '';
    if (!isSummaryEmployeeId(id)) { skipped += 1; continue; }
    const month = parseMonth(raw[iMonth]);
    const netPay = parseAmount(raw[iAmt]);
    if (!month || netPay == null) { skipped += 1; continue; }
    months.add(month);
    rows.push({
      month,
      employeeId: id.toUpperCase(),
      name: iName >= 0 ? String(raw[iName] || '').trim() : '',
      netPay,
    });
  }
  return {headers, columns: cols, rows, skipped, months: [...months].sort()};
}

export function compareSalaryRows(rows, {employees = [], salaries = [], month} = {}) {
  const empById = new Map(employees.map((e) => [String(e.id).toUpperCase(), e]));
  const target = month || (rows[0]?.month || '');
  const list = rows.filter((r) => r.month === target);
  const out = list.map((r) => {
    const emp = empById.get(r.employeeId);
    const existing = emp ? salaries.find((s) => s.employeeId === emp.id && s.month === r.month) : null;
    let status = 'unmatched';
    if (emp && !existing) status = 'new';
    else if (emp && Number(existing.netPay) !== Number(r.netPay)) status = 'changed';
    else if (emp) status = 'same';
    return {
      month: r.month,
      employeeId: emp?.id || r.employeeId,
      name: emp?.name || r.name,
      sheetName: r.name,
      netPay: r.netPay,
      existingPay: existing ? Number(existing.netPay) : null,
      remittance: existing?.remittance || '未匯',
      status,
    };
  });
  const counts = {new: 0, changed: 0, same: 0, unmatched: 0};
  for (const r of out) counts[r.status] += 1;
  return {month: target, rows: out, counts};
}

export function parseCsv(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.length);
  return lines.map((line) => {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') out.push(cur), cur = '';
      else cur += ch;
    }
    out.push(cur);
    return out;
  });
}

export function fixturePath() {
  return String(process.env.HR_SALARY_SHEET_FIXTURE || '').trim();
}

export async function loadSheetValues({spreadsheetId, sheetTab, fetchImpl, values} = {}) {
  if (values) return values;
  const path = fixturePath();
  if (path) {
    if (!existsSync(path)) throw new AppError(500, '找不到薪資匯入測試檔');
    return parseCsv(await readFile(path, 'utf8'));
  }
  const status = await serviceAccountStatus();
  if (!status.configured) throw new AppError(400, SETUP_INSTRUCTIONS);
  try {
    return await fetchSheetValues({spreadsheetId, sheetTab, fetchImpl});
  } catch (e) {
    throw new AppError(e.message?.includes('權限') || e.message?.includes('找不到') ? 400 : 502, e.message || '讀取試算表失敗');
  }
}

export async function importStatus() {
  const sa = await serviceAccountStatus();
  const fixture = fixturePath();
  const configured = Boolean(sa.configured || fixture);
  return {
    configured,
    source: fixture ? 'fixture' : (sa.configured ? 'google' : 'none'),
    clientEmail: sa.clientEmail || '',
    reason: configured ? '' : sa.reason,
    instructions: configured ? '' : SETUP_INSTRUCTIONS,
  };
}
