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

// Invoice Type — which stage of the project's own Payment Schedule (built by
// Quotations, computePaymentSchedule() in data.js — never recomputed here)
// this invoice represents. 'Custom' is always available as an escape hatch
// for anything that doesn't map cleanly to a stage (spec: Create Invoice
// redesign §4/§5).
const INVOICE_TYPES = ['Deposit', 'Progress', 'Final', 'Custom'];
const INVOICE_TYPE_LABELS = { Deposit:'Deposit / First Payment', Progress:'Progress / Second Payment', Final:'Final Payment', Custom:'Custom Invoice' };

/* ---------------------------------------------------------------------- */
/* Project Payment Schedule lookup (spec §3/§4/§5/§12/§14-16) — an invoice  */
/* NEVER invents or recomputes a schedule: it reads the exact same          */
/* `paymentSchedule` (label/pct/amount, already summing to the project's    */
/* Year 1 Total) already built by computePaymentSchedule() in data.js and   */
/* stored on the project's own quotation record. A 2-stage (30/70) schedule */
/* naturally yields Deposit+Final only; a 3-stage (20/40/40 etc.) schedule   */
/* naturally yields Deposit+Progress+Final — nothing hardcoded per preset.  */
/* ---------------------------------------------------------------------- */
function projectQuotationFor(projectCode){
  if(!projectCode) return null;
  const quotes = DB.all('quotations').filter(q=> q.projectCode===projectCode && q.status!=='Superseded');
  return quotes.find(x=>x.status==='Accepted') || quotes.find(x=>x.status==='Sent') || quotes[0] || null;
}
// Returns { schedule:[{label,pct,amount}], total } for the project — schedule
// is [] (Custom-only) when the project has no usable quotation to read a
// schedule from, e.g. a manually-created project with no quotation on file.
function projectPaymentScheduleFor(projectCode){
  const proj = projectCode ? DB.find('projects', projectCode) : null;
  const q = projectQuotationFor(projectCode);
  const total = proj ? (Number(proj.confirmedValue)||0) : 0;
  if(q && Array.isArray(q.paymentSchedule) && q.paymentSchedule.length){
    return { schedule: q.paymentSchedule.map(s=>({...s})), total };
  }
  return { schedule: [], total };
}
// Maps each stage in the schedule to an Invoice Type key: first stage is
// always Deposit, last is always Final, anything in between is Progress —
// this is what makes a 2-stage schedule show only Deposit+Final (no
// "Progress" option ever appears) and a 3-stage schedule show all three,
// with zero hardcoded assumptions about preset names (spec §5).
function invoiceStageOptionsFor(projectCode){
  const { schedule } = projectPaymentScheduleFor(projectCode);
  const n = schedule.length;
  const opts = schedule.map((st,i)=>{
    const key = i===0 ? 'Deposit' : (i===n-1 ? 'Final' : 'Progress');
    return { key, index:i, label: st.label, pct: st.pct, amount: st.amount };
  });
  opts.push({ key:'Custom', index:null, label:'Custom Invoice', pct:null, amount:null });
  return opts;
}
function invoiceStageOption(projectCode, typeKey){
  return invoiceStageOptionsFor(projectCode).find(o=>o.key===typeKey) || null;
}

/* ---------------------------------------------------------------------- */
/* Payment-stage-aware wording (spec §10/§22) — small template functions,   */
/* keyed on Invoice Type + whether a payment is already linked/recorded.    */
/* Auto-suggested only: always freely editable afterward (icState._summaryTouched */
/* / _notesTouched guard which fields get re-suggested vs left alone).      */
/* ---------------------------------------------------------------------- */
function icDefaultSummary(s, breakdown){
  const name = s.businessName || s.clientName || 'the client';
  const amt = money(breakdown.currentAmount);
  const already = breakdown.thisInvoicePaidActual > 0.004;
  if(s.invoiceType==='Deposit'){
    return already
      ? `This invoice confirms receipt of the deposit payment of ${amt} for the ${name} project, securing the project start as outlined in the item breakdown below.`
      : `This invoice covers the deposit payment of ${amt} required to begin the ${name} project, as outlined in the item breakdown below.`;
  }
  if(s.invoiceType==='Progress'){
    return `This invoice covers the progress payment of ${amt} for the ${name} project, reflecting work completed to date as outlined in the item breakdown below.`;
  }
  if(s.invoiceType==='Final'){
    return `This invoice covers the final payment of ${amt} for the ${name} project, completing the total project value upon settlement, as outlined in the item breakdown below.`;
  }
  const paidSoFar = breakdown.thisInvoicePaidActual;
  const phrase = paidSoFar > 0.004 ? 'partial payment received' : 'payment due';
  return `This invoice confirms the ${phrase} for the ${name} project, as outlined in the item breakdown below.`;
}
function icDefaultNotes(s){
  if(s.invoiceType==='Deposit'){
    return `- This deposit confirms your project booking and secures the start date.\n- Work begins once the deposit payment is received and confirmed.\n- Remaining balance is due per the payment schedule agreed in your quotation.`;
  }
  if(s.invoiceType==='Progress'){
    return `- This progress payment reflects work completed to date on the project.\n- Remaining stage(s) remain due per the payment schedule agreed in your quotation.`;
  }
  if(s.invoiceType==='Final'){
    return `- This is the final payment for the project as agreed in your quotation.\n- Project deliverables are handed over/considered complete once this payment is received and confirmed.`;
  }
  return '';
}

/* ---------------------------------------------------------------------- */
/* Payment Status (display-only, spec §11) — DERIVED from the real          */
/* Invoice Status + Invoice Type + real linked-payment totals. Never a      */
/* stored field, so it can never drift from the real state machine above.  */
/* ---------------------------------------------------------------------- */
function invoicePaymentDisplayStatus(inv, totals){
  const EPS = 0.005;
  if(inv.status==='Draft') return 'Draft';
  if(inv.status==='Cancelled') return 'Cancelled';
  if(totals.totalPaid <= EPS) return 'Payment Pending';
  if(totals.balance > EPS) return 'Partially Paid';
  // This invoice's own face amount is fully covered by real payments.
  const projFullyPaid = inv.projectCode && paymentSummaryFor(inv.projectCode).status==='Fully Paid';
  if(inv.invoiceType==='Final' || projFullyPaid) return 'Fully Paid';
  if(inv.invoiceType==='Deposit') return 'Deposit Paid';
  if(inv.invoiceType==='Progress') return 'Progress Payment Paid';
  return 'Fully Paid';
}

/* ---------------------------------------------------------------------- */
/* Payment breakdown — the ONE computation shared by the live Create form   */
/* (a PROJECTION — nothing has been saved/paid yet) and a saved invoice's   */
/* preview/print/detail (REAL numbers from actual linked-payment history).  */
/* "Total Paid After This Payment" on the form is explicitly a projection   */
/* label — an issued-but-unpaid invoice is never displayed as already paid. */
/* ---------------------------------------------------------------------- */
// `excludeInvoiceId` — when editing/previewing an invoice that may already
// have real payments linked to IT, its own payments are excluded from
// "Previously Paid" (they belong in "Current Invoice"/"This Invoice Paid"
// instead) so nothing is ever double-counted (spec §18/TEST C).
function projectPreviouslyPaid(projectCode, excludeInvoiceId){
  if(!projectCode) return 0;
  return paymentsForProject(projectCode)
    .filter(p=> !excludeInvoiceId || p.invoiceId !== excludeInvoiceId)
    .reduce((s,p)=> s + (Number(p.amount)||0), 0);
}
// For the live Create/Edit form — s.items/discountAmount may still be
// unsaved edits, so "Current Invoice Amount" is computed from THOSE, exactly
// like the existing subtotal/discount math already did, not re-derived from
// the stage table (auto-calc from a stage just pre-fills those same items).
function icComputeBreakdown(s){
  const proj = s.projectCode ? DB.find('projects', s.projectCode) : null;
  const { schedule } = projectPaymentScheduleFor(s.projectCode);
  const projectTotal = proj ? (Number(proj.confirmedValue)||0) : 0;
  const previouslyPaid = projectPreviouslyPaid(s.projectCode, s.editingId);
  const subtotal = (s.items||[]).reduce((sum,it)=> sum + (Number(it.qty)||1)*(Number(it.amount)||0), 0);
  const currentAmount = Math.max(0, Math.round((subtotal - (Number(s.discountAmount)||0))*100)/100);
  const thisInvoicePaidActual = s.editingId ? invoiceTotals({ id:s.editingId, items:s.items, discountAmount:s.discountAmount }).totalPaid : 0;
  const projectedTotalPaidAfter = Math.round((previouslyPaid + currentAmount)*100)/100;
  const remainingAfter = Math.max(0, Math.round((projectTotal - projectedTotalPaidAfter)*100)/100);
  return { proj, schedule, projectTotal, previouslyPaid, currentAmount, thisInvoicePaidActual, projectedTotalPaidAfter, remainingAfter };
}
// For a SAVED invoice (detail/preview/PDF/print) — every figure here is real
// (actual linked payments), never a projection.
function invoicePaymentBreakdown(inv){
  const totals = invoiceTotals(inv);
  const proj = inv.projectCode ? DB.find('projects', inv.projectCode) : null;
  const { schedule } = projectPaymentScheduleFor(inv.projectCode);
  const projectTotal = proj ? (Number(proj.confirmedValue)||0) : totals.total;
  const previouslyPaid = projectPreviouslyPaid(inv.projectCode, inv.id);
  const totalPaidAfter = Math.round((previouslyPaid + totals.totalPaid)*100)/100;
  const balanceAfter = Math.max(0, Math.round((projectTotal - totalPaidAfter)*100)/100);
  return { totals, schedule, projectTotal, previouslyPaid, totalPaidAfter, balanceAfter };
}

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
                <th>Invoice No.</th><th>Type</th><th>Date</th><th>Project Code</th><th>Client / Business</th>
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
                  <td>${escapeHtml(INVOICE_TYPE_LABELS[inv.invoiceType]||inv.invoiceType||'Custom Invoice')}</td>
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
              }).join('') : `<tr><td colspan="11"><div class="empty-row">No invoices match the current filters.</div></td></tr>`}
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
/* Create / Edit Invoice — split-screen layout matching Create Quotation's  */
/* Edit/Preview pattern exactly (renderCreateQuotationModal in                */
/* js/quotations.js is the structural template this mirrors — same          */
/* .qc-split/.qc-edit-col/.qc-preview-col/.qc-preview-toolbar/.qc-zoom-      */
/* controls/.qc-preview-canvas/.qc-a4-scale classes, same modal-xl shell,    */
/* same "remount vs refresh-only" split). Nothing about the underlying       */
/* invoice data model, status-transition function, or payment-linking below */
/* this section changed — only the create/edit UI was rebuilt.              */
/* ---------------------------------------------------------------------- */
let IC_STATE = null;
let IC_TAB = 'edit'; // 'edit' | 'preview' — narrow screens only, mirrors QC_TAB
let IC_ZOOM = 'fit';  // 'fit' or a literal scale factor — mirrors QC_ZOOM
const IC_A4_PAGE_WIDTH_PX = 794; // same physical-page-width constant as Quotations

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
    projectLocked: !!prefill.projectCode, // entered from Project Detail (spec §20) — skip project search
    projectCode: proj ? proj.id : '',
    clientName: proj ? proj.clientName : '',
    businessName: proj ? proj.businessName : '',
    websiteLink: '',
    invoiceDate: todayLocalISO(),
    dueDate: '',
    projectStatus: proj ? proj.stage : '',
    status: 'Draft',
    currency: 'USD',
    invoiceType: 'Custom',
    paymentStageIndex: null,
    items: proj ? invoiceItemsFromProjectScope(proj.id) : [],
    discountAmount: 0,
    summary: '',
    notes: '',
    assignedSales: CURRENT_USER.name,
    _summaryTouched: false,
    _notesTouched: false,
  };
  IC_TAB = 'edit';
  // A project handed in up front (Project Detail's own "+ Create Invoice")
  // gets the exact same auto-detect-stage treatment as picking it from the
  // dropdown (spec §20: "preselect that project" means fully applied, not
  // just filled into the field).
  if(proj) icApplyProject(proj.id);
  renderCreateInvoiceModal();
}

function loadInvoiceStateFrom(inv, { asDuplicate=false } = {}){
  return {
    editingId: asDuplicate ? null : inv.id,
    invoiceNumber: asDuplicate ? null : inv.invoiceNumber,
    projectLocked: false,
    projectCode: inv.projectCode || '',
    clientName: inv.clientName, businessName: inv.businessName || '',
    websiteLink: inv.websiteLink || '',
    invoiceDate: asDuplicate ? todayLocalISO() : inv.invoiceDate,
    dueDate: asDuplicate ? '' : (inv.dueDate || ''),
    projectStatus: inv.projectStatus || '',
    status: asDuplicate ? 'Draft' : inv.status,
    currency: inv.currency || 'USD',
    invoiceType: inv.invoiceType || 'Custom',
    paymentStageIndex: asDuplicate ? null : (inv.paymentStageIndex!=null ? inv.paymentStageIndex : null),
    items: (inv.items||[]).map(it=>({ ...it, id: asDuplicate ? fnId() : (it.id||fnId()) })),
    discountAmount: Number(inv.discountAmount)||0,
    summary: inv.summary || '',
    notes: inv.notes || '',
    assignedSales: inv.assignedSales || CURRENT_USER.name,
    // Existing text is real content someone wrote — never overwrite it just
    // because the modal reopened (spec §10/§22 "keep editable... never
    // clobber user edits").
    _summaryTouched: !!(inv.summary && inv.summary.trim()),
    _notesTouched: !!(inv.notes && inv.notes.trim()),
  };
}

function duplicateInvoice(id){
  const src = DB.find('invoices', id);
  if(!src) return;
  IC_STATE = loadInvoiceStateFrom(src, { asDuplicate:true });
  IC_TAB = 'edit';
  renderCreateInvoiceModal();
}

function icAssignableProjects(){
  const all = DB.all('projects');
  if(isFounder() || CURRENT_USER.role==='partner_operations') return all;
  return all.filter(p=> p.assignedSales===CURRENT_USER.name);
}

// Applies a selected project AND auto-detects its real payment schedule
// (spec §3/§4/§5) — Invoice Type resets to whatever the first available
// stage is (or stays Custom if the project has no usable schedule), so
// switching projects never leaves a stale/impossible stage selected.
function icApplyProject(projectCode){
  const proj = DB.find('projects', projectCode);
  if(!proj) return;
  const s = IC_STATE;
  s.projectCode = proj.id;
  s.clientName = proj.clientName;
  s.businessName = proj.businessName;
  s.projectStatus = proj.stage;
  if(!s.editingId && !s.items.length) s.items = invoiceItemsFromProjectScope(proj.id);
  const opts = invoiceStageOptionsFor(proj.id).filter(o=>o.key!=='Custom');
  // Prefer the next stage that doesn't already have a live (non-Cancelled)
  // invoice against it — a natural "what's next" default, never a hard
  // requirement (Custom stays freely selectable regardless).
  const nextOpen = opts.find(o=> !DB.all('invoices').some(i=> i.projectCode===proj.id && i.paymentStageIndex===o.index && i.status!=='Cancelled'));
  icApplyInvoiceType((nextOpen||opts[0]||{key:'Custom'}).key);
}

// The core new stage-aware logic (spec §4/§5/§10/§22): selecting a type
// (or Custom) auto-fills the amount from the project's real schedule via the
// existing items array — no new "amount" field invented — and auto-suggests
// wording, without ever clobbering text the user already typed themselves.
function icApplyInvoiceType(typeKey){
  const s = IC_STATE;
  s.invoiceType = typeKey;
  if(typeKey==='Custom'){
    s.paymentStageIndex = null;
  } else {
    const opt = invoiceStageOption(s.projectCode, typeKey);
    if(opt && opt.index!=null){
      s.paymentStageIndex = opt.index;
      s.items = [{ id: fnId(), description: `${opt.label}${s.businessName?' — '+s.businessName:''}`, period:'', qty:1, amount: opt.amount }];
      s.discountAmount = 0;
    }
  }
  const breakdown = icComputeBreakdown(s);
  if(!s._summaryTouched) s.summary = icDefaultSummary(s, breakdown);
  if(!s._notesTouched && !s.notes.trim()) s.notes = icDefaultNotes(s);
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

// Adapts the live Create/Edit form state into an invoice-shaped object so
// the SAME renderer used for a saved invoice's preview/PDF (buildInvoiceSections
// / buildInvoicePagesHtml / paintInvoicePreview, all below) can be reused for
// the live preview pane too — exactly the qcStateToPreviewQuotation pattern
// (spec §23: one render path, never a second print template).
function icStateToPreviewInvoice(s){
  return {
    id: s.editingId || '__ic_preview__',
    invoiceNumber: icInvoiceNumberPreview(s),
    projectCode: s.projectCode, leadId: null,
    clientName: s.clientName, businessName: s.businessName,
    websiteLink: s.websiteLink, invoiceDate: s.invoiceDate, dueDate: s.dueDate,
    projectStatus: s.projectStatus, status: s.status, currency: s.currency,
    invoiceType: s.invoiceType, paymentStageIndex: s.paymentStageIndex,
    items: s.items, discountAmount: Number(s.discountAmount)||0,
    summary: s.summary, notes: s.notes,
    assignedSales: s.assignedSales, createdBy: CURRENT_USER.name, createdAt: new Date().toISOString(),
  };
}

function renderCreateInvoiceModal(){
  // Mirrors Quotations' own scroll-preserving remount (spec §12/§13 parity):
  // a handful of edits (project pick, invoice type, add/remove row, tab
  // switch, zoom) still fully remount, so the left panel's scroll position
  // is captured here and restored once the new DOM mounts.
  const prevOverlay = document.getElementById('activeModalOverlay');
  const prevScrollTop = prevOverlay ? (prevOverlay.querySelector('.qc-edit-col')||{}).scrollTop : null;

  const s = IC_STATE;
  const projects = icAssignableProjects();
  const breakdown = icComputeBreakdown(s);
  const stageOpts = s.projectCode ? invoiceStageOptionsFor(s.projectCode) : [{ key:'Custom', index:null, label:'Custom Invoice', pct:null, amount:null }];

  const html = `
    <div class="modal-head">
      <h3>${s.editingId?'Edit Invoice':'Create Invoice'}</h3>
      <div class="qc-tabs">
        <div class="tab-btn ${IC_TAB==='edit'?'active':''}" data-ictab="edit">Edit</div>
        <div class="tab-btn ${IC_TAB==='preview'?'active':''}" data-ictab="preview">Preview</div>
      </div>
      <button class="modal-close" id="icClose">&times;</button>
    </div>
    <div class="modal-body qc-modal-body">
      <div class="qc-split">
        <div class="qc-edit-col" ${IC_TAB!=='edit'?'data-hide-narrow="1"':''}>

          <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">A. Project Information</div>
          <div class="form-grid">
            <div class="form-field full"><label class="required">Project</label>
              ${s.projectLocked
                ? `<input value="${escapeHtml(s.projectCode)} — ${escapeHtml(s.businessName)}" readonly class="field-locked">`
                : `<select id="ic_project">
                    <option value="">— Select a project —</option>
                    ${projects.map(p=>`<option value="${p.id}" ${s.projectCode===p.id?'selected':''}>${p.id} — ${escapeHtml(p.businessName)}</option>`).join('')}
                  </select>`}
            </div>
            <div class="form-field"><label class="required">Client Name</label><input id="ic_client" value="${escapeHtml(s.clientName)}"></div>
            <div class="form-field"><label>Business Name</label><input id="ic_business" value="${escapeHtml(s.businessName)}"></div>
            <div class="form-field full"><label>Website Link</label><input id="ic_website" value="${escapeHtml(s.websiteLink)}" placeholder="https://…"></div>
            <div class="form-field"><label>Project Value</label><input value="${breakdown.proj?money(breakdown.projectTotal):'—'}" disabled></div>
            <div class="form-field"><label>Project Status</label>
              <select id="ic_pstatus">${PROJECT_STAGES.map(st=>`<option ${s.projectStatus===st?'selected':''}>${st}</option>`).join('')}</select>
            </div>
            <div class="form-field"><label>Existing Payments</label><input value="${money(breakdown.previouslyPaid)}" disabled></div>
            <div class="form-field"><label>Outstanding Balance</label><input value="${breakdown.proj?money(Math.max(0,Math.round((breakdown.projectTotal-breakdown.previouslyPaid)*100)/100)):'—'}" disabled></div>
          </div>
          ${breakdown.schedule.length ? `
          <p class="text-muted" style="font-size:11.5px;margin:8px 0 0">Existing Payment Schedule: ${breakdown.schedule.map(st=>`${escapeHtml(st.label)} ${st.pct}% (${money(st.amount)})`).join(' · ')}</p>
          ` : (s.projectCode ? `<p class="text-muted" style="font-size:11.5px;margin:8px 0 0">No payment schedule found on file for this project — only Custom Invoice is available.</p>` : '')}

          <div class="divider"></div>
          <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">B. Invoice Type / Payment Stage</div>
          <div class="form-grid">
            <div class="form-field full"><label class="required">Invoice Type</label>
              <select id="ic_type">
                ${stageOpts.map(o=>`<option value="${o.key}" ${s.invoiceType===o.key?'selected':''}>${escapeHtml(INVOICE_TYPE_LABELS[o.key]||o.label)}${o.amount!=null?` — ${money(o.amount)}`:''}</option>`).join('')}
              </select>
            </div>
            <div class="form-field"><label>Invoice No. <span class="field-auto-badge">Auto</span></label>
              <input id="ic_invnum" value="${escapeHtml(icInvoiceNumberPreview(s))}" ${(!isFounder() || (s.editingId && !INVOICE_CREATE_STATUSES.includes(s.status)))?'readonly class="field-locked"':''}>
            </div>
            <div class="form-field"><label class="required">Invoice Date</label><input type="date" id="ic_date" value="${s.invoiceDate}"></div>
            <div class="form-field"><label>Payment Due Date <span class="text-muted" style="font-weight:400">(optional)</span></label><input type="date" id="ic_due" value="${s.dueDate||''}"></div>
            <div class="form-field"><label>Invoice Status</label>
              <select id="ic_status" ${s.editingId && !INVOICE_CREATE_STATUSES.includes(s.status) ? 'disabled' : ''}>
                ${INVOICE_CREATE_STATUSES.map(st=>`<option ${s.status===st?'selected':''}>${st}</option>`).join('')}
              </select>
              ${s.editingId && !INVOICE_CREATE_STATUSES.includes(s.status) ? `<p class="text-muted" style="font-size:11px;margin:4px 0 0">Current status (${escapeHtml(s.status)}) is driven automatically by recorded payments — issuing never marks an invoice Paid on its own.</p>` : ''}
            </div>
            <div class="form-field"><label>Currency</label>
              <select id="ic_currency"><option ${s.currency==='USD'?'selected':''}>USD</option><option ${s.currency==='KHR'?'selected':''}>KHR</option></select>
            </div>
          </div>

          <div class="divider"></div>
          <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">Payment Summary</div>
          <div class="form-grid">
            <div class="form-field"><label>Project Total</label><input value="${money(breakdown.projectTotal)}" disabled></div>
            <div class="form-field"><label>Previously Paid</label><input value="${money(breakdown.previouslyPaid)}" disabled></div>
            <div class="form-field"><label>Current Invoice Amount</label><input value="${money(breakdown.currentAmount)}" disabled></div>
            <div class="form-field"><label>Total Paid After This Payment <span class="text-muted" style="font-weight:400">(projected)</span></label><input value="${money(breakdown.projectedTotalPaidAfter)}" disabled></div>
            <div class="form-field"><label>Remaining Balance</label><input value="${money(breakdown.remainingAfter)}" disabled></div>
          </div>
          <p class="text-muted" style="font-size:11px;margin:6px 0 0">"Total Paid After This Payment" is a projection — it assumes this invoice gets paid in full. Only real recorded/linked payments ever count as actually paid.</p>

          <div class="divider"></div>
          <div class="flex-row" style="justify-content:space-between;margin-bottom:8px">
            <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin:0">C. Invoice Items</div>
            <span class="cell-link" style="font-size:12px" id="ic_addRow">+ Add Row</span>
          </div>
          <div id="ic_itemsWrap">${invoiceItemsEditorHtml(s.items, s.currency)}</div>
          <div class="form-field" style="margin-top:10px;max-width:220px"><label>Discount / Promotion ($)</label><input type="number" min="0" step="0.01" id="ic_discount" value="${s.discountAmount||0}"></div>

          <div class="divider"></div>
          <div class="form-field full"><label>Invoice Summary</label><textarea id="ic_summary" rows="3">${escapeHtml(s.summary)}</textarea></div>
          <div class="form-field full"><label>Notes</label><textarea id="ic_notes" rows="4" placeholder="e.g. Hosting/domain included, remaining balance details, extra features quoted separately…">${escapeHtml(s.notes)}</textarea></div>
        </div>

        <div class="qc-preview-col" ${IC_TAB!=='preview'?'data-hide-narrow="1"':''}>
          <div class="qc-preview-toolbar">
            <span class="qc-preview-toolbar-title">Invoice Preview</span>
            <div class="qc-zoom-controls">
              <button class="btn btn-ghost btn-sm ${IC_ZOOM==='fit'?'active':''}" data-iczoom="fit" title="Fit to panel width">Fit</button>
              <button class="btn btn-ghost btn-sm ${IC_ZOOM===1?'active':''}" data-iczoom="100" title="Actual size">100%</button>
              <button class="btn btn-ghost btn-sm" data-iczoom="out" title="Zoom out">&minus;</button>
              <button class="btn btn-ghost btn-sm" data-iczoom="in" title="Zoom in">+</button>
            </div>
          </div>
          <div class="qc-preview-canvas" id="icPreviewCanvas">
            <div class="qc-a4-scale" id="icA4Scale">
              <div id="ic_livePreview"><div class="quote-doc-loading">Rendering preview…</div></div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="icCancel">Cancel</button>
      <button class="btn btn-outline" id="icSaveDraft">Save as Draft</button>
      <button class="btn btn-primary" id="icIssue">${s.editingId && !INVOICE_CREATE_STATUSES.includes(s.status) ? 'Save Changes' : 'Issue Invoice'}</button>
    </div>
  `;

  openModal(html, { xl:true, onMount:(overlay)=>{
    const editCol = overlay.querySelector('.qc-edit-col');
    if(editCol && prevScrollTop!=null) editCol.scrollTop = prevScrollTop;
    overlay.querySelector('#icClose').onclick = closeModal;
    overlay.querySelector('#icCancel').onclick = closeModal;
    overlay.querySelectorAll('[data-ictab]').forEach(t=> t.onclick = ()=>{ IC_TAB = t.dataset.ictab; renderCreateInvoiceModal(); });
    overlay.querySelectorAll('[data-iczoom]').forEach(b=> b.onclick = ()=>{
      const z = b.dataset.iczoom;
      if(z==='fit') IC_ZOOM = 'fit';
      else if(z==='100') IC_ZOOM = 1;
      else if(z==='in') IC_ZOOM = Math.min(2, (IC_ZOOM==='fit'?icCurrentFitZoom(overlay):IC_ZOOM) + 0.1);
      else if(z==='out') IC_ZOOM = Math.max(0.3, (IC_ZOOM==='fit'?icCurrentFitZoom(overlay):IC_ZOOM) - 0.1);
      renderCreateInvoiceModal();
    });
    icApplyZoom(overlay);
    icWireResize(overlay);
    const livePreviewEl = overlay.querySelector('#ic_livePreview');
    if(livePreviewEl) paintInvoicePreview(livePreviewEl, icStateToPreviewInvoice(s), ()=>icApplyZoom(overlay));

    const projectSel = overlay.querySelector('#ic_project');
    if(projectSel) projectSel.onchange = (e)=>{ icApplyProject(e.target.value); renderCreateInvoiceModal(); };
    overlay.querySelector('#ic_client').onchange = (e)=>{ s.clientName = e.target.value; refreshIcPreview(overlay); };
    overlay.querySelector('#ic_business').onchange = (e)=>{ s.businessName = e.target.value; refreshIcPreview(overlay); };
    overlay.querySelector('#ic_website').onchange = (e)=>{ s.websiteLink = e.target.value; refreshIcPreview(overlay); };
    overlay.querySelector('#ic_type').onchange = (e)=>{ icApplyInvoiceType(e.target.value); renderCreateInvoiceModal(); };
    const invnumInput = overlay.querySelector('#ic_invnum');
    if(invnumInput && !invnumInput.readOnly) invnumInput.onchange = (e)=>{ s.invoiceNumber = e.target.value.trim() || null; refreshIcPreview(overlay); };
    overlay.querySelector('#ic_date').onchange = (e)=>{ s.invoiceDate = e.target.value; renderCreateInvoiceModal(); };
    overlay.querySelector('#ic_due').onchange = (e)=>{ s.dueDate = e.target.value; refreshIcPreview(overlay); };
    overlay.querySelector('#ic_pstatus').onchange = (e)=>{ s.projectStatus = e.target.value; refreshIcPreview(overlay); };
    const statusSel = overlay.querySelector('#ic_status');
    if(statusSel) statusSel.onchange = (e)=>{ s.status = e.target.value; refreshIcPreview(overlay); };
    overlay.querySelector('#ic_currency').onchange = (e)=>{ s.currency = e.target.value; refreshIcPreview(overlay); };
    overlay.querySelector('#ic_discount').onchange = (e)=>{ s.discountAmount = Number(e.target.value)||0; renderCreateInvoiceModal(); };
    overlay.querySelector('#ic_summary').onchange = (e)=>{ s.summary = e.target.value; s._summaryTouched = true; refreshIcPreview(overlay); };
    overlay.querySelector('#ic_notes').onchange = (e)=>{ s.notes = e.target.value; s._notesTouched = true; refreshIcPreview(overlay); };
    overlay.querySelector('#ic_addRow').onclick = ()=>{ s.items.push({ id:fnId(), description:'', period:'', qty:1, amount:0 }); renderCreateInvoiceModal(); };
    wireInvoiceItemsEditor(overlay, s);

    overlay.querySelector('#icSaveDraft').onclick = ()=> saveInvoiceFromState('Draft');
    overlay.querySelector('#icIssue').onclick = ()=> saveInvoiceFromState(s.editingId && !INVOICE_CREATE_STATUSES.includes(s.status) ? null : 'Issued');
  }});
}

// Lighter-weight refresh (spec §12/§13 parity with refreshQcPreview) — used
// by every field that only changes preview CONTENT, never what other fields
// on screen look like, so editing text never disturbs scroll position or zoom.
function refreshIcPreview(overlay){
  const s = IC_STATE;
  const preview = overlay.querySelector('#ic_livePreview');
  if(preview) paintInvoicePreview(preview, icStateToPreviewInvoice(s), ()=>icApplyZoom(overlay));
  else icApplyZoom(overlay);
}

/* ---------------------------------------------------------------------- */
/* Live preview zoom (screen-only) — same pattern as Quotations'            */
/* qcCurrentFitZoom/qcApplyZoom/qcWireResize, kept as its own small copy    */
/* (own ids/state) rather than sharing QC_ZOOM/QC_TAB, since the two modals */
/* are conceptually independent screens even though they never open at the */
/* same time.                                                               */
/* ---------------------------------------------------------------------- */
function icCurrentFitZoom(overlay){
  const canvas = overlay.querySelector('#icPreviewCanvas');
  if(!canvas) return 1;
  const available = canvas.clientWidth - 32;
  if(!available || available<=0) return 1;
  return Math.max(0.3, Math.min(1.5, available / IC_A4_PAGE_WIDTH_PX));
}
function icApplyZoom(overlay){
  const canvas = overlay.querySelector('#icPreviewCanvas');
  const scaleEl = overlay.querySelector('#icA4Scale');
  if(!canvas || !scaleEl) return;
  const z = IC_ZOOM==='fit' ? icCurrentFitZoom(overlay) : IC_ZOOM;
  scaleEl.style.zoom = z;
}
let IC_RESIZE_HANDLER = null;
function icWireResize(overlay){
  if(IC_RESIZE_HANDLER) window.removeEventListener('resize', IC_RESIZE_HANDLER);
  IC_RESIZE_HANDLER = ()=>{
    if(!document.body.contains(overlay)){ window.removeEventListener('resize', IC_RESIZE_HANDLER); IC_RESIZE_HANDLER = null; return; }
    if(IC_ZOOM==='fit') icApplyZoom(overlay);
  };
  window.addEventListener('resize', IC_RESIZE_HANDLER);
}

// `forceStatus` — 'Draft' (Save as Draft button), 'Issued' (Issue Invoice,
// first time only), or null (Save Changes on an already-Issued+ invoice,
// where status stays exactly what the real payment-driven state machine
// says — issuing/editing NEVER marks an invoice Paid by itself, spec §11/§17).
function saveInvoiceFromState(forceStatus){
  const s = IC_STATE;
  if(!s.projectCode){ toast('Please select a project.', 'error'); return; }
  if(!s.clientName.trim()){ toast('Please enter a client name.', 'error'); return; }
  if(!s.invoiceDate){ toast('Please select an invoice date.', 'error'); return; }
  const proj = DB.find('projects', s.projectCode);
  if(!canCreateInvoiceForProject(proj)){ toast('You do not have permission to create an invoice for this project.', 'error'); return; }

  let existing = s.editingId ? DB.find('invoices', s.editingId) : null;
  if(existing && !canEditInvoice(existing)){ toast('You do not have permission to edit this invoice.', 'error'); return; }

  const invoiceNumber = s.invoiceNumber || existing?.invoiceNumber || generateInvoiceNumber(s.projectCode, s.businessName||s.clientName, s.invoiceDate);
  const status = forceStatus || s.status || 'Draft';
  const record = {
    id: existing ? existing.id : 'INV' + Date.now() + Math.floor(Math.random()*10000),
    invoiceNumber,
    projectCode: s.projectCode, leadId: proj ? proj.leadId : null,
    clientName: s.clientName.trim(), businessName: s.businessName.trim(),
    websiteLink: s.websiteLink.trim(), invoiceDate: s.invoiceDate, dueDate: s.dueDate || '',
    projectStatus: s.projectStatus, status, currency: s.currency,
    invoiceType: s.invoiceType || 'Custom', paymentStageIndex: s.paymentStageIndex!=null ? s.paymentStageIndex : null,
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
          ${statusBadge(inv.status)}<span class="text-muted" style="font-weight:600">${escapeHtml(invoicePaymentDisplayStatus(inv, totals))}</span><span>${escapeHtml(inv.clientName)}${inv.businessName?' — '+escapeHtml(inv.businessName):''}</span>
        </div>
      </div>
      <button class="modal-close" id="idClose">&times;</button>
    </div>
    <div class="modal-body">
      <div class="flex-row" style="justify-content:flex-end;margin-bottom:14px;flex-wrap:wrap;gap:8px" id="idActions"></div>

      <div class="pd-keyinfo">
        <div>
          ${infoRow('Project', proj ? `${proj.id} — ${escapeHtml(proj.businessName)}` : (inv.projectCode||'—'))}
          ${infoRow('Invoice Type', escapeHtml(INVOICE_TYPE_LABELS[inv.invoiceType]||inv.invoiceType||'Custom Invoice'))}
          ${infoRow('Invoice Date', fmtDate(inv.invoiceDate))}
          ${infoRow('Payment Due Date', inv.dueDate?fmtDate(inv.dueDate):'—')}
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
        <thead><tr><th>Invoice No.</th><th>Type</th><th>Date</th><th>Total</th><th>Paid</th><th>Balance</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>
          ${list.map(inv=>{
            const t = invoiceTotals(inv);
            return `<tr>
              <td class="cell-strong">${escapeHtml(inv.invoiceNumber)}</td>
              <td>${escapeHtml(INVOICE_TYPE_LABELS[inv.invoiceType]||inv.invoiceType||'Custom Invoice')}</td>
              <td>${fmtDate(inv.invoiceDate)}</td>
              <td>${money(t.total)}</td>
              <td>${money(t.totalPaid)}</td>
              <td>${money(t.balance)}</td>
              <td>${statusBadge(inv.status)}</td>
              <td><div class="flex-row" style="gap:2px;flex-wrap:wrap">
                <button class="btn btn-ghost btn-sm" data-view-invoice="${inv.id}">View</button>
                <button class="btn btn-ghost btn-sm" data-pdf-invoice="${inv.id}">PDF</button>
                ${canEditInvoice(inv) ? `<button class="btn btn-ghost btn-sm" data-edit-invoice="${inv.id}">Edit</button>` : ''}
                ${t.balance>0.004 && inv.status!=='Draft' && inv.status!=='Cancelled' ? `<button class="btn btn-ghost btn-sm" data-pay-invoice="${inv.id}">Record Payment</button>` : ''}
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
  container.querySelectorAll('[data-edit-invoice]').forEach(el=> el.onclick = ()=>{
    const inv = DB.find('invoices', el.dataset.editInvoice);
    if(inv){ IC_STATE = loadInvoiceStateFrom(inv); IC_TAB='edit'; renderCreateInvoiceModal(); }
  });
  container.querySelectorAll('[data-pay-invoice]').forEach(el=> el.onclick = ()=>{
    const inv = DB.find('invoices', el.dataset.payInvoice);
    if(inv && inv.projectCode) openRecordPaymentModal(inv.projectCode, ()=>{ if(typeof openProjectDetailModal==='function') openProjectDetailModal(inv.projectCode); }, inv.id);
  });
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
  if(inv.dueDate) rows.push(`<tr><th>Payment Due Date</th><td>${fmtDate(inv.dueDate)}</td></tr>`);
  if(inv.websiteLink) rows.push(`<tr><th>Website</th><td>${escapeHtml(inv.websiteLink)}</td></tr>`);
  if(proj) rows.push(`<tr><th>Project Status</th><td>${escapeHtml(proj.stage||'—')}</td></tr>`);
  rows.push(`<tr><th>Payment Status</th><td>${escapeHtml(invoicePaymentDisplayStatus(inv, invoiceTotals(inv)))}</td></tr>`);
  return rows.join('');
}

// Spec §14-16: the printed/preview title reflects the Invoice Type, and
// flips to the "…PAID" wording once real linked payments actually cover it
// — never just because the invoice was Issued.
function invoiceDocTitle(inv, totals){
  const disp = invoicePaymentDisplayStatus(inv, totals);
  if(inv.invoiceType==='Deposit') return disp==='Deposit Paid' ? 'DEPOSIT PAID' : 'DEPOSIT INVOICE';
  if(inv.invoiceType==='Progress') return disp==='Progress Payment Paid' ? 'PROGRESS PAYMENT PAID' : 'PROGRESS PAYMENT INVOICE';
  if(inv.invoiceType==='Final') return disp==='Fully Paid' ? 'FINAL PAYMENT — FULLY PAID' : 'FINAL PAYMENT INVOICE';
  return 'INVOICE';
}

function invoiceFullHeaderHtml(inv){
  const totals = invoiceTotals(inv);
  return `<div class="quote-doc-head">
    <div class="quote-doc-brand">
      <img class="quote-doc-logo" src="../assets/branding/bizweb-kh-logo-main-print.png" alt="BizWeb KH">
      <div class="text-muted" style="font-size:11px">Tel: 017 400 044 | Telegram: @BizWebKH | www.bizwebkh.com</div>
    </div>
    <div class="quote-doc-meta">
      <div class="khmer-text" style="font-size:13px;color:var(--blue)">វិក្កយបត្រ</div>
      <div><b>${escapeHtml(invoiceDocTitle(inv, totals))}</b> ${statusBadge(inv.status)}</div>
      <div>Invoice No: ${escapeHtml(inv.invoiceNumber)}</div>
    </div>
  </div>`;
}
function invoiceContHeaderHtml(inv){
  return `<div class="quote-doc-cont-head"><b>BizWeb KH</b> — ${escapeHtml(invoiceDocTitle(inv, invoiceTotals(inv)))} · Invoice No: ${escapeHtml(inv.invoiceNumber)}</div>`;
}

/* ---------------------------------------------------------------------- */
/* Payment-stage type framing + the compact multi-stage Payment Schedule    */
/* breakdown block (spec §12/§13/§14-16) — both are pure render functions   */
/* over invoicePaymentBreakdown()'s real numbers; no calculation is         */
/* duplicated here, and both are used identically by the live preview pane  */
/* AND Print/PDF (buildInvoiceSections below is the one place either is     */
/* called from — spec §23).                                                 */
/* ---------------------------------------------------------------------- */
function invoiceTypeFramingHtml(inv){
  const bd = invoicePaymentBreakdown(inv);
  const t = bd.totals;
  if(inv.invoiceType==='Deposit'){
    const stage = inv.paymentStageIndex!=null ? bd.schedule[inv.paymentStageIndex] : null;
    return `<table class="quote-doc-table qc-mini-table" style="max-width:380px">
      <tbody>
        <tr><td>Project Total</td><td style="text-align:right">${money(bd.projectTotal)}</td></tr>
        ${stage ? `<tr><td>Deposit %</td><td style="text-align:right">${stage.pct}%</td></tr>` : ''}
        <tr><td>Deposit Amount</td><td style="text-align:right">${money(t.total)}</td></tr>
        <tr><td>Previous Paid</td><td style="text-align:right">${money(bd.previouslyPaid)}</td></tr>
        <tr><td><b>Balance After Deposit</b></td><td style="text-align:right"><b>${money(bd.balanceAfter)}</b></td></tr>
      </tbody>
    </table>`;
  }
  if(inv.invoiceType==='Progress'){
    return `<table class="quote-doc-table qc-mini-table" style="max-width:380px">
      <tbody>
        <tr><td>Project Total</td><td style="text-align:right">${money(bd.projectTotal)}</td></tr>
        <tr><td>Deposit Already Paid</td><td style="text-align:right">${money(bd.previouslyPaid)}</td></tr>
        <tr><td>Current Progress Payment</td><td style="text-align:right">${money(t.total)}</td></tr>
        <tr><td><b>Remaining Final Balance</b></td><td style="text-align:right"><b>${money(bd.balanceAfter)}</b></td></tr>
      </tbody>
    </table>`;
  }
  if(inv.invoiceType==='Final'){
    const fullyPaid = bd.balanceAfter<=0.005 && t.totalPaid>0.004;
    return `<table class="quote-doc-table qc-mini-table" style="max-width:380px">
      <tbody>
        <tr><td>Project Total</td><td style="text-align:right">${money(bd.projectTotal)}</td></tr>
        <tr><td>Total Previous Payments</td><td style="text-align:right">${money(bd.previouslyPaid)}</td></tr>
        <tr><td>Final Amount Due</td><td style="text-align:right">${money(t.total)}</td></tr>
        <tr><td><b>Balance After Payment</b></td><td style="text-align:right"><b>${money(bd.balanceAfter)}${fullyPaid?' — FULLY PAID':''}</b></td></tr>
      </tbody>
    </table>`;
  }
  return '';
}
// Compact multi-stage breakdown — only rendered when the project's real
// schedule has 2+ stages (a single-stage/no-schedule project has nothing to
// break down). PAID/PARTIAL/PENDING is derived from the actual OTHER
// invoice (if any) issued against each stage — never hardcoded percentages,
// never this invoice's own record for any stage but its own.
function invoicePaymentScheduleBlockHtml(inv){
  const { schedule } = projectPaymentScheduleFor(inv.projectCode);
  if(!schedule || schedule.length<2) return '';
  const rows = schedule.map((st,i)=>{
    let tag, color;
    if(i===inv.paymentStageIndex){ tag='CURRENT INVOICE'; color='var(--blue)'; }
    else{
      const other = DB.all('invoices')
        .filter(x=> x.projectCode===inv.projectCode && x.paymentStageIndex===i && x.status!=='Cancelled' && x.id!==inv.id)
        .sort((a,b)=> new Date(b.createdAt||0)-new Date(a.createdAt||0))[0];
      if(other){
        const ot = invoiceTotals(other);
        tag = ot.balance<=0.005 && ot.totalPaid>0.004 ? 'PAID' : (ot.totalPaid>0.004 ? 'PARTIAL' : 'PENDING');
      } else tag = 'PENDING';
      color = tag==='PAID' ? 'var(--green)' : tag==='PARTIAL' ? '#d98a12' : 'var(--muted)';
    }
    return `<tr><td>${escapeHtml(st.label)}</td><td style="text-align:right">${money(st.amount)}</td><td style="text-align:right;color:${color};font-weight:700">${tag}</td></tr>`;
  }).join('');
  return `<h4 class="quote-doc-h">Payment Schedule</h4><table class="quote-doc-table qc-mini-table" style="max-width:460px">
    <thead><tr><th>Stage</th><th style="text-align:right">Amount</th><th style="text-align:right">Status</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function buildInvoiceSections(inv){
  const bank = bankDetails();
  const proj = inv.projectCode ? DB.find('projects', inv.projectCode) : null;
  const totals = invoiceTotals(inv);
  const sections = [];

  sections.push({ id:'info', kind:'block', html:`<table class="quote-doc-infotable">${invoiceInfoRows(inv, proj)}</table>` });

  sections.push({ id:'summary', kind:'block',
    html:`<h4 class="quote-doc-h">Invoice Summary</h4><p style="font-size:12.5px;margin:0;white-space:pre-wrap">${escapeHtml(inv.summary||'—')}</p>` });

  const typeFraming = invoiceTypeFramingHtml(inv);
  if(typeFraming){
    sections.push({ id:'stageframing', kind:'block',
      html:`<h4 class="quote-doc-h">${escapeHtml(invoiceDocTitle(inv, totals))}</h4>${typeFraming}` });
  }
  const scheduleBlock = invoicePaymentScheduleBlockHtml(inv);
  if(scheduleBlock) sections.push({ id:'schedule', kind:'block', html: scheduleBlock });

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
