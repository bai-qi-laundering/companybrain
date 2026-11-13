#!/usr/bin/env node
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {Store} from '../backend/store.mjs';
import {HrStore} from '../backend/hr-store.mjs';
import {createHandler} from '../backend/app.mjs';
import {openPglite} from './pglite-pool.mjs';
import {seedHr, seedOrganizations, prepareDocFolders, LOCAL_ADMIN} from './seed-hr.mjs';

const port = Number(process.env.PORT || 8788);
const origin = process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`;
const docRoot = process.env.HR_DOC_ROOT || '/tmp/hr-merge-docs';
await prepareDocFolders(docRoot);

const {db, pool} = openPglite();
const store = new Store(pool);
await store.init(LOCAL_ADMIN.username, LOCAL_ADMIN.password);
const hr = new HrStore(pool);
await hr.ensure();
await seedOrganizations(store);
await seedHr(hr);

const root = fileURLToPath(new URL('..', import.meta.url));
const htmlPath = path.join(root, 'index.html');
const publicDir = path.join(root, 'public');
const server = http.createServer(createHandler({
  store, hr,
  config: {origin, secure: false, key: '', model: 'gemini-3.1-flash-lite'},
  htmlPath, publicDir,
}));
server.listen(port, '127.0.0.1', () => {
  console.log('companybrain-hr-local ready on ' + origin);
  console.log('login ' + LOCAL_ADMIN.username + ' / ' + LOCAL_ADMIN.password);
  console.log('docs ' + docRoot);
});
process.on('SIGINT', async () => { server.close(); await db.close(); process.exit(0); });
