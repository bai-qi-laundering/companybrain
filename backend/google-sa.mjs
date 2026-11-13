import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createPrivateKey, createSign} from 'node:crypto';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

let cached = {token: '', exp: 0, email: ''};

export function saJsonSource() {
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

export async function getAccessToken({fetchImpl = fetch, sa} = {}) {
  const creds = sa || await loadServiceAccount();
  if (!creds) return null;
  const now = Math.floor(Date.now() / 1000);
  if (cached.token && cached.email === creds.client_email && cached.exp > now + 60) return cached.token;
  const jwt = signJwt({
    iss: creds.client_email,
    scope: SHEETS_SCOPE,
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
  cached = {token: data.access_token, exp: now + Number(data.expires_in || 3600), email: creds.client_email};
  return cached.token;
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
