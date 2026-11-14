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
export const SCAN_NAME = /^[A-Z0-9_-]+_.+_(身分證|存摺|駕照|履歷表)_\d{8}T\d{6}_[a-f0-9]{12}\.[a-zA-Z]+$/;

const LABEL_TO_CAT = {身分證: 'identity', 存摺: 'bank', 駕照: 'license', 履歷表: 'resume'};

export function folderConfig() {
  return {
    identity: process.env.NAS_IDENTITY_PATH || '',
    bank: process.env.NAS_BANK_PATH || '',
    license: process.env.NAS_LICENSE_PATH || '',
    resume: process.env.NAS_RESUME_PATH || '',
  };
}

export function displayFolder(category) {
  const folders = folderConfig();
  return folders[category] || '';
}


export function leftIdentityPath() {
  return process.env.NAS_IDENTITY_LEFT_PATH || '';
}

/** Primary write folder first, then the 離職 identity/license sibling if configured. */
export function folderRoots(category) {
  const primary = folderConfig()[category] || '';
  const roots = [];
  const add = (root) => {
    if (!root) return;
    const key = path.resolve(root);
    if (!roots.some((r) => path.resolve(r) === key)) roots.push(root);
  };
  add(primary);
  if (category === 'identity' || category === 'license') add(leftIdentityPath());
  return roots;
}

function safeJoinRoot(root, relativePath) {
  const rel = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.split('/').includes('..')) return null;
  const abs = path.resolve(root, rel);
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

export async function resolveDocFile(category, relativePath) {
  for (const root of folderRoots(category)) {
    const abs = safeJoinRoot(root, relativePath);
    if (!abs) continue;
    try {
      const st = await stat(abs);
      if (st.isFile()) {
        const display = String(root).replace(/\\/g, '/') + '/' + String(relativePath || '').replace(/\\/g, '/');
        return {abs, root, displayPath: display};
      }
    } catch { /* try next root */ }
  }
  return null;
}

export function isPrimaryDocRoot(root, category) {
  const primary = folderConfig()[category];
  if (!primary || !root) return false;
  return path.resolve(root) === path.resolve(primary);
}

export async function enrichDocuments(docs = []) {
  const out = [];
  for (const d of docs) {
    const ignored = isIgnoredDocFile(d.filename) || isIgnoredDocFile(d.relativePath);
    if (ignored) {
      out.push({...d, available: false});
      continue;
    }
    const hit = await resolveDocFile(d.category, d.relativePath || d.filename);
    out.push({...d, available: Boolean(hit), displayPath: hit?.displayPath || d.displayPath || ''});
  }
  return out;
}

export function isIgnoredDocFile(filename) {
  const base = String(filename || '').split('/').pop();
  if (!base) return true;
  const lower = base.toLowerCase();
  if (lower === 'thumbs.db' || lower === '.ds_store' || lower === 'desktop.ini') return true;
  if (base.includes('@SynoEAStream') || base.includes('@SynoResource')) return true;
  if (base.startsWith('._')) return true;
  return false;
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
    if (ent.name === '@eaDir' || ent.name === '@SynoResource' || ent.name === '@SynoEAStream') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await walk(p));
    else if (ent.isFile() && !isIgnoredDocFile(ent.name)) out.push(p);
  }
  return out;
}

function parseManaged(filename) {
  if (!SCAN_NAME.test(filename)) return null;
  const m = filename.match(/^([A-Z0-9_-]+)_(.+)_(身分證|存摺|駕照|履歷表)_\d{8}T\d{6}_[a-f0-9]{12}\.[a-zA-Z]+$/);
  if (!m) return null;
  return {employeeId: m[1], nameHint: m[2].replaceAll('_', ' '), category: LABEL_TO_CAT[m[3]]};
}

function folderGroups() {
  const folders = folderConfig();
  const groups = [];
  const index = new Map();
  for (const [category, root] of Object.entries(folders)) {
    if (!root) continue;
    const key = path.resolve(root);
    if (!index.has(key)) {
      index.set(key, {root, categories: []});
      groups.push(index.get(key));
    }
    const g = index.get(key);
    if (!g.categories.includes(category)) g.categories.push(category);
  }
  return groups;
}

function categoriesForScan(categories, filename, relativePath, existing = []) {
  const parsed = parseManaged(filename);
  if (parsed && categories.includes(parsed.category)) return [parsed.category];
  const hits = existing.filter((d) => categories.includes(d.category) && d.relativePath === relativePath).map((d) => d.category);
  if (hits.length) return [...new Set(hits)];
  if (categories.length === 1) return categories;
  return [];
}

export async function scanFolders(hr, employees) {
  const found = [];
  const existing = (await hr.state()).documents || [];
  for (const {root, categories} of folderGroups()) {
    try { await access(root); } catch { continue; }
    for (const category of categories) await hr.markDocumentsUnavailable(category);
    const files = await walk(root);
    for (const abs of files) {
      const st = await stat(abs);
      if (!st.isFile()) continue;
      const filename = path.basename(abs);
      const relativePath = path.relative(root, abs).split(path.sep).join('/');
      const cats = categoriesForScan(categories, filename, relativePath, existing);
      if (!cats.length) continue;
      const parsed = parseManaged(filename);
      let employeeId = null;
      const suggestions = [];
      if (parsed && employees.some((e) => e.id === parsed.employeeId)) employeeId = parsed.employeeId;
      else if (parsed?.nameHint) {
        const hits = employees.filter((e) => e.name && (e.name === parsed.nameHint || parsed.nameHint.includes(e.name) || e.name.includes(parsed.nameHint)));
        for (const h of hits) suggestions.push({employeeId: h.id, name: h.name});
      }
      for (const category of cats) {
        const id = 'D-' + createHash('sha1').update(category + ':' + relativePath).digest('hex').slice(0, 16);
        const row = {id, category, relativePath, filename, size: st.size, mtime: Math.trunc(st.mtimeMs), available: true, employeeId, suggestions};
        await hr.insertDocument(row, null);
        found.push(row);
      }
    }
  }
  await hr.setSetting('lastScan', {at: new Date().toISOString(), count: found.length});
  return {count: found.length};
}

export function fileId() {
  return 'D-' + randomBytes(8).toString('hex');
}
