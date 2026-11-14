import test from 'node:test';
import assert from 'node:assert/strict';
import {isValidTaiwanId, maskTaiwanId, normalizeTaiwanId} from '../backend/hr-twid.mjs';
import {isLeftJobDocPath} from '../backend/hr-ocr.mjs';
import {encryptSecret, decryptSecret, last4, hasPiiKey} from '../backend/hr-crypto.mjs';
import {planArrivalFromInsurance, earliestEnrollmentDate} from '../backend/hr-arrival.mjs';
import {normalizeExtract, packConfirmed, geminiReady} from '../backend/hr-ocr.mjs';

test('Taiwan ID checksum accepts a known valid number and rejects a bad check digit', () => {
  assert.equal(isValidTaiwanId('A123456789'), true);
  assert.equal(isValidTaiwanId('a123456789'), true);
  assert.equal(isValidTaiwanId('A123456788'), false);
  assert.equal(isValidTaiwanId(''), false);
  assert.equal(isValidTaiwanId('1234567890'), false);
  assert.equal(maskTaiwanId('A123456789'), 'A****6789');
  assert.equal(normalizeTaiwanId(' a123456789 '), 'A123456789');
});

test('PII key encrypts bank accounts and last4 never includes the full number', () => {
  const prev = process.env.HR_PII_KEY;
  process.env.HR_PII_KEY = 'ab'.repeat(32);
  try {
    assert.equal(hasPiiKey(), true);
    const blob = encryptSecret('12345678901234');
    assert.match(blob, /^v1:/);
    assert.equal(decryptSecret(blob), '12345678901234');
    assert.ok(!blob.includes('12345678901234'));
    assert.equal(last4('12345678901234'), '1234');
  } finally {
    if (prev == null) delete process.env.HR_PII_KEY;
    else process.env.HR_PII_KEY = prev;
  }
});

test('missing PII key degrades: cannot pack a bank account', () => {
  const prev = process.env.HR_PII_KEY;
  delete process.env.HR_PII_KEY;
  try {
    assert.equal(hasPiiKey(), false);
    assert.throws(() => packConfirmed('bank', {account: '1234567890', bankCode: '004', accountName: '測試'}), /HR_PII_KEY/);
  } finally {
    if (prev == null) delete process.env.HR_PII_KEY;
    else process.env.HR_PII_KEY = prev;
  }
});

test('identity confirm requires a valid Taiwan ID checksum', () => {
  const prev = process.env.HR_PII_KEY;
  process.env.HR_PII_KEY = 'ab'.repeat(32);
  try {
    assert.throws(() => packConfirmed('identity', {nationalId: 'A123456788', name: '測試'}), /檢查碼/);
    const packed = packConfirmed('identity', {nationalId: 'A123456789', name: '王小明', birthDate: '1990-01-02'});
    assert.equal(packed.nationalIdMask, 'A****6789');
    assert.ok(packed.nationalIdEnc);
    assert.ok(!JSON.stringify(packed).includes('A123456789'));
  } finally {
    if (prev == null) delete process.env.HR_PII_KEY;
    else process.env.HR_PII_KEY = prev;
  }
});

test('arrival fill uses the earliest 加保 date and leaves others missing', () => {
  const employees = [
    {id: 'A', name: '已有', arrivalDate: '2019-03-01'},
    {id: 'B', name: '舊員', arrivalDate: ''},
    {id: 'C', name: '仍缺', arrivalDate: ''},
  ];
  const records = [
    {employee_id: 'B', kind: 'insurance', payload: {labor: '加保', health: '退保', date: '2016-05-12'}},
    {employee_id: 'B', kind: 'insurance', payload: {labor: '加保', health: '加保', date: '2016-05-10'}},
    {employee_id: 'A', kind: 'insurance', payload: {labor: '加保', health: '加保', date: '2010-01-01'}},
  ];
  const plan = planArrivalFromInsurance(employees, records);
  assert.equal(plan.filled.length, 1);
  assert.equal(plan.filled[0].employeeId, 'B');
  assert.equal(plan.filled[0].arrivalDate, '2016-05-10');
  assert.equal(plan.filled[0].source, '加保日');
  assert.deepEqual(plan.stillMissing.map((x) => x.employeeId), ['C']);
  assert.equal(earliestEnrollmentDate(records.filter((r) => r.employee_id === 'B')), '2016-05-10');
});

test('Gemini unconfigured is detected and extract warnings flag a bad ID', () => {
  assert.equal(geminiReady({key: ''}), false);
  assert.equal(geminiReady({key: 'PASTE_YOUR_KEY_HERE'}), false);
  assert.equal(geminiReady({key: 'real'}), true);
  const extracted = normalizeExtract('identity', {nationalId: 'A123456788', name: '測試', birthDate: '1990-01-02', warnings: []});
  assert.ok(extracted.warnings.some((w) => w.includes('檢查碼')));
});

test('batch scan skips 離職 folder paths', () => {
  assert.equal(isLeftJobDocPath('離職/張三.pdf'), true);
  assert.equal(isLeftJobDocPath('離職'), true);
  assert.equal(isLeftJobDocPath('張三.pdf'), false);
  assert.equal(isLeftJobDocPath('外籍居留證/a.jpg'), false);
});
