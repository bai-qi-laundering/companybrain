/**
 * 匯入老闆原本的「月份_自動損益表.xlsx」歷史月份（只讀原檔）。
 *
 * 規則（也寫在 docs/FINANCE.md）：
 * - 以「年度損益表」工作表每月每科目的數字為準（含稅，就是老闆在 Excel 看到的數字），一個月一個科目一筆，source='excel-import'。
 * - 只匯入「已結帳」月份：該月 Excel 收入 > 0；可再用 until 限制最後一個月。還在記帳中的月份（收入是 0）略過。
 * - 匯入的月份以 Excel 為準：損益表那個月只看 Excel，系統的對帳單營收、人資薪資、文件與手動項目都不計入（會註記），避免重複。
 *   之後的月份才用系統資料。重新匯入同一個月會先刪掉舊的 excel-import 再寫入（可重複執行）。
 * - 薪資在 Excel 只有每月總額（沒有每人明細），所以匯入成「薪資」科目總額。
 */
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {AppError} from './domain.mjs';
import {EXPENSE_CATEGORIES} from './finance.mjs';

export const EXCEL_SOURCE = 'excel-import';
export const EXCEL_REVENUE = '收入';
export const DEFAULT_EXCEL_PATH = '115年支出明細/月份_自動損益表.xlsx';

export function parsePnlWorkbook(absPath, {timeoutMs = 60_000} = {}) {
  const script = fileURLToPath(new URL('./finance-excel/pnl_import.py', import.meta.url));
  return new Promise((resolve, reject) => {
    execFile('python3', [script, absPath], {timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024}, (err, stdout, stderr) => {
      if (err) return reject(new AppError(422, '讀不到這份 Excel：' + String(stderr || err.message).split('\n').filter(Boolean).pop()?.slice(0, 160)));
      try { resolve(JSON.parse(stdout)); } catch { reject(new AppError(422, 'Excel 內容無法解析')); }
    });
  });
}

export async function fileSha256(absPath) {
  return createHash('sha256').update(await readFile(absPath)).digest('hex');
}

/** 「115年支出明細/…」或「…-116.xlsx」→ 西元年。 */
export function yearFromPath(rel) {
  const s = String(rel || '');
  const m = s.match(/(\d{3})年/) || s.match(/-(\d{3})\.xls[xm]?$/i);
  if (!m) return null;
  const y = Number(m[1]) + 1911;
  return y >= 2000 && y <= 2100 ? String(y) : null;
}

const round = (v) => Math.round(v * 100) / 100;

/** 純函式：把解析結果轉成要寫入的項目與預覽。 */
const taipeiMonth = () => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit'}).format(new Date());

export function planExcelImport(parsed, {year, until = null, now = taipeiMonth()} = {}) {
  if (!/^\d{4}$/.test(String(year || ''))) throw new AppError(400, '請指定年度（例如 2026）');
  if (until && !/^\d{4}-\d{2}$/.test(until)) throw new AppError(400, '最後月份格式不正確（YYYY-MM）');
  if (!parsed?.summarySheet) throw new AppError(422, (parsed?.warnings || []).join('；') || '這不是「月份_自動損益表」格式');
  const months = [], entries = [], warnings = [...(parsed.warnings || [])];
  const unknown = new Set();
  for (let i = 1; i <= 12; i++) {
    const month = `${year}-${String(i).padStart(2, '0')}`;
    const src = parsed.months?.[String(i)];
    if (!src) { months.push({month, status: 'skip', reason: 'Excel 沒有這個月'}); continue; }
    const categories = {};
    for (const [label, v] of Object.entries(src.categories || {})) {
      if (!EXPENSE_CATEGORIES.includes(label)) { if (v) unknown.add(label); continue; }
      if (v) categories[label] = round(v);
    }
    const revenue = round(src.revenue || 0);
    const expenseTotal = round(Object.values(categories).reduce((s, v) => s + v, 0));
    const detail = parsed.details?.[String(i)];
    const diffs = detail ? EXPENSE_CATEGORIES.filter((c) => Math.abs((categories[c] || 0) - (detail.categories?.[c] || 0)) > 0.5)
      .map((c) => ({category: c, summary: categories[c] || 0, detail: round(detail.categories?.[c] || 0)})) : [];
    const row = {month, revenue, expenseTotal, profit: round(revenue - expenseTotal), salary: categories['薪資'] || 0, categories, detailRows: detail?.rows || 0, diffs};
    if (month >= now) { months.push({...row, status: 'skip', reason: '本月或未來月份，用系統資料'}); continue; }
    if (!(revenue > 0)) { months.push({...row, status: 'skip', reason: '收入是 0（還在記帳中，未結帳）'}); continue; }
    if (until && month > until) { months.push({...row, status: 'skip', reason: `晚於指定的最後月份 ${until}`}); continue; }
    months.push({...row, status: 'import'});
    entries.push({month, category: EXCEL_REVENUE, kind: 'income', total: revenue});
    for (const [category, total] of Object.entries(categories)) entries.push({month, category, kind: 'expense', total});
  }
  if (unknown.size) warnings.push('這些項目不是 21 個科目，未匯入：' + [...unknown].join('、'));
  const imported = months.filter((m) => m.status === 'import');
  return {
    year: String(year), until, months, entries, warnings,
    importMonths: imported.map((m) => m.month),
    totals: {revenue: round(imported.reduce((s, m) => s + m.revenue, 0)), expense: round(imported.reduce((s, m) => s + m.expenseTotal, 0)), salary: round(imported.reduce((s, m) => s + m.salary, 0)), entries: entries.length},
  };
}

/** 寫入（可重複執行）：同一個交易裡先刪掉這些月份舊的 excel-import 再寫入。 */
export async function applyExcelImport(pool, plan, {file, sha, actor}) {
  const {randomUUID} = await import('node:crypto');
  if (!plan.importMonths.length) return {inserted: 0, deleted: 0};
  const description = `原 Excel 損益表（${file}）`;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const del = await c.query(`DELETE FROM fin_entries WHERE source='${EXCEL_SOURCE}' AND month IN (${plan.importMonths.map((_, i) => '$' + (i + 1)).join(',')})`, plan.importMonths);
    for (const e of plan.entries) {
      await c.query(`INSERT INTO fin_entries(id,month,kind,category,description,net,tax,total,source,created_by) VALUES($1,$2,$3,$4,$5,NULL,NULL,$6,'${EXCEL_SOURCE}',$7)`,
        [randomUUID(), e.month, e.kind, e.category, description, e.total, actor]);
    }
    await c.query(`INSERT INTO fin_settings(key,value,updated_by,updated_at) VALUES($1,$2::jsonb,$3,now())
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=now()`,
    ['excelImport:' + plan.year, JSON.stringify({file, sha256: sha, months: plan.importMonths, totals: plan.totals, importedAt: new Date().toISOString()}), actor]);
    await c.query('COMMIT');
    return {inserted: plan.entries.length, deleted: del.rowCount || 0};
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}
