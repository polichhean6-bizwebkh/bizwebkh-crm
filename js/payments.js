/* ==========================================================================
   BizWeb KH CRM — payments.js
   Payments behaves as a simple PAYMENT LEDGER: every payment is its own
   entry (project_id, amount, date, method, type, note, recorded by). A
   project's Confirmed Value, Total Paid, Remaining Balance and Payment
   Status are never stored — they are always derived live from the ledger
   via paymentSummaryFor() in data.js, so this page, the Project view, the
   Dashboard and Sales Performance can never disagree with each other.

   This page is now a FINANCIAL OVERVIEW / REPORTING surface — Projects is
   the primary place to record/edit/void payments (Project View → Record /
   Edit Payment). Nothing here writes to the payment ledger; every action
   here either reviews data or hands off to a Project's own detail view.
   ========================================================================== */

let FINANCIAL_FILTER_STATE = { date:'all', status:'' };


/* ---------------------------------------------------------------------- */
/* Payment <-> Invoice relinking (Founder/Admin only) — the ONE place a    */
/* payment's invoiceId is ever changed after it was first recorded. Only   */
/* invoices belonging to the SAME project as the payment may be selected — */
/* never cross-project. Relinking NEVER touches amount/type/date/method/   */
/* reference/note, NEVER touches any receipt already generated against     */
/* this payment (a receipt's own invoiceId is captured once at generation  */
/* time and deliberately never rewritten — see js/receipts.js), and NEVER  */
/* changes the project's Paid/Remaining (those are ledger-amount-based     */
/* only via paymentSummaryFor(), unaffected by which invoice a payment     */
/* points to). Both the old and new invoice's status are recalculated via  */
/* recalcInvoiceStatus() exactly as an amount edit already does.           */
/* ---------------------------------------------------------------------- */
async function relinkPaymentInvoice(paymentId, newInvoiceId, userName){
  const payment = DB.find('payments', paymentId);
  if(!payment) return { ok:false, error:'Payment not found.' };
  newInvoiceId = newInvoiceId || null;
  const oldInvoiceId = payment.invoiceId || null;
  if(newInvoiceId){
    const targetInv = DB.find('invoices', newInvoiceId);
    if(!targetInv) return { ok:false, error:'Invoice not found.' };
    if(targetInv.projectCode !== payment.projectId){
      return { ok:false, error:'That invoice belongs to a different project — a payment can only be linked to an invoice on its own project.' };
    }
  }
  if(newInvoiceId === oldInvoiceId) return { ok:true, unchanged:true };

  payment.invoiceId = newInvoiceId;
  const savedLink = await DB.update('payments', payment);
  if(!savedLink.ok) return { ok:false, error: savedLink.userMessage };

  if(oldInvoiceId && typeof recalcInvoiceStatus==='function') await recalcInvoiceStatus(oldInvoiceId);
  if(newInvoiceId && typeof recalcInvoiceStatus==='function') await recalcInvoiceStatus(newInvoiceId);

  const oldInv = oldInvoiceId ? DB.find('invoices', oldInvoiceId) : null;
  const newInv = newInvoiceId ? DB.find('invoices', newInvoiceId) : null;
  const proj = DB.find('projects', payment.projectId);
  logActivity({ userName, refType:'project', refId: payment.projectId, refLabel: proj ? `${proj.id} — ${proj.businessName}` : payment.projectId,
    type:'Payment Invoice Link Updated',
    description:`${userName} changed the invoice link for payment ${payment.paymentNumber||payment.id} on project ${payment.projectId}: ${oldInv?oldInv.invoiceNumber:'None'} → ${newInv?newInv.invoiceNumber:'None'}.` });

  return { ok:true, payment, oldInv, newInv };
}

// Eligible target invoices for relinking a given payment — any live
// (non-Cancelled) invoice on the SAME project, plus the payment's own
// currently-linked invoice even if it has since been cancelled (so it never
// silently disappears from the dropdown).
function eligibleInvoicesForPaymentLink(payment){
  if(!payment) return [];
  return DB.all('invoices').filter(i=> i.projectCode===payment.projectId && (i.status!=='Cancelled' || i.id===payment.invoiceId));
}

// Standalone "Link/Change Invoice" modal — reused by both Project Payment
// History (Edit Payment's own inline control also covers this, but this
// modal is the one Invoice Detail's "Link Existing Payment" action reuses,
// spec Payment/Invoice refinements §2/§7) and any other surface that only
// has a payment id in hand, without needing to reopen the full Edit Payment
// form. Founder/Admin only — mirrors canEditPayments()/openEditPaymentModal.
function openLinkPaymentInvoiceModal(paymentId, onDone){
  if(!canEditPayments(CURRENT_USER.role)){ toast('Only Founder/Admin can change a payment\'s invoice link.', 'error'); return; }
  const payment = DB.find('payments', paymentId);
  if(!payment) return;
  const proj = DB.find('projects', payment.projectId);
  const options = eligibleInvoicesForPaymentLink(payment);
  const currentInv = payment.invoiceId ? DB.find('invoices', payment.invoiceId) : null;

  const html = `
    <div class="modal-head"><h3>Link / Change Invoice</h3><button class="modal-close" id="lpiClose">&times;</button></div>
    <div class="modal-body">
      <p class="text-muted" style="margin-top:0;font-size:13px">${escapeHtml(payment.paymentNumber||payment.id)} — ${moneyPrecise(payment.amount)} · ${payment.projectId}${proj?' — '+escapeHtml(proj.businessName):''}</p>
      <p class="text-muted" style="font-size:12px">Currently linked to: <b>${currentInv?escapeHtml(currentInv.invoiceNumber):'No Invoice'}</b></p>
      <div class="form-field"><label>Invoice</label>
        <select id="lpi_invoice">
          <option value="">— No Invoice —</option>
          ${options.map(i=>`<option value="${i.id}" ${payment.invoiceId===i.id?'selected':''}>${escapeHtml(i.invoiceNumber)}</option>`).join('')}
        </select>
      </div>
      <p class="text-muted" style="font-size:11.5px">Changing this link never affects the payment's amount, type, date or method, and never changes any receipt already generated for it. Only invoices belonging to this same project can be selected.</p>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="lpiCancel">Cancel</button>
      <button class="btn btn-primary" id="lpiSave">Save Link</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#lpiClose').onclick = closeModal;
    overlay.querySelector('#lpiCancel').onclick = closeModal;
    overlay.querySelector('#lpiSave').onclick = function(){ return runSave(this, async ()=>{
      const newInvoiceId = overlay.querySelector('#lpi_invoice').value || null;
      const result = await relinkPaymentInvoice(payment.id, newInvoiceId, CURRENT_USER.name);
      if(!result.ok){ toast(result.error, 'error'); return; }
      toast(result.unchanged ? 'No change to the invoice link.' : 'Invoice link updated.', 'success');
      closeModal();
      if(onDone) onDone();
      // Data-freshness fix: relinking recalculates BOTH invoices' statuses
      // (see relinkPaymentInvoice) and can change what Invoices/Projects/
      // Dashboard show — refreshAfterLeadOrProjectChange() refreshes
      // whichever page is currently behind this modal, from the
      // already-updated cache, no network call.
      refreshAfterLeadOrProjectChange();
    }); };
  }});
}

// Invoice-initiated counterpart to the above (spec §7 "Link Existing
// Payment") — picks from this project's UNLINKED payments (invoiceId===
// null) and links the chosen one to THIS invoice, reusing the exact same
// relinkPaymentInvoice() core so the logic is never duplicated. Founder/
// Admin only.
function openLinkExistingPaymentModal(invoiceId, onDone){
  if(!isFounder()){ toast('Only Founder/Admin can link an existing payment.', 'error'); return; }
  const inv = DB.find('invoices', invoiceId);
  if(!inv) return;
  const candidates = DB.all('payments').filter(p=> p.projectId===inv.projectCode && !p.voided && !p.invoiceId);

  const html = `
    <div class="modal-head"><h3>Link Existing Payment</h3><button class="modal-close" id="lepClose">&times;</button></div>
    <div class="modal-body">
      <p class="text-muted" style="margin-top:0;font-size:13px">Invoice ${escapeHtml(inv.invoiceNumber)} — ${inv.projectCode}</p>
      ${candidates.length ? `
      <div class="form-field"><label class="required">Unlinked Payment</label>
        <select id="lep_payment">
          ${candidates.map(p=>`<option value="${p.id}">${escapeHtml(p.paymentNumber||p.id)} — ${moneyPrecise(p.amount)} (${fmtDate(p.date)})</option>`).join('')}
        </select>
      </div>
      <p class="text-muted" style="font-size:11.5px">Only payments recorded on this same project with no invoice link yet are shown. Linking never changes the payment's amount, type, date or method.</p>
      ` : `<p class="text-muted" style="font-size:12.5px">There are no unlinked payments on this project to attach.</p>`}
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="lepCancel">Cancel</button>
      ${candidates.length ? `<button class="btn btn-primary" id="lepSave">Link Payment</button>` : ''}
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#lepClose').onclick = closeModal;
    overlay.querySelector('#lepCancel').onclick = closeModal;
    const saveBtn = overlay.querySelector('#lepSave');
    if(saveBtn) saveBtn.onclick = function(){ return runSave(this, async ()=>{
      const paymentId = overlay.querySelector('#lep_payment').value;
      const result = await relinkPaymentInvoice(paymentId, inv.id, CURRENT_USER.name);
      if(!result.ok){ toast(result.error, 'error'); return; }
      toast('Payment linked to this invoice.', 'success');
      closeModal();
      if(onDone) onDone();
      refreshAfterLeadOrProjectChange(); // data-freshness fix — see openLinkPaymentInvoiceModal above
    }); };
  }});
}

function renderPaymentsPage(){
  const el = document.getElementById('pageContent');
  const projects = [...DB.all('projects')];
  const rows = projects.map(p=> ({ proj:p, summary: paymentSummaryFor(p.id) }));

  // ---- Top KPI cards: always all-time / all-project totals, so they can  ----
  // ---- never drift from Dashboard's Collected Revenue / Outstanding      ----
  // ---- Balance (§18). Filters below only narrow the two detail tables.   ----
  const totalProjectValue = rows.reduce((s,r)=> s + r.summary.confirmedValue, 0);
  const totalCollected = rows.reduce((s,r)=> s + r.summary.totalPaid + (r.summary.renewalPaid||0), 0);
  const totalOutstanding = rows.reduce((s,r)=> s + r.summary.remaining, 0);
  const fullyPaidCount = rows.filter(r=> r.summary.status==='Fully Paid').length;
  const partiallyPaidCount = rows.filter(r=> r.summary.status==='Partially Paid').length;
  const unpaidCount = rows.filter(r=> r.summary.status==='Not Paid').length;

  el.innerHTML = `
    <div class="kpi-grid summary-cards-6" style="margin-bottom:18px">
      <div class="kpi-card"><div class="kpi-value">${moneyPrecise(totalProjectValue)}</div><div class="kpi-label">Total Project Value</div></div>
      <div class="kpi-card"><div class="kpi-value" style="color:var(--green)">${moneyPrecise(totalCollected)}</div><div class="kpi-label">Total Collected</div></div>
      <div class="kpi-card"><div class="kpi-value" style="color:var(--red)">${moneyPrecise(totalOutstanding)}</div><div class="kpi-label">Total Outstanding</div></div>
      <div class="kpi-card"><div class="kpi-value">${fullyPaidCount}</div><div class="kpi-label">Fully Paid Projects</div></div>
      <div class="kpi-card"><div class="kpi-value">${partiallyPaidCount}</div><div class="kpi-label">Partially Paid Projects</div></div>
      <div class="kpi-card"><div class="kpi-value">${unpaidCount}</div><div class="kpi-label">Unpaid Projects</div></div>
    </div>

    <div class="filters-bar" style="margin-bottom:18px">
      <select id="finFltDate" class="sel">
        <option value="all" ${FINANCIAL_FILTER_STATE.date==='all'?'selected':''}>All Time</option>
        <option value="month" ${FINANCIAL_FILTER_STATE.date==='month'?'selected':''}>This Month</option>
        <option value="30d" ${FINANCIAL_FILTER_STATE.date==='30d'?'selected':''}>Last 30 Days</option>
        <option value="year" ${FINANCIAL_FILTER_STATE.date==='year'?'selected':''}>This Year</option>
      </select>
      <select id="finFltStatus" class="sel">
        <option value="">All Payment Statuses</option>
        ${PAYMENT_STATUSES.map(s=>`<option value="${s}" ${FINANCIAL_FILTER_STATE.status===s?'selected':''}>${s}</option>`).join('')}
      </select>
      <p class="text-muted" style="font-size:11.5px;margin:0 0 0 4px">Filters apply to Outstanding Payments and Recent Payments below.</p>
    </div>

    <div id="finTablesWrap"></div>
  `;

  document.getElementById('finFltDate').onchange = (e)=>{ FINANCIAL_FILTER_STATE.date=e.target.value; renderFinancialTables(); };
  document.getElementById('finFltStatus').onchange = (e)=>{ FINANCIAL_FILTER_STATE.status=e.target.value; renderFinancialTables(); };

  renderFinancialTables();
}

function withinDateFilter(dateStr){
  if(FINANCIAL_FILTER_STATE.date==='all') return true;
  if(!dateStr) return false;
  const d = new Date(dateStr);
  if(isNaN(d)) return false;
  const now = new Date();
  if(FINANCIAL_FILTER_STATE.date==='month'){
    return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth();
  }
  if(FINANCIAL_FILTER_STATE.date==='30d'){
    const cutoff = new Date(now); cutoff.setDate(cutoff.getDate()-30);
    return d >= cutoff && d <= now;
  }
  if(FINANCIAL_FILTER_STATE.date==='year'){
    return d.getFullYear()===now.getFullYear();
  }
  return true;
}

function renderFinancialTables(){
  const wrap = document.getElementById('finTablesWrap');
  if(!wrap) return;

  const projects = [...DB.all('projects')];
  const rows = projects.map(p=> ({ proj:p, summary: paymentSummaryFor(p.id) }));

  // ---- Outstanding Payments: only Remaining > 0, optionally narrowed by  ----
  // ---- the Payment Status filter.                                       ----
  let outstanding = rows.filter(r=> r.summary.remaining > 0);
  if(FINANCIAL_FILTER_STATE.status) outstanding = outstanding.filter(r=> r.summary.status===FINANCIAL_FILTER_STATE.status);
  outstanding.sort((a,b)=> b.summary.remaining - a.summary.remaining);

  // ---- Recent Payments: every non-voided ledger entry, newest first,    ----
  // ---- optionally narrowed by date range and by the owning project's    ----
  // ---- current Payment Status.                                         ----
  const statusByProject = {};
  rows.forEach(r=> statusByProject[r.proj.id] = r.summary.status);
  let recentPayments = DB.all('payments').filter(p=>!p.voided);
  recentPayments = recentPayments.filter(p=> withinDateFilter(p.date||p.createdAt));
  if(FINANCIAL_FILTER_STATE.status) recentPayments = recentPayments.filter(p=> statusByProject[p.projectId]===FINANCIAL_FILTER_STATE.status);
  recentPayments.sort((a,b)=> new Date(b.date||b.createdAt) - new Date(a.date||a.createdAt));
  const RECENT_LIMIT = 25;
  const recentShown = recentPayments.slice(0, RECENT_LIMIT);

  wrap.innerHTML = `
    <div class="panel" style="margin-bottom:18px">
      <div class="panel-head"><h3>Outstanding Payments</h3><span class="text-muted" style="font-size:12px">${outstanding.length} project${outstanding.length===1?'':'s'}</span></div>
      <div class="panel-body pad">
        <div class="table-wrap scroll-x">
          <table class="data-table">
            <thead>
              <tr>
                <th>Project</th><th>Client</th><th>Project Value</th><th>Paid</th>
                <th>Remaining</th><th>Last Payment</th><th>Payment Status</th><th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${outstanding.length ? outstanding.map(({proj:p, summary:s})=>`
                <tr>
                  <td class="cell-link" data-open="${p.id}">${p.id}</td>
                  <td>${escapeHtml(p.clientName)}<div class="cell-sub">${escapeHtml(p.businessName)}</div></td>
                  <td class="cell-strong">${moneyPrecise(s.confirmedValue)}</td>
                  <td style="font-weight:700;color:${s.totalPaid>0?'var(--green)':'inherit'}">${moneyPrecise(s.totalPaid)}</td>
                  <td style="font-weight:700;color:#d98a12">${moneyPrecise(s.remaining)}</td>
                  <td>${s.lastPayment ? `${fmtDate(s.lastPayment.date)}<div class="cell-sub">${escapeHtml(s.lastPayment.type)}</div>` : '—'}</td>
                  <td>${paymentBadge(s.status)}</td>
                  <td><button class="btn btn-secondary btn-sm" data-open="${p.id}">Open Project</button></td>
                </tr>`).join('') : `<tr><td colspan="8"><div class="empty-row">No outstanding balances${FINANCIAL_FILTER_STATE.status?' for this Payment Status filter':''}. Every matching project is fully paid.</div></td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Recent Payments</h3><span class="text-muted" style="font-size:12px">${recentPayments.length} payment${recentPayments.length===1?'':'s'}${FINANCIAL_FILTER_STATE.date!=='all'||FINANCIAL_FILTER_STATE.status?' matching filters':''}</span></div>
      <div class="panel-body pad">
        <div class="table-wrap scroll-x">
          <table class="data-table">
            <thead>
              <tr>
                <th>Date</th><th>Project</th><th>Client</th><th>Payment #</th><th>Type</th>
                <th>Amount</th><th>Method</th><th>Recorded By</th><th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${recentShown.length ? recentShown.map(p=>{
                const proj = DB.find('projects', p.projectId);
                return `
                <tr>
                  <td>${fmtDate(p.date)}</td>
                  <td class="cell-link" data-open="${p.projectId}">${p.projectId}</td>
                  <td>${proj ? escapeHtml(proj.clientName) : '—'}</td>
                  <td class="cell-strong">${escapeHtml(p.paymentNumber||'—')}</td>
                  <td>${escapeHtml(p.type)}</td>
                  <td class="cell-strong">${moneyPrecise(p.amount)}</td>
                  <td>${escapeHtml(p.method||'—')}</td>
                  <td>${escapeHtml(p.recordedBy||'—')}</td>
                  <td><button class="btn btn-ghost btn-sm" data-open="${p.projectId}">View Project</button></td>
                </tr>`;}).join('') : `<tr><td colspan="9"><div class="empty-row">No payments recorded yet${FINANCIAL_FILTER_STATE.date!=='all'||FINANCIAL_FILTER_STATE.status?' for this filter':''}.</div></td></tr>`}
            </tbody>
          </table>
        </div>
        ${recentPayments.length>RECENT_LIMIT ? `<p class="text-muted" style="margin-top:10px;font-size:12px">Showing latest ${RECENT_LIMIT} of ${recentPayments.length} payments.</p>` : ''}
      </div>
    </div>
  `;

  wrap.querySelectorAll('[data-open]').forEach(x=> x.onclick = ()=> openProjectDetailModal(x.dataset.open));
}

/* ---------------------------------------------------------------------- */
/* Record Payment — the canonical payment-entry form. Invoked from Project */
/* View / Project Edit (see projects.js) only; this page never opens it   */
/* directly anymore — Projects is the source of truth for recording       */
/* payments (spec §1/§5).                                                  */
/* ---------------------------------------------------------------------- */

// `presetInvoiceId` (optional, spec: Invoices module §8) preselects the
// Invoice dropdown below — used when "Record Payment" is launched FROM an
// invoice (list row / detail view). Every pre-existing call site (Project
// View's own Record Payment button) passes nothing here and the dropdown
// simply defaults to "— No Invoice —", so an unlinked payment is recorded
// exactly as before this module existed.
// `presetInvoiceId` (optional, spec: Invoices module §8) preselects the
// Invoice dropdown below — used when "Record Payment" is launched FROM an
// invoice (list row / detail view). Every pre-existing call site (Project
// View's own Record Payment button) passes nothing here and the dropdown
// simply defaults to "— No Invoice —", so an unlinked payment is recorded
// exactly as before this module existed.
//
// `opts.autoReceipt` (spec: "Invoice -> Payment -> Receipt Workflow" primary
// workflow) — when true, saving this modal both records the payment AND
// generates its receipt in the same action ("Record Payment & Generate
// Receipt"), instead of leaving receipt generation as a separate follow-up
// click in the confirmation modal. Every call site that omits it keeps the
// original two-step behavior (Save Payment, then optionally Generate
// Receipt from the confirmation modal) byte-identical to before.
// `opts.forceNoInvoice` — used by the Receipts page's "+ Record Receipt" →
// "Project Payment without Invoice" mode: hides the Invoice dropdown
// entirely (this payment can never be linked to one) and shows the exact
// warning copy the spec requires.
function openRecordPaymentModal(projectId, onDone, presetInvoiceId=null, opts={}){
  const proj = DB.find('projects', projectId);
  if(!proj) return;
  const autoReceipt = !!opts.autoReceipt;
  const forceNoInvoice = !!opts.forceNoInvoice;
  const summary = paymentSummaryFor(projectId);
  const eligibleInvoices = forceNoInvoice ? [] : (typeof DB!=='undefined' ? DB.all('invoices') : [])
    .filter(i=> i.projectCode===projectId && i.status!=='Cancelled');

  // Launched from an Invoice: its outstanding balance (capped at the project's remaining balance) is offered as the starting amount.
  // Invoice Amount / Amount Already Received / Outstanding Balance are read live from invoiceTotals(), the ONE place those figures are computed (js/invoices.js).
  const presetInvoice = (!forceNoInvoice && presetInvoiceId) ? DB.find('invoices', presetInvoiceId) : null;
  const presetInvoiceTotals = presetInvoice ? invoiceTotals(presetInvoice) : null;
  const startAmount = presetInvoice ? Math.max(0, Math.min(presetInvoiceTotals.balance, summary.remaining)) : '';

  // Payment Purpose release: the user chooses only WHY the money came (Project Payment | Renewal). The Payment Label (First / Second / ... / Final Payment, Renewal Payment) is
  // calculated here for display while typing, and calculated again — authoritatively — by the server, which also refuses an amount above the remaining balance.
  // infoRow() escapes its value, so rows that carry markup (the live-updated spans) use rpRow(), whose value is trusted HTML built here from escaped / numeric parts only.
  const rpRow = (label, valueHtml) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;font-size:13px;border-bottom:1px solid #f2f5fa">
    <span class="text-muted">${label}</span><span class="cell-strong" style="text-align:right">${valueHtml}</span>
  </div>`;
  const html = `
    <div class="modal-head"><h3>${autoReceipt ? 'Record Payment &amp; Generate Receipt' : 'Record Payment'}</h3><button class="modal-close" id="rpClose">&times;</button></div>
    <div class="modal-body">
      <div class="pd-keyinfo" style="grid-template-columns:1fr 1fr;margin-bottom:14px">
        <div>
          ${rpRow('Project', escapeHtml(proj.id + ' — ' + proj.businessName))}
          ${rpRow('Project Value', '<span id="rp_value">' + moneyPrecise(summary.confirmedValue) + '</span>')}
        </div>
        <div>
          ${rpRow('Paid', '<span id="rp_paid">' + moneyPrecise(summary.totalPaid) + '</span>')}
          ${rpRow('Remaining', '<b id="rp_remaining">' + moneyPrecise(summary.remaining) + '</b>')}
        </div>
      </div>
      ${presetInvoice ? `
      <div class="pd-keyinfo" style="grid-template-columns:1fr 1fr;margin-bottom:14px">
        <div>
          ${infoRow('Invoice', escapeHtml(presetInvoice.invoiceNumber))}
          ${infoRow('Invoice Amount', moneyPrecise(presetInvoiceTotals.total))}
        </div>
        <div>
          ${infoRow('Amount Already Received', moneyPrecise(presetInvoiceTotals.totalPaid))}
          ${infoRow('Outstanding Balance', moneyPrecise(presetInvoiceTotals.balance))}
        </div>
      </div>` : ''}
      ${forceNoInvoice ? `<p class="text-muted" style="font-size:12px;background:rgba(217,138,18,.1);border:1px solid #d98a12;border-radius:var(--radius-sm);padding:8px 10px;margin:0 0 14px">This receipt will not be linked to an invoice. Use this only when payment was received without an invoice.</p>` : ''}
      <div class="form-grid">
        <div class="form-field"><label class="required">Payment Purpose</label>
          <select id="rp_type">${PAYMENT_TYPES.map(t=>`<option value="${t}">${t}</option>`).join('')}</select>
        </div>
        <div class="form-field"><label>Payment Label</label><input id="rp_label" value="" readonly tabindex="-1" style="font-weight:700"></div>
        <div class="form-field"><label class="required">Amount ($)</label><input type="number" id="rp_amount" value="${startAmount}" min="0.01" step="0.01" inputmode="decimal">
          <p id="rp_msg" style="font-size:12px;margin:4px 0 0;min-height:16px"></p>
        </div>
        <div class="form-field"><label class="required">Payment Date</label><input type="date" id="rp_date" value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="form-field"><label class="required">Payment Method</label><select id="rp_method">${PAYMENT_METHODS.map(m=>`<option>${m}</option>`).join('')}</select></div>
        <div class="form-field"><label>Transaction / Reference No.</label><input id="rp_ref" placeholder="e.g. bank txn ref, receipt #…"></div>
        ${eligibleInvoices.length ? `<div class="form-field"><label>Invoice</label>
          <select id="rp_invoice">
            <option value="">— No Invoice —</option>
            ${eligibleInvoices.map(i=>`<option value="${i.id}" ${presetInvoiceId===i.id?'selected':''}>${escapeHtml(i.invoiceNumber)}</option>`).join('')}
          </select></div>` : ''}
        <div class="form-field full"><label>Note</label><textarea id="rp_notes" placeholder="Optional note…"></textarea></div>
        <div class="form-field full"><label>Recorded By</label><input value="${escapeHtml(CURRENT_USER.name)}" disabled></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="rpCancel">Cancel</button>
      <button class="btn btn-primary" id="rpSave">${autoReceipt ? 'Record Payment &amp; Generate Receipt' : 'Save Payment'}</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#rpClose').onclick = closeModal;
    overlay.querySelector('#rpCancel').onclick = closeModal;
    const typeSel = overlay.querySelector('#rp_type'), amountEl = overlay.querySelector('#rp_amount');
    const labelEl = overlay.querySelector('#rp_label'), msgEl = overlay.querySelector('#rp_msg'), saveBtn = overlay.querySelector('#rpSave');

    // Live label: re-run on every keystroke / purpose change. Final Payment appears the moment the amount equals the remaining balance and
    // goes back to the sequential label if the amount changes again. Save is blocked while the amount is not valid.
    const refresh = ()=>{
      const cur = paymentSummaryFor(projectId);                  // fresh figures, not the ones captured when the modal opened
      const pv = previewPaymentLabel(projectId, typeSel.value, amountEl.value);
      labelEl.value = pv.label;
      const renewal = typeSel.value === 'Renewal';
      let msg = '', color = 'var(--muted)';
      if(renewal){ msg = 'Renewals are recorded separately from the project balance.'; }
      else if(!pv.valid && amountEl.value !== ''){ msg = pv.error; color = 'var(--red)'; }
      else if(pv.valid && pv.isFinal){ msg = 'This pays the project in full.'; color = 'var(--green)'; }
      else if(pv.valid){ msg = 'Remaining after this payment: ' + moneyPrecise(cur.remaining - Number(amountEl.value)); }
      else if(cur.remaining <= 0){ msg = 'No project balance remaining. Set the Project Value first, or choose Renewal.'; color = 'var(--amber)'; }
      msgEl.textContent = msg; msgEl.style.color = color;
      const blocked = renewal ? !(Number(amountEl.value) > 0) : !pv.valid;
      saveBtn.disabled = blocked; saveBtn.title = blocked ? (renewal ? 'Enter the payment amount.' : (pv.error || 'Enter a valid amount.')) : '';
    };
    typeSel.onchange = refresh; amountEl.oninput = refresh; refresh();

    overlay.querySelector('#rpSave').onclick = function(){ return runSave(this, async ()=>{
      const type = typeSel.value;
      const amount = Number(amountEl.value)||0;
      const date = overlay.querySelector('#rp_date').value;
      const method = overlay.querySelector('#rp_method').value;
      const reference = overlay.querySelector('#rp_ref').value.trim();
      const notes = overlay.querySelector('#rp_notes').value.trim();
      const invoiceSel = overlay.querySelector('#rp_invoice');
      const invoiceId = forceNoInvoice ? null : (invoiceSel ? (invoiceSel.value || null) : null);
      if(amount<=0 || !date){ toast('Please enter a valid amount and date.', 'error'); return; }
      const pv = previewPaymentLabel(projectId, type, amountEl.value);
      if(type!=='Renewal' && !pv.valid){ toast(pv.error, 'error'); return; }     // overpayment / zero / bad decimals: never sent. The server enforces the same rule.

      if(invoiceId){
        // Invoice-linked guard: a payment may not exceed the linked invoice's balance. Only Founder/Admin can confirm that (the project balance rule above still applies to everybody).
        const linkedInv = DB.find('invoices', invoiceId);
        const linkedTotals = linkedInv ? invoiceTotals(linkedInv) : null;
        if(linkedTotals && amount > linkedTotals.balance + 0.004){
          if(!isFounder()){
            toast(`This would exceed the invoice balance (${moneyPrecise(linkedTotals.balance)}). Only Founder/Admin can confirm an overpayment.`, 'error');
            return;
          }
          const proceed = confirm(
            `This payment is greater than the invoice's outstanding balance.\n\n` +
            `Invoice Balance: ${moneyPrecise(linkedTotals.balance)}\n` +
            `Amount Entered: ${moneyPrecise(amount)}\n\n` +
            `Record this against the invoice anyway?`
          );
          if(!proceed) return;
        }
      }

      const recorded = await recordPaymentEntry({ projectId, amount, date, method, type, reference, note: notes, userName: CURRENT_USER.name, invoiceId });
      if(!recorded.ok){ saveFailed(recorded); return; }      // nothing was recorded (e.g. the server refused an overpayment): the form stays open with everything the user typed
      const savedPayment = recorded.record;
      const label = savedPayment.paymentNumber || pv.label;  // the label the SERVER stored

      // Combined "Record Payment & Generate Receipt": generate the receipt in the SAME action, before recalculating the invoice's status so the new receipt is already counted.
      if(autoReceipt && typeof generateReceiptForPayment==='function'){
        await generateReceiptForPayment(savedPayment.id, ()=>{});
      }
      if(invoiceId && typeof recalcInvoiceStatus==='function') await recalcInvoiceStatus(invoiceId);
      logActivity({ userName: CURRENT_USER.name, refType:'project', refId: proj.id, refLabel:`${proj.id} — ${proj.businessName}`,
        type: label==='First Payment' ? 'Deposit Recorded' : 'Payment Recorded',
        description:`${CURRENT_USER.name} recorded payment: ${moneyPrecise(amount)} (${type}, ${label}) for project ${proj.id}`,
        remark: [reference, notes].filter(Boolean).join(' — ') || null });

      closeModal();
      const newSummary = paymentSummaryFor(projectId);

      // Never silently change delivery status — offer it instead. Payment status itself always comes from the amounts, never from the label.
      let suggestedStage = null;
      if(type==='Project Payment' && label==='First Payment' && proj.stage==='Confirmed') suggestedStage = 'Deposit Paid';
      else if(type==='Project Payment' && newSummary.remaining<=0 && proj.stage==='Final Payment Pending') suggestedStage = 'Completed';

      openPaymentRecordedModal({ proj, amount, summary: newSummary, suggestedStage, label, paymentId: savedPayment.id, onAfterClose: ()=>{
        if(onDone) onDone();
        // Data-freshness: re-render the CURRENT route from the already-updated cache (no network call, no reload).
        refreshAfterLeadOrProjectChange();
      }});
    }); };
  }});
}

// `paymentId` (optional, spec: Receipts module) — the just-saved payment's
// own id, used only to offer a "Generate Receipt" action below. Every
// pre-existing call site that doesn't pass it (none currently) would simply
// skip that button; receipts.js may also not be loaded at all (typeof-
// guarded), in which case this modal behaves byte-identical to before.
function openPaymentRecordedModal({ proj, amount, summary, suggestedStage, label=null, paymentId=null, onAfterClose }){
  const checkIcon = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

  const finish = (message)=>{
    closeModal();
    toast(message, 'success');
    if(onAfterClose) onAfterClose();
  };

  const showReceiptAction = paymentId && typeof receiptActionButtonHtml==='function';

  const html = `
    <div class="modal-body" style="text-align:center;padding-top:28px">
      <div style="width:56px;height:56px;border-radius:50%;background:var(--green);display:flex;align-items:center;justify-content:center;margin:0 auto 14px">${checkIcon}</div>
      <h3 style="font-size:17px;font-weight:800;margin-bottom:4px">Payment Recorded Successfully</h3>
      <p class="text-muted" style="margin:0 0 18px;font-size:13px">${proj.id} — ${escapeHtml(proj.businessName)}</p>
      <div class="pd-keyinfo" style="grid-template-columns:1fr;text-align:left;margin-bottom:${suggestedStage?'18px':'4px'}">
        <div>
          ${label ? infoRow('Payment', escapeHtml(label)) : ''}
          ${infoRow('Payment Amount', moneyPrecise(amount))}
          ${infoRow('Total Paid', moneyPrecise(summary.totalPaid))}
          ${infoRow('Remaining Balance', moneyPrecise(summary.remaining))}
          ${infoRow('Payment Status', summary.status)}
        </div>
      </div>
      ${suggestedStage ? `
      <div style="text-align:left;border-top:1px solid var(--line);padding-top:16px">
        <p style="font-size:13.5px;font-weight:600;margin:0 0 12px">Would you like to update the Project Status to "${escapeHtml(suggestedStage)}"?</p>
      </div>` : ''}
    </div>
    <div class="modal-foot ${suggestedStage?'pr-modal-foot':''}">
      ${showReceiptAction ? receiptActionButtonHtml(paymentId, 'btn btn-outline') : ''}
      ${suggestedStage ? `
        <button class="btn btn-secondary" id="prKeep">Keep Current Status</button>
        <button class="btn btn-primary" id="prUpdate">Update to ${escapeHtml(suggestedStage)}</button>
      ` : `<button class="btn btn-primary" id="prDone">Done</button>`}
    </div>
  `;

  openModal(html, { onMount:(overlay)=>{
    if(showReceiptAction && typeof wireReceiptActionButtons==='function') wireReceiptActionButtons(overlay);
    if(suggestedStage){
      overlay.querySelector('#prKeep').onclick = ()=> finish('Payment recorded successfully.');
      overlay.querySelector('#prUpdate').onclick = ()=>{
        closeModal();
        // Exact same status-update logic used everywhere else in the app —
        // only the trigger (this button) differs from the old confirm().
        applyProjectStageChange(proj, suggestedStage);
        toast('Payment recorded and project status updated.', 'success');
        if(onAfterClose) onAfterClose();
      };
    } else {
      overlay.querySelector('#prDone').onclick = ()=> finish('Payment recorded successfully.');
    }
  }});
}
