import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {Store} from '../backend/store.mjs';
const require=createRequire(new URL('../backend/package.json',import.meta.url));const {PGlite}=require('@electric-sql/pglite');
test('PostgreSQL schema, durable entities, revision rollback and audit deltas',async()=>{const db=new PGlite();const pool={async query(sql,params){if(!params&&sql.trim().includes(';')){const r=await db.exec(sql);return r.at(-1)}const r=await db.query(sql,params?.map(p=>p&&typeof p==='object'?JSON.stringify(p):p));return {...r,rowCount:r.rows.length||r.affectedRows||0}},async connect(){return {...this,release(){}}}};const store=new Store(pool);try{await store.init('admin1','abcdefghijklmnop');let state=await store.read();assert.equal(state.organizations.length,1);assert.equal(state.records.length,0);state.records.push({id:'r1',org:'baiqi',date:'2026-10-07',title:'第一次',type:'一般紀錄',note:'',amount:null});state=await store.save(0,state,'admin1');assert.equal(state.revision,1);assert.equal((await store.read()).records[0].title,'第一次');const before=(await db.query('SELECT * FROM cb_audit')).rows;assert.equal(before.length,1);assert.equal(before[0].entity_type,'records');await assert.rejects(store.save(0,state,'admin1'),/另一台/);assert.equal((await store.read()).revision,1);state.records[0].title='修改後';state=await store.save(1,state,'admin1');const audit=(await db.query('SELECT * FROM cb_audit ORDER BY id')).rows;assert.equal(audit.length,2);assert.equal(audit[1].before_data.title,'第一次');assert.equal(audit[1].after_data.title,'修改後');await store.init('admin1','abcdefghijklmnop');assert.equal((await store.read()).records[0].title,'修改後');state=await store.read();state.organizations[0].priceNotes='鹽 50kg/包 $245';state=await store.save(state.revision,state,'admin1');assert.equal((await store.read()).organizations[0].priceNotes,'鹽 50kg/包 $245');state.records=[];await store.save(state.revision,state,'admin1');assert.equal((await store.read()).records.length,0);const removed=(await db.query("SELECT before_data,after_data FROM cb_audit WHERE entity_type='records' ORDER BY id DESC LIMIT 1")).rows[0];assert.equal(removed.before_data.title,'修改後');assert.equal(removed.after_data,null);}finally{await db.close()}});

test('directory folder primary key is not dropped on repeated saves', async () => {
  const db = new PGlite();
  const pool = {
    async query(sql, params) {
      if (!params && sql.trim().includes(';')) {
        const r = await db.exec(sql);
        return r.at(-1);
      }
      const r = await db.query(sql, params?.map((p) => p && typeof p === 'object' ? JSON.stringify(p) : p));
      return {...r, rowCount: r.rows.length || r.affectedRows || 0};
    },
    async connect() { return {...this, release() {}}; },
  };
  const store = new Store(pool);
  try {
    await store.init('admin1', 'abcdefghijklmnop');
    await store.ensureDirectoryFolders();
    const first = await db.query(
      "SELECT oid FROM pg_constraint WHERE conrelid = 'cb_directory_folders'::regclass AND conname = 'cb_directory_folders_pkey'"
    );
    assert.equal(first.rows.length, 1);
    const oid = first.rows[0].oid;
    await store.saveDirectoryFolder('clients', 'h2o', '合約書、報價單/H2O', {role: 'linked', source: 'auto'});
    await store.saveDirectoryFolder('clients', 'h2o', '合約書、報價單/H2O', {role: 'linked', source: 'auto'});
    await store.ensureDirectoryFolders();
    await store.ensureDirectoryFolders();
    await store.saveDirectoryFolder('clients', 'h2o', '客戶&廠商/各飯店洗前洗後對比照/H2O', {role: 'linked', source: 'auto'});
    const again = await db.query(
      "SELECT oid FROM pg_constraint WHERE conrelid = 'cb_directory_folders'::regclass AND conname = 'cb_directory_folders_pkey'"
    );
    assert.equal(again.rows.length, 1);
    assert.equal(again.rows[0].oid, oid);
    const rows = await store.directoryFolders('clients', 'h2o');
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((r) => r.relative_path === '合約書、報價單/H2O').length, 1);
  } finally {
    await db.close();
  }
});
