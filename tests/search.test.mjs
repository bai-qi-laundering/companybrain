import test from 'node:test';
import assert from 'node:assert/strict';
import {searchOrganizations, suggestKeywords, findSnippet, markPlain, formatMatchHint} from '../backend/search.mjs';
import {resolveOrganization} from '../backend/organizations.mjs';
import {retrieve} from '../backend/assistant.mjs';

const yonglong = {id: 'yonglong', name: '永隆五金', kind: '設備商', aliases: [], keywords: [], contact: '王先生', role: '窗口', manager: '', contract: '', memo: '', prices: []};
const other = {id: 'other', name: '大信設備', kind: '設備商', aliases: [], keywords: [], contact: '', role: '', manager: '', contract: '', memo: '', prices: []};
const hotel = {id: 'hotel', name: '高雄洲際飯店', kind: '飯店', aliases: ['洲際'], keywords: [], contact: '', role: '', manager: '', contract: '', memo: '', prices: []};
const records = [
  {id: 'r1', org: 'yonglong', relatedOrg: null, date: '2026-03-12', type: '一般紀錄', title: '天車維修', note: '廠內天車保養完成', sourceText: '', attachments: [{id: 'media-' + 'a'.repeat(64), mime: 'image/jpeg', name: '天車發票.jpg'}]},
  {id: 'r2', org: 'yonglong', relatedOrg: null, date: '2026-01-08', type: '一般紀錄', title: '天車發票', note: '請款', sourceText: ''},
  {id: 'r3', org: 'other', relatedOrg: null, date: '2026-04-01', type: '一般紀錄', title: '洗衣機保養', note: '', sourceText: ''},
];
const state = {organizations: [yonglong, other, hotel], records, tasks: []};

test('searching 天車 finds 永隆五金 via record content with a highlighted snippet', () => {
  const hits = searchOrganizations(state, '天車');
  assert.equal(hits[0].org.name, '永隆五金');
  assert.equal(hits.some((h) => h.org.id === 'other' || h.org.id === 'hotel'), false);
  assert.ok(hits[0].hitCount >= 2);
  const hint = hits[0].hits[0];
  assert.match(hint.snippet, /天車/);
  assert.ok(hint.start >= 0);
  assert.match(markPlain(hint.snippet, hint.start, hint.length), /「天車/);
  assert.match(formatMatchHint(hint), /紀錄：/);
});

test('exact organization name ranks above a content mention of the same words', () => {
  const hits = searchOrganizations({
    organizations: [yonglong, other, hotel],
    records: [...records, {id: 'r4', org: 'other', relatedOrg: null, date: '2026-05-01', type: '一般紀錄', title: '比較永隆五金報價', note: '', sourceText: ''}],
    tasks: [],
  }, '永隆五金');
  assert.equal(hits[0].org.name, '永隆五金');
  assert.equal(hits[0].matchType, 'name');
  assert.ok(hits.some((h) => h.org.id === 'other' && h.matchType === 'content'));
});

test('resolveOrganization and retrieve find the crane vendor from 天車 without using the org name', () => {
  assert.equal(resolveOrganization(null, state.organizations, '天車廠商是誰', {records, tasks: []}).id, 'yonglong');
  assert.equal(resolveOrganization('洲際', state.organizations).id, 'hotel');
  assert.equal(resolveOrganization(null, state.organizations, '今天陌生飯店客訴', {records, tasks: []}), null);
  const evidence = retrieve(state, {keywords: ['天車'], orgIds: []}, '天車廠商是誰');
  assert.equal(evidence.organizations[0].id, 'yonglong');
  assert.ok(String(evidence.organizations[0].matchHint).includes('天車'));
  assert.ok(evidence.items.some((r) => r.id === 'r1' || r.id === 'r2'));
});

test('attachment filenames and saved keywords are searchable, and frequent record terms are suggested', () => {
  const byFile = searchOrganizations({organizations: [yonglong, other], records, tasks: []}, '發票.jpg');
  assert.ok(byFile.some((h) => h.org.id === 'yonglong'));
  const tagged = {...yonglong, keywords: ['天車']};
  const hits = searchOrganizations({organizations: [tagged, other], records: [], tasks: []}, '天車');
  assert.equal(hits[0].org.id, 'yonglong');
  assert.equal(hits[0].matchType, 'keyword');
  const suggestions = suggestKeywords(yonglong, records, []);
  assert.ok(suggestions.some((s) => s.term.includes('天車')));
});
