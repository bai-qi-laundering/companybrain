import {randomBytes} from 'node:crypto';
import {AppError} from './domain.mjs';
import {yearsForEmployee, decorateYear, defaultSettlement, SETTLEMENTS, DEFAULT_BASIS, endingSoon} from './hr-leave.mjs';
import {DEFAULT_DEPT_PREFIXES, nextPrefixedId, prefixForDepartment, isUsableEmployeeId, PAY_TYPES, PAYMENT_METHODS} from './hr-ids.mjs';

export const DOC_TYPES = {identity: '身分證', bank: '存摺', license: '駕照'};
export const STATUSES = ['待聯絡', '待面試', '待回覆', '錄取', '待報到', '已報到', '未錄取', '放棄'];
export const OPEN_STATUSES = ['待聯絡', '待面試', '待回覆', '錄取', '待報到'];
export const EMP_FIELDS = ['name', 'department', 'job', 'employmentType', 'payType', 'paymentMethod', 'arrivalDate', 'departureDate', 'phone', 'emergencyContact', 'paperLocation', 'notes', 'lineBound', 'lineId'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hr_employees (
  id text PRIMARY KEY,
  payload jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hr_records (
  id text PRIMARY KEY,
  employee_id text NOT NULL REFERENCES hr_employees(id),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hr_documents (
  id text PRIMARY KEY,
  category text NOT NULL,
  relative_path text NOT NULL,
  filename text NOT NULL,
  size bigint NOT NULL,
  mtime bigint NOT NULL,
  available boolean NOT NULL DEFAULT true,
  employee_id text REFERENCES hr_employees(id),
  suggestions jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_on date,
  UNIQUE(category, relative_path)
);
CREATE TABLE IF NOT EXISTS hr_candidates (
  id text PRIMARY KEY,
  payload jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hr_recruitment_events (
  id text PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES hr_candidates(id),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hr_recruitment_import_rows (
  id text PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES hr_candidates(id),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hr_recruitment_goals (
  department text PRIMARY KEY,
  payload jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS hr_leave_import_rows (
  id text PRIMARY KEY,
  employee_id text REFERENCES hr_employees(id),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hr_salaries (
  id text PRIMARY KEY,
  employee_id text NOT NULL REFERENCES hr_employees(id),
  month text NOT NULL,
  digest text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(employee_id, month, digest)
);
CREATE TABLE IF NOT EXISTS hr_attendance (
  id text PRIMARY KEY,
  employee_id text NOT NULL REFERENCES hr_employees(id),
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS hr_audit (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  detail text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS hr_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS hr_leave_years (
  id text PRIMARY KEY,
  employee_id text NOT NULL REFERENCES hr_employees(id),
  year_key text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  statutory numeric NOT NULL,
  entitled numeric NOT NULL,
  entitled_source text NOT NULL DEFAULT 'statutory',
  carried_in numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT '未結算',
  settled_on date,
  settled_by text,
  notes text NOT NULL DEFAULT '',
  UNIQUE(employee_id, year_key)
);
CREATE TABLE IF NOT EXISTS hr_leave_entries (
  id text PRIMARY KEY,
  employee_id text NOT NULL REFERENCES hr_employees(id),
  leave_year_id text NOT NULL REFERENCES hr_leave_years(id),
  taken_on date NOT NULL,
  days numeric NOT NULL,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hr_leave_years_emp ON hr_leave_years(employee_id, starts_on);
CREATE INDEX IF NOT EXISTS hr_leave_entries_year ON hr_leave_entries(leave_year_id);
CREATE TABLE IF NOT EXISTS hr_meta (
  id integer PRIMARY KEY CHECK (id = 1),
  employee_seq integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS hr_records_emp ON hr_records(employee_id, kind);
CREATE INDEX IF NOT EXISTS hr_docs_emp ON hr_documents(employee_id);
CREATE INDEX IF NOT EXISTS hr_events_cand ON hr_recruitment_events(candidate_id);
`;

function today() {
  return new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
}
function nowIso() {
  return new Date().toISOString();
}
function newId(prefix) {
  return prefix + randomBytes(6).toString('hex');
}
function active(emp, day = today()) {
  const a = emp.arrivalDate, d = emp.departureDate;
  return (!a || a <= day) && (!d || d >= day);
}

export class HrStore {
  constructor(pool) { this.pool = pool; }

  async ensure() {
    await this.pool.query(SCHEMA);
    await this.pool.query('INSERT INTO hr_meta(id, employee_seq) VALUES(1, 1) ON CONFLICT DO NOTHING');
    await this.setSettingIfAbsent('leaveYearBasis', 'anniversary');
    await this.setSettingIfAbsent('leaveSettleDefault', '未休完已折現');
    await this.setSettingIfAbsent('deptPrefixes', DEFAULT_DEPT_PREFIXES);
  }

  async audit(client, actor, action, target, detail = '') {
    await (client || this.pool).query(
      'INSERT INTO hr_audit(actor, action, target, detail) VALUES($1,$2,$3,$4)',
      [actor, action, target, String(detail || '').slice(0, 2000)]
    );
  }

  async state() {
    const [employees, records, documents, candidates, events, goals, leaveExcel, salaries, attendance, audit, settings, lastImport, leaveYears, leaveEntries] = await Promise.all([
      this.pool.query('SELECT id, payload, revision FROM hr_employees ORDER BY id'),
      this.pool.query('SELECT id, employee_id, kind, payload, created_at FROM hr_records ORDER BY created_at DESC, id'),
      this.pool.query('SELECT * FROM hr_documents ORDER BY category, filename'),
      this.pool.query('SELECT id, payload, revision FROM hr_candidates ORDER BY id'),
      this.pool.query('SELECT * FROM hr_recruitment_events ORDER BY created_at DESC, id DESC'),
      this.pool.query('SELECT department, payload, revision FROM hr_recruitment_goals ORDER BY department'),
      this.pool.query('SELECT id, employee_id, payload, created_at FROM hr_leave_import_rows ORDER BY created_at DESC, id'),
      this.pool.query('SELECT id, employee_id, month, version, status, payload FROM hr_salaries ORDER BY month DESC'),
      this.pool.query('SELECT id, employee_id, payload FROM hr_attendance'),
      this.pool.query('SELECT created_at, actor, action, target, detail FROM hr_audit ORDER BY id DESC LIMIT 200'),
      this.pool.query('SELECT key, value FROM hr_settings'),
      this.pool.query("SELECT value FROM hr_settings WHERE key='lastImport'"),
      this.pool.query('SELECT * FROM hr_leave_years ORDER BY starts_on DESC, id'),
      this.pool.query('SELECT * FROM hr_leave_entries ORDER BY taken_on DESC, id'),
    ]);
    const mapEmp = (r) => ({id: r.id, revision: r.revision, ...r.payload});
    const result = {
      employees: employees.rows.map(mapEmp),
      records: records.rows.map((r) => ({id: r.id, employeeId: r.employee_id, kind: r.kind, created: r.created_at, ...r.payload})),
      documents: documents.rows.map((r) => ({
        id: r.id, category: r.category, relativePath: r.relative_path, filename: r.filename,
        size: Number(r.size), mtime: Number(r.mtime), available: r.available,
        employeeId: r.employee_id, suggestions: r.suggestions || [], expiresOn: r.expires_on,
      })),
      candidates: candidates.rows.map((r) => ({id: r.id, revision: r.revision, ...r.payload})),
      recruitmentEvents: events.rows.map((r) => ({id: r.id, candidateId: r.candidate_id, kind: r.kind, created: r.created_at, ...r.payload})),
      recruitmentGoals: goals.rows.map((r) => this.decorateGoal(r.department, r.payload, employees.rows.map(mapEmp))),
      leaveExcel: leaveExcel.rows.map((r) => ({id: r.id, employeeId: r.employee_id, created: r.created_at, ...r.payload})),
      salaries: salaries.rows.map((r) => ({id: r.id, employeeId: r.employee_id, month: r.month, version: r.version, status: r.status})),
      attendanceCount: attendance.rows.length,
      audit: audit.rows.map((r) => ({created: r.created_at, actor: r.actor, action: r.action, target: r.target, detail: r.detail})),
      settings: Object.fromEntries(settings.rows.map((r) => [r.key, r.value])),
      lastImport: lastImport.rows[0]?.value || null,
      deptPrefixes: { ...DEFAULT_DEPT_PREFIXES, ...((settings.rows.find((r) => r.key === 'deptPrefixes')?.value) || {}) },
      leaveYearBasis: (settings.rows.find((r) => r.key === 'leaveYearBasis')?.value) || DEFAULT_BASIS,
      leaveSettleDefault: (settings.rows.find((r) => r.key === 'leaveSettleDefault')?.value) || '未休完已折現',
      leaveYears: this.decorateYears(leaveYears.rows, leaveEntries.rows),
      leaveEntries: leaveEntries.rows.map((r) => this.mapEntry(r)),
    };
    result.leaveExpiryReminders = endingSoon(result.leaveYears, today(), 60).map((y) => {
      const emp = result.employees.find((e) => e.id === y.employeeId);
      return {employeeId: y.employeeId, name: emp?.name || y.employeeId, endsOn: y.endsOn, remaining: y.remaining, summary: y.summary};
    });
    return result;
  }

  decorateGoal(department, payload, employees, day = today()) {
    const current = employees.filter((e) => e.department === department && active(e, day)).length;
    const baseline = Number(payload.baseline || 0);
    const required = Number(payload.required || 0);
    const net = current - baseline;
    const percent = required ? Math.max(0, Math.min(100, Math.round((net / required) * 100))) : 0;
    return {
      department, ...payload, current, netFilled: net, percent,
      remaining: Math.max(required - net, 0), filled: Math.max(net, 0), asOf: day,
    };
  }

  async deptPrefixes() {
    const r = await this.pool.query("SELECT value FROM hr_settings WHERE key='deptPrefixes'");
    const v = r.rows[0]?.value;
    if (v && typeof v === 'object' && !Array.isArray(v)) return {...DEFAULT_DEPT_PREFIXES, ...v};
    return {...DEFAULT_DEPT_PREFIXES};
  }
  async nextEmployeeId(department, prefix) {
    const map = await this.deptPrefixes();
    const p = String(prefix || prefixForDepartment(department, map) || '').trim().toUpperCase();
    if (!/^[A-Z]{1,3}$/.test(p)) throw new AppError(400, '請選擇部門字首。打卡計薪編號為「部門字母＋流水號」（如物流 D001、摺疊 F113）；洗滓可選 W 或 E。');
    const ids = (await this.pool.query('SELECT id FROM hr_employees')).rows.map((r) => r.id);
    return nextPrefixedId(p, ids);
  }

  async upsertEmployee(id, data, actor, {create} = {}) {
    if (!isUsableEmployeeId(id)) throw new AppError(400, '員工編號限英數字、底線及短橫線');
    id = String(id).trim().toUpperCase();
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const cur = await c.query('SELECT payload, revision FROM hr_employees WHERE id=$1 FOR UPDATE', [id]);
      if (create && cur.rowCount) throw new AppError(409, '員工編號已存在');
      if (!create && !cur.rowCount) throw new AppError(404, '找不到員工');
      const payload = pickEmp(data, cur.rows[0]?.payload || {});
      if (!payload.name) throw new AppError(400, '請填寫姓名');
      const revision = (cur.rows[0]?.revision || 0) + 1;
      await c.query(
        `INSERT INTO hr_employees(id, payload, revision, updated_at) VALUES($1,$2,$3,now())
         ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, revision=excluded.revision, updated_at=now()`,
        [id, payload, revision]
      );
      await this.audit(c, actor, create ? '新增員工' : '更新員工', id, payload.name);
      await c.query('COMMIT');
      return {id, revision, ...payload};
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally { c.release(); }
  }

  async getEmployee(id) {
    const r = await this.pool.query('SELECT id, payload, revision FROM hr_employees WHERE id=$1', [id]);
    if (!r.rowCount) throw new AppError(404, '找不到員工');
    return {id: r.rows[0].id, revision: r.rows[0].revision, ...r.rows[0].payload};
  }

  async upsertCandidate(id, data, actor, {create} = {}) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const cur = await c.query('SELECT payload, revision FROM hr_candidates WHERE id=$1 FOR UPDATE', [id]);
      if (create && cur.rowCount) throw new AppError(409, '應徵者已存在');
      if (!create && !cur.rowCount) throw new AppError(404, '找不到應徵者');
      const prev = cur.rows[0]?.payload || {};
      const merged = {...prev, ...data};
      if (!merged.name || !merged.phone) throw new AppError(400, '請填寫應徵者姓名與電話');
      if (merged.status && !STATUSES.includes(merged.status)) throw new AppError(400, '招募進度不正確');
      if (merged.status === '已報到' && !merged.employeeId && !prev.employeeId) {
        throw new AppError(400, '尚未建立員工檔案，不能標示為已報到。請使用「報到並轉為員工」。');
      }
      const payload = pickCand(merged);
      if (prev.employeeId) {
        payload.employeeId = prev.employeeId;
        payload.status = '已報到';
      }
      const revision = (cur.rows[0]?.revision || 0) + 1;
      await c.query(
        `INSERT INTO hr_candidates(id, payload, revision, created_at, updated_at)
         VALUES($1,$2,$3,now(),now())
         ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, revision=excluded.revision, updated_at=now()`,
        [id, payload, revision]
      );
      await this.audit(c, actor, create ? '新增應徵者' : '更新應徵者', id, payload.name + ' ' + (payload.status || ''));
      await c.query('COMMIT');
      return {id, revision, ...payload};
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally { c.release(); }
  }

  async addEvent(candidateId, kind, data, actor) {
    if (!['phone', 'interview'].includes(kind)) throw new AppError(400, '紀錄種類不正確');
    const cand = await this.pool.query('SELECT payload, revision FROM hr_candidates WHERE id=$1', [candidateId]);
    if (!cand.rowCount) throw new AppError(404, '找不到應徵者');
    const payload = {
      at: data.at || nowIso(),
      outcome: String(data.outcome || '').slice(0, 50),
      contactPerson: String(data.contactPerson || '').slice(0, 80),
      notes: String(data.notes || '').slice(0, 4000),
      nextFollowup: data.nextFollowup || '',
      nextInterviewAt: data.nextInterviewAt || '',
    };
    const evId = data.id || newId('E-');
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('INSERT INTO hr_recruitment_events(id, candidate_id, kind, payload) VALUES($1,$2,$3,$4)', [evId, candidateId, kind, payload]);
      const cur = cand.rows[0].payload;
      let status = cur.status;
      if (payload.outcome === '約定面試') status = '待面試';
      if (payload.outcome === '錄取') status = '錄取';
      if (payload.outcome === '未錄取') status = '未錄取';
      const next = {
        ...cur,
        status: cur.employeeId ? '已報到' : status,
        followupDate: payload.nextFollowup !== undefined && payload.nextFollowup !== '' ? payload.nextFollowup : cur.followupDate,
        interviewAt: payload.nextInterviewAt || cur.interviewAt,
        contactPerson: payload.contactPerson || cur.contactPerson,
      };
      if (payload.outcome === '約定面試' && payload.nextInterviewAt) next.interviewAt = payload.nextInterviewAt;
      await c.query('UPDATE hr_candidates SET payload=$1, revision=revision+1, updated_at=now() WHERE id=$2', [next, candidateId]);
      await this.audit(c, actor, kind === 'phone' ? '新增電話紀錄' : '新增面試紀錄', candidateId, payload.outcome);
      await c.query('COMMIT');
      return {id: evId, candidateId, kind, ...payload};
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally { c.release(); }
  }

  async convert(candidateId, body, actor) {
    const candR = await this.pool.query('SELECT payload, revision FROM hr_candidates WHERE id=$1', [candidateId]);
    if (!candR.rowCount) throw new AppError(404, '找不到應徵者');
    const cand = candR.rows[0].payload;
    if (cand.employeeId) throw new AppError(409, '這位應徵者已轉為員工 ' + cand.employeeId);
    let empId = String(body.employeeId || '').trim().toUpperCase();
    if (!empId) empId = await this.nextEmployeeId(body.department || cand.department, body.prefix);
    if (!isUsableEmployeeId(empId)) throw new AppError(400, '員工編號限英數字、底線及短橫線，既有編號會原樣保留');
    empId = empId.toUpperCase();
    const payload = pickEmp({
      name: cand.name,
      department: body.department || cand.department,
      job: body.job || cand.job,
      employmentType: body.employmentType || '正職',
      payType: body.payType || (body.employmentType === '兼職' || body.employmentType === '時薪' ? '兼職' : '正職'),
      paymentMethod: body.paymentMethod || '匯款',
      lineId: body.lineId || '',
      arrivalDate: body.arrivalDate || cand.availableDate || today(),
      phone: body.phone || cand.phone,
      notes: '由徵人資料轉入；招募歷程保留於徵人頁。',
    });
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const exists = await c.query('SELECT 1 FROM hr_employees WHERE id=$1', [empId]);
      if (exists.rowCount) throw new AppError(409, '員工編號已存在');
      await c.query('INSERT INTO hr_employees(id, payload, revision) VALUES($1,$2,1)', [empId, payload]);
      const nextCand = {...cand, employeeId: empId, status: '已報到', followupDate: '', interviewAt: ''};
      await c.query('UPDATE hr_candidates SET payload=$1, revision=revision+1, updated_at=now() WHERE id=$2', [nextCand, candidateId]);
      await this.audit(c, actor, '報到並轉為員工', candidateId, empId + ' ' + payload.name);
      await c.query('COMMIT');
      return {employee: {id: empId, ...payload}, candidate: {id: candidateId, ...nextCand}};
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally { c.release(); }
  }

  async addRecord(kind, body, actor) {
    if (!['insurance', 'leave', 'change'].includes(kind)) throw new AppError(400, '紀錄種類不正確');
    const employeeId = body.employeeId;
    await this.getEmployee(employeeId);
    const id = body.id || newId('REC-');
    const payload = {...body};
    delete payload.id;
    delete payload.employeeId;
    delete payload.kind;
    await this.pool.query('INSERT INTO hr_records(id, employee_id, kind, payload) VALUES($1,$2,$3,$4)', [id, employeeId, kind, payload]);
    await this.audit(this.pool, actor, '新增' + ({insurance: '保險', leave: '特休', change: '人事異動'}[kind]), employeeId, kind);
    return {id, employeeId, kind, ...payload};
  }

  async upsertGoal(department, data, actor) {
    if (!department) throw new AppError(400, '請選擇部門');
    const cur = await this.pool.query('SELECT payload, revision FROM hr_recruitment_goals WHERE department=$1', [department]);
    const prev = cur.rows[0]?.payload || null;
    const employees = (await this.pool.query('SELECT payload FROM hr_employees')).rows.map((r) => r.payload);
    const baseline = prev ? prev.baseline : employees.filter((e) => e.department === department && active(e)).length;
    const additional = Number(data.additional || data.required || 0);
    if (!Number.isFinite(additional) || additional <= 0) throw new AppError(400, '請填要補足的人數');
    const required = (prev?.required || 0) + additional;
    const history = [...(prev?.history || []), {at: nowIso(), additional, notes: String(data.notes || '').slice(0, 500)}];
    const payload = {baseline, required, history};
    const revision = (cur.rows[0]?.revision || 0) + 1;
    await this.pool.query(
      `INSERT INTO hr_recruitment_goals(department, payload, revision) VALUES($1,$2,$3)
       ON CONFLICT(department) DO UPDATE SET payload=excluded.payload, revision=excluded.revision`,
      [department, payload, revision]
    );
    await this.audit(this.pool, actor, '更新徵人需求', department, '+' + additional);
    return this.decorateGoal(department, payload, (await this.pool.query('SELECT id, payload FROM hr_employees')).rows.map((r) => ({id: r.id, ...r.payload})));
  }

  async insertDocument(row, actor) {
    await this.pool.query(
      `INSERT INTO hr_documents(id, category, relative_path, filename, size, mtime, available, employee_id, suggestions, expires_on)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(category, relative_path) DO UPDATE SET
         filename=excluded.filename, size=excluded.size, mtime=excluded.mtime, available=true,
         employee_id=COALESCE(hr_documents.employee_id, excluded.employee_id),
         suggestions=excluded.suggestions, expires_on=COALESCE(hr_documents.expires_on, excluded.expires_on)`,
      [row.id, row.category, row.relativePath, row.filename, row.size, row.mtime, row.available !== false,
        row.employeeId || null, JSON.stringify(row.suggestions || []), row.expiresOn || null]
    );
    if (actor && row.employeeId) await this.audit(this.pool, actor, '上傳員工文件', row.employeeId, row.category + ' ' + row.filename);
    return row;
  }

  async setDocumentExpiry(id, expiresOn, actor) {
    const r = await this.pool.query('UPDATE hr_documents SET expires_on=$1 WHERE id=$2 RETURNING *', [expiresOn || null, id]);
    if (!r.rowCount) throw new AppError(404, '找不到文件');
    await this.audit(this.pool, actor, '更新證件效期', r.rows[0].employee_id || id, (expiresOn || '') + ' ' + r.rows[0].filename);
    return r.rows[0];
  }

  async bindDocument(id, employeeId, actor) {
    await this.getEmployee(employeeId);
    const r = await this.pool.query('UPDATE hr_documents SET employee_id=$1 WHERE id=$2 RETURNING *', [employeeId, id]);
    if (!r.rowCount) throw new AppError(404, '找不到文件');
    await this.audit(this.pool, actor, '確認文件配對', employeeId, r.rows[0].category + ' ' + r.rows[0].filename);
    return r.rows[0];
  }

  async getDocument(id) {
    const r = await this.pool.query('SELECT * FROM hr_documents WHERE id=$1', [id]);
    if (!r.rowCount) throw new AppError(404, '找不到文件');
    return r.rows[0];
  }

  async markDocumentsUnavailable(category) {
    await this.pool.query('UPDATE hr_documents SET available=false WHERE category=$1', [category]);
  }

  async setSettingIfAbsent(key, value) {
    const json = JSON.stringify(value ?? null);
    await this.pool.query('INSERT INTO hr_settings(key, value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO NOTHING', [key, json]);
  }
  async setSetting(key, value) {
    const json = JSON.stringify(value ?? null);
    await this.pool.query(
      'INSERT INTO hr_settings(key, value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [key, json]
    );
  }

  async insertLeaveRow(id, employeeId, payload) {
    await this.pool.query(
      'INSERT INTO hr_leave_import_rows(id, employee_id, payload) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
      [id, employeeId, payload]
    );
  }
  async leaveRows() {
    return (await this.pool.query('SELECT * FROM hr_leave_import_rows')).rows;
  }
  async bindLeave(id, employeeId, actor) {
    await this.getEmployee(employeeId);
    const r = await this.pool.query('UPDATE hr_leave_import_rows SET employee_id=$1 WHERE id=$2 RETURNING id', [employeeId, id]);
    if (!r.rowCount) throw new AppError(404, '找不到特休來源紀錄');
    await this.audit(this.pool, actor, '配對特休Excel員工', employeeId, id);
  }
  async applyLeaveArrival(id, actor) {
    const row = await this.pool.query('SELECT * FROM hr_leave_import_rows WHERE id=$1', [id]);
    if (!row.rowCount) throw new AppError(404, '找不到特休來源紀錄');
    const payload = row.rows[0].payload;
    const employeeId = row.rows[0].employee_id;
    if (!employeeId) throw new AppError(400, '請先配對員工');
    const emp = await this.getEmployee(employeeId);
    const arrival = payload.arrivalDate;
    if (!arrival) throw new AppError(400, '來源沒有到職日');
    const next = {...pickEmp(emp), arrivalDate: arrival, arrivalDateSource: {type: '特休Excel', at: nowIso()}};
    await this.pool.query('UPDATE hr_employees SET payload=$1, revision=revision+1, updated_at=now() WHERE id=$2', [next, employeeId]);
    await this.audit(this.pool, actor, '由特休Excel帶入到職日', employeeId, (emp.arrivalDate || '') + ' → ' + arrival);
    return {employeeId, arrivalDate: arrival};
  }

  async insertSalary(row) {
    await this.pool.query(
      `INSERT INTO hr_salaries(id, employee_id, month, digest, version, status, payload, created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()))
       ON CONFLICT(employee_id, month, digest) DO NOTHING`,
      [row.id, row.employeeId, row.month, row.digest, row.version, row.status, row.payload, row.created || null]
    );
  }
  async insertAttendance(row) {
    await this.pool.query(
      'INSERT INTO hr_attendance(id, employee_id, payload) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      [row.id, row.employeeId, row.payload]
    );
  }

  async insertImportRow(id, candidateId, payload) {
    await this.pool.query(
      'INSERT INTO hr_recruitment_import_rows(id, candidate_id, payload) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
      [id, candidateId, payload]
    );
  }
  async importRowExists(id) {
    return (await this.pool.query('SELECT 1 FROM hr_recruitment_import_rows WHERE id=$1', [id])).rowCount > 0;
  }

  mapLeaveYear(r) {
    return {
      id: r.id, employeeId: r.employee_id, yearKey: r.year_key,
      startsOn: toDay(r.starts_on), endsOn: toDay(r.ends_on),
      statutory: Number(r.statutory), entitled: Number(r.entitled),
      entitledSource: r.entitled_source, carriedIn: Number(r.carried_in || 0),
      status: r.status, settledOn: toDay(r.settled_on), settledBy: r.settled_by || '',
      notes: r.notes || '',
    };
  }
  mapEntry(r) {
    return {id: r.id, employeeId: r.employee_id, leaveYearId: r.leave_year_id, takenOn: toDay(r.taken_on), days: Number(r.days), notes: r.notes || '', created: r.created_at};
  }
  decorateYears(yearRows, entryRows) {
    const entries = entryRows.map((r) => this.mapEntry(r));
    return yearRows.map((r) => decorateYear(this.mapLeaveYear(r), entries.filter((e) => e.leaveYearId === r.id)));
  }
  async leaveBasis() {
    const r = await this.pool.query("SELECT value FROM hr_settings WHERE key='leaveYearBasis'");
    const v = r.rows[0]?.value;
    const basis = typeof v === 'string' ? v : (v && v.toString ? v.toString() : DEFAULT_BASIS);
    return basis === 'calendar' ? 'calendar' : DEFAULT_BASIS;
  }
  async ensureEmployeeYears(employeeId, asOf = today()) {
    const emp = await this.getEmployee(employeeId);
    if (!emp.arrivalDate) return [];
    const until = emp.departureDate && emp.departureDate < asOf ? emp.departureDate : asOf;
    const basis = await this.leaveBasis();
    const planned = yearsForEmployee(emp.arrivalDate, until, basis);
    for (const y of planned) {
      await this.pool.query(
        `INSERT INTO hr_leave_years(id, employee_id, year_key, starts_on, ends_on, statutory, entitled, entitled_source)
         VALUES($1,$2,$3,$4,$5,$6,$6,'statutory')
         ON CONFLICT(employee_id, year_key) DO UPDATE SET
           starts_on=excluded.starts_on, ends_on=excluded.ends_on, statutory=excluded.statutory,
           entitled=CASE WHEN hr_leave_years.entitled_source='manual' OR hr_leave_years.status<>'未結算'
                         THEN hr_leave_years.entitled ELSE excluded.entitled END`,
        [yearId(employeeId, y.yearKey), employeeId, y.yearKey, y.startsOn, y.endsOn, y.statutory]
      );
    }
    const rows = await this.pool.query('SELECT * FROM hr_leave_years WHERE employee_id=$1 ORDER BY starts_on', [employeeId]);
    const entries = await this.pool.query('SELECT * FROM hr_leave_entries WHERE employee_id=$1', [employeeId]);
    return this.decorateYears(rows.rows, entries.rows);
  }
  async ensureAllYears(asOf = today()) {
    const emps = (await this.pool.query('SELECT id FROM hr_employees')).rows;
    for (const e of emps) await this.ensureEmployeeYears(e.id, asOf);
  }
  async upsertImportedYear(row) {
    await this.pool.query(
      `INSERT INTO hr_leave_years(id, employee_id, year_key, starts_on, ends_on, statutory, entitled, entitled_source, carried_in, status, settled_on, settled_by, notes)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT(employee_id, year_key) DO NOTHING`,
      [row.id, row.employeeId, row.yearKey, row.startsOn, row.endsOn, row.statutory, row.entitled,
       row.entitledSource || 'imported', row.carriedIn || 0, row.status || '未結算',
       row.settledOn || null, row.settledBy || null, row.notes || '']
    );
  }
  async overrideEntitled(id, days, actor) {
    const n = Number(days);
    if (!Number.isFinite(n) || n < 0 || n > 365) throw new AppError(400, '應有天數不正確');
    const cur = await this.pool.query('SELECT * FROM hr_leave_years WHERE id=$1', [id]);
    if (!cur.rowCount) throw new AppError(404, '找不到特休年度');
    await this.pool.query("UPDATE hr_leave_years SET entitled=$1, entitled_source='manual' WHERE id=$2", [n, id]);
    await this.audit(this.pool, actor, '調整特休應有天數', cur.rows[0].employee_id, cur.rows[0].year_key + ' → ' + n);
    return this.yearById(id);
  }
  async addLeaveEntry(body, actor) {
    const employeeId = body.employeeId;
    await this.getEmployee(employeeId);
    let yearIdValue = body.leaveYearId;
    if (!yearIdValue) {
      await this.ensureEmployeeYears(employeeId, body.takenOn || today());
      const years = (await this.pool.query('SELECT * FROM hr_leave_years WHERE employee_id=$1 ORDER BY starts_on', [employeeId])).rows;
      const day = body.takenOn;
      const hit = years.find((y) => toDay(y.starts_on) <= day && day <= toDay(y.ends_on));
      if (!hit) throw new AppError(400, '請假日期不在任何特休年度內（到職未滿六個月或日期不正確）');
      yearIdValue = hit.id;
    }
    const year = (await this.pool.query('SELECT * FROM hr_leave_years WHERE id=$1', [yearIdValue])).rows[0];
    if (!year) throw new AppError(404, '找不到特休年度');
    if (year.status !== '未結算') throw new AppError(400, '這個特休年度已結算，不能再登記請假');
    const days = Number(body.days);
    if (!Number.isFinite(days) || days <= 0 || days > 30) throw new AppError(400, '請假天數請填 0.5 的倍數，且大於 0');
    if (Math.round(days * 2) !== days * 2) throw new AppError(400, '請假天數只接受 0.5 天的倍數');
    const takenOn = body.takenOn;
    if (!takenOn) throw new AppError(400, '請填請假日期');
    const id = body.id || newId('LV-');
    await this.pool.query(
      'INSERT INTO hr_leave_entries(id, employee_id, leave_year_id, taken_on, days, notes) VALUES($1,$2,$3,$4,$5,$6)',
      [id, employeeId, yearIdValue, takenOn, days, String(body.notes || '').slice(0, 500)]
    );
    await this.audit(this.pool, actor, '登記特休使用', employeeId, takenOn + ' ' + days + '天');
    return this.mapEntry((await this.pool.query('SELECT * FROM hr_leave_entries WHERE id=$1', [id])).rows[0]);
  }
  async deleteLeaveEntry(id, actor) {
    const cur = await this.pool.query('SELECT * FROM hr_leave_entries WHERE id=$1', [id]);
    if (!cur.rowCount) throw new AppError(404, '找不到請假紀錄');
    const year = (await this.pool.query('SELECT * FROM hr_leave_years WHERE id=$1', [cur.rows[0].leave_year_id])).rows[0];
    if (year && year.status !== '未結算') throw new AppError(400, '這個特休年度已結算，不能刪除請假紀錄');
    await this.pool.query('DELETE FROM hr_leave_entries WHERE id=$1', [id]);
    await this.audit(this.pool, actor, '刪除特休使用', cur.rows[0].employee_id, id);
  }
  async settleYear(id, body, actor) {
    const cur = await this.pool.query('SELECT * FROM hr_leave_years WHERE id=$1', [id]);
    if (!cur.rowCount) throw new AppError(404, '找不到特休年度');
    const decorated = (await this.yearById(id));
    let status = body.status || defaultSettlement(decorated.remaining);
    if (!SETTLEMENTS.includes(status) || status === '未結算') throw new AppError(400, '請選擇結算狀態');
    if (status === '已休完' && decorated.remaining > 0 && !body.force) {
      throw new AppError(400, '尚有剩餘天數，無法標示已休完。請改為未休完已折現，或遞延到明年。');
    }
    const settledOn = body.settledOn || today();
    const settledBy = String(body.settledBy || actor || '').slice(0, 80);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const prev = cur.rows[0];
      if (prev.status === '遞延到明年') await this.clearCarryFrom(c, prev);
      await c.query(
        'UPDATE hr_leave_years SET status=$1, settled_on=$2, settled_by=$3, notes=$4 WHERE id=$5',
        [status, settledOn, settledBy, String(body.notes || '').slice(0, 500), id]
      );
      if (status === '遞延到明年' && decorated.remaining > 0) {
        await this.addCarryToNext(c, prev, decorated.remaining);
      }
      await this.audit(c, actor, '結算特休年度', prev.employee_id, prev.year_key + ' ' + status + ' 經手 ' + settledBy);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally { c.release(); }
    return this.yearById(id);
  }
  async addCarryToNext(client, year, amount) {
    const emp = (await client.query('SELECT payload FROM hr_employees WHERE id=$1', [year.employee_id])).rows[0];
    const hire = emp?.payload?.arrivalDate;
    const basis = 'anniversary';
    const nextStarts = toDay(year.ends_on) && addDaysSafe(toDay(year.ends_on), 1);
    if (!nextStarts) return;
    const planned = yearsForEmployee(hire, nextStarts, basis).find((y) => y.startsOn === nextStarts);
    if (!planned) return;
    const id = yearId(year.employee_id, planned.yearKey);
    await client.query(
      `INSERT INTO hr_leave_years(id, employee_id, year_key, starts_on, ends_on, statutory, entitled, entitled_source, carried_in)
       VALUES($1,$2,$3,$4,$5,$6,$6,'statutory',$7)
       ON CONFLICT(employee_id, year_key) DO UPDATE SET carried_in=hr_leave_years.carried_in + excluded.carried_in`,
      [id, year.employee_id, planned.yearKey, planned.startsOn, planned.endsOn, planned.statutory, amount]
    );
  }
  async clearCarryFrom(client, year) {
    const nextStarts = addDaysSafe(toDay(year.ends_on), 1);
    if (!nextStarts) return;
    const next = await client.query('SELECT * FROM hr_leave_years WHERE employee_id=$1 AND starts_on=$2', [year.employee_id, nextStarts]);
    if (!next.rowCount) return;
    // We cannot know exact previous carry from this year alone if multiple; subtract current remaining as of when it was settled is hard.
    // Store nothing extra — leave carried_in as-is if already consumed. For first version, zero only if next still 未結算 and carried_in>=0.
    const amt = Number(next.rows[0].carried_in || 0);
    // Recompute this year's remaining without depending on next.
    const entries = await client.query('SELECT days FROM hr_leave_entries WHERE leave_year_id=$1', [year.id]);
    const used = entries.rows.reduce((n, r) => n + Number(r.days), 0);
    const remaining = Number(year.entitled) + Number(year.carried_in || 0) - used;
    const nextCarry = Math.max(0, amt - remaining);
    await client.query('UPDATE hr_leave_years SET carried_in=$1 WHERE id=$2', [nextCarry, next.rows[0].id]);
  }
  async yearById(id) {
    const y = await this.pool.query('SELECT * FROM hr_leave_years WHERE id=$1', [id]);
    if (!y.rowCount) throw new AppError(404, '找不到特休年度');
    const entries = await this.pool.query('SELECT * FROM hr_leave_entries WHERE leave_year_id=$1', [id]);
    return this.decorateYears(y.rows, entries.rows)[0];
  }
  async insertLeaveRecordLegacy(row) {
    await this.pool.query('INSERT INTO hr_records(id, employee_id, kind, payload, created_at) VALUES($1,$2,$3,$4,COALESCE($5::timestamptz, now())) ON CONFLICT(id) DO NOTHING',
      [row.id, row.employeeId, 'leave', row.payload, row.created || null]);
  }
}

function yearId(employeeId, yearKey) {
  return 'LY-' + employeeId + '-' + yearKey;
}
function toDay(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
function addDaysSafe(date, n) {
  if (!date) return '';
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  const pad = (x) => String(x).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}


function pickEmp(data, prev = {}) {
  const o = {...prev};
  for (const k of EMP_FIELDS) {
    const v = data[k] == null ? (prev[k] == null ? '' : prev[k]) : data[k];
    o[k] = v == null ? '' : String(v).slice(0, k === 'notes' || k === 'lineId' ? 4000 : 200);
  }
  if (!PAY_TYPES.includes(o.payType)) o.payType = o.employmentType === '兼職' || o.employmentType === '時薪' ? '兼職' : (o.payType || '正職');
  if (!PAYMENT_METHODS.includes(o.paymentMethod)) o.paymentMethod = o.paymentMethod || '匯款';
  if (data.arrivalDateSource || prev.arrivalDateSource) o.arrivalDateSource = data.arrivalDateSource || prev.arrivalDateSource;
  return o;
}
function pickCand(data) {
  return {
    name: String(data.name || '').slice(0, 80),
    phone: String(data.phone || '').slice(0, 40),
    department: String(data.department || '').slice(0, 80),
    job: String(data.job || '').slice(0, 80),
    source: String(data.source || '').slice(0, 120),
    contactPerson: String(data.contactPerson || '').slice(0, 80),
    availableDate: String(data.availableDate || '').slice(0, 20),
    interviewAt: String(data.interviewAt || '').slice(0, 40),
    followupDate: String(data.followupDate || '').slice(0, 20),
    status: STATUSES.includes(data.status) ? data.status : '待聯絡',
    notes: String(data.notes || '').slice(0, 4000),
    employeeId: String(data.employeeId || '').slice(0, 40),
  };
}

export {today, newId, active, pickEmp, pickCand};
