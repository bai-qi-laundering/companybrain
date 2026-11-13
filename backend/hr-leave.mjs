/** Taiwan LSA Art. 38 annual leave, default leave year = hire-date anniversary. */
export const SETTLEMENTS = ['未結算', '已休完', '未休完已折現', '遞延到明年'];
export const DEFAULT_SETTLEMENT = '未休完已折現';
export const DEFAULT_BASIS = 'anniversary';
export const EXPIRY_SOON_DAYS = 60;

function pad(n) { return String(n).padStart(2, '0'); }
export function iso(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }

export function parseIso(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return {y, m, d};
}

export function addYears(date, n) {
  const p = parseIso(date);
  if (!p) return '';
  const last = new Date(Date.UTC(p.y + n, p.m, 0)).getUTCDate();
  return iso(p.y + n, p.m, Math.min(p.d, last));
}
export function addMonths(date, n) {
  const p = parseIso(date);
  if (!p) return '';
  const dt = new Date(Date.UTC(p.y, p.m - 1 + n, 1));
  const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return iso(y, m, Math.min(p.d, last));
}
export function addDays(date, n) {
  const p = parseIso(date);
  if (!p) return '';
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
export function dayBefore(date) { return addDays(date, -1); }

export function completedYears(hire, onDate) {
  if (!parseIso(hire) || !parseIso(onDate) || onDate < hire) return 0;
  let n = 0;
  while (addYears(hire, n + 1) <= onDate) n += 1;
  return n;
}
export function completedMonths(hire, onDate) {
  if (!parseIso(hire) || !parseIso(onDate) || onDate < hire) return 0;
  let n = 0;
  while (addMonths(hire, n + 1) <= onDate) n += 1;
  return n;
}

/** Statutory days at the start of a leave year (LSA Art. 38). */
export function statutoryDays(hire, leaveYearStart) {
  if (!parseIso(hire) || !parseIso(leaveYearStart)) return 0;
  if (leaveYearStart < addMonths(hire, 6)) return 0;
  const years = completedYears(hire, leaveYearStart);
  if (years < 1) return 3;
  if (years < 2) return 7;
  if (years < 3) return 10;
  if (years < 5) return 14;
  if (years < 10) return 15;
  return Math.min(30, 15 + (years - 9));
}

export function hoursToDays(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n / 8) * 1000) / 1000;
}

/**
 * Enumerate leave years from first grant (6 months) through the year containing asOf.
 * basis: 'anniversary' (default, confirmed) or 'calendar'.
 */
export function enumerateLeaveYears(hire, asOf, basis = DEFAULT_BASIS) {
  if (!parseIso(hire) || !parseIso(asOf) || asOf < hire) return [];
  if (basis === 'calendar') return enumerateCalendar(hire, asOf);
  const first = addMonths(hire, 6);
  if (asOf < first) return [];
  const years = [];
  const firstEnd = dayBefore(addYears(hire, 1));
  years.push(yearRow(first, firstEnd));
  let n = 1;
  for (;;) {
    const start = addYears(hire, n);
    if (start > asOf) break;
    years.push(yearRow(start, dayBefore(addYears(hire, n + 1))));
    n += 1;
    if (n > 80) break;
  }
  return years;
}

function enumerateCalendar(hire, asOf) {
  const first = addMonths(hire, 6);
  if (asOf < first) return [];
  const years = [];
  const startY = Number(first.slice(0, 4));
  const endY = Number(asOf.slice(0, 4));
  for (let y = startY; y <= endY; y++) {
    const start = iso(y, 1, 1);
    const end = iso(y, 12, 31);
    const grantOn = first > start && first <= end ? first : (start >= first ? start : first);
    if (grantOn > asOf && y === endY && first > asOf) continue;
    const statutory = statutoryDays(hire, grantOn < first ? first : (start < first ? first : start));
    years.push({yearKey: String(y), startsOn: start < first ? first : start, endsOn: end, statutory});
  }
  return years;
}

function yearRow(start, end, hireForStat) {
  return {yearKey: start, startsOn: start, endsOn: end, statutory: statutoryDays(hireForStat || guessHire(start, end), start)};
}

function guessHire(start, end) {
  // For anniversary years, 6-month period ends the day before 1st anniversary,
  // so hire = addMonths(start, -6). Full years: hire = start shifted back by tenure years — statutoryDays uses hire+start.
  // Caller should pass hire; this fallback only used if missing. We recompute below with hire.
  return addMonths(start, -6);
}

export function yearsForEmployee(hire, asOf, basis = DEFAULT_BASIS) {
  if (!parseIso(hire) || !parseIso(asOf)) return [];
  if (basis === 'calendar') return enumerateLeaveYears(hire, asOf, 'calendar');
  const first = addMonths(hire, 6);
  if (asOf < first) return [];
  const out = [];
  const firstEnd = dayBefore(addYears(hire, 1));
  out.push({yearKey: first, startsOn: first, endsOn: firstEnd, statutory: statutoryDays(hire, first)});
  let n = 1;
  for (;;) {
    const start = addYears(hire, n);
    if (start > asOf) break;
    out.push({yearKey: start, startsOn: start, endsOn: dayBefore(addYears(hire, n + 1)), statutory: statutoryDays(hire, start)});
    n += 1;
    if (n > 80) break;
  }
  return out;
}

export function yearContaining(hire, date, basis = DEFAULT_BASIS) {
  return yearsForEmployee(hire, date, basis).find((y) => y.startsOn <= date && date <= y.endsOn) || null;
}

/** Map a free-text old-HR period like「2026週年」to a leave year start. */
export function parsePeriod(period, hire, recordDate, basis = DEFAULT_BASIS) {
  const text = String(period || '').trim();
  const m = text.match(/(\d{4})/);
  if (m && parseIso(hire)) {
    const y = Number(m[1]);
    const all = yearsForEmployee(hire, iso(Math.max(y + 1, Number((recordDate || '').slice(0, 4) || y) + 1), 12, 31), basis);
    const hit = all.find((row) => row.startsOn.startsWith(String(y)) || (basis === 'calendar' && row.yearKey === String(y)));
    if (hit) return hit;
  }
  if (parseIso(recordDate) && parseIso(hire)) return yearContaining(hire, recordDate, basis);
  return null;
}

export function decorateYear(year, entries = []) {
  const used = Math.round(entries.filter((e) => e.leaveYearId === year.id || e.leave_year_id === year.id)
    .reduce((n, e) => n + Number(e.days || 0), 0) * 1000) / 1000;
  const entitled = Number(year.entitled);
  const carried = Number(year.carriedIn ?? year.carried_in ?? 0);
  const remaining = Math.round((entitled + carried - used) * 1000) / 1000;
  return {
    ...year,
    carriedIn: carried,
    used,
    remaining,
    summary: summaryLine({entitled, carried, used, remaining, status: year.status}),
  };
}

export function summaryLine({entitled, carried, used, remaining, status}) {
  const grant = carried ? `${fmt(entitled)} 天 + 遞延 ${fmt(carried)} 天` : `${fmt(entitled)} 天`;
  return `${grant}，用了 ${fmt(used)} 天，剩 ${fmt(remaining)} 天，${status || '未結算'}`;
}

function fmt(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0';
  return String(Math.round(x * 1000) / 1000);
}

export function defaultSettlement(remaining) {
  return Number(remaining) <= 0 ? '已休完' : DEFAULT_SETTLEMENT;
}

export function endingSoon(years, asOf, withinDays = EXPIRY_SOON_DAYS) {
  const limit = addDays(asOf, withinDays);
  return years.filter((y) => y.status === '未結算' && Number(y.remaining) > 0 && y.endsOn >= asOf && y.endsOn <= limit);
}

export {enumerateLeaveYears as enumerateLeaveYearsForBasis};
