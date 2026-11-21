/** Employee IDs for the 打卡算薪水 sheet: department letter + number (D001, F113). */
export const DEFAULT_DEPT_PREFIXES = {
  物流: 'D',
  摺疊: 'F',
  撐開: 'H',
  洗滌: 'W', // E004 is a legacy 洗滌 number; new numbers are always W
  洗滓: 'W', // typo alias kept so older stored maps and records still resolve
  辦公室: 'O',
  行政: 'O',
};

/** Departments that may use more than one prefix. */
export const DEPT_PREFIX_CHOICES = {
  洗滌: ['W'],
  洗滓: ['W'],
};

/**
 * Official 部門／職稱 from the payroll sheet「部門預設值」
 * (spreadsheet 1DkB-tDXzO6PsUuyUE2EPO9e_7IjKYt2ZxlsUJfwdZxo), in sheet order.
 * GAS seeds (BAIQI_ROLE_SEEDS_) are only used when that tab is first created;
 * the live tab is the source of truth. Title dropdowns in the sheet use
 * requireValueInList(..., true) with setAllowInvalid(true), so free text stays
 * a fallback. 員工編號 prefixes come from the same workbook's 員工資料.
 */
export const STANDARD_DEPARTMENT_JOBS = [
  ['辦公室', '行政'],
  ['洗滌', '洗滌人員'],
  ['摺疊', '現場作業員'],
  ['撐開', '現場作業員'],
  ['物流', '新進司機'],
  ['物流', '司機'],
  ['摺疊', '作業員'],
  ['撐開', '作業員'],
  ['洗滌', '早班作業員'],
];
export const STANDARD_DEPARTMENTS = [...new Set(STANDARD_DEPARTMENT_JOBS.map((row) => row[0]))];
export const STANDARD_JOBS = [...new Set(STANDARD_DEPARTMENT_JOBS.map((row) => row[1]))];
export const DEPARTMENT_JOBS = STANDARD_DEPARTMENT_JOBS.reduce((map, [dept, job]) => {
  if (!map[dept]) map[dept] = [];
  if (!map[dept].includes(job)) map[dept].push(job);
  return map;
}, {});

/** Titles allowed for a department, official sheet order. Unknown depts get the full official list. */
export function jobsForDepartment(department, extra = []) {
  const canon = normalizeDepartment(department);
  const official = (canon && DEPARTMENT_JOBS[canon]) ? DEPARTMENT_JOBS[canon] : STANDARD_JOBS;
  return mergeJobTitles(official, extra);
}

/**
 * 部門預設值 also has 兼職／兼職 (時薪, not split by department). On 轉員工 a part-timer keeps the work area as
 * 部門 in companybrain (it decides the 編號 letter) but is written to the sheet as 部門 兼職、職稱 兼職.
 */
export const PART_TIME_PROFILE = ['兼職', '兼職'];

/**
 * 轉員工 must use a 部門＋職稱 pair from 部門預設值 so reselecting in the sheet applies the same pay.
 * Blank 職稱 is allowed (written blank, filled later). Returns an error message or ''.
 */
export function convertProfileError({department, job, payType}) {
  if (payType === '兼職') return '';
  const d = normalizeDepartment(department) === '行政' ? '辦公室' : normalizeDepartment(department);
  const j = String(job || '').trim();
  if (d && !STANDARD_DEPARTMENTS.includes(d)) return '部門必須是試算表「部門預設值」的部門：' + STANDARD_DEPARTMENTS.join('、');
  if (!j) return '';
  if (!d) return '請先選部門';
  if (!STANDARD_DEPARTMENT_JOBS.some(([a, b]) => a === d && b === j)) return '「' + d + '」的職稱必須是：' + (DEPARTMENT_JOBS[d] || []).join('、');
  return '';
}

export const PAY_TYPES = ['正職', '兼職'];
export const PAYMENT_METHODS = ['匯款', '現金'];

/** Auto-generated IDs look like D001 / F113. */
export const AUTO_ID_RE = /^[A-Z]{1,3}\d{1,6}$/;
/** Existing IDs from the old HR / sheet are kept verbatim (letters, digits, _-). */
export const EXISTING_ID_RE = /^[A-Z0-9_-]{1,32}$/;

export function normalizePrefix(value) {
  return String(value || '').trim().toUpperCase();
}

/** Map the typo 洗滓 to 洗滌; other departments are trimmed only. */
export function normalizeDepartment(department) {
  const d = String(department || '').trim();
  return d === '洗滓' ? '洗滌' : d;
}

export function prefixForDepartment(department, map = DEFAULT_DEPT_PREFIXES) {
  const d = String(department || '').trim();
  if (!d) return '';
  if (map[d]) return map[d];
  const canon = normalizeDepartment(d);
  if (map[canon]) return map[canon];
  if (canon === '洗滌' && (map['洗滌'] || map['洗滓'])) return map['洗滌'] || map['洗滓'];
  const key = Object.keys(map).find((k) => k === d || k === canon || d.includes(k) || canon.includes(k) || k.includes(d) || k.includes(canon));
  return key ? map[key] : '';
}

export function prefixChoices(department, map = DEFAULT_DEPT_PREFIXES) {
  const d = String(department || '').trim();
  const canon = normalizeDepartment(d);
  if (DEPT_PREFIX_CHOICES[d]) return DEPT_PREFIX_CHOICES[d];
  if (DEPT_PREFIX_CHOICES[canon]) return DEPT_PREFIX_CHOICES[canon];
  const p = prefixForDepartment(department, map);
  return p ? [p] : [];
}

export function mergeJobTitles(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const raw of list || []) {
      const v = String(raw || '').trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

export function jobTitleOptions(employees = [], candidates = [], extra = []) {
  const fromData = [...employees, ...candidates].flatMap((row) => [row?.job, row?.desiredPosition]);
  return mergeJobTitles(STANDARD_JOBS, extra, fromData);
}

export function nextPrefixedId(prefix, existingIds, width = 3) {
  const p = normalizePrefix(prefix);
  if (!p || !/^[A-Z]{1,3}$/.test(p)) throw new Error('部門字首不正確');
  const re = new RegExp('^' + p + '(\\d+)$', 'i');
  let max = 0, seenWidth = width;
  for (const id of existingIds) {
    const m = String(id).match(re);
    if (m) {
      max = Math.max(max, parseInt(m[1], 10));
      seenWidth = Math.max(seenWidth, m[1].length);
    }
  }
  return p + String(max + 1).padStart(Math.max(width, seenWidth), '0');
}

export function isUsableEmployeeId(id) {
  const v = String(id || '').trim().toUpperCase();
  return EXISTING_ID_RE.test(v);
}
