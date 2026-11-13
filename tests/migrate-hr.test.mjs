import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {rmSync} from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = path.join(tmpdir(), 'hr-fixture-' + Date.now() + '.sqlite3');

test('migrate --dry-run prints counts and does not need Postgres', () => {
  const made = spawnSync(process.execPath, [path.join(root, 'scripts/make-hr-fixture.mjs'), fixture], {encoding: 'utf8'});
  assert.equal(made.status, 0, made.stderr + made.stdout);
  const run = spawnSync(process.execPath, [path.join(root, 'scripts/migrate-hr.mjs'), '--sqlite', fixture, '--dry-run'], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.match(run.stdout, /預演/);
  assert.match(run.stdout, /employees: 1/);
  assert.match(run.stdout, /leaveRecords: 2/);
  assert.match(run.stdout, /candidates: 1/);
  assert.match(run.stdout, /salaries: 1/);
  assert.match(run.stdout, /attendance: 1/);
  assert.match(run.stdout, /leaveLedgers/);
  rmSync(fixture, {force: true});
});
