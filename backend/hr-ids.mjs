/** Employee IDs for the 打卡算薪水 sheet: department letter + number (D001, F113). */
export const DEFAULT_DEPT_PREFIXES = {
  物流: 'D',
  摺疊: 'F',
  撐開: 'H',
  洗滓: 'W', // existing sheet also uses E for 洗滓; pick on convert
  辦公室: 'O',
  行政: 'O',
};

/** Departments that may use more than one prefix. */
export const DEPT_PREFIX_CHOICES = {
  洗滓: ['W', 'E'],
};

export const PAY_TYPES = ['正職', '兼職'];
export const PAYMENT_METHODS = ['匯款', '現金'];

/** Auto-generated IDs look like D001 / F113. */
export const AUTO_ID_RE = /^[A-Z]{1,3}\d{1,6}$/;
/** Existing IDs from the old HR / sheet are kept verbatim (letters, digits, _-). */
export const EXISTING_ID_RE = /^[A-Z0-9_-]{1,32}$/;

export function normalizePrefix(value) {
  return String(value || '').trim().toUpperCase();
}

export function prefixForDepartment(department, map = DEFAULT_DEPT_PREFIXES) {
  if (!department) return '';
  if (map[department]) return map[department];
  const key = Object.keys(map).find((k) => k === department || department.includes(k) || k.includes(department));
  return key ? map[key] : '';
}

export function prefixChoices(department, map = DEFAULT_DEPT_PREFIXES) {
  if (DEPT_PREFIX_CHOICES[department]) return DEPT_PREFIX_CHOICES[department];
  const p = prefixForDepartment(department, map);
  return p ? [p] : [];
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
