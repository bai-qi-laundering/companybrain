#!/usr/bin/env node
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, rmSync} from 'node:fs';
import path from 'node:path';

const dest = process.argv[2] || '/workspace/hr-merge/fixtures/hr-sample.sqlite3';
mkdirSync(path.dirname(dest), {recursive: true});
try { rmSync(dest); } catch {}
const db = new DatabaseSync(dest);
db.exec(`
CREATE TABLE employees(id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE records(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id), kind TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE salaries(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id), month TEXT NOT NULL, digest TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL, UNIQUE(employee_id,month,digest));
CREATE TABLE documents(id TEXT PRIMARY KEY, category TEXT NOT NULL, relative_path TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, available INTEGER NOT NULL, employee_id TEXT REFERENCES employees(id), suggestions TEXT NOT NULL, UNIQUE(category,relative_path));
CREATE TABLE attendance(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id), data TEXT NOT NULL);
CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT, created TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE candidates(id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE recruitment_events(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id), kind TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE recruitment_import_rows(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id), data TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE recruitment_goals(department TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE leave_import_rows(id TEXT PRIMARY KEY, employee_id TEXT REFERENCES employees(id), data TEXT NOT NULL, created TEXT NOT NULL);
`);
const emp = JSON.stringify({name:'黃淑芬',department:'行政',job:'人資行政',employmentType:'正職',arrivalDate:'2019-03-01',departureDate:'',phone:'0912-000-001',emergencyContact:'黃先生',paperLocation:'行政櫃',notes:'',lineBound:''});
db.prepare('INSERT INTO employees(id,data,revision) VALUES(?,?,1)').run('EMP-001', emp);
const empOld = JSON.stringify({name:'劉金福',department:'摺疊',job:'摺疊',employmentType:'正職',arrivalDate:'',departureDate:'',phone:'0912-000-030',emergencyContact:'',paperLocation:'',notes:'示意：舊員工缺到職日',lineBound:''});
db.prepare('INSERT INTO employees(id,data,revision) VALUES(?,?,1)').run('EMP-030', empOld);
const empMiss = JSON.stringify({name:'缺件測試',department:'物流',job:'司機',employmentType:'正職',arrivalDate:'',departureDate:'',phone:'',emergencyContact:'',paperLocation:'',notes:'示意：無到職日也無加保',lineBound:''});
db.prepare('INSERT INTO employees(id,data,revision) VALUES(?,?,1)').run('EMP-031', empMiss);
const recs = [
  ['REC-L1','EMP-001','leave', JSON.stringify({id:'REC-L1',employeeId:'EMP-001',date:'2026-03-01',period:'2026週年',action:'核給',hours:120,notes:'年度核給'}), '2026-03-01T00:00:00+08:00'],
  ['REC-L2','EMP-001','leave', JSON.stringify({id:'REC-L2',employeeId:'EMP-001',date:'2026-06-02',period:'2026週年',action:'已休',hours:16,notes:'兩天'}), '2026-06-02T00:00:00+08:00'],
  ['REC-I1','EMP-001','insurance', JSON.stringify({labor:'加保',health:'加保',date:'2019-03-01'}), '2019-03-01T00:00:00+08:00'],
  ['REC-I2','EMP-030','insurance', JSON.stringify({labor:'加保',health:'加保',date:'2016-05-10'}), '2016-05-10T00:00:00+08:00'],
  ['REC-I3','EMP-030','insurance', JSON.stringify({labor:'加保',health:'退保',date:'2016-05-12'}), '2016-05-12T00:00:00+08:00'],
];
const ins = db.prepare('INSERT INTO records VALUES(?,?,?,?,?)');
for (const r of recs) ins.run(...r);
db.prepare('INSERT INTO candidates VALUES(?,?,1,?,?)').run('R-03', JSON.stringify({name:'許雅琪',phone:'0988-100-003',department:'行政',job:'人資行政',status:'待報到',employeeId:''}), '2026-11-01T00:00:00+08:00', '2026-11-01T00:00:00+08:00');
db.prepare('INSERT INTO salaries VALUES(?,?,?,?,?,?,?,?)').run('SAL-1','EMP-001','2026-09','digest-demo',1,'待核對', JSON.stringify({month:'2026-09',netPay:1,source:'示意'}), '2026-10-01T00:00:00+08:00');
db.prepare('INSERT INTO attendance VALUES(?,?,?)').run('ATT-1','EMP-001', JSON.stringify({employeeId:'EMP-001',date:'2026-10-14',time:'08:00:00',type:'上班'}));
db.close();
console.log('wrote ' + dest);
