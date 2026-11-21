import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createPrivateKey, createSign} from 'node:crypto';

// Read/write: companybrain appends new-hire rows and flips 匯款類型 for rows it created (see hr-sheet-write.mjs).
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const DATASTORE_READ_SCOPE = 'https://www.googleapis.com/auth/datastore';
const tokenCache = new Map();

export function saJsonSource() {
  const b64 = String(process.env.GOOGLE_SA_JSON_B64 || '').trim();
  if (b64) {
    try { return Buffer.from(b64, 'base64').toString('utf8').trim(); } catch { return ''; }
  }
  return String(process.env.GOOGLE_SA_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
}

export async function loadServiceAccount() {
  const raw = saJsonSource();
  if (!raw) return null;
  let text = raw;
  if (raw.startsWith('{')) text = raw;
  else if (existsSync(raw)) text = await readFile(raw, 'utf8');
  else return null;
  try {
    const json = JSON.parse(text);
    if (!json.client_email || !json.private_key) return null;
    return json;
  } catch {
    return null;
  }
}

export async function serviceAccountStatus() {
  const sa = await loadServiceAccount();
  if (!sa) {
    return {configured: false, clientEmail: '', reason: saJsonSource() ? 'json-invalid' : 'missing'};
  }
  return {configured: true, clientEmail: sa.client_email, reason: ''};
}

function b64url(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
}

export function signJwt(payload, privateKeyPem) {
  const header = b64url({alg: 'RS256', typ: 'JWT'});
  const body = b64url(payload);
  const signer = createSign('RSA-SHA256');
  signer.update(header + '.' + body);
  const sig = signer.sign(createPrivateKey(privateKeyPem)).toString('base64url');
  return header + '.' + body + '.' + sig;
}

export async function getAccessToken({fetchImpl = fetch, sa, scope = SHEETS_SCOPE} = {}) {
  const creds = sa || await loadServiceAccount();
  if (!creds) return null;
  const now = Math.floor(Date.now() / 1000);
  const cacheKey = creds.client_email + '|' + scope;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.exp > now + 60) return cached.token;
  const jwt = signJwt({
    iss: creds.client_email,
    scope,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }, creds.private_key);
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt}).toString(),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('Google 授權失敗（' + res.status + '）');
  const data = await res.json();
  tokenCache.set(cacheKey, {token: data.access_token, exp: now + Number(data.expires_in || 3600)});
  return data.access_token;
}

export async function fetchSheetValues({spreadsheetId, sheetTab, fetchImpl = fetch, token}) {
  const access = token || await getAccessToken({fetchImpl});
  if (!access) throw new Error('尚未設定服務帳戶');
  const range = encodeURIComponent("'" + String(sheetTab || '').replaceAll("'", '') + "'!A1:ZZ");
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + '/values/' + range + '?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS';
  const res = await fetchImpl(url, {headers: {Authorization: 'Bearer ' + access}, signal: AbortSignal.timeout(30000)});
  if (res.status === 403) throw new Error('沒有權限讀取試算表，請確認已把服務帳戶加成檢視者。');
  if (res.status === 404) throw new Error('找不到試算表或分頁名稱不正確。');
  if (!res.ok) throw new Error('讀取試算表失敗（' + res.status + '）');
  const data = await res.json();
  return data.values || [];
}

/** Read several tabs in one call (values:batchGet). Returns {tabTitle: rows[][]}. */
export async function fetchSheetTabs({spreadsheetId, tabs = [], fetchImpl = fetch, token}) {
  const access = token || await getAccessToken({fetchImpl});
  if (!access) throw new Error('尚未設定服務帳戶');
  const qs = tabs.map((t) => 'ranges=' + encodeURIComponent("'" + String(t || '').replaceAll("'", '') + "'!A1:ZZ")).join('&');
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + '/values:batchGet?' + qs + '&valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS';
  const res = await fetchImpl(url, {headers: {Authorization: 'Bearer ' + access}, signal: AbortSignal.timeout(30000)});
  if (res.status === 403) throw new Error('沒有權限讀取試算表，請確認已把服務帳戶加成檢視者。');
  if (res.status === 404 || res.status === 400) throw new Error('找不到試算表或分頁名稱不正確。');
  if (!res.ok) throw new Error('讀取試算表失敗（' + res.status + '）');
  const data = await res.json();
  const out = {};
  tabs.forEach((t, i) => { out[t] = data.valueRanges?.[i]?.values || []; });
  return out;
}

function a1Tab(tab) {
  return "'" + String(tab || '').replaceAll("'", '') + "'";
}

async function sheetsWrite({url, method, body, fetchImpl = fetch, token}) {
  const access = token || await getAccessToken({fetchImpl});
  if (!access) throw new Error('尚未設定服務帳戶');
  const res = await fetchImpl(url, {
    method,
    headers: {Authorization: 'Bearer ' + access, 'content-type': 'application/json'},
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 403) throw new Error('服務帳戶沒有編輯權限：請在試算表「共用」把服務帳戶改成「編輯者」。');
  if (res.status === 404 || res.status === 400) throw new Error('找不到試算表或分頁名稱不正確（' + res.status + '）。');
  if (!res.ok) throw new Error('寫入試算表失敗（' + res.status + '）');
  return res.json();
}

/** Append one row after the last row of a tab (USER_ENTERED so yyyy/mm/dd becomes a date). Returns the updated A1 range. */
export async function appendSheetRow({spreadsheetId, tab, row, fetchImpl, token}) {
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + '/values/'
    + encodeURIComponent(a1Tab(tab) + '!A1') + ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS&includeValuesInResponse=false';
  const data = await sheetsWrite({url, method: 'POST', body: {majorDimension: 'ROWS', values: [row]}, fetchImpl, token});
  return data.updates?.updatedRange || '';
}

/** Overwrite one cell, e.g. 'K12'. */
export async function updateSheetCell({spreadsheetId, tab, cell, value, fetchImpl, token}) {
  const range = a1Tab(tab) + '!' + cell;
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + '/values/'
    + encodeURIComponent(range) + '?valueInputOption=USER_ENTERED';
  const data = await sheetsWrite({url, method: 'PUT', body: {range, majorDimension: 'ROWS', values: [[value]]}, fetchImpl, token});
  return data.updatedRange || range;
}
