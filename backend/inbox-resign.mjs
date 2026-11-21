// 收件匣的離職單：確認後把離職日寫進「打卡算薪水」試算表「員工資料」的「實際最後在職日」（G 欄，依表頭找欄位）與 companybrain。
// - 確認畫面先讀試算表目前的值；有不同的非空白值時，要老闆勾選「覆蓋」才會寫。
// - HR_SHEET_WRITE=off、沒有服務帳戶、讀不到或寫不進去 → 文件照樣歸檔，標示「離職日未寫入試算表」。
// - 只改這一格，其他欄位與試算表的 Apps Script 都不動。
import {fetchSheetTabs, updateSheetCell} from './google-sa.mjs';
import {baiqiSalaryId, baiqiSalaryColumnKey, importStatus} from './hr-salary-import.mjs';
import {parseSheetDate} from './hr-sheet-sync.mjs';
import {writeEnabled, colLetter, cellDate, EMP_TAB} from './hr-sheet-write.mjs';

export const DEPARTURE_HEADERS = ['實際最後在職日', '最後在職日', '離職日', '離職日期'];

function findCol(headers, names) {
  const keys = (headers || []).map((h) => baiqiSalaryColumnKey(h));
  for (const n of names) { const i = keys.indexOf(baiqiSalaryColumnKey(n)); if (i >= 0) return i; }
  return -1;
}

/** 在「員工資料」找這位員工的離職日格。純函式（測試用）。 */
export function locateDeparture(values, employeeId) {
  if (!values?.length) return {ok: false, error: '「員工資料」分頁是空的'};
  const headers = values[0].map((h) => String(h ?? '').trim());
  const iId = findCol(headers, ['員工編號']);
  const iDep = findCol(headers, DEPARTURE_HEADERS);
  if (iId < 0) return {ok: false, error: '「員工資料」找不到「員工編號」欄'};
  if (iDep < 0) return {ok: false, error: '「員工資料」找不到「實際最後在職日」欄'};
  const key = baiqiSalaryId(employeeId);
  const hits = [];
  values.slice(1).forEach((r, i) => { if (baiqiSalaryId(r[iId]) === key) hits.push(i + 2); });
  if (!hits.length) return {ok: false, error: `試算表「員工資料」找不到員工編號 ${employeeId}`};
  if (hits.length > 1) return {ok: false, error: `試算表「員工資料」有 ${hits.length} 列都是 ${employeeId}，請先整理試算表`};
  const row = hits[0];
  const raw = String(values[row - 1][iDep] ?? '').trim();
  const parsed = raw ? parseSheetDate(raw) : {date: ''};
  return {ok: true, row, cell: colLetter(iDep) + row, column: colLetter(iDep), header: headers[iDep], raw, current: parsed.date || '', currentInvalid: Boolean(raw && !parsed.date)};
}

export function createResignationSheet({hr, fetchImpl, loadTabs, update, statusImpl = importStatus, env = process.env} = {}) {
  async function spreadsheetId() { return (await hr.getSalaryImport()).spreadsheetId; }
  /** 讀目前的值（確認畫面顯示用）。 */
  async function read(employeeId) {
    const enabled = writeEnabled(env);
    if (!enabled) return {ok: false, writeEnabled: false, error: '已關閉寫入試算表（HR_SHEET_WRITE）'};
    try {
      if (!loadTabs && !(await statusImpl()).configured) return {ok: false, writeEnabled: true, error: '尚未設定 Google 服務帳戶'};
      const sid = await spreadsheetId();
      const tabs = loadTabs ? await loadTabs({spreadsheetId: sid}) : await fetchSheetTabs({spreadsheetId: sid, tabs: [EMP_TAB], fetchImpl});
      return {...locateDeparture(tabs[EMP_TAB] || [], employeeId), writeEnabled: true, spreadsheetId: sid};
    } catch (e) {
      return {ok: false, writeEnabled: true, error: '讀不到試算表：' + String(e.message || e).slice(0, 160)};
    }
  }
  /**
   * 寫入離職日。回傳 {written, reason?, previous, cell?}；有不同的非空白值且沒勾 overwrite → {written:false, conflict:true}。
   */
  async function write(employeeId, date, {overwrite = false} = {}) {
    const st = await read(employeeId);
    if (!st.ok) return {written: false, reason: st.error, previous: ''};
    const previous = st.current || st.raw || '';
    if (st.current === date) return {written: true, unchanged: true, previous, cell: st.cell};
    if (previous && !overwrite) return {written: false, conflict: true, reason: `試算表已有 ${previous}，未勾選覆蓋`, previous, cell: st.cell};
    try {
      const args = {spreadsheetId: st.spreadsheetId, tab: EMP_TAB, cell: st.cell, value: cellDate(date)};
      if (update) await update(args); else await updateSheetCell({...args, fetchImpl});
      return {written: true, previous, cell: st.cell};
    } catch (e) {
      return {written: false, reason: '寫入試算表失敗：' + String(e.message || e).slice(0, 160), previous, cell: st.cell};
    }
  }
  return {read, write};
}
