const STOP = new Set(['請問','請','幫','幫我','我','查詢','查','查看','資料','紀錄','記錄','有','沒有','有沒有','什麼','甚麼','怎麼','為什麼','時候','什麼時候','何時','幾','幾號','幾點','哪天','日期','時間','去','的','了','呢','那','他','她','嗎','是','在','回來','回國','最近','近期','最新','是誰','誰','哪家','哪個','哪間']);
const WEAK = new Set(['廠商','客人','客戶','對象','公司','飯店','酒店','旅館','發票','維修','保養','價格','單價','合約','待辦','事項','內容','附件','聯絡人','備註','一般','紀錄','記錄','客訴','投訴']);

export function normalizeSearch(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s·・．.（）()／/—–-]+/g, '');
}

export function isWeakSearchTerm(term) {
  const n = normalizeSearch(term);
  return !n || n.length < 2 || STOP.has(term) || STOP.has(n) || WEAK.has(term) || WEAK.has(n);
}

function segmentTerms(text) {
  const value = String(text || '');
  const terms = [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    for (const part of new Intl.Segmenter('zh-Hant', {granularity: 'word'}).segment(value)) {
      const word = part.segment.trim();
      if (part.isWordLike && word.length >= 2) terms.push(word);
    }
  } else {
    for (const word of value.split(/[\s,，、。！？!?;；:：]+/)) {
      if (word.length >= 2) terms.push(word);
    }
  }
  return terms;
}

/** Needles for a query. The raw string is always used when it is a short/deliberate search. Extra specific terms are extracted from longer questions. */
function leftoverPhrases(text) {
  const list = [...STOP, ...WEAK].sort((a, b) => b.length - a.length);
  let s = String(text || '');
  for (const w of list) s = s.split(w).join(' ');
  return s.split(/[\s,，、。！？!?;；:：]+/).map((x) => x.trim()).filter((x) => normalizeSearch(x).length >= 2);
}

/** CJK 2–3 character grams, used because Chinese has no spaces and the word segmenter often splits 天車 into 天 + 車. */
export function cjkNgrams(text, min = 2, max = 3) {
  const grams = [];
  let run = '';
  const flush = () => {
    if (run.length >= min) {
      for (let n = min; n <= Math.min(max, run.length); n++) {
        for (let i = 0; i <= run.length - n; i++) grams.push(run.slice(i, i + n));
      }
    }
    run = '';
  };
  for (const ch of String(text || '')) {
    if (/[\u3400-\u9FFF]/.test(ch)) run += ch;
    else flush();
  }
  flush();
  return grams;
}

export function queryNeedles(raw, {fromQuestion = false} = {}) {
  const q = String(raw || '').trim();
  const out = [];
  const compact = normalizeSearch(q);
  if (compact.length >= 1 && (!fromQuestion || compact.length <= 12)) out.push(q);
  if (fromQuestion || compact.length > 4) {
    for (const part of leftoverPhrases(q)) if (!isWeakSearchTerm(part)) out.push(part);
    for (const part of segmentTerms(q)) if (!isWeakSearchTerm(part)) out.push(part);
    if (fromQuestion) {
      for (const part of leftoverPhrases(q).flatMap((phrase) => cjkNgrams(phrase, 2, 2))) {
        if (!isWeakSearchTerm(part)) out.push(part);
      }
    }
  }
  const seen = new Set();
  return out.filter((term) => {
    const key = normalizeSearch(term);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function attachmentText(row) {
  return (row.attachments || []).map((a) => [a?.name, a?.mime].filter(Boolean).join(' ')).join(' ');
}

function orgProfileFields(o) {
  return [
    ['名稱', o.name],
    ...((o.aliases || []).map((a) => ['別名', a])),
    ...((o.keywords || []).map((a) => ['關鍵字', a])),
    ['聯絡人', o.contact],
    ['職務', o.role],
    ['負責人', o.manager],
    ['備註', o.memo],
    ['合約', o.contract],
    ['分類', o.kind],
    ['價格', o.priceNotes],
    ['價格', Array.isArray(o.prices) ? o.prices.map((p) => Array.isArray(p) ? p.join(' ') : p).join(' ') : ''],
    ['價格', (o.prices && o.prices.length) || o.priceNotes ? '價格 單價' : ''],
  ];
}

function recordFields(r) {
  return [
    ['事項', r.title],
    ['內容', r.note],
    ['類型', r.type],
    ['原文', r.sourceText],
    ...((r.attachments || []).map((a) => ['附件', a?.name])),
  ];
}

function taskFields(t) {
  return [
    ['待辦', t.title],
    ['內容', t.note],
    ...((t.attachments || []).map((a) => ['附件', a?.name])),
  ];
}

function fieldHits(fields, needles) {
  const hits = [];
  for (const [field, value] of fields) {
    const text = String(value || '');
    if (!text) continue;
    const hay = normalizeSearch(text);
    for (const term of needles) {
      const needle = normalizeSearch(term);
      if (needle && hay.includes(needle)) {
        hits.push({field, text, term});
        break;
      }
    }
  }
  return hits;
}

export function findSnippet(text, term, radius = 16) {
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  const nTerm = String(term || '').normalize('NFKC');
  if (!src) return {snippet: '', start: -1, length: 0, term: nTerm};
  const lower = src.normalize('NFKC');
  let idx = lower.toLowerCase().indexOf(nTerm.toLowerCase());
  let matchLen = nTerm.length;
  if (idx < 0) {
    const map = [];
    let compact = '';
    for (let i = 0; i < lower.length; i++) {
      if (/\s/.test(lower[i])) continue;
      compact += lower[i];
      map.push(i);
    }
    const cNeedle = normalizeSearch(nTerm);
    const cIdx = compact.toLowerCase().indexOf(cNeedle);
    if (cIdx >= 0) {
      idx = map[cIdx];
      const last = map[cIdx + cNeedle.length - 1] ?? idx;
      matchLen = last - idx + 1;
    }
  }
  if (idx < 0) return {snippet: src.slice(0, radius * 2), start: -1, length: 0, term: nTerm};
  const from = Math.max(0, idx - radius);
  const to = Math.min(src.length, idx + matchLen + radius);
  const prefix = from > 0 ? '…' : '';
  const suffix = to < src.length ? '…' : '';
  const snippet = prefix + src.slice(from, to).trim() + suffix;
  const start = idx - from + prefix.length;
  return {snippet, start, length: matchLen, term: nTerm};
}

export function markPlain(snippet, start, length) {
  if (start < 0 || length <= 0) return snippet;
  return snippet.slice(0, start) + '「' + snippet.slice(start, start + length) + '」' + snippet.slice(start + length);
}

export function markHtml(snippet, start, length, escapeFn) {
  const esc = escapeFn || ((x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])));
  if (start < 0 || length <= 0) return esc(snippet);
  return esc(snippet.slice(0, start)) + '<mark>' + esc(snippet.slice(start, start + length)) + '</mark>' + esc(snippet.slice(start + length));
}

export function formatMatchHint(hit) {
  if (!hit) return '';
  const marked = markPlain(hit.snippet, hit.start, hit.length);
  const when = hit.date ? hit.date + ' ' : '';
  if (hit.kind === 'record') return when + '紀錄：' + marked;
  if (hit.kind === 'task') return when + '待辦：' + marked;
  if (hit.field) return hit.field + '：' + marked;
  return marked;
}

function nameList(o) {
  return [o.name, ...(o.aliases || []), ...(o.keywords || [])].filter(Boolean);
}

export function searchOrganizations(state, rawQuery, opts = {}) {
  const organizations = state.organizations || [];
  const records = state.records || [];
  const tasks = state.tasks || [];
  const kinds = opts.kinds || null;
  const explicit = Boolean(opts.needles && opts.needles.length);
  const needles = (explicit ? opts.needles : queryNeedles(rawQuery, {fromQuestion: opts.fromQuestion})).filter((t) => {
    const key = normalizeSearch(t);
    return key.length >= 2 || (key.length === 1 && (explicit || normalizeSearch(rawQuery).length === 1));
  });
  if (!needles.length) {
    return organizations
      .filter((o) => !kinds || kinds.includes(o.kind || '其他'))
      .map((o) => ({org: o, score: 0, matchType: '', hitCount: 0, latest: '', hits: []}));
  }

  const results = [];
  for (const o of organizations) {
    if (kinds && !kinds.includes(o.kind || '其他')) continue;
    let matchType = '';
    let score = 0;
    const hits = [];
    const names = nameList(o);
    const nName = normalizeSearch(o.name);

    for (const term of needles) {
      const needle = normalizeSearch(term);
      if (!needle) continue;
      if (nName === needle) {
        matchType = 'name';
        score = Math.max(score, 10000);
        const sn = findSnippet(o.name, term);
        hits.push({kind: 'profile', field: '名稱', date: '', ...sn});
      } else if ((o.aliases || []).some((a) => normalizeSearch(a) === needle)) {
        if (score < 8000) { matchType = 'alias'; score = 8000; }
        const alias = (o.aliases || []).find((a) => normalizeSearch(a) === needle);
        hits.push({kind: 'profile', field: '別名', date: '', ...findSnippet(alias, term)});
      } else if ((o.keywords || []).some((a) => normalizeSearch(a) === needle)) {
        if (score < 8000) { matchType = 'keyword'; score = 8000; }
        const kw = (o.keywords || []).find((a) => normalizeSearch(a) === needle);
        hits.push({kind: 'profile', field: '關鍵字', date: '', ...findSnippet(kw, term)});
      } else if (nName.includes(needle) || names.some((n) => normalizeSearch(n).includes(needle))) {
        if (score < 5000) { matchType = 'name'; score = 5000; }
        const src = names.find((n) => normalizeSearch(n).includes(needle)) || o.name;
        hits.push({kind: 'profile', field: nName.includes(needle) ? '名稱' : '別名', date: '', ...findSnippet(src, term)});
      }
    }

    const profileHits = fieldHits(orgProfileFields(o).filter(([field]) => !['名稱', '別名', '關鍵字'].includes(field)), needles);
    if (profileHits.length) {
      if (score < 2000) { matchType = 'profile'; score = 2000; }
      for (const h of profileHits.slice(0, 2)) hits.push({kind: 'profile', field: h.field, date: '', ...findSnippet(h.text, h.term)});
    }

    let contentCount = 0;
    let latest = '';
    for (const r of records) {
      if (r.org !== o.id && r.relatedOrg !== o.id) continue;
      const found = fieldHits(recordFields(r), needles);
      if (!found.length) continue;
      contentCount += 1;
      const date = r.date || '';
      if (date > latest) latest = date;
      const h = found[0];
      hits.push({kind: 'record', id: r.id, date, field: h.field, ...findSnippet(h.text, h.term)});
    }
    for (const t of tasks) {
      if (t.org !== o.id) continue;
      const found = fieldHits(taskFields(t), needles);
      if (!found.length) continue;
      contentCount += 1;
      const date = t.dueDate || '';
      if (date > latest) latest = date;
      const h = found[0];
      hits.push({kind: 'task', id: t.id, date, field: h.field, ...findSnippet(h.text, h.term)});
    }
    if (contentCount) {
      const recency = latest ? Number(String(latest).replace(/-/g, '').slice(0, 8)) || 0 : 0;
      const contentScore = 100 * contentCount + Math.min(99, recency % 100000000 / 1000000);
      if (score < 1000) { matchType = 'content'; score = contentScore; }
      else score += contentScore;
    }

    if (!matchType && !hits.length) continue;
    hits.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    results.push({org: o, score, matchType, hitCount: contentCount, latest, hits: hits.slice(0, 4)});
  }

  results.sort((a, b) => b.score - a.score || String(b.latest || '').localeCompare(String(a.latest || '')) || (b.hitCount || 0) - (a.hitCount || 0) || String(a.org.name || '').localeCompare(String(b.org.name || ''), 'zh-TW'));
  return results;
}

export function suggestKeywords(org, records = [], tasks = [], limit = 8) {
  const existing = new Set(nameList(org).map(normalizeSearch));
  const counts = new Map();
  const docs = [
    ...(records || []).filter((r) => r.org === org.id || r.relatedOrg === org.id),
    ...(tasks || []).filter((t) => t.org === org.id),
  ];
  const prefixes = (text) => {
    const terms = [];
    let run = '';
    const flush = () => { if (run.length >= 2) terms.push(run.slice(0, 2)); run = ''; };
    for (const ch of String(text || '')) {
      if (/[\u3400-\u9FFF]/.test(ch)) run += ch;
      else flush();
    }
    flush();
    return terms;
  };
  for (const row of docs) {
    const text = [row.title, row.note, ...(row.attachments || []).map((a) => String(a?.name || '').replace(/\.[a-z0-9]+$/i, ''))].filter(Boolean).join(' ');
    const seen = new Set();
    for (const part of prefixes(text)) {
      const n = normalizeSearch(part);
      if (n.length < 2 || isWeakSearchTerm(part) || existing.has(n) || seen.has(n)) continue;
      seen.add(n);
      const prev = counts.get(n);
      const inTitle = normalizeSearch(row.title || '').includes(n);
      counts.set(n, {term: part, count: (prev?.count || 0) + 1, inTitle: Boolean(prev?.inTitle || inTitle)});
    }
  }
  return [...counts.values()].filter((x) => x.count >= 2 || x.inTitle).sort((a, b) => b.count - a.count || a.term.localeCompare(b.term, 'zh-TW')).slice(0, limit);
}

export function recordSearchHay(r, orgName, relatedName) {
  return [r.title, r.note, r.type, r.sourceText, orgName, relatedName, attachmentText(r), r.createdByName].filter(Boolean).join(' ');
}

export function taskSearchHay(t, orgName) {
  return [t.title, t.note, orgName, attachmentText(t)].filter(Boolean).join(' ');
}
