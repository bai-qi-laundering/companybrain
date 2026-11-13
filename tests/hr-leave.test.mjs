import test from 'node:test';
import assert from 'node:assert/strict';
import {statutoryDays, yearsForEmployee, hoursToDays, parsePeriod, defaultSettlement, summaryLine, addMonths, addYears} from '../backend/hr-leave.mjs';

test('LSA Art.38 statutory days on anniversary starts', () => {
  const hire = '2019-03-01';
  assert.equal(statutoryDays(hire, '2019-08-31'), 0);
  assert.equal(statutoryDays(hire, addMonths(hire, 6)), 3);
  assert.equal(statutoryDays(hire, '2020-03-01'), 7);
  assert.equal(statutoryDays(hire, '2021-03-01'), 10);
  assert.equal(statutoryDays(hire, '2022-03-01'), 14);
  assert.equal(statutoryDays(hire, '2023-03-01'), 14);
  assert.equal(statutoryDays(hire, '2024-03-01'), 15);
  assert.equal(statutoryDays(hire, '2028-03-01'), 15);
  assert.equal(statutoryDays(hire, '2029-03-01'), 16);
  assert.equal(statutoryDays(hire, addYears(hire, 24)), 30);
  assert.equal(statutoryDays(hire, addYears(hire, 30)), 30);
});

test('anniversary leave years start at six months then each hire anniversary', () => {
  const years = yearsForEmployee('2019-03-01', '2026-11-13', 'anniversary');
  assert.equal(years[0].startsOn, '2019-09-01');
  assert.equal(years[0].endsOn, '2020-02-29');
  assert.equal(years[0].statutory, 3);
  const cur = years.find((y) => y.startsOn === '2026-03-01');
  assert.ok(cur);
  assert.equal(cur.endsOn, '2027-02-28');
  assert.equal(cur.statutory, 15);
});

test('old period text 2026週年 maps to anniversary year and hours convert to half days', () => {
  const y = parsePeriod('2026週年', '2019-03-01', '2026-06-02');
  assert.equal(y.startsOn, '2026-03-01');
  assert.equal(hoursToDays(4), 0.5);
  assert.equal(hoursToDays(8), 1);
  assert.equal(defaultSettlement(9), '未休完已折現');
  assert.equal(defaultSettlement(0), '已休完');
  assert.equal(summaryLine({entitled: 15, carried: 0, used: 6, remaining: 9, status: '未結算'}), '15 天，用了 6 天，剩 9 天，未結算');
});
