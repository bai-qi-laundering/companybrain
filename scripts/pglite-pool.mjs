import {createRequire} from 'node:module';
const require = createRequire(new URL('../backend/package.json', import.meta.url));
const {PGlite} = require('@electric-sql/pglite');

export function jsonParam(p) {
  if (p == null) return p;
  if (p instanceof Date) return p.toISOString();
  if (typeof p === 'object') return JSON.stringify(p);
  return p;
}

export function createPglitePool(db) {
  const pool = {
    async query(sql, params) {
      if (!params && typeof sql === 'string' && sql.includes(';') && /;\s*\S/.test(sql.trim().replace(/;+\s*$/, '; x'))) {
        // multiple statements
        const r = await db.exec(sql);
        const last = r?.at?.(-1) || {rows: [], affectedRows: 0};
        return {rows: last.rows || [], rowCount: (last.rows && last.rows.length) || last.affectedRows || 0};
      }
      if (!params && typeof sql === 'string' && sql.trim().includes(';')) {
        const r = await db.exec(sql);
        const last = r?.at?.(-1) || {rows: [], affectedRows: 0};
        return {rows: last.rows || [], rowCount: (last.rows && last.rows.length) || last.affectedRows || 0};
      }
      const r = await db.query(sql, params?.map(jsonParam));
      return {rows: r.rows || [], rowCount: (r.rows && r.rows.length) || r.affectedRows || 0};
    },
    async connect() {
      return {...pool, release() {}};
    },
  };
  return pool;
}

export function openPglite() {
  const db = new PGlite();
  return {db, pool: createPglitePool(db)};
}
