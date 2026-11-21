// companybrain → payroll sheet, for new hires converted in companybrain only.
// - On 「報到並轉為員工」: append one row to 員工資料 and one to 薪資設定 with whatever is known (blanks allowed).
// - Periodically: for rows companybrain created (tracked in hr_sheet_rows), fill BLANK cells from newer
//   companybrain data, and flip 匯款類型 現金 → 匯款 once a passbook is on file, but only while the cell still
//   holds the value companybrain wrote. Never touches pre-existing rows or non-blank cells a person edited.
// - Pay fields in 薪資設定 (底薪/時薪, 加班費率, 勞健保, 每日扣除休息, 津貼…) are copied from the sheet's own
//   「部門預設值」 tab, read live at write time and matched by 部門+職稱. Only blank pay cells on rows
//   companybrain created are filled, each pay cell at most once. No match → identity only + a note.
//   The 部門預設值 tab and the sheet's script are never modified.
import {baiqiSalaryId, baiqiSalaryColumnKey, importStatus} from './hr-salary-import.mjs';
import {fetchSheetTabs, appendSheetRow, updateSheetCell} from './google-sa.mjs';
import {normName} from './hr-sheet-sync.mjs';
import {partTimeJobFor, PART_TIME_PROFILE} from './hr-ids.mjs';

export const EMP_TAB = '員工資料';
export const PAY_TAB = '薪資設定';
export const DEFAULTS_TAB = '部門預設值';
const KNOWN_IDS_KEY = 'sheetKnownIds';

// field → header aliases (matched with baiqiSalaryColumnKey, so 部門/員工部門, 計薪型態/薪資類型, 姓名/員工姓名 are equal)
const EMP_COLS = {
  id: ['員工編號'], name: ['姓名'], department: ['部門'], payType: ['計薪型態'],
  arrivalDate: ['到職日', '到職日期', '入職日'], job: ['職稱'],
};
const PAY_COLS = {
  id: ['員工編號'], name: ['姓名'], department: ['部門'], payType: ['計薪型態'], job: ['職稱'], remittance: ['匯款類型'],
};
// Fields filled later when blank (id/name are written once and only checked).
export const FILLABLE = {[EMP_TAB]: ['department', 'payType', 'arrivalDate', 'job'], [PAY_TAB]: ['department', 'payType', 'job', 'remittance']};

export function writeEnabled(env = process.env) {
  return !['0', 'false', 'off', 'no'].includes(String(env.HR_SHEET_WRITE ?? '').trim().toLowerCase());
}

export function colLetter(i) {
  let n = i + 1, s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

export function columnIndex(headers, cols) {
  const keys = (headers || []).map((h) => baiqiSalaryColumnKey(h));
  const out = {};
  for (const [field, names] of Object.entries(cols)) {
    out[field] = -1;
    for (const n of names) { const i = keys.indexOf(baiqiSalaryColumnKey(n)); if (i >= 0) { out[field] = i; break; } }
  }
  return out;
}

/** Text cells: keep literal (no formulas, keep leading zeros). Dates: yyyy/mm/dd so the sheet stores a real date. */
export function cellText(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^[=+\-@]/.test(s) || /^\d+$/.test(s)) return "'" + s;
  return s;
}
export function cellDate(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? m[1] + '/' + m[2] + '/' + m[3] : '';
}

/** Values companybrain wants in the sheet for this employee (sheet wording). */
export function desiredValues(emp, {hasBank = false} = {}) {
  const payType = ['正職', '兼職'].includes(emp.payType) ? emp.payType : (['兼職', '時薪'].includes(emp.employmentType) ? '兼職' : (emp.employmentType === '正職' ? '正職' : ''));
  const raw = String(emp.department || '').trim();
  const dept = raw === '洗滓' ? '洗滌' : raw === '行政' ? '辦公室' : raw;
  const job = String(emp.job || '').trim();
  return {
    id: String(emp.id || '').trim(),
    name: String(emp.name || '').trim(),
    // Real 部門 for everyone (洗滓 typo → 洗滌; 行政 → 辦公室). Part-timers keep the sheet's convention of the
    // department's default 職稱 (摺疊/撐開 現場作業員, 洗滌 洗滌人員, 辦公室 行政); their pay uses 部門預設值 兼職／兼職.
    department: dept,
    payType,
    arrivalDate: cellDate(emp.arrivalDate),
    job: payType === '兼職' && (!job || job === '兼職') ? partTimeJobFor(dept) : job,
    remittance: hasBank ? '匯款' : '現金',
  };
}

function toCell(field, value) {
  if (field === 'arrivalDate') return value;
  if (String(field).startsWith('pay:') && /^-?\d+(\.\d+)?$/.test(String(value).trim())) return String(value).trim(); // numbers stay numbers
  return cellText(value);
}

/**
 * Pay defaults for one 部門+職稱 from the sheet's 部門預設值 tab: {header: value} for non-blank cells,
 * or null when no row matches. Pure.
 */
export function defaultsFor(values, department, job) {
  if (!values?.length || !department || !job) return null;
  const head = values[0].map((h) => String(h ?? '').trim());
  const di = head.indexOf('部門'), ji = head.indexOf('職稱');
  if (di < 0 || ji < 0) return null;
  const norm = (v) => { const d = String(v ?? '').trim(); return d === '洗滓' ? '洗滌' : d; };
  const hit = values.slice(1).find((r) => norm(r[di]) === norm(department) && String(r[ji] ?? '').trim() === String(job).trim());
  if (!hit) return null;
  const out = {};
  head.forEach((h, i) => { if (i === di || i === ji || !h) return; const v = String(hit[i] ?? '').trim(); if (v) out[h] = v; });
  return out;
}

/** Which 部門預設值 row prices this person: 兼職／兼職 for every part-timer (時薪, not split by 部門). */
export function payProfileFor({department, job, payType}) {
  return payType === '兼職' ? PART_TIME_PROFILE : [department, job];
}

/** Map pay-default headers to 薪資設定 column indexes (header text compared like the payroll importer). */
function payColumns(headers, defaults) {
  const keys = (headers || []).map((h) => baiqiSalaryColumnKey(h));
  const out = [];
  for (const [h, v] of Object.entries(defaults || {})) {
    const i = keys.indexOf(baiqiSalaryColumnKey(h));
    if (i >= 0) out.push({header: h, i, value: v});
  }
  return out;
}

export function buildRow(headers, cols, values) {
  const idx = columnIndex(headers, cols);
  if (idx.id < 0) throw new Error('「' + (cols === EMP_COLS ? EMP_TAB : PAY_TAB) + '」找不到「員工編號」欄');
  const width = Math.max(headers.length, ...Object.values(idx).map((i) => i + 1));
  const row = Array(width).fill('');
  const written = {};
  for (const [field, i] of Object.entries(idx)) {
    if (i < 0 || values[field] === undefined) continue;
    row[i] = toCell(field, values[field]);
    written[field] = values[field];
  }
  return {row, written};
}

/** Rows whose 員工編號 or 姓名 already exist → conflict (write nothing). */
export function findConflicts(tabs, {id, name}) {
  const key = baiqiSalaryId(id), nm = normName(name);
  const hits = [];
  for (const [tab, cols] of [[EMP_TAB, EMP_COLS], [PAY_TAB, PAY_COLS]]) {
    const values = tabs[tab] || [];
    if (!values.length) continue;
    const idx = columnIndex(values[0], cols);
    values.slice(1).forEach((r, i) => {
      const rid = idx.id >= 0 ? String(r[idx.id] ?? '').trim() : '';
      const rname = idx.name >= 0 ? String(r[idx.name] ?? '').trim() : '';
      if (rid && baiqiSalaryId(rid) === key) hits.push({tab, row: i + 2, reason: 'id', value: rid});
      else if (nm && rname && normName(rname) === nm) hits.push({tab, row: i + 2, reason: 'name', value: rname + (rid ? '（' + rid + '）' : '（無編號）')});
    });
  }
  return hits;
}

/** Plan blank-cell fills for a row companybrain owns. Pure. */
export function planFill({tab, values, owned, desired, defaultsValues}) {
  const cols = tab === EMP_TAB ? EMP_COLS : PAY_COLS;
  if (!values?.length) return {error: '分頁是空的'};
  const idx = columnIndex(values[0], cols);
  const key = baiqiSalaryId(owned.sheetId);
  if (!key) return {error: '沒有編號，不會自動修改'};
  const rows = values.slice(1).map((r, i) => ({r, n: i + 2})).filter(({r}) => baiqiSalaryId(r[idx.id]) === key);
  if (!rows.length) return {error: '試算表上找不到這列（可能被刪除或改編號），不會重建'};
  if (rows.length > 1) return {error: '試算表上這個編號有 ' + rows.length + ' 列，不會自動修改'};
  const {r, n} = rows[0];
  const sheetName = idx.name >= 0 ? String(r[idx.name] ?? '').trim() : '';
  if (sheetName && normName(sheetName) !== normName(owned.name)) return {error: '試算表上姓名已改為「' + sheetName + '」，不會自動修改'};
  const last = (owned.cells || {})[tab] || {};
  const writes = [];
  for (const field of FILLABLE[tab]) {
    const i = idx[field];
    if (i === undefined || i < 0) continue;
    const want = desired[field];
    if (!want) continue;
    const cur = String(r[i] ?? '').trim();
    if (cur === want) continue;
    const blank = cur === '';
    // 匯款類型 may move 現金 → 匯款 only while the cell still holds what companybrain wrote.
    const ourOld = field === 'remittance' && cur === '現金' && want === '匯款' && last.remittance === '現金';
    if (blank || ourOld) writes.push({field, cell: colLetter(i) + n, value: want, from: cur});
  }
  let payNote = '';
  if (tab === PAY_TAB && defaultsValues) {
    // Use what the row will say after this fill; a person's 部門/職稱 edit wins.
    const eff = (field) => { const w = writes.find((x) => x.field === field); return w ? w.value : String(r[idx[field]] ?? '').trim(); };
    const [dept, job] = payProfileFor({department: eff('department'), job: eff('job'), payType: eff('payType')});
    const defs = defaultsFor(defaultsValues, dept, job);
    if (!defs) payNote = dept && job ? '部門預設值沒有「' + dept + '／' + job + '」，薪資欄未自動帶入' : '部門或職稱未填，薪資欄未自動帶入';
    else {
      const done = last.__pay || {};
      for (const {header, i, value} of payColumns(values[0], defs)) {
        if (Object.prototype.hasOwnProperty.call(done, header)) continue; // each pay cell at most once
        if (String(r[i] ?? '').trim() !== '') continue; // never overwrite
        writes.push({field: 'pay:' + header, header, cell: colLetter(i) + n, value, from: ''});
      }
    }
  }
  return {row: n, writes, payNote};
}

export const SHEET_ROWS_SCHEMA = `
CREATE TABLE IF NOT EXISTS hr_sheet_rows (
  employee_id text PRIMARY KEY,
  sheet_id text NOT NULL,
  name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  error text NOT NULL DEFAULT '',
  cells jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hr_sheet_write_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  employee_id text NOT NULL,
  action text NOT NULL,
  tab text NOT NULL DEFAULT '',
  cell text NOT NULL DEFAULT '',
  value text NOT NULL DEFAULT '',
  ok boolean NOT NULL DEFAULT true,
  error text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS hr_sheet_write_log_emp ON hr_sheet_write_log(employee_id, id);
`;

export const STATUS_LABEL = {
  pending: '待寫入試算表', written: '已寫入試算表', failed: '未寫入試算表', conflict: '未寫入試算表（試算表已有相同編號或姓名）',
  attention: '已寫入，但自動補欄暫停',
};

export function createSheetWriter({hr, fetchImpl, loadTabs, append, update, statusImpl = importStatus, env = process.env} = {}) {
  const pool = hr.pool;
  let ensured = false;
  let chain = Promise.resolve();
  let timer = null;
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  async function ensure() {
    if (ensured) return;
    await pool.query(SHEET_ROWS_SCHEMA);
    ensured = true;
  }
  async function spreadsheetId() { return (await hr.getSalaryImport()).spreadsheetId; }
  async function readTabs() {
    const sid = await spreadsheetId();
    const tabs = loadTabs ? await loadTabs({spreadsheetId: sid}) : await fetchSheetTabs({spreadsheetId: sid, tabs: [EMP_TAB, PAY_TAB, DEFAULTS_TAB], fetchImpl});
    await rememberIds(tabs);
    return {sid, tabs};
  }
  async function doAppend(args) { return append ? append(args) : appendSheetRow({...args, fetchImpl}); }
  async function doUpdate(args) { return update ? update(args) : updateSheetCell({...args, fetchImpl}); }

  async function rememberIds(tabs) {
    const ids = new Set();
    for (const [tab, cols] of [[EMP_TAB, EMP_COLS], [PAY_TAB, PAY_COLS]]) {
      const v = tabs[tab] || [];
      if (!v.length) continue;
      const i = columnIndex(v[0], cols).id;
      if (i < 0) continue;
      for (const r of v.slice(1)) { const id = String(r[i] ?? '').trim().toUpperCase(); if (id) ids.add(id); }
    }
    if (!ids.size) return;
    const cur = await knownIds();
    for (const id of cur) ids.add(id);
    await hr.setSetting(KNOWN_IDS_KEY, [...ids].sort());
  }
  async function knownIds() {
    const r = await pool.query('SELECT value FROM hr_settings WHERE key=$1', [KNOWN_IDS_KEY]);
    return Array.isArray(r.rows[0]?.value) ? r.rows[0].value : [];
  }

  /**
   * IDs on the sheet for numbering. strict (轉員工): must read the live sheet or throw — no fallback, because the
   * office adds people (e.g. foreign workers) straight into the sheet. Non-strict: last seen list on failure.
   */
  async function idsForNumbering({strict = false} = {}) {
    if (strict && !writeEnabled(env)) return knownIds(); // HR_SHEET_WRITE=off (dev/tests): sheet is out of the loop
    if (writeEnabled(env) && (await statusImpl()).configured) {
      try { await readTabs(); } catch (e) {
        if (strict) throw sheetUnreadable(e);
      }
    } else if (strict) throw sheetUnreadable(new Error('尚未設定 Google 服務帳戶'));
    return knownIds();
  }
  function sheetUnreadable(e) {
    const err = new Error('讀不到打卡算薪水試算表，暫時不能轉員工（避免員工編號和試算表重複）。請稍後再試或檢查服務帳戶權限。（' + String(e.message || e).slice(0, 120) + '）');
    err.status = 503;
    return err;
  }

  async function log(employeeId, action, {tab = '', cell = '', value = '', ok = true, error = ''} = {}) {
    await pool.query('INSERT INTO hr_sheet_write_log(employee_id, action, tab, cell, value, ok, error) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [employeeId, action, tab, cell, String(value).slice(0, 200), ok, String(error).slice(0, 500)]);
  }
  async function getRow(employeeId) {
    const r = await pool.query('SELECT * FROM hr_sheet_rows WHERE employee_id=$1', [employeeId]);
    return r.rows[0] || null;
  }
  async function saveRow(row) {
    await pool.query(
      `INSERT INTO hr_sheet_rows(employee_id, sheet_id, name, status, error, cells, attempts, updated_at)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,now())
       ON CONFLICT(employee_id) DO UPDATE SET sheet_id=excluded.sheet_id, name=excluded.name, status=excluded.status,
         error=excluded.error, cells=excluded.cells, attempts=excluded.attempts, updated_at=now()`,
      [row.employee_id, row.sheet_id, row.name, row.status, row.error || '', JSON.stringify(row.cells || {}), row.attempts || 0]
    );
  }
  async function employeeAndBank(employeeId) {
    const emp = await hr.getEmployee(employeeId);
    const p = (await pool.query('SELECT account_enc, account_last4 FROM hr_employee_pii WHERE employee_id=$1', [employeeId])).rows[0];
    return {emp, hasBank: Boolean(p && (p.account_enc || p.account_last4))};
  }

  /** Append the two rows for a newly converted employee. Never throws (failures are recorded for retry). */
  async function writeNew(employeeId, actor = 'system') {
    return serial(async () => {
      await ensure();
      let row = await getRow(employeeId);
      const {emp, hasBank} = await employeeAndBank(employeeId);
      if (!row) {
        row = {employee_id: emp.id, sheet_id: emp.id, name: emp.name, status: 'pending', cells: {}, attempts: 0};
        await saveRow(row);
      }
      if (row.status === 'written' || row.status === 'attention') return publicRow(row);
      row.attempts = (row.attempts || 0) + 1;
      try {
        if (!writeEnabled(env)) throw new Error('已關閉寫入試算表（HR_SHEET_WRITE）');
        if (!(await statusImpl()).configured) throw new Error('尚未設定 Google 服務帳戶');
        const {sid, tabs} = await readTabs();
        const cells = row.cells || {};
        const pending = [[EMP_TAB, EMP_COLS], [PAY_TAB, PAY_COLS]].filter(([tab]) => !cells[tab]?.__row);
        // Conflicts only matter for tabs not yet written by us.
        const conflicts = findConflicts(Object.fromEntries(pending.map(([t]) => [t, tabs[t]])), {id: row.sheet_id, name: row.name});
        if (conflicts.length) {
          row.status = 'conflict';
          row.error = conflicts.slice(0, 4).map((c) => c.tab + ' 第' + c.row + '列已有' + (c.reason === 'id' ? '編號 ' : '姓名 ') + c.value).join('；');
          await saveRow(row);
          await log(employeeId, 'conflict', {ok: false, error: row.error});
          await hr.audit(pool, actor, '試算表寫入暫停（重複）', employeeId, row.error);
          return publicRow(row);
        }
        const want = desiredValues({...emp, id: row.sheet_id}, {hasBank});
        let payNote = '';
        for (const [tab, cols] of pending) {
          const values = tabs[tab];
          if (!values?.length) throw new Error('找不到「' + tab + '」表頭');
          const {row: line, written} = buildRow(values[0], cols, tab === EMP_TAB
            ? {id: want.id, name: want.name, department: want.department, payType: want.payType, arrivalDate: want.arrivalDate, job: want.job}
            : {id: want.id, name: want.name, department: want.department, payType: want.payType, job: want.job, remittance: want.remittance});
          let payWritten = null;
          if (tab === PAY_TAB) {
            const [pd, pj] = payProfileFor(want);
            const defs = defaultsFor(tabs[DEFAULTS_TAB], pd, pj);
            if (defs) {
              payWritten = {};
              for (const {header, i, value} of payColumns(values[0], defs)) {
                while (line.length <= i) line.push('');
                if (line[i] === '') { line[i] = toCell('pay:' + header, value); payWritten[header] = value; }
              }
            } else payNote = pd && pj ? '部門預設值沒有「' + pd + '／' + pj + '」，薪資欄未自動帶入' : '部門或職稱未填，薪資欄未自動帶入';
          }
          const range = await doAppend({spreadsheetId: sid, tab, row: line});
          const rowNo = Number(String(range).match(/![A-Z]+(\d+)/)?.[1] || 0) || null;
          cells[tab] = {...written, __row: rowNo || true, ...(payWritten ? {__pay: payWritten} : {})};
          row.cells = cells;
          await saveRow(row);
          await log(employeeId, 'append', {tab, cell: range, value: Object.entries(written).filter(([, v]) => v).map(([k, v]) => k + '=' + v).join(' ') + (payWritten ? ' 薪資欄' + Object.keys(payWritten).length + '項' : '')});
        }
        row.status = 'written';
        row.error = payNote;
        await saveRow(row);
        await hr.audit(pool, actor, '新員工寫入試算表', employeeId, EMP_TAB + '、' + PAY_TAB + ' 各新增一列');
      } catch (e) {
        row.status = 'failed';
        row.error = String(e.message || e).slice(0, 300);
        await saveRow(row);
        await log(employeeId, 'append', {ok: false, error: row.error});
      }
      return publicRow(row);
    });
  }

  /** Fill blank cells / 匯款類型 on rows companybrain created. */
  async function fillOwned({employeeId, actor = 'system'} = {}) {
    return serial(async () => {
      await ensure();
      if (!writeEnabled(env) || !(await statusImpl()).configured) return {skipped: true, writes: 0};
      const owned = (await pool.query(
        employeeId ? "SELECT * FROM hr_sheet_rows WHERE employee_id=$1 AND status IN ('written','attention')" : "SELECT * FROM hr_sheet_rows WHERE status IN ('written','attention')",
        employeeId ? [employeeId] : []
      )).rows;
      if (!owned.length) return {writes: 0};
      const {sid, tabs} = await readTabs();
      let count = 0;
      for (const row of owned) {
        let emp, hasBank;
        try { ({emp, hasBank} = await employeeAndBank(row.employee_id)); } catch { continue; }
        const desired = desiredValues({...emp, id: row.sheet_id}, {hasBank});
        const problems = [], notes = [];
        for (const tab of [EMP_TAB, PAY_TAB]) {
          const plan = planFill({tab, values: tabs[tab], owned: {sheetId: row.sheet_id, name: row.name, cells: row.cells}, desired, defaultsValues: tabs[DEFAULTS_TAB]});
          if (plan.error) { problems.push(tab + '：' + plan.error); continue; }
          if (plan.payNote) notes.push(plan.payNote);
          for (const w of plan.writes) {
            try {
              await doUpdate({spreadsheetId: sid, tab, cell: w.cell, value: toCell(w.field, w.value)});
              const prev = row.cells?.[tab] || {};
              row.cells = {...row.cells, [tab]: w.header ? {...prev, __pay: {...(prev.__pay || {}), [w.header]: w.value}} : {...prev, [w.field]: w.value}};
              count += 1;
              await log(row.employee_id, 'fill', {tab, cell: w.cell, value: w.field + '=' + w.value + (w.from ? '（原 ' + w.from + '）' : '')});
              await hr.audit(pool, actor, '試算表補欄', row.employee_id, tab + ' ' + w.cell + ' ' + w.field + '=' + w.value);
            } catch (e) {
              problems.push(tab + ' ' + w.cell + '：' + (e.message || e));
              await log(row.employee_id, 'fill', {tab, cell: w.cell, ok: false, error: e.message || String(e)});
            }
          }
        }
        row.status = problems.length ? 'attention' : 'written';
        row.error = [...problems, ...notes].join('；').slice(0, 500);
        await saveRow(row);
      }
      return {writes: count};
    });
  }

  /** Periodic job: retry failed appends, then fill owned rows. */
  async function tick(actor = 'system') {
    await ensure();
    if (!writeEnabled(env) || !(await statusImpl()).configured) return {skipped: true};
    const retry = (await pool.query("SELECT employee_id FROM hr_sheet_rows WHERE status IN ('pending','failed') AND attempts < 48")).rows;
    for (const r of retry) await writeNew(r.employee_id, actor);
    return fillOwned({actor});
  }

  /** Manual 重試 from the profile: conflict/failed → try append again; written → fill now. */
  async function retry(employeeId, actor) {
    await ensure();
    const row = await getRow(employeeId);
    if (!row) return writeNew(employeeId, actor);
    if (row.status === 'written' || row.status === 'attention') { await fillOwned({employeeId, actor}); return publicRow(await getRow(employeeId)); }
    await pool.query("UPDATE hr_sheet_rows SET status='pending', attempts=0 WHERE employee_id=$1", [employeeId]);
    return writeNew(employeeId, actor);
  }

  async function forEmployee(employeeId) {
    await ensure();
    const row = await getRow(employeeId);
    if (!row) return null;
    const logs = (await pool.query('SELECT at, action, tab, cell, value, ok, error FROM hr_sheet_write_log WHERE employee_id=$1 ORDER BY id DESC LIMIT 20', [employeeId])).rows;
    return {...publicRow(row), logs};
  }

  function start({intervalMinutes = 60, firstDelayMs = 180000, logger = console} = {}) {
    if (!intervalMinutes || timer) return false;
    const run = async () => {
      try { const r = await tick(); if (r.writes) logger.log('HR sheet write filled ' + r.writes + ' cells'); }
      catch (e) { logger.error('HR sheet write failed:', String(e.message || e.name).slice(0, 200)); }
    };
    setTimeout(() => void run(), firstDelayMs).unref?.();
    timer = setInterval(() => void run(), intervalMinutes * 60000);
    timer.unref?.();
    return true;
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return {ensure, writeNew, fillOwned, tick, retry, forEmployee, idsForNumbering, knownIds, start, stop};
}

function publicRow(row) {
  if (!row) return null;
  const cells = row.cells || {};
  return {
    employeeId: row.employee_id, sheetId: row.sheet_id, status: row.status, label: STATUS_LABEL[row.status] || row.status,
    error: row.error || '', attempts: row.attempts || 0,
    rows: {[EMP_TAB]: cells[EMP_TAB]?.__row || null, [PAY_TAB]: cells[PAY_TAB]?.__row || null},
    updatedAt: row.updated_at || null,
  };
}
