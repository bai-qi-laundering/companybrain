import {createWriteStream} from 'node:fs';
import {mkdir, readdir, stat, unlink, access} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {AppError} from './domain.mjs';
import {isIgnoredDocFile, safeName} from './hr-docs.mjs';

export const DIRECTORY_UPLOAD_LIMIT = 20 * 1024 * 1024;
export const DIRECTORY_REQUEST_LIMIT = 25 * 1024 * 1024;
export const DIRECTORY_MAX_FILES = 8;

export const KIND_FOLDERS = {
  vendors: '廠商',
  clients: '客戶',
  employees: '員工',
};

export const RESERVED_EMPLOYEE_FOLDERS = new Set([
  '員工身分證(在職)',
  '員工身分證、駕照(離職)',
  '員工駕照',
  '存簿匯款資料',
  '履歷表',
  'ID資料',
  '切結書、存證信函、離職申請、勞動契約',
  '勞動契約、薪資辦法',
  '勞工協商資料',
  '勞工局資料',
  '員工在職、離職證明',
  '106.6.20勞動檢查',
  '106年春酒相片',
  '菲律賓學生',
  '請假紀錄',
  '請假證明',
  '資遣通報',
  '防疫相關',
  '行車記錄器-仁',
]);

const UPLOAD_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
};

export function canonicalKind(kind) {
  const k = String(kind || '').trim();
  if (k === 'vendor' || k === 'vendors' || k === '廠商') return 'vendors';
  if (k === 'client' || k === 'clients' || k === '客人' || k === '客戶') return 'clients';
  if (k === 'employee' || k === 'employees' || k === '員工') return 'employees';
  return '';
}

export function orgDirectoryKind(org) {
  const kind = org?.kind || '其他';
  return kind === '飯店' ? 'clients' : 'vendors';
}

export function assertEntityId(id) {
  const value = String(id || '').trim();
  if (!value || value.length > 80 || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new AppError(400, '對象編號不正確');
  }
  return value;
}

export function directoryRoot() {
  const explicit = String(process.env.NAS_DIRECTORY_ROOT || '').trim();
  if (explicit) return path.resolve(explicit);
  const identity = String(process.env.NAS_IDENTITY_PATH || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (identity) {
    const parts = identity.split('/').filter(Boolean);
    const empIdx = parts.lastIndexOf('員工');
    if (empIdx > 0) return path.resolve('/' + parts.slice(0, empIdx).join('/'));
  }
  return '';
}

export function inferDirectoryRoot(identityPath) {
  const identity = String(identityPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = identity.split('/').filter(Boolean);
  const empIdx = parts.lastIndexOf('員工');
  if (empIdx > 0) return '/' + parts.slice(0, empIdx).join('/');
  return '';
}

function posixJoin(...parts) {
  return parts.map((p) => String(p).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
}

export function folderBaseName(entityId, entityName) {
  const id = assertEntityId(entityId);
  const name = safeName(entityName);
  return `${id}_${name}`.slice(0, 200);
}

export function defaultRelativePath(kind, entityId, entityName) {
  const canon = canonicalKind(kind);
  const prefix = KIND_FOLDERS[canon];
  if (!prefix) throw new AppError(400, '名錄種類不正確');
  const base = folderBaseName(entityId, entityName);
  if (canon === 'employees' && RESERVED_EMPLOYEE_FOLDERS.has(base)) {
    throw new AppError(400, '此資料夾名稱與既有員工證件資料夾衝突，請聯繫管理員');
  }
  return posixJoin(prefix, base);
}

export function safeJoinRoot(root, relativePath) {
  if (!root) return null;
  const rel = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.split('/').includes('..')) return null;
  const abs = path.resolve(root, rel);
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

export function isValidStoredPath(kind, entityId, relativePath) {
  const canon = canonicalKind(kind);
  const prefix = KIND_FOLDERS[canon];
  const id = String(entityId || '');
  const rel = String(relativePath || '').replace(/\\/g, '/');
  if (!canon || !prefix || !id || !rel || rel.includes('..') || rel.startsWith('/')) return false;
  const parts = rel.split('/').filter(Boolean);
  if (parts.length !== 2) return false;
  if (parts[0] !== prefix) return false;
  if (!parts[1].startsWith(id + '_')) return false;
  if (canon === 'employees' && RESERVED_EMPLOYEE_FOLDERS.has(parts[1])) return false;
  return true;
}

export function safeFileName(name) {
  const base = String(name || '').split(/[/\\]/).pop() || '';
  let cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/g, '_').trim();
  cleaned = cleaned.replace(/[. ]+$/g, '');
  if (isIgnoredDocFile(cleaned) || cleaned === '@eaDir') return '';
  return cleaned.slice(0, 180);
}

export function extMime(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return UPLOAD_EXT[ext] || 'application/octet-stream';
}

export function isAllowedUploadName(filename) {
  const name = safeFileName(filename);
  if (!name) return false;
  const ext = path.extname(name).toLowerCase();
  return Boolean(UPLOAD_EXT[ext]);
}

export async function uniqueDest(dir, filename) {
  const safe = safeFileName(filename);
  if (!safe) throw new AppError(400, '檔名不正確');
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  let candidate = safe;
  for (let i = 0; i < 50; i++) {
    const abs = path.join(dir, candidate);
    try {
      await access(abs);
      candidate = `${stem}_${i + 2}${ext}`;
    } catch {
      return {filename: candidate, dest: abs};
    }
  }
  throw new AppError(409, '同名檔案過多，請重新命名後再上傳');
}

async function ensureRoot() {
  const root = directoryRoot();
  if (!root) throw new AppError(503, '尚未設定名錄文件資料夾（NAS_DIRECTORY_ROOT）');
  return root;
}

export async function resolveEntityFolder({store, kind, entityId, entityName, create}) {
  const canon = canonicalKind(kind);
  if (!canon) throw new AppError(400, '名錄種類不正確');
  const id = assertEntityId(entityId);
  const root = await ensureRoot();
  if (typeof store.ensureDirectoryFolders === 'function') await store.ensureDirectoryFolders();
  const row = typeof store.directoryFolder === 'function' ? await store.directoryFolder(canon, id) : null;
  let relative = row?.relative_path || row?.relativePath || '';
  if (relative && !isValidStoredPath(canon, id, relative)) {
    throw new AppError(500, '文件資料夾路徑無效，請聯繫管理員');
  }
  if (!relative) {
    relative = defaultRelativePath(canon, id, entityName);
    if (!isValidStoredPath(canon, id, relative)) throw new AppError(500, '無法建立文件資料夾路徑');
    if (create && typeof store.saveDirectoryFolder === 'function') {
      await store.saveDirectoryFolder(canon, id, relative);
    }
  }
  const abs = safeJoinRoot(root, relative);
  if (!abs) throw new AppError(500, '文件資料夾路徑無效');
  if (create) await mkdir(abs, {recursive: true});
  return {root, relativePath: relative, abs, displayPath: path.posix.join(root.replaceAll('\\', '/'), relative), created: create};
}

export async function listEntityFiles(folderAbs) {
  let entries;
  try { entries = await readdir(folderAbs, {withFileTypes: true}); }
  catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  const files = [];
  for (const ent of entries) {
    if (ent.name === '@eaDir' || ent.name === '@SynoResource' || ent.name === '@SynoEAStream') continue;
    if (!ent.isFile() || isIgnoredDocFile(ent.name)) continue;
    const abs = path.join(folderAbs, ent.name);
    const st = await stat(abs);
    if (!st.isFile()) continue;
    files.push({
      name: ent.name,
      size: st.size,
      mtime: Math.trunc(st.mtimeMs),
      mime: extMime(ent.name),
    });
  }
  files.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name, 'zh-Hant'));
  return files;
}

export async function saveDirectoryUploads(folderAbs, parts) {
  const files = parts.filter((p) => (p.name === 'file' || p.filename) && p.filename && p.body?.length);
  if (!files.length) throw new AppError(400, '請選擇檔案');
  if (files.length > DIRECTORY_MAX_FILES) throw new AppError(400, `一次最多上傳 ${DIRECTORY_MAX_FILES} 個檔案`);
  const saved = [];
  for (const file of files) {
    if (!isAllowedUploadName(file.filename)) throw new AppError(400, '只接受 PDF、圖片或常見 Office 文件');
    if (file.body.length > DIRECTORY_UPLOAD_LIMIT) throw new AppError(400, '每個檔案請小於 20MB');
    const {filename, dest} = await uniqueDest(folderAbs, file.filename);
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
    const out = createWriteStream(dest, {flags, mode: 0o644});
    try {
      await pipeline(Readable.from(file.body), out);
    } catch {
      try { await unlink(dest); } catch { /* ignore */ }
      throw new AppError(400, '檔案寫入失敗');
    }
    const st = await stat(dest);
    saved.push({name: filename, size: st.size, mtime: Math.trunc(st.mtimeMs), mime: extMime(filename)});
  }
  return saved;
}

export function resolveEntityFile(folderAbs, filename) {
  const raw = String(filename || '');
  if (!raw || raw !== raw.split(/[/\\]/).pop()) return null;
  if (raw.includes('..') || raw === '.' || raw === '@eaDir') return null;
  if (isIgnoredDocFile(raw)) return null;
  return safeJoinRoot(folderAbs, raw);
}

export async function deleteEntityFile(folderAbs, filename) {
  const abs = resolveEntityFile(folderAbs, filename);
  if (!abs) throw new AppError(400, '檔名不正確');
  try {
    const st = await stat(abs);
    if (!st.isFile()) throw new AppError(400, '只能刪除檔案');
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(404, '找不到這個檔案');
  }
  await unlink(abs);
  return {ok: true, name: path.basename(abs)};
}
