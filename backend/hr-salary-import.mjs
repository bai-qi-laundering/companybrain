import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {fetchSheetValues, serviceAccountStatus} from './google-sa.mjs';
import {AppError} from './domain.mjs';

export const DEFAULT_SALARY_IMPORT = {
  spreadsheetId: '1DkB-tDXzO6PsUuyUE2EPO9e_7IjKYt2ZxlsUJfwdZxo',
  sheetTab: '薪資計算明細',
  columns: {month: '計算月份', employeeId: '員工編號', name: '員工姓名', amount: '實領薪資'},
};

// Visible columns of 薪資計算明細, same order as BAIQI_SALARY_VISIBLE_HEADERS in the payroll Apps Script.
export const BAIQI_SALARY_VISIBLE_HEADERS = [
  '計算月份', '最後打卡日期', '員工編號', '員工姓名', '員工部門', '職稱', '匯款類型', '薪資類型', '實領薪資',
  '出勤總工時', '正常出勤工時', '加班前2小時總時數', '加班後2小時總時數', '加班費總計',
  '伙食津貼', '職務加給', '主管加給', '業績獎金', '特休', '營運獎金', '激勵獎金', '預借薪資',
  '事假天數', '事假扣款', '病假天數', '病假扣款', '國定假日出勤天數', '國定假日加給', '本月總假天數', '實際上班天數',
  '離職日期', '在職天數', '缺勤天數', '缺勤扣款', '勞保扣款', '健保扣款', '勞保計費天數', '到職日期', '本月在職起日', '本月在職迄日',
];

export const BAIQI_SALARY_LEGACY_HEADERS = [
  '計算月份', '最後打卡日期', '員工編號', '員工姓名', '員工部門', '薪資類型',
  '出勤總工時', '加班前2小時總時數', '加班後2小時總時數', '加班費總計', '勞健保扣除額', '實領薪資',
];

const COLUMN_ALIASES = {
  匯款方式: '匯款類型',
  付款方式: '匯款類型',
  發薪方式: '匯款類型',
  姓名: '員工姓名',
  部門: '員工部門',
  計薪型態: '薪資類型',
  正常工時: '正常出勤工時',
  事假: '事假天數',
  病假: '病假天數',
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
  '預設讀取分頁「薪資計算明細」，以「員工編號」對應員工、「計算月份」對應月份、「實領薪資」對應實發金額。只帶入彙總列（計算月份為 yyyy/mm，員工編號不是打卡列或「—」）；右側隱藏的輔助欄會略過。欄位名稱可在匯入畫面調整並存成預設。',
].join('\n');

/** Same as payroll Apps Script baiqiSalaryId_: trim, uppercase, letter O → digit 0. */
export function baiqiSalaryId(v) {
  return String(v || '').trim().toUpperCase().replace(/O/g, '0');
}

/** Same as payroll Apps Script baiqiSalaryColumnKey_. */
export function baiqiSalaryColumnKey(v) {
  const s = String(v == null ? '' : v).normalize('NFKC').replace(/\s/g, '');
  return COLUMN_ALIASES[s] || s;
}

function visibleHeaderKeys() {
  return new Set([
    ...BAIQI_SALARY_VISIBLE_HEADERS.map(baiqiSalaryColumnKey),
    ...BAIQI_SALARY_LEGACY_HEADERS.map(baiqiSalaryColumnKey),
  ]);
}

/** Map visible / legacy header names to the first matching column; ignore hidden helper columns. */
export function salaryColumnMap(headers = []) {
  const allowed = visibleHeaderKeys();
  const m = new Map();
  headers.forEach((h, i) => {
    const k = baiqiSalaryColumnKey(h);
    if (!k || !allowed.has(k) || m.has(k)) return;
    m.set(k, i);
  });
  return m;
}

export function guessMapping(headers = []) {
  const list = headers.map((h) => String(h || '').trim());
  const map = salaryColumnMap(list);
  const found = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const hit = aliases.find((a) => map.has(baiqiSalaryColumnKey(a)));
    if (hit) {
      const i = map.get(baiqiSalaryColumnKey(hit));
      found[field] = list[i] || hit;
    } else {
      const loose = list.find((h) => aliases.some((a) => baiqiSalaryColumnKey(h) === baiqiSalaryColumnKey(a)));
      if (loose) found[field] = loose;
    }
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

/** Period string used by the payroll script: first '-' becomes '/'. */
export function salaryPeriod(value) {
  return String(value ?? '').replace('-', '/');
}

export function parseAmount(value) {
  const s = String(value ?? '').normalize('NFKC').trim().replace(/−/g, '-').replace(/[,\s$＄]/g, '');
  if (s === '' || s === '-' || s === '—') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Summary-row test used by baiqiSalaryRemittance_ / reorderBaiqiSalaryColumns:
 * 計算月份 matches yyyy/mm, and the normalized 員工編號 is present, does not contain ⏱, and is not —.
 */
export function isSalarySummaryRow(monthRaw, idRaw) {
  const period = salaryPeriod(monthRaw);
  const id = baiqiSalaryId(idRaw);
  return /^\d{4}\/\d{2}$/.test(period) && Boolean(id) && !id.includes('⏱') && !id.includes('⏱️') && id !== '—';
}

export function isSummaryEmployeeId(value) {
  const id = baiqiSalaryId(value);
  return Boolean(id) && !id.includes('⏱') && !id.includes('⏱️') && id !== '—' && id !== '-' && id !== '–';
}

export function normalizeColumns(columns = {}) {
  return {
    month: String(columns.month || DEFAULT_SALARY_IMPORT.columns.month).trim() || DEFAULT_SALARY_IMPORT.columns.month,
    employeeId: String(columns.employeeId || DEFAULT_SALARY_IMPORT.columns.employeeId).trim() || DEFAULT_SALARY_IMPORT.columns.employeeId,
    name: String(columns.name || DEFAULT_SALARY_IMPORT.columns.name).trim() || DEFAULT_SALARY_IMPORT.columns.name,
    amount: String(columns.amount || DEFAULT_SALARY_IMPORT.columns.amount).trim() || DEFAULT_SALARY_IMPORT.columns.amount,
  };
}

function headerIndex(headers, name, map) {
  const want = baiqiSalaryColumnKey(name);
  if (map && map.has(want)) return map.get(want);
  return headers.findIndex((h) => baiqiSalaryColumnKey(h) === want);
}

export function parseSheetRows(values, columns) {
  if (!values?.length) return {headers: [], rows: [], skipped: 0, months: []};
  const headers = values[0].map((h) => String(h || '').trim());
  const map = salaryColumnMap(headers);
  const cols = normalizeColumns(columns && Object.keys(columns).length ? columns : guessMapping(headers));
  const iMonth = headerIndex(headers, cols.month, map);
  const iId = headerIndex(headers, cols.employeeId, map);
  const iName = headerIndex(headers, cols.name, map);
  const iAmt = headerIndex(headers, cols.amount, map);
  if (iMonth < 0 || iId < 0 || iAmt < 0) {
    throw new AppError(400, '找不到必要欄位（需要月份、員工編號、實領／實發金額）。請檢查欄位對應。目前表頭：' + headers.filter(Boolean).join('、'));
  }
  const rows = [];
  let skipped = 0;
  const months = new Set();
  for (const raw of values.slice(1)) {
    const sheetId = iId >= 0 ? String(raw[iId] ?? '').trim() : '';
    if (!isSalarySummaryRow(raw[iMonth], sheetId)) { skipped += 1; continue; }
    const month = parseMonth(raw[iMonth]);
    const netPay = parseAmount(raw[iAmt]);
    if (!month || netPay == null) { skipped += 1; continue; }
    months.add(month);
    rows.push({
      month,
      employeeId: sheetId,
      name: iName >= 0 ? String(raw[iName] || '').trim() : '',
      netPay,
    });
  }
  return {headers, columns: cols, rows, skipped, months: [...months].sort()};
}

export function isActiveOn(emp, day) {
  const d = day || new Date().toLocaleDateString('en-CA', {timeZone: 'Asia/Taipei'});
  const a = emp.arrivalDate || '';
  const dep = emp.departureDate || '';
  return (!a || a <= d) && (!dep || dep >= d);
}

export function salaryImportCoverage({month, months = [], summaryCount, employees = [], today: day} = {}) {
  const activeEmployeeCount = employees.filter((e) => isActiveOn(e, day)).length;
  const warnings = [];
  const monthList = [...months].filter(Boolean);
  if (monthList.length > 1) {
    warnings.push('這份「薪資計算明細」混了多個計算月份（' + monthList.join('、') + '）。每次按「算薪水」通常會把整張分頁覆寫；請先選對月份再確認。確認後只會寫入所選月份、對得到的員工，其他月份與其他員工的紀錄不會被刪除。');
  }
  if (summaryCount < activeEmployeeCount) {
    warnings.push('本月彙總列有 ' + summaryCount + ' 筆，少於目前在職員工 ' + activeEmployeeCount + ' 人。試算表可能只算了部分部門或個別員工（每次計算會整表覆寫）。確認後只會更新對得到的人，其他人的薪資不會被清空。');
  }
  return {month: month || '', summaryCount, activeEmployeeCount, warnings};
}

export function compareSalaryRows(rows, {employees = [], salaries = [], month, today: day} = {}) {
  const groups = new Map();
  for (const e of employees) {
    const k = baiqiSalaryId(e.id);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const target = month || (rows[0]?.month || '');
  const list = rows.filter((r) => r.month === target);
  const out = list.map((r) => {
    const matches = groups.get(baiqiSalaryId(r.employeeId)) || [];
    let emp = null;
    let status = 'unmatched';
    if (matches.length > 1) status = 'ambiguous';
    else if (matches.length === 1) {
      emp = matches[0];
      const existing = salaries.find((s) => s.employeeId === emp.id && s.month === r.month);
      if (!existing) status = 'new';
      else if (Number(existing.netPay) !== Number(r.netPay)) status = 'changed';
      else status = 'same';
    }
    const existing = emp ? salaries.find((s) => s.employeeId === emp.id && s.month === r.month) : null;
    return {
      month: r.month,
      employeeId: emp?.id || r.employeeId,
      sheetId: r.employeeId,
      name: emp?.name || r.name,
      sheetName: r.name,
      netPay: r.netPay,
      existingPay: existing ? Number(existing.netPay) : null,
      remittance: existing?.remittance || '未匯',
      status,
    };
  });
  const counts = {new: 0, changed: 0, same: 0, unmatched: 0, ambiguous: 0};
  for (const r of out) counts[r.status] += 1;
  const coverage = salaryImportCoverage({
    month: target,
    months: [...new Set(rows.map((r) => r.month))].sort(),
    summaryCount: out.length,
    employees,
    today: day,
  });
  return {month: target, rows: out, counts, ...coverage};
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
