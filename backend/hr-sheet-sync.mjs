// One-way sync: payroll Google Sheet (打卡算薪水) → companybrain HR.
// The sheet is the source of truth for 實際最後在職日 (離職日), 職稱 and 員工編號; 到職日 only fills blanks.
// Monthly 實領薪資 is NOT synced any more (owner uploads pay himself); planSalarySync is kept only for the
// manual 「匯入本月薪資」 preview code and tests.
// Sheet-only new hires on/after HR_SHEET_GO_LIVE are auto-created as 「待確認（試算表新增）」 (hr-sheet-newcomers.mjs).
// Nothing is ever written back to the sheet. Bad cells are flagged in the sync log, never fatal.
import {baiqiSalaryId, baiqiSalaryColumnKey, parseSheetRows, importStatus, fixturePath, parseCsv} from './hr-salary-import.mjs';
import {fetchSheetTabs} from './google-sa.mjs';
import {readFile} from 'node:fs/promises';
import {createNewcomers, goLiveDate, PAY_TAB} from './hr-sheet-newcomers.mjs';

export const EMPLOYEE_TAB = '員工資料';
const EMP_HEADERS = {
  id: ['員工編號', '編號', '工號'],
  name: ['姓名', '員工姓名'],
  department: ['部門', '員工部門'],
  arrivalDate: ['到職日', '到職日期', '入職日', '入職日期'],
  departureDate: ['實際最後在職日', '最後在職日', '離職日', '離職日期'],
  job: ['職稱'],
};
const LOG_KEEP = 200;

export const FLAG_LABELS = {
  'bad-date': '日期格式看不懂（請改成 yyyy/mm/dd）',
  'sheet-only': '試算表有、百麒大腦沒有這位員工',
  'cb-only': '百麒大腦有、試算表沒有這個編號',
  'ambiguous': '編號對到多位員工',
  'duplicate-sheet-id': '試算表員工資料編號重複',
  'cb-departure-only': '百麒大腦有離職日、試算表沒有（未改動）',
  'arrival-mismatch': '到職日兩邊不同（以百麒大腦為準，未改動）',
  'departure-before-arrival': '最後在職日早於到職日（未改動）',
  'salary-unmatched': '薪資列對不到員工',
  'salary-paid-changed': '已匯款的月份金額在試算表變了（未改動，請人工確認）',
  'salary-duplicate': '同一人同月份出現多列（取最後一列）',
  'name-mismatch': '同一個編號兩邊姓名不同（整列未同步，請先核對編號）',
  'sheet-new-name-match': '試算表新員工與百麒大腦現有員工同名（未自動建立，請確認是否同一人）',
  'sheet-new-candidate-match': '試算表新員工與應徵者同名（未自動建立，請從應徵者頁轉員工或確認）',
  'sheet-new-no-name': '試算表新員工沒有姓名（未自動建立）',
  'sheet-new-failed': '試算表新員工自動建立失敗',
};

export function normName(v) {
  return String(v ?? '').normalize('NFKC').replace(/\s/g, '');
}
function namesDiffer(a, b) {
  const x = normName(a), y = normName(b);
  return Boolean(x && y && x !== y);
}

function pad(n) { return String(n).padStart(2, '0'); }

/** Accepts yyyy/m/d, yyyy-m-d, yyyy.m.d (optional trailing time). Returns {date} or {error}. Blank → {date: ''}. */
export function parseSheetDate(value) {
  const raw = String(value ?? '').normalize('NFKC').trim();
  if (!raw) return {date: ''};
  const m = raw.match(/^(\d{4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})\s*日?(?:\s+.*)?$/);
  if (!m) return {error: raw};
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1950 || y > 2100 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return {error: raw};
  return {date: y + '-' + pad(mo) + '-' + pad(d)};
}

function findCol(headers, names) {
  const keys = headers.map((h) => baiqiSalaryColumnKey(h));
  for (const n of names) {
    const i = keys.indexOf(baiqiSalaryColumnKey(n));
    if (i >= 0) return i;
  }
  return -1;
}

/** Parse the 員工資料 tab by header names (column letters may move). */
export function parseEmployeeTab(values) {
  if (!values?.length) throw new Error('「員工資料」分頁是空的');
  const headers = values[0].map((h) => String(h ?? '').trim());
  const idx = Object.fromEntries(Object.entries(EMP_HEADERS).map(([k, names]) => [k, findCol(headers, names)]));
  if (idx.id < 0) throw new Error('「員工資料」找不到「員工編號」欄');
  const rows = [];
  values.slice(1).forEach((r, i) => {
    const id = String(r[idx.id] ?? '').trim();
    if (!id) return;
    const cell = (k) => (idx[k] >= 0 ? String(r[idx[k]] ?? '').trim() : '');
    rows.push({
      row: i + 2,
      id,
      key: baiqiSalaryId(id),
      name: cell('name'),
      department: cell('department'),
      job: cell('job'),
      arrivalRaw: cell('arrivalDate'),
      departureRaw: cell('departureDate'),
      hasArrival: idx.arrivalDate >= 0,
      hasDeparture: idx.departureDate >= 0,
      hasJob: idx.job >= 0,
    });
  });
  return {headers, columns: idx, rows};
}

function groupByKey(employees) {
  const m = new Map();
  for (const e of employees) {
    const k = baiqiSalaryId(e.id);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(e);
  }
  return m;
}

/** Decide employee-field changes. Pure: no DB access. */
export function planEmployeeSync({sheetRows = [], employees = []} = {}) {
  const changes = [];
  const flags = [];
  const cb = groupByKey(employees);
  const seen = new Map();
  for (const r of sheetRows) seen.set(r.key, (seen.get(r.key) || 0) + 1);
  for (const r of sheetRows) {
    if (seen.get(r.key) > 1) {
      flags.push({type: 'duplicate-sheet-id', employeeId: r.id, row: r.row, name: r.name});
      continue;
    }
    const matches = cb.get(r.key) || [];
    if (matches.length > 1) { flags.push({type: 'ambiguous', employeeId: r.id, row: r.row, name: r.name}); continue; }
    if (!matches.length) { flags.push({type: 'sheet-only', employeeId: r.id, row: r.row, name: r.name, department: r.department}); continue; }
    const emp = matches[0];
    if (namesDiffer(emp.name, r.name)) {
      const sameName = sheetRows.find((x) => x !== r && normName(x.name) === normName(emp.name));
      flags.push({type: 'name-mismatch', employeeId: emp.id, row: r.row, name: emp.name, raw: r.name, current: emp.name, suggestedId: sameName?.id || ''});
      continue;
    }
    const base = {employeeId: emp.id, name: emp.name || r.name, row: r.row};
    const arr = r.hasArrival ? parseSheetDate(r.arrivalRaw) : {date: ''};
    const dep = r.hasDeparture ? parseSheetDate(r.departureRaw) : {date: ''};
    if (arr.error) flags.push({...base, type: 'bad-date', field: 'arrivalDate', raw: arr.error});
    if (dep.error) flags.push({...base, type: 'bad-date', field: 'departureDate', raw: dep.error});
    const curArr = String(emp.arrivalDate || '');
    const curDep = String(emp.departureDate || '');
    // 到職日: fill blanks only.
    if (arr.date && !curArr) changes.push({...base, field: 'arrivalDate', from: '', to: arr.date});
    else if (arr.date && curArr && arr.date !== curArr) flags.push({...base, type: 'arrival-mismatch', field: 'arrivalDate', raw: arr.date, current: curArr});
    // 離職日: sheet wins when it has a valid date.
    const effectiveArrival = curArr || arr.date || '';
    if (dep.date) {
      if (effectiveArrival && dep.date < effectiveArrival) flags.push({...base, type: 'departure-before-arrival', field: 'departureDate', raw: dep.date, current: effectiveArrival});
      else if (dep.date !== curDep) changes.push({...base, field: 'departureDate', from: curDep, to: dep.date});
    } else if (!dep.error && curDep && r.hasDeparture) {
      flags.push({...base, type: 'cb-departure-only', field: 'departureDate', current: curDep});
    }
    // 職稱: sheet wins when filled.
    if (r.hasJob && r.job && r.job !== String(emp.job || '')) changes.push({...base, field: 'job', from: String(emp.job || ''), to: r.job});
  }
  const sheetKeys = new Set(sheetRows.map((r) => r.key));
  for (const e of employees) {
    if (!sheetKeys.has(baiqiSalaryId(e.id))) flags.push({type: 'cb-only', employeeId: e.id, name: e.name || ''});
  }
  return {changes, flags};
}

/** Decide monthly 實發金額 ledger writes from 薪資計算明細 summary rows. Pure. */
export function planSalarySync({values = [], employees = [], salaries = [], columns} = {}) {
  const writes = [];
  const flags = [];
  if (!values.length) return {writes, flags, months: [], skipped: 0};
  const parsed = parseSheetRows(values, columns);
  const cb = groupByKey(employees);
  const latest = new Map();
  for (const r of parsed.rows) {
    const k = baiqiSalaryId(r.employeeId) + '|' + r.month;
    if (latest.has(k)) flags.push({type: 'salary-duplicate', employeeId: r.employeeId, name: r.name, month: r.month});
    latest.set(k, r);
  }
  for (const r of latest.values()) {
    const matches = cb.get(baiqiSalaryId(r.employeeId)) || [];
    if (matches.length !== 1) {
      flags.push({type: matches.length ? 'ambiguous' : 'salary-unmatched', employeeId: r.employeeId, name: r.name, month: r.month, netPay: r.netPay});
      continue;
    }
    const emp = matches[0];
    if (namesDiffer(emp.name, r.name)) {
      flags.push({type: 'name-mismatch', employeeId: emp.id, name: emp.name, raw: r.name, current: emp.name, month: r.month});
      continue;
    }
    const cur = salaries.find((s) => s.employeeId === emp.id && s.month === r.month);
    const base = {employeeId: emp.id, name: emp.name || r.name, month: r.month, netPay: r.netPay};
    if (!cur) writes.push({...base, action: 'insert', from: null});
    else if (Number(cur.netPay) === Number(r.netPay)) continue;
    else if (cur.remittance === '已匯') flags.push({...base, type: 'salary-paid-changed', current: Number(cur.netPay)});
    else writes.push({...base, action: 'update', id: cur.id, from: Number(cur.netPay), notes: cur.notes, remittance: cur.remittance});
  }
  return {writes, flags, months: parsed.months, skipped: parsed.skipped};
}

export function syncIntervalMinutes(env = process.env) {
  // 「薪資計算明細」每按一次算薪水就整頁覆蓋，所以預設 10 分鐘抓一次快照；已抓到的月份永遠保留在 hr_salaries。
  const raw = String(env.HR_SHEET_SYNC_MINUTES ?? '').trim();
  if (raw === '') return 10;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 24 * 60) : 10;
}

async function loadTabs({spreadsheetId, fetchImpl}) {
  const empFixture = String(process.env.HR_EMPLOYEE_SHEET_FIXTURE || '').trim();
  if (empFixture || fixturePath()) {
    // Test/demo: HR_EMPLOYEE_SHEET_FIXTURE is the 員工資料 CSV.
    return {[EMPLOYEE_TAB]: empFixture ? parseCsv(await readFile(empFixture, 'utf8')) : []};
  }
  return fetchSheetTabs({spreadsheetId, tabs: [EMPLOYEE_TAB, PAY_TAB], fetchImpl});
}

export const SYNC_SCHEMA = `
CREATE TABLE IF NOT EXISTS hr_sheet_sync_log (
  id bigserial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  trigger text NOT NULL,
  actor text NOT NULL DEFAULT '',
  dry_run boolean NOT NULL DEFAULT false,
  ok boolean NOT NULL DEFAULT false,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text NOT NULL DEFAULT ''
);
`;

export function createSheetSync({hr, fetchImpl, loadValues, statusImpl = importStatus, env = process.env} = {}) {
  const newcomers = hr.sheetNewcomers || (hr.sheetNewcomers = createNewcomers({hr, env}));
  let running = null;
  let timer = null;
  let ensured = false;
  const pool = hr.pool;

  async function ensure() {
    if (ensured) return;
    await pool.query(SYNC_SCHEMA);
    ensured = true;
  }

  async function applyEmployeeChanges(changes, actor) {
    const byEmp = new Map();
    for (const c of changes) {
      if (!byEmp.has(c.employeeId)) byEmp.set(c.employeeId, []);
      byEmp.get(c.employeeId).push(c);
    }
    let applied = 0;
    for (const [id, list] of byEmp) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const cur = await client.query('SELECT payload FROM hr_employees WHERE id=$1 FOR UPDATE', [id]);
        if (!cur.rowCount) { await client.query('ROLLBACK'); continue; }
        const payload = {...cur.rows[0].payload};
        const done = [];
        for (const c of list) {
          if (String(payload[c.field] || '') !== String(c.from || '')) continue; // changed meanwhile; next run will retry
          payload[c.field] = c.to;
          done.push(c);
        }
        if (!done.length) { await client.query('ROLLBACK'); continue; }
        const at = new Date().toISOString();
        payload.sheetSync = {...(payload.sheetSync || {}), at, fields: done.map((c) => c.field)};
        if (done.some((c) => c.field === 'arrivalDate')) payload.arrivalDateSource = {type: '打卡試算表', at};
        await client.query('UPDATE hr_employees SET payload=$1, revision=revision+1, updated_at=now() WHERE id=$2', [payload, id]);
        await hr.audit(client, actor, '試算表同步員工', id, done.map((c) => c.field + ': ' + (c.from || '空白') + ' → ' + c.to).join('；').slice(0, 900));
        await client.query('COMMIT');
        applied += done.length;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { client.release(); }
    }
    return applied;
  }

  async function runOnce({trigger = 'manual', actor = 'system', dryRun = false} = {}) {
    await ensure();
    const status = await statusImpl();
    if (!status.configured) {
      const err = new Error('尚未設定 Google 服務帳戶，無法同步試算表。');
      err.status = 400;
      err.instructions = status.instructions;
      throw err;
    }
    const log = await pool.query('INSERT INTO hr_sheet_sync_log(trigger, actor, dry_run) VALUES($1,$2,$3) RETURNING id', [trigger, actor, dryRun]);
    const logId = log.rows[0].id;
    try {
      const cfg = await hr.getSalaryImport();
      const tabs = loadValues ? await loadValues({spreadsheetId: cfg.spreadsheetId}) : await loadTabs({spreadsheetId: cfg.spreadsheetId, fetchImpl});
      const employees = (await pool.query('SELECT id, payload FROM hr_employees')).rows.map((r) => ({id: r.id, ...r.payload}));
      const empValues = tabs[EMPLOYEE_TAB] || [];
      const sheetRows = empValues.length ? parseEmployeeTab(empValues).rows : [];
      const empPlan = empValues.length ? planEmployeeSync({sheetRows, employees}) : {changes: [], flags: []};
      const salPlan = {writes: [], flags: [], months: []};
      const salaryError = '';
      const salaryApplied = 0;
      let employeeApplied = 0;
      if (!dryRun) employeeApplied = await applyEmployeeChanges(empPlan.changes, 'sheet-sync:' + actor);
      const nc = sheetRows.length ? await newcomers.run({sheetRows, empValues, payValues: tabs[PAY_TAB] || [], dryRun, actor: 'sheet-sync:' + actor})
        : {created: [], planned: [], flags: [], skipped: {}};
      const handled = new Set(nc.planned.map((x) => x.employeeId));
      empPlan.flags = empPlan.flags.filter((f) => !(f.type === 'sheet-only' && handled.has(String(f.employeeId).toUpperCase())));
      const summary = {
        newcomersCreated: nc.created, newcomersPlanned: nc.planned, newcomersSkipped: nc.skipped,
        employeeRows: empValues.length ? empValues.length - 1 : 0,
        employeeChanges: empPlan.changes,
        salaryWrites: salPlan.writes.map(({notes, ...w}) => w),
        salaryMonths: salPlan.months,
        flags: [...empPlan.flags, ...nc.flags, ...salPlan.flags],
        employeeApplied, salaryApplied, salaryError,
      };
      await pool.query('UPDATE hr_sheet_sync_log SET finished_at=now(), ok=true, summary=$1::jsonb WHERE id=$2', [JSON.stringify(summary), logId]);
      await prune();
      return {id: Number(logId), ok: true, dryRun, trigger, ...summary};
    } catch (e) {
      const msg = String(e.message || e).slice(0, 500);
      await pool.query('UPDATE hr_sheet_sync_log SET finished_at=now(), ok=false, error=$1 WHERE id=$2', [msg, logId]);
      await prune();
      e.status = e.status || 502;
      throw e;
    }
  }

  async function prune() {
    await pool.query('DELETE FROM hr_sheet_sync_log WHERE id NOT IN (SELECT id FROM hr_sheet_sync_log ORDER BY id DESC LIMIT ' + LOG_KEEP + ')');
  }

  async function run(opts = {}) {
    if (running) {
      const err = new Error('同步正在進行中，請稍候再試');
      err.status = 409;
      throw err;
    }
    running = runOnce(opts);
    try { return await running; } finally { running = null; }
  }

  async function logs(limit = 20) {
    await ensure();
    const r = await pool.query('SELECT * FROM hr_sheet_sync_log ORDER BY id DESC LIMIT $1', [Math.min(Math.max(1, limit), 100)]);
    return r.rows.map((x) => ({
      id: Number(x.id), startedAt: x.started_at, finishedAt: x.finished_at, trigger: x.trigger, actor: x.actor,
      dryRun: x.dry_run, ok: x.ok, error: x.error, summary: x.summary,
    }));
  }

  async function status() {
    const s = await statusImpl();
    const recent = await logs(20);
    return {
      configured: s.configured, source: s.source, clientEmail: s.clientEmail, instructions: s.instructions,
      intervalMinutes: syncIntervalMinutes(), running: Boolean(running),
      last: recent[0] || null,
      lastSuccess: recent.find((l) => l.ok && !l.dryRun) || null,
      logs: recent.map(({summary, ...l}) => ({...l, counts: countsOf(summary)})),
      flagLabels: FLAG_LABELS,
      goLive: goLiveDate(env),
      pendingNewcomers: await newcomers.pending(),
      ignoreIds: await newcomers.ignoreIds(),
    };
  }

  function start({intervalMinutes = syncIntervalMinutes(), firstDelayMs = 120000, logger = console} = {}) {
    if (!intervalMinutes || timer) return false;
    const tick = async () => {
      try {
        const s = await statusImpl();
        if (!s.configured) return;
        const r = await run({trigger: 'schedule', actor: 'system'});
        if (r.newcomersCreated?.length) logger.log('HR sheet sync created ' + r.newcomersCreated.length + ' sheet-only employees (pending review)');
        if (r.employeeApplied || r.salaryApplied) logger.log('HR sheet sync applied ' + r.employeeApplied + ' employee fields, ' + r.salaryApplied + ' salary rows');
      } catch (e) {
        if (e.status !== 409) logger.error('HR sheet sync failed:', String(e.message || e.name).slice(0, 200));
      }
    };
    setTimeout(() => void tick(), firstDelayMs).unref?.();
    timer = setInterval(() => void tick(), intervalMinutes * 60000);
    timer.unref?.();
    return true;
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }

  return {ensure, run, logs, status, start, stop};
}

export function countsOf(summary = {}) {
  return {
    employeeChanges: (summary.employeeChanges || []).length,
    salaryWrites: (summary.salaryWrites || []).length,
    flags: (summary.flags || []).length,
    employeeApplied: summary.employeeApplied || 0,
    salaryApplied: summary.salaryApplied || 0,
    newcomersCreated: (summary.newcomersCreated || []).length,
  };
}
