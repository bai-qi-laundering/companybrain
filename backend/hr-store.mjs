import {randomBytes} from 'node:crypto';
import {AppError} from './domain.mjs';
import {encryptSecret, decryptSecret, hasPiiKey, last4} from './hr-crypto.mjs';
import {maskTaiwanId, isValidTaiwanId, normalizeTaiwanId} from './hr-twid.mjs';
import {DEFAULT_SALARY_IMPORT} from './hr-salary-import.mjs';
import {yearsForEmployee, decorateYear, defaultSettlement, SETTLEMENTS, DEFAULT_BASIS, endingSoon} from './hr-leave.mjs';
import {DEFAULT_DEPT_PREFIXES, nextPrefixedId, prefixForDepartment, isUsableEmployeeId, PAY_TYPES, PAYMENT_METHODS} from './hr-ids.mjs';

export const DOC_TYPES = {identity: '身分證', bank: '存摺', license: '駕照', resume: '履歷表'};
export const STATUSES = ['待聯絡', '待面試', '待回覆', '錄取', '待報到', '已報到', '未錄取', '放棄', '未回覆', '未到面試', '未報到'];
export const OPEN_STATUSES = ['待聯絡', '待面試', '待回覆', '錄取', '待報到'];
export const EMP_FIELDS = ['name', 'department', 'job', 'employmentType', 'payType', 'paymentMethod', 'arrivalDate', 'departureDate', 'phone', 'emergencyContact', 'paperLocation', 'notes', 'lineBound', 'lineId', 'address', 'education', 'experience'];

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

CREATE TABLE IF NOT EXISTS hr_employee_pii (
  employee_id text PRIMARY KEY REFERENCES hr_employees(id),
  bank_code text,
  bank_branch text,
  account_name text,
  account_last4 text,
  account_enc text,
  national_id_mask text,
  national_id_enc text,
  national_name text,
  birth_date date,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hr_ocr_reviews (
  id text PRIMARY KEY,
  document_id text REFERENCES hr_documents(id),
  employee_id text REFERENCES hr_employees(id),
  candidate_id text REFERENCES hr_candidates(id),
  category text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  extracted jsonb NOT NULL DEFAULT '{}',
  skip_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  confirmed_by text
);
CREATE INDEX IF NOT EXISTS hr_ocr_reviews_emp ON hr_ocr_reviews(employee_id, status);
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
    await this.setSettingIfAbsent('salaryImport', DEFAULT_SALARY_IMPORT);
    await this.pool.query('ALTER TABLE hr_documents ADD COLUMN IF NOT EXISTS candidate_id text REFERENCES hr_candidates(id)');
    await this.pool.query('ALTER TABLE hr_ocr_reviews ADD COLUMN IF NOT EXISTS candidate_id text REFERENCES hr_candidates(id)');
    await this.pool.query('CREATE INDEX IF NOT EXISTS hr_docs_cand ON hr_documents(candidate_id)');
    await this.pool.query('CREATE INDEX IF NOT EXISTS hr_ocr_reviews_cand ON hr_ocr_reviews(candidate_id, status)');
  }

  async audit(client, actor, action, target, detail = '') {
    await (client || this.pool).query(
      'INSERT INTO hr_audit(actor, action, target, detail) VALUES($1,$2,$3,$4)',
      [actor, action, target, String(detail || '').slice(0, 2000)]
    );
  }

  async state() {
    const [employees, records, documents, candidates, events, goals, leaveExcel, salaries, audit, settings, lastImport, leaveYears, leaveEntries, pii, ocrReviews] = await Promise.all([
      this.pool.query('SELECT id, payload, revision FROM hr_employees ORDER BY id'),
      this.pool.query('SELECT id, employee_id, kind, payload, created_at FROM hr_records ORDER BY created_at DESC, id'),
      this.pool.query('SELECT * FROM hr_documents ORDER BY category, filename'),
      this.pool.query('SELECT id, payload, revision, created_at, updated_at FROM hr_candidates ORDER BY id'),
      this.pool.query('SELECT * FROM hr_recruitment_events ORDER BY created_at DESC, id DESC'),
      this.pool.query('SELECT department, payload, revision FROM hr_recruitment_goals ORDER BY department'),
      this.pool.query('SELECT id, employee_id, payload, created_at FROM hr_leave_import_rows ORDER BY created_at DESC, id'),
      this.pool.query('SELECT id, employee_id, month, version, status, payload FROM hr_salaries ORDER BY month DESC, id'),
      this.pool.query('SELECT created_at, actor, action, target, detail FROM hr_audit ORDER BY id DESC LIMIT 200'),
      this.pool.query('SELECT key, value FROM hr_settings'),
      this.pool.query("SELECT value FROM hr_settings WHERE key='lastImport'"),
      this.pool.query('SELECT * FROM hr_leave_years ORDER BY starts_on DESC, id'),
      this.pool.query('SELECT * FROM hr_leave_entries ORDER BY taken_on DESC, id'),
      this.pool.query('SELECT * FROM hr_employee_pii'),
      this.pool.query('SELECT * FROM hr_ocr_reviews ORDER BY created_at DESC, id'),
    ]);
    const mapEmp = (r) => ({id: r.id, revision: r.revision, ...r.payload});
    const piiByEmp = Object.fromEntries(pii.rows.map((r) => [r.employee_id, publicPii(r)]));
    const result = {
      employees: employees.rows.map(mapEmp),
      records: records.rows.map((r) => ({id: r.id, employeeId: r.employee_id, kind: r.kind, created: r.created_at, ...r.payload})),
      documents: documents.rows.map((r) => ({
        id: r.id, category: r.category, relativePath: r.relative_path, filename: r.filename,
        size: Number(r.size), mtime: Number(r.mtime), available: r.available,
        employeeId: r.employee_id, candidateId: r.candidate_id, suggestions: r.suggestions || [], expiresOn: r.expires_on,
      })),
      candidates: candidates.rows.map(publicCandidate),
      recruitmentEvents: events.rows.map((r) => ({id: r.id, candidateId: r.candidate_id, kind: r.kind, created: r.created_at, ...r.payload})),
      recruitmentGoals: goals.rows.map((r) => this.decorateGoal(r.department, r.payload, employees.rows.map(mapEmp))),
      leaveExcel: leaveExcel.rows.map((r) => ({id: r.id, employeeId: r.employee_id, created: r.created_at, ...r.payload})),
      salaries: salaries.rows.map(mapSalary),
      audit: audit.rows.map((r) => ({created: r.created_at, actor: r.actor, action: r.action, target: r.target, detail: r.detail})),
      settings: Object.fromEntries(settings.rows.map((r) => [r.key, r.value])),
      lastImport: lastImport.rows[0]?.value || null,
      deptPrefixes: { ...DEFAULT_DEPT_PREFIXES, ...((settings.rows.find((r) => r.key === 'deptPrefixes')?.value) || {}) },
      leaveYearBasis: (settings.rows.find((r) => r.key === 'leaveYearBasis')?.value) || DEFAULT_BASIS,
      leaveSettleDefault: (settings.rows.find((r) => r.key === 'leaveSettleDefault')?.value) || '未休完已折現',
      leaveYears: this.decorateYears(leaveYears.rows, leaveEntries.rows),
      leaveEntries: leaveEntries.rows.map((r) => this.mapEntry(r)),
    };
    result.employees = result.employees.map((e) => ({...e, pii: piiByEmp[e.id] || null}));
    result.ocrReviews = ocrReviews.rows.map((r) => mapOcrReview(r, {reveal: r.status === 'pending'}));
    result.ocr = {geminiConfigured: false, piiKeyConfigured: hasPiiKey()};
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
    if (hasProfilePiiFields(data)) validateProfilePii(data);
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
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally { c.release(); }
    const pii = hasProfilePiiFields(data) ? await this.upsertProfilePii(id, data, actor) : (await this.getEmployeePii(id));
    const emp = await this.getEmployee(id);
    return {...emp, pii};
  }

  async getEmployeePii(employeeId) {
    const r = await this.pool.query('SELECT * FROM hr_employee_pii WHERE employee_id=$1', [employeeId]);
    return r.rowCount ? publicPii(r.rows[0]) : null;
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
      const payload = pickCand(merged, prev);
      if (prev.employeeId) {
        payload.employeeId = prev.employeeId;
        payload.status = '已報到';
      }
      if (prev.archived && data.archived !== false) {
        payload.archived = true;
        payload.archivedAt = prev.archivedAt;
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
      const row = (await this.pool.query('SELECT id, payload, revision, created_at, updated_at FROM hr_candidates WHERE id=$1', [id])).rows[0];
      return publicCandidate(row);
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
      if (payload.outcome === '未回覆') status = '未回覆';
      if (payload.outcome === '未到面試' || payload.outcome === '未到場') status = '未到面試';
      if (payload.outcome === '未報到') status = '未報到';
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
    const extraNotes = [cand.notes, cand.address && ('住址：' + cand.address), cand.education && ('學歷：' + cand.education), cand.experience && ('經歷：' + cand.experience)].filter(Boolean).join('\n');
    const payload = pickEmp({
      name: cand.name,
      department: body.department || cand.department,
      job: body.job || cand.job,
      employmentType: body.employmentType || '正職',
      payType: body.payType || (body.employmentType === '兼職' || body.employmentType === '時薪' ? '兼職' : '正職'),
      paymentMethod: body.paymentMethod || '匯款',
      lineId: body.lineId || cand.lineId || '',
      arrivalDate: body.arrivalDate || cand.availableDate || today(),
      phone: body.phone || cand.phone,
      address: cand.address || '',
      education: cand.education || '',
      experience: cand.experience || '',
      notes: extraNotes || '由徵人資料轉入；招募歷程保留於徵人頁。',
    });
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const exists = await c.query('SELECT 1 FROM hr_employees WHERE id=$1', [empId]);
      if (exists.rowCount) throw new AppError(409, '員工編號已存在');
      await c.query('INSERT INTO hr_employees(id, payload, revision) VALUES($1,$2,1)', [empId, payload]);
      const nextCand = {...cand, employeeId: empId, status: '已報到', followupDate: '', interviewAt: ''};
      await c.query('UPDATE hr_candidates SET payload=$1, revision=revision+1, updated_at=now() WHERE id=$2', [nextCand, candidateId]);
      await c.query('UPDATE hr_documents SET employee_id=$1 WHERE candidate_id=$2 AND employee_id IS NULL', [empId, candidateId]);
      await this.audit(c, actor, '報到並轉為員工', candidateId, empId + ' ' + payload.name);
      await c.query('COMMIT');
      const pubCand = publicCandidate({id: candidateId, revision: (candR.rows[0].revision || 0) + 1, payload: nextCand, created_at: null, updated_at: new Date()});
      const nationalId = cand.nationalId || (cand.nationalIdEnc && hasPiiKey() ? (() => { try { return decryptSecret(cand.nationalIdEnc); } catch { return ''; } })() : '');
      if (cand.birthDate || nationalId) {
        await this.upsertProfilePii(empId, {birthDate: cand.birthDate || '', nationalId}, actor);
      }
      const pii = await this.getEmployeePii(empId);
      return {employee: {id: empId, ...payload, pii}, candidate: pubCand};
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
      `INSERT INTO hr_documents(id, category, relative_path, filename, size, mtime, available, employee_id, candidate_id, suggestions, expires_on)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT(category, relative_path) DO UPDATE SET
         filename=excluded.filename, size=excluded.size, mtime=excluded.mtime, available=true,
         employee_id=COALESCE(hr_documents.employee_id, excluded.employee_id),
         candidate_id=COALESCE(hr_documents.candidate_id, excluded.candidate_id),
         suggestions=excluded.suggestions, expires_on=COALESCE(hr_documents.expires_on, excluded.expires_on)`,
      [row.id, row.category, row.relativePath, row.filename, row.size, row.mtime, row.available !== false,
        row.employeeId || null, row.candidateId || null, JSON.stringify(row.suggestions || []), row.expiresOn || null]
    );
    if (actor && (row.employeeId || row.candidateId)) await this.audit(this.pool, actor, '上傳員工文件', row.employeeId || row.candidateId, row.category + ' ' + row.filename);
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

  async getSalaryImport() {
    const r = await this.pool.query("SELECT value FROM hr_settings WHERE key='salaryImport'");
    const v = r.rows[0]?.value || {};
    const columns = {...DEFAULT_SALARY_IMPORT.columns, ...(v.columns || {})};
    return {
      spreadsheetId: String(v.spreadsheetId || DEFAULT_SALARY_IMPORT.spreadsheetId).trim() || DEFAULT_SALARY_IMPORT.spreadsheetId,
      sheetTab: String(v.sheetTab || DEFAULT_SALARY_IMPORT.sheetTab).trim() || DEFAULT_SALARY_IMPORT.sheetTab,
      columns,
    };
  }
  async saveSalaryImport(body, actor) {
    const cur = await this.getSalaryImport();
    const next = {
      spreadsheetId: String(body.spreadsheetId || cur.spreadsheetId).trim() || cur.spreadsheetId,
      sheetTab: String(body.sheetTab || cur.sheetTab).trim() || cur.sheetTab,
      columns: {
        month: String(body.columns?.month || body.month || cur.columns.month).trim() || cur.columns.month,
        employeeId: String(body.columns?.employeeId || body.employeeId || cur.columns.employeeId).trim() || cur.columns.employeeId,
        name: String(body.columns?.name || body.name || cur.columns.name).trim() || cur.columns.name,
        amount: String(body.columns?.amount || body.amount || cur.columns.amount).trim() || cur.columns.amount,
      },
    };
    await this.setSetting('salaryImport', next);
    if (actor) await this.audit(this.pool, actor, '更新薪資匯入設定', 'salaryImport', next.sheetTab);
    return next;
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


  async upsertSalary(body, actor) {
    const employeeId = String(body.employeeId || '').trim();
    if (!employeeId) throw new AppError(400, '請指定員工');
    await this.getEmployee(employeeId);
    const month = String(body.month || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new AppError(400, '請填月份（YYYY-MM）');
    const netPay = Number(body.netPay);
    if (!Number.isFinite(netPay) || netPay < 0 || netPay > 1e9) throw new AppError(400, '請填實發金額');
    const remittance = body.remittance === '已匯' ? '已匯' : '未匯';
    const notes = String(body.notes || '').slice(0, 500);
    const payload = {netPay, notes, remittance, source: 'ledger'};
    if (body.id) {
      const cur = await this.pool.query('SELECT * FROM hr_salaries WHERE id=$1', [body.id]);
      if (!cur.rowCount) throw new AppError(404, '找不到薪資紀錄');
      const other = await this.pool.query("SELECT id FROM hr_salaries WHERE employee_id=$1 AND month=$2 AND digest='ledger' AND id<>$3", [employeeId, month, body.id]);
      if (other.rowCount) throw new AppError(409, '這個月份已有薪資紀錄');
      await this.pool.query(
        "UPDATE hr_salaries SET month=$1, status=$2, payload=$3::jsonb, digest='ledger' WHERE id=$4",
        [month, remittance, JSON.stringify(payload), body.id]
      );
      await this.audit(this.pool, actor, '修改薪資紀錄', employeeId, month + ' ' + remittance);
      return mapSalary((await this.pool.query('SELECT * FROM hr_salaries WHERE id=$1', [body.id])).rows[0]);
    }
    const exists = await this.pool.query("SELECT id FROM hr_salaries WHERE employee_id=$1 AND month=$2 AND digest='ledger'", [employeeId, month]);
    if (exists.rowCount) throw new AppError(409, '這個月份已有薪資紀錄，請直接修改');
    const id = newId('SAL-');
    await this.pool.query(
      "INSERT INTO hr_salaries(id, employee_id, month, digest, version, status, payload) VALUES($1,$2,$3,'ledger',1,$4,$5::jsonb)",
      [id, employeeId, month, remittance, JSON.stringify(payload)]
    );
    await this.audit(this.pool, actor, '新增薪資紀錄', employeeId, month + ' ' + netPay);
    return mapSalary((await this.pool.query('SELECT * FROM hr_salaries WHERE id=$1', [id])).rows[0]);
  }

  async deleteSalary(id, actor) {
    const cur = await this.pool.query('SELECT * FROM hr_salaries WHERE id=$1', [id]);
    if (!cur.rowCount) throw new AppError(404, '找不到薪資紀錄');
    await this.pool.query('DELETE FROM hr_salaries WHERE id=$1', [id]);
    await this.audit(this.pool, actor, '刪除薪資紀錄', cur.rows[0].employee_id, cur.rows[0].month);
    return {ok: true};
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

  async insertOcrReview({documentId, employeeId, candidateId, category, extracted, status = 'pending', skipReason} = {}, actor) {
    const id = newId('OCR-');
    const sealed = sealExtracted(category, extracted || {});
    await this.pool.query(
      `INSERT INTO hr_ocr_reviews(id, document_id, employee_id, candidate_id, category, status, extracted, skip_reason)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [id, documentId || null, employeeId || null, candidateId || null, category, status, JSON.stringify(sealed), skipReason || null]
    );
    if (actor) await this.audit(this.pool, actor, '文件辨識待確認', employeeId || candidateId || documentId || id, category);
    return this.getOcrReview(id, {reveal: true});
  }

  async getOcrReview(id, {reveal = false} = {}) {
    const r = await this.pool.query('SELECT * FROM hr_ocr_reviews WHERE id=$1', [id]);
    if (!r.rowCount) throw new AppError(404, '找不到辨識結果');
    return mapOcrReview(r.rows[0], {reveal});
  }

  async findReviewForDocument(documentId, statuses = ['pending', 'confirmed']) {
    const r = await this.pool.query(
      "SELECT * FROM hr_ocr_reviews WHERE document_id=$1 AND status IN ('pending','confirmed') ORDER BY created_at DESC, id DESC LIMIT 1",
      [documentId]
    );
    return r.rowCount ? mapOcrReview(r.rows[0], {reveal: r.rows[0].status === 'pending'}) : null;
  }

  async confirmOcrReview(id, fields, actor) {
    const cur = await this.pool.query('SELECT * FROM hr_ocr_reviews WHERE id=$1', [id]);
    if (!cur.rowCount) throw new AppError(404, '找不到辨識結果');
    const row = cur.rows[0];
    if (row.status !== 'pending') throw new AppError(400, '這筆辨識已處理');
    const extracted = revealExtracted(row.extracted || {});
    const merged = {...extracted, ...(fields || {})};
    const {packConfirmed} = await import('./hr-ocr.mjs');
    const packed = packConfirmed(row.category, merged);
    let pii = null;
    let candidate = null;
    if (row.category === 'resume') {
      const candId = row.candidate_id;
      if (!candId) throw new AppError(400, '這份履歷沒有對應應徵者，無法寫入');
      candidate = await this.applyResumeToCandidate(candId, packed, actor);
    } else {
      await this.upsertEmployeePii(row.employee_id, packed, row.category);
      const piiRow = (await this.pool.query('SELECT * FROM hr_employee_pii WHERE employee_id=$1', [row.employee_id])).rows[0];
      pii = publicPii(piiRow);
    }
    await this.pool.query(
      "UPDATE hr_ocr_reviews SET status='confirmed', extracted=$2::jsonb, confirmed_at=now(), confirmed_by=$3, updated_at=now() WHERE id=$1",
      [id, JSON.stringify(sealExtracted(row.category, merged)), actor || '']
    );
    await this.audit(this.pool, actor, '確認文件辨識', row.employee_id || row.candidate_id || id, row.category);
    return {review: await this.getOcrReview(id), pii, candidate};
  }

  async applyResumeToCandidate(candidateId, packed, actor) {
    const patch = {
      name: packed.name,
      phone: packed.phone,
      birthDate: packed.birthDate,
      nationalId: packed.nationalId,
      address: packed.address,
      education: packed.education,
      experience: packed.experience,
      job: packed.desiredPosition || packed.job,
    };
    return this.upsertCandidate(candidateId, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== '')), actor);
  }

  async archiveCandidate(id, actor) {
    const cur = await this.pool.query('SELECT payload, revision FROM hr_candidates WHERE id=$1', [id]);
    if (!cur.rowCount) throw new AppError(404, '找不到應徵者');
    const prev = cur.rows[0].payload || {};
    if (prev.archived) return publicCandidate({id, revision: cur.rows[0].revision, payload: prev, created_at: null, updated_at: new Date()});
    const payload = {...prev, archived: true, archivedAt: nowIso()};
    const revision = (cur.rows[0].revision || 0) + 1;
    await this.pool.query('UPDATE hr_candidates SET payload=$1, revision=$2, updated_at=now() WHERE id=$3', [payload, revision, id]);
    await this.audit(this.pool, actor, '封存應徵者', id, prev.name || '');
    const row = (await this.pool.query('SELECT id, payload, revision, created_at, updated_at FROM hr_candidates WHERE id=$1', [id])).rows[0];
    return publicCandidate(row);
  }

  async dismissOcrReview(id, actor) {
    const cur = await this.pool.query('SELECT * FROM hr_ocr_reviews WHERE id=$1', [id]);
    if (!cur.rowCount) throw new AppError(404, '找不到辨識結果');
    if (cur.rows[0].status !== 'pending') throw new AppError(400, '這筆辨識已處理');
    await this.pool.query("UPDATE hr_ocr_reviews SET status='dismissed', updated_at=now() WHERE id=$1", [id]);
    await this.audit(this.pool, actor, '略過文件辨識', cur.rows[0].employee_id || id, cur.rows[0].category);
    return {ok: true};
  }

  async upsertEmployeePii(employeeId, packed, category) {
    if (!employeeId) throw new AppError(400, '沒有對應員工，無法寫入辨識結果');
    await this.getEmployee(employeeId);
    const cur = (await this.pool.query('SELECT * FROM hr_employee_pii WHERE employee_id=$1', [employeeId])).rows[0] || {};
    const next = {
      bank_code: category === 'bank' ? (packed.bankCode || '') : (cur.bank_code || null),
      bank_branch: category === 'bank' ? (packed.bankBranch || '') : (cur.bank_branch || null),
      account_name: category === 'bank' ? (packed.accountName || '') : (cur.account_name || null),
      account_last4: category === 'bank' ? (packed.accountLast4 || '') : (cur.account_last4 || null),
      account_enc: category === 'bank' ? (packed.accountEnc || null) : (cur.account_enc || null),
      national_id_mask: category === 'identity' ? (packed.nationalIdMask || '') : (cur.national_id_mask || null),
      national_id_enc: category === 'identity' ? (packed.nationalIdEnc || null) : (cur.national_id_enc || null),
      national_name: category === 'identity' ? (packed.nationalName || '') : (cur.national_name || null),
      birth_date: category === 'identity' ? (packed.birthDate || null) : (cur.birth_date || null),
    };
    await this.pool.query(
      `INSERT INTO hr_employee_pii(employee_id, bank_code, bank_branch, account_name, account_last4, account_enc, national_id_mask, national_id_enc, national_name, birth_date, updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
       ON CONFLICT(employee_id) DO UPDATE SET
         bank_code=excluded.bank_code, bank_branch=excluded.bank_branch, account_name=excluded.account_name,
         account_last4=excluded.account_last4, account_enc=excluded.account_enc,
         national_id_mask=excluded.national_id_mask, national_id_enc=excluded.national_id_enc,
         national_name=excluded.national_name, birth_date=excluded.birth_date, updated_at=now()`,
      [employeeId, next.bank_code, next.bank_branch, next.account_name, next.account_last4, next.account_enc,
       next.national_id_mask, next.national_id_enc, next.national_name, next.birth_date || null]
    );
    return publicPii({employee_id: employeeId, ...next});
  }

  async upsertProfilePii(employeeId, fields, actor) {
    if (!employeeId) throw new AppError(400, '沒有對應員工');
    await this.getEmployee(employeeId);
    const packed = packProfilePii(fields, (await this.pool.query('SELECT * FROM hr_employee_pii WHERE employee_id=$1', [employeeId])).rows[0] || {});
    const saved = await this.pool.query(
      `INSERT INTO hr_employee_pii(employee_id, bank_code, bank_branch, account_name, account_last4, account_enc, national_id_mask, national_id_enc, national_name, birth_date, updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
       ON CONFLICT(employee_id) DO UPDATE SET
         bank_code=excluded.bank_code, bank_branch=excluded.bank_branch, account_name=excluded.account_name,
         account_last4=excluded.account_last4, account_enc=excluded.account_enc,
         national_id_mask=excluded.national_id_mask, national_id_enc=excluded.national_id_enc,
         national_name=excluded.national_name, birth_date=excluded.birth_date, updated_at=now()
       RETURNING *`,
      [employeeId, packed.bank_code, packed.bank_branch, packed.account_name, packed.account_last4, packed.account_enc,
       packed.national_id_mask, packed.national_id_enc, packed.national_name, packed.birth_date]
    );
    if (actor) await this.audit(this.pool, actor, '更新員工證件資料', employeeId, '');
    return publicPii(saved.rows[0]);
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


function sealExtracted(category, extracted = {}) {
  const out = {...extracted};
  if (out.account) {
    out.accountLast4 = last4(out.account);
    if (hasPiiKey()) out.accountEnc = encryptSecret(out.account);
    delete out.account;
  }
  if (out.nationalId) {
    out.nationalIdMask = maskTaiwanId(out.nationalId);
    if (hasPiiKey()) {
      out.nationalIdEnc = encryptSecret(out.nationalId);
      delete out.nationalId;
    }
  }
  return out;
}
function revealExtracted(extracted = {}) {
  const out = {...extracted};
  if (out.accountEnc && hasPiiKey()) {
    try { out.account = decryptSecret(out.accountEnc); } catch { /* keep last4 */ }
  }
  if (out.nationalIdEnc && hasPiiKey()) {
    try { out.nationalId = decryptSecret(out.nationalIdEnc); } catch { /* keep mask */ }
  }
  delete out.accountEnc;
  delete out.nationalIdEnc;
  return out;
}
function mapOcrReview(row, {reveal = false} = {}) {
  const extracted = reveal ? revealExtracted(row.extracted || {}) : redactExtracted(row.extracted || {});
  return {
    id: row.id,
    documentId: row.document_id,
    employeeId: row.employee_id,
    category: row.category,
    status: row.status,
    extracted,
    skipReason: row.skip_reason || '',
    created: row.created_at,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by || '',
    candidateId: row.candidate_id || row.candidateId || '',
  };
}
function redactExtracted(extracted = {}) {
  const out = {...extracted};
  if (out.account || out.accountEnc) {
    out.accountLast4 = out.accountLast4 || last4(out.account || '');
    delete out.account;
    delete out.accountEnc;
  }
  if (out.nationalId || out.nationalIdEnc) {
    out.nationalIdMask = out.nationalIdMask || maskTaiwanId(out.nationalId || '');
    delete out.nationalId;
    delete out.nationalIdEnc;
  }
  return out;
}
function formatDateField(v) {
  if (!v) return '';
  if (typeof v === 'string') {
    const s = v.replace(/\//g, '-').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const pad = (x) => String(x).padStart(2, '0');
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  return '';
}
function publicPii(row) {
  if (!row) return null;
  const birth = formatDateField(row.birth_date);
  let account = '';
  let nationalId = '';
  if (hasPiiKey()) {
    if (row.account_enc) {
      try { account = decryptSecret(row.account_enc); } catch { /* keep last4 */ }
    }
    if (row.national_id_enc) {
      try { nationalId = decryptSecret(row.national_id_enc); } catch { /* keep mask */ }
    }
  }
  return {
    bankCode: row.bank_code || '',
    bankBranch: row.bank_branch || '',
    accountName: row.account_name || '',
    accountLast4: row.account_last4 || last4(account),
    account,
    nationalIdMask: row.national_id_mask || (nationalId ? maskTaiwanId(nationalId) : ''),
    nationalId,
    nationalName: row.national_name || '',
    birthDate: birth,
  };
}

const PROFILE_PII_KEYS = ['nationalId', 'birthDate', 'nationalName', 'bankCode', 'bankBranch', 'account', 'accountName'];
function hasProfilePiiFields(data = {}) {
  return PROFILE_PII_KEYS.some((k) => data[k] !== undefined);
}
function validBirth(value) {
  const s = String(value || '').trim().replace(/\//g, '-').slice(0, 10);
  if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new AppError(400, '出生年月日格式請用 YYYY-MM-DD');
  return s;
}
function looksLikeMaskedAccount(value, last4digits) {
  const s = String(value || '').replace(/\s/g, '');
  if (!s) return true;
  const digits = s.replace(/\D/g, '');
  if (last4digits && digits === String(last4digits) && s.length <= 6) return true;
  if (/^[•*xX]+\d{2,4}$/.test(s)) return true;
  return false;
}
function validateProfilePii(fields = {}) {
  if (fields.nationalId !== undefined && String(fields.nationalId || '').trim()) {
    const id = normalizeTaiwanId(fields.nationalId);
    if (!isValidTaiwanId(id)) throw new AppError(400, '身分證字號檢查碼不正確');
  }
  if (fields.birthDate !== undefined && String(fields.birthDate || '').trim()) validBirth(fields.birthDate);
  if (fields.account !== undefined && String(fields.account || '').trim() && !looksLikeMaskedAccount(fields.account, fields.accountLast4)) {
    if (!hasPiiKey()) throw new AppError(400, '尚未設定 HR_PII_KEY，無法保存完整銀行帳號。');
  }
  if (fields.nationalId !== undefined && String(fields.nationalId || '').trim() && !hasPiiKey()) {
    throw new AppError(400, '尚未設定 HR_PII_KEY，無法保存身分證字號。');
  }
}
function packProfilePii(fields, cur = {}) {
  validateProfilePii(fields);
  const next = {
    bank_code: cur.bank_code || null,
    bank_branch: cur.bank_branch || null,
    account_name: cur.account_name || null,
    account_last4: cur.account_last4 || null,
    account_enc: cur.account_enc || null,
    national_id_mask: cur.national_id_mask || null,
    national_id_enc: cur.national_id_enc || null,
    national_name: cur.national_name || null,
    birth_date: formatDateField(cur.birth_date) || null,
  };
  if (fields.bankCode !== undefined) next.bank_code = String(fields.bankCode || '').replace(/\D/g, '').slice(0, 3);
  if (fields.bankBranch !== undefined) next.bank_branch = String(fields.bankBranch || fields.branch || '').slice(0, 80);
  if (fields.accountName !== undefined) next.account_name = String(fields.accountName || '').slice(0, 80);
  if (fields.account !== undefined && !looksLikeMaskedAccount(fields.account, cur.account_last4)) {
    const account = String(fields.account || '').replace(/[^\d-]/g, '');
    if (account) {
      if (!hasPiiKey()) throw new AppError(400, '尚未設定 HR_PII_KEY，無法保存完整銀行帳號。');
      next.account_enc = encryptSecret(account);
      next.account_last4 = last4(account);
    } else {
      next.account_enc = null;
      next.account_last4 = '';
    }
  }
  if (fields.nationalId !== undefined) {
    const id = normalizeTaiwanId(fields.nationalId);
    if (id) {
      if (!hasPiiKey()) throw new AppError(400, '尚未設定 HR_PII_KEY，無法保存身分證字號。');
      next.national_id_enc = encryptSecret(id);
      next.national_id_mask = maskTaiwanId(id);
    } else {
      next.national_id_enc = null;
      next.national_id_mask = '';
    }
  }
  if (fields.nationalName !== undefined) next.national_name = String(fields.nationalName || '').slice(0, 80);
  if (fields.birthDate !== undefined) next.birth_date = validBirth(fields.birthDate) || null;
  return next;
}

function mapSalary(r) {
  const p = r.payload || {};
  const net = Number(p.netPay ?? p.net ?? p.amount);
  const remittance = (r.status === '已匯' || p.remittance === '已匯') ? '已匯' : '未匯';
  return {
    id: r.id,
    employeeId: r.employee_id,
    month: r.month,
    netPay: Number.isFinite(net) ? net : 0,
    notes: String(p.notes || (p.source && !['ledger', 'migrated'].includes(p.source) ? p.source : '') || '').slice(0, 500),
    remittance,
  };
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
function looksLikeMaskedId(value, mask) {
  const s = String(value || '').trim().toUpperCase();
  if (!s) return true;
  if (mask && s === String(mask).toUpperCase()) return true;
  return /^[A-Z][*•xX]{4}\d{4}$/.test(s);
}
function pickCand(data, prev = {}) {
  const out = {
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
    birthDate: String(data.birthDate || prev.birthDate || '').slice(0, 10),
    address: String(data.address ?? prev.address ?? '').slice(0, 200),
    education: String(data.education ?? prev.education ?? '').slice(0, 2000),
    experience: String(data.experience ?? prev.experience ?? '').slice(0, 4000),
    nationalIdMask: prev.nationalIdMask || '',
    nationalIdEnc: prev.nationalIdEnc || null,
    archived: Boolean(data.archived || prev.archived),
    archivedAt: data.archivedAt || prev.archivedAt || '',
  };
  if (data.nationalId !== undefined) {
    const raw = String(data.nationalId || '').trim();
    if (!raw) {
      out.nationalIdEnc = null;
      out.nationalIdMask = '';
    } else if (!looksLikeMaskedId(raw, prev.nationalIdMask)) {
      const id = normalizeTaiwanId(raw);
      if (id && !isValidTaiwanId(id)) throw new AppError(400, '身分證字號檢查碼不正確');
      if (id) {
        if (!hasPiiKey()) throw new AppError(400, '尚未設定 HR_PII_KEY，無法保存身分證字號。');
        out.nationalIdEnc = encryptSecret(id);
        out.nationalIdMask = maskTaiwanId(id);
      } else {
        out.nationalIdEnc = null;
        out.nationalIdMask = '';
      }
    }
  }
  return out;
}
function publicCandidate(row) {
  if (!row) return null;
  const p = {...(row.payload || {})};
  let nationalId = '';
  if (p.nationalIdEnc && hasPiiKey()) {
    try { nationalId = decryptSecret(p.nationalIdEnc); } catch { /* keep mask */ }
  }
  delete p.nationalIdEnc;
  return {
    id: row.id,
    revision: row.revision,
    created: row.created_at || p.created || '',
    updated: row.updated_at || p.updated || '',
    ...p,
    nationalId,
    nationalIdMask: p.nationalIdMask || (nationalId ? maskTaiwanId(nationalId) : ''),
    archived: Boolean(p.archived || p.archivedAt),
  };
}

export {today, newId, active, pickEmp, pickCand};
