/* 財務收件匣：上傳 → AI 分類歸檔 → 不確定就跳出詢問 → 月損益表 */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const money = (v) => (v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString('zh-TW', {maximumFractionDigits: 2}));
  const thisYear = () => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Taipei', year: 'numeric'}).format(new Date());
  const thisMonth = () => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit'}).format(new Date());
  let ctx = {}, meta = null, tab = 'inbox', year = thisYear(), basis = 'total', filedMonth = '', entryMonth = thisMonth();
  let pending = [], filed = [];

  const CSS = `
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

  function ensureCss() {
    if ($('#fin-style')) return;
    const st = document.createElement('style'); st.id = 'fin-style'; st.textContent = CSS; document.head.appendChild(st);
  }
  const api = (p, m, b) => ctx.api(p, m, b);
  async function upload(file) {
    const fd = new FormData(); fd.append('file', file);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 180000);
    try {
      const r = await fetch('/api/finance/inbox', {method: 'POST', credentials: 'same-origin', headers: ctx.csrf ? {'X-CSRF-Token': ctx.csrf} : {}, body: fd, signal: controller.signal});
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || '上傳失敗');
      return data;
    } finally { clearTimeout(timer); }
  }
  const orgOptions = (sel) => {
    const groups = {clients: '客人', vendors: '廠商'};
    return '<option value="">（不在名錄／放財務收件匣）</option>' + Object.entries(groups).map(([k, label]) =>
      `<optgroup label="${label}">${(meta?.organizations || []).filter((o) => o.folder === k).map((o) => `<option value="${esc(o.id)}"${o.id === sel ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}</optgroup>`).join('');
  };
  const catOptions = (sel) => '<option value="">（不計入／未選）</option>' + [...(meta?.expenseCategories || []), ...(meta?.incomeCategories || [])].map((c) => `<option${c === sel ? ' selected' : ''}>${esc(c)}</option>`).join('');
  const companyOptions = (sel) => '<option value="">（未判斷）</option>' + (meta?.companies || []).map((c) => `<option${c.name === sel ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  const typeOptions = (sel) => (meta?.docTypes || []).map((t) => `<option${t === sel ? ' selected' : ''}>${esc(t)}</option>`).join('');
  const isImage = (d) => /^image\//.test(d.mime) && !/heic/.test(d.mime);
  const fileUrl = (d) => '/api/finance/documents/' + d.id + '/file';
  const summary = (f) => [f.company ? '【' + f.company + '】' : '', f.docType, f.orgName || f.counterpartyName, f.invoiceNumber, f.month, f.total !== null && f.total !== undefined ? money(f.total) + ' 元' : '', f.category].filter(Boolean).map(esc).join(' · ');

  async function loadMeta() { meta = await api('/api/finance/meta'); }
  async function loadPending() {
    const [a, b] = await Promise.all([api('/api/finance/documents?status=needs_review'), api('/api/finance/documents?status=error')]);
    pending = [...a.documents, ...b.documents]; meta.counts = b.counts;
  }

  function shell(root) {
    const n = (meta?.counts?.needs_review || 0) + (meta?.counts?.error || 0);
    root.innerHTML = `<div class="fin-tabs">
      <button data-tab="inbox" class="${tab === 'inbox' ? 'on' : ''}">上傳／待確認${n ? `<span class="fin-badge">${n}</span>` : ''}</button>
      <button data-tab="filed" class="${tab === 'filed' ? 'on' : ''}">已歸檔</button>
      <button data-tab="pnl" class="${tab === 'pnl' ? 'on' : ''}">損益表</button>
      <button data-tab="settings" class="${tab === 'settings' ? 'on' : ''}">設定</button></div><div id="fin-body"></div>
      <dialog class="fin-dialog" id="fin-dialog"></dialog>`;
    $$('[data-tab]', root).forEach((b) => b.onclick = () => { tab = b.dataset.tab; paint(root); });
  }

  async function paint(root) {
    try {
      if (!meta) await loadMeta();
      if (tab === 'inbox') await loadPending();
      shell(root);
      const body = $('#fin-body', root);
      if (tab === 'inbox') paintInbox(root, body);
      else if (tab === 'filed') await paintFiled(root, body);
      else if (tab === 'settings') await paintSettings(root, body);
      else await paintPnl(root, body);
    } catch (e) { root.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  function paintInbox(root, body) {
    body.innerHTML = `<div class="fin-drop" id="fin-drop" tabindex="0" role="button"><b>把發票照片、貨款明細、報價單拖到這裡，或點一下選檔案</b>
      <span class="fin-muted">支援照片、PDF、Excel（xlsx/xls）、CSV，每個 20MB 內。系統會自動辨識、分類、歸到對象資料夾；不確定的會跳出來問你。${meta.aiReady ? '' : '<br><b style="color:#a33">尚未設定 Gemini，檔案會先收進待確認，請手動填寫。</b>'}</span>
      <input type="file" id="fin-file" multiple hidden accept="image/*,.pdf,.xlsx,.xlsm,.xls,.csv"></div>
      <div class="fin-progress" id="fin-progress"></div>
      <h2 style="font-size:17px;margin:18px 0 4px">待確認（${pending.length}）</h2>
      ${pending.length ? '' : '<p class="fin-muted">目前沒有需要確認的文件。</p>'}
      ${pending.map((d) => `<div class="fin-card"><div><h3>${esc(d.originalName)}</h3><div class="fin-muted">${summary(d.fields) || (d.status === 'error' ? '辨識失敗' : '')}</div>
        ${(d.questions || []).map((q) => `<div class="fin-q">${esc(q)}</div>`).join('')}</div>
        <button class="fin-btn pri" data-review="${d.id}">確認</button></div>`).join('')}`;
    const drop = $('#fin-drop', body), input = $('#fin-file', body);
    drop.onclick = () => input.click();
    drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); handleFiles(root, Array.from(e.dataTransfer.files || [])); };
    input.onchange = () => handleFiles(root, Array.from(input.files || []));
    $$('[data-review]', body).forEach((b) => b.onclick = () => openReview(root, b.dataset.review));
  }

  async function handleFiles(root, files) {
    if (!files.length) return;
    const box = $('#fin-progress', root);
    const lines = files.map((f) => { const div = document.createElement('div'); div.textContent = `⏳ ${f.name}：上傳與辨識中…`; box.appendChild(div); return div; });
    let auto = 0, ask = 0, dup = 0, fail = 0;
    for (let i = 0; i < files.length; i++) {
      try {
        const res = await upload(files[i]);
        const d = res.documents[0];
        if (d.duplicate) { dup++; lines[i].textContent = `↺ ${files[i].name}：這個檔案之前上傳過（${d.status === 'filed' ? '已歸檔' : '待確認'}），不重複處理`; }
        else if (d.status === 'filed') { auto++; lines[i].textContent = `✓ ${files[i].name}：已自動歸檔 — ${d.fields.docType}・${d.fields.orgName || d.fields.counterpartyName || ''}・${money(d.fields.total)} 元 → ${d.storedPath}`; }
        else { ask++; lines[i].textContent = `？ ${files[i].name}：需要你確認`; }
      } catch (e) { fail++; lines[i].textContent = `✗ ${files[i].name}：${e.message}`; }
    }
    ctx.notify?.(`完成：${auto} 份自動歸檔、${ask} 份待確認${dup ? `、${dup} 份重複` : ''}${fail ? `、${fail} 份失敗` : ''}`);
    const keep = box.innerHTML;
    await loadPending(); meta.counts = (await api('/api/finance/documents?status=needs_review&limit=1')).counts;
    shell(root); paintInbox(root, $('#fin-body', root)); $('#fin-progress', root).innerHTML = keep;
    if (pending.length) openReview(root, pending[0].id); // 不確定的直接跳出來問
  }

  async function openReview(root, id) {
    const dlg = $('#fin-dialog', root);
    const d = pending.find((x) => x.id === id) || await api('/api/finance/documents/' + id);
    const f = d.fields || {};
    const left = pending.filter((x) => x.id !== id).length;
    dlg.innerHTML = `<div class="dialog-head"><h2 style="font-size:18px">請確認這份文件</h2><button type="button" data-x aria-label="關閉">×</button></div>
      <div class="fin-review"><div><div class="fin-preview">${isImage(d) ? `<img src="${fileUrl(d)}" alt="">` : `<p class="fin-muted" style="padding:20px;text-align:center">${esc(d.originalName)}<br><br><a class="fin-btn" href="${fileUrl(d)}" target="_blank" rel="noopener">開啟原檔</a></p>`}</div>
        <p class="fin-muted" style="margin-top:6px">AI 把握度：${d.confidence === null ? '—' : Math.round(d.confidence * 100) + '%'}　<a href="${fileUrl(d)}" target="_blank" rel="noopener">開新視窗看原檔</a></p></div>
      <form class="fin-form" id="fin-form">
        <div class="wide">${(d.questions || []).map((q) => `<div class="fin-q">${esc(q)}</div>`).join('') || '<div class="fin-muted">沒有疑問，確認後就會歸檔。</div>'}</div>
        <label>文件類型<select name="docType">${typeOptions(f.docType || '其他')}</select></label>
        <label>屬於集團哪家公司<select name="company">${companyOptions(f.company)}</select></label>
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
        <label class="wide" style="display:flex;gap:8px;align-items:center;color:var(--ink)"><input type="checkbox" name="countInPnl" style="width:auto;margin:0"${f.countInPnl ? ' checked' : ''}> 計入損益表</label>
        <div class="wide" style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
          <button type="button" class="fin-btn" data-retry>重新辨識</button>
          <button type="button" class="fin-btn warn" data-ignore>不處理（不歸檔、不計入）</button>
          <button type="submit" class="fin-btn pri">確認並歸檔${left ? `（還有 ${left} 份）` : ''}</button></div>
      </form></div>`;
    if (!dlg.open) dlg.showModal();
    $('[data-x]', dlg).onclick = () => dlg.close();
    const form = $('#fin-form', dlg);
    form.elements.docType.onchange = () => {
      const t = form.elements.docType.value;
      if (['報價單', '合約', '其他', '銷項發票'].includes(t)) { form.elements.countInPnl.checked = false; form.elements.category.value = ''; }
    };
    const next = async () => { await loadPending(); if (pending.length) openReview(root, pending[0].id); else { dlg.close(); ctx.notify?.('全部確認完了'); } shell(root); paintInbox(root, $('#fin-body', root)); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const el = form.elements, num = (v) => (v === '' ? null : Number(v));
      try {
        const r = await api('/api/finance/documents/' + id + '/confirm', 'POST', {docType: el.docType.value, company: el.company.value || null, orgId: el.orgId.value || null, counterpartyName: el.counterpartyName.value, invoiceNumber: el.invoiceNumber.value, date: el.date.value || null, month: el.month.value || null, net: num(el.net.value), tax: num(el.tax.value), total: num(el.total.value), category: el.category.value || null, description: el.description.value, countInPnl: el.countInPnl.checked});
        ctx.notify?.('已歸檔到 ' + r.document.storedPath);
        await next();
      } catch (err) { ctx.notify?.(err.message); }
    };
    $('[data-ignore]', dlg).onclick = async () => {
      if (!confirm('這份文件不歸檔、也不計入損益？（檔案會留在 財務收件匣/待確認）')) return;
      try { await api('/api/finance/documents/' + id + '/ignore', 'POST', {}); await next(); } catch (err) { ctx.notify?.(err.message); }
    };
    $('[data-retry]', dlg).onclick = async (ev) => {
      ev.target.disabled = true; ev.target.textContent = '辨識中…';
      try { const r = await api('/api/finance/documents/' + id + '/retry', 'POST', {}); pending = pending.map((x) => x.id === id ? r.document : x); openReview(root, id); }
      catch (err) { ctx.notify?.(err.message); ev.target.disabled = false; ev.target.textContent = '重新辨識'; }
    };
  }

  async function paintFiled(root, body) {
    const data = await api('/api/finance/documents?status=filed' + (filedMonth ? '&month=' + filedMonth : ''));
    filed = data.documents;
    body.innerHTML = `<div class="fin-row"><label>月份 <input type="month" id="fin-fm" value="${esc(filedMonth)}"></label><span class="fin-muted">共 ${filed.length} 份</span></div>
      <div class="fin-scroll"><table class="fin-table fin-left"><thead><tr><th>日期</th><th>公司</th><th>類型</th><th>對象</th><th>發票號碼</th><th>含稅總額</th><th>科目</th><th>計入</th><th>歸檔位置</th><th></th></tr></thead><tbody>
      ${filed.map((d) => { const f = d.fields || {}; return `<tr><td>${esc(f.date || f.month || '')}</td><td>${esc(f.company || '')}</td><td>${esc(f.docType)}</td><td>${esc(f.orgName || f.counterpartyName || '')}</td><td>${esc(f.invoiceNumber || '')}</td><td style="text-align:right">${money(f.total)}</td><td>${esc(f.category || '')}</td><td>${f.countInPnl ? '✓' : ''}</td><td class="fin-muted">${esc(d.storedPath)}</td>
        <td><a class="fin-btn" href="${fileUrl(d)}" target="_blank" rel="noopener">開啟</a> <button class="fin-btn" data-reopen="${d.id}">重新確認</button></td></tr>`; }).join('') || '<tr><td colspan="10">還沒有歸檔的文件。</td></tr>'}
      </tbody></table></div>`;
    $('#fin-fm', body).onchange = (e) => { filedMonth = e.target.value; paintFiled(root, body); };
    $$('[data-reopen]', body).forEach((b) => b.onclick = async () => {
      try { await api('/api/finance/documents/' + b.dataset.reopen + '/reopen', 'POST', {}); await loadPending(); tab = 'inbox'; shell(root); paintInbox(root, $('#fin-body', root)); openReview(root, b.dataset.reopen); }
      catch (e) { ctx.notify?.(e.message); }
    });
  }

  function revenueLine(p) {
    const st = Object.entries(p.revenueStatus || {});
    if (!st.length) return '營收還沒讀取過，請按「更新營收」';
    const errs = st.filter(([, v]) => v.error);
    const last = st.map(([, v]) => v.fetchedAt).filter(Boolean).sort().pop();
    return (last ? '營收更新於 ' + new Date(last).toLocaleString('zh-TW', {timeZone: 'Asia/Taipei', hour12: false}) : '') + (errs.length ? `；${errs.length} 個月更新失敗：${errs[0][1].error}` : '');
  }

  async function paintSettings(root, body) {
    const st = await api('/api/finance/settings');
    let rows = st.companies.map((c) => ({name: c.name, taxId: c.taxId, aliases: (c.aliases || []).join(', ')}));
    const draw = () => {
      body.innerHTML = `<h2 style="font-size:17px;margin:0 0 6px">集團公司</h2>
      <p class="fin-muted">文件會依買方／賣方統編（或名稱）判斷屬於哪一家公司，損益表合併計算。統編填好後，判斷會更準。</p>
      <form id="fin-co"><div class="fin-scroll"><table class="fin-table fin-left"><thead><tr><th>公司名稱</th><th>統編（8 碼）</th><th>其他名稱（逗號分隔）</th><th></th></tr></thead><tbody>
      ${rows.map((c, i) => `<tr><td><input data-k="name" data-i="${i}" value="${esc(c.name)}" style="width:140px"></td><td><input data-k="taxId" data-i="${i}" value="${esc(c.taxId)}" inputmode="numeric" maxlength="8" style="width:110px"></td><td><input data-k="aliases" data-i="${i}" value="${esc(c.aliases)}" style="width:280px"></td><td><button type="button" class="fin-btn warn" data-rm="${i}">移除</button></td></tr>`).join('')}
      </tbody></table></div><div class="fin-row"><button type="button" class="fin-btn" id="fin-co-add">新增公司</button><button class="fin-btn pri">儲存</button></div></form>
      <h2 style="font-size:17px;margin:20px 0 6px">營收來源</h2>
      <p class="fin-muted">唯讀讀取百麒系統後台 Firestore（專案 ${esc(st.revenueSource.project)}）的 statement_cases，只取已寄出的版本；不會寄送、改動或開票。<br>
      服務帳戶：${esc(st.revenueSource.serviceAccount || '尚未設定')}；需要的權限：${esc(st.revenueSource.role)}。</p>`;
      $$('#fin-co input', body).forEach((inp) => inp.oninput = () => { rows[Number(inp.dataset.i)][inp.dataset.k] = inp.value; });
      $('#fin-co-add', body).onclick = () => { rows.push({name: '', taxId: '', aliases: ''}); draw(); };
      $$('[data-rm]', body).forEach((btn) => btn.onclick = () => { rows.splice(Number(btn.dataset.rm), 1); draw(); });
      $('#fin-co', body).onsubmit = async (e) => {
        e.preventDefault();
        try {
          const r = await api('/api/finance/settings', 'PUT', {companies: rows.filter((c) => c.name.trim()).map((c) => ({name: c.name, taxId: c.taxId, aliases: c.aliases.split(/[,，、]/)}))});
          meta.companies = r.companies; rows = r.companies.map((c) => ({name: c.name, taxId: c.taxId, aliases: (c.aliases || []).join(', ')}));
          ctx.notify?.('已儲存'); draw();
        } catch (err) { ctx.notify?.(err.message); }
      };
    };
    draw();
  }

  async function paintPnl(root, body) {
    const p = await api(`/api/finance/pnl?year=${year}&basis=${basis}`);
    const entries = (await api('/api/finance/entries?month=' + entryMonth)).entries;
    const mlabel = (m) => Number(m.slice(5)) + '月';
    const row = (label, obj, total, cls = '', noteKey) => `<tr class="${cls}"><td>${esc(label)}</td>${p.months.map((m) => { const v = obj[m]; const note = noteKey && p.notes[noteKey + '|' + m]; return `<td class="${v < 0 ? 'neg' : ''}"${note ? ` title="${esc(note)}"` : ''}>${v ? money(v) : ''}${note ? '*' : ''}</td>`; }).join('')}<td>${money(total)}</td></tr>`;
    const years = Array.from({length: 4}, (_, i) => String(Number(thisYear()) - i));
    body.innerHTML = `<div class="fin-row"><label>年度 <select id="fin-year">${years.map((y) => `<option${y === year ? ' selected' : ''}>${y}</option>`).join('')}</select></label>
      <label>金額 <select id="fin-basis"><option value="total"${basis === 'total' ? ' selected' : ''}>含稅（同原本損益表）</option><option value="net"${basis === 'net' ? ' selected' : ''}>未稅</option></select></label>
      <a class="fin-btn" href="/api/finance/pnl.csv?year=${year}&basis=${basis}">下載 Excel（CSV）</a>
      <button class="fin-btn" id="fin-rev">更新 ${year} 營收</button><span class="fin-muted" id="fin-rev-msg">${esc(revenueLine(p))}</span></div>
      <div class="fin-scroll"><table class="fin-table"><thead><tr><th>項目</th>${p.months.map((m) => `<th>${mlabel(m)}</th>`).join('')}<th>年度總計</th></tr></thead><tbody>
      ${p.expenses.map((r) => row(r.category, r.months, r.total, '', r.category === '薪資' ? '薪資' : '')).join('')}
      ${row('總支出', p.expenseTotal, p.expenseYear, 'sum')}${row('收入（對帳單）', p.revenue, p.revenueYear, '', '收入')}${row('其他收入', p.otherIncome, p.otherIncomeYear)}${row('收入合計', p.income, p.incomeYear, 'sum')}${row('淨利', p.profit, p.profitYear, 'profit')}
      </tbody></table></div>
      <p class="fin-muted" style="margin-top:6px">收入取自百麒系統後台「已寄出」的對帳單（含稅應付金額），每天自動更新本月與上月；銷項發票只歸檔不計入。薪資＝人資每月實發合計（滑鼠移到 * 看人數），加上手動薪資調整。支出只計入已歸檔且勾選計入的文件和手動項目。</p>
      <h2 style="font-size:17px;margin:20px 0 6px">手動項目與明細</h2>
      <p class="fin-muted">「其他收入」只填對帳單以外的收入（例如廢品出售、利息、補助），洗滌營收已自動計入，重複填會算兩次。「薪資」只填人資實發以外的調整（例如預支、年終）。</p>
      <form class="fin-row" id="fin-manual"><input type="month" name="month" value="${esc(entryMonth)}" required>
        <select name="category" required>${catOptions('')}</select><input name="counterparty" placeholder="對象（例如 欣雄、合庫）" style="width:150px">
        <input name="description" placeholder="摘要" style="width:180px"><input name="total" type="number" step="0.01" placeholder="含稅金額" required style="width:120px">
        <button class="fin-btn pri">新增</button></form>
      <div class="fin-scroll"><table class="fin-table fin-left"><thead><tr><th>月份</th><th>科目</th><th>對象</th><th>摘要</th><th>含稅</th><th>來源</th><th></th></tr></thead><tbody>
      ${entries.map((e) => `<tr><td>${esc(e.month)}</td><td>${esc(e.category)}</td><td>${esc(e.counterparty || '')}</td><td>${esc(e.description || '')}</td><td style="text-align:right">${money(e.total)}</td><td>${e.source === 'manual' ? '手動' : esc(e.docType || '文件')}</td>
        <td>${e.source === 'manual' ? `<button class="fin-btn warn" data-del="${e.id}">刪除</button>` : `<a class="fin-btn" href="/api/finance/documents/${e.docId}/file" target="_blank" rel="noopener">原檔</a>`}</td></tr>`).join('') || `<tr><td colspan="7">${esc(entryMonth)} 沒有項目。</td></tr>`}
      </tbody></table></div>`;
    $('#fin-rev', body).onclick = async (ev) => {
      ev.target.disabled = true; $('#fin-rev-msg', body).textContent = '讀取對帳單中…';
      try {
        const r = await api('/api/finance/revenue/refresh', 'POST', {year});
        const err = r.results.find((x) => x.error);
        ctx.notify?.(err ? '營收更新失敗：' + err.error : `已更新 ${r.results.length} 個月營收（讀取 ${r.reads} 筆對帳單）`);
        paintPnl(root, body);
      } catch (e) { ctx.notify?.(e.message); ev.target.disabled = false; }
    };
    $('#fin-year', body).onchange = (e) => { year = e.target.value; paintPnl(root, body); };
    $('#fin-basis', body).onchange = (e) => { basis = e.target.value; paintPnl(root, body); };
    const form = $('#fin-manual', body);
    form.elements.month.onchange = (e) => { entryMonth = e.target.value; paintPnl(root, body); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!form.elements.category.value) { ctx.notify?.('請選科目'); return; }
      try {
        await api('/api/finance/entries', 'POST', {month: form.elements.month.value, category: form.elements.category.value, counterparty: form.elements.counterparty.value, description: form.elements.description.value, total: Number(form.elements.total.value)});
        ctx.notify?.('已新增'); paintPnl(root, body);
      } catch (err) { ctx.notify?.(err.message); }
    };
    $$('[data-del]', body).forEach((b) => b.onclick = async () => {
      if (!confirm('刪除這筆手動項目？')) return;
      try { await api('/api/finance/entries/' + b.dataset.del, 'DELETE'); paintPnl(root, body); } catch (err) { ctx.notify?.(err.message); }
    });
  }

  window.CompanyFinance = {
    render(root, options) {
      ctx = options || {}; ensureCss();
      if (!root) return;
      if (!ctx.nasMode) { root.innerHTML = '<div class="empty">財務功能需要連上 NAS 並登入後才能使用。</div>'; return; }
      paint(root);
    },
  };
})();
