#!/usr/bin/env node
/**
 * Read-only import of HumanResourceManagement SQLite into companybrain Postgres.
 * Idempotent and non-destructive: existing rows are left untouched (INSERT ... DO NOTHING / skip).
 *
 *   node scripts/migrate-hr.mjs --sqlite /path/to/hr.sqlite3 --dry-run
 *   node scripts/migrate-hr.mjs --sqlite /path/to/hr.sqlite3
 *
 * PG connection: PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD (same as companybrain).
 */
import {readFileSync, existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import process from 'node:process';
const leaveMod = await import(process.env.HR_MIGRATE_FROM_APP ? './hr-leave.mjs' : '../backend/hr-leave.mjs');
const storeMod = await import(process.env.HR_MIGRATE_FROM_APP ? './hr-store.mjs' : '../backend/hr-store.mjs');
const arrivalMod = await import(process.env.HR_MIGRATE_FROM_APP ? './hr-arrival.mjs' : '../backend/hr-arrival.mjs');
const {HrStore} = storeMod;
const {hoursToDays, parsePeriod, DEFAULT_BASIS} = leaveMod;
const {planArrivalFromInsurance, applyArrivalFill} = arrivalMod;


function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const dryRun = process.argv.includes('--dry-run');
const sqlitePath = arg('--sqlite');
if (!sqlitePath) {
  console.error('請提供 --sqlite /path/to/hr.sqlite3');
  process.exit(2);
}
if (!existsSync(sqlitePath)) {
  console.error('找不到 SQLite：' + sqlitePath);
  process.exit(2);
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
function tables(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
}
function rows(db, sql) {
  try { return db.prepare(sql).all(); } catch { return []; }
}

function openSqlite(path) {
  const db = new DatabaseSync(path, {readOnly: true});
  db.exec('PRAGMA query_only=ON');
  return db;
}

function collect(db) {
  const have = tables(db);
  const out = {
    employees: have.has('employees') ? rows(db, 'SELECT * FROM employees') : [],
    records: have.has('records') ? rows(db, 'SELECT * FROM records') : [],
    documents: have.has('documents') ? rows(db, 'SELECT * FROM documents') : [],
    candidates: have.has('candidates') ? rows(db, 'SELECT * FROM candidates') : [],
    recruitmentEvents: have.has('recruitment_events') ? rows(db, 'SELECT * FROM recruitment_events') : [],
    recruitmentImportRows: have.has('recruitment_import_rows') ? rows(db, 'SELECT * FROM recruitment_import_rows') : [],
    recruitmentGoals: have.has('recruitment_goals') ? rows(db, 'SELECT * FROM recruitment_goals') : [],
    leaveImportRows: have.has('leave_import_rows') ? rows(db, 'SELECT * FROM leave_import_rows') : [],
    salaries: have.has('salaries') ? rows(db, 'SELECT * FROM salaries') : [],
    attendance: have.has('attendance') ? rows(db, 'SELECT * FROM attendance') : [],
    audit: have.has('audit') ? rows(db, 'SELECT * FROM audit') : [],
    settings: have.has('settings') ? rows(db, 'SELECT * FROM settings') : [],
  };
  return out;
}

function countsOf(data) {
  const leaveRecords = data.records.filter((r) => r.kind === 'leave');
  return {
    employees: data.employees.length,
    records: data.records.length,
    leaveRecords: leaveRecords.length,
    documents: data.documents.length,
    candidates: data.candidates.length,
    recruitmentEvents: data.recruitmentEvents.length,
    recruitmentImportRows: data.recruitmentImportRows.length,
    recruitmentGoals: data.recruitmentGoals.length,
    leaveImportRows: data.leaveImportRows.length,
    salaries: data.salaries.length,
    attendance: data.attendance.length,
    audit: data.audit.length,
    settings: data.settings.length,
  };
}

function empPayload(row) {
  return parseJson(row.data, {});
}

const sqlite = openSqlite(sqlitePath);
const data = collect(sqlite);
const counts = countsOf(data);
console.log(dryRun ? '【預演 --dry-run】只讀舊人資 SQLite，不寫入 Postgres' : '【正式遷移】讀舊人資 SQLite（唯讀），寫入 companybrain（既有列不覆蓋）');
console.log('來源：' + sqlitePath);
console.log('筆數：');
for (const [k, v] of Object.entries(counts)) console.log('  ' + k + ': ' + v);

// Preview leave ledger mapping even in dry-run
function plannedLedgers() {
  const filledDates = Object.fromEntries((typeof arrivalPlan !== 'undefined' ? arrivalPlan.filled : []).map((f) => [f.employeeId, f.arrivalDate]));
  const emps = Object.fromEntries(data.employees.map((r) => {
    const p = empPayload(r);
    return [r.id, {id: r.id, ...p, arrivalDate: p.arrivalDate || filledDates[r.id] || ''}];
  }));
  const leaveRecs = data.records.filter((r) => r.kind === 'leave').map((r) => ({...r, payload: parseJson(r.data, {})}));
  const groups = new Map();
  for (const rec of leaveRecs) {
    const emp = emps[rec.employee_id];
    if (!emp) continue;
    const payload = rec.payload;
    const year = parsePeriod(payload.period, emp.arrivalDate, payload.date, DEFAULT_BASIS);
    const key = rec.employee_id + '::' + (year?.yearKey || payload.period || 'unmapped');
    if (!groups.has(key)) groups.set(key, {employeeId: rec.employee_id, year, period: payload.period, grants: 0, used: 0, settled: false, entries: 0, unmapped: !year});
    const g = groups.get(key);
    const days = hoursToDays(payload.hours);
    if (payload.action === '已休') { g.used += days; g.entries += 1; }
    else if (payload.action === '結清') g.settled = true;
    else g.grants += days; // 核給 / 調整
  }
  return [...groups.values()];
}
const insuranceRecs = data.records.filter((r) => r.kind === 'insurance').map((r) => ({...r, payload: parseJson(r.data, {})}));
const arrivalPlan = planArrivalFromInsurance(
  data.employees.map((r) => ({id: r.id, ...empPayload(r)})),
  insuranceRecs
);
console.log('  arrivalFilled (空到職日由最早加保日帶入): ' + arrivalPlan.filled.length);
console.log('  arrivalStillMissing (無到職日也無加保日): ' + arrivalPlan.stillMissing.length);
for (const item of arrivalPlan.filled) console.log('    - ' + item.employeeId + ' ' + (item.name || '') + ' ← ' + item.arrivalDate);
for (const item of arrivalPlan.stillMissing) console.log('    - ' + item.employeeId + ' ' + (item.name || '') + '（仍缺）');

const ledgers = plannedLedgers();
console.log('  leaveLedgers (由特休紀錄對應到職日週年): ' + ledgers.length + '（其中無法對應期間 ' + ledgers.filter((g) => g.unmapped).length + '）');

if (dryRun) {
  sqlite.close();
  process.exit(0);
}

const pg = await import('pg');
const pool = new pg.default.Pool({max: 5, connectionTimeoutMillis: 10000});
const hr = new HrStore(pool);
await hr.ensure();

async function skipOr(table, id, insert) {
  if (!id) return 'skip';
  const exists = await pool.query(`SELECT 1 FROM ${table} WHERE id=$1`, [id]);
  if (exists.rowCount) return 'exists';
  await insert();
  return 'inserted';
}

const result = Object.fromEntries(Object.keys(counts).map((k) => [k, {inserted: 0, exists: 0, skipped: 0}]));
result.leaveYears = {inserted: 0, exists: 0, skipped: 0};
result.leaveEntries = {inserted: 0, exists: 0, skipped: 0};

for (const row of data.employees) {
  const payload = empPayload(row);
  const exists = await pool.query('SELECT 1 FROM hr_employees WHERE id=$1', [row.id]);
  if (exists.rowCount) result.employees.exists += 1;
  else {
    await pool.query('INSERT INTO hr_employees(id, payload, revision, updated_at) VALUES($1,$2,$3,now())', [row.id, payload, row.revision || 1]);
    result.employees.inserted += 1;
  }
}

for (const row of data.records) {
  const payload = parseJson(row.data, {});
  const st = await skipOr('hr_records', row.id, () => pool.query(
    'INSERT INTO hr_records(id, employee_id, kind, payload, created_at) VALUES($1,$2,$3,$4,COALESCE($5::timestamptz, now()))',
    [row.id, row.employee_id, row.kind, payload, row.created || null]
  ));
  result.records[st === 'inserted' ? 'inserted' : st === 'exists' ? 'exists' : 'skipped'] += 1;
}

for (const row of data.documents) {
  const suggestions = parseJson(row.suggestions, []);
  const st = await skipOr('hr_documents', row.id, () => pool.query(
    `INSERT INTO hr_documents(id, category, relative_path, filename, size, mtime, available, employee_id, suggestions)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(category, relative_path) DO NOTHING`,
    [row.id, row.category, row.relative_path, row.filename, row.size, row.mtime, Boolean(row.available), row.employee_id, JSON.stringify(suggestions)]
  ));
  result.documents[st === 'inserted' ? 'inserted' : st === 'exists' ? 'exists' : 'skipped'] += 1;
}

for (const row of data.candidates) {
  const payload = parseJson(row.data, {});
  const exists = await pool.query('SELECT 1 FROM hr_candidates WHERE id=$1', [row.id]);
  if (exists.rowCount) result.candidates.exists += 1;
  else {
    await pool.query('INSERT INTO hr_candidates(id, payload, revision, created_at, updated_at) VALUES($1,$2,$3,COALESCE($4::timestamptz, now()),COALESCE($5::timestamptz, now()))',
      [row.id, payload, row.revision || 1, row.created || null, row.updated || null]);
    result.candidates.inserted += 1;
  }
}

for (const row of data.recruitmentEvents) {
  const payload = parseJson(row.data, {});
  const st = await skipOr('hr_recruitment_events', row.id, () => pool.query(
    'INSERT INTO hr_recruitment_events(id, candidate_id, kind, payload, created_at) VALUES($1,$2,$3,$4,COALESCE($5::timestamptz, now()))',
    [row.id, row.candidate_id, row.kind, payload, row.created || null]
  ));
  result.recruitmentEvents[st === 'inserted' ? 'inserted' : 'exists'] += 1;
}
for (const row of data.recruitmentImportRows) {
  const payload = parseJson(row.data, {});
  const st = await skipOr('hr_recruitment_import_rows', row.id, () => pool.query(
    'INSERT INTO hr_recruitment_import_rows(id, candidate_id, payload, created_at) VALUES($1,$2,$3,COALESCE($4::timestamptz, now()))',
    [row.id, row.candidate_id, payload, row.created || null]
  ));
  result.recruitmentImportRows[st === 'inserted' ? 'inserted' : 'exists'] += 1;
}
for (const row of data.recruitmentGoals) {
  const payload = parseJson(row.data, {});
  const exists = await pool.query('SELECT 1 FROM hr_recruitment_goals WHERE department=$1', [row.department]);
  if (exists.rowCount) result.recruitmentGoals.exists += 1;
  else {
    await pool.query('INSERT INTO hr_recruitment_goals(department, payload, revision) VALUES($1,$2,$3)', [row.department, payload, row.revision || 1]);
    result.recruitmentGoals.inserted += 1;
  }
}
for (const row of data.leaveImportRows) {
  const payload = parseJson(row.data, {});
  const st = await skipOr('hr_leave_import_rows', row.id, () => pool.query(
    'INSERT INTO hr_leave_import_rows(id, employee_id, payload, created_at) VALUES($1,$2,$3,COALESCE($4::timestamptz, now()))',
    [row.id, row.employee_id, payload, row.created || null]
  ));
  result.leaveImportRows[st === 'inserted' ? 'inserted' : 'exists'] += 1;
}
for (const row of data.salaries) {
  const payload = parseJson(row.data, {});
  const exists = await pool.query('SELECT 1 FROM hr_salaries WHERE id=$1', [row.id]);
  if (exists.rowCount) result.salaries.exists += 1;
  else {
    await pool.query(
      'INSERT INTO hr_salaries(id, employee_id, month, digest, version, status, payload, created_at) VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now())) ON CONFLICT(employee_id, month, digest) DO NOTHING',
      [row.id, row.employee_id, row.month, row.digest, row.version, row.status, payload, row.created || null]
    );
    result.salaries.inserted += 1;
  }
}
for (const row of data.attendance) {
  const payload = parseJson(row.data, {});
  const st = await skipOr('hr_attendance', row.id, () => pool.query(
    'INSERT INTO hr_attendance(id, employee_id, payload) VALUES($1,$2,$3)',
    [row.id, row.employee_id, payload]
  ));
  result.attendance[st === 'inserted' ? 'inserted' : 'exists'] += 1;
}
for (const row of data.settings) {
  if (row.key === 'leaveYearBasis') continue;
  const exists = await pool.query('SELECT 1 FROM hr_settings WHERE key=$1', [row.key]);
  if (exists.rowCount) result.settings.exists += 1;
  else {
    await pool.query('INSERT INTO hr_settings(key, value) VALUES($1,$2)', [row.key, parseJson(row.value, row.value)]);
    result.settings.inserted += 1;
  }
}

// Fill empty 到職日 from earliest 加保日 (never overwrites an existing date)
const fillResult = await applyArrivalFill(pool, {
  employees: data.employees.map((r) => ({id: r.id, ...empPayload(r)})),
  records: insuranceRecs,
});
result.arrivalFilled = {inserted: fillResult.filled, exists: 0, skipped: fillResult.stillMissing};
console.log('到職日由加保日帶入：' + fillResult.filled + '；仍缺：' + fillResult.stillMissing);

// Build leave ledgers from records; also ensure statutory years
const emps = Object.fromEntries((await pool.query('SELECT id, payload FROM hr_employees')).rows.map((r) => [r.id, {id: r.id, ...r.payload}]));
for (const emp of Object.values(emps)) {
  if (emp.arrivalDate) await hr.ensureEmployeeYears(emp.id);
}
for (const g of ledgers) {
  const emp = emps[g.employeeId];
  if (!emp?.arrivalDate) { result.leaveYears.skipped += 1; continue; }
  if (g.unmapped || !g.year) { result.leaveYears.skipped += 1; continue; }
  await hr.ensureEmployeeYears(emp.id, g.year.endsOn);
  const found = (await pool.query('SELECT * FROM hr_leave_years WHERE employee_id=$1 AND year_key=$2', [g.employeeId, g.year.yearKey])).rows[0];
  if (!found) { result.leaveYears.skipped += 1; continue; }
  if (found.entitled_source !== 'manual' && found.status === '未結算' && g.grants > 0) {
    await pool.query("UPDATE hr_leave_years SET entitled=$1, entitled_source='imported' WHERE id=$2 AND entitled_source='statutory'", [g.grants, found.id]);
  }
  if (g.settled && found.status === '未結算') {
    const status = g.used >= Number(found.entitled) ? '已休完' : '未休完已折現';
    await pool.query("UPDATE hr_leave_years SET status=$1, notes=COALESCE(NULLIF(notes,''), '由舊人資系統結清紀錄帶入（不記金額）') WHERE id=$2 AND status='未結算'", [status, found.id]);
  }
  result.leaveYears.inserted += 1;
}

const leaveRecs = data.records.filter((r) => r.kind === 'leave').map((r) => ({...r, payload: parseJson(r.data, {})}));
for (const rec of leaveRecs) {
  const emp = emps[rec.employee_id];
  const payload = rec.payload;
  if (payload.action !== '已休') continue;
  const year = parsePeriod(payload.period, emp?.arrivalDate, payload.date, DEFAULT_BASIS);
  if (!year) { result.leaveEntries.skipped += 1; continue; }
  const found = (await pool.query('SELECT id FROM hr_leave_years WHERE employee_id=$1 AND year_key=$2', [rec.employee_id, year.yearKey])).rows[0];
  if (!found) { result.leaveEntries.skipped += 1; continue; }
  const entryId = 'LV-MIG-' + rec.id;
  const exists = await pool.query('SELECT 1 FROM hr_leave_entries WHERE id=$1', [entryId]);
  if (exists.rowCount) { result.leaveEntries.exists += 1; continue; }
  const days = hoursToDays(payload.hours);
  if (days <= 0) { result.leaveEntries.skipped += 1; continue; }
  await pool.query(
    'INSERT INTO hr_leave_entries(id, employee_id, leave_year_id, taken_on, days, notes) VALUES($1,$2,$3,$4,$5,$6)',
    [entryId, rec.employee_id, found.id, payload.date || year.startsOn, days, (payload.notes || payload.period || '').slice(0, 500)]
  );
  result.leaveEntries.inserted += 1;
}

// Employee IDs are kept verbatim (including D001 / F113 / EMP-001). Auto numbers
// for later 報到轉員工 are computed from the highest existing prefix+number.

console.log('寫入結果（inserted / already existed / skipped）：');
for (const [k, v] of Object.entries(result)) console.log(`  ${k}: ${v.inserted} / ${v.exists} / ${v.skipped}`);

sqlite.close();
await pool.end();
