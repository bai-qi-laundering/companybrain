/** Employee IDs for the 打卡算薪水 sheet: department letter + number (D001, F113). */
export const DEFAULT_DEPT_PREFIXES = {
  物流: 'D',
  摺疊: 'F',
  撐開: 'H',
  洗滌: 'W', // existing sheet also uses E for 洗滌; pick on convert
  洗滓: 'W', // typo alias kept so older stored maps and records still resolve
  辦公室: 'O',
  行政: 'O',
};

/** Departments that may use more than one prefix. */
export const DEPT_PREFIX_CHOICES = {
  洗滌: ['W', 'E'],
  洗滓: ['W', 'E'],
};

/** Standard 職稱／職缺 options. Merged with titles already in employee and candidate records. */
export const STANDARD_JOBS = ['司機', '物流助理', '洗滌', '摺疊', '撐開', '行政', '會計', '廠務', '客服對帳'];

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
