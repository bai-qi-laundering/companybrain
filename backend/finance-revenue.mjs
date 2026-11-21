// 營收：唯讀讀取百麒系統後台（hotellinen_service）Firestore statement_cases，
// 以「已寄出」的最新版本應付金額（折讓後未稅 + 稅額）為當月收入，與應收帳款頁同一套規則。
// 只用 runQuery 讀取；不寫入、不寄送、不開票。
import {getAccessToken, DATASTORE_READ_SCOPE} from './google-sa.mjs';

export const FIRESTORE_PROJECT = process.env.FINANCE_FIRESTORE_PROJECT || 'hotel-inventory-3a1ad';
const round = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** Firestore REST Value → 一般 JS 值。 */
export function decodeValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return Boolean(v.booleanValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return null;
}
export const decodeFields = (fields) => Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, decodeValue(v)]));

// 與 hotellinen_service receivables-core.js 相同：合併帳單（含「+」）不計，良西+良一 例外。
export function isFixedHotelCase(c) {
  const name = String(c?.customerKey || '').normalize('NFKC').replace(/\s/g, '');
  return !name.includes('+') || name === '良西+良一';
}
export function sentVersion(c) {
  return [...(c.versions || [])].filter((v) => v && v.sentAt).sort((a, b) => b.version - a.version)[0] || null;
}
export function caseRevenue(c) {
  if (!isFixedHotelCase(c)) return null;
  const v = sentVersion(c);
  if (!v) return null;
  const net = round(v.snapshot?.totals?.afterRebate), tax = round(v.snapshot?.totals?.tax);
  return {customerKey: c.customerKey || '', startDate: c.startDate || '', endDate: c.endDate || '', version: v.version, net, tax, total: round(net + tax),
    resendPending: Number(c.latestVersion) > Number(v.version)};
}

export function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}`};
}

/** 一個月份 = 一次查詢；讀取次數 = 回傳的帳單筆數（約每家飯店一筆）。 */
export async function fetchStatementMonth({month, fetchImpl = fetch, token}) {
  const access = token || await getAccessToken({fetchImpl, scope: DATASTORE_READ_SCOPE});
  if (!access) throw Object.assign(new Error('尚未設定 Google 服務帳戶'), {code: 'no-sa'});
  const {start, end} = monthRange(month);
  const body = {structuredQuery: {
    from: [{collectionId: 'statement_cases'}],
    where: {compositeFilter: {op: 'AND', filters: [
      {fieldFilter: {field: {fieldPath: 'endDate'}, op: 'GREATER_THAN_OR_EQUAL', value: {stringValue: start}}},
      {fieldFilter: {field: {fieldPath: 'endDate'}, op: 'LESS_THAN_OR_EQUAL', value: {stringValue: end}}},
    ]}},
    select: {fields: ['customerKey', 'startDate', 'endDate', 'latestVersion', 'versions'].map((fieldPath) => ({fieldPath}))},
  }};
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(FIRESTORE_PROJECT)}/databases/(default)/documents:runQuery`;
  const res = await fetchImpl(url, {method: 'POST', headers: {authorization: 'Bearer ' + access, 'content-type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(30000)});
  if (res.status === 403) throw Object.assign(new Error('服務帳戶沒有讀取對帳單（Firestore）的權限，請在 Google Cloud 加上「Cloud Datastore 檢視者」角色'), {code: 'forbidden'});
  if (!res.ok) throw Object.assign(new Error('讀取對帳單失敗（' + res.status + '）'), {code: 'http'});
  const rows = await res.json();
  const docs = (Array.isArray(rows) ? rows : []).filter((r) => r.document).map((r) => decodeFields(r.document.fields));
  return summarizeMonth(month, docs);
}

export function summarizeMonth(month, docs) {
  const cases = docs.map(caseRevenue).filter(Boolean).sort((a, b) => a.customerKey.localeCompare(b.customerKey, 'zh-Hant'));
  const unsent = docs.filter((c) => isFixedHotelCase(c) && !sentVersion(c)).map((c) => c.customerKey || '').sort();
  return {
    month, reads: Math.max(1, docs.length), cases,
    net: round(cases.reduce((s, c) => s + c.net, 0)), tax: round(cases.reduce((s, c) => s + c.tax, 0)), total: round(cases.reduce((s, c) => s + c.total, 0)),
    unsent, resendPending: cases.filter((c) => c.resendPending).map((c) => c.customerKey),
  };
}

const taipeiMonth = (d = new Date()) => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit'}).format(d);
export function recentMonths(now = new Date()) {
  const cur = taipeiMonth(now);
  const [y, m] = cur.split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  return [prev, cur];
}

/** 每小時檢查一次：本月與上月的營收快取超過 20 小時才重讀（每天約 2 次查詢）。舊月份只在按「更新營收」時讀。 */
export function startRevenueRefresh({fin, fetchRevenue = fetchStatementMonth, logger = console, intervalMs = 3600000, maxAgeHours = 20} = {}) {
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      for (const month of recentMonths()) {
        const row = await fin.revenueAttemptedAt(month);
        const last = row?.attempted_at ? new Date(row.attempted_at).getTime() : 0;
        if (Date.now() - last < maxAgeHours * 3600000) continue;
        const r = await fin.refreshRevenue(month, fetchRevenue);
        if (r.error) { logger.log('Revenue refresh ' + month + ' failed: ' + r.error); if (r.code === 'no-sa' || r.code === 'forbidden') break; }
      }
    } catch (e) { logger.log('Revenue refresh error: ' + (e?.name || 'error')); }
    finally { running = false; }
  }
  const first = setTimeout(tick, 60000); first.unref?.();
  const timer = setInterval(tick, intervalMs); timer.unref?.();
  return {tick, stop() { clearTimeout(first); clearInterval(timer); }};
}
