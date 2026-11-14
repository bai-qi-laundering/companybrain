import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';

const PREFIX = 'v1:';

export function piiKey() {
  const raw = String(process.env.HR_PII_KEY || '').trim();
  if (!raw || raw.startsWith('CHANGE_ME') || raw === 'PASTE_YOUR_KEY_HERE') return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  if (raw.length >= 32) return createHash('sha256').update(raw).digest();
  return null;
}

export function hasPiiKey() {
  return Boolean(piiKey());
}

export function encryptSecret(plain) {
  const key = piiKey();
  if (!key) throw new Error('尚未設定 HR_PII_KEY，無法保存完整帳號');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(blob) {
  const key = piiKey();
  if (!key) throw new Error('尚未設定 HR_PII_KEY，無法讀取加密資料');
  const s = String(blob || '');
  if (!s.startsWith(PREFIX)) throw new Error('加密資料格式不正確');
  const buf = Buffer.from(s.slice(PREFIX.length), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function last4(value) {
  const s = String(value || '').replace(/\s+/g, '');
  return s.length <= 4 ? s : s.slice(-4);
}
