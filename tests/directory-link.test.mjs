import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFolderName, matchCandidateFolders, applyExactDirectoryLinks,
  SYNONYM_GROUPS, CONFIRMED_FOLDER_LINKS, resolveConfirmedTargets,
} from '../backend/directory-link.mjs';
import {normalizeName} from '../backend/directory-link.mjs';

function indexFrom(orgs, emps = []) {
  return matchCandidateFolders({folders: []}, {organizations: orgs, employees: emps}).index;
}

const orgs = [
  {id: 'h2o', name: 'H2O', kind: '飯店', aliases: ['H2O']},
  {id: 'indigo', name: '英迪格', kind: '飯店', aliases: []},
  {id: 'jie-c', name: '捷絲旅中正館', kind: '飯店', aliases: ['捷中正']},
  {id: 'jie-s', name: '捷絲旅站前館', kind: '飯店', aliases: ['捷站前']},
  {id: 'yan', name: '然一', kind: '飯店', aliases: []},
  {id: 'yi', name: '驛館', kind: '飯店', aliases: []},
  {id: 'hao3', name: '好地方三多館', kind: '飯店', aliases: ['好地方']},
  {id: 'hao6', name: '好地方六合館', kind: '飯店', aliases: ['好六']},
  {id: 'salt', name: '鹽旅/泊思行旅', kind: '飯店', aliases: ['鹽旅']},
  {id: 'camel', name: '駱駝', kind: '飯店', aliases: []},
  {id: 'ecolab', name: '藝康企業股份有限公司', kind: '原料商', aliases: ['藝康']},
];
const emps = [{id: 'F004', name: '張玉菁'}];

test('synonyms, character folding, parenthetical descriptors and aliases classify as exact', () => {
  const index = indexFrom(orgs, emps);
  assert.equal(classifyFolderName('INDIGO', index).confidence, 'exact');
  assert.equal(classifyFolderName('INDIGO', index).hits[0].id, 'indigo');
  assert.equal(classifyFolderName('塩旅', index).hits[0].id, 'salt');
  assert.equal(classifyFolderName('然一(舊合約、報價)', index).confidence, 'exact');
  assert.equal(classifyFolderName('然一(舊合約、報價)', index).hits[0].id, 'yan');
  assert.equal(classifyFolderName('驛館(舊合約、資料)', index).hits[0].id, 'yi');
  assert.equal(classifyFolderName('好地方', index).hits[0].id, 'hao3');
  assert.equal(classifyFolderName('好六', index).hits[0].id, 'hao6');
  assert.equal(classifyFolderName('捷中正', index).hits[0].id, 'jie-c');
  assert.equal(classifyFolderName('駱駝客衣單範本', index).confidence, 'exact');
  assert.equal(classifyFolderName('藝康', index).hits[0].id, 'ecolab');
  assert.equal(classifyFolderName('張玉菁', index).hits[0].id, 'F004');
  assert.ok(SYNONYM_GROUPS.some((g) => g.includes('INDIGO') && g.includes('英迪格')));
  assert.equal(normalizeName('塩旅'), normalizeName('鹽旅'));
});

test('捷絲旅 is ambiguous; compound parents are mixed; given name is fuzzy', () => {
  const index = indexFrom(orgs, emps);
  const jie = classifyFolderName('捷絲旅', index);
  assert.equal(jie.confidence, 'ambiguous');
  assert.equal(jie.hits.length, 2);
  const mixed = classifyFolderName('然一、驛館', index);
  assert.equal(mixed.confidence, 'mixed');
  assert.equal(mixed.hits.length, 2);
  const given = classifyFolderName('玉菁', index);
  assert.equal(given.confidence, 'fuzzy');
  assert.equal(given.hits[0].id, 'F004');
  assert.equal(classifyFolderName('日澤', index).confidence, 'unmatched');
});

test('exact links skip mixed parents, collapse child folders, and apply is idempotent', async () => {
  const folders = [
    {relativePath: '合約書、報價單/H2O', name: 'H2O', parent: '合約書、報價單'},
    {relativePath: '合約書、報價單/H2O/舊合約、報價、資料', name: '舊合約、報價、資料', parent: '合約書、報價單/H2O'},
    {relativePath: '合約書、報價單/INDIGO', name: 'INDIGO', parent: '合約書、報價單'},
    {relativePath: '合約書、報價單/捷絲旅', name: '捷絲旅', parent: '合約書、報價單'},
    {relativePath: '合約書、報價單/然一、驛館', name: '然一、驛館', parent: '合約書、報價單'},
    {relativePath: '合約書、報價單/然一、驛館/驛館', name: '驛館', parent: '合約書、報價單/然一、驛館'},
    {relativePath: '合約書、報價單/然一、驛館/然一(舊合約、報價)', name: '然一(舊合約、報價)', parent: '合約書、報價單/然一、驛館'},
    {relativePath: '員工/張玉菁', name: '張玉菁', parent: '員工'},
    {relativePath: '員工/請假紀錄/玉菁', name: '玉菁', parent: '員工/請假紀錄'},
    {relativePath: '廠商/日澤', name: '日澤', parent: '廠商'},
  ];
  const matched = matchCandidateFolders({folders}, {organizations: orgs, employees: emps});
  const paths = matched.links.map((l) => l.relativePath).sort();
  assert.ok(paths.includes('合約書、報價單/H2O'));
  assert.ok(!paths.includes('合約書、報價單/H2O/舊合約、報價、資料'));
  assert.ok(paths.includes('合約書、報價單/INDIGO'));
  assert.equal(matched.links.filter((l) => l.relativePath === '合約書、報價單/捷絲旅').length, 2);
  assert.deepEqual(
    matched.links.filter((l) => l.relativePath === '合約書、報價單/捷絲旅').map((l) => l.entityId).sort(),
    ['jie-c', 'jie-s']
  );
  assert.ok(!paths.includes('合約書、報價單/然一、驛館'));
  assert.ok(paths.includes('合約書、報價單/然一、驛館/驛館'));
  assert.ok(paths.includes('合約書、報價單/然一、驛館/然一(舊合約、報價)'));
  assert.ok(paths.includes('員工/張玉菁'));
  assert.ok(paths.includes('員工/請假紀錄/玉菁'));
  assert.ok(!paths.includes('廠商/日澤'));

  const saved = [];
  const store = {
    async directoryFolders(kind, id) { return saved.filter((r) => r.kind === kind && r.entityId === id); },
    async saveDirectoryFolder(kind, entityId, relativePath, opts = {}) {
      if (saved.some((r) => r.kind === kind && r.entityId === entityId && r.relativePath === relativePath)) return;
      saved.push({kind, entityId, relative_path: relativePath, relativePath, role: opts.role || 'linked', source: opts.source || 'auto'});
    },
  };
  const first = await applyExactDirectoryLinks({store, root: '/tmp', links: matched.links});
  const second = await applyExactDirectoryLinks({store, root: '/tmp', links: matched.links});
  assert.equal(first.added, matched.links.length);
  assert.equal(second.added, 0);
  assert.equal(second.skipped, matched.links.length);
});

const confirmedOrgs = [
  ...orgs,
  {id: 'liang1', name: '良一', kind: '飯店', aliases: []},
  {id: 'liangx', name: '良西', kind: '飯店', aliases: []},
  {id: 'liangz', name: '良站前', kind: '飯店', aliases: ['良站']},
  {id: 'chengyi', name: '承億酒店', kind: '飯店', aliases: ['承億']},
  {id: 'li-liu', name: '秝芯旅店六合館', kind: '飯店', aliases: ['秝芯']},
  {id: 'li-bo', name: '秝芯旅店駁二館', kind: '飯店', aliases: ['秝二']},
];
const confirmedEmps = [
  ...emps,
  {id: 'F005', name: '陳紅幸'},
  {id: 'F006', name: '吳育賢'},
];

test('user-confirmed fuzzy and ambiguous folders become idempotent links', async () => {
  const folders = [
    {relativePath: '客戶&廠商/客戶對話紀錄截圖、染色、破損照/良一、西', name: '良一、西', parent: '客戶&廠商/客戶對話紀錄截圖、染色、破損照'},
    {relativePath: '客戶&廠商/客戶對話紀錄截圖、染色、破損照/良站', name: '良站', parent: '客戶&廠商/客戶對話紀錄截圖、染色、破損照'},
    {relativePath: '合約書、報價單/秝芯合約書', name: '秝芯合約書', parent: '合約書、報價單'},
    {relativePath: '合約書、報價單/秝芯合約書/秝芯(駁二)名片', name: '秝芯(駁二)名片', parent: '合約書、報價單/秝芯合約書'},
    {relativePath: '員工/勞工局資料/勞工局罰款(吳育賢、陳紅幸)', name: '勞工局罰款(吳育賢、陳紅幸)', parent: '員工/勞工局資料'},
    {relativePath: '員工/請假紀錄/玉菁', name: '玉菁', parent: '員工/請假紀錄'},
    {relativePath: '客戶&廠商/110年春酒/捷絲旅', name: '捷絲旅', parent: '客戶&廠商/110年春酒'},
    {relativePath: '合約書、報價單/@其他客戶報價/捷絲旅', name: '捷絲旅', parent: '合約書、報價單/@其他客戶報價'},
    {relativePath: '合約書、報價單/捷絲旅', name: '捷絲旅', parent: '合約書、報價單'},
    {relativePath: '合約書、報價單/@其他客戶報價/承億文旅、酒店', name: '承億文旅、酒店', parent: '合約書、報價單/@其他客戶報價'},
  ];
  const matched = matchCandidateFolders({folders}, {organizations: confirmedOrgs, employees: confirmedEmps});

  function ids(path) {
    return matched.links.filter((l) => l.relativePath === path).map((l) => l.entityId).sort();
  }
  assert.deepEqual(ids('客戶&廠商/客戶對話紀錄截圖、染色、破損照/良一、西'), ['liang1', 'liangx']);
  assert.deepEqual(ids('客戶&廠商/客戶對話紀錄截圖、染色、破損照/良站'), ['liangz']);
  assert.deepEqual(ids('合約書、報價單/秝芯合約書'), ['li-bo']);
  assert.deepEqual(ids('合約書、報價單/秝芯合約書/秝芯(駁二)名片'), ['li-bo']);
  assert.ok(!ids('合約書、報價單/秝芯合約書').includes('li-liu'));
  assert.deepEqual(ids('員工/勞工局資料/勞工局罰款(吳育賢、陳紅幸)'), ['F005']);
  assert.ok(!ids('員工/勞工局資料/勞工局罰款(吳育賢、陳紅幸)').includes('F006'));
  assert.deepEqual(ids('員工/請假紀錄/玉菁'), ['F004']);
  for (const path of [
    '客戶&廠商/110年春酒/捷絲旅',
    '合約書、報價單/@其他客戶報價/捷絲旅',
    '合約書、報價單/捷絲旅',
  ]) {
    assert.deepEqual(ids(path), ['jie-c', 'jie-s']);
  }
  assert.deepEqual(ids('合約書、報價單/@其他客戶報價/承億文旅、酒店'), ['chengyi']);
  assert.equal(matched.missing.length, 0);
  assert.ok(CONFIRMED_FOLDER_LINKS.length >= 8);

  const saved = [];
  const store = {
    async directoryFolders(kind, id) { return saved.filter((r) => r.kind === kind && r.entityId === id); },
    async saveDirectoryFolder(kind, entityId, relativePath, opts = {}) {
      if (saved.some((r) => r.kind === kind && r.entityId === entityId && r.relativePath === relativePath)) return;
      saved.push({kind, entityId, relative_path: relativePath, relativePath, role: opts.role || 'linked', source: opts.source || 'auto'});
    },
  };
  const first = await applyExactDirectoryLinks({store, root: '/tmp', links: matched.links, missing: matched.missing});
  const second = await applyExactDirectoryLinks({store, root: '/tmp', links: matched.links, missing: matched.missing});
  assert.equal(first.added, matched.links.length);
  assert.equal(second.added, 0);
  assert.ok(saved.every((r) => r.source === 'confirmed'));
  assert.equal(first.missing.length, 0);
});

test('confirmed links report missing targets and do not invent records', () => {
  const folders = [
    {relativePath: '客戶&廠商/客戶對話紀錄截圖、染色、破損照/良一、西', name: '良一、西'},
    {relativePath: '合約書、報價單/秝芯合約書', name: '秝芯合約書'},
  ];
  const onlyLiang1 = [
    {id: 'liang1', name: '良一', kind: '飯店', aliases: []},
    {id: 'li-liu', name: '秝芯旅店六合館', kind: '飯店', aliases: ['秝芯']},
  ];
  const matched = matchCandidateFolders({folders}, {organizations: onlyLiang1, employees: []});
  assert.deepEqual(
    matched.links.filter((l) => l.relativePath.endsWith('良一、西')).map((l) => l.entityId),
    ['liang1']
  );
  assert.ok(matched.missing.some((m) => m.path.endsWith('良一、西') && m.name === '良西'));
  assert.equal(matched.links.filter((l) => l.relativePath === '合約書、報價單/秝芯合約書').length, 0);
  assert.ok(matched.missing.some((m) => m.path === '合約書、報價單/秝芯合約書' && m.name === '秝芯旅店駁二館'));
});
