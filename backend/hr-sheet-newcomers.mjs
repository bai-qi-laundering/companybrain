// Sheet-only new employees (e.g. foreign workers the office types straight into 打卡算薪水) → companybrain.
// Runs inside the hourly 試算表同步. Rules:
// - Only rows in 員工資料 (the GAS creates the 薪資設定 row from it; 薪資設定 is only used to fill a blank
//   計薪型態／職稱). Needs 員工編號 + 姓名 + a valid 到職日 on/after HR_SHEET_GO_LIVE (set at deploy).
//   No go-live date configured → nothing is auto-created.
// - Never for: 編號 already in companybrain (O/0 normalized), the permanent ignore list, duplicate 編號 on the
//   sheet, or rows companybrain itself wrote (hr_sheet_rows).
// - Same name as an existing employee or open applicant → not created, flagged for linking.
// - Created records are marked source=sheet and listed as 「待確認（試算表新增）」 until the user confirms or
//   dismisses. companybrain never writes back to these sheet rows (they are not in hr_sheet_rows).
import {baiqiSalaryId, baiqiSalaryColumnKey} from './hr-salary-import.mjs';
import {parseSheetDate, normName} from './hr-sheet-sync.mjs';

export const PAY_TAB = '薪資設定';
export const IGNORE_KEY = 'sheetNewIgnoreIds';
export const DEFAULT_IGNORE_IDS = ['B777', 'F144', 'O004', 'W132', 'F153'];

export const NEWCOMER_SCHEMA = `
CREATE TABLE IF NOT EXISTS hr_sheet_newcomers (
  employee_id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'pending',
  sheet_row integer,
  in_pay_tab boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by text NOT NULL DEFAULT ''
);
`;

export function goLiveDate(env = process.env) {
  const m = String(env.HR_SHEET_GO_LIVE || '').trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  return m ? m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0') : '';
}

function col(headers, names) {
  const keys = (headers || []).map((h) => baiqiSalaryColumnKey(h));
  for (const n of names) { const i = keys.indexOf(baiqiSalaryColumnKey(n)); if (i >= 0) return i; }
  return -1;
}

/** Extra 員工資料 columns the sync parser does not need (計薪型態, LINE ID), by row number. */
function extraEmpCells(values) {
  const out = new Map();
  if (!values?.length) return out;
  const pt = col(values[0], ['計薪型態', '薪資類型']), line = col(values[0], ['LINE ID', 'LINEID', 'LINE']);
  values.slice(1).forEach((r, i) => out.set(i + 2, {payType: pt >= 0 ? String(r[pt] ?? '').trim() : '', lineId: line >= 0 ? String(r[line] ?? '').trim() : ''}));
  return out;
}

function payTabIndex(values) {
  const out = new Map();
  if (!values?.length) return out;
  const h = values[0];
  const id = col(h, ['員工編號']), pt = col(h, ['計薪型態']), job = col(h, ['職稱']);
  if (id < 0) return out;
  for (const r of values.slice(1)) {
    const k = baiqiSalaryId(r[id]);
    if (k && !out.has(k)) out.set(k, {payType: pt >= 0 ? String(r[pt] ?? '').trim() : '', job: job >= 0 ? String(r[job] ?? '').trim() : ''});
  }
  return out;
}

/**
 * Pure plan. sheetRows = parseEmployeeTab(...).rows. Returns {create: [...], flags: [...], skipped: {...}}.
 */
export function planNewcomers({sheetRows = [], empValues = [], payValues = [], employees = [], candidates = [], ignoreIds = [], ownedIds = [], goLive = ''}) {
  const create = [], flags = [];
  const skipped = {noGoLive: 0, beforeGoLive: 0, ignored: 0};
  if (!goLive) { skipped.noGoLive = sheetRows.length; return {create, flags, skipped}; }
  const dbKeys = new Set(employees.map((e) => baiqiSalaryId(e.id)));
  const ignore = new Set([...ignoreIds, ...ownedIds].map((x) => baiqiSalaryId(x)));
  const counts = new Map();
  for (const r of sheetRows) counts.set(r.key, (counts.get(r.key) || 0) + 1);
  const extra = extraEmpCells(empValues), pay = payTabIndex(payValues);
  const empByName = new Map(employees.filter((e) => e.name).map((e) => [normName(e.name), e]));
  const candByName = new Map(candidates.filter((c) => c.name && !c.employeeId && !c.archived).map((c) => [normName(c.name), c]));
  for (const r of sheetRows) {
    if (!r.key || dbKeys.has(r.key)) continue;
    if (ignore.has(r.key)) { skipped.ignored += 1; continue; }
    if (counts.get(r.key) > 1) continue; // already flagged as duplicate-sheet-id by the sync
    const arr = parseSheetDate(r.arrivalRaw);
    if (!arr.date || arr.date < goLive) { skipped.beforeGoLive += 1; continue; }
    const base = {employeeId: r.id.toUpperCase(), row: r.row, name: r.name};
    if (!r.name) { flags.push({...base, type: 'sheet-new-no-name'}); continue; }
    const sameEmp = empByName.get(normName(r.name));
    if (sameEmp) { flags.push({...base, type: 'sheet-new-name-match', current: sameEmp.id, suggestedId: sameEmp.id}); continue; }
    const sameCand = candByName.get(normName(r.name));
    if (sameCand) { flags.push({...base, type: 'sheet-new-candidate-match', current: sameCand.id}); continue; }
    const ex = extra.get(r.row) || {}, p = pay.get(r.key);
    const payType = ['正職', '兼職'].includes(ex.payType) ? ex.payType : (['正職', '兼職'].includes(p?.payType) ? p.payType : '');
    const dep = parseSheetDate(r.departureRaw);
    create.push({
      id: r.id.trim().toUpperCase(), row: r.row, inPayTab: Boolean(p),
      payload: {
        name: r.name,
        department: r.department === '洗滓' ? '洗滌' : r.department,
        job: r.job || p?.job || '',
        payType: payType || '正職',
        employmentType: payType || '正職',
        arrivalDate: arr.date,
        departureDate: dep.date || '',
        lineId: ex.lineId || '',
        notes: '由打卡算薪水試算表自動建立（第 ' + r.row + ' 列），請確認。',
      },
    });
  }
  return {create, flags, skipped};
}

export function createNewcomers({hr, env = process.env}) {
  const pool = hr.pool;
  let ensured = false;
  async function ensure() {
    if (ensured) return;
    await pool.query(NEWCOMER_SCHEMA);
    await hr.setSettingIfAbsent(IGNORE_KEY, DEFAULT_IGNORE_IDS);
    ensured = true;
  }
  async function ignoreIds() {
    const r = await pool.query('SELECT value FROM hr_settings WHERE key=$1', [IGNORE_KEY]);
    return Array.isArray(r.rows[0]?.value) ? r.rows[0].value : DEFAULT_IGNORE_IDS;
  }
  async function inputs() {
    await ensure();
    const employees = (await pool.query('SELECT id, payload FROM hr_employees')).rows.map((r) => ({id: r.id, ...r.payload}));
    const candidates = (await pool.query('SELECT id, payload FROM hr_candidates')).rows.map((r) => ({id: r.id, ...r.payload}));
    const owned = (await pool.query("SELECT sheet_id FROM hr_sheet_rows").catch(() => ({rows: []}))).rows.map((r) => r.sheet_id);
    return {employees, candidates, ownedIds: owned, ignoreIds: await ignoreIds(), goLive: goLiveDate(env)};
  }
  /** Plan + (unless dryRun) create. Each creation is audited. */
  async function run({sheetRows, empValues, payValues, dryRun = false, actor = 'sheet-sync'}) {
    const plan = planNewcomers({sheetRows, empValues, payValues, ...(await inputs())});
    const created = [];
    if (!dryRun) {
      for (const c of plan.create) {
        try {
          await hr.upsertEmployee(c.id, c.payload, actor, {create: true});
        } catch (e) {
          plan.flags.push({type: 'sheet-new-failed', employeeId: c.id, row: c.row, name: c.payload.name, raw: String(e.message || e).slice(0, 200)});
          continue;
        }
        await pool.query('INSERT INTO hr_sheet_newcomers(employee_id, status, sheet_row, in_pay_tab) VALUES($1,$2,$3,$4) ON CONFLICT(employee_id) DO NOTHING', [c.id, 'pending', c.row, c.inPayTab]);
        await hr.audit(pool, actor, '試算表新增員工', c.id, c.payload.name + '（員工資料第 ' + c.row + ' 列，到職 ' + c.payload.arrivalDate + '）待確認');
        created.push({employeeId: c.id, name: c.payload.name, row: c.row, department: c.payload.department, arrivalDate: c.payload.arrivalDate});
      }
    }
    return {created, planned: plan.create.map((c) => ({employeeId: c.id, name: c.payload.name, row: c.row, department: c.payload.department, arrivalDate: c.payload.arrivalDate})), flags: plan.flags, skipped: plan.skipped};
  }
  async function pending() {
    await ensure();
    const r = await pool.query(`SELECT n.employee_id, n.sheet_row, n.in_pay_tab, n.created_at, e.payload
      FROM hr_sheet_newcomers n JOIN hr_employees e ON e.id=n.employee_id WHERE n.status='pending' ORDER BY n.created_at`);
    return r.rows.map((x) => ({employeeId: x.employee_id, name: x.payload?.name || '', department: x.payload?.department || '', job: x.payload?.job || '',
      payType: x.payload?.payType || '', arrivalDate: x.payload?.arrivalDate || '', sheetRow: x.sheet_row, inPayTab: x.in_pay_tab, createdAt: x.created_at}));
  }
  async function statusOf(employeeId) {
    await ensure();
    const r = await pool.query('SELECT status FROM hr_sheet_newcomers WHERE employee_id=$1', [employeeId]);
    return r.rows[0]?.status || '';
  }
  async function confirm(employeeId, actor) {
    await ensure();
    const r = await pool.query("UPDATE hr_sheet_newcomers SET status='confirmed', decided_at=now(), decided_by=$2 WHERE employee_id=$1 AND status='pending'", [employeeId, actor]);
    if (!r.rowCount) { const e = new Error('這位不在待確認名單'); e.status = 404; throw e; }
    await hr.audit(pool, actor, '確認試算表新增員工', employeeId, '');
    return {ok: true, employeeId, status: 'confirmed'};
  }
  /** Not a real hire: remove the auto-created record (only while nothing else is attached) and never recreate it. */
  async function dismiss(employeeId, actor) {
    await ensure();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const n = await c.query("SELECT 1 FROM hr_sheet_newcomers WHERE employee_id=$1 AND status='pending' FOR UPDATE", [employeeId]);
      if (!n.rowCount) { const e = new Error('這位不在待確認名單'); e.status = 404; throw e; }
      // Leave years are derived from 到職日 automatically; drop them only when nothing was recorded.
      const entries = await c.query('SELECT 1 FROM hr_leave_entries WHERE employee_id=$1 LIMIT 1', [employeeId]);
      if (!entries.rowCount) await c.query('DELETE FROM hr_leave_years WHERE employee_id=$1', [employeeId]);
      const name = (await c.query('SELECT payload FROM hr_employees WHERE id=$1', [employeeId])).rows[0]?.payload?.name || '';
      await c.query('DELETE FROM hr_employees WHERE id=$1', [employeeId]);
      await c.query("UPDATE hr_sheet_newcomers SET status='dismissed', decided_at=now(), decided_by=$2 WHERE employee_id=$1", [employeeId, actor]);
      const ids = await ignoreIds();
      if (!ids.map(baiqiSalaryId).includes(baiqiSalaryId(employeeId))) await c.query('INSERT INTO hr_settings(key, value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [IGNORE_KEY, JSON.stringify([...ids, employeeId])]);
      await hr.audit(c, actor, '略過試算表新增員工', employeeId, name + '（已移除自動建立的資料，之後不再自動建立）');
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      if (e.code === '23503') { const err = new Error('這位已經有其他資料（文件、薪資、出勤等），不能略過；請改成確認後再手動處理'); err.status = 409; throw err; }
      throw e;
    } finally { c.release(); }
    return {ok: true, employeeId, status: 'dismissed'};
  }
  return {ensure, run, pending, statusOf, confirm, dismiss, ignoreIds};
}
