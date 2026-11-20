import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {AppError} from './domain.mjs';
import {sendJson} from './http-send.mjs';
import {
  canonicalKind, orgDirectoryKind, assertEntityId, directoryRoot,
  resolveEntityFolder, listEntityFiles, saveDirectoryUploads,
  resolveEntityFile, deleteEntityFile, extMime, DIRECTORY_REQUEST_LIMIT,
} from './directory-docs.mjs';

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

const ROUTE = /^\/api\/directory\/([^/]+)\/([^/]+)\/documents(?:\/(file))?$/;

export async function handleDirectory(req, res, {store, hr, session, method, path: p} = {}) {
  const url = parseUrl(req);
  const match = url.pathname.match(ROUTE);
  if (!match) return false;
  if (!store) throw new AppError(503, '資料庫尚未就緒');
  const kind = decodeURIComponent(match[1]);
  const id = decodeURIComponent(match[2]);
  const isFile = match[3] === 'file';
  const entity = await loadEntity({store, hr, kind, id});

  if (!isFile && method === 'GET') {
    const folder = await resolveEntityFolder({
      store, kind: entity.canon, entityId: entity.entityId, entityName: entity.name, create: true,
    });
    const files = await listEntityFiles(folder.abs);
    send(req, res, 200, {
      kind: entity.canon,
      id: entity.entityId,
      name: entity.name,
      folder: folder.relativePath,
      displayPath: folder.displayPath,
      files,
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
    const name = url.searchParams.get('name') || '';
    const folder = await resolveEntityFolder({
      store, kind: entity.canon, entityId: entity.entityId, entityName: entity.name, create: false,
    });
    const abs = resolveEntityFile(folder.abs, name);
    if (!abs) throw new AppError(400, '檔名不正確');
    let st;
    try { st = await stat(abs); }
    catch { throw new AppError(404, '找不到這個檔案'); }
    if (!st.isFile()) throw new AppError(404, '找不到這個檔案');
    res.writeHead(200, {
      'content-type': extMime(name),
      'content-length': st.size,
      'content-disposition': contentDisposition(name),
      'cache-control': 'private, max-age=60',
    });
    if (method === 'HEAD') { res.end(); return true; }
    createReadStream(abs).pipe(res);
    return true;
  }

  if (isFile && method === 'DELETE') {
    const name = url.searchParams.get('name') || '';
    const folder = await resolveEntityFolder({
      store, kind: entity.canon, entityId: entity.entityId, entityName: entity.name, create: false,
    });
    send(req, res, 200, await deleteEntityFile(folder.abs, name));
    return true;
  }

  throw new AppError(405, '不支援這個操作');
}
