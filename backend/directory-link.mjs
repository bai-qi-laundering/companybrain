import {readdir, stat} from 'node:fs/promises';
import path from 'node:path';
import {orgDirectoryKind, KIND_FOLDERS, RESERVED_EMPLOYEE_FOLDERS, directoryRoot, safeJoinRoot} from './directory-docs.mjs';

export const SYNONYM_GROUPS = [
  ['INDIGO', 'Indigo', 'indigo', '英迪格'],
];

export const GENERIC_SUFFIXES = [
  '合約書', '合約', '報價單', '報價', '洗前照片', '客衣單範本', '範本',
  '資料', '名片', '相關', '舊合約', '舊資料',
];

// User-confirmed folder links (2026-11-20). Paths are relative to the 百麒 root.
// Each targets[] entry is one directory record, tried by name then alias; missing names are reported, never invented.
export const CONFIRMED_FOLDER_LINKS = [
  {path: '客戶&廠商/客戶對話紀錄截圖、染色、破損照/良一、西', targets: [['良一'], ['良西']]},
  {path: '客戶&廠商/客戶對話紀錄截圖、染色、破損照/良站', targets: [['良站前']]},
  {path: '合約書、報價單/秝芯合約書', targets: [['秝芯旅店駁二館', '秝二']]},
  {path: '合約書、報價單/秝芯合約書/秝芯(駁二)名片', targets: [['秝芯旅店駁二館', '秝二']]},
  {path: '員工/勞工局資料/勞工局罰款(吳育賢、陳紅幸)', targets: [['陳紅幸']]},
  {path: '員工/請假紀錄/玉菁', targets: [['張玉菁']]},
  {name: '捷絲旅', targets: [['捷絲旅中正館', '捷中正'], ['捷絲旅站前館', '捷站前']]},
  {path: '合約書、報價單/@其他客戶報價/承億文旅、酒店', targets: [['承億酒店', '承億']]},
];

export function confirmedRuleFor(folder) {
  const rel = folder.relativePath || folder;
  const name = folder.name || String(rel).split('/').pop();
  for (const rule of CONFIRMED_FOLDER_LINKS) {
    if (rule.path && rel === rule.path) return rule;
    if (rule.name && name === rule.name) return rule;
  }
  return null;
}

const SKIP_TOP = new Set([
  '0年分類帳(空)', '0年支出明細(空)',
  '公告', '表格', '面試', '工作SOP', '保險資料', 'Apollo人資系統',
  '舊資料', '掃描', '薪資表', '年度薪資', '會計師相關報表', '出差旅單',
  '各組維修保樣', '水處理圖片', '洗劑物質成分資料', '貨車行照',
  '重要對話紀錄', '鍋爐改裝', '沒在用的雜項', '國際自備資金',
  '百、聖、富給國際', '@百麒闆-紀錄事項',
  '106年11月員工守則(新)李老師給',
]);

const SKIP_TOP_PREFIX = /^(?:\d+年分類帳|\d+年支出明細)/;

const MIXED_SKIP_NAMES = new Set([
  '現行合約', '租賃合約', '舊資料', '近期詢問未簽合約',
  '@空白報價&合約書', '聊天紀錄', '對話紀錄', '布品照片', '布品',
  '新增資料夾', '照片', '無續簽', '餐廳',
  'SGS檢驗資料', 'TLV闕水器', '客戶資料 與空白表格', '廠商名片',
  '橘桶加輪子照片檔', '百麒與他家差異',
]);

const MIXED_SKIP_RE = /(春酒|尾牙|破損桶子)$/;

const PII_EMPLOYEE_FOLDERS = new Set([
  '員工身分證(在職)',
  '員工身分證、駕照(離職)',
  '員工駕照',
  '存簿匯款資料',
  '履歷表',
  'ID資料',
]);

export function isProtectedEmployeePath(relativePath) {
  const parts = String(relativePath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts[0] !== '員工') return false;
  return PII_EMPLOYEE_FOLDERS.has(parts[1] || '');
}

export function foldChars(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/塩/g, '鹽')
    .replace(/台/g, '臺')
    .replace(/微/g, '薇');
}

export function normalizeName(s) {
  return foldChars(s)
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[（）()[\]【】.,，。．、／/\-_＆&＋+·・'’"“”\s]/g, '')
    .trim();
}

export function splitCompound(name) {
  const inner = [];
  const stripped = String(name || '').replace(/[（(]([^）)]*)[）)]/g, (_, a) => {
    inner.push(...String(a).split(/[、,&＆／]/));
    return ' ';
  });
  const parts = [...stripped.split(/[、,&＆／]/), ...inner]
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length >= 2 ? parts : [String(name || '').trim()].filter(Boolean);
}

function companySuffixes() {
  return ['企業股份有限公司', '股份有限公司', '有限公司', '企業'];
}

function strippedCompany(name) {
  let s = String(name || '').trim();
  for (const suf of companySuffixes()) {
    if (s.endsWith(suf) && s.length > suf.length + 1) s = s.slice(0, -suf.length);
  }
  return s.trim();
}

export function entityLabels(entity, {kind} = {}) {
  const labels = new Set();
  const add = (v) => {
    const s = String(v || '').trim();
    if (s) labels.add(s);
    const stripped = strippedCompany(s);
    if (stripped && stripped !== s) labels.add(stripped);
    for (const group of SYNONYM_GROUPS) {
      if (group.some((g) => g === s)) for (const g of group) labels.add(g);
    }
  };
  add(entity.name);
  add(entity.id);
  for (const a of entity.aliases || []) add(a);
  if (kind === 'employees') add(entity.id);
  return [...labels];
}

function indexEntities(organizations = [], employees = []) {
  const byNorm = new Map();
  const records = [];
  const add = (entity, kind, type) => {
    const rec = {entity, kind, type, id: entity.id, name: entity.name, labels: entityLabels(entity, {kind})};
    records.push(rec);
    for (const label of rec.labels) {
      const key = normalizeName(label);
      if (!key) continue;
      if (!byNorm.has(key)) byNorm.set(key, []);
      if (!byNorm.get(key).some((r) => r.type === type && r.id === rec.id)) byNorm.get(key).push(rec);
    }
  };
  for (const o of organizations) add(o, orgDirectoryKind(o), 'org');
  for (const e of employees) add(e, 'employees', 'employee');
  return {byNorm, records};
}

function uniqueHits(hits) {
  const seen = new Map();
  for (const h of hits) seen.set(h.type + ':' + h.id, h);
  return [...seen.values()];
}

function lookupExact(byNorm, name) {
  const key = normalizeName(name);
  if (!key) return [];
  return uniqueHits(byNorm.get(key) || []);
}

export function resolveConfirmedTargets(targets, index) {
  const hits = [];
  const missing = [];
  for (const names of targets || []) {
    let found = null;
    for (const name of names) {
      const matches = lookupExact(index.byNorm, name);
      if (matches.length === 1) { found = matches[0]; break; }
      if (matches.length > 1) { found = {ambiguous: true, name, matches}; break; }
    }
    if (found && found.id) {
      if (!hits.some((h) => h.type === found.type && h.id === found.id)) hits.push(found);
    } else if (found && found.ambiguous) {
      missing.push(names[0] + '（名錄中不唯一）');
    } else {
      missing.push(names[0]);
    }
  }
  return {hits, missing};
}

function hasGenericSuffix(folderName, label) {
  const fn = foldChars(folderName);
  const lb = foldChars(label);
  if (!fn.startsWith(lb) || fn.length === lb.length) return false;
  const rest = fn.slice(lb.length).replace(/^[-\s_]+/, '');
  return GENERIC_SUFFIXES.some((s) => rest === s || rest === '的' + s);
}

function otherEntitySharesPrefix(records, label, hit) {
  const key = normalizeName(label);
  if (!key || key.length < 2) return false;
  return records.some((r) => (r.type !== hit.type || r.id !== hit.id) && r.labels.some((l) => {
    const n = normalizeName(l);
    return n !== key && (n.startsWith(key) || key.startsWith(n));
  }));
}

export function isDescriptorPart(part) {
  const raw = String(part || '').trim();
  if (!raw) return true;
  const n = normalizeName(raw);
  if (!n) return true;
  const generics = new Set([...GENERIC_SUFFIXES, '舊合約', '舊資料', '對話紀錄', '相關報價單', '相關', '照片', '布品', '名片', '資料'].map(normalizeName));
  return generics.has(n);
}

function leadingLabel(folderName) {
  return String(folderName || '').replace(/[（(][^）)]*[）)]/g, ' ').split(/[、,&＆／]/)[0].trim();
}

export function classifyFolderName(folderName, index) {
  const {byNorm, records} = index;
  const lead = leadingLabel(folderName);
  const leadHits = lead ? lookupExact(byNorm, lead) : [];
  const innerAndRest = splitCompound(folderName).filter((p) => normalizeName(p) !== normalizeName(lead));
  if (leadHits.length === 1 && innerAndRest.every(isDescriptorPart)) {
    return {confidence: 'exact', reason: 'name-or-alias', hits: leadHits};
  }
  const parts = splitCompound(folderName);
  const exactParts = parts.map((p) => ({part: p, hits: lookupExact(byNorm, p)}));

  if (parts.length === 1) {
    const hits = exactParts[0].hits;
    if (hits.length === 1) return {confidence: 'exact', reason: 'name-or-alias', hits};
    if (hits.length > 1) return {confidence: 'ambiguous', reason: 'multiple-exact', hits, parts: exactParts};

    // Unique label + generic suffix (合約書、洗前照片…)
    const suffixHits = [];
    for (const rec of records) {
      for (const label of rec.labels) {
        if (hasGenericSuffix(folderName, label) && !otherEntitySharesPrefix(records, label, rec)) {
          suffixHits.push(rec);
          break;
        }
      }
    }
    const uniqueSuffix = uniqueHits(suffixHits);
    if (uniqueSuffix.length === 1) return {confidence: 'exact', reason: 'unique-suffix', hits: uniqueSuffix};
    if (uniqueSuffix.length > 1) return {confidence: 'ambiguous', reason: 'suffix-multiple', hits: uniqueSuffix};

    // Unique substring / given-name / near prefix
    const folded = normalizeName(folderName);
    const fuzzy = [];
    if (folded.length >= 2) {
      for (const rec of records) {
        for (const label of rec.labels) {
          const n = normalizeName(label);
          if (!n || n.length < 2) continue;
          if (n === folded) continue;
          if (folded.includes(n) || n.includes(folded) || n.startsWith(folded) || folded.startsWith(n)) {
            fuzzy.push(rec);
            break;
          }
        }
      }
    }
    const uniqueFuzzy = uniqueHits(fuzzy);
    if (uniqueFuzzy.length === 1) return {confidence: 'fuzzy', reason: 'partial-name', hits: uniqueFuzzy};
    if (uniqueFuzzy.length > 1) return {confidence: 'ambiguous', reason: 'partial-multiple', hits: uniqueFuzzy};
    return {confidence: 'unmatched', reason: 'no-match', hits: []};
  }

  const resolved = exactParts.filter((p) => p.hits.length === 1).map((p) => p.hits[0]);
  const amb = exactParts.filter((p) => p.hits.length > 1);
  const uniqueResolved = uniqueHits(resolved);
  if (amb.length) return {confidence: 'ambiguous', reason: 'compound-ambiguous', hits: uniqueHits([...resolved, ...amb.flatMap((p) => p.hits)]), parts: exactParts};
  if (uniqueResolved.length >= 2) return {confidence: 'mixed', reason: 'compound-multi', hits: uniqueResolved, parts: exactParts};
  if (uniqueResolved.length === 1 && exactParts.some((p) => !p.hits.length)) {
    return {confidence: 'fuzzy', reason: 'compound-partial', hits: uniqueResolved, parts: exactParts};
  }
  if (uniqueResolved.length === 1) return {confidence: 'exact', reason: 'compound-single', hits: uniqueResolved, parts: exactParts};
  // Fuzzy each unresolved part
  const fuzzyHits = [];
  for (const p of exactParts) {
    if (p.hits.length || isDescriptorPart(p.part)) continue;
    const sub = classifyFolderName(p.part, index);
    if (sub.confidence === 'fuzzy' || sub.confidence === 'exact') fuzzyHits.push(...sub.hits);
    if (sub.confidence === 'ambiguous') {
      return {confidence: 'ambiguous', reason: 'compound-ambiguous', hits: uniqueHits([...uniqueResolved, ...sub.hits]), parts: exactParts};
    }
  }
  const uniqueFuzzy = uniqueHits([...uniqueResolved, ...fuzzyHits]);
  if (uniqueFuzzy.length >= 2) return {confidence: 'mixed', reason: 'compound-multi', hits: uniqueFuzzy, parts: exactParts};
  if (uniqueFuzzy.length === 1) return {confidence: 'fuzzy', reason: 'compound-partial', hits: uniqueFuzzy, parts: exactParts};
  return {confidence: 'unmatched', reason: 'compound-none', hits: [], parts: exactParts};
}

function shouldSkipDirName(name, relParts) {
  if (!name || name === '@eaDir' || name.startsWith('@Syno')) return true;
  if (name === 'Thumbs.db' || name === 'desktop.ini') return true;
  if (relParts[0] === '員工' && PII_EMPLOYEE_FOLDERS.has(name) && relParts.length === 1) return true;
  return false;
}

export function isSkippableTopLevel(name) {
  if (SKIP_TOP.has(name) || SKIP_TOP_PREFIX.test(name)) return true;
  if (name === '其他洗衣廠') return true;
  return false;
}

export function isMixedArchiveName(name) {
  return MIXED_SKIP_NAMES.has(name) || MIXED_SKIP_RE.test(name);
}

async function dirChildren(abs) {
  try {
    return await readdir(abs, {withFileTypes: true});
  } catch {
    return [];
  }
}

export async function collectCandidateFolders(rootAbs, {maxDepth = 4} = {}) {
  const root = path.resolve(rootAbs);
  const folders = [];
  const filesAt = new Map();

  async function walk(abs, rel, depth) {
    const entries = await dirChildren(abs);
    const relParts = rel ? rel.split('/') : [];
    const fileNames = [];
    for (const ent of entries) {
      if (ent.name === '@eaDir' || ent.name.startsWith('@Syno') || ent.name === 'Thumbs.db' || ent.name === 'desktop.ini') continue;
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isFile()) {
        fileNames.push(ent.name);
        continue;
      }
      if (!ent.isDirectory()) continue;
      if (shouldSkipDirName(ent.name, relParts)) continue;
      if (!rel && isSkippableTopLevel(ent.name)) continue;
      if (relParts[0] === '員工' && PII_EMPLOYEE_FOLDERS.has(relParts[1])) continue;
      folders.push({relativePath: childRel, name: ent.name, parent: rel});
      if (depth < maxDepth) await walk(path.join(abs, ent.name), childRel, depth + 1);
    }
    filesAt.set(rel, fileNames);
  }

  await walk(root, '', 0);
  return {folders, filesAt};
}

export function matchCandidateFolders(candidates, {organizations = [], employees = []} = {}) {
  const index = indexEntities(organizations, employees);
  const byPath = new Map(candidates.folders.map((f) => [f.relativePath, f]));
  const exact = [];
  const fuzzy = [];
  const ambiguous = [];
  const unmatched = [];
  const mixed = [];
  const classified = new Map();

  function classify(folder) {
    if (classified.has(folder.relativePath)) return classified.get(folder.relativePath);
    // Skip further classification of PII
    if (isProtectedEmployeePath(folder.relativePath)) {
      const row = {folder, confidence: 'skipped', reason: 'pii', hits: []};
      classified.set(folder.relativePath, row);
      return row;
    }
    const result = classifyFolderName(folder.name, index);
    const row = {folder, ...result};
    classified.set(folder.relativePath, row);
    return row;
  }

  const autoLinks = []; // {kind, entityId, name, relativePath, confidence, reason}
  const confirmed = [];
  const missing = [];

  for (const folder of candidates.folders) {
    const rule = confirmedRuleFor(folder);
    if (rule) {
      const resolved = resolveConfirmedTargets(rule.targets, index);
      for (const name of resolved.missing) {
        if (!missing.some((m) => m.path === folder.relativePath && m.name === name)) {
          missing.push({path: folder.relativePath, name});
        }
      }
      const hits = resolved.hits;
      confirmed.push({folder, confidence: 'confirmed', reason: 'user-confirmed', hits, missing: resolved.missing});
      for (const hit of hits) {
        autoLinks.push({
          kind: hit.kind,
          entityId: hit.id,
          name: hit.name,
          type: hit.type,
          relativePath: folder.relativePath,
          confidence: 'confirmed',
          reason: 'user-confirmed',
        });
      }
      continue;
    }
    const row = classify(folder);
    const parentRow = folder.parent ? classified.get(folder.parent) || classify(byPath.get(folder.parent) || {relativePath: folder.parent, name: folder.parent.split('/').pop(), parent: ''}) : null;

    // Mixed/compound parents: auto-link only unique exact children, not the parent
    if (row.confidence === 'mixed') {
      mixed.push(row);
      continue;
    }
    if (row.confidence === 'exact' && row.hits.length === 1) {
      // If this folder's name also classified as exact but sibling compound parent is mixed,
      // still link this child.
      // If a different exact child of a mixed parent matches another entity, good.
      // Don't auto-link a mixed archive container even if the name exact-matches (e.g. 餐廳).
      if (isMixedArchiveName(folder.name) && !folder.parent) {
        unmatched.push({...row, confidence: 'unmatched', reason: 'mixed-archive'});
        continue;
      }
      // Parent folder named with this same entity (exact) — still ok to link both
      autoLinks.push({
        kind: row.hits[0].kind,
        entityId: row.hits[0].id,
        name: row.hits[0].name,
        type: row.hits[0].type,
        relativePath: folder.relativePath,
        confidence: 'exact',
        reason: row.reason,
      });
      exact.push(row);
      continue;
    }
    if (row.confidence === 'fuzzy') {
      // Don't treat generic mixed names as fuzzy even if they partial-match
      if (isMixedArchiveName(folder.name)) {
        unmatched.push({...row, confidence: 'unmatched', reason: 'mixed-archive'});
        continue;
      }
      fuzzy.push(row);
      continue;
    }
    if (row.confidence === 'ambiguous') {
      ambiguous.push(row);
      continue;
    }
    if (row.confidence === 'skipped') continue;
    // unmatched: only report "leaf-ish" candidate folders, not every misc subdir of an unmatched tree
    if (isMixedArchiveName(folder.name)) {
      unmatched.push({...row, reason: row.reason === 'no-match' ? 'mixed-archive' : row.reason});
      continue;
    }
    unmatched.push(row);
  }

  // Deduplicate auto links
  const seen = new Set();
  const links = [];
  for (const link of autoLinks) {
    const key = link.kind + ':' + link.entityId + ':' + link.relativePath;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(link);
  }
  // Collapse descendant exact links, but keep user-confirmed child folders (e.g. 秝芯(駁二)名片).
  const collapsed = links.filter((l) => l.confidence === 'confirmed' || !links.some((o) =>
    o !== l && o.kind === l.kind && o.entityId === l.entityId && l.relativePath.startsWith(o.relativePath + '/')
  ));

  return {exact, fuzzy, ambiguous, unmatched, mixed, confirmed, missing, links: collapsed, index};
}

export function summarizeMatch(result, {filesAt} = {}) {
  const describeHits = (hits) => hits.map((h) => `${h.name}（${h.kind === 'employees' ? '員工' : h.kind === 'clients' ? '客人' : '廠商'} ${h.id}）`).join('、');
  const rows = (list) => list.map((r) => ({
    path: r.folder.relativePath,
    name: r.folder.name,
    reason: r.reason,
    matches: describeHits(r.hits || []),
    leftoverFiles: (filesAt && filesAt.get(r.folder.relativePath) || []).slice(0, 20),
  }));
  return {
    counts: {
      exactFolders: result.exact.length,
      exactLinks: result.links.length,
      confirmed: (result.confirmed || []).length,
      missing: (result.missing || []).length,
      fuzzy: result.fuzzy.length,
      ambiguous: result.ambiguous.length,
      mixed: result.mixed.length,
      unmatched: result.unmatched.length,
    },
    exact: rows(result.exact),
    confirmed: rows(result.confirmed || []),
    missing: result.missing || [],
    fuzzy: rows(result.fuzzy),
    ambiguous: rows(result.ambiguous),
    mixed: rows(result.mixed),
    unmatched: rows(result.unmatched),
  };
}

export async function scanDirectoryLinks({root, organizations, employees}) {
  const base = root || directoryRoot();
  if (!base) throw new Error('尚未設定 NAS_DIRECTORY_ROOT');
  const candidates = await collectCandidateFolders(base);
  const matched = matchCandidateFolders(candidates, {organizations, employees});
  return {...matched, root: base, filesAt: candidates.filesAt, summary: summarizeMatch(matched, {filesAt: candidates.filesAt})};
}

export async function applyExactDirectoryLinks({store, organizations, employees, root, links, missing}) {
  let reportMissing = missing || [];
  let computed = links;
  if (!computed) {
    const scanned = await scanDirectoryLinks({root, organizations, employees});
    computed = scanned.links;
    reportMissing = scanned.missing || [];
  }
  let added = 0, skipped = 0;
  for (const link of computed) {
    if (isProtectedEmployeePath(link.relativePath)) { skipped += 1; continue; }
    if (!safeJoinRoot(root || directoryRoot(), link.relativePath)) { skipped += 1; continue; }
    const before = await store.directoryFolders(link.kind, link.entityId);
    const existed = before.some((r) => r.relative_path === link.relativePath || r.relativePath === link.relativePath);
    await store.saveDirectoryFolder(link.kind, link.entityId, link.relativePath, {role: 'linked', source: link.confidence === 'confirmed' ? 'confirmed' : 'auto'});
    const after = await store.directoryFolders(link.kind, link.entityId);
    const now = after.some((r) => r.relative_path === link.relativePath || r.relativePath === link.relativePath);
    if (!existed && now) added += 1;
    else skipped += 1;
  }
  return {ok: true, added, skipped, total: computed.length, missing: reportMissing};
}
