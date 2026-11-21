#!/usr/bin/env node
// 預覽（dry-run）匯入原本「月份_自動損益表.xlsx」會寫入哪些月份與科目；只讀檔案，不連資料庫。
// 用法：node scripts/finance-excel-preview.mjs <檔案.xlsx> [--year 2026] [--until 2026-10] [--json]
import {parsePnlWorkbook, planExcelImport, yearFromPath} from '../backend/finance-import.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const file = args.find((a, i) => !a.startsWith('--') && !['--year', '--until'].includes(args[i - 1]));
if (!file) { console.error('用法：node scripts/finance-excel-preview.mjs <檔案.xlsx> [--year 2026] [--until 2026-10] [--json]'); process.exit(2); }
const plan = planExcelImport(await parsePnlWorkbook(file), {year: opt('--year') || yearFromPath(file), until: opt('--until')});
if (args.includes('--json')) { console.log(JSON.stringify({...plan, entries: undefined}, null, 2)); process.exit(0); }
const fmt = (v) => Math.round(v || 0).toLocaleString('en-US');
console.log(`年度 ${plan.year}；會匯入 ${plan.importMonths.length} 個月、${plan.totals.entries} 筆（收入 ${fmt(plan.totals.revenue)}、支出 ${fmt(plan.totals.expense)}、其中薪資 ${fmt(plan.totals.salary)}）`);
for (const m of plan.months) {
  console.log(`${m.month}  ${m.status === 'import' ? '匯入' : '略過'}  收入 ${fmt(m.revenue)}  支出 ${fmt(m.expenseTotal)}  薪資 ${fmt(m.salary)}  科目 ${Object.keys(m.categories || {}).length}${m.reason ? '  ← ' + m.reason : ''}${m.diffs?.length ? '  （明細與彙總不同：' + m.diffs.map((d) => `${d.category} ${fmt(d.summary)}/${fmt(d.detail)}`).join('、') + '）' : ''}`);
}
for (const w of plan.warnings) console.log('注意：' + w);
