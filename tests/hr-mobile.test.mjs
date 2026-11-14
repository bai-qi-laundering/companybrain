import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Store} from '../backend/store.mjs';
import {HrStore} from '../backend/hr-store.mjs';
import {createHandler} from '../backend/app.mjs';
import {openPglite} from '../scripts/pglite-pool.mjs';
import {prepareDocFolders} from '../scripts/seed-hr.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const origin = 'http://companybrain.test';

async function start() {
  const docRoot = await mkdtemp(path.join(os.tmpdir(), 'hr-docs-'));
  await prepareDocFolders(docRoot);
  const {db, pool} = openPglite();
  const store = new Store(pool);
  await store.init('admin1', 'abcdefghijklmnop');
  const hr = new HrStore(pool);
  await hr.ensure();
  for (let i = 0; i < 12; i++) {
    await hr.upsertEmployee('D' + String(i + 1).padStart(3, '0'), {
      name: '員工' + i, department: '物流', job: i < 3 ? '司機' : '新進司機', employmentType: '正職', arrivalDate: '2024-01-01',
    }, 'test', {create: true});
  }
  const config = {origin: 'http://127.0.0.1', secure: false, key: '', model: 'model'};
  const server = http.createServer(createHandler({
    store, hr,
    config,
    htmlPath: path.join(root, 'index.html'),
    publicDir: path.join(root, 'public'),
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port;
  config.origin = url;
  const login = await fetch(url + '/api/login', {
    method: 'POST', headers: {Origin: url, 'content-type': 'application/json'},
    body: JSON.stringify({username: 'admin1', password: 'abcdefghijklmnop'}),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const csrf = (await login.json()).csrf;
  return {url, cookie, csrf, server, db, docRoot};
}

test('mobile HR first paint, typing, and add-candidate submit stay stable', async (t) => {
  let pw;
  try {
    const pwMod = await import(pathToFileURL('/tmp/pw-hr/node_modules/playwright/index.js').href);
    const chromium = pwMod.chromium || (pwMod.default && pwMod.default.chromium);
    if (!chromium) throw new Error('playwright chromium export missing');
    pw = await chromium.launch({channel: 'chrome', args: ['--disable-dev-shm-usage']});
  } catch (e) {
    t.skip('Playwright/Chrome unavailable: ' + e.message);
    return;
  }
  const ctx = await start();
  const browser = pw;
  const context = await browser.newContext({
    viewport: {width: 390, height: 844},
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const [name, value] = ctx.cookie.split('=');
  await context.addCookies([{name, value, url: ctx.url}]);
  const page = await context.newPage();
  try {
    const t0 = Date.now();
    await page.goto(ctx.url, {waitUntil: 'domcontentloaded'});
    await page.locator('nav button[data-view="recruitment"]').click();
    const skel = page.locator('.hr-skeleton, text=正在載入人事資料');
    // skeleton may already have gone; either is fine
    await page.getByRole('button', {name: '＋ 新增應徵者'}).waitFor({timeout: 15000});
    const firstContentMs = Date.now() - t0;
    const hasOfficial = await page.locator('#hr-root').textContent();
    assert.ok(firstContentMs < 8000, 'first content too slow: ' + firstContentMs + 'ms');

    const box = page.locator('#hr-root');
    await page.evaluate(() => window.scrollTo(0, 180));
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => window.refreshNas && window.refreshNas());
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.scrollY), scrollBefore);

    await page.getByRole('button', {name: '＋ 新增應徵者'}).click();
    const dialog = page.locator('dialog.hr-dlg');
    await dialog.waitFor();
    await dialog.locator('input[name="name"]').fill('手機新應徵');
    await page.waitForTimeout(200);
    await page.evaluate(() => window.refreshNas && window.refreshNas());
    await page.waitForTimeout(200);
    assert.equal(await dialog.locator('input[name="name"]').inputValue(), '手機新應徵');
    const confirm = dialog.getByRole('button', {name: '確定'});
    await confirm.scrollIntoViewIfNeeded();
    await confirm.click();
    try {
      await page.getByText('手機新應徵').first().waitFor({timeout: 10000});
    } catch (err) {
      const shot = '/tmp/hr-mobile-fail.png';
      await page.screenshot({path: shot, fullPage: true});
      const dialogHtml = await page.locator('dialog.hr-dlg').innerHTML().catch(() => '');
      const rootText = await page.locator('#hr-root').innerText().catch(() => '');
      console.error('mobile submit failed screenshot', shot, 'dialog', dialogHtml.slice(0, 800), 'root', rootText.slice(0, 800));
      throw err;
    }
    assert.ok(!(await page.locator('dialog.hr-dlg').isVisible().catch(() => false)));
    console.log('mobile_first_content_ms', firstContentMs);
  } finally {
    await context.close();
    await browser.close();
    await new Promise((r) => ctx.server.close(r));
    await ctx.db.close();
    await rm(ctx.docRoot, {recursive: true, force: true});
  }
});
