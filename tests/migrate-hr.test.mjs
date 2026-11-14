import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {rmSync} from 'node:fs';
import {applyArrivalFill} from '../backend/hr-arrival.mjs';
import {HrStore} from '../backend/hr-store.mjs';
import {openPglite} from '../scripts/pglite-pool.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = path.join(tmpdir(), 'hr-fixture-' + Date.now() + '.sqlite3');

test('migrate --dry-run prints counts and does not need Postgres', () => {
  const made = spawnSync(process.execPath, [path.join(root, 'scripts/make-hr-fixture.mjs'), fixture], {encoding: 'utf8'});
  assert.equal(made.status, 0, made.stderr + made.stdout);
  const run = spawnSync(process.execPath, [path.join(root, 'scripts/migrate-hr.mjs'), '--sqlite', fixture, '--dry-run'], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.match(run.stdout, /預演/);
  assert.match(run.stdout, /employees: 3/);
  assert.match(run.stdout, /leaveRecords: 2/);
  assert.match(run.stdout, /candidates: 1/);
  assert.match(run.stdout, /salaries: 1/);
  assert.match(run.stdout, /attendance: 略過/);
  assert.match(run.stdout, /不遷移打卡/);
  assert.match(run.stdout, /leaveLedgers/);
  assert.match(run.stdout, /arrivalFilled \(空到職日由最早加保日帶入\): 1/);
  assert.match(run.stdout, /arrivalStillMissing \(無到職日也無加保日\): 1/);
  assert.match(run.stdout, /EMP-030/);
  assert.match(run.stdout, /2016-05-10/);
  assert.match(run.stdout, /EMP-031/);
  rmSync(fixture, {force: true});
});


test('applyArrivalFill writes 加保日 onto empty hire dates only', async () => {
  const {db, pool} = openPglite();
  const hr = new HrStore(pool);
  await hr.ensure();
  await hr.upsertEmployee('EMP-030', {name: '劉金福', department: '摺疊', arrivalDate: ''}, 'test', {create: true});
  await hr.upsertEmployee('EMP-001', {name: '黃淑芬', department: '行政', arrivalDate: '2019-03-01'}, 'test', {create: true});
  await hr.addRecord('insurance', {employeeId: 'EMP-030', labor: '加保', health: '加保', date: '2016-05-10'}, 'test');
  await hr.addRecord('insurance', {employeeId: 'EMP-030', labor: '加保', health: '退保', date: '2016-05-12'}, 'test');
  const recs = (await hr.state()).records;
  const emps = (await hr.state()).employees;
  const result = await applyArrivalFill(pool, {employees: emps, records: recs});
  assert.equal(result.filled, 1);
  assert.equal(result.stillMissing, 0);
  const again = (await hr.state()).employees.find((e) => e.id === 'EMP-030');
  assert.equal(again.arrivalDate, '2016-05-10');
  assert.equal(again.arrivalDateSource.type, '加保日');
  const kept = (await hr.state()).employees.find((e) => e.id === 'EMP-001');
  assert.equal(kept.arrivalDate, '2019-03-01');
  const second = await applyArrivalFill(pool, {employees: (await hr.state()).employees, records: recs});
  assert.equal(second.filled, 0);
  await db.close();
});
