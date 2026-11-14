#!/usr/bin/env node
/**
 * Hard-delete recruitment candidates that are not in 待報到, after an official backup.
 *
 *   node scripts/purge-recruitment.mjs --dry-run --export-dir /path
 *   node scripts/purge-recruitment.mjs --apply --export-dir /path
 *
 * Does not delete résumé files on disk. Never deletes employees.
 * Marks deleted IDs in hr_purged_candidates so migrate-hr will not re-import them.
 */
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
import process from 'node:process';

const here = fileURLToPath(new URL('.', import.meta.url));
const fromApp = existsSync(path.join(here, 'hr-store.mjs'));
const {HrStore} = await import(fromApp ? './hr-store.mjs' : '../backend/hr-store.mjs');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const dryRun = process.argv.includes('--dry-run') || !process.argv.includes('--apply');
const exportDir = arg('--export-dir', '');

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return '"' + s.replaceAll('"', '""') + '"';
  return s;
}
function toCsv(rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((col) => csvEscape(row[col])).join(','));
  }
  return lines.join('\n') + '\n';
}

const pg = await import('pg');
const pool = new pg.default.Pool({max: 5, connectionTimeoutMillis: 10000});
const hr = new HrStore(pool);
await hr.ensure();
const plan = await hr.listRecruitmentPurgePlan();

console.log('待報到保留：' + plan.keepCount);
console.log('將刪除（非待報到）：' + plan.deleteCount);

if (exportDir) {
  await mkdir(exportDir, {recursive: true});
  const dropRows = plan.drop.map((r) => ({
    id: r.id,
    name: r.payload && r.payload.name,
    status: r.payload && r.payload.status,
    department: r.payload && r.payload.department,
    job: r.payload && (r.payload.job || r.payload.desiredPosition),
    phone: r.payload && r.payload.phone,
    employeeId: r.payload && (r.payload.employeeId || r.payload.employee_id || ''),
    created: r.created,
    updated: r.updated,
  }));
  await writeFile(path.join(exportDir, 'candidates-to-delete.json'), JSON.stringify({
    keepStatus: plan.keepStatus,
    keepCount: plan.keepCount,
    deleteCount: plan.deleteCount,
    keep: plan.keep,
    drop: plan.drop,
    events: plan.events,
    importRows: plan.importRows,
    documents: plan.documents,
    ocrReviews: plan.ocrReviews,
  }, null, 2));
  await writeFile(path.join(exportDir, 'candidates-to-delete.csv'), toCsv(dropRows, ['id', 'name', 'status', 'department', 'job', 'phone', 'employeeId', 'created', 'updated']));
  await writeFile(path.join(exportDir, 'events-to-delete.json'), JSON.stringify(plan.events, null, 2));
  await writeFile(path.join(exportDir, 'import-rows-to-delete.json'), JSON.stringify(plan.importRows, null, 2));
  await writeFile(path.join(exportDir, 'documents-to-unlink.json'), JSON.stringify(plan.documents, null, 2));
  console.log('已匯出：' + exportDir);
}

if (dryRun) {
  console.log('預演，未刪除。加上 --apply 才會清除。');
  await pool.end();
  process.exit(0);
}

const result = await hr.purgeRecruitmentExceptPending('admin1', {reason: '非待報到舊資料清除'});
console.log('已刪除：' + result.deleteCount);
console.log('仍保留待報到：' + result.keepCount);
const after = await hr.listRecruitmentPurgePlan();
if (after.deleteCount !== 0) {
  console.error('清除後仍有非待報到應徵者：' + after.deleteCount);
  await pool.end();
  process.exit(1);
}
await pool.end();
