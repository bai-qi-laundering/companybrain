/* 財務：已歸檔的財務文件、月損益表、設定（上傳與待確認在「收件匣」：inbox-app.js） */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const money = (v) => (v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString('zh-TW', {maximumFractionDigits: 2}));
  const thisYear = () => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Taipei', year: 'numeric'}).format(new Date());
  const thisMonth = () => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit'}).format(new Date());
  let ctx = {}, meta = null, tab = 'filed', year = thisYear(), basis = 'total', filedMonth = '', entryMonth = thisMonth();
  let filed = [];

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
  const catOptions = (sel) => '<option value="">（不計入／未選）</option>' + [...(meta?.expenseCategories || []), ...(meta?.incomeCategories || [])].map((c) => `<option${c === sel ? ' selected' : ''}>${esc(c)}</option>`).join('');
  const fileUrl = (d) => '/api/finance/documents/' + d.id + '/file';

  async function loadMeta() { meta = await api('/api/finance/meta'); }

  function shell(root) {
    const n = (meta?.counts?.needs_review || 0) + (meta?.counts?.error || 0);
    root.innerHTML = `<p class="fin-muted" style="margin:0 0 10px">上傳文件請到 <a href="#" id="fin-go-inbox">收件匣（${n} 份待確認）</a></p>
      <div class="fin-tabs">
      <button data-tab="filed" class="${tab === 'filed' ? 'on' : ''}">已歸檔</button>
      <button data-tab="pnl" class="${tab === 'pnl' ? 'on' : ''}">損益表</button>
      <button data-tab="settings" class="${tab === 'settings' ? 'on' : ''}">設定</button></div><div id="fin-body"></div>`;
    $$('[data-tab]', root).forEach((b) => b.onclick = () => { tab = b.dataset.tab; paint(root); });
    $('#fin-go-inbox', root).onclick = (e) => { e.preventDefault(); ctx.openInbox?.(); };
  }

  async function paint(root) {
    try {
      await loadMeta();
      shell(root);
      const body = $('#fin-body', root);
      if (tab === 'filed') await paintFiled(root, body);
      else if (tab === 'settings') await paintSettings(root, body);
      else await paintPnl(root, body);
    } catch (e) { root.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  async function paintFiled(root, body) {
    const data = await api('/api/finance/documents?status=filed&scope=finance' + (filedMonth ? '&month=' + filedMonth : ''));
    filed = data.documents;
    body.innerHTML = `<div class="fin-row"><label>月份 <input type="month" id="fin-fm" value="${esc(filedMonth)}"></label><span class="fin-muted">共 ${filed.length} 份</span></div>
      <div class="fin-scroll"><table class="fin-table fin-left"><thead><tr><th>日期</th><th>公司</th><th>類型</th><th>對象</th><th>發票號碼</th><th>含稅總額</th><th>科目</th><th>計入</th><th>歸檔位置</th><th></th></tr></thead><tbody>
      ${filed.map((d) => { const f = d.fields || {}; return `<tr><td>${esc(f.date || f.month || '')}</td><td>${esc(f.company || '')}</td><td>${esc(f.docType)}</td><td>${esc(f.orgName || f.counterpartyName || '')}</td><td>${esc(f.invoiceNumber || '')}</td><td style="text-align:right">${money(f.total)}</td><td>${esc(f.category || '')}</td><td>${f.countInPnl ? '✓' : ''}</td><td class="fin-muted">${esc(d.storedPath)}</td>
        <td><a class="fin-btn" href="${fileUrl(d)}" target="_blank" rel="noopener">開啟</a> <button class="fin-btn" data-reopen="${d.id}">重新確認</button></td></tr>`; }).join('') || '<tr><td colspan="10">還沒有歸檔的文件。</td></tr>'}
      </tbody></table></div>`;
    $('#fin-fm', body).onchange = (e) => { filedMonth = e.target.value; paintFiled(root, body); };
    $$('[data-reopen]', body).forEach((b) => b.onclick = async () => {
      try { await api('/api/finance/documents/' + b.dataset.reopen + '/reopen', 'POST', {}); ctx.notify?.('已移回收件匣，請在收件匣重新確認'); ctx.openInbox?.(b.dataset.reopen); }
      catch (e) { ctx.notify?.(e.message); }
    });
  }

  function revenueLine(p) {
    const xl = (p.excelMonths || []).length ? `${p.excelMonths.map((m) => Number(m.slice(5))).join('、')} 月依原 Excel；` : '';
    const st = Object.entries(p.revenueStatus || {});
    if (!st.length) return xl + '營收還沒讀取過，請按「更新營收」';
    const errs = st.filter(([, v]) => v.error);
    const last = st.map(([, v]) => v.fetchedAt).filter(Boolean).sort().pop();
    return xl + (last ? '營收更新於 ' + new Date(last).toLocaleString('zh-TW', {timeZone: 'Asia/Taipei', hour12: false}) : '') + (errs.length ? `；${errs.length} 個月更新失敗：${errs[0][1].error}` : '');
  }

  function xlTable(r) {
    return `<p class="fin-muted">${esc(r.path)}（${esc(r.year)} 年）${r.dryRun ? '預覽' : '已匯入'}：${r.importMonths.length} 個月、${r.totals.entries} 筆；收入 ${money(r.totals.revenue)}、支出 ${money(r.totals.expense)}（薪資 ${money(r.totals.salary)}）</p>
      <div class="fin-scroll"><table class="fin-table"><thead><tr><th>月份</th><th>收入</th><th>總支出</th><th>薪資</th><th>淨利</th><th>結果</th></tr></thead><tbody>
      ${r.months.map((m) => `<tr><td>${esc(m.month)}</td><td>${money(m.revenue || 0)}</td><td>${money(m.expenseTotal || 0)}</td><td>${money(m.salary || 0)}</td><td>${money(m.profit || 0)}</td><td style="text-align:left">${m.status === 'import' ? '匯入' : '略過：' + esc(m.reason)}${m.diffs?.length ? `<br><span class="fin-muted">明細與彙總不同（用彙總）：${esc(m.diffs.map((d) => d.category).join('、'))}</span>` : ''}</td></tr>`).join('')}
      </tbody></table></div>${(r.warnings || []).map((w) => `<p class="fin-muted">注意：${esc(w)}</p>`).join('')}`;
  }
  let xlPath = '115年支出明細/月份_自動損益表.xlsx', xlUntil = '', xlPreview = null;

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
      服務帳戶：${esc(st.revenueSource.serviceAccount || '尚未設定')}；需要的權限：${esc(st.revenueSource.role)}。</p>
      <h2 style="font-size:17px;margin:20px 0 6px">匯入原本的損益表 Excel</h2>
      <p class="fin-muted">只讀取 NAS 上的原檔，不會修改。只匯入已結帳（收入不是 0）的過去月份；匯入的月份以 Excel 為準，系統的對帳單、薪資、文件不再重複計入。可以重複匯入，會覆蓋上次匯入的同月份。</p>
      <form id="fin-xl" class="fin-row"><input name="path" value="${esc(xlPath)}" style="width:340px" placeholder="NAS 路徑"><input name="until" value="${esc(xlUntil)}" placeholder="最後月份（選填，YYYY-MM）" style="width:190px">
        <button class="fin-btn" data-mode="preview">預覽</button><button type="button" class="fin-btn pri" id="fin-xl-go" ${xlPreview?.importMonths?.length ? '' : 'disabled'}>確認匯入</button></form>
      <div id="fin-xl-out">${xlPreview ? xlTable(xlPreview) : ''}</div>`;
      $$('#fin-co input', body).forEach((inp) => inp.oninput = () => { rows[Number(inp.dataset.i)][inp.dataset.k] = inp.value; });
      const xlForm = $('#fin-xl', body);
      const xlRun = async (dryRun) => {
        xlPath = xlForm.path.value.trim(); xlUntil = xlForm.until.value.trim();
        try {
          const r = await api('/api/finance/import-excel', 'POST', {path: xlPath, until: xlUntil || undefined, dryRun});
          xlPreview = r; if (!dryRun) ctx.notify?.(`已匯入 ${r.importMonths.length} 個月（${r.inserted} 筆）`);
        } catch (err) { ctx.notify?.(err.message); }
        draw();
      };
      xlForm.onsubmit = (e) => { e.preventDefault(); xlRun(true); };
      $('#fin-xl-go', body).onclick = () => { if (confirm(`匯入 ${xlPreview.importMonths.join('、')}？這些月份會以 Excel 為準。`)) xlRun(false); };
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
      ${entries.map((e) => `<tr><td>${esc(e.month)}</td><td>${esc(e.category)}</td><td>${esc(e.counterparty || '')}</td><td>${esc(e.description || '')}</td><td style="text-align:right">${money(e.total)}</td><td>${e.source === 'manual' ? '手動' : e.source === 'excel-import' ? '原 Excel' : esc(e.docType || '文件')}</td>
        <td>${e.source === 'excel-import' ? '' : e.source === 'manual' ? `<button class="fin-btn warn" data-del="${e.id}">刪除</button>` : `<a class="fin-btn" href="/api/finance/documents/${e.docId}/file" target="_blank" rel="noopener">原檔</a>`}</td></tr>`).join('') || `<tr><td colspan="7">${esc(entryMonth)} 沒有項目。</td></tr>`}
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
