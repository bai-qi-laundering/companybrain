#!/usr/bin/env node
/**
 * Confirm-first batch OCR of existing 存摺 and 身分證 photos.
 * Creates pending hr_ocr_reviews only; does not write employee PII until an admin confirms.
 *
 *   HR_MIGRATE_FROM_APP=1 node hr-batch-ocr.mjs
 *   node scripts/hr-batch-ocr.mjs
 *
 * Uses GEMINI_API_KEY, HR_PII_KEY, PG*, and document folder paths from the environment.
 * Prints counts and filenames only — never decrypted ID or account numbers.
 * Does not touch sessions or the admin password.
 */
import process from 'node:process';
import pg from 'pg';

const fromApp = process.env.HR_MIGRATE_FROM_APP || process.cwd().endsWith('/app');
const ocrMod = await import(fromApp ? './hr-ocr.mjs' : '../backend/hr-ocr.mjs');
const hrMod = await import(fromApp ? './hr-store.mjs' : '../backend/hr-store.mjs');
const {batchScanDocuments, geminiReady} = ocrMod;
const {HrStore} = hrMod;

const env = process.env;
const config = {key: env.GEMINI_API_KEY || '', model: env.GEMINI_MODEL || 'gemini-3.1-flash-lite'};
if (!geminiReady(config)) {
  console.log(JSON.stringify({ok: false, skipped: 'no-gemini', scanned: 0, pending: 0, failed: 0, skippedFiles: 0, skippedLeft: 0}));
  process.exit(1);
}

const pool = new pg.Pool({max: 5, connectionTimeoutMillis: 10000});
const hr = new HrStore(pool);
await hr.ensure();
try {
  const result = await batchScanDocuments({hr, config, actor: 'batch-scan'});
  const safe = {
    ok: result.ok,
    scanned: result.scanned,
    pending: result.pending,
    failed: result.failed,
    skippedFiles: result.skippedFiles,
    skippedLeft: result.skippedLeft,
    reviews: (result.reviews || []).map((r) => ({
      id: r.id, employeeId: r.employeeId, filename: r.filename, category: r.category,
    })),
    errors: (result.errors || []).map((e) => ({
      file: e.file, category: e.category, reason: String(e.reason || '').replace(/\d{4,}/g, '****').slice(0, 160),
    })),
  };
  console.log(JSON.stringify(safe, null, 2));
} finally {
  await pool.end();
}
