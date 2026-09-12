/* ==========================================================================
   BizWeb KH CRM — invoices.js
   New Invoices module. Each invoice is its own self-contained record
   (line items / summary / notes inline) persisted to the `invoices`
   Supabase table via the same DB.upsert()/rowToInvoice()/invoiceToRow()
   convention already used for `quotations` (see data.js). Total Paid /
   Balance Due are NEVER stored on the invoice — always derived live from
   linked Payment records (payments.invoice_id), the exact same principle
   paymentSummaryFor() already uses for a Project's own totals.

   PDF/print pipeline: this module supplies its own `buildInvoiceSections()`
   (invoice-shaped content) but reuses the EXACT SAME generic A4 pagination
   engine already built for Quotations — measureQuoteDoc() / packQuoteSections()
   / renderQuotePagesHtml() / printQuoteDocFromContainer() (js/quotations.js)
   — and the exact same `.quote-doc-*` / `.quote-page*` CSS. None of that is
   duplicated here; only invoice-specific HTML fragments are new.
   ========================================================================== */

const INVOICE_STATUSES = ['Draft', 'Issued', 'Partially Paid', 'Paid', 'Cancelled'];
// Only these two are ever picked directly on the Create/Edit form — every
// other status is reached only through the payment-driven transition
// function below (Partially Paid / Paid) or the dedicated Cancel action
// (Cancelled), never typed/selected freely (spec §11: "a clear
// status-transition function, not scattered inline logic").
const INVOICE_CREATE_STATUSES = ['Draft', 'Issued'];

/* ---------------------------------------------------------------------- */
/* Permissions (mirrors isFounder()/canEditPayments() conventions exactly  */
/* — no new permission system invented).                                  */
/* ---------------------------------------------------------------------- */
function canCreateInvoiceForProject(proj){
  if(!proj) return false;
  if(isFounder()) return true;
  if(CURRENT_USER.role === 'sales') return proj.assignedSales === CURRENT_USER.name;
  return CURRENT_USER.role === 'partner_operations'; // view/create parity with their existing Quotations/Payments access
}
// Editing an Issued+ invoice (or cancelling / deleting one) is Founder/Admin
// only — same "financial document, founder-gated once live" rule already
// used for payments (PAYMENT_EDIT_ROLES). A still-Draft invoice can be
// edited by whoever created it (mirrors Quotations' own Draft-edit rule).
function canEditInvoice(inv){
  if(isFounder()) return true;
  return inv.status === 'Draft' && inv.createdBy === CURRENT_USER.name;
}
function canCancelInvoice(){ return isFounder(); }
function canDeleteInvoice(){ return isFounder(); }

/* ---------------------------------------------------------------------- */
/* Totals + status-transition (spec §8/§11) — the ONE place either is      */
/* computed; every surface (list, detail, project sub-list, PDF) calls    */
/* these instead of recomputing inline.                                   */
/* ---------------------------------------------------------------------- */
function invoicePaymentsFor(invoiceId){
  return DB.all('payments')
    .filter(p=> p.invoiceId===invoiceId && !p.voided)
    .sort((a,b)=> new Date(a.date||a.createdAt) - new Date(b.date||b.createdAt));
}
function invoiceTotals(inv){
  const subtotal = (inv.items||[]).reduce((s,it)=> s + (Number(it.qty)||1) * (Number(it.amount)||0), 0);
  const discount = Number(inv.discountAmount)||0;
  const total = Math.max(0, Math.round((subtotal - discount) * 100) / 100);
  const totalPaid = invoicePaymentsFor(inv.id).reduce((s,p)=> s + (Number(p.amount)||0), 0);
  const balance = Math.max(0, Math.round((total - totalPaid) * 100) / 100);
  return { subtotal, discount, total, totalPaid, balance };
}
// Pure — never mutates, never saves. Draft/Cancelled are manual-only states
// that a payment can never auto-advance out of (spec §11): a Draft invoice
// isn't "live" yet, and a Cancelled one is excluded from balance tracking
// entirely regardless of what payments exist against it.
function nextInvoiceStatus(inv, totals){
  if(inv.status==='Draft' || inv.status==='Cancelled') return inv.status;
  const EPS = 0.005;
  if(totals.totalPaid <= EPS) return 'Issued';
  if(totals.balance > EPS) return 'Partially Paid';
  return 'Paid';
}
// Recomputes + persists the status transition for one invoice (called after
// any payment is recorded/edited/voided against it). Returns the fresh
// {inv, totals} pair, or null if the invoice no longer exists.
function recalcInvoiceStatus(invoiceId){
  if(!invoiceId) return null;
  const inv = DB.find('invoices', invoiceId);
  if(!inv) return null;
  const totals = invoiceTotals(inv);
  const next = nextInvoiceStatus(inv, totals);
  if(next !== inv.status){ inv.status = next; DB.upsert('invoices', inv); }
  return { inv, totals };
}

/* ---------------------------------------------------------------------- */
/* Invoice List Page                                                      */
/* ---------------------------------------------------------------------- */
let INV_FILTER_STATE = { status:'', date:'all', project:'', client:'', search:'' };
let INV_PAGE = 1;
const INV_PAGE_SIZE = 20;

function renderInvoicesPage(){
  const el = document.getElementById('pageContent');
  const projects = DB.all('projects');
  el.innerHTML = `
    <div class="flex-row" style="justify-content:flex-end;margin-bottom:14px">
      <button class="btn btn-primary btn-sm" id="invCreateBtn">+ Create Invoice</button>
    </div>
    <div class="filters-bar" style="margin-bottom:16px">
      <select id="invFltStatus" class="sel">
        <option value="">All Statuses</option>
        ${INVOICE_STATUSES.map(s=>`<option value="${s}" ${INV_FILTER_STATE.status===s?'selected':''}>${s}</option>`).join('')}
      </select>
      <select id="invFltDate" class="sel">
        <option value="all" ${INV_FILTER_STATE.date==='all'?'selected':''}>All Time</option>
        <option value="month" ${INV_FILTER_STATE.date==='month'?'selected':''}>This Month</option>
        <option value="30d" ${INV_FILTER_STATE.date==='30d'?'selected':''}>Last 30 Days</option>
        <option value="year" ${INV_FILTER_STATE.date==='year'?'selected':''}>This Year</option>
      </select>
      <select id="invFltProject" class="sel">
        <option value="">All Projects</option>
        ${projects.map(p=>`<option value="${p.id}" ${INV_FILTER_STATE.project===p.id?'selected':''}>${p.id} — ${escapeHtml(p.businessName)}</option>`).join('')}
      </select>
      <input id="invFltSearch" placeholder="Search invoice #, client, business…" value="${escapeHtml(INV_FILTER_STATE.search)}" style="min-width:220px">
    </div>
    <div id="invTableWrap"></div>
  `;
  document.getElementById('invCreateBtn').onclick = ()=> openCreateInvoiceModal();
  document.getElementById('invFltStatus').onchange = (e)=>{ INV_FILTER_STATE.status=e.target.value; INV_PAGE=1; renderInvTable(); };
  document.getElementById('invFltDate').onchange = (e)=>{ INV_FILTER_STATE.date=e.target.value; INV_PAGE=1; renderInvTable(); };
  document.getElementById('invFltProject').onchange = (e)=>{ INV_FILTER_STATE.project=e.target.value; INV_PAGE=1; renderInvTable(); };
  let searchDebounce;
  document.getElementById('invFltSearch').oninput = (e)=>{
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(()=>{ INV_FILTER_STATE.search=e.target.value; INV_PAGE=1; renderInvTable(); }, 200);
  };
  renderInvTable();
}

function invWithinDateFilter(dateStr){
  if(INV_FILTER_STATE.date==='all') return true;
  if(!dateStr) return false;
  const d = new Date(dateStr);
  if(isNaN(d)) return false;
  const now = new Date();
  if(INV_FILTER_STATE.date==='month') return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth();
  if(INV_FILTER_STATE.date==='30d'){ const cutoff=new Date(now); cutoff.setDate(cutoff.getDate()-30); return d>=cutoff && d<=now; }
  if(INV_FILTER_STATE.date==='year') return d.getFullYear()===now.getFullYear();
  return true;
}

function filteredInvoices(){
  const f = INV_FILTER_STATE;
  const q = f.search.trim().toLowerCase();
  return DB.all('invoices').filter(inv=>{
    if(f.status && inv.status!==f.status) return false;
    if(f.project && inv.projectCode!==f.project) return false;
    if(!invWithinDateFilter(inv.invoiceDate)) return false;
    if(q){
      const hay = `${inv.invoiceNumber} ${inv.clientName} ${inv.businessName}`.toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  }).sort((a,b)=> new Date(b.createdAt||b.invoiceDate) - new Date(a.createdAt||a.invoiceDate));
}

function renderInvTable(){
  const wrap = document.getElementById('invTableWrap');
  if(!wrap) return;
  const all = filteredInvoices();
  const totalPages = Math.max(1, Math.ceil(all.length / INV_PAGE_SIZE));
  INV_PAGE = Math.min(INV_PAGE, totalPages);
  const startIdx = (INV_PAGE-1)*INV_PAGE_SIZE;
  const pageRows = all.slice(startIdx, startIdx+INV_PAGE_SIZE);

  wrap.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h3>Invoices</h3><span class="text-muted" style="font-size:12px">${all.length} invoice${all.length===1?'':'s'}</span></div>
      <div class="panel-body pad">
        <div class="table-wrap scroll-x">
          <table class="data-table">
            <thead>
              <tr>
                <th>Invoice No.</th><th>Date</th><th>Project Code</th><th>Client / Business</th>
                <th>Project</th><th>Total</th><th>Paid</th><th>Balance</th><th>Status</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${pageRows.length ? pageRows.map(inv=>{
                const totals = invoiceTotals(inv);
                const proj = inv.projectCode ? DB.find('projects', inv.projectCode) : null;
                return `
                <tr>
                  <td class="cell-link" data-open="${inv.id}">${escapeHtml(inv.invoiceNumber)}</td>
                  <td>${fmtDate(inv.invoiceDate)}</td>
                  <td>${escapeHtml(inv.projectCode||'—')}</td>
                  <td>${escapeHtml(inv.clientName)}<div class="cell-sub">${escapeHtml(inv.businessName||'')}</div></td>
                  <td>${proj?escapeHtml(serviceDisplayName(proj.projectType)):'—'}</td>
                  <td class="cell-strong">${money(totals.total)}</td>
                  <td style="font-weight:700;color:${totals.totalPaid>0?'var(--green)':'inherit'}">${money(totals.totalPaid)}</td>
                  <td style="font-weight:700;color:${totals.balance>0?'#d98a12':'inherit'}">${money(totals.balance)}</td>
                  <td>${statusBadge(inv.status)}</td>
                  <td>
                    <div class="flex-row" style="gap:2px;flex-wrap:wrap">
                      <button class="btn btn-ghost btn-sm" data-open="${inv.id}">View</button>
                      <button class="btn btn-ghost btn-sm" data-pdf="${inv.id}">PDF</button>
                      ${totals.balance>0.004 && inv.status!=='Draft' && inv.status!=='Cancelled' ? `<button class="btn btn-ghost btn-sm" data-pay="${inv.id}">Record Payment</button>` : ''}
                      <button class="btn btn-ghost btn-sm" data-dup="${inv.id}">Duplicate</button>
                    </div>
                  </td>
                </tr>`;
              }).join('') : `<tr><td colspan="10"><div class="empty-row">No invoices match the current filters.</div></td></tr>`}
            </tbody>
          </table>
        </div>
        ${renderInvPagination(all.length, totalPages)}
      </div>
    </div>
  `;
  wrap.querySelectorAll('[data-open]').forEach(x=> x.onclick = ()=> openInvoiceDetailModal(x.dataset.open));
  wrap.querySelectorAll('[data-pdf]').forEach(x=> x.onclick = ()=> openInvoicePreview(x.dataset.pdf, true));
  wrap.querySelectorAll('[data-pay]').forEach(x=>{
    x.onclick = ()=>{
      const inv = DB.find('invoices', x.dataset.pay);
      if(inv && inv.projectCode) openRecordPaymentModal(inv.projectCode, ()=> renderInvTable(), inv.id);
    };
  });
  wrap.querySelectorAll('[data-dup]').forEach(x=> x.onclick = ()=> duplicateInvoice(x.dataset.dup));
  wrap.querySelectorAll('[data-page]').forEach(btn=>{
    btn.onclick = ()=>{
      const p = btn.dataset.page;
      if(p==='prev') INV_PAGE = Math.max(1, INV_PAGE-1);
      else if(p==='next') INV_PAGE = Math.min(totalPages, INV_PAGE+1);
      else INV_PAGE = Number(p);
      renderInvTable();
    };
  });
}

function renderInvPagination(totalCount, totalPages){
  if(totalCount===0) return '';
  const startIdx = (INV_PAGE-1)*INV_PAGE_SIZE;
  const shownFrom = startIdx+1;
  const shownTo = Math.min(totalCount, startIdx+INV_PAGE_SIZE);
  let pageBtns = '';
  for(let p=1;p<=totalPages;p++){
    if(totalPages>7 && p!==1 && p!==totalPages && Math.abs(p-INV_PAGE)>2){
      if(p===2 || p===totalPages-1) pageBtns += `<span style="padding:0 4px;color:var(--muted)">…</span>`;
      continue;
    }
    pageBtns += `<button class="btn ${p===INV_PAGE?'btn-primary':'btn-secondary'} btn-sm" data-page="${p}" style="min-width:34px">${p}</button>`;
  }
  return `
    <div class="flex-row" style="justify-content:space-between;flex-wrap:wrap;gap:10px;margin:12px 0 0">
      <p class="text-muted" style="margin:0;font-size:12px">Showing ${shownFrom}–${shownTo} of ${totalCount} invoices</p>
      <div class="flex-row" style="gap:6px">
        <button class="btn btn-secondary btn-sm" data-page="prev" ${INV_PAGE<=1?'disabled':''}>Previous</button>
        ${pageBtns}
        <button class="btn btn-secondary btn-sm" data-page="next" ${INV_PAGE>=totalPages?'disabled':''}>Next</button>
      </div>
    </div>
  `;
}

/* ---------------------------------------------------------------------- */
/* Create / Edit Invoice                                                  */
/* ---------------------------------------------------------------------- */
let IC_STATE = null;

function defaultInvoiceSummary(proj, paidSoFar){
  const name = proj ? (proj.businessName || proj.clientName) : 'the';
  const phrase = paidSoFar > 0.004 ? 'partial payment received' : 'payment due';
  return `This invoice confirms the ${phrase} for the ${name} project, as outlined in the item breakdown below.`;
}

// Best-effort scope prefill from the project's own most relevant quotation
// (spec §4: "if the linkage isn't straightforward, don't over-engineer") —
// silently leaves items empty if no usable quotation is found.
function invoiceItemsFromProjectScope(projectCode){
  if(!projectCode) return [];
  const quotes = DB.all('quotations').filter(q=> q.projectCode===projectCode && q.status!=='Superseded');
  const q = quotes.find(x=>x.status==='Accepted') || quotes.find(x=>x.status==='Sent') || quotes[0];
  if(!q || !Array.isArray(q.items) || !q.items.length) return [];
  return q.items.filter(it=> it.included!==false).map(it=>({
    id: fnId(), description: it.name, period: '', qty: 1, amount: Number(it.price)||0,
  }));
}

function openCreateInvoiceModal(prefill={}){
  const proj = prefill.projectCode ? DB.find('projects', prefill.projectCode) : null;
  IC_STATE = {
    editingId: null,
    invoiceNumber: null, // assigned on first save
    projectCode: proj ? proj.id : '',
    clientName: proj ? proj.clientName : '',
    businessName: proj ? proj.businessName : '',
    websiteLink: '',
    invoiceDate: todayLocalISO(),
    projectStatus: proj ? proj.stage : '',
    status: 'Draft',
    currency: 'USD',
    items: proj ? invoiceItemsFromProjectScope(proj.id) : [],
    discountAmount: 0,
    summary: defaultInvoiceSummary(proj, 0),
    notes: '',
    assignedSales: CURRENT_USER.name,
  };
  renderCreateInvoiceModal();
}

function loadInvoiceStateFrom(inv, { asDuplicate=false } = {}){
  return {
    editingId: asDuplicate ? null : inv.id,
    invoiceNumber: asDuplicate ? null : inv.invoiceNumber,
    projectCode: inv.projectCode || '',
    clientName: inv.clientName, businessName: inv.businessName || '',
    websiteLink: inv.websiteLink || '',
    invoiceDate: asDuplicate ? todayLocalISO() : inv.invoiceDate,
    projectStatus: inv.projectStatus || '',
    status: asDuplicate ? 'Draft' : inv.status,
    currency: inv.currency || 'USD',
    items: (inv.items||[]).map(it=>({ ...it, id: asDuplicate ? fnId() : (it.id||fnId()) })),
    discountAmount: Number(inv.discountAmount)||0,
    summary: inv.summary || '',
    notes: inv.notes || '',
    assignedSales: inv.assignedSales || CURRENT_USER.name,
  };
}

function duplicateInvoice(id){
  const src = DB.find('invoices', id);
  if(!src) return;
  IC_STATE = loadInvoiceStateFrom(src, { asDuplicate:true });
  renderCreateInvoiceModal();
}

function icAssignableProjects(){
  const all = DB.all('projects');
  if(isFounder() || CURRENT_USER.role==='partner_operations') return all;
  return all.filter(p=> p.assignedSales===CURRENT_USER.name);
}

function icApplyProject(projectCode){
  const proj = DB.find('projects', projectCode);
  if(!proj) return;
  const s = IC_STATE;
  s.projectCode = proj.id;
  s.clientName = proj.clientName;
  s.businessName = proj.businessName;
  s.projectStatus = proj.stage;
  if(!s.editingId && !s.items.length) s.items = invoiceItemsFromProjectScope(proj.id);
}

function icInvoiceNumberPreview(s){
  if(s.invoiceNumber) return s.invoiceNumber;
  return generateInvoiceNumber(s.projectCode || null, s.businessName || s.clientName, s.invoiceDate);
}

function invoiceItemsEditorHtml(items, currency){
  if(!items.length) return `<div class="empty-row">No line items yet — click "+ Add Row" below.</div>`;
  return `
    <div class="table-wrap scroll-x">
      <table class="data-table qc-mini-table">
        <thead><tr><th>No.</th><th>Description</th><th>Timeline / Period</th><th>Qty</th><th>Amount</th><th></th></tr></thead>
        <tbody>
          ${items.map((it,i)=>`
            <tr data-item="${it.id}">
              <td>${i+1}</td>
              <td><input data-f="description" data-id="${it.id}" value="${escapeHtml(it.description||'')}" placeholder="Item description"></td>
              <td><input data-f="period" data-id="${it.id}" value="${escapeHtml(it.period||'')}" placeholder="e.g. One-time / Monthly"></td>
              <td><input type="number" min="0" step="1" data-f="qty" data-id="${it.id}" value="${it.qty!=null?it.qty:1}" style="width:64px"></td>
              <td><input type="number" min="0" step="0.01" data-f="amount" data-id="${it.id}" value="${it.amount!=null?it.amount:0}" style="width:100px"></td>
              <td>
                <div class="flex-row" style="gap:2px">
                  <span class="icon-btn" data-move-up="${it.id}" title="Move up" style="cursor:pointer">&uarr;</span>
                  <span class="icon-btn" data-move-down="${it.id}" title="Move down" style="cursor:pointer">&darr;</span>
                  <span class="icon-btn" data-remove-item="${it.id}" title="Remove" style="font-size:15px;cursor:pointer">&times;</span>
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function wireInvoiceItemsEditor(overlay, s){
  overlay.querySelectorAll('[data-f]').forEach(inp=>{
    inp.onchange = ()=>{
      const it = s.items.find(x=>x.id===inp.dataset.id);
      if(!it) return;
      const f = inp.dataset.f;
      it[f] = (f==='qty'||f==='amount') ? Number(inp.value)||0 : inp.value;
      renderCreateInvoiceModal();
    };
  });
  overlay.querySelectorAll('[data-remove-item]').forEach(x=> x.onclick = ()=>{
    s.items = s.items.filter(i=>i.id!==x.dataset.removeItem);
    renderCreateInvoiceModal();
  });
  overlay.querySelectorAll('[data-move-up]').forEach(x=> x.onclick = ()=>{
    const idx = s.items.findIndex(i=>i.id===x.dataset.moveUp);
    if(idx>0){ const [it]=s.items.splice(idx,1); s.items.splice(idx-1,0,it); renderCreateInvoiceModal(); }
  });
  overlay.querySelectorAll('[data-move-down]').forEach(x=> x.onclick = ()=>{
    const idx = s.items.findIndex(i=>i.id===x.dataset.moveDown);
    if(idx>-1 && idx<s.items.length-1){ const [it]=s.items.splice(idx,1); s.items.splice(idx+1,0,it); renderCreateInvoiceModal(); }
  });
}

function renderCreateInvoiceModal(){
  const s = IC_STATE;
  const projects = icAssignableProjects();
  const subtotal = (s.items||[]).reduce((sum,it)=> sum + (Number(it.qty)||1)*(Number(it.amount)||0), 0);
  const total = Math.max(0, subtotal - (Number(s.discountAmount)||0));
  const existingPaid = s.editingId ? invoiceTotals({ id:s.editingId, items:s.items, discountAmount:s.discountAmount }).totalPaid : 0;
  const balance = Math.max(0, Math.round((total-existingPaid)*100)/100);

  const html = `
    <div class="modal-head"><h3>${s.editingId?'Edit Invoice':'Create Invoice'}</h3><button class="modal-close" id="icClose">&times;</button></div>
    <div class="modal-body">
      <p class="text-muted" style="margin-top:0;font-size:12.5px">Invoice No: <b>${escapeHtml(icInvoiceNumberPreview(s))}</b></p>
      <div class="form-grid">
        <div class="form-field"><label class="required">Project</label>
          <select id="ic_project">
            <option value="">— Select a project —</option>
            ${projects.map(p=>`<option value="${p.id}" ${s.projectCode===p.id?'selected':''}>${p.id} — ${escapeHtml(p.businessName)}</option>`).join('')}
          </select>
        </div>
        <div class="form-field"><label class="required">Client Name</label><input id="ic_client" value="${escapeHtml(s.clientName)}"></div>
        <div class="form-field"><label>Business Name</label><input id="ic_business" value="${escapeHtml(s.businessName)}"></div>
        <div class="form-field"><label>Website Link</label><input id="ic_website" value="${escapeHtml(s.websiteLink)}" placeholder="https://…"></div>
        <div class="form-field"><label class="required">Invoice Date</label><input type="date" id="ic_date" value="${s.invoiceDate}"></div>
        <div class="form-field"><label>Project Status</label>
          <select id="ic_pstatus">${PROJECT_STAGES.map(st=>`<option ${s.projectStatus===st?'selected':''}>${st}</option>`).join('')}</select>
        </div>
        <div class="form-field"><label>Payment Status</label>
          <select id="ic_status" ${s.editingId && !INVOICE_CREATE_STATUSES.includes(s.status) ? 'disabled' : ''}>
            ${INVOICE_CREATE_STATUSES.map(st=>`<option ${s.status===st?'selected':''}>${st}</option>`).join('')}
          </select>
          ${s.editingId && !INVOICE_CREATE_STATUSES.includes(s.status) ? `<p class="text-muted" style="font-size:11px;margin:4px 0 0">Current status (${escapeHtml(s.status)}) is driven automatically by recorded payments.</p>` : ''}
        </div>
        <div class="form-field"><label>Currency</label>
          <select id="ic_currency"><option ${s.currency==='USD'?'selected':''}>USD</option><option ${s.currency==='KHR'?'selected':''}>KHR</option></select>
        </div>
      </div>

      <div class="divider"></div>
      <div class="flex-row" style="justify-content:space-between;margin-bottom:8px">
        <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin:0">Invoice Items</div>
        <span class="cell-link" style="font-size:12px" id="ic_addRow">+ Add Row</span>
      </div>
      <div id="ic_itemsWrap">${invoiceItemsEditorHtml(s.items, s.currency)}</div>

      <div class="divider"></div>
      <div class="form-grid">
        <div class="form-field"><label>Discount / Promotion ($)</label><input type="number" min="0" step="0.01" id="ic_discount" value="${s.discountAmount||0}"></div>
        <div class="form-field"><label>Subtotal</label><input value="${money(subtotal)}" disabled></div>
        <div class="form-field"><label>Total Amount</label><input value="${money(total)}" disabled></div>
        <div class="form-field"><label>Total Paid</label><input value="${money(existingPaid)}" disabled></div>
        <div class="form-field"><label>Balance Due</label><input value="${money(balance)}" disabled></div>
      </div>

      <div class="divider"></div>
      <div class="form-field full"><label>Invoice Summary</label><textarea id="ic_summary" rows="3">${escapeHtml(s.summary)}</textarea></div>
      <div class="form-field full"><label>Notes</label><textarea id="ic_notes" rows="4" placeholder="e.g. Hosting/domain included, remaining balance details, extra features quoted separately…">${escapeHtml(s.notes)}</textarea></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="icCancel">Cancel</button>
      <button class="btn btn-primary" id="icSave">Save Invoice</button>
    </div>
  `;
  openModal(html, { xl:true, onMount:(overlay)=>{
    overlay.querySelector('#icClose').onclick = closeModal;
    overlay.querySelector('#icCancel').onclick = closeModal;
    overlay.querySelector('#ic_project').onchange = (e)=>{ icApplyProject(e.target.value); renderCreateInvoiceModal(); };
    overlay.querySelector('#ic_client').onchange = (e)=> s.clientName = e.target.value;
    overlay.querySelector('#ic_business').onchange = (e)=> s.businessName = e.target.value;
    overlay.querySelector('#ic_website').onchange = (e)=> s.websiteLink = e.target.value;
    overlay.querySelector('#ic_date').onchange = (e)=> s.invoiceDate = e.target.value;
    overlay.querySelector('#ic_pstatus').onchange = (e)=> s.projectStatus = e.target.value;
    const statusSel = overlay.querySelector('#ic_status');
    if(statusSel) statusSel.onchange = (e)=> s.status = e.target.value;
    overlay.querySelector('#ic_currency').onchange = (e)=> s.currency = e.target.value;
    overlay.querySelector('#ic_discount').onchange = (e)=>{ s.discountAmount = Number(e.target.value)||0; renderCreateInvoiceModal(); };
    overlay.querySelector('#ic_summary').onchange = (e)=> s.summary = e.target.value;
    overlay.querySelector('#ic_notes').onchange = (e)=> s.notes = e.target.value;
    overlay.querySelector('#ic_addRow').onclick = ()=>{ s.items.push({ id:fnId(), description:'', period:'', qty:1, amount:0 }); renderCreateInvoiceModal(); };
    wireInvoiceItemsEditor(overlay, s);
    overlay.querySelector('#icSave').onclick = ()=> saveInvoiceFromState();
  }});
}

function saveInvoiceFromState(){
  const s = IC_STATE;
  if(!s.projectCode){ toast('Please select a project.', 'error'); return; }
  if(!s.clientName.trim()){ toast('Please enter a client name.', 'error'); return; }
  if(!s.invoiceDate){ toast('Please select an invoice date.', 'error'); return; }
  const proj = DB.find('projects', s.projectCode);
  if(!canCreateInvoiceForProject(proj)){ toast('You do not have permission to create an invoice for this project.', 'error'); return; }

  let existing = s.editingId ? DB.find('invoices', s.editingId) : null;
  if(existing && !canEditInvoice(existing)){ toast('You do not have permission to edit this invoice.', 'error'); return; }

  const invoiceNumber = s.invoiceNumber || existing?.invoiceNumber || generateInvoiceNumber(s.projectCode, s.businessName||s.clientName, s.invoiceDate);
  const record = {
    id: existing ? existing.id : 'INV' + Date.now() + Math.floor(Math.random()*10000),
    invoiceNumber,
    projectCode: s.projectCode, leadId: proj ? proj.leadId : null,
    clientName: s.clientName.trim(), businessName: s.businessName.trim(),
    websiteLink: s.websiteLink.trim(), invoiceDate: s.invoiceDate,
    projectStatus: s.projectStatus, status: s.status, currency: s.currency,
    items: s.items, discountAmount: Number(s.discountAmount)||0,
    summary: s.summary, notes: s.notes,
    assignedSales: s.assignedSales || CURRENT_USER.name,
    createdBy: existing ? existing.createdBy : CURRENT_USER.name,
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
  };
  DB.upsert('invoices', record);
  logActivity({ userName: CURRENT_USER.name, refType:'project', refId: s.projectCode, refLabel:`${s.projectCode} — ${s.businessName||s.clientName}`,
    type: existing ? 'Invoice Updated' : 'Invoice Created',
    description: `${CURRENT_USER.name} ${existing?'updated':'created'} invoice ${invoiceNumber} (${record.status}).` });

  toast(existing ? 'Invoice updated.' : 'Invoice created.', 'success');
  closeModal();
  if(currentRoute()==='invoices') renderInvoicesPage();
  if(currentRoute()==='dashboard') router();
  openInvoiceDetailModal(record.id);
}

/* ---------------------------------------------------------------------- */
/* Invoice Detail                                                         */
/* ---------------------------------------------------------------------- */
function openInvoiceDetailModal(id){
  const inv = DB.find('invoices', id);
  if(!inv){ toast('Invoice not found.', 'error'); return; }
  const totals = invoiceTotals(inv);
  const proj = inv.projectCode ? DB.find('projects', inv.projectCode) : null;
  const payments = invoicePaymentsFor(inv.id);

  const html = `
    <div class="modal-head">
      <div><h3>${escapeHtml(inv.invoiceNumber)}</h3>
        <div class="text-muted" style="font-size:12px;margin-top:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          ${statusBadge(inv.status)}<span>${escapeHtml(inv.clientName)}${inv.businessName?' — '+escapeHtml(inv.businessName):''}</span>
        </div>
      </div>
      <button class="modal-close" id="idClose">&times;</button>
    </div>
    <div class="modal-body">
      <div class="flex-row" style="justify-content:flex-end;margin-bottom:14px;flex-wrap:wrap;gap:8px" id="idActions"></div>

      <div class="pd-keyinfo">
        <div>
          ${infoRow('Project', proj ? `${proj.id} — ${escapeHtml(proj.businessName)}` : (inv.projectCode||'—'))}
          ${infoRow('Invoice Date', fmtDate(inv.invoiceDate))}
          ${infoRow('Website Link', inv.websiteLink||'—')}
        </div>
        <div>
          ${infoRow('Total Amount', money(totals.total))}
          ${infoRow('Total Paid', money(totals.totalPaid))}
          ${infoRow('Balance Due', money(totals.balance))}
        </div>
      </div>

      <div class="pd-sections">
        ${collapsibleSectionHtml('inv-items', `Items (${(inv.items||[]).length})`, invoiceItemsReadonlyHtml(inv))}
        ${collapsibleSectionHtml('inv-summary', 'Invoice Summary', `<p style="font-size:12.5px;white-space:pre-wrap">${escapeHtml(inv.summary||'—')}</p>`)}
        ${collapsibleSectionHtml('inv-notes', 'Notes', `<p style="font-size:12.5px;white-space:pre-wrap">${escapeHtml(inv.notes||'—')}</p>`)}
        ${collapsibleSectionHtml('inv-payments', `Linked Payments (${payments.length})`, invoiceLinkedPaymentsHtml(payments))}
      </div>
    </div>
    <div class="modal-foot"><button class="btn btn-secondary" id="idClose2">Close</button></div>
  `;
  openModal(html, { large:true, onMount:(overlay)=>{
    overlay.querySelector('#idClose').onclick = closeModal;
    overlay.querySelector('#idClose2').onclick = closeModal;
    wireCollapsibleSections(overlay);

    const actionsEl = overlay.querySelector('#idActions');
    const btns = [];
    btns.push(`<button class="btn btn-outline btn-sm" id="iaPreview">Preview</button>`);
    btns.push(`<button class="btn btn-outline btn-sm" id="iaPdf">Download PDF</button>`);
    btns.push(`<button class="btn btn-ghost btn-sm" id="iaDup">Duplicate</button>`);
    if(canEditInvoice(inv)) btns.push(`<button class="btn btn-ghost btn-sm" id="iaEdit">Edit</button>`);
    if(totals.balance>0.004 && inv.status!=='Draft' && inv.status!=='Cancelled') btns.push(`<button class="btn btn-primary btn-sm" id="iaPay">Record Payment</button>`);
    if(inv.status!=='Cancelled' && inv.status!=='Paid' && canCancelInvoice()) btns.push(`<button class="btn btn-danger btn-sm" id="iaCancel">Cancel Invoice</button>`);
    if(canDeleteInvoice()) btns.push(`<button class="btn btn-danger btn-sm" id="iaDelete">Delete</button>`);
    actionsEl.innerHTML = btns.join('');

    overlay.querySelector('#iaPreview').onclick = ()=> openInvoicePreview(inv.id, false);
    overlay.querySelector('#iaPdf').onclick = ()=> openInvoicePreview(inv.id, true);
    overlay.querySelector('#iaDup').onclick = ()=>{ closeModal(); duplicateInvoice(inv.id); };
    const editBtn = overlay.querySelector('#iaEdit');
    if(editBtn) editBtn.onclick = ()=>{ IC_STATE = loadInvoiceStateFrom(inv); renderCreateInvoiceModal(); };
    const payBtn = overlay.querySelector('#iaPay');
    if(payBtn) payBtn.onclick = ()=>{ if(inv.projectCode) openRecordPaymentModal(inv.projectCode, ()=> openInvoiceDetailModal(inv.id), inv.id); };
    const cancelBtn = overlay.querySelector('#iaCancel');
    if(cancelBtn) cancelBtn.onclick = ()=> openCancelInvoiceModal(inv.id);
    const delBtn = overlay.querySelector('#iaDelete');
    if(delBtn) delBtn.onclick = ()=>{
      if(!confirm(`Permanently delete invoice ${inv.invoiceNumber}? This cannot be undone.`)) return;
      DB.remove('invoices', inv.id);
      logActivity({ userName: CURRENT_USER.name, refType:'project', refId: inv.projectCode||inv.id, refLabel: inv.invoiceNumber,
        type:'Invoice Deleted', description:`${CURRENT_USER.name} deleted invoice ${inv.invoiceNumber}.` });
      toast('Invoice deleted.', 'success');
      closeModal();
      if(currentRoute()==='invoices') renderInvoicesPage();
    };
  }});
}

function invoiceItemsReadonlyHtml(inv){
  const items = inv.items||[];
  if(!items.length) return `<p class="text-muted" style="font-size:12.5px;margin:8px 0 0">No line items.</p>`;
  return `
    <div class="table-wrap scroll-x">
      <table class="data-table qc-mini-table">
        <thead><tr><th>No.</th><th>Description</th><th>Timeline / Period</th><th>Qty</th><th>Amount</th></tr></thead>
        <tbody>
          ${items.map((it,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(it.description||'')}</td><td>${escapeHtml(it.period||'—')}</td><td>${it.qty!=null?it.qty:1}</td><td>${money(it.amount)}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}
function invoiceLinkedPaymentsHtml(payments){
  if(!payments.length) return `<p class="text-muted" style="font-size:12.5px;margin:8px 0 0">No payments recorded against this invoice yet.</p>`;
  return `
    <div class="table-wrap scroll-x">
      <table class="data-table">
        <thead><tr><th>Payment #</th><th>Type</th><th>Amount</th><th>Date</th><th>Method</th><th>Recorded By</th></tr></thead>
        <tbody>
          ${payments.map(p=>`<tr><td class="cell-strong">${escapeHtml(p.paymentNumber||'—')}</td><td>${escapeHtml(p.type)}</td><td class="cell-strong">${money(p.amount)}</td><td>${fmtDate(p.date)}</td><td>${escapeHtml(p.method||'—')}</td><td>${escapeHtml(p.recordedBy||'—')}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function openCancelInvoiceModal(id){
  const inv = DB.find('invoices', id);
  if(!inv) return;
  const html = `
    <div class="modal-head"><h3>Cancel Invoice</h3><button class="modal-close" id="ciClose">&times;</button></div>
    <div class="modal-body">
      <p style="margin-top:0">Cancel invoice <b>${escapeHtml(inv.invoiceNumber)}</b>?</p>
      <p class="text-muted" style="font-size:12.5px">A cancelled invoice is excluded from active balance calculations. Any payments already linked to it stay in the ledger untouched — cancelling never deletes or voids a payment.</p>
      <div class="form-field"><label class="required">Reason</label><textarea id="ci_reason" placeholder="e.g. Superseded by a corrected invoice…"></textarea></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="ciCancel">Back</button>
      <button class="btn btn-danger" id="ciConfirm">Cancel Invoice</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#ciClose').onclick = closeModal;
    overlay.querySelector('#ciCancel').onclick = closeModal;
    overlay.querySelector('#ciConfirm').onclick = ()=>{
      const reason = overlay.querySelector('#ci_reason').value.trim();
      if(!reason){ toast('Please provide a reason.', 'error'); return; }
      inv.status = 'Cancelled';
      DB.upsert('invoices', inv);
      logActivity({ userName: CURRENT_USER.name, refType:'project', refId: inv.projectCode||inv.id, refLabel: inv.invoiceNumber,
        type:'Invoice Cancelled', description:`${CURRENT_USER.name} cancelled invoice ${inv.invoiceNumber}. Reason: ${reason}` });
      toast('Invoice cancelled.', 'success');
      closeModal();
      if(currentRoute()==='invoices') renderInvoicesPage();
      openInvoiceDetailModal(inv.id);
    };
  }});
}

/* ---------------------------------------------------------------------- */
/* Project Detail integration (spec §9)                                   */
/* ---------------------------------------------------------------------- */
function linkedInvoicesHtml(projectId){
  const list = DB.all('invoices').filter(i=> i.projectCode===projectId);
  return `
    <div class="flex-row" style="justify-content:space-between;margin-bottom:8px">
      <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin:0">Invoices</div>
      <span class="cell-link" style="font-size:12px" data-new-invoice="${projectId}">+ Create Invoice</span>
    </div>
    ${list.length ? `
    <div class="table-wrap scroll-x">
      <table class="data-table qc-mini-table">
        <thead><tr><th>Invoice No.</th><th>Date</th><th>Total</th><th>Paid</th><th>Balance</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>
          ${list.map(inv=>{
            const t = invoiceTotals(inv);
            return `<tr>
              <td class="cell-strong">${escapeHtml(inv.invoiceNumber)}</td>
              <td>${fmtDate(inv.invoiceDate)}</td>
              <td>${money(t.total)}</td>
              <td>${money(t.totalPaid)}</td>
              <td>${money(t.balance)}</td>
              <td>${statusBadge(inv.status)}</td>
              <td><div class="flex-row" style="gap:2px">
                <button class="btn btn-ghost btn-sm" data-view-invoice="${inv.id}">View</button>
                <button class="btn btn-ghost btn-sm" data-pdf-invoice="${inv.id}">PDF</button>
              </div></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>` : `<div class="empty-row">No invoices yet.</div>`}
  `;
}
function wireLinkedInvoices(container){
  container.querySelectorAll('[data-view-invoice]').forEach(el=> el.onclick = ()=> openInvoiceDetailModal(el.dataset.viewInvoice));
  container.querySelectorAll('[data-pdf-invoice]').forEach(el=> el.onclick = ()=> openInvoicePreview(el.dataset.pdfInvoice, true));
  const newBtn = container.querySelector('[data-new-invoice]');
  if(newBtn) newBtn.onclick = ()=> openCreateInvoiceModal({ projectCode: newBtn.dataset.newInvoice });
}

/* ---------------------------------------------------------------------- */
/* PDF / Print — reuses the Quotations A4 pagination engine verbatim       */
/* (measureQuoteDoc / packQuoteSections / renderQuotePagesHtml /           */
/* printQuoteDocFromContainer, all defined in js/quotations.js and         */
/* completely content-agnostic) — only the section content below is new.  */
/* ---------------------------------------------------------------------- */
function invoiceInfoRows(inv, proj){
  const rows = [
    `<tr><th>${bilingualLabel('ឈ្មោះអតិថិជន','Client Name')}</th><td>${escapeHtml(inv.clientName)}</td></tr>`,
  ];
  if(inv.businessName && String(inv.businessName).trim()){
    rows.push(`<tr><th>${bilingualLabel('ឈ្មោះអាជីវកម្ម','Business Name')}</th><td>${escapeHtml(inv.businessName)}</td></tr>`);
  }
  rows.push(`<tr><th>${bilingualLabel('គម្រោង','Project')}</th><td>${escapeHtml(inv.projectCode||'—')}${proj?' — '+escapeHtml(serviceDisplayName(proj.projectType)):''}</td></tr>`);
  rows.push(`<tr><th>${bilingualLabel('កាលបរិច្ឆេទ','Date')}</th><td>${fmtDate(inv.invoiceDate)}</td></tr>`);
  if(inv.websiteLink) rows.push(`<tr><th>Website</th><td>${escapeHtml(inv.websiteLink)}</td></tr>`);
  return rows.join('');
}

function invoiceFullHeaderHtml(inv){
  return `<div class="quote-doc-head">
    <div class="quote-doc-brand">
      <img class="quote-doc-logo" src="../assets/branding/bizweb-kh-logo-main-print.png" alt="BizWeb KH">
      <div class="text-muted" style="font-size:11px">Tel: 017 400 044 | Telegram: @BizWebKH | www.bizwebkh.com</div>
    </div>
    <div class="quote-doc-meta">
      <div class="khmer-text" style="font-size:13px;color:var(--blue)">វិក្កយបត្រ</div>
      <div><b>INVOICE</b> ${statusBadge(inv.status)}</div>
      <div>Invoice No: ${escapeHtml(inv.invoiceNumber)}</div>
    </div>
  </div>`;
}
function invoiceContHeaderHtml(inv){
  return `<div class="quote-doc-cont-head"><b>BizWeb KH</b> — INVOICE · Invoice No: ${escapeHtml(inv.invoiceNumber)}</div>`;
}

function buildInvoiceSections(inv){
  const bank = bankDetails();
  const proj = inv.projectCode ? DB.find('projects', inv.projectCode) : null;
  const totals = invoiceTotals(inv);
  const sections = [];

  sections.push({ id:'info', kind:'block', html:`<table class="quote-doc-infotable">${invoiceInfoRows(inv, proj)}</table>` });

  sections.push({ id:'summary', kind:'block',
    html:`<h4 class="quote-doc-h">Invoice Summary</h4><p style="font-size:12.5px;margin:0;white-space:pre-wrap">${escapeHtml(inv.summary||'—')}</p>` });

  sections.push({ id:'items', kind:'group',
    headingHtml:`<h4 class="quote-doc-h">Items</h4>`,
    contHeadingHtml:`<h4 class="quote-doc-h">Items (continued)</h4>`,
    wrapOpenHtml:`<table class="quote-doc-table"><thead><tr><th>No.</th><th>Description</th><th>Timeline / Period</th><th>Qty</th><th>Amount</th></tr></thead><tbody>`,
    wrapCloseHtml:`</tbody></table>`,
    items: (inv.items||[]).length ? (inv.items||[]).map((it,i)=>({ html:`<tr><td>${i+1}</td><td>${escapeHtml(it.description||'')}</td><td>${escapeHtml(it.period||'—')}</td><td>${it.qty!=null?it.qty:1}</td><td>${money(it.amount)}</td></tr>` }))
      : [{ html:`<tr><td colspan="5" style="text-align:center;color:var(--muted)">No line items.</td></tr>` }],
  });

  sections.push({ id:'notes', kind:'block',
    html: inv.notes ? `<h4 class="quote-doc-h">Notes</h4><p style="font-size:12.5px;margin:0;white-space:pre-wrap">${escapeHtml(inv.notes)}</p>` : '' });

  sections.push({ id:'totals', kind:'block',
    html:`<table class="quote-doc-table qc-mini-table" style="max-width:340px;margin-left:auto">
      <tbody>
        <tr><td>Subtotal</td><td style="text-align:right">${money(totals.subtotal)}</td></tr>
        ${totals.discount>0 ? `<tr><td>Discount / Promotion</td><td style="text-align:right">-${money(totals.discount)}</td></tr>` : ''}
        <tr><td><b>Total Amount</b></td><td style="text-align:right"><b>${money(totals.total)}</b></td></tr>
        <tr><td>Total Paid</td><td style="text-align:right;color:var(--green)">${money(totals.totalPaid)}</td></tr>
        <tr><td><b>Balance Due</b></td><td style="text-align:right"><b>${money(totals.balance)}</b></td></tr>
      </tbody>
    </table>` });

  const bankDetailRows = [
    `<div><b>Account Name:</b> ${escapeHtml(bank.accountName)}</div>`,
    `<div><b>Account Number:</b> ${escapeHtml(bank.accountNumber)}</div>`,
    `<div><b>Bank Name:</b> ${escapeHtml(bank.bankName)}</div>`,
    bank.memo ? `<div><b>Memo:</b> ${escapeHtml(bank.memo)}</div>` : '',
  ].join('');
  const qrHtml = bank.qrImageUrl ? `
      <div class="quote-doc-qr-title">KHQR</div>
      <div class="quote-doc-qr-frame"><img class="quote-doc-qr-img" src="${escapeHtml(bank.qrImageUrl)}" alt="KHQR Payment QR Code" width="180" height="180"></div>
      <div class="quote-doc-qr-caption">Scan to Pay</div>
      <div class="quote-doc-qr-help">Scan with your preferred banking app.</div>` : '';
  if(totals.balance > 0.004){
    sections.push({ id:'bank', kind:'block',
      html:`<h4 class="quote-doc-h">Payment Bank Details</h4><div class="quote-doc-bankbox">
        <div class="quote-doc-bankbox-details">
          <div class="quote-doc-bankbox-label">Bank Details</div>
          ${bankDetailRows}
        </div>
        ${qrHtml ? `<div class="quote-doc-bankbox-qr">${qrHtml}</div>` : ''}
      </div>` });
  }

  sections.push({ id:'accept', kind:'block',
    html:`<div class="quote-doc-accept">
      <div class="quote-doc-accept-client">
        <div class="sig-line"></div>
        <span>Client Signature</span>
      </div>
      <div class="quote-doc-accept-rep">
        <img class="quote-doc-accept-sig" src="../assets/signature/chhean-poli-signature.png" alt="Authorized Signature" width="194" height="68">
        <div class="sig-line"></div>
        <span>BizWeb KH Representative</span>
      </div>
    </div>` });

  return sections.filter(sec=> sec.kind!=='block' || sec.html);
}

async function buildInvoicePagesHtml(inv){
  try{ if(document.fonts && document.fonts.ready) await document.fonts.ready; }catch(e){}
  const sections = buildInvoiceSections(inv);
  const headerFullHtml = invoiceFullHeaderHtml(inv);
  const headerContHtml = invoiceContHeaderHtml(inv);
  const { measured, headerFullHeight, headerContHeight } = measureQuoteDoc(sections, headerFullHtml, headerContHtml);
  const pageContentHeightPx = qdocMm(QDOC_PAGE_H_MM - 2*QDOC_MARGIN_MM);
  const firstBudget = pageContentHeightPx - headerFullHeight;
  const contBudget = pageContentHeightPx - headerContHeight;
  const pages = packQuoteSections(measured, { firstBudget, contBudget });
  const html = `<div class="quote-pages-wrap">${renderQuotePagesHtml(pages, inv, headerFullHtml, headerContHtml)}</div>`;
  return { html, pageCount: pages.length };
}

let INV_PREVIEW_TOKEN = 0;
async function paintInvoicePreview(containerEl, inv, onDone){
  const token = ++INV_PREVIEW_TOKEN;
  const { html, pageCount } = await buildInvoicePagesHtml(inv);
  if(token !== INV_PREVIEW_TOKEN) return;
  if(!containerEl || !document.body.contains(containerEl)) return;
  containerEl.innerHTML = html;
  if(onDone) onDone(pageCount);
}

function openInvoicePreview(id, autoPrint=false){
  const inv = DB.find('invoices', id);
  if(!inv) return;
  const html = `
    <div class="modal-head"><h3>Invoice Preview</h3><span id="ipPageCount" class="text-muted" style="font-size:12px;margin-left:8px"></span><button class="modal-close" id="ipClose">&times;</button></div>
    <div class="modal-body" style="background:#eef1f6;padding:20px" id="ipPreviewBody">
      <div class="text-muted" style="padding:60px;text-align:center">Rendering preview…</div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="ipClose2">Close</button>
      <button class="btn btn-primary" id="ipPrint" disabled>Download PDF (Print)</button>
    </div>
  `;
  openModal(html, { large:true, onMount:(overlay)=>{
    overlay.querySelector('#ipClose').onclick = closeModal;
    overlay.querySelector('#ipClose2').onclick = closeModal;
    const body = overlay.querySelector('#ipPreviewBody');
    const printBtn = overlay.querySelector('#ipPrint');
    printBtn.onclick = ()=> printQuoteDocFromContainer(body);
    paintInvoicePreview(body, inv, (pageCount)=>{
      printBtn.disabled = false;
      const pc = overlay.querySelector('#ipPageCount');
      if(pc) pc.textContent = `${pageCount} page${pageCount===1?'':'s'}`;
      if(autoPrint) printQuoteDocFromContainer(body);
    });
  }});
}
