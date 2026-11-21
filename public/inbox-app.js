/* 收件匣（分揀員）：什麼檔案都收 → 判斷要去哪 → 財務文件、名片有把握才自動歸檔；個人文件一律先問 */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const money = (v) => (v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString('zh-TW', {maximumFractionDigits: 2}));
  let ctx = {}, meta = null, pending = [], recent = [];
  const FIN_CSS = `
  .fin-tabs{display:flex;gap:8px;margin:4px 0 18px;flex-wrap:wrap}.fin-tabs button{border:1px solid var(--line);border-radius:999px;padding:7px 15px;background:#fff}
  .fin-tabs button.on{background:var(--green);color:#fff;border-color:var(--green)}.fin-badge{display:inline-block;min-width:20px;padding:0 6px;margin-left:6px;border-radius:10px;background:#c0392b;color:#fff;font-size:12px;text-align:center}
  .fin-drop{border:2px dashed #9fb3c0;border-radius:8px;padding:28px 16px;text-align:center;background:#fff;cursor:pointer}.fin-drop.over{background:var(--soft);border-color:var(--green)}
  .fin-drop b{display:block;font-size:18px;margin-bottom:4px}.fin-muted{color:var(--muted);font-size:13px}
  .fin-progress{margin:12px 0;display:grid;gap:6px}.fin-progress div{background:#fff;border:1px solid var(--line);border-radius:6px;padding:8px 12px;font-size:14px}
  .fin-card{background:#fff;border:1px solid var(--line);border-radius:6px;padding:12px 14px;margin:10px 0;display:flex;gap:12px;align-items:flex-start;justify-content:space-between}
  .fin-card h3{font-size:15px;margin-bottom:4px}.fin-q{background:#fff6e0;border-left:3px solid var(--ochre);padding:6px 10px;margin:4px 0;font-size:13px;border-radius:3px}
  .fin-btn{border:1px solid var(--line);border-radius:5px;padding:7px 12px;background:#fff;white-space:nowrap}.fin-btn.pri{background:var(--green);color:#fff;border-color:var(--green)}.fin-btn.warn{color:#a33}
  .fin-table{width:100%;border-collapse:collapse;background:#fff;font-size:13px}.fin-table th,.fin-table td{border:1px solid var(--line);padding:5px 7px;text-align:right;white-space:nowrap}
  .fin-table th:first-child,.fin-table td:first-child{text-align:left;position:sticky;left:0;background:#fff}.fin-table tr.sum td{font-weight:700;background:var(--soft)}.fin-table tr.profit td{font-weight:700}
  .fin-table td.neg{color:#b03030}.fin-scroll{overflow-x:auto;border-radius:6px}.fin-left td,.fin-left th{text-align:left}
  .fin-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0}.fin-row select,.fin-row input{border:1px solid var(--line);border-radius:4px;padding:7px;background:#fff;width:auto;margin-top:0}
  dialog.fin-dialog{width:min(980px,calc(100% - 20px))}.fin-review{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:18px}
  .fin-preview{border:1px solid var(--line);border-radius:6px;min-height:260px;max-height:70vh;overflow:auto;display:flex;align-items:center;justify-content:center;background:#f7f9fa}
  .fin-preview img{max-width:100%;display:block}.fin-form{display:grid;grid-template-columns:1fr 1fr;gap:10px}.fin-form label{font-size:12px;color:var(--muted)}
  .fin-form input,.fin-form select,.fin-form textarea{width:100%;border:1px solid var(--line);border-radius:4px;padding:7px;background:#fff;color:var(--ink);margin-top:3px}
  .fin-form .wide{grid-column:1/-1}@media(max-width:760px){.fin-review{grid-template-columns:1fr}.fin-form{grid-template-columns:1fr}}`;
  const CSS = `
  .ib-tag{display:inline-block;font-size:12px;border-radius:10px;padding:1px 8px;margin-right:6px;background:var(--soft);color:var(--ink)}.ib-tag.pii{background:#fde8e8;color:#a33}
  .ib-thumb{width:84px;height:64px;border-radius:5px;overflow:hidden;flex:none;background:#eef2f4;display:flex;align-items:center;justify-content:center;cursor:pointer;position:relative}
  .ib-thumb img{width:100%;height:100%;object-fit:cover}.ib-blur img{filter:blur(9px)}.ib-blur::after{content:'點一下顯示';position:absolute;font-size:11px;color:#fff;background:rgba(0,0,0,.45);padding:1px 5px;border-radius:3px}
  .fin-preview.ib-blur img{filter:blur(18px)}.fin-preview.ib-blur{cursor:pointer;position:relative}.fin-preview.ib-blur::after{content:'個資文件：點一下顯示';position:absolute;color:#fff;background:rgba(0,0,0,.5);padding:4px 10px;border-radius:4px}
  .ib-card-main{display:flex;gap:12px;align-items:flex-start;min-width:0}.ib-note{background:#eef6ff;border-left:3px solid #4a7fb5;padding:6px 10px;margin:4px 0;font-size:13px;border-radius:3px}
  .ib-recent td{font-size:13px}`;
  const ROUTE_LABEL = {finance: '財務', card: '名片', hr: '人資', resignation: '離職單', salary: '薪資', unknown: '未辨識'};
  const HR_TYPES = ['身分證', '居留證', '駕照', '存摺', '履歷'];
  const FIN_TYPES = () => meta?.docTypes || [];
  const routeOf = (t) => HR_TYPES.includes(t) ? 'hr' : t === '名片' ? 'card' : t === '離職單' ? 'resignation' : t === '薪資檔' ? 'salary' : 'finance';

  function ensureCss() {
    if (!$('#fin-style')) { const st = document.createElement('style'); st.id = 'fin-style'; st.textContent = FIN_CSS; document.head.appendChild(st); }
    if (!$('#ib-style')) { const st = document.createElement('style'); st.id = 'ib-style'; st.textContent = CSS; document.head.appendChild(st); }
  }
  const api = (p, m, b) => ctx.api(p, m, b);
  async function upload(file) {
    const fd = new FormData(); fd.append('file', file);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 180000);
    try {
      const r = await fetch('/api/inbox/upload', {method: 'POST', credentials: 'same-origin', headers: ctx.csrf ? {'X-CSRF-Token': ctx.csrf} : {}, body: fd, signal: controller.signal});
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || '上傳失敗');
      return data;
    } finally { clearTimeout(timer); }
  }
  const fileUrl = (d, thumb) => '/api/inbox/' + d.id + '/file' + (thumb ? '?thumb=1' : '');
  const isImage = (d) => /^image\//.test(d.mime) && !/heic/.test(d.mime);
  const opt = (v, label, sel) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(label)}</option>`;
  const orgOptions = (sel, empty = '（不在名錄／放財務收件匣）') => `<option value="">${esc(empty)}</option>` + [['clients', '客人'], ['vendors', '廠商']].map(([k, label]) =>
    `<optgroup label="${label}">${(meta?.organizations || []).filter((o) => o.folder === k).map((o) => opt(o.id, o.name + (o.kind ? `（${o.kind}）` : ''), sel)).join('')}</optgroup>`).join('');
  const empOptions = (sel) => '<option value="">（請選擇員工）</option>' + (meta?.employees || []).map((e) => opt(e.id, `${e.id} ${e.name}${e.left ? '（已離職）' : ''}`, sel)).join('');
  const catOptions = (sel) => '<option value="">（不計入／未選）</option>' + [...(meta?.expenseCategories || []), ...(meta?.incomeCategories || [])].map((c) => opt(c, c, sel)).join('');
  const companyOptions = (sel) => '<option value="">（未判斷）</option>' + (meta?.companies || []).map((c) => opt(c.name, c.name, sel)).join('');
  const typeOptions = (sel) => (meta?.types || []).map((t) => opt(t, t, sel)).join('');
  function summary(d) {
    const f = d.fields || {};
    if (d.route === 'card') return [f.counterpartyName, f.contact?.name, f.orgName ? '→ ' + f.orgName : ''].filter(Boolean).map(esc).join(' · ');
    if (d.pii) return [f.docType, f.employeeId ? '員工 ' + f.employeeId : '', f.departureDate ? '離職日 ' + f.departureDate : '', f.months?.length ? f.months.join('、') : ''].filter(Boolean).map(esc).join(' · ');
    return [f.company ? '【' + f.company + '】' : '', f.docType, f.orgName || f.counterpartyName, f.invoiceNumber, f.month, f.total !== null && f.total !== undefined ? money(f.total) + ' 元' : '', f.category].filter(Boolean).map(esc).join(' · ');
  }
  const tag = (d) => `<span class="ib-tag${d.pii ? ' pii' : ''}">${d.pii ? '🔒 ' : ''}${esc(d.fields?.docType || ROUTE_LABEL[d.route] || '未辨識')}</span>`;
  function outcome(d) {
    const t = d.target || {};
    if (d.status === 'purged') return '暫存已刪除（逾期未確認）';
    if (d.status === 'ignored') return '不處理';
    if (t.type === 'hr') return `已歸到 ${t.employeeId} ${t.employeeName || ''} 的${({identity: '身分證', bank: '存摺', license: '駕照', resume: '履歷'})[t.category] || ''}資料夾${t.ocrReviewId ? '（存摺／證件資料請到「員工」確認）' : ''}`;
    if (t.type === 'resignation') return `${t.employeeId} 離職日 ${t.departureDate}；試算表${t.sheet?.written ? '已寫入' : '未寫入（' + (t.sheet?.reason || '') + '）'}`;
    if (t.type === 'salary') return `${t.company} ${t.month}：寫入 ${t.saved} 筆${t.protected ? `，${t.protected} 筆已匯款未覆蓋` : ''} → ${t.storedPath}`;
    if (t.type === 'card') return `名片 → ${t.orgName}${t.contactAdded ? '（已加聯絡人）' : ''}`;
    return d.storedPath ? '→ ' + d.storedPath : '';
  }

  async function load() {
    const [m, p, r] = await Promise.all([api('/api/inbox/meta'), api('/api/inbox'), api('/api/inbox?status=recent')]);
    meta = m; pending = p.documents; recent = r.documents;
  }

  async function paint(root) {
    try { await load(); } catch (e) { root.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    draw(root);
    if (ctx.openId) { const id = ctx.openId; ctx.openId = null; openReview(root, id); }
  }

  function draw(root, keepProgress) {
    const prog = keepProgress ? ($('#fin-progress', root)?.innerHTML || '') : '';
    root.innerHTML = `<div class="fin-drop" id="fin-drop" tabindex="0" role="button"><b>把任何文件拖到這裡，或點一下選檔案（可一次選很多個）</b>
      <span class="fin-muted">發票、收據、對帳單、報價單、合約、名片、身分證、居留證、駕照、存摺、履歷、離職單、薪資檔都可以。照片、PDF、Excel、CSV，每個 20MB 內。<br>
      財務文件與名錄裡找得到的名片會自動歸檔；身分證、存摺、離職單、薪資檔等個人文件一律先加密暫存，等你確認後才歸檔（${esc(meta.purgeDays)} 天沒確認會自動刪除）。
      ${meta.aiReady ? '' : '<br><b style="color:#a33">尚未設定 Gemini，檔案會先收進待確認，請手動選種類。</b>'}${meta.piiKeyConfigured ? '' : '<br><b style="color:#a33">尚未設定 HR_PII_KEY：個人文件無法上傳。</b>'}</span>
      <input type="file" id="fin-file" multiple hidden accept="image/*,.pdf,.xlsx,.xlsm,.xls,.csv"></div>
      <div class="fin-progress" id="fin-progress">${prog}</div>
      <h2 style="font-size:17px;margin:18px 0 4px">待確認（${pending.length}）</h2>
      ${pending.length ? '' : '<p class="fin-muted">目前沒有需要確認的文件。</p>'}
      ${pending.map((d) => `<div class="fin-card"><div class="ib-card-main">${isImage(d) ? `<div class="ib-thumb${d.pii ? ' ib-blur' : ''}" data-thumb="${d.id}"><img loading="lazy" src="${fileUrl(d, true)}" alt=""></div>` : `<div class="ib-thumb">${esc((d.originalName.split('.').pop() || '').toUpperCase())}</div>`}
        <div><h3>${tag(d)}${esc(d.originalName)}</h3><div class="fin-muted">${summary(d) || (d.status === 'error' ? '辨識失敗' : '')}</div>
        ${(d.questions || []).map((q) => `<div class="fin-q">${esc(q)}</div>`).join('')}</div></div>
        <button class="fin-btn pri" data-review="${d.id}">確認</button></div>`).join('')}
      ${recent.length ? `<h2 style="font-size:17px;margin:22px 0 6px">最近處理</h2><div class="fin-scroll"><table class="fin-table fin-left ib-recent"><thead><tr><th>檔名</th><th>種類</th><th>結果</th></tr></thead><tbody>
        ${recent.slice(0, 25).map((d) => `<tr><td>${esc(d.originalName)}</td><td>${tag(d)}</td><td>${esc(outcome(d))}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <dialog class="fin-dialog" id="fin-dialog"></dialog>`;
    const drop = $('#fin-drop', root), input = $('#fin-file', root);
    drop.onclick = () => input.click();
    drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); handleFiles(root, Array.from(e.dataTransfer.files || [])); };
    input.onchange = () => handleFiles(root, Array.from(input.files || []));
    $$('[data-review]', root).forEach((b) => b.onclick = () => openReview(root, b.dataset.review));
    $$('[data-thumb]', root).forEach((t) => t.onclick = () => t.classList.toggle('ib-blur'));
  }

  async function handleFiles(root, files) {
    if (!files.length) return;
    const box = $('#fin-progress', root);
    const lines = files.map((f) => { const div = document.createElement('div'); div.textContent = `⏳ ${f.name}：等待上傳…`; box.appendChild(div); return div; });
    let auto = 0, ask = 0, dup = 0, fail = 0;
    for (let i = 0; i < files.length; i++) {
      lines[i].textContent = `⏳ ${files[i].name}：上傳與辨識中…（${i + 1}/${files.length}）`;
      try {
        const res = await upload(files[i]);
        const d = res.documents[0];
        if (d.status === 'rejected') throw new Error(d.error);
        const label = d.fields?.docType || ROUTE_LABEL[d.route] || '';
        if (d.duplicate) { dup++; lines[i].textContent = `↺ ${files[i].name}：之前上傳過（${d.status === 'filed' ? '已歸檔' : '待確認'}），不重複處理`; }
        else if (d.status === 'filed') { auto++; lines[i].textContent = `✓ ${files[i].name}：${label}，已自動歸檔 ${outcome(d)}`; }
        else { ask++; lines[i].textContent = `？ ${files[i].name}：${label ? label + '，' : ''}${d.pii ? '個人文件，已加密暫存，' : ''}需要你確認`; }
      } catch (e) { fail++; lines[i].textContent = `✗ ${files[i].name}：${e.message}`; }
    }
    ctx.notify?.(`完成：${auto} 份自動歸檔、${ask} 份待確認${dup ? `、${dup} 份重複` : ''}${fail ? `、${fail} 份失敗` : ''}`);
    await load(); draw(root, true);
    if (pending.length) openReview(root, pending[0].id);
  }

  function financeForm(f) {
    return `<label>屬於集團哪家公司<select name="company">${companyOptions(f.company)}</select></label>
      <label>對象（名錄）<select name="orgId">${orgOptions(f.orgId)}</select></label>
      <label>文件上的對方名稱<input name="counterpartyName" value="${esc(f.counterpartyName || '')}"></label>
      <label>發票號碼<input name="invoiceNumber" value="${esc(f.invoiceNumber || '')}" placeholder="AB12345678"></label>
      <label>文件日期<input type="date" name="date" value="${esc(f.date || '')}"></label>
      <label>算在哪個月份<input type="month" name="month" value="${esc(f.month || '')}"></label>
      <label>未稅金額<input type="number" step="0.01" name="net" value="${esc(f.net ?? '')}"></label>
      <label>稅額<input type="number" step="0.01" name="tax" value="${esc(f.tax ?? '')}"></label>
      <label>含稅總額<input type="number" step="0.01" name="total" value="${esc(f.total ?? '')}"></label>
      <label>損益表科目<select name="category">${catOptions(f.category)}</select></label>
      <label class="wide">摘要<input name="description" value="${esc(f.description || '')}"></label>
      <label class="wide" style="display:flex;gap:8px;align-items:center;color:var(--ink)"><input type="checkbox" name="countInPnl" style="width:auto;margin:0"${f.countInPnl ? ' checked' : ''}> 計入損益表</label>`;
  }
  function cardForm(f) {
    const c = f.contact || {};
    return `<label>歸到名錄的對象<select name="orgId">${orgOptions(f.orgId, '（新增對象）')}</select></label>
      <label>名片上的公司<input name="counterpartyName" value="${esc(f.counterpartyName || '')}"></label>
      <div class="wide ib-new" style="display:${f.orgId ? 'none' : 'grid'};grid-template-columns:1fr 1fr;gap:10px">
        <label>新對象名稱<input name="newName" value="${esc(f.counterpartyName || '')}"></label>
        <label>新對象種類<select name="newKind">${(meta.kinds || []).map((k) => opt(k, k, '')).join('')}</select></label></div>
      <label>姓名<input name="cName" value="${esc(c.name || '')}"></label>
      <label>職稱<input name="cTitle" value="${esc(c.title || '')}"></label>
      <label>電話（多支用、分隔）<input name="cPhones" value="${esc((c.phones || []).join('、'))}"></label>
      <label>Email<input name="cEmail" value="${esc(c.email || '')}"></label>
      <label class="wide">地址<input name="cAddress" value="${esc(c.address || '')}"></label>
      <div class="wide ib-note">圖片會放到該對象資料夾的「名片」，聯絡人加到名錄的「聯絡人」（同電話／Email 不重複加）。</div>`;
  }
  function hrForm(f, t) {
    return `<label>是哪位員工的文件<select name="employeeId">${empOptions(f.employeeId)}</select></label>
      ${t === '居留證' || t === '駕照' ? `<label>到期日（選填）<input type="date" name="expiresOn" value=""></label>` : '<span></span>'}
      <div class="wide ib-note">會放到原本的員工${esc({身分證: '身分證', 居留證: '身分證', 駕照: '駕照', 存摺: '存簿匯款', 履歷: '履歷表'}[t] || '')}資料夾。${t === '存摺' ? '帳號會由 AI 讀出後，到「員工」頁確認（加密保存，匯款類型自動改成匯款）。' : ''}${t === '身分證' || t === '居留證' ? '證號會由 AI 讀出後，到「員工」頁確認。' : ''}</div>`;
  }
  function resignForm(f) {
    return `<label>離職員工<select name="employeeId">${empOptions(f.employeeId)}</select></label>
      <label>離職日（實際最後在職日）<input type="date" name="departureDate" value="${esc(f.departureDate || '')}"></label>
      <div class="wide" id="ib-sheet"><div class="fin-muted">選好員工後會顯示試算表目前的值。</div></div>`;
  }
  function salaryForm(f) {
    return `<label>薪資月份<input type="month" name="month" value="${esc(f.month || '')}"></label>
      <label>公司（原檔放到 薪資表/公司）<select name="company">${(meta.salaryCompanies || []).map((c) => opt(c, c, f.company || meta.defaultSalaryCompany)).join('')}</select></label>
      <label class="wide" style="display:flex;gap:8px;align-items:center;color:var(--ink)"><input type="checkbox" name="importRows" style="width:auto;margin:0" checked> 把實領薪資寫進人資（已匯款的不覆蓋）</label>
      <div class="wide" id="ib-salary"><div class="fin-muted">讀取中…</div></div>`;
  }

  async function openReview(root, id) {
    const dlg = $('#fin-dialog', root);
    let d = pending.find((x) => x.id === id);
    if (!d) { try { d = await api('/api/inbox/' + id); } catch (e) { ctx.notify?.(e.message); return; } }
    const f = d.fields || {};
    let type = f.docType && (meta.types || []).includes(f.docType) ? f.docType : (d.route === 'finance' ? '其他' : '');
    const left = pending.filter((x) => x.id !== id).length;
    const preview = isImage(d) ? `<div class="fin-preview${d.pii ? ' ib-blur' : ''}" id="ib-prev"><img src="${fileUrl(d)}" alt=""></div>` : `<div class="fin-preview"><p class="fin-muted" style="padding:20px;text-align:center">${esc(d.originalName)}<br><br><a class="fin-btn" href="${fileUrl(d)}" target="_blank" rel="noopener">開啟原檔</a></p></div>`;
    const body = () => {
      const r = routeOf(type);
      if (!type) return '<div class="wide fin-muted">請先選文件種類。</div>';
      if (r === 'finance') return financeForm(FIN_TYPES().includes(f.docType) ? f : {...f, docType: type});
      if (r === 'card') return cardForm(f);
      if (r === 'hr') return hrForm(f, type);
      if (r === 'resignation') return resignForm(f);
      return salaryForm(f);
    };
    dlg.innerHTML = `<div class="dialog-head"><h2 style="font-size:18px">請確認這份文件</h2><button type="button" data-x aria-label="關閉">×</button></div>
      <div class="fin-review"><div>${preview}
        <p class="fin-muted" style="margin-top:6px">${d.pii ? '🔒 個資文件（加密暫存）　' : ''}AI 把握度：${d.confidence === null ? '—' : Math.round(d.confidence * 100) + '%'}　<a href="${fileUrl(d)}" target="_blank" rel="noopener">開新視窗看原檔</a></p></div>
      <form class="fin-form" id="fin-form">
        <div class="wide">${(d.questions || []).map((q) => `<div class="fin-q">${esc(q)}</div>`).join('') || '<div class="fin-muted">沒有疑問，確認後就會歸檔。</div>'}</div>
        <label class="wide">文件種類<select name="docType"><option value="">（請選擇）</option>${typeOptions(type)}</select></label>
        <div class="wide" id="ib-fields" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">${body()}</div>
        <div class="wide" style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
          <button type="button" class="fin-btn" data-retry>重新辨識</button>
          <button type="button" class="fin-btn warn" data-ignore>不處理</button>
          <button type="submit" class="fin-btn pri">確認並歸檔${left ? `（還有 ${left} 份）` : ''}</button></div>
      </form></div>`;
    if (!dlg.open) dlg.showModal();
    $('[data-x]', dlg).onclick = () => dlg.close();
    const prev = $('#ib-prev', dlg); if (prev) prev.onclick = () => prev.classList.remove('ib-blur');
    const form = $('#fin-form', dlg);
    let sheetState = null;
    const wire = () => {
      const el = form.elements, r = routeOf(type);
      if (r === 'card') el.orgId.onchange = () => { $('.ib-new', dlg).style.display = el.orgId.value ? 'none' : 'grid'; };
      if (r === 'resignation') {
        const refresh = async () => {
          const box = $('#ib-sheet', dlg); sheetState = null;
          if (!el.employeeId.value) { box.innerHTML = '<div class="fin-muted">選好員工後會顯示試算表目前的值。</div>'; return; }
          box.innerHTML = '<div class="fin-muted">讀取試算表中…</div>';
          try {
            const p = await api(`/api/inbox/${id}/resignation-preview?employeeId=${encodeURIComponent(el.employeeId.value)}`);
            sheetState = p.sheet;
            const s = p.sheet;
            const cur = s.current || s.raw;
            box.innerHTML = `<div class="ib-note">系統目前的離職日：${esc(p.employee.departureDate || '（空白）')}<br>
              ${s.ok ? `試算表「員工資料」${esc(s.cell)}（${esc(s.header)}）目前：<b>${esc(cur || '（空白）')}</b>` : `試算表：<b>無法寫入</b>（${esc(s.error)}）— 文件會照樣歸檔，離職日只寫進系統，請手動補到試算表。`}</div>
              <label id="ib-ow" style="display:none;gap:8px;align-items:center;color:#a33;margin-top:6px"><input type="checkbox" name="overwriteSheet" style="width:auto;margin:0"> 試算表已有不同的日期，確定要覆蓋</label>`;
            const toggle = () => { const ow = $('#ib-ow', dlg); const differ = s.ok && cur && cur !== el.departureDate.value; ow.style.display = differ ? 'flex' : 'none'; if (!differ && form.elements.overwriteSheet) form.elements.overwriteSheet.checked = false; };
            el.departureDate.oninput = toggle; toggle();
          } catch (e) { box.innerHTML = `<div class="fin-q">${esc(e.message)}</div>`; }
        };
        el.employeeId.onchange = refresh; refresh();
      }
      if (r === 'salary') {
        const refresh = async () => {
          const box = $('#ib-salary', dlg);
          try {
            const p = await api(`/api/inbox/${id}/salary-preview?month=${encodeURIComponent(el.month.value || '')}`);
            if (!el.month.value && p.month) el.month.value = p.month;
            box.innerHTML = p.importable ? `<div class="ib-note">檔案裡的月份：${esc(p.months.join('、') || '—')}。${esc(p.month)}：新增 ${p.summary.new}、更新 ${p.summary.changed}、相同 ${p.summary.same}、對不到員工 ${p.summary.unmatched + p.summary.ambiguous}${p.unmatched.length ? `（${esc(p.unmatched.join('、'))}）` : ''}</div>`
              : `<div class="fin-q">${esc((p.warnings || [])[0] || '讀不到可匯入的薪資欄位，只會歸檔原檔')}</div>`;
            if (!p.importable) { el.importRows.checked = false; el.importRows.disabled = true; }
          } catch (e) { box.innerHTML = `<div class="fin-q">${esc(e.message)}</div>`; }
        };
        el.month.onchange = refresh; refresh();
      }
    };
    form.elements.docType.onchange = () => {
      type = form.elements.docType.value;
      $('#ib-fields', dlg).innerHTML = (() => { const r = routeOf(type); if (!type) return '<div class="wide fin-muted">請先選文件種類。</div>'; if (r === 'finance') return financeForm({...f, docType: type}); if (r === 'card') return cardForm(f); if (r === 'hr') return hrForm(f, type); if (r === 'resignation') return resignForm(f); return salaryForm(f); })();
      if (['報價單', '合約', '其他', '銷項發票'].includes(type) && form.elements.countInPnl) { form.elements.countInPnl.checked = false; form.elements.category.value = ''; }
      wire();
    };
    wire();
    const next = async () => { await load(); draw(root, true); if (pending.length) openReview(root, pending[0].id); else ctx.notify?.('全部確認完了'); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!type) { ctx.notify?.('請選文件種類'); return; }
      const el = form.elements, num = (v) => (v === '' ? null : Number(v)), r = routeOf(type);
      let payload = {docType: type};
      if (r === 'finance') payload = {...payload, company: el.company.value || null, orgId: el.orgId.value || null, counterpartyName: el.counterpartyName.value, invoiceNumber: el.invoiceNumber.value, date: el.date.value || null, month: el.month.value || null, net: num(el.net.value), tax: num(el.tax.value), total: num(el.total.value), category: el.category.value || null, description: el.description.value, countInPnl: el.countInPnl.checked};
      else if (r === 'card') payload = {...payload, orgId: el.orgId.value || null, newOrg: el.orgId.value ? null : {name: el.newName.value, kind: el.newKind.value}, contact: {name: el.cName.value, title: el.cTitle.value, phones: el.cPhones.value.split(/[、,，]/), email: el.cEmail.value, address: el.cAddress.value}};
      else if (r === 'hr') { if (!el.employeeId.value) { ctx.notify?.('請選擇員工'); return; } payload = {...payload, employeeId: el.employeeId.value, expiresOn: el.expiresOn?.value || null}; }
      else if (r === 'resignation') {
        if (!el.employeeId.value || !el.departureDate.value) { ctx.notify?.('請選擇員工並填離職日'); return; }
        payload = {...payload, employeeId: el.employeeId.value, departureDate: el.departureDate.value, overwriteSheet: Boolean(el.overwriteSheet?.checked)};
      } else payload = {...payload, month: el.month.value || null, company: el.company.value, importRows: el.importRows.checked};
      try {
        const res = await api('/api/inbox/' + id + '/confirm', 'POST', payload);
        ctx.notify?.('已處理：' + (outcome(res.document) || res.document.storedPath || '完成'));
        await next();
      } catch (err) { ctx.notify?.(err.message); }
    };
    $('[data-ignore]', dlg).onclick = async () => {
      if (!confirm(d.pii ? '這份個人文件不處理？加密暫存檔會直接刪除。' : '這份文件不歸檔、也不計入損益？（檔案會留在 財務收件匣/待確認）')) return;
      try { await api('/api/inbox/' + id + '/ignore', 'POST', {}); await next(); } catch (err) { ctx.notify?.(err.message); }
    };
    $('[data-retry]', dlg).onclick = async (ev) => {
      ev.target.disabled = true; ev.target.textContent = '辨識中…';
      try { const r = await api('/api/inbox/' + id + '/retry', 'POST', {}); pending = pending.map((x) => x.id === id ? r.document : x); openReview(root, id); }
      catch (err) { ctx.notify?.(err.message); ev.target.disabled = false; ev.target.textContent = '重新辨識'; }
    };
  }

  window.CompanyInbox = {
    render(root, options) {
      ctx = options || {}; ensureCss();
      if (!root) return;
      if (!ctx.nasMode) { root.innerHTML = '<div class="empty">收件匣需要連上 NAS 並登入後才能使用。</div>'; return; }
      paint(root);
    },
  };
})();
