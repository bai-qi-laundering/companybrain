import {createWriteStream} from 'node:fs';
import {mkdir, readdir, stat, access, constants} from 'node:fs/promises';
import {createHash, randomBytes} from 'node:crypto';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {DOC_TYPES} from './hr-store.mjs';
import {AppError} from './domain.mjs';

export const UPLOAD_LIMIT = 12 * 1024 * 1024;
export const MIMES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};
export const SCAN_NAME = /^[A-Z0-9_-]+_.+_(身分證|存摺|駕照)_\d{8}T\d{6}_[a-f0-9]{12}\.[a-zA-Z]+$/;

const LABEL_TO_CAT = {身分證: 'identity', 存摺: 'bank', 駕照: 'license'};

export function folderConfig() {
  return {
    identity: process.env.NAS_IDENTITY_PATH || '',
    bank: process.env.NAS_BANK_PATH || '',
    license: process.env.NAS_LICENSE_PATH || '',
  };
}

export function displayFolder(category) {
  const folders = folderConfig();
  return folders[category] || '';
}

export function safeName(name) {
  return String(name || '').replace(/[^\w\u3400-\u9fff-]/g, '_').slice(0, 60) || '未命名';
}

export function buildFilename(employeeId, employeeName, category, ext, when = new Date(), token = randomBytes(6).toString('hex')) {
  const label = DOC_TYPES[category];
  if (!label) throw new AppError(400, '文件種類不正確');
  const stamp = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(when).reduce((a, p) => (a[p.type] = p.value, a), {});
  // en-CA with time parts: YYYY-MM-DD and HH:MM:SS. Match Python %Y%m%dT%H%M%S
  const ymd = `${stamp.year}${stamp.month}${stamp.day}`;
  const hms = `${stamp.hour}${stamp.minute}${stamp.second}`;
  return `${employeeId}_${safeName(employeeName)}_${label}_${ymd}T${hms}_${token}${ext}`;
}

export function savedPath(category, filename) {
  const root = displayFolder(category);
  if (!root) return filename;
  return path.posix.join(root.replaceAll('\\', '/'), filename);
}

export async function saveUpload({category, employeeId, employeeName, mime, stream, size}) {
  const ext = MIMES[mime];
  if (!ext) throw new AppError(400, '只接受 JPG、PNG、WEBP 或 PDF');
  if (size > UPLOAD_LIMIT) throw new AppError(400, '檔案請小於 12MB');
  const root = folderConfig()[category];
  if (!root) throw new AppError(500, '尚未設定 ' + category + ' 文件資料夾');
  await mkdir(root, {recursive: true});
  const filename = buildFilename(employeeId, employeeName, category, ext);
  const dest = path.join(root, filename);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
  const out = createWriteStream(dest, {flags, mode: 0o644});
  try {
    await pipeline(stream, out);
  } catch (e) {
    throw new AppError(400, '檔案寫入失敗');
  }
  const st = await stat(dest);
  return {filename, dest, displayPath: savedPath(category, filename), size: st.size, mtime: Math.trunc(st.mtimeMs)};
}

async function walk(dir) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, {withFileTypes: true}); }
  catch (e) { return out; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await walk(p));
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

function parseManaged(filename) {
  if (!SCAN_NAME.test(filename)) return null;
  const m = filename.match(/^([A-Z0-9_-]+)_(.+)_(身分證|存摺|駕照)_\d{8}T\d{6}_[a-f0-9]{12}\.[a-zA-Z]+$/);
  if (!m) return null;
  return {employeeId: m[1], nameHint: m[2].replaceAll('_', ' '), category: LABEL_TO_CAT[m[3]]};
}

export async function scanFolders(hr, employees) {
  const folders = folderConfig();
  const found = [];
  for (const [category, root] of Object.entries(folders)) {
    if (!root) continue;
    try { await access(root); } catch { continue; }
    await hr.markDocumentsUnavailable(category);
    const files = await walk(root);
    for (const abs of files) {
      const st = await stat(abs);
      if (!st.isFile()) continue;
      const filename = path.basename(abs);
      const relativePath = path.relative(root, abs).split(path.sep).join('/');
      const parsed = parseManaged(filename);
      let employeeId = null;
      const suggestions = [];
      if (parsed && employees.some((e) => e.id === parsed.employeeId)) employeeId = parsed.employeeId;
      else if (parsed?.nameHint) {
        const hits = employees.filter((e) => e.name && (e.name === parsed.nameHint || parsed.nameHint.includes(e.name) || e.name.includes(parsed.nameHint)));
        for (const h of hits) suggestions.push({employeeId: h.id, name: h.name});
      }
      const id = 'D-' + createHash('sha1').update(category + ':' + relativePath).digest('hex').slice(0, 16);
      const row = {id, category, relativePath, filename, size: st.size, mtime: Math.trunc(st.mtimeMs), available: true, employeeId, suggestions};
      await hr.insertDocument(row, null);
      found.push(row);
    }
  }
  await hr.setSetting('lastScan', {at: new Date().toISOString(), count: found.length});
  return {count: found.length};
}

export function fileId() {
  return 'D-' + randomBytes(8).toString('hex');
}
