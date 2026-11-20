import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {AppError} from './domain.mjs';
import {sendJson} from './http-send.mjs';
import {
  canonicalKind, orgDirectoryKind, assertEntityId, directoryRoot,
  resolveEntityFolder, listEntityFiles, saveDirectoryUploads,
  resolveEntityFile, deleteEntityFile, extMime, DIRECTORY_REQUEST_LIMIT,
  isAllowedLinkPath, isProtectedRelativePath, isValidStoredPath,
  ensureEntityFolders, listAllEntityDocuments, resolveLinkedFile, safeJoinRoot,
} from './directory-docs.mjs';
import {scanDirectoryLinks, applyExactDirectoryLinks} from './directory-link.mjs';

function send(req, res, status, body) {
  return sendJson(res, status, body, req);
}

function parseUrl(req) {
  return new URL(req.url, 'http://localhost');
}

async function readRaw(req, limit = DIRECTORY_REQUEST_LIMIT) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new AppError(400, '單次上傳總量請小於 25MB');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function boundaryOf(req) {
  const ct = req.headers['content-type'] || '';
  const m = ct.match(/multipart\/form-data;\s*boundary=([^;]+)/i);
  return m ? m[1].trim().replace(/^"|"$/g, '') : '';
}

export function parseMultipart(buf, boundary) {
  const sep = Buffer.from('--' + boundary);
  const parts = [];
  let start = buf.indexOf(sep);
  while (start >= 0) {
    const after = start + sep.length;
    if (buf.slice(after, after + 2).toString() === '--') break;
    const headEnd = buf.indexOf('\r\n\r\n', after);
    if (headEnd < 0) break;
    const next = buf.indexOf(sep, headEnd);
    if (next < 0) break;
    const header = buf.slice(after, headEnd).toString('utf8');
    let body = buf.slice(headEnd + 4, next);
    if (body.slice(-2).toString() === '\r\n') body = body.slice(0, -2);
    const name = /name="([^"]+)"/.exec(header)?.[1] || '';
    const filename = /filename="([^"]*)"/.exec(header)?.[1] || '';
    const mime = /content-type:\s*([^\r\n]+)/i.exec(header)?.[1]?.trim() || '';
    parts.push({name, filename, mime, body});
    start = next;
  }
  return parts;
}

function contentDisposition(filename) {
  const ascii = String(filename).replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function loadEntity({store, hr, kind, id}) {
  const canon = canonicalKind(kind);
  if (!canon) throw new AppError(400, '名錄種類不正確');
  const entityId = assertEntityId(id);
  if (canon === 'employees') {
    if (!hr) throw new AppError(404, '找不到這位員工');
    const employee = await hr.getEmployee(entityId);
    return {canon, entityId, name: employee.name};
  }
  const state = await store.read();
  const org = (state.organizations || []).find((o) => o.id === entityId);
  if (!org) throw new AppError(404, '找不到這個對象');
  const expected = orgDirectoryKind(org);
  if (expected !== canon) {
    throw new AppError(400, expected === 'clients' ? '這筆資料在客人名錄' : '這筆資料在廠商名錄');
  }
  return {canon, entityId, name: org.name};
}

async function loadCatalog({store, hr}) {
  const state = await store.read();
  let employees = [];
  if (hr) {
    const hrState = await hr.state();
    employees = (hrState.employees || []).map((e) => ({id: e.id, name: e.name}));
  }
  return {organizations: state.organizations || [], employees};
}

const DOC_ROUTE = /^\/api\/directory\/([^/]+)\/([^/]+)\/documents(?:\/(file))?$/;
const FOLDER_ROUTE = /^\/api\/directory\/([^/]+)\/([^/]+)\/folders$/;

export async function handleDirectory(req, res, {store, hr, session, method, path: p} = {}) {
  const url = parseUrl(req);
  if (!store) throw new AppError(503, '資料庫尚未就緒');

  if (url.pathname === '/api/directory/links/scan' && (method === 'GET' || method === 'POST')) {
    const catalog = await loadCatalog({store, hr});
    const scanned = await scanDirectoryLinks({root: directoryRoot(), ...catalog});
    send(req, res, 200, scanned.summary);
    return true;
  }
  if (url.pathname === '/api/directory/links/apply-exact' && method === 'POST') {
    const catalog = await loadCatalog({store, hr});
    const root = directoryRoot();
    const scanned = await scanDirectoryLinks({root, ...catalog});
    const result = await applyExactDirectoryLinks({store, root, links: scanned.links, ...catalog});
    send(req, res, 200, {...result, summary: scanned.summary});
    return true;
  }

  const folderMatch = url.pathname.match(FOLDER_ROUTE);
  if (folderMatch) {
    const entity = await loadEntity({store, hr, kind: decodeURIComponent(folderMatch[1]), id: decodeURIComponent(folderMatch[2])});
    const packed = await ensureEntityFolders({store, kind: entity.canon, entityId: entity.entityId, entityName: entity.name, create: method !== 'DELETE'});
    if (method === 'GET') {
      send(req, res, 200, {
        kind: entity.canon, id: entity.entityId, name: entity.name,
        folders: packed.folders.map((f) => ({role: f.role, relativePath: f.relativePath, displayPath: f.displayPath, source: f.source})),
      });
      return true;
    }
    if (method === 'POST') {
      const body = JSON.parse((await readRaw(req, 50_000)).toString('utf8') || '{}');
      const rel = String(body.relativePath || body.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!isAllowedLinkPath(rel)) throw new AppError(400, '資料夾路徑不正確，或這是受保護的證件資料夾');
      const abs = safeJoinRoot(packed.root, rel);
      if (!abs) throw new AppError(400, '資料夾路徑不正確');
      try { await stat(abs); } catch { throw new AppError(404, '找不到這個資料夾'); }
      const st = await stat(abs);
      if (!st.isDirectory()) throw new AppError(400, '只能連結資料夾');
      await store.saveDirectoryFolder(entity.canon, entity.entityId, rel, {role: 'linked', source: 'manual'});
      const next = await ensureEntityFolders({store, kind: entity.canon, entityId: entity.entityId, entityName: entity.name, create: false});
      send(req, res, 200, {ok: true, folders: next.folders.map((f) => ({role: f.role, relativePath: f.relativePath, displayPath: f.displayPath, source: f.source}))});
      return true;
    }
    if (method === 'DELETE') {
      const rel = String(url.searchParams.get('path') || url.searchParams.get('folder') || '').replace(/\\/g, '/').replace(/^\/+/, '');
      send(req, res, 200, await store.unlinkDirectoryFolder(entity.canon, entity.entityId, rel));
      return true;
    }
    throw new AppError(405, '不支援這個操作');
  }

  const match = url.pathname.match(DOC_ROUTE);
  if (!match) return false;
  const kind = decodeURIComponent(match[1]);
  const id = decodeURIComponent(match[2]);
  const isFile = match[3] === 'file';
  const entity = await loadEntity({store, hr, kind, id});

  if (!isFile && method === 'GET') {
    const packed = await ensureEntityFolders({
      store, kind: entity.canon, entityId: entity.entityId, entityName: entity.name, create: true,
    });
    const folder = url.searchParams.get('folder') || '';
    const subpath = url.searchParams.get('path') || '';
    const listed = await listAllEntityDocuments(packed.folders, {folder, subpath, depth: folder || subpath ? 0 : 1});
    send(req, res, 200, {
      kind: entity.canon,
      id: entity.entityId,
      name: entity.name,
      folder: packed.primary.relativePath,
      displayPath: packed.primary.displayPath,
      folders: packed.folders.map((f) => ({role: f.role, relativePath: f.relativePath, displayPath: f.displayPath, source: f.source})),
      files: listed.files,
      dirs: listed.dirs,
    });
    return true;
  }

  if (!isFile && method === 'POST') {
    const boundary = boundaryOf(req);
    if (!boundary) throw new AppError(400, '請用表單上傳檔案');
    const parts = parseMultipart(await readRaw(req), boundary);
    const folder = await resolveEntityFolder({
      store, kind: entity.canon, entityId: entity.entityId, entityName: entity.name, create: true,
    });
    const saved = await saveDirectoryUploads(folder.abs, parts);
    send(req, res, 200, {ok: true, folder: folder.relativePath, displayPath: folder.displayPath, files: saved});
    return true;
  }

  if (isFile && (method === 'GET' || method === 'HEAD')) {
    const packed = await ensureEntityFolders({
      store, kind: entity.canon, entityId: entity.entityId, entityName: entity.name, create: false,
    });
    const folderRel = url.searchParams.get('folder') || packed.primary.relativePath;
    const filePath = url.searchParams.get('path') || url.searchParams.get('name') || '';
    if (!packed.folders.some((f) => f.relativePath === folderRel)) throw new AppError(400, '沒有這個文件資料夾');
    const abs = resolveLinkedFile(packed.root, folderRel, filePath);
    if (!abs) throw new AppError(400, '檔名不正確');
    let st;
    try { st = await stat(abs); }
    catch { throw new AppError(404, '找不到這個檔案'); }
    if (!st.isFile()) throw new AppError(404, '找不到這個檔案');
    const base = filePath.split('/').pop();
    res.writeHead(200, {
      'content-type': extMime(base),
      'content-length': st.size,
      'content-disposition': contentDisposition(base),
      'cache-control': 'private, max-age=60',
    });
    if (method === 'HEAD') { res.end(); return true; }
    createReadStream(abs).pipe(res);
    return true;
  }

  if (isFile && method === 'DELETE') {
    const packed = await ensureEntityFolders({
      store, kind: entity.canon, entityId: entity.entityId, entityName: entity.name, create: false,
    });
    const folderRel = url.searchParams.get('folder') || packed.primary.relativePath;
    const filePath = url.searchParams.get('path') || url.searchParams.get('name') || '';
    if (!packed.folders.some((f) => f.relativePath === folderRel)) throw new AppError(400, '沒有這個文件資料夾');
    const abs = resolveLinkedFile(packed.root, folderRel, filePath);
    if (!abs) throw new AppError(400, '檔名不正確');
    const {unlink} = await import('node:fs/promises');
    try {
      const st = await stat(abs);
      if (!st.isFile()) throw new AppError(400, '只能刪除檔案');
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(404, '找不到這個檔案');
    }
    await unlink(abs);
    send(req, res, 200, {ok: true, name: filePath.split('/').pop(), path: filePath, folder: folderRel});
    return true;
  }

  throw new AppError(405, '不支援這個操作');
}
