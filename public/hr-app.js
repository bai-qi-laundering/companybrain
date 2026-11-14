(() => {
  const STATUSES = ['待聯絡', '待面試', '待回覆', '錄取', '待報到', '已報到', '未錄取', '放棄', '未回覆', '未到面試', '未報到'];
  const OPEN = ['待聯絡', '待面試', '待回覆', '錄取', '待報到'];
  const CLOSED = ['未回覆', '未到面試', '未報到', '未錄取', '放棄', '已報到'];
  const QUICK_STATUSES = ['未回覆', '未到面試', '未報到'];
  const DOC = {identity: '身分證', bank: '存摺', license: '駕照', resume: '履歷表'};
  const PHONE = ['已接通', '未接', '忙線', '停話／錯號', '婉拒', '約定面試', '待回覆', '未回覆'];
  const INTERVIEW = ['已面試', '未到場', '未到面試', '改期', '錄取', '未錄取', '待回覆'];
  const TYPES = ['正職', '時薪', '兼職'];
  const PAY_TYPES = ['正職', '兼職'];
  const PAY_METHODS = ['匯款', '現金'];
  const DEFAULT_PREFIXES = {物流:'D',摺疊:'F',撐開:'H',洗滌:'W',洗滓:'W',辦公室:'O',行政:'O'};
  const PREFIX_CHOICES = {洗滌:['W','E'],洗滓:['W','E']};
  const STANDARD_DEPARTMENT_JOBS = [['辦公室','行政'],['洗滌','洗滌人員'],['摺疊','現場作業員'],['撐開','現場作業員'],['物流','新進司機'],['物流','司機'],['摺疊','作業員'],['撐開','作業員'],['洗滌','早班作業員']];
  const STANDARD_DEPARTMENTS = [...new Set(STANDARD_DEPARTMENT_JOBS.map((row) => row[0]))];
  const STANDARD_JOBS = [...new Set(STANDARD_DEPARTMENT_JOBS.map((row) => row[1]))];
  const DEPARTMENT_JOBS = STANDARD_DEPARTMENT_JOBS.reduce((map, [dept, job]) => {
    if (!map[dept]) map[dept] = [];
    if (!map[dept].includes(job)) map[dept].push(job);
    return map;
  }, {});

  const KEY = 'companybrain-hr-demo-v1';

  let ctx = {};
  let state = emptyState();
  let route = {page: 'list', id: null};
  let demo = true;
  let jobFilter = {staff: '', recruitment: ''};

  function emptyState() {
    return {employees: [], records: [], documents: [], candidates: [], recruitmentEvents: [], recruitmentGoals: [], leaveExcel: [], salaries: [], audit: [], lastImport: null, leaveYears: [], leaveEntries: [], leaveYearBasis: 'anniversary', leaveSettleDefault: '未休完已折現', leaveExpiryReminders: [], ocrReviews: [], ocr: {geminiConfigured: false, piiKeyConfigured: false}, salaryImport: {configured: false}};
  }
  function today() {
    return new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
  }

  function addYears(date, n) {
    if (!date) return '';
    const [y, m, d] = date.split('-').map(Number);
    const last = new Date(Date.UTC(y + n, m, 0)).getUTCDate();
    const pad = (x) => String(x).padStart(2, '0');
    return `${y + n}-${pad(m)}-${pad(Math.min(d, last))}`;
  }
  function addMonths(date, n) {
    if (!date) return '';
    const [y, m, d] = date.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1 + n, 1));
    const yy = dt.getUTCFullYear(), mm = dt.getUTCMonth() + 1;
    const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    const pad = (x) => String(x).padStart(2, '0');
    return `${yy}-${pad(mm)}-${pad(Math.min(d, last))}`;
  }
  function addDays(date, n) {
    const [y, m, d] = date.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    const pad = (x) => String(x).padStart(2, '0');
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  }
  function statutoryDays(hire, start) {
    if (!hire || start < addMonths(hire, 6)) return 0;
    let years = 0;
    while (addYears(hire, years + 1) <= start) years += 1;
    if (years < 1) return 3;
    if (years < 2) return 7;
    if (years < 3) return 10;
    if (years < 5) return 14;
    if (years < 10) return 15;
    return Math.min(30, 15 + (years - 9));
  }
  function plannedYears(hire, asOf) {
    if (!hire || asOf < addMonths(hire, 6)) return [];
    const out = [];
    const first = addMonths(hire, 6);
    out.push({yearKey: first, startsOn: first, endsOn: addDays(addYears(hire, 1), -1), statutory: statutoryDays(hire, first)});
    for (let n = 1; n < 80; n++) {
      const start = addYears(hire, n);
      if (start > asOf) break;
      out.push({yearKey: start, startsOn: start, endsOn: addDays(addYears(hire, n + 1), -1), statutory: statutoryDays(hire, start)});
    }
    return out;
  }
  function decorateLeave(y, entries) {
    const used = Math.round((entries.filter((e) => e.leaveYearId === y.id).reduce((n, e) => n + Number(e.days || 0), 0)) * 1000) / 1000;
    const entitled = Number(y.entitled), carried = Number(y.carriedIn || 0);
    const remaining = Math.round((entitled + carried - used) * 1000) / 1000;
    const grant = carried ? `${entitled} 天 + 遞延 ${carried} 天` : `${entitled} 天`;
    return {...y, used, remaining, carriedIn: carried, summary: `${grant}，用了 ${used} 天，剩 ${remaining} 天，${y.status || '未結算'}`};
  }
  function leaveReminders(asOf = today()) {
    const limit = addDays(asOf, 60);
    return (state.leaveYears || []).filter((y) => y.status === '未結算' && y.remaining > 0 && y.endsOn >= asOf && y.endsOn <= limit);
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  }
  function $(sel, el) { return (el || document).querySelector(sel); }
  function $$(sel, el) { return [...(el || document).querySelectorAll(sel)]; }
  function active(e, day = today()) {
    return (!e.arrivalDate || e.arrivalDate <= day) && (!e.departureDate || e.departureDate >= day);
  }
  function q() { return (ctx.query || '').trim().toLowerCase(); }
  function match(obj, keys) {
    const s = keys.map((k) => obj[k] || '').join(' ').toLowerCase();
    return !q() || s.includes(q());
  }
  function toast(t) { if (ctx.notify) ctx.notify(t); }

  function seed() {
    const employees = [
      {id: 'EMP-001', name: '黃淑芬', department: '行政', job: '人資行政', employmentType: '正職', arrivalDate: '2019-03-01', departureDate: '', phone: '0912-000-001', emergencyContact: '黃先生 0912-111-001', paperLocation: '行政櫃 3 層', notes: '', lineBound: ''},
      {id: 'EMP-003', name: '王建宏', department: '廠務', job: '廠務主管', employmentType: '正職', arrivalDate: '2018-07-16', departureDate: '', phone: '0912-000-003', emergencyContact: '王太太 0912-111-003', paperLocation: '廠務室', notes: '', lineBound: ''},
      {id: 'EMP-008', name: '林雅婷', department: '客服對帳', job: '客服對帳', employmentType: '正職', arrivalDate: '2024-02-01', departureDate: '', phone: '0912-000-008', emergencyContact: '', paperLocation: '', notes: '示意：缺緊急聯絡人與紙本位置', lineBound: ''},
      {id: 'EMP-014', name: '陳志明', department: '物流', job: '物流司機', employmentType: '正職', arrivalDate: '2022-05-20', departureDate: '', phone: '0912-000-014', emergencyContact: '陳太太 0912-111-014', paperLocation: '司機室', notes: '', lineBound: '', pii: {bankCode: '004', bankBranch: '城中分行', accountName: '陳志明', account: '12345678901234', accountLast4: '1234', nationalId: 'A123456789', nationalIdMask: 'A****6789', nationalName: '陳志明', birthDate: '1988-02-03'}},
      {id: 'EMP-015', name: '張偉誠', department: '物流', job: '物流司機', employmentType: '正職', arrivalDate: '2023-09-11', departureDate: '', phone: '0912-000-015', emergencyContact: '張先生 0912-111-015', paperLocation: '司機室', notes: '', lineBound: ''},
    ];
    const documents = [
      {id: 'D-demo-1', category: 'identity', filename: 'EMP-014_陳志明_身分證_20260501T100000_aabbccddeeff.jpg', relativePath: 'EMP-014_陳志明_身分證_20260501T100000_aabbccddeeff.jpg', employeeId: 'EMP-014', size: 120000, mtime: Date.now(), available: true, suggestions: [], expiresOn: ''},
      {id: 'D-demo-2', category: 'bank', filename: 'EMP-014_陳志明_存摺_20260501T100100_ffeeddccbbaa.jpg', relativePath: 'EMP-014_陳志明_存摺_20260501T100100_ffeeddccbbaa.jpg', employeeId: 'EMP-014', size: 140000, mtime: Date.now(), available: true, suggestions: [], expiresOn: ''},
      {id: 'D-demo-3', category: 'license', filename: 'EMP-014_陳志明_駕照_20260501T100200_abc123abc123.pdf', relativePath: 'EMP-014_陳志明_駕照_20260501T100200_abc123abc123.pdf', employeeId: 'EMP-014', size: 8000, mtime: Date.now(), available: true, suggestions: [], expiresOn: '2026-12-05'},
    ];
    const candidates = [
      {id: 'R-01', name: '吳佳穎', phone: '0988-100-001', department: '物流', job: '物流司機', source: '1111', status: '待面試', followupDate: today(), interviewAt: today() + 'T14:00', contactPerson: '黃淑芬', availableDate: '', notes: '', employeeId: ''},
      {id: 'R-02', name: '周柏翰', phone: '0988-100-002', department: '廠務', job: '廠務助理', source: '介紹', status: '待聯絡', followupDate: today(), interviewAt: '', contactPerson: '王建宏', availableDate: '', notes: '', employeeId: ''},
      {id: 'R-03', name: '許雅琪', phone: '0988-100-003', department: '行政', job: '人資行政', source: '104', status: '待報到', followupDate: today(), interviewAt: '', contactPerson: '黃淑芬', availableDate: today(), notes: '', employeeId: ''},
      {id: 'R-04', name: '鄭文傑', phone: '0988-100-004', department: '物流', job: '物流司機', source: '1111', status: '待回覆', followupDate: '2026-11-10', interviewAt: '', contactPerson: '黃淑芬', availableDate: '', notes: '', employeeId: ''},
      {id: 'R-05', name: '蔡佩珊', phone: '0988-100-005', department: '客服對帳', job: '客服', source: '104', status: '錄取', followupDate: today(), interviewAt: '', contactPerson: '林雅婷', availableDate: '', notes: '', employeeId: ''},
      {id: 'R-06', name: '林書廷', phone: '0988-100-006', department: '廠務', job: '廠務', source: '介紹', status: '未錄取', followupDate: '', interviewAt: '', contactPerson: '', availableDate: '', notes: '', employeeId: ''},
    ];
    const recruitmentGoals = [
      decorateGoal({department: '物流', baseline: 2, required: 4, history: []}, employees),
      decorateGoal({department: '廠務', baseline: 1, required: 2, history: []}, employees),
      decorateGoal({department: '行政', baseline: 1, required: 1, history: []}, employees),
    ];
    const records = [
      {id: 'REC-demo-2', employeeId: 'EMP-001', kind: 'insurance', labor: '加保', health: '加保', laborGrade: '', healthGrade: '', date: '2019-03-01', note: ''},
    ];
    const leaveYears = [];
    const leaveEntries = [];
    for (const e of employees) {
      for (const y of plannedYears(e.arrivalDate, today())) {
        const row = {id: 'LY-' + e.id + '-' + y.yearKey, employeeId: e.id, ...y, entitled: y.statutory, entitledSource: 'statutory', carriedIn: 0, status: '未結算', settledOn: '', settledBy: '', notes: ''};
        leaveYears.push(row);
      }
    }
    const cur = leaveYears.find((y) => y.employeeId === 'EMP-001' && y.startsOn === '2026-03-01');
    if (cur) {
      leaveEntries.push({id: 'LV-demo-1', employeeId: 'EMP-001', leaveYearId: cur.id, takenOn: '2026-06-02', days: 2, notes: '示意請假'});
      leaveEntries.push({id: 'LV-demo-2', employeeId: 'EMP-001', leaveYearId: cur.id, takenOn: '2026-08-18', days: 3.5, notes: '示意請假（含半天）'});
      leaveEntries.push({id: 'LV-demo-3', employeeId: 'EMP-001', leaveYearId: cur.id, takenOn: '2026-10-05', days: 0.5, notes: '半天'});
    }
    const prev = leaveYears.find((y) => y.employeeId === 'EMP-001' && y.startsOn === '2025-03-01');
    if (prev) {
      prev.status = '未休完已折現'; prev.settledOn = '2026-03-02'; prev.settledBy = '黃淑芬'; prev.notes = '年度結束未休完，依慣例折現（不記金額）';
      leaveEntries.push({id: 'LV-demo-4', employeeId: 'EMP-001', leaveYearId: prev.id, takenOn: '2025-07-10', days: 5, notes: '去年已休'});
    }
    const salaries = [
      {id: 'SAL-demo-1', employeeId: 'EMP-014', month: '2026-09', netPay: 42000, notes: '示意', remittance: '已匯'},
      {id: 'SAL-demo-2', employeeId: 'EMP-014', month: '2026-10', netPay: 41500, notes: '', remittance: '未匯'},
      {id: 'SAL-demo-3', employeeId: 'EMP-001', month: '2026-10', netPay: 38000, notes: '', remittance: '已匯'},
    ];
    return {employees, records, documents, candidates, recruitmentEvents: [], recruitmentGoals, leaveExcel: [], salaries, audit: [], lastImport: null, leaveYearBasis: 'anniversary', leaveSettleDefault: '未休完已折現', leaveYears: leaveYears.map((y) => decorateLeave(y, leaveEntries)), leaveEntries, leaveExpiryReminders: [], salaryImport: {configured: true, source: 'demo', spreadsheetId: '', sheetTab: '薪資計算明細', columns: {month: '計算月份', employeeId: '員工編號', name: '員工姓名', amount: '實領薪資'}}};
  }
  function decorateGoal(g, employees, day = today()) {
    const current = employees.filter((e) => e.department === g.department && active(e, day)).length;
    const baseline = Number(g.baseline || 0);
    const required = Number(g.required || 0);
    const net = current - baseline;
    const percent = required ? Math.max(0, Math.min(100, Math.round((net / required) * 100))) : 0;
    return {...g, current, netFilled: net, percent, remaining: Math.max(required - net, 0), filled: Math.max(net, 0), asOf: day};
  }
  function loadDemo() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) { state = JSON.parse(raw); refreshLeave(); return; }
    } catch {}
    state = seed();
    refreshLeave();
    saveDemo();
  }
  function refreshLeave() {
    state.leaveYears = (state.leaveYears || []).map((y) => decorateLeave(y, state.leaveEntries || []));
    state.leaveExpiryReminders = leaveReminders().map((y) => {
      const emp = state.employees.find((e) => e.id === y.employeeId);
      return {employeeId: y.employeeId, name: emp?.name || y.employeeId, endsOn: y.endsOn, remaining: y.remaining, summary: y.summary};
    });
  }
  function saveDemo() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
  }

  function stateView() {
    if (route.page === 'profile' && route.id) return {view: 'profile', id: route.id};
    if (route.page === 'candidate' && route.id) return {view: 'candidate', id: route.id};
    if (ctx.view === 'recruitment') return {view: 'recruitment', id: ''};
    return {view: 'staff', id: ''};
  }
  async function refresh(opts = {}) {
    if (!demo && ctx.api) {
      const {view, id} = opts.view ? opts : stateView();
      const q = '/api/hr/state?view=' + encodeURIComponent(view) + (id ? '&id=' + encodeURIComponent(id) : '');
      const next = await ctx.api(q);
      state = {...state, ...next};
    } else {
      loadDemo();
    }
  }

  async function write(path, method, body) {
    if (!demo && ctx.api) return ctx.api(path, method, body);
    return demoWrite(path, method, body);
  }

  function deptPrefixes() {
    const map = {...DEFAULT_PREFIXES, ...(state.deptPrefixes || {})};
    const w = map['洗滌'] || map['洗滓'] || 'W';
    map['洗滌'] = w;
    map['洗滓'] = w;
    return map;
  }
  function prefixFor(department, prefix) {
    if (prefix) return String(prefix).toUpperCase();
    const map = deptPrefixes();
    const d = String(department || '').trim();
    if (map[d]) return map[d];
    if (d === '洗滓' || d === '洗滌') return map['洗滌'] || map['洗滓'] || 'W';
    return '';
  }
  function prefixChoicesFor(department) {
    const d = String(department || '').trim();
    return PREFIX_CHOICES[d] || PREFIX_CHOICES[d === '洗滓' ? '洗滌' : d] || (prefixFor(d) ? [prefixFor(d)] : ['D','F','H','W','E','O']);
  }
  function officialJobs() {
    return state.jobTitlesOfficial || STANDARD_JOBS;
  }
  function officialDepartments() {
    return state.departmentsOfficial || STANDARD_DEPARTMENTS;
  }
  function jobsForDept(department, current) {
    const d = String(department || '').trim() === '洗滓' ? '洗滌' : String(department || '').trim();
    const map = state.departmentJobs || DEPARTMENT_JOBS;
    const official = (d && map[d] && map[d].length) ? map[d] : officialJobs();
    const extra = current && !official.includes(current) ? [current] : [];
    return [...extra, ...official];
  }
  function jobTitleOptions() {
    const seen = new Set();
    const out = [];
    const add = (raw) => {
      const v = String(raw || '').trim();
      if (!v || seen.has(v)) return;
      seen.add(v);
      out.push(v);
    };
    for (const v of officialJobs()) add(v);
    for (const v of state.jobTitles || []) add(v);
    for (const row of [...(state.employees || []), ...(state.candidates || [])]) {
      add(row.job);
      add(row.desiredPosition);
    }
    return out;
  }
  function jobCombo(name, label, value, department) {
    const v = value || '';
    const opts = jobsForDept(department, v.trim());
    const id = 'hr-jobs-' + name;
    return `<div class="field"><span>${esc(label)}</span><input name="${name}" value="${esc(v)}" list="${id}" autocomplete="off" placeholder="選擇或自行輸入"><datalist id="${id}">${opts.map((o) => `<option value="${esc(o)}"></option>`).join('')}</datalist></div>`;
  }
  function deptCombo(name, label, value) {
    const v = value || '';
    const opts = officialDepartments();
    const list = (v.trim() && !opts.includes(v.trim())) ? [v.trim(), ...opts] : opts;
    const id = 'hr-depts-' + name;
    return `<div class="field"><span>${esc(label)}</span><input name="${name}" value="${esc(v)}" list="${id}" autocomplete="off" placeholder="選擇或自行輸入"><datalist id="${id}">${list.map((o) => `<option value="${esc(o)}"></option>`).join('')}</datalist></div>`;
  }
  function bindDeptJob(form) {
    const dept = form?.elements?.department;
    const job = form?.elements?.job;
    if (!dept || !job) return;
    const sync = () => {
      const list = document.getElementById(job.getAttribute('list'));
      if (!list) return;
      list.innerHTML = jobsForDept(dept.value, job.value.trim()).map((o) => `<option value="${esc(o)}"></option>`).join('');
    };
    dept.addEventListener('change', sync);
    dept.addEventListener('input', sync);
  }
  function jobFilterSelect(current, name) {
    const opts = jobTitleOptions();
    return `<label class="muted" style="display:flex;align-items:center;gap:8px">職稱 <select name="${name}" data-job-filter><option value="">全部</option>${opts.map((o) => `<option ${o === current ? 'selected' : ''} value="${esc(o)}">${esc(o)}</option>`).join('')}</select></label>`;
  }
  function nextEmpId(department, prefix) {
    const p = prefixFor(department, prefix);
    if (!p) return '';
    const re = new RegExp('^' + p + '(\\d+)$', 'i');
    let max = 0;
    for (const e of state.employees) {
      const m = String(e.id).match(re);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return p + String(max + 1).padStart(3, '0');
  }

  function demoWrite(path, method, body) {
    const idOf = (p) => decodeURIComponent((p.match(/\/([^/]+)(?:\/[^/]+)?$/) || [])[1] || '');
    if (path === '/api/hr/employees' && method === 'POST') {
      const id = (body.id || nextEmpId(body.department, body.prefix) || ('X' + Date.now())).toUpperCase();
      if (state.employees.some((e) => e.id === id)) throw new Error('員工編號已存在');
      const row = {id, ...body};
      state.employees.push(row); saveDemo(); return row;
    }
    let m;
    if ((m = path.match(/^\/api\/hr\/employees\/([^/]+)$/)) && method === 'PATCH') {
      const e = state.employees.find((x) => x.id === m[1]);
      if (!e) throw new Error('找不到員工');
      const piiKeys = ['nationalId', 'birthDate', 'nationalName', 'bankCode', 'bankBranch', 'account', 'accountName'];
      const piiPatch = {};
      for (const k of piiKeys) {
        if (body[k] !== undefined) { piiPatch[k] = body[k]; delete body[k]; }
      }
      Object.assign(e, body);
      if (Object.keys(piiPatch).length) {
        e.pii = Object.assign({}, e.pii || {}, piiPatch);
        if (piiPatch.account) e.pii.accountLast4 = String(piiPatch.account).replace(/\D/g, '').slice(-4);
        if (piiPatch.nationalId) {
          const idn = String(piiPatch.nationalId).toUpperCase();
          e.pii.nationalId = idn;
          e.pii.nationalIdMask = idn ? (idn[0] + '****' + idn.slice(-4)) : '';
        }
      }
      saveDemo(); return e;
    }
    if (path === '/api/hr/records' && method === 'POST') {
      const row = {id: 'REC-' + Date.now(), ...body};
      state.records.unshift(row); saveDemo(); return row;
    }
    if (path === '/api/hr/candidates' && method === 'POST') {
      const row = {id: 'R-' + Date.now(), status: '待聯絡', ...body, employeeId: ''};
      state.candidates.push(row); saveDemo(); return row;
    }
    if ((m = path.match(/^\/api\/hr\/candidates\/([^/]+)$/)) && method === 'PATCH') {
      const c = state.candidates.find((x) => x.id === m[1]);
      if (!c) throw new Error('找不到應徵者');
      if (body.status === '已報到' && !c.employeeId) throw new Error('尚未建立員工檔案，不能標示為已報到。請使用「報到並轉為員工」。');
      Object.assign(c, body);
      if (c.employeeId) c.status = '已報到';
      saveDemo(); return c;
    }
    if ((m = path.match(/^\/api\/hr\/candidates\/([^/]+)\/events$/)) && method === 'POST') {
      const c = state.candidates.find((x) => x.id === m[1]);
      if (!c) throw new Error('找不到應徵者');
      const ev = {id: 'E-' + Date.now(), candidateId: c.id, kind: body.kind, at: new Date().toISOString(), ...body};
      state.recruitmentEvents.unshift(ev);
      if (body.outcome === '約定面試') c.status = '待面試';
      if (body.outcome === '錄取') c.status = '錄取';
      if (body.outcome === '未錄取') c.status = '未錄取';
      if (body.nextFollowup) c.followupDate = body.nextFollowup;
      if (body.nextInterviewAt) c.interviewAt = body.nextInterviewAt;
      saveDemo(); return ev;
    }
    if ((m = path.match(/^\/api\/hr\/candidates\/([^/]+)\/convert$/)) && method === 'POST') {
      const c = state.candidates.find((x) => x.id === m[1]);
      if (!c) throw new Error('找不到應徵者');
      if (c.employeeId) throw new Error('這位應徵者已轉為員工 ' + c.employeeId);
      const id = body.employeeId || nextEmpId(body.department || (state.candidates.find((x)=>x.id===m[1])||{}).department, body.prefix);
      const employee = {id, name: c.name, department: body.department || c.department, job: body.job || c.job, employmentType: body.employmentType || '正職', payType: body.payType || (body.employmentType === '兼職' || body.employmentType === '時薪' ? '兼職' : '正職'), paymentMethod: body.paymentMethod || '匯款', arrivalDate: body.arrivalDate || c.availableDate || today(), departureDate: '', phone: body.phone || c.phone, emergencyContact: '', paperLocation: '', notes: '由徵人資料轉入；招募歷程保留於徵人頁。', lineBound: '', lineId: body.lineId || ''};
      state.employees.push(employee);
      employee.address = c.address || '';
      employee.education = c.education || '';
      employee.experience = c.experience || '';
      employee.notes = c.notes ? ('由徵人資料轉入。' + c.notes) : '由徵人資料轉入；招募歷程保留於徵人頁。';
      if (c.birthDate || c.nationalId) {
        employee.pii = Object.assign({}, employee.pii || {}, {birthDate: c.birthDate || '', nationalId: c.nationalId || '', nationalIdMask: c.nationalIdMask || ''});
      }
      (state.documents || []).forEach((d) => {
        if (d.candidateId === c.id && !d.employeeId) d.employeeId = id;
      });
      c.employeeId = id; c.status = '已報到'; c.followupDate = '';
      saveDemo(); return {employee, candidate: c};
    }
    if ((m = path.match(/^\/api\/hr\/candidates\/([^/]+)$/)) && method === 'DELETE') {
      const c = state.candidates.find((x) => x.id === m[1]);
      if (!c) throw new Error('找不到應徵者');
      c.archived = true;
      c.archivedAt = new Date().toISOString();
      saveDemo(); return c;
    }
    if (path === '/api/hr/goals' && method === 'POST') {
      let g = state.recruitmentGoals.find((x) => x.department === body.department);
      const additional = Number(body.additional || body.required || 0);
      if (!g) {
        const baseline = state.employees.filter((e) => e.department === body.department && active(e)).length;
        g = {department: body.department, baseline, required: 0, history: []};
        state.recruitmentGoals.push(g);
      }
      g.required = (g.required || 0) + additional;
      g.history = g.history || []; g.history.push({at: new Date().toISOString(), additional, notes: body.notes || ''});
      Object.assign(g, decorateGoal(g, state.employees));
      saveDemo(); return g;
    }
    if ((m = path.match(/^\/api\/hr\/documents\/([^/]+)$/)) && method === 'PATCH') {
      const d = state.documents.find((x) => x.id === m[1]);
      if (!d) throw new Error('找不到文件');
      if (body.employeeId) d.employeeId = body.employeeId;
      if (body.expiresOn !== undefined) d.expiresOn = body.expiresOn;
      saveDemo(); return d;
    }
    if (path === '/api/hr/leave-entries' && method === 'POST') {
      const days = Number(body.days);
      if (!days || days <= 0 || Math.round(days * 2) !== days * 2) throw new Error('請假天數只接受 0.5 天的倍數');
      const y = state.leaveYears.find((x) => x.id === body.leaveYearId);
      if (!y) throw new Error('找不到特休年度');
      if (y.status !== '未結算') throw new Error('這個特休年度已結算，不能再登記請假');
      const row = {id: 'LV-' + Date.now(), employeeId: body.employeeId, leaveYearId: body.leaveYearId, takenOn: body.takenOn, days, notes: body.notes || ''};
      state.leaveEntries.push(row); refreshLeave(); saveDemo(); return row;
    }
    let lm;
    if ((lm = path.match(/^\/api\/hr\/leave-entries\/([^/]+)$/)) && method === 'DELETE') {
      state.leaveEntries = state.leaveEntries.filter((e) => e.id !== lm[1]); refreshLeave(); saveDemo(); return {ok: true};
    }
    if ((lm = path.match(/^\/api\/hr\/leave-years\/([^/]+)$/)) && method === 'PATCH') {
      const y = state.leaveYears.find((x) => x.id === lm[1]);
      if (!y) throw new Error('找不到特休年度');
      if (body.entitled != null) { y.entitled = Number(body.entitled); y.entitledSource = 'manual'; }
      refreshLeave(); saveDemo(); return decorateLeave(y, state.leaveEntries);
    }
    if ((lm = path.match(/^\/api\/hr\/leave-years\/([^/]+)\/settle$/)) && method === 'POST') {
      const y = state.leaveYears.find((x) => x.id === lm[1]);
      if (!y) throw new Error('找不到特休年度');
      const dec = decorateLeave(y, state.leaveEntries);
      const status = body.status || (dec.remaining <= 0 ? '已休完' : '未休完已折現');
      if (status === '已休完' && dec.remaining > 0) throw new Error('尚有剩餘天數，無法標示已休完。請改為未休完已折現，或遞延到明年。');
      y.status = status; y.settledOn = body.settledOn || today(); y.settledBy = body.settledBy || ''; y.notes = body.notes || '';
      if (status === '遞延到明年' && dec.remaining > 0) {
        const emp = state.employees.find((e) => e.id === y.employeeId);
        const nextStarts = addDays(y.endsOn, 1);
        let nxt = state.leaveYears.find((x) => x.employeeId === y.employeeId && x.startsOn === nextStarts);
        if (!nxt && emp) {
          const planned = plannedYears(emp.arrivalDate, nextStarts).find((p) => p.startsOn === nextStarts);
          if (planned) {
            nxt = {id: 'LY-' + emp.id + '-' + planned.yearKey, employeeId: emp.id, ...planned, entitled: planned.statutory, entitledSource: 'statutory', carriedIn: 0, status: '未結算', settledOn: '', settledBy: '', notes: ''};
            state.leaveYears.push(nxt);
          }
        }
        if (nxt) nxt.carriedIn = Number(nxt.carriedIn || 0) + dec.remaining;
      }
      refreshLeave(); saveDemo(); return decorateLeave(y, state.leaveEntries);
    }
    if (path === '/api/hr/ocr/batch-bank' && method === 'POST') {
      throw new Error('示範模式不連 Gemini，無法批次辨識。');
    }
    if ((m = path.match(/^\/api\/hr\/ocr-reviews\/([^/]+)\/confirm$/)) && method === 'POST') {
      const r = (state.ocrReviews || []).find((x) => x.id === m[1]);
      if (!r) throw new Error('找不到辨識結果');
      r.status = 'confirmed';
      const emp = state.employees.find((e) => e.id === r.employeeId);
      if (emp && r.category === 'bank') {
        const acc = String(body.account || '');
        emp.pii = Object.assign({}, emp.pii || {}, {bankCode: body.bankCode || '', bankBranch: body.branch || body.bankBranch || '', accountName: body.accountName || '', account: acc, accountLast4: acc.slice(-4)});
      }
      if (emp && r.category === 'identity') {
        const idn = String(body.nationalId || '').toUpperCase();
        emp.pii = Object.assign({}, emp.pii || {}, {nationalId: idn, nationalIdMask: idn ? (idn[0] + '****' + idn.slice(-4)) : '', nationalName: body.name || '', birthDate: body.birthDate || ''});
      }
      const cand = state.candidates.find((x) => x.id === r.candidateId);
      if (cand && r.category === 'resume') {
        if (body.name) cand.name = body.name;
        if (body.phone) cand.phone = body.phone;
        if (body.birthDate) cand.birthDate = body.birthDate;
        if (body.nationalId) {
          const idn = String(body.nationalId).toUpperCase();
          cand.nationalId = idn;
          cand.nationalIdMask = idn ? (idn[0] + '****' + idn.slice(-4)) : '';
        }
        if (body.address) cand.address = body.address;
        if (body.education) cand.education = body.education;
        if (body.experience) cand.experience = body.experience;
        if (body.desiredPosition || body.job) cand.job = body.desiredPosition || body.job;
      }
      saveDemo();
      return {review: r, pii: emp && emp.pii, candidate: cand};
    }
    if ((m = path.match(/^\/api\/hr\/ocr-reviews\/([^/]+)\/dismiss$/)) && method === 'POST') {
      const r = (state.ocrReviews || []).find((x) => x.id === m[1]);
      if (!r) throw new Error('找不到辨識結果');
      r.status = 'dismissed';
      saveDemo();
      return {ok: true};
    }
    if (path === '/api/hr/salaries' && method === 'POST') {
      const month = String(body.month || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('請填月份（YYYY-MM）');
      if ((state.salaries || []).some((s) => s.employeeId === body.employeeId && s.month === month)) throw new Error('這個月份已有薪資紀錄，請直接修改');
      const row = {id: 'SAL-' + Date.now(), employeeId: body.employeeId, month, netPay: Number(body.netPay) || 0, notes: body.notes || '', remittance: body.remittance === '已匯' ? '已匯' : '未匯'};
      state.salaries = state.salaries || [];
      state.salaries.push(row); saveDemo(); return row;
    }
    if ((m = path.match(/^\/api\/hr\/salaries\/([^/]+)$/)) && method === 'PATCH') {
      const row = (state.salaries || []).find((s) => s.id === m[1]);
      if (!row) throw new Error('找不到薪資紀錄');
      const month = String(body.month || row.month).slice(0, 7);
      if ((state.salaries || []).some((s) => s.id !== row.id && s.employeeId === row.employeeId && s.month === month)) throw new Error('這個月份已有薪資紀錄');
      Object.assign(row, {month, netPay: body.netPay != null ? Number(body.netPay) : row.netPay, notes: body.notes != null ? body.notes : row.notes, remittance: body.remittance === '已匯' || body.remittance === '未匯' ? body.remittance : row.remittance});
      saveDemo(); return row;
    }
    if ((m = path.match(/^\/api\/hr\/salaries\/([^/]+)$/)) && method === 'DELETE') {
      state.salaries = (state.salaries || []).filter((s) => s.id !== m[1]);
      saveDemo(); return {ok: true};
    }
    if (path === '/api/hr/salaries/import/preview' && method === 'POST') {
      return demoSalaryPreview(body);
    }
    if (path === '/api/hr/salaries/import/confirm' && method === 'POST') {
      const month = body.month;
      let saved = 0, skipped = 0;
      for (const r of (body.rows || [])) {
        if (r.status === 'unmatched' || r.status === 'same' || !state.employees.some((e) => e.id === r.employeeId)) { skipped += 1; continue; }
        const cur = (state.salaries || []).find((s) => s.employeeId === r.employeeId && s.month === (r.month || month));
        if (cur) { cur.netPay = Number(r.netPay); if (!cur.notes) cur.notes = '由薪資計算明細匯入'; }
        else {
          state.salaries = state.salaries || [];
          state.salaries.push({id: 'SAL-' + Date.now() + '-' + r.employeeId, employeeId: r.employeeId, month: r.month || month, netPay: Number(r.netPay), notes: '由薪資計算明細匯入', remittance: '未匯'});
        }
        saved += 1;
      }
      saveDemo();
      return {ok: true, month, saved, skipped};
    }
    if (path === '/api/hr/settings/salaryImport' && method === 'PATCH') {
      state.salaryImport = Object.assign({}, state.salaryImport || {}, body, {configured: Boolean((state.salaryImport || {}).configured)});
      saveDemo(); return state.salaryImport;
    }
    throw new Error('示範模式不支援 ' + method + ' ' + path);




  }

  async function uploadFile(employeeId, category, file, expiresOn, opts = {}) {
    if (!demo && ctx.api) {
      const fd = new FormData();
      fd.append('file', file);
      if (opts.candidateId) fd.append('candidateId', opts.candidateId);
      else if (employeeId) fd.append('employeeId', employeeId);
      fd.append('category', category);
      if (expiresOn) fd.append('expiresOn', expiresOn);
      const r = await fetch('/api/hr/documents/upload', {method: 'POST', credentials: 'same-origin', headers: ctx.csrf ? {'X-CSRF-Token': ctx.csrf} : {}, body: fd});
      const result = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(result.error || '上傳失敗');
      return result;
    }
    const emp = state.employees.find((e) => e.id === employeeId) || state.candidates.find((e) => e.id === (opts.candidateId || employeeId));
    const safe = (emp?.name || '未命名').replace(/[^\w\u3400-\u9fff-]/g, '_').slice(0, 60);
    const ext = (file.name.match(/\.[a-zA-Z0-9]+$/) || ['.jpg'])[0];
    const stamp = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const taipei = new Date(stamp.toLocaleString('en-US', {timeZone: 'Asia/Taipei'}));
    const ts = `${taipei.getFullYear()}${pad(taipei.getMonth() + 1)}${pad(taipei.getDate())}T${pad(taipei.getHours())}${pad(taipei.getMinutes())}${pad(taipei.getSeconds())}`;
    const token = Array.from(crypto.getRandomValues(new Uint8Array(6))).map((b) => b.toString(16).padStart(2, '0')).join('');
    const filename = `${employeeId}_${safe}_${DOC[category]}_${ts}_${token}${ext}`;
    const folder = {identity: '/volume1/人事資料/身分證', bank: '/volume1/人事資料/存摺', license: '/volume1/人事資料/駕照', resume: '/volume1/共用資料匣/履歷表'}[category];
    const displayPath = folder + '/' + filename;
    const row = {id: 'D-' + Date.now(), category, filename, relativePath: filename, employeeId: opts.candidateId ? '' : employeeId, candidateId: opts.candidateId || '', size: file.size, mtime: Date.now(), available: true, suggestions: [], expiresOn: expiresOn || '', displayPath, path: displayPath};
    state.documents.push(row); saveDemo();
    return row;
  }
  function missingPaper(e) {
    const miss = [];
    if (!e.emergencyContact) miss.push('緊急聯絡人');
    if (!e.paperLocation) miss.push('紙本位置');
    const docs = state.documents.filter((d) => d.employeeId === e.id && d.available);
    if (!docs.some((d) => d.category === 'identity')) miss.push('身分證');
    return miss;
  }
  function expirySoon(day = today()) {
    const limit = new Date(day); limit.setDate(limit.getDate() + 60);
    const until = limit.toISOString().slice(0, 10);
    return state.documents.filter((d) => d.expiresOn && d.expiresOn <= until);
  }

  function onNavigate(view, opts) {
    ctx.view = view;
    if (!(opts && opts.keepRoute)) route = {page: 'list', id: null};
  }
  function uiBusy(root) {
    if (document.querySelector('dialog[open]')) return true;
    const ae = document.activeElement;
    if (ae && root && root.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName || '')) return true;
    if (root && root.querySelector('dialog[open], form.inline-grid, form.dlg-body')) {
      if (ae && root.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName || '')) return true;
    }
    return false;
  }
  function snapshotUi(root) {
    return {
      scroll: window.scrollY,
      jobFilter: {...jobFilter},
      route: {...route},
      search: (ctx.query || ''),
    };
  }
  function restoreUi(snap) {
    if (!snap) return;
    jobFilter = snap.jobFilter || jobFilter;
    route = snap.route || route;
    requestAnimationFrame(() => window.scrollTo(0, snap.scroll || 0));
  }
  function skeletonHtml() {
    return `<div class="hr-skeleton" aria-busy="true"><div class="hr-skel-card"></div><div class="hr-skel-card"></div><div class="hr-skel-row"></div><div class="hr-skel-row"></div><p class="muted">正在載入人事資料…</p></div>`;
  }
  function render(root, next) {
    ctx = Object.assign({}, ctx, next || {});
    demo = !ctx.nasMode;
    const view = ctx.view || 'staff';
    if (next && next.preserve && uiBusy(root)) return;
    const snap = snapshotUi(root);
    const hasContent = root && (root.querySelector('.hr-table, .kanban, .profile, .hr-toolbar'));
    if (root && !hasContent) root.innerHTML = skeletonHtml();
    refresh().then(() => {
      if (next && next.preserve && uiBusy(root)) return;
      if (route.page === 'profile' && route.id) paintProfile(root, route.id);
      else if (route.page === 'candidate' && route.id && view === 'recruitment') paintCandidate(root, route.id);
      else if (view === 'recruitment') paintRecruitment(root);
      else paintStaff(root);
      if (next && next.preserve) restoreUi(snap);
    }).catch((e) => { if (root) root.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
  }

  function renderHome(root, next) {
    ctx = Object.assign({}, ctx, next || {});
    demo = !ctx.nasMode;
    if (root && !root.innerHTML) root.innerHTML = skeletonHtml();
    refresh({view: 'home'}).then(() => {
      const t = today();
      const home = state.home || {};
      const follow = home.followupToday != null ? [{n: home.followupToday}] : visibleCands().filter((c) => OPEN.includes(c.status) && c.followupDate === t);
      const overdue = home.overdue != null ? [{n: home.overdue}] : visibleCands().filter((c) => OPEN.includes(c.status) && c.followupDate && c.followupDate < t);
      const followN = home.followupToday != null ? home.followupToday : follow.length;
      const overdueN = home.overdue != null ? home.overdue : overdue.length;
      const exp = home.expiry != null ? home.expiry : expirySoon().length;
      const onboard = home.onboard != null ? home.onboard : state.employees.filter((e) => e.arrivalDate && e.arrivalDate >= t && missingPaper(e).length).length;
      const leaveSoon = home.leaveSoon || state.leaveExpiryReminders || leaveReminders();
      root.innerHTML = `<section class="hr-home"><h2 class="section-title" style="margin:18px 0 8px">人事與徵人待辦</h2>
        <div class="hr-grid">
          <button class="hr-card today" type="button" data-go="recruitment"><div class="k">今日待聯絡</div><div class="n">${followN}</div></button>
          <button class="hr-card overdue" type="button" data-go="recruitment"><div class="k">已過期未跟</div><div class="n">${overdueN}</div></button>
          <button class="hr-card" type="button" data-go="staff"><div class="k">證件即將到期</div><div class="n">${exp}</div></button>
          <button class="hr-card ${leaveSoon.length ? 'overdue' : ''}" type="button" data-go="staff"><div class="k">特休將到期未休</div><div class="n">${leaveSoon.length}</div></button>
          <button class="hr-card" type="button" data-go="staff"><div class="k">報到資料未齊</div><div class="n">${onboard}</div></button>
        </div>
        ${leaveSoon.length ? `<p class="muted">特休年度將在 60 天內結束且尚有剩餘：${leaveSoon.map((x) => esc(x.name) + ' 剩 ' + x.remaining + ' 天（'+esc(x.endsOn)+' 止）').join('、')}。年底未休完預設結算為「未休完已折現」（只記狀態，不記金額）。</p>` : ''}
        </section>`;
      $$('[data-go]', root).forEach((b) => b.onclick = () => ctx.go && ctx.go(b.dataset.go));
    }).catch(() => { root.innerHTML = ''; });
  }

  function paintStaff(root) {
    if (route.page === 'profile' && route.id) return paintProfile(root, route.id);
    const list = state.employees.filter((e) => match(e, ['id', 'name', 'department', 'job', 'phone']) && (!jobFilter.staff || String(e.job || '').trim() === jobFilter.staff)).sort((a, b) => a.id.localeCompare(b.id));
    const exp = expirySoon();
    root.innerHTML = `
      <div class="hr-grid">
        <div class="hr-card"><div class="k">在職人數</div><div class="n">${state.employees.filter((e) => active(e)).length}</div></div>
        <div class="hr-card"><div class="k">證件即將到期（60天）</div><div class="n">${exp.length}</div></div>
        <div class="hr-card"><div class="k">資料未齊</div><div class="n">${state.employees.filter((e) => missingPaper(e).length).length}</div></div>
      </div>
      ${exp.length ? `<p class="muted">效期提醒：${exp.map((d) => esc((state.employees.find((e) => e.id === d.employeeId) || {}).name || d.filename) + ' ' + DOC[d.category] + ' ' + d.expiresOn).join('、')}</p>` : ''}
      <div class="hr-toolbar">
        <button class="hr-btn" data-act="add-emp">＋ 新增員工</button>
        <button class="hr-btn ghost" data-act="scan">掃描舊文件並配對</button>
        <button class="hr-btn ghost" data-act="ocr-bank">批次辨識既有存摺與身分證</button>
        <button class="hr-btn ghost" data-act="leave-excel">匯入特休 Excel</button>
        <button class="hr-btn ghost" data-act="salary-import">匯入本月薪資</button>
        <span class="spacer"></span>
        ${jobFilterSelect(jobFilter.staff, 'staff-job')}
        <span class="muted">點列即可開啟單頁檔案；欄位可直接改。</span>
      </div>
      <table class="hr-table"><thead><tr><th>編號</th><th>姓名</th><th>部門</th><th>職稱</th><th>電話</th><th>到職</th><th>狀態</th></tr></thead>
      <tbody>${list.map((e) => `<tr data-open="${esc(e.id)}"><td>${esc(e.id)}</td><td>${esc(e.name)}</td><td>${esc(e.department)}</td><td>${esc(e.job)}</td><td>${esc(e.phone)}</td><td>${esc(e.arrivalDate)}</td><td>${active(e) ? '<span class="pill ok">在職</span>' : '<span class="pill">離職</span>'}${missingPaper(e).length ? ' <span class="pill warn">未齊</span>' : ''}${pendingOcr(e.id).length ? ' <span class="pill warn">待確認辨識</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="7">沒有符合的員工。</td></tr>'}</tbody></table>`;
    $$('[data-open]', root).forEach((tr) => tr.onclick = () => { const id = tr.dataset.open; route = {page: 'profile', id}; refresh({view: 'profile', id}).then(() => paintProfile(root, id)); });
    $('[data-act="add-emp"]', root).onclick = () => openEmpForm(root);
    $('[data-act="scan"]', root).onclick = () => doScan(root);
    $('[data-act="ocr-bank"]', root).onclick = () => doBatchBank(root);
    $('[data-act="leave-excel"]', root).onclick = () => openExcel(root, 'leave');
    $('[data-act="salary-import"]', root).onclick = () => openSalaryImport(root);
    const jobSel = $('[data-job-filter]', root);
    if (jobSel) jobSel.onchange = () => { jobFilter.staff = jobSel.value; paintStaff(root); };
  }

  function paintProfile(root, id) {
    const e = state.employees.find((x) => x.id === id);
    if (!e) { route = {page: 'list'}; return paintStaff(root); }
    const docs = state.documents.filter((d) => d.employeeId === id);
    const recs = (k) => state.records.filter((r) => r.employeeId === id && r.kind === k);
    const miss = missingPaper(e);
    root.innerHTML = `
      <div class="hr-toolbar"><button class="hr-btn ghost" data-act="back">← 返回員工名錄</button><span class="muted">${esc(e.id)}</span></div>
      <div class="profile">
        <div class="profile-main">
          <section class="hr-card">
            <h2 class="section-title">基本資料（可直接改）</h2>
            <form id="emp-inline" class="inline-grid">
              ${field('name', '姓名', e.name)}${deptCombo('department', '部門', e.department)}
              ${jobCombo('job', '職稱', e.job, e.department)}${sel('employmentType', '雇用型態', TYPES, e.employmentType)}
              ${sel('payType', '計薪型態', PAY_TYPES, e.payType || (e.employmentType === '兼職' || e.employmentType === '時薪' ? '兼職' : '正職'))}${sel('paymentMethod', '匯款類型', PAY_METHODS, e.paymentMethod || '匯款')}
              ${field('arrivalDate', '到職日', e.arrivalDate, 'date')}${field('departureDate', '離職日', e.departureDate, 'date')}
              ${e.arrivalDateSource && e.arrivalDateSource.type === '加保日' ? '<p class="muted arrival-note" style="grid-column:1/-1">到職日由最早勞健保加保日帶入' + (e.arrivalDateSource.date ? '（' + esc(e.arrivalDateSource.date) + '）' : '') + '，可直接修改。</p>' : ''}
              ${field('phone', '電話', e.phone)}${field('emergencyContact', '緊急聯絡人', e.emergencyContact)}
              ${field('paperLocation', '紙本位置', e.paperLocation)}${field('lineId', 'LINE ID', e.lineId)}
              ${field('lineBound', 'LINE 綁定狀態', e.lineBound)}
              ${field('birthDate', '出生年月日', (e.pii && e.pii.birthDate) || '', 'date')}${field('nationalId', '身分證字號', (e.pii && e.pii.nationalId) || '')}
              ${field('address', '住址', e.address || '')}
              <div class="field" style="grid-column:1/-1"><span>學歷</span><textarea name="education">${esc(e.education || '')}</textarea></div>
              <div class="field" style="grid-column:1/-1"><span>經歷</span><textarea name="experience">${esc(e.experience || '')}</textarea></div>
              <div class="field" style="grid-column:1/-1"><span>備註</span><textarea name="notes">${esc(e.notes)}</textarea></div>
              <div style="grid-column:1/-1"><button class="hr-btn" type="submit">儲存基本資料</button></div>
            </form>
            ${miss.length ? `<p class="muted">報到清單未完成：${miss.map(esc).join('、')}</p>` : '<p class="muted">報到清單已齊（緊急聯絡人、紙本位置、身分證）。</p>'}
          </section>
          <section class="hr-card" id="leave-ledger">
            ${leaveBlock(e)}
          </section>
          <section class="hr-card">
            <h2 class="section-title">勞健保</h2>
            ${recs('insurance').map((r) => `<div class="doc"><div>勞保 ${esc(r.labor || '—')}　健保 ${esc(r.health || '—')}　${esc(r.date || '')}</div><div class="muted">${esc(r.note || '')}${r.laborGrade || r.healthGrade ? '（級距已保存）' : ''}</div></div>`).join('') || '<p class="muted">尚無保險紀錄。</p>'}
            <button class="hr-btn ghost" data-act="add-ins" style="margin-top:8px">＋ 新增保險紀錄</button>
          </section>
          <section class="hr-card">
            <h2 class="section-title">人事異動</h2>
            ${recs('change').map((r) => `<div class="doc"><div>${esc(r.date || '')}　${esc(r.title || r.type || '異動')}</div><div class="muted">${esc(r.note || '')}</div></div>`).join('') || '<p class="muted">尚無異動紀錄。</p>'}
            <button class="hr-btn ghost" data-act="add-chg" style="margin-top:8px">＋ 新增異動</button>
          </section>
        </div>
        <div class="profile-side">
          ${ocrCards(id)}
          ${piiBlock(e)}
          <section class="hr-card">
            <h2 class="section-title">證件文件</h2>
            <p class="muted">在這上傳就會自動綁到這位員工，檔名規則與舊系統相同。舊檔保留，不會覆蓋。</p>
            ${['identity', 'bank', 'license', 'resume'].map((cat) => `
              <div class="drop" data-drop="${cat}" style="margin:8px 0">
                <strong>${DOC[cat]}</strong>
                <div class="muted">拖放或點此選檔（JPG／PNG／WEBP／PDF，12MB 內）</div>
                ${cat === 'license' ? '<div class="field" style="margin-top:8px;text-align:left"><span>駕照效期</span><input type="date" data-exp="license"></div>' : ''}
                <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden data-file="${cat}">
                ${docs.filter((d) => d.category === cat).map((d) => docRow(d, cat)).join('')}
              </div>`).join('')}
          </section>
          <section class="hr-card" id="salary-ledger">
            ${salaryBlock(id)}
          </section>
        </div>
      </div>
      <div id="hr-dialogs"></div>
      <div id="hr-lightbox" class="hr-lightbox" hidden>
        <div class="hr-lightbox-backdrop" data-lb="close"></div>
        <div class="hr-lightbox-box" role="dialog" aria-modal="true" aria-label="證件預覽">
          <button type="button" class="hr-lightbox-close" data-lb="close" aria-label="關閉">×</button>
          <button type="button" class="hr-lightbox-nav prev" data-lb="prev" aria-label="上一張">‹</button>
          <img alt="">
          <button type="button" class="hr-lightbox-nav next" data-lb="next" aria-label="下一張">›</button>
          <p class="hr-lightbox-cap"></p>
        </div>
      </div>`;
    $('[data-act="back"]', root).onclick = () => { route = {page: 'list'}; paintStaff(root); };
        bindDeptJob($('#emp-inline', root));
    $('#emp-inline', root).onsubmit = async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const body = Object.fromEntries(['name', 'department', 'job', 'employmentType', 'payType', 'paymentMethod', 'arrivalDate', 'departureDate', 'phone', 'emergencyContact', 'paperLocation', 'lineId', 'lineBound', 'notes', 'birthDate', 'nationalId', 'address', 'education', 'experience'].map((k) => [k, f.elements[k].value]));
      try { await write('/api/hr/employees/' + id, 'PATCH', body); toast('已儲存 ' + body.name); await refresh(); paintProfile(root, id); }
      catch (err) { toast(err.message); }
    };
    bindLeave(root, id);
    $('[data-act="add-ins"]', root).onclick = () => openRecord(root, id, 'insurance');
    $('[data-act="add-chg"]', root).onclick = () => openRecord(root, id, 'change');
    $$('[data-drop]', root).forEach((box) => bindDrop(box, id, root));
    bindOcrCards(root, id);
    bindBankBlock(root, id);
    bindLightbox(root, id);
    bindSalary(root, id);
  }


  function pendingOcr(ownerId, {candidateId} = {}) {
    return (state.ocrReviews || []).filter((r) => r.status === 'pending' && (candidateId ? r.candidateId === candidateId : r.employeeId === ownerId));
  }
  function ocrFields(r) {
    const x = r.extracted || {};
    if (r.category === 'bank') return field('bankCode', '銀行代碼', x.bankCode) + field('branch', '分行', x.branch) + field('account', '帳號', x.account) + field('accountName', '戶名', x.accountName);
    if (r.category === 'resume') {
      return field('name', '姓名', x.name) + field('phone', '電話', x.phone) + field('birthDate', '出生年月日', x.birthDate, 'date') + field('nationalId', '身分證字號', x.nationalId) + field('address', '住址', x.address) + jobCombo('desiredPosition', '希望職缺', x.desiredPosition || x.job || '') + `<div class="field" style="grid-column:1/-1"><span>學歷</span><textarea name="education">${esc(x.education || '')}</textarea></div>` + `<div class="field" style="grid-column:1/-1"><span>經歷</span><textarea name="experience">${esc(x.experience || '')}</textarea></div>`;
    }
    return field('nationalId', '身分證字號', x.nationalId) + field('name', '姓名', x.name) + field('birthDate', '生日', x.birthDate, 'date');
  }
  function ocrTitle(cat) {
    return {bank: '存摺辨識結果，請核對後確認', identity: '身分證辨識結果，請核對後確認', resume: '履歷辨識結果，請核對後確認'}[cat] || '辨識結果，請核對後確認';
  }
  function ocrHint(cat) {
    if (cat === 'bank') return '確認後銀行帳戶會顯示在員工檔，完整帳號僅登入的管理員可看（可顯示／隱藏），資料庫仍加密。';
    if (cat === 'resume') return '確認後會寫入這位應徵者的姓名、電話、出生年月日、身分證字號、住址、學歷、經歷與希望職缺。身分證字號若有填寫會檢查檢查碼。';
    return '身分證字號會檢查檢查碼，確認後會寫入基本資料的出生年月日與身分證字號。';
  }
  function ocrCards(employeeId) { return renderOcrCards(pendingOcr(employeeId)); }
  function candidateOcrCards(candidateId) { return renderOcrCards(pendingOcr('', {candidateId})); }
  function renderOcrCards(list) {
    if (!list.length) return '';
    return list.map((r) => {
      const warns = (r.extracted?.warnings || r.warnings || []).map((w) => esc(w)).join('、');
      return `<section class="hr-card ocr-confirm" data-ocr="${esc(r.id)}" data-cat="${esc(r.category)}">
        <h2 class="section-title">${ocrTitle(r.category)}</h2>
        <p class="muted">辨識只供預填，按「確認」才會寫入。${ocrHint(r.category)}</p>
        <form class="inline-grid ocr-form">${ocrFields(r)}</form>
        ${warns ? `<p class="muted">注意：${warns}</p>` : ''}
        <div class="hr-toolbar" style="margin-top:8px"><button class="hr-btn" type="button" data-ocr-ok>確認</button><button class="hr-btn ghost" type="button" data-ocr-skip>略過</button></div>
      </section>`;
    }).join('');
  }
  function piiBlock(e) {
    const pii = e.pii || {};
    const full = pii.account || '';
    const last4 = pii.accountLast4 || (full ? full.slice(-4) : '');
    const masked = last4 ? ('••••' + last4) : '';
    return `<section class="hr-card bank-block" data-bank="${esc(e.id)}">
      <h2 class="section-title">銀行帳戶</h2>
      <p class="muted">完整帳號僅登入的管理員可見，預設先隱藏後四碼以外的數字。資料庫仍加密保存。沒有辨識結果也可以在這裡手動填寫後儲存。</p>
      <form class="inline-grid bank-form">
        ${field('bankCode', '銀行代碼', pii.bankCode || '')}
        ${field('bankBranch', '分行', pii.bankBranch || '')}
        <div class="field account-field"><span>帳號</span>
          <div class="secret-row">
            <input name="account" type="text" autocomplete="off" data-full="${esc(full)}" data-masked="${esc(masked)}" value="${esc(masked)}" ${full ? 'readonly' : ''}>
            <button type="button" class="hr-btn ghost" data-act="toggle-account" ${full ? '' : 'hidden'}>顯示</button>
          </div>
        </div>
        ${field('accountName', '戶名', pii.accountName || '')}
        <div style="grid-column:1/-1"><button class="hr-btn" type="submit">儲存銀行帳戶</button></div>
      </form>
    </section>`;
  }
  function bindOcrCards(root, employeeId, opts = {}) {
    $$('.ocr-confirm', root).forEach((card) => {
      const id = card.dataset.ocr;
      $('[data-ocr-ok]', card).onclick = async () => {
        const f = $('.ocr-form', card);
        const body = Object.fromEntries([...f.querySelectorAll('input,textarea,select')].filter((el) => el.name).map((el) => [el.name, el.value]));
        try {
          await write('/api/hr/ocr-reviews/' + id + '/confirm', 'POST', body);
          toast('已確認並寫入');
          await refresh();
          if (opts.onDone) opts.onDone();
          else paintProfile(root, employeeId);
        } catch (err) { toast(err.message); }
      };
      $('[data-ocr-skip]', card).onclick = async () => {
        try {
          await write('/api/hr/ocr-reviews/' + id + '/dismiss', 'POST', {});
          toast('已略過此次辨識');
          await refresh();
          if (opts.onDone) opts.onDone();
          else paintProfile(root, employeeId);
        } catch (err) { toast(err.message); }
      };
    });
  }
  function bindBankBlock(root, employeeId) {
    const box = $('[data-bank]', root);
    if (!box) return;
    const input = box.querySelector('input[name=account]');
    const btn = $('[data-act="toggle-account"]', box);
    let shown = false;
    if (btn) btn.onclick = () => {
      shown = !shown;
      const full = input.dataset.full || '';
      const masked = input.dataset.masked || '';
      input.value = shown ? full : masked;
      input.readOnly = !shown && Boolean(full);
      btn.textContent = shown ? '隱藏' : '顯示';
    };
    const form = $('.bank-form', box);
    if (!form) return;
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const body = {
        bankCode: form.elements.bankCode.value,
        bankBranch: form.elements.bankBranch.value,
        accountName: form.elements.accountName.value,
      };
      // If the field is still the masked last-4 display, omit account so we do not overwrite the encrypted number.
      const typed = form.elements.account.value.trim();
      const masked = (input.dataset.masked || '').trim();
      if (typed && typed !== masked) body.account = typed;
      try { await write('/api/hr/employees/' + employeeId, 'PATCH', body); toast('已儲存銀行帳戶'); await refresh(); paintProfile(root, employeeId); }
      catch (err) { toast(err.message); }
    };
  }
  async function doBatchBank(root) {
    try {
      const r = await write('/api/hr/ocr/batch-bank', 'POST', {});
      if (r.skipped === 'no-gemini') toast(r.message || '尚未設定 Gemini，無法批次辨識。');
      else toast('已掃描 ' + (r.scanned || 0) + ' 張，待確認 ' + (r.pending || 0) + (r.failed ? '，失敗 ' + r.failed : ''));
      await refresh();
      paintStaff(root);
    } catch (e) { toast(e.message); }
  }


  function docKind(d) {
    const ext = String(d.filename || d.relativePath || '').split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return 'image';
    if (ext === 'pdf') return 'pdf';
    return 'other';
  }
  function placeholderThumb(d) {
    const label = DOC[d.category] || '證件';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320"><rect width="480" height="320" fill="#e8eef2"/><rect x="16" y="16" width="448" height="288" fill="none" stroke="#182c39" stroke-width="4"/><text x="240" y="150" text-anchor="middle" font-size="28" font-family="sans-serif" fill="#182c39">${label}示意</text><text x="240" y="190" text-anchor="middle" font-size="14" font-family="sans-serif" fill="#64717e">示範預覽，非正式檔案</text></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  function fileHref(d) {
    return '/api/hr/documents/' + encodeURIComponent(d.id) + '/file';
  }
  function docRow(d, cat) {
    const kind = docKind(d);
    const pathText = d.displayPath || d.path || ('/volume1/人事資料/' + DOC[cat] + '/' + d.filename);
    let thumb = '';
    if (kind === 'image') {
      const src = demo ? placeholderThumb(d) : fileHref(d);
      thumb = `<button type="button" class="doc-thumb" data-lightbox="${esc(d.id)}" aria-label="放大查看 ${esc(d.filename)}"><img src="${src}" alt="${esc(d.filename)}" loading="lazy"></button>`;
    } else if (kind === 'pdf') {
      thumb = demo
        ? `<button type="button" class="doc-thumb doc-pdf" data-pdf-demo aria-label="PDF ${esc(d.filename)}"><span>PDF</span></button>`
        : `<a class="doc-thumb doc-pdf" href="${esc(fileHref(d))}" target="_blank" rel="noopener" aria-label="開啟 PDF ${esc(d.filename)}"><span>PDF</span></a>`;
    }
    const view = demo
      ? (kind === 'image'
        ? `<button type="button" class="hr-btn ghost" data-lightbox="${esc(d.id)}">查看</button>`
        : `<button type="button" class="hr-btn ghost" data-pdf-demo>查看</button>`)
      : `<a href="${esc(fileHref(d))}" target="_blank" rel="noopener">查看</a>`;
    return `<div class="doc"><div class="doc-main">${thumb}<div class="doc-meta"><div>${esc(d.filename)}</div><div class="path">已存到 ${esc(pathText)}</div>${d.expiresOn ? `<div class="muted">效期 ${esc(d.expiresOn)}</div>` : ''}</div></div>${view}</div>`;
  }
  function employeeImages(employeeId) {
    const order = {identity: 0, bank: 1, license: 2};
    return (state.documents || []).filter((d) => d.employeeId === employeeId && docKind(d) === 'image')
      .sort((a, b) => (order[a.category] ?? 9) - (order[b.category] ?? 9) || String(a.filename).localeCompare(String(b.filename)));
  }
  function bindLightbox(root, employeeId) {
    const box = $('#hr-lightbox', root);
    if (!box) return;
    const img = $('img', box);
    const cap = $('.hr-lightbox-cap', box);
    const list = () => employeeImages(employeeId);
    let idx = 0;
    const show = (i) => {
      const items = list();
      if (!items.length) return close();
      idx = (i + items.length) % items.length;
      const d = items[idx];
      img.src = demo ? placeholderThumb(d) : fileHref(d);
      img.alt = d.filename || '';
      cap.textContent = (DOC[d.category] || '') + '　' + (d.filename || '');
      const many = items.length > 1;
      $$('.hr-lightbox-nav', box).forEach((b) => b.hidden = !many);
      box.hidden = false;
    };
    const close = () => { box.hidden = true; img.removeAttribute('src'); };
    $$('[data-lightbox]', root).forEach((el) => {
      el.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); show(list().findIndex((d) => d.id === el.dataset.lightbox)); });
    });
    $$('[data-pdf-demo]', root).forEach((el) => {
      el.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); toast('示範模式沒有實際 PDF 檔案。'); });
    });
    $$('[data-lb="close"]', box).forEach((el) => el.onclick = close);
    const prev = $('[data-lb="prev"]', box);
    const next = $('[data-lb="next"]', box);
    if (prev) prev.onclick = (ev) => { ev.stopPropagation(); show(idx - 1); };
    if (next) next.onclick = (ev) => { ev.stopPropagation(); show(idx + 1); };
    box.onkeydown = (ev) => {
      if (box.hidden) return;
      if (ev.key === 'Escape') close();
      if (ev.key === 'ArrowLeft') show(idx - 1);
      if (ev.key === 'ArrowRight') show(idx + 1);
    };
    if (document._hrLightboxKey) document.removeEventListener('keydown', document._hrLightboxKey);
    document.addEventListener('keydown', document._hrLightboxKey = (ev) => {
      if (box.hidden) return;
      if (ev.key === 'Escape') { ev.preventDefault(); close(); }
      if (ev.key === 'ArrowLeft') show(idx - 1);
      if (ev.key === 'ArrowRight') show(idx + 1);
    });
  }
  function money(n) {
    return new Intl.NumberFormat('zh-TW', {maximumFractionDigits: 2}).format(Number(n) || 0);
  }
  function salaryBlock(employeeId) {
    const rows = (state.salaries || []).filter((s) => s.employeeId === employeeId).sort((a, b) => String(b.month).localeCompare(String(a.month)));
    const body = rows.map((s) => `<tr>
      <td>${esc(s.month)}</td>
      <td class="num">${money(s.netPay)}</td>
      <td>${esc(s.notes || '—')}</td>
      <td>${s.remittance === '已匯' ? '<span class="pill ok">已匯</span>' : '<span class="pill warn">未匯</span>'}</td>
      <td><button type="button" class="hr-btn ghost" data-sal-edit="${esc(s.id)}">修改</button> <button type="button" class="hr-btn ghost" data-sal-del="${esc(s.id)}">刪除</button></td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">尚無薪資紀錄。</td></tr>';
    return `<h2 class="section-title">薪資</h2>
      <p class="muted">按月登記實發金額與匯款狀態。可用「匯入本月薪資」從打卡算薪水試算表帶入實領金額，不匯入打卡明細。</p>
      <table class="hr-table salary-table"><thead><tr><th>月份</th><th>實發金額</th><th>備註</th><th>匯款狀態</th><th></th></tr></thead><tbody>${body}</tbody></table>
      <div class="hr-toolbar" style="margin-top:8px">
        <button class="hr-btn ghost" data-act="add-salary">＋ 新增薪資紀錄</button>
        <button class="hr-btn ghost" data-act="salary-import">匯入本月薪資</button>
      </div>`;
  }
  function bindSalary(root, employeeId) {
    const open = (existing) => {
      const s = existing || {month: today().slice(0, 7), netPay: '', notes: '', remittance: '未匯'};
      dlg(root, existing ? '修改薪資紀錄' : '新增薪資紀錄',
        field('month', '月份', s.month, 'month') + field('netPay', '實發金額', s.netPay === '' ? '' : s.netPay, 'number') + field('notes', '備註（選填）', s.notes || '') + sel('remittance', '匯款狀態', ['未匯', '已匯'], s.remittance || '未匯'),
        async (f) => {
          const body = {employeeId, month: f.elements.month.value, netPay: f.elements.netPay.value, notes: f.elements.notes.value, remittance: f.elements.remittance.value};
          if (existing) await write('/api/hr/salaries/' + existing.id, 'PATCH', body);
          else await write('/api/hr/salaries', 'POST', body);
          toast('已儲存薪資紀錄');
          await refresh();
          paintProfile(root, employeeId);
        });
    };
    $('[data-act="add-salary"]', root).onclick = () => open(null);
    $('[data-act="salary-import"]', root).onclick = () => openSalaryImport(root);
    $$('[data-sal-edit]', root).forEach((b) => b.onclick = () => open((state.salaries || []).find((s) => s.id === b.dataset.salEdit)));
    $$('[data-sal-del]', root).forEach((b) => b.onclick = async () => {
      if (!confirm('確定刪除這筆薪資紀錄？')) return;
      try { await write('/api/hr/salaries/' + b.dataset.salDel, 'DELETE'); toast('已刪除'); await refresh(); paintProfile(root, employeeId); }
      catch (err) { toast(err.message); }
    });
  }


  const STATUS_LABEL = {new: '新增', changed: '金額變更', same: '相同', unmatched: '對不到員工', ambiguous: '編號對到多人'};
  const baiqiSalaryId = (v) => String(v || '').trim().toUpperCase().replace(/O/g, '0');
  function demoSalaryPreview(body) {
    const month = body.month || '2026-10';
    const sample = [
      {month, employeeId: 'EMP-014', name: '陳志明', netPay: 43000},
      {month, employeeId: 'EMP-001', name: '黃淑芬', netPay: 38000},
      {month, employeeId: 'EMP-015', name: '張偉誠', netPay: 35000},
      {month, employeeId: '0002', name: 'NANA', netPay: 44571},
    ];
    const rows = sample.map((r) => {
      const matches = (state.employees || []).filter((e) => baiqiSalaryId(e.id) === baiqiSalaryId(r.employeeId));
      const emp = matches.length === 1 ? matches[0] : null;
      const existing = emp ? (state.salaries || []).find((s) => s.employeeId === emp.id && s.month === r.month) : null;
      let status = 'unmatched';
      if (matches.length > 1) status = 'ambiguous';
      else if (emp && !existing) status = 'new';
      else if (emp && Number(existing.netPay) !== Number(r.netPay)) status = 'changed';
      else if (emp) status = 'same';
      return {month: r.month, employeeId: emp?.id || r.employeeId, sheetId: r.employeeId, name: emp?.name || r.name, netPay: r.netPay, existingPay: existing ? Number(existing.netPay) : null, status};
    });
    const counts = {new: 0, changed: 0, same: 0, unmatched: 0, ambiguous: 0};
    for (const r of rows) counts[r.status] += 1;
    const today = new Date().toLocaleDateString('en-CA', {timeZone: 'Asia/Taipei'});
    const activeEmployeeCount = (state.employees || []).filter((e) => (!e.arrivalDate || e.arrivalDate <= today) && (!e.departureDate || e.departureDate >= today)).length;
    const warnings = rows.length < activeEmployeeCount ? ['本月彙總列有 ' + rows.length + ' 筆，少於目前在職員工 ' + activeEmployeeCount + ' 人。試算表可能只算了部分部門或個別員工（每次計算會整表覆寫）。確認後只會更新對得到的人，其他人的薪資不會被清空。'] : [];
    return {month, months: [month], columns: {month: '計算月份', employeeId: '員工編號', name: '員工姓名', amount: '實領薪資'}, headers: ['計算月份', '員工編號', '員工姓名', '實領薪資'], rows, counts, skipped: 2, configured: true, summaryCount: rows.length, activeEmployeeCount, warnings};
  }
  async function openSalaryImport(root) {
    if (!$('#hr-dialogs', root)) root.insertAdjacentHTML('beforeend', '<div id="hr-dialogs"></div>');
    const host = $('#hr-dialogs', root);
    const info = state.salaryImport || {};
    const close = () => { host.innerHTML = ''; };
    if (!info.configured && !demo) {
      host.innerHTML = `<dialog class="hr-dlg wide" open><h2>匯入本月薪資</h2><div class="dlg-body"><pre class="setup-help">${esc(info.instructions || '尚未設定 Google 服務帳戶，無法讀取試算表。請在 NAS 的 settings.env 設定 GOOGLE_SA_JSON，並把服務帳戶加成試算表檢視者。')}</pre><div class="hr-toolbar" style="margin-top:12px"><button class="hr-btn ghost" type="button" data-cancel>關閉</button></div></div></dialog>`;
      $('[data-cancel]', host).onclick = close;
      return;
    }
    host.innerHTML = `<dialog class="hr-dlg wide" open><h2>匯入本月薪資</h2><div class="dlg-body"><p class="muted">正在讀取試算表…</p></div></dialog>`;
    try {
      const cols = (info.columns || {month: '計算月份', employeeId: '員工編號', name: '員工姓名', amount: '實領薪資'});
      let data = await write('/api/hr/salaries/import/preview', 'POST', {columns: cols, month: ''});
      const paint = (preview) => {
        const counts = preview.counts || {};
        const months = preview.months || [];
        const columns = preview.columns || cols;
        const rows = preview.rows || [];
        const actionable = rows.filter((r) => r.status === 'new' || r.status === 'changed');
        host.innerHTML = `<dialog class="hr-dlg wide" open><h2>匯入本月薪資</h2>
          <div class="dlg-body">
            <p class="muted">只帶入彙總列的實領薪資（計算月份為 yyyy/mm，員工編號不是打卡列或「—」）。對得到的「新增／金額變更」要按確認才會寫入；金額相同、對不到員工、或編號對到多人的，不會改現有資料。系統內的員工編號不會被改寫。</p>
            <p>計算月份 <strong>${esc(preview.month || '')}</strong>：彙總列 ${preview.summaryCount ?? rows.length} 筆，目前在職員工 ${preview.activeEmployeeCount ?? '—'} 人。${preview.skipped ? '另略過 ' + preview.skipped + ' 列。' : ''}</p>
            ${(preview.warnings || []).map((w) => `<p class="import-warning">${esc(w)}</p>`).join('')}
            <div class="inline-grid">
              <div class="field"><span>月份</span><select name="month">${months.map((m) => `<option ${m === preview.month ? 'selected' : ''}>${esc(m)}</option>`).join('') || `<option>${esc(preview.month || '')}</option>`}</select></div>
              <div class="field"><span>月份欄</span><input name="colMonth" value="${esc(columns.month || '')}"></div>
              <div class="field"><span>員工編號欄</span><input name="colId" value="${esc(columns.employeeId || '')}"></div>
              <div class="field"><span>姓名欄</span><input name="colName" value="${esc(columns.name || '')}"></div>
              <div class="field"><span>金額欄</span><input name="colAmount" value="${esc(columns.amount || '')}"></div>
            </div>
            <p class="muted">新增 ${counts.new || 0}、金額變更 ${counts.changed || 0}、相同 ${counts.same || 0}、對不到員工 ${counts.unmatched || 0}${counts.ambiguous ? '、編號對到多人 ' + counts.ambiguous : ''}。</p>
            <div class="import-table-wrap"><table class="hr-table salary-table"><thead><tr><th>月份</th><th>員工</th><th>金額</th><th>狀態</th></tr></thead>
            <tbody>${rows.map((r) => `<tr class="st-${esc(r.status)}"><td>${esc(r.month)}</td><td>${esc(r.employeeId)} ${esc(r.name || '')}${r.sheetId && r.sheetId !== r.employeeId ? ' <span class="muted">（表上 ' + esc(r.sheetId) + '）</span>' : ''}</td><td class="num">${money(r.netPay)}${r.status === 'changed' && r.existingPay != null ? ' <span class="muted">（現為 ' + money(r.existingPay) + '）</span>' : ''}</td><td><span class="pill ${r.status === 'new' ? 'ok' : r.status === 'changed' ? 'warn' : ''}">${esc(STATUS_LABEL[r.status] || r.status)}</span></td></tr>`).join('') || '<tr><td colspan="4">這個月份沒有可匯入的列。</td></tr>'}</tbody></table></div>
            <div class="hr-toolbar" style="margin-top:12px">
              <button class="hr-btn" type="button" data-confirm ${actionable.length ? '' : 'disabled'}>確認寫入 ${actionable.length} 筆</button>
              <button class="hr-btn ghost" type="button" data-reload>依欄位重新預覽</button>
              <button class="hr-btn ghost" type="button" data-save-map>儲存欄位對應</button>
              <button class="hr-btn ghost" type="button" data-cancel>取消</button>
            </div>
          </div>
        </dialog>`;
        const mapping = () => ({
          month: host.querySelector('[name=colMonth]').value,
          employeeId: host.querySelector('[name=colId]').value,
          name: host.querySelector('[name=colName]').value,
          amount: host.querySelector('[name=colAmount]').value,
        });
        $('[data-cancel]', host).onclick = close;
        $('[name=month]', host).onchange = async () => {
          try { data = await write('/api/hr/salaries/import/preview', 'POST', {month: $('[name=month]', host).value, columns: mapping()}); paint(data); }
          catch (e) { toast(e.message); }
        };
        $('[data-reload]', host).onclick = async () => {
          try { data = await write('/api/hr/salaries/import/preview', 'POST', {month: $('[name=month]', host).value, columns: mapping()}); paint(data); }
          catch (e) { toast(e.message); }
        };
        $('[data-save-map]', host).onclick = async () => {
          try { const saved = await write('/api/hr/settings/salaryImport', 'PATCH', {columns: mapping()}); state.salaryImport = Object.assign({}, state.salaryImport, saved); toast('已儲存欄位對應'); }
          catch (e) { toast(e.message); }
        };
        $('[data-confirm]', host).onclick = async () => {
          try {
            const res = await write('/api/hr/salaries/import/confirm', 'POST', {month: preview.month, rows: actionable});
            toast('已寫入 ' + res.saved + ' 筆薪資' + (res.skipped ? '，略過 ' + res.skipped : ''));
            close();
            await refresh();
            if (route.page === 'profile' && route.id) paintProfile(root, route.id);
            else paintStaff(root);
          } catch (e) { toast(e.message); }
        };
      };
      paint(data);
    } catch (e) {
      host.innerHTML = `<dialog class="hr-dlg wide" open><h2>匯入本月薪資</h2><div class="dlg-body"><pre class="setup-help">${esc(e.message || '讀取失敗')}</pre><div class="hr-toolbar" style="margin-top:12px"><button class="hr-btn ghost" type="button" data-cancel>關閉</button></div></div></dialog>`;
      $('[data-cancel]', host).onclick = close;
    }
  }

  function field(name, label, value, type = 'text') {
    return `<div class="field"><span>${esc(label)}</span><input name="${name}" type="${type}" value="${esc(value || '')}"></div>`;
  }
  function sel(name, label, opts, value) {
    return `<div class="field"><span>${esc(label)}</span><select name="${name}">${opts.map((o) => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
  }
  function bindDrop(box, employeeId, root, opts = {}) {
    const cat = box.dataset.drop;
    const input = $('[data-file]', box);
    box.addEventListener('click', (e) => { if (e.target.closest('a,input,button,.doc,.doc-thumb')) return; input.click(); });
    box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('over'); });
    box.addEventListener('dragleave', () => box.classList.remove('over'));
    box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('over'); if (e.dataTransfer.files[0]) doUpload(employeeId, cat, e.dataTransfer.files[0], root, box, opts); });
    input.addEventListener('change', () => { if (input.files[0]) doUpload(employeeId, cat, input.files[0], root, box, opts); input.value = ''; });
  }
  async function doUpload(employeeId, cat, file, root, box, opts = {}) {
    const exp = box ? $('[data-exp]', box)?.value : '';
    try {
      const saved = await uploadFile(employeeId, cat, file, exp, opts);
      let msg = '已存到 ' + (saved.displayPath || saved.path || saved.filename);
      if (saved.ocr && saved.ocr.skipped === 'no-gemini') msg += '。尚未設定 Gemini，無法自動辨識，請自行核對。';
      else if (saved.ocr && saved.ocr.skipped === 'ocr-error') msg += '。' + (saved.ocr.message || '自動辨識暫時無法使用。');
      else if (saved.ocr && saved.ocr.review) msg += '。已預填辨識結果，請核對後按確認才會寫入。';
      toast(msg);
      await refresh();
      if (opts.onDone) opts.onDone();
      else paintProfile(root, employeeId);
    } catch (e) { toast(e.message); }
  }


  function visibleCands() {
    return (state.candidates || []).filter((c) => !c.archived);
  }
  function candTime(c) {
    const evs = (state.recruitmentEvents || []).filter((e) => e.candidateId === c.id).map((e) => e.created || e.at || '').sort();
    return c.updated || evs[evs.length - 1] || c.created || c.interviewAt || c.followupDate || '';
  }
  function sortNewest(list) {
    return [...list].sort((a, b) => String(candTime(b)).localeCompare(String(candTime(a))) || String(b.id).localeCompare(String(a.id)));
  }
  function confirmDeleteCand(root, id, after) {
    const c = state.candidates.find((x) => x.id === id);
    if (!c) return;
    if (!window.confirm('確定封存「' + c.name + '」？名單上不會再顯示，招募紀錄會保留，需要時可在已封存區塊查看。')) return;
    write('/api/hr/candidates/' + id, 'DELETE', {}).then(async () => {
      toast('已封存 ' + c.name);
      await refresh();
      after();
    }).catch((e) => toast(e.message));
  }

  function paintRecruitment(root) {
    if (route.page === 'candidate' && route.id) return paintCandidate(root, route.id);
    const tday = today();
    const live = visibleCands().filter((c) => match(c, ['name', 'phone', 'department', 'job']) && (!jobFilter.recruitment || String(c.job || '').trim() === jobFilter.recruitment));
    const open = live.filter((c) => OPEN.includes(c.status));
    const todayList = open.filter((c) => c.followupDate === tday);
    const overdue = open.filter((c) => c.followupDate && c.followupDate < tday);
    const cols = ['待聯絡', '待面試', '待回覆', '錄取', '待報到'];
    const card = (c) => `<article class="kanban-item${c.followupDate && c.followupDate < tday ? ' overdue' : ''}" draggable="true" data-open="${esc(c.id)}"><div class="name">${esc(c.name)}</div><div class="meta">${esc(c.department || '')} ${esc(c.job || '')}<br>${esc(c.phone)} ${c.followupDate ? '跟進 ' + esc(c.followupDate) : ''}</div><button type="button" class="hr-btn ghost kanban-del" data-del="${esc(c.id)}" title="封存">封存</button></article>`;
    const closedBlocks = CLOSED.map((s) => {
      const items = sortNewest(live.filter((c) => c.status === s));
      if (!items.length) return '';
      return `<section class="hr-card" style="margin-top:12px"><h2 class="section-title">${esc(s)} <span class="muted">${items.length}</span></h2>
        <div class="cand-list">${items.map((c) => `<div class="cand-row" data-open="${esc(c.id)}"><strong>${esc(c.name)}</strong><span class="muted">${esc(c.department || '')} ${esc(c.job || '')}　${esc(c.phone)}</span><button type="button" class="hr-btn ghost" data-del="${esc(c.id)}">封存</button></div>`).join('')}</div></section>`;
    }).join('');
    const archived = sortNewest((state.candidates || []).filter((c) => c.archived && match(c, ['name', 'phone', 'department', 'job'])));
    const archBlock = archived.length ? `<section class="hr-card" style="margin-top:12px"><h2 class="section-title">已封存 <span class="muted">${archived.length}</span></h2>
      <div class="cand-list muted">${archived.map((c) => `<div class="cand-row"><strong>${esc(c.name)}</strong><span>${esc(c.status)}　${esc((c.archivedAt || '').slice(0, 10))}</span></div>`).join('')}</div></section>` : '';
    root.innerHTML = `
      <div class="hr-grid">
        <div class="hr-card today"><div class="k">今日待聯絡</div><div class="n">${todayList.length}</div></div>
        <div class="hr-card overdue"><div class="k">已過期未跟</div><div class="n">${overdue.length}</div></div>
        <div class="hr-card"><div class="k">進行中</div><div class="n">${open.length}</div></div>
      </div>
      <section class="hr-card" style="margin-bottom:16px">
        <h2 class="section-title">部門補足進度</h2>
        ${(state.recruitmentGoals || []).map((g) => `<div style="margin:8px 0"><div style="display:flex;justify-content:space-between"><strong>${esc(g.department)}</strong><span class="muted">在職 ${g.current}　淨補足 ${g.netFilled}／需求 ${g.required}　${g.percent}%</span></div><div class="progress"><i style="width:${g.percent}%"></i></div></div>`).join('') || '<p class="muted">尚未設定需求。</p>'}
        <div class="hr-toolbar" style="margin-top:10px">
          <button class="hr-btn ghost" data-act="goal">＋ 增加需求人數</button>
          <button class="hr-btn" data-act="add-cand">＋ 新增應徵者</button>
          <button class="hr-btn ghost" data-act="excel">匯入徵人 Excel</button>
          <span class="spacer"></span>
          ${jobFilterSelect(jobFilter.recruitment, 'recruit-job')}
        </div>
      </section>
      <div class="kanban">
        ${cols.map((s) => {
          const raw = live.filter((c) => c.status === s);
          const items = s === '待報到' ? raw : sortNewest(raw);
          return `<div class="kanban-col" data-col="${s}"><h3>${s} <span class="muted">${items.length}</span></h3>${items.map(card).join('')}</div>`;
        }).join('')}
      </div>
      ${closedBlocks}
      ${archBlock}
      <div id="hr-dialogs"></div>`;
    $$('[data-open]', root).forEach((el) => el.onclick = (ev) => {
      if (ev.target.closest('[data-del]')) return;
      const id = el.dataset.open; route = {page: 'candidate', id}; refresh({view: 'candidate', id}).then(() => paintCandidate(root, id));
    });
    $$('[data-del]', root).forEach((el) => el.onclick = (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      confirmDeleteCand(root, el.dataset.del, () => { route = {page: 'list'}; paintRecruitment(root); });
    });
    $$('.kanban-item', root).forEach((el) => {
      el.addEventListener('dragstart', (ev) => ev.dataTransfer.setData('text/plain', el.dataset.open));
    });
    $$('.kanban-col', root).forEach((col) => {
      col.addEventListener('dragover', (ev) => ev.preventDefault());
      col.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        const id = ev.dataTransfer.getData('text/plain');
        const status = col.dataset.col;
        try { await write('/api/hr/candidates/' + id, 'PATCH', {status}); toast('已改為 ' + status); await refresh(); paintRecruitment(root); }
        catch (e) { toast(e.message); }
      });
    });
    $('[data-act="add-cand"]', root).onclick = () => openCandForm(root);
    $('[data-act="goal"]', root).onclick = () => openGoal(root);
    $('[data-act="excel"]', root).onclick = () => openExcel(root, 'recruitment');
    const jobSel = $('[data-job-filter]', root);
    if (jobSel) jobSel.onchange = () => { jobFilter.recruitment = jobSel.value; paintRecruitment(root); };
  }

  function paintCandidate(root, id) {
    const c = state.candidates.find((x) => x.id === id);
    if (!c) { route = {page: 'list'}; return paintRecruitment(root); }
    const evs = state.recruitmentEvents.filter((e) => e.candidateId === id);
    const resumes = (state.documents || []).filter((d) => d.candidateId === id || (d.category === 'resume' && d.employeeId && d.employeeId === c.employeeId));
    const canConvert = !c.employeeId && c.status !== '已報到' && !c.archived;
    root.innerHTML = `
      <div class="hr-toolbar"><button class="hr-btn ghost" data-act="back">← 返回徵人看板</button></div>
      <div class="profile">
        <section class="hr-card">
          <h2 class="section-title">${esc(c.name)} <span class="pill st-${esc(c.status)}">${esc(c.status)}</span>${c.archived ? ' <span class="pill">已封存</span>' : ''}</h2>
          <form id="cand-inline" class="inline-grid">
            ${field('name', '姓名', c.name)}${field('phone', '電話', c.phone)}
            ${field('department', '部門', c.department)}${jobCombo('job', '職缺', c.job)}
            ${field('source', '來源', c.source)}${field('contactPerson', '窗口', c.contactPerson)}
            ${field('availableDate', '可到職', c.availableDate, 'date')}${field('followupDate', '下次跟進', c.followupDate, 'date')}
            ${field('interviewAt', '面試時間', c.interviewAt)}
            ${sel('status', '進度', STATUSES, c.status)}
            ${field('birthDate', '出生年月日', c.birthDate || '', 'date')}${field('nationalId', '身分證字號', c.nationalId || '')}
            ${field('address', '住址', c.address || '')}
            <div class="field" style="grid-column:1/-1"><span>學歷</span><textarea name="education">${esc(c.education || '')}</textarea></div>
            <div class="field" style="grid-column:1/-1"><span>經歷</span><textarea name="experience">${esc(c.experience || '')}</textarea></div>
            <div class="field" style="grid-column:1/-1"><span>備註</span><textarea name="notes">${esc(c.notes)}</textarea></div>
            <div style="grid-column:1/-1"><button class="hr-btn" type="submit">儲存</button> <span class="muted">「已報到」只能透過報到轉員工完成。</span></div>
          </form>
        </section>
        <div class="profile-side">
          <section class="hr-card">
            <h2 class="section-title">快速紀錄</h2>
            <div class="hr-toolbar">
              <button class="hr-btn" data-act="call">記錄電話</button>
              <button class="hr-btn ghost" data-act="iv">記錄面試</button>
            </div>
            <div class="hr-toolbar" style="margin-top:8px;flex-wrap:wrap">
              ${QUICK_STATUSES.map((s) => `<button type="button" class="hr-btn ghost" data-quick="${esc(s)}">${esc(s)}</button>`).join('')}
            </div>
            ${canConvert ? `<button class="hr-btn" data-act="convert" style="width:100%;margin-top:8px">報到並轉為員工</button>` : ''}
            ${c.employeeId ? `<p>已轉為員工 <button class="hr-btn ghost" data-act="goto-emp">${esc(c.employeeId)}</button></p>` : ''}
            ${c.archived ? '' : `<button class="hr-btn ghost" data-act="delete" style="width:100%;margin-top:8px">封存此應徵者</button>`}
          </section>
          ${candidateOcrCards(id)}
          <section class="hr-card">
            <h2 class="section-title">履歷表</h2>
            <p class="muted">面試後可上傳履歷（JPG／PNG／WEBP／PDF）。若已設定 Gemini，會先出現確認卡，按確認才會寫入基本資料。</p>
            <div class="drop" data-drop="resume" style="margin:8px 0">
              <strong>履歷表</strong>
              <div class="muted">拖放或點此選檔（12MB 內）</div>
              <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden data-file="resume">
              ${resumes.map((d) => docRow(d, 'resume')).join('') || ''}
            </div>
          </section>
          <section class="hr-card">
            <h2 class="section-title">聯絡與面試歷程</h2>
            ${evs.map((e) => `<div class="doc"><div>${esc(e.kind === 'phone' ? '電話' : '面試')}　${esc(e.outcome || '')}</div><div class="muted">${esc(e.notes || '')} ${esc(e.created || e.at || '')}</div></div>`).join('') || '<p class="muted">尚無紀錄，可用上方快速記錄。</p>'}
          </section>
        </div>
      </div>
      <div id="hr-dialogs"></div>`;
    $('[data-act="back"]', root).onclick = () => { route = {page: 'list'}; paintRecruitment(root); };
    $('#cand-inline', root).onsubmit = async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const body = Object.fromEntries(['name', 'phone', 'department', 'job', 'source', 'contactPerson', 'availableDate', 'followupDate', 'interviewAt', 'status', 'notes', 'birthDate', 'nationalId', 'address', 'education', 'experience'].map((k) => [k, f.elements[k].value]));
      try { await write('/api/hr/candidates/' + id, 'PATCH', body); toast('已儲存'); await refresh(); paintCandidate(root, id); }
      catch (err) { toast(err.message); }
    };
    $('[data-act="call"]', root).onclick = () => openLog(root, id, 'phone');
    $('[data-act="iv"]', root).onclick = () => openLog(root, id, 'interview');
    $('[data-act="convert"]', root)?.addEventListener('click', () => openConvert(root, id));
    $('[data-act="delete"]', root)?.addEventListener('click', () => confirmDeleteCand(root, id, () => { route = {page: 'list'}; paintRecruitment(root); }));
    $$('[data-quick]', root).forEach((b) => b.onclick = async () => {
      try {
        await write('/api/hr/candidates/' + id, 'PATCH', {status: b.dataset.quick});
        toast('已改為 ' + b.dataset.quick);
        await refresh();
        paintCandidate(root, id);
      } catch (e) { toast(e.message); }
    });
    $('[data-act="goto-emp"]', root)?.addEventListener('click', () => {
      route = {page: 'profile', id: c.employeeId};
      ctx.view = 'staff';
      if (ctx.go) ctx.go('staff', {keepRoute: true});
      else paintProfile(root, c.employeeId);
    });
    const drop = $('[data-drop="resume"]', root);
    if (drop) bindDrop(drop, '', root, {candidateId: id, onDone: () => paintCandidate(root, id)});
    bindOcrCards(root, '', {candidateId: id, onDone: () => paintCandidate(root, id)});
  }

  function ensureDialogs(root) {
    if (!$('#hr-dialogs', root)) root.insertAdjacentHTML('beforeend', '<div id="hr-dialogs"></div>');
    return $('#hr-dialogs', root);
  }
  function showFormError(form, msg, fieldName) {
    let el = form.querySelector('.hr-form-error');
    if (!el) {
      el = document.createElement('p');
      el.className = 'hr-form-error';
      el.setAttribute('role', 'alert');
      const actions = form.querySelector('.dlg-actions');
      if (actions) actions.before(el);
      else form.appendChild(el);
    }
    el.textContent = msg;
    if (fieldName && form.elements[fieldName]) {
      form.elements[fieldName].setAttribute('aria-invalid', 'true');
      form.elements[fieldName].focus();
    }
  }
  function dlg(root, title, inner, onsubmit) {
    const host = ensureDialogs(root);
    host.innerHTML = `<dialog class="hr-dlg"><h2>${esc(title)}</h2><form class="dlg-body"><div class="dlg-fields">${inner}</div><p class="hr-form-error" role="alert" hidden></p><div class="dlg-actions hr-toolbar"><button class="hr-btn" type="submit">確定</button><button class="hr-btn ghost" type="button" data-cancel>取消</button></div></form></dialog>`;
    const box = $('dialog', host);
    const form = $('form', host);
    const close = () => { try { box.close(); } catch {} host.innerHTML = ''; };
    $('[data-cancel]', host).onclick = close;
    box.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const err = form.querySelector('.hr-form-error');
      if (err) { err.hidden = true; err.textContent = ''; }
      const btn = form.querySelector('[type="submit"]');
      if (btn) btn.disabled = true;
      try {
        await onsubmit(form);
        close();
      } catch (ex) {
        const msg = ex.message || '操作失敗';
        if (err) { err.hidden = false; err.textContent = msg; }
        toast(msg);
        if (btn) btn.disabled = false;
      }
    };
    bindDeptJob(form);
    if (typeof box.showModal === 'function') box.showModal();
    else box.setAttribute('open', '');
  }
  function openEmpForm(root) {
    if (!$('#hr-dialogs', root)) root.insertAdjacentHTML('beforeend', '<div id="hr-dialogs"></div>');
    dlg(root, '新增員工', field('name', '姓名', '') + deptCombo('department', '部門', '') + jobCombo('job', '職稱', '') + sel('employmentType', '雇用型態', TYPES, '正職') + sel('payType', '計薪型態', PAY_TYPES, '正職') + sel('paymentMethod', '匯款類型', PAY_METHODS, '匯款') + field('phone', '電話', '') + field('lineId', 'LINE ID', '') + field('arrivalDate', '到職日', today(), 'date'), async (f) => {
      const body = Object.fromEntries(['name', 'department', 'job', 'employmentType', 'payType', 'paymentMethod', 'phone', 'lineId', 'arrivalDate'].map((k) => [k, f.elements[k].value]));
      const row = await write('/api/hr/employees', 'POST', body);
      toast('已新增 ' + row.id); await refresh(); route = {page: 'profile', id: row.id}; paintProfile(root, row.id);
    });
  }
  function openCandForm(root) {
    if (!$('#hr-dialogs', root)) root.insertAdjacentHTML('beforeend', '<div id="hr-dialogs"></div>');
    dlg(root, '新增應徵者', field('name', '姓名', '') + field('phone', '電話', '') + deptCombo('department', '部門', '') + jobCombo('job', '職缺', '') + field('source', '來源', '') + field('followupDate', '下次跟進', today(), 'date'), async (f) => {
      const body = Object.fromEntries(['name', 'phone', 'department', 'job', 'source', 'followupDate'].map((k) => [k, f.elements[k].value]));
      if (!String(body.name || '').trim()) {
        showFormError(f, '請填寫應徵者姓名', 'name');
        throw new Error('請填寫應徵者姓名');
      }
      body.status = '待聯絡';
      const row = await write('/api/hr/candidates', 'POST', body);
      toast('已新增應徵者'); await refresh({view: 'candidate', id: row.id}); route = {page: 'candidate', id: row.id}; paintCandidate(root, row.id);
    });
  }
  function openLog(root, id, kind) {
    const outcomes = kind === 'phone' ? PHONE : INTERVIEW;
    dlg(root, kind === 'phone' ? '記錄電話' : '記錄面試',
      sel('outcome', '結果', outcomes, outcomes[0]) + field('contactPerson', '窗口', '') + field('notes', '備註', '') + field('nextFollowup', '下次跟進', today(), 'date') + (kind === 'phone' ? field('nextInterviewAt', '若約定面試，時間', '') : ''),
      async (f) => {
        await write('/api/hr/candidates/' + id + '/events', 'POST', {kind, outcome: f.elements.outcome.value, contactPerson: f.elements.contactPerson.value, notes: f.elements.notes.value, nextFollowup: f.elements.nextFollowup.value, nextInterviewAt: f.elements.nextInterviewAt?.value || ''});
        toast('已記錄'); await refresh(); paintCandidate(root, id);
      });
  }
  function openConvert(root, id) {
    const c = state.candidates.find((x) => x.id === id);
    const choices = prefixChoicesFor(c.department);
    const preview = nextEmpId(c.department, choices[0]);
    dlg(root, '報到並轉為員工',
      `<p class="muted">員工編號依打卡計薪規則自動給「部門字首＋流水號」（物流 D、摺疊 F、撐開 H、洗滌 W／E、辦公室／行政 O）。既有編號原樣保留。預覽：<strong>${esc(preview || '請選擇字首')}</strong>。並帶入報到清單。</p>` + deptCombo('department', '部門', c.department) + `<div class="field"><span>編號字首</span><select name="prefix">${choices.map((p) => `<option>${p}</option>`).join('')}</select></div>` + jobCombo('job', '職稱', c.job, c.department) + sel('employmentType', '雇用型態', TYPES, '正職') + sel('payType', '計薪型態', PAY_TYPES, '正職') + sel('paymentMethod', '匯款類型', PAY_METHODS, '匯款') + field('lineId', 'LINE ID', '') + field('arrivalDate', '到職日', c.availableDate || today(), 'date') + field('phone', '電話', c.phone),
      async (f) => {
        const body = Object.fromEntries(['department', 'job', 'employmentType', 'payType', 'paymentMethod', 'lineId', 'arrivalDate', 'phone', 'prefix'].map((k) => [k, f.elements[k].value]));
        const r = await write('/api/hr/candidates/' + id + '/convert', 'POST', body);
        toast('已轉為 ' + r.employee.id);
        await refresh();
        route = {page: 'profile', id: r.employee.id};
        ctx.view = 'staff';
        if (ctx.go) ctx.go('staff', {keepRoute: true});
        else paintProfile(root, r.employee.id);
      });
  }
  function openGoal(root) {
    if (!$('#hr-dialogs', root)) root.insertAdjacentHTML('beforeend', '<div id="hr-dialogs"></div>');
    dlg(root, '增加徵人需求', deptCombo('department', '部門', '') + field('additional', '要再補幾人', '1', 'number') + field('notes', '備註', ''), async (f) => {
      await write('/api/hr/goals', 'POST', {department: f.elements.department.value, additional: Number(f.elements.additional.value), notes: f.elements.notes.value});
      toast('已更新需求'); await refresh(); paintRecruitment(root);
    });
  }

  function leaveBlock(e) {
    const years = (state.leaveYears || []).filter((y) => y.employeeId === e.id).sort((a, b) => b.startsOn.localeCompare(a.startsOn));
    const t = today();
    const current = years.find((y) => y.startsOn <= t && t <= y.endsOn) || years[0];
    const history = years.filter((y) => current && y.id !== current.id);
    const entriesOf = (id) => (state.leaveEntries || []).filter((x) => x.leaveYearId === id).sort((a, b) => b.takenOn.localeCompare(a.takenOn));
    const yearHtml = (y, isCurrent) => {
      const entries = entriesOf(y.id);
      return `<div class="doc" style="align-items:flex-start;flex-direction:column">
        <div style="width:100%;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <div><strong>${isCurrent ? '本年度（到職日週年）' : '過往年度'}</strong><div class="muted">${esc(y.startsOn)} ～ ${esc(y.endsOn)}</div>
          <div style="margin-top:6px;font-size:16px">${esc(y.summary)}</div>
          <div class="muted">法定應有 ${esc(y.statutory)} 天${y.entitledSource === 'manual' ? '；已手動調整為 ' + esc(y.entitled) + ' 天' : ''}${y.settledOn ? '　結算日 ' + esc(y.settledOn) + '　經手 ' + esc(y.settledBy || '') : ''}</div></div>
          <div>${y.status === '未結算' ? `<button class="hr-btn ghost" data-leave-entry="${esc(y.id)}">＋ 登記請假</button> <button class="hr-btn ghost" data-leave-override="${esc(y.id)}">調整應有天數</button> <button class="hr-btn" data-leave-settle="${esc(y.id)}">結算</button>` : `<span class="pill">${esc(y.status)}</span>`}</div>
        </div>
        ${entries.length ? `<table class="hr-table" style="margin-top:8px"><thead><tr><th>日期</th><th>天數</th><th>備註</th><th></th></tr></thead><tbody>${entries.map((en) => `<tr><td>${esc(en.takenOn)}</td><td>${esc(en.days)}</td><td>${esc(en.notes || '')}</td><td>${y.status === '未結算' ? `<button class="hr-btn ghost" data-leave-del="${esc(en.id)}">刪除</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted" style="margin-top:8px">尚無請假紀錄。</p>'}
      </div>`;
    };
    return `<h2 class="section-title">特休台帳</h2>
      <p class="muted">特休年度以到職日週年計算（勞基法第 38 條自動核給；可手動調整）。請假可登記 0.5 天。結算只記狀態、日期與經手人，不記金額；年度結束未休完時，預設為「未休完已折現」。</p>
      ${!e.arrivalDate ? '<p class="muted">尚未填到職日，無法核給特休。</p>' : (current ? yearHtml(current, true) : '<p class="muted">到職未滿六個月，尚未核給特休。</p>')}
      ${history.length ? `<h3 class="section-title" style="margin-top:12px">歷年紀錄</h3>${history.map((y) => yearHtml(y, false)).join('')}` : ''}`;
  }
  function bindLeave(root, employeeId) {
    $$('[data-leave-entry]', root).forEach((b) => b.onclick = () => openLeaveEntry(root, employeeId, b.dataset.leaveEntry));
    $$('[data-leave-override]', root).forEach((b) => b.onclick = () => openLeaveOverride(root, employeeId, b.dataset.leaveOverride));
    $$('[data-leave-settle]', root).forEach((b) => b.onclick = () => openLeaveSettle(root, employeeId, b.dataset.leaveSettle));
    $$('[data-leave-del]', root).forEach((b) => b.onclick = async () => {
      try { await write('/api/hr/leave-entries/' + b.dataset.leaveDel, 'DELETE'); toast('已刪除'); await refresh(); paintProfile(root, employeeId); }
      catch (e) { toast(e.message); }
    });
  }
  function openLeaveEntry(root, employeeId, leaveYearId) {
    dlg(root, '登記請假', field('takenOn', '日期', today(), 'date') + field('days', '天數（可 0.5）', '1', 'number') + field('notes', '備註', ''), async (f) => {
      await write('/api/hr/leave-entries', 'POST', {employeeId, leaveYearId, takenOn: f.elements.takenOn.value, days: Number(f.elements.days.value), notes: f.elements.notes.value});
      toast('已登記請假'); await refresh(); paintProfile(root, employeeId);
    });
  }
  function openLeaveOverride(root, employeeId, id) {
    const y = state.leaveYears.find((x) => x.id === id);
    dlg(root, '調整應有天數', `<p class="muted">法定應有 ${esc(y.statutory)} 天。調整後仍以你輸入的天數為準。</p>` + field('entitled', '應有天數', y.entitled, 'number'), async (f) => {
      await write('/api/hr/leave-years/' + id, 'PATCH', {entitled: Number(f.elements.entitled.value)});
      toast('已調整應有天數'); await refresh(); paintProfile(root, employeeId);
    });
  }
  function openLeaveSettle(root, employeeId, id) {
    const y = state.leaveYears.find((x) => x.id === id);
    const def = Number(y.remaining) <= 0 ? '已休完' : '未休完已折現';
    dlg(root, '結算特休年度',
      `<p class="muted">${esc(y.summary)}。未休完時預設「未休完已折現」（公司慣例）；仍可改為遞延到明年或已休完。只記錄狀態、結算日與經手人，不登記金額。</p>`
      + `<div class="field"><span>結算狀態</span><select name="status">${['未休完已折現', '遞延到明年', '已休完'].map((s) => `<option ${s === def ? 'selected' : ''}>${s}</option>`).join('')}</select></div>`
      + field('settledOn', '結算日期', today(), 'date') + field('settledBy', '經手人', '') + field('notes', '備註', ''),
      async (f) => {
        await write('/api/hr/leave-years/' + id + '/settle', 'POST', {status: f.elements.status.value, settledOn: f.elements.settledOn.value, settledBy: f.elements.settledBy.value, notes: f.elements.notes.value});
        toast('已結算'); await refresh(); paintProfile(root, employeeId);
      });
  }

  function openRecord(root, employeeId, kind) {
    const title = {leave: '新增特休', insurance: '新增保險紀錄', change: '新增人事異動'}[kind];
    let fields = field('date', '日期', today(), 'date') + field('note', '備註', '');
    if (kind === 'leave') fields = field('year', '年度', String(new Date().getFullYear()), 'number') + field('days', '給假天數', '', 'number') + field('used', '已用天數', '0', 'number') + field('note', '備註', '');
    if (kind === 'insurance') fields = field('date', '日期', today(), 'date') + sel('labor', '勞保', ['加保', '退保', '異動', '—'], '加保') + sel('health', '健保', ['加保', '退保', '異動', '—'], '加保') + field('note', '備註', '');
    if (kind === 'change') fields = field('date', '日期', today(), 'date') + field('title', '異動摘要', '') + field('note', '備註', '');
    dlg(root, title, fields, async (f) => {
      const body = {kind, employeeId};
      [...f.elements].forEach((el) => { if (el.name) body[el.name] = el.value; });
      await write('/api/hr/records', 'POST', body);
      toast('已新增'); await refresh(); paintProfile(root, employeeId);
    });
  }
  async function doScan(root) {
    if (demo) { toast('示範模式不掃描本機資料夾；正式環境會掃描 NAS 指定路徑並自動配對。'); return; }
    try {
      const r = await write('/api/hr/documents/scan', 'POST', {});
      toast('已掃描 ' + r.count + ' 個檔案');
      await refresh();
      paintStaff(root);
    } catch (e) { toast(e.message); }
  }
  function openExcel(root, kind) {
    if (!$('#hr-dialogs', root)) root.insertAdjacentHTML('beforeend', '<div id="hr-dialogs"></div>');
    const extra = kind === 'recruitment' ? field('start', '起始日', '2026-07-01', 'date') + field('end', '結束日', today(), 'date') : '';
    dlg(root, kind === 'recruitment' ? '匯入徵人 Excel' : '匯入特休 Excel', extra + `<div class="field"><span>檔案（.xlsx / .xls）</span><input type="file" name="file" accept=".xlsx,.xls,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></div>`, async (f) => {
      const file = f.elements.file.files[0];
      if (!file) throw new Error('請選擇檔案');
      if (demo) { toast('示範模式不寫入 Excel；請在 NAS 正式環境匯入。'); return; }
      const fd = new FormData();
      fd.append('file', file);
      if (kind === 'recruitment') { fd.append('start', f.elements.start.value); fd.append('end', f.elements.end.value); }
      const previewPath = kind === 'recruitment' ? '/api/hr/recruitment/excel/preview' : '/api/hr/leave/excel/preview';
      const importPath = kind === 'recruitment' ? '/api/hr/recruitment/excel/import' : '/api/hr/leave/excel/import';
      const prev = await fetch(previewPath, {method: 'POST', credentials: 'same-origin', headers: ctx.csrf ? {'X-CSRF-Token': ctx.csrf} : {}, body: fd});
      const data = await prev.json();
      if (!prev.ok) throw new Error(data.error || '預覽失敗');
      const rows = data.rows || data;
      const ok = confirm('預覽 ' + (Array.isArray(rows) ? rows.length : JSON.stringify(data).slice(0, 80)) + ' 筆，確定匯入？');
      if (!ok) return;
      await write(importPath, 'POST', {rows: Array.isArray(rows) ? rows : (data.items || [])});
      toast('已匯入'); await refresh(); kind === 'recruitment' ? paintRecruitment(root) : paintStaff(root);
    });
  }

  window.CompanyHr = {
    render,
    renderHome,
    onNavigate,
    resetDemo() { localStorage.removeItem(KEY); state = seed(); saveDemo(); },
  };
})();
