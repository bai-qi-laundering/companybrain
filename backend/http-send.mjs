import {gzipSync} from 'node:zlib';

/** JSON response, gzip when the client accepts it and the body is worth compressing. */
export function sendJson(res, status, body, req) {
  let data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const headers = {'Content-Type': 'application/json; charset=utf-8'};
  const accept = String(req?.headers?.['accept-encoding'] || '');
  if (accept.includes('gzip') && data.length > 512) {
    data = gzipSync(data);
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
  }
  headers['Content-Length'] = String(data.length);
  res.writeHead(status, headers);
  res.end(data);
}
