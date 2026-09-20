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
/* Invoice Type <-> Payment Type consistency (soft guidance only) — used   */
/* when Record Payment is launched from an Invoice (presetInvoiceId) to    */
/* preselect a sensible Payment Type. Never enforced: the dropdown stays   */
/* fully editable and saving is never blocked, only a soft inline warning  */
/* is shown if the user picks something else (see openRecordPaymentModal). */
/* ---------------------------------------------------------------------- */
const INVOICE_TYPE_TO_PAYMENT_TYPE = { Deposit:'Deposit', Progress:'Partial Payment', Final:'Final Payment', Custom:null };

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
function relinkPaymentInvoice(paymentId, newInvoiceId, userName){
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
  DB.upsert('payments', payment);

  if(oldInvoiceId && typeof recalcInvoiceStatus==='function') recalcInvoiceStatus(oldInvoiceId);
  if(newInvoiceId && typeof recalcInvoiceStatus==='function') recalcInvoiceStatus(newInvoiceId);

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
    overlay.querySelector('#lpiSave').onclick = ()=>{
      const newInvoiceId = overlay.querySelector('#lpi_invoice').value || null;
      const result = relinkPaymentInvoice(payment.id, newInvoiceId, CURRENT_USER.name);
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
    };
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
    if(saveBtn) saveBtn.onclick = ()=>{
      const paymentId = overlay.querySelector('#lep_payment').value;
      const result = relinkPaymentInvoice(paymentId, inv.id, CURRENT_USER.name);
      if(!result.ok){ toast(result.error, 'error'); return; }
      toast('Payment linked to this invoice.', 'success');
      closeModal();
      if(onDone) onDone();
      refreshAfterLeadOrProjectChange(); // data-freshness fix — see openLinkPaymentInvoiceModal above
    };
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
  const totalCollected = rows.reduce((s,r)=> s + r.summary.totalPaid, 0);
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
function openRecordPaymentModal(projectId, onDone, presetInvoiceId=null){
  const proj = DB.find('projects', projectId);
  if(!proj) return;
  const summary = paymentSummaryFor(projectId);
  const hasDeposit = paymentsForProject(projectId).some(p=>p.type==='Deposit');
  const suggestedNumber = nextPaymentNumberLabel(projectId);
  const eligibleInvoices = (typeof DB!=='undefined' ? DB.all('invoices') : [])
    .filter(i=> i.projectCode===projectId && i.status!=='Cancelled');

  // Invoice Type / Payment Type consistency (soft guidance only, spec §4) —
  // launched from an Invoice, preselect a sensible Payment Type from its
  // Invoice Type. Custom invoices suggest nothing (user picks freely). The
  // dropdown stays fully editable either way, and picking something else
  // never blocks Save — only shows a small inline warning near the field.
  const presetInvoice = presetInvoiceId ? DB.find('invoices', presetInvoiceId) : null;
  const suggestedPaymentType = presetInvoice ? (INVOICE_TYPE_TO_PAYMENT_TYPE[presetInvoice.invoiceType] || null) : null;

  const html = `
    <div class="modal-head"><h3>Record Payment</h3><button class="modal-close" id="rpClose">&times;</button></div>
    <div class="modal-body">
      <p class="text-muted" style="margin-top:0;font-size:13px">${proj.id} — ${escapeHtml(proj.businessName)} · Project Value ${moneyPrecise(summary.confirmedValue)} · Remaining: <b>${moneyPrecise(summary.remaining)}</b></p>
      <div class="form-grid">
        <div class="form-field"><label class="required">Payment Number</label><input id="rp_number" value="${suggestedNumber}"></div>
        <div class="form-field"><label class="required">Payment Type</label>
          <select id="rp_type">
            ${!hasDeposit ? `<option value="Deposit" ${suggestedPaymentType==='Deposit'?'selected':''}>Deposit</option>` : ''}
            <option value="Partial Payment" ${suggestedPaymentType==='Partial Payment'?'selected':''}>Partial Payment</option>
            <option value="Full Payment">Full Payment</option>
            <option value="Final Payment" ${suggestedPaymentType==='Final Payment'?'selected':''}>Final Payment</option>
            <option value="Renewal">Renewal</option>
            <option value="Other">Other</option>
          </select>
          <p class="text-muted" id="rp_typeWarning" style="display:none;color:var(--amber);font-size:11px;margin:4px 0 0">This payment type differs from the invoice stage.</p>
        </div>
        <div class="form-field"><label class="required">Amount ($)</label><input type="number" id="rp_amount" value="${!hasDeposit ? Math.round(summary.confirmedValue*proj.depositPct) / 100 : summary.remaining}" min="0.01" step="0.01"></div>
        <div class="form-field"><label class="required">Payment Date</label><input type="date" id="rp_date" value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="form-field"><label class="required">Payment Method</label><select id="rp_method">${PAYMENT_METHODS.map(m=>`<option>${m}</option>`).join('')}</select></div>
        <div class="form-field"><label>Reference</label><input id="rp_ref" placeholder="e.g. bank txn ref, receipt #…"></div>
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
      <button class="btn btn-primary" id="rpSave">Save Payment</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#rpClose').onclick = closeModal;
    overlay.querySelector('#rpCancel').onclick = closeModal;

    // Full Payment (spec: "CRM – Record Payment: Add Full Payment Payment
    // Type") — selecting it autofills Amount with the CURRENT remaining
    // balance (recomputed fresh, not the value captured when the modal
    // opened), and — only when the project has no previous payment at all —
    // suggests "Full Payment" as the Payment Number instead of forcing an
    // ordinal like "1st Payment". Both fields stay freely editable
    // afterward. No other Payment Type's behavior is touched.
    const rpTypeSel = overlay.querySelector('#rp_type');
    const rpTypeWarning = overlay.querySelector('#rp_typeWarning');
    // Soft warning only (spec §4) — never blocks Save, just flags that the
    // chosen Payment Type no longer matches the invoice stage it was
    // launched from. Nothing shows at all when there was no suggestion
    // (no presetInvoiceId, or a Custom invoice).
    const refreshTypeWarning = ()=>{
      if(!rpTypeWarning) return;
      rpTypeWarning.style.display = (suggestedPaymentType && rpTypeSel.value !== suggestedPaymentType) ? 'block' : 'none';
    };
    refreshTypeWarning();
    rpTypeSel.onchange = ()=>{
      if(rpTypeSel.value === 'Full Payment'){
        const freshSummary = paymentSummaryFor(projectId);
        overlay.querySelector('#rp_amount').value = freshSummary.remaining;
        if(paymentsForProject(projectId).length === 0){
          overlay.querySelector('#rp_number').value = 'Full Payment';
        }
      }
      refreshTypeWarning();
    };

    overlay.querySelector('#rpSave').onclick = ()=>{
      const paymentNumber = overlay.querySelector('#rp_number').value.trim() || suggestedNumber;
      const type = overlay.querySelector('#rp_type').value;
      const amount = Number(overlay.querySelector('#rp_amount').value)||0;
      const date = overlay.querySelector('#rp_date').value;
      const method = overlay.querySelector('#rp_method').value;
      const reference = overlay.querySelector('#rp_ref').value.trim();
      const notes = overlay.querySelector('#rp_notes').value.trim();
      const invoiceSel = overlay.querySelector('#rp_invoice');
      const invoiceId = invoiceSel ? (invoiceSel.value || null) : null;
      if(amount<=0 || !date){ toast('Please enter a valid amount and date.', 'error'); return; }

      // Never let Total Paid silently exceed Project Value — warn and
      // require explicit confirmation rather than blocking outright, in
      // case the overage is genuinely intentional (e.g. a renewal payment
      // recorded against the same project).
      const currentSummary = paymentSummaryFor(projectId);
      if(amount > currentSummary.remaining + 0.004){
        const proceed = confirm(
          `This payment is greater than the remaining project balance.\n\n` +
          `Remaining Balance: ${moneyPrecise(currentSummary.remaining)}\n` +
          `Amount Entered: ${moneyPrecise(amount)}\n\n` +
          `Record this payment anyway?`
        );
        if(!proceed) return;
      }

      const savedPayment = recordPaymentEntry({ projectId, paymentNumber, amount, date, method, type, reference, note: notes, userName: CURRENT_USER.name, invoiceId });
      // Recompute the linked invoice's Total Paid/Balance/Status (spec §8) —
      // this is a real reference to the SAME payment row just recorded
      // above, never a duplicate. Unlinked payments (invoiceId===null,
      // every payment recorded before this module existed included) never
      // touch this at all.
      if(invoiceId && typeof recalcInvoiceStatus==='function') recalcInvoiceStatus(invoiceId);
      logActivity({ userName: CURRENT_USER.name, refType:'project', refId: proj.id, refLabel:`${proj.id} — ${proj.businessName}`,
        type: type==='Deposit' ? 'Deposit Recorded' : 'Payment Recorded',
        description:`${CURRENT_USER.name} recorded payment: ${moneyPrecise(amount)} (${type}, ${paymentNumber}) for project ${proj.id}`,
        remark: [reference, notes].filter(Boolean).join(' — ') || null });

      closeModal();
      const newSummary = paymentSummaryFor(projectId);

      // Section 11: never silently change delivery status — offer it instead
      // (in-app modal, not a native confirm()). The eligibility check below
      // is unchanged from the original confirm()-based flow — only the UI
      // that presents the offer has changed.
      let suggestedStage = null;
      if(type==='Deposit' && proj.stage==='Confirmed') suggestedStage = 'Deposit Paid';
      else if(newSummary.remaining<=0 && proj.stage==='Final Payment Pending') suggestedStage = 'Completed';

      openPaymentRecordedModal({ proj, amount, summary: newSummary, suggestedStage, paymentId: savedPayment.id, onAfterClose: ()=>{
        if(onDone) onDone();
        // Data-freshness fix (spec: "immediate refresh after successful
        // mutations"): refreshAfterLeadOrProjectChange() re-runs the CURRENT
        // route's render function fresh from DB._cache (already updated
        // synchronously by DB.upsert() above) — no network call, no full
        // page reload. Calling it unconditionally, instead of only for the
        // 'payments'/'dashboard' routes, means whichever page the user is
        // actually on (Projects, Invoices, Receipts, Dashboard, Payments…)
        // always reflects the new payment immediately, even though this
        // modal was opened from a Project Detail overlay sitting on top of
        // some other page. The modal overlay itself lives outside
        // #pageContent (see openModal()), so re-rendering the page
        // underneath never disturbs it.
        refreshAfterLeadOrProjectChange();
      }});
    };
  }});
}

/* ---------------------------------------------------------------------- */
/* Payment Recorded confirmation — CRM-styled modal replacing the old      */
/* native alert()/confirm() pair. Shows the payment summary (same values   */
/* already computed above — nothing recalculated here) and, only when the  */
/* exact same eligibility check the old confirm() used is met, offers the  */
/* follow-on project-stage change as in-app buttons instead of a native    */
/* confirm() dialog. The stage-change action itself still calls the exact  */
/* same applyProjectStageChange() used by every other stage-change entry   */
/* point in the app — only what triggers it (a button, not confirm())      */
/* changed.                                                                 */
/* ---------------------------------------------------------------------- */
// `paymentId` (optional, spec: Receipts module) — the just-saved payment's
// own id, used only to offer a "Generate Receipt" action below. Every
// pre-existing call site that doesn't pass it (none currently) would simply
// skip that button; receipts.js may also not be loaded at all (typeof-
// guarded), in which case this modal behaves byte-identical to before.
function openPaymentRecordedModal({ proj, amount, summary, suggestedStage, paymentId=null, onAfterClose }){
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
