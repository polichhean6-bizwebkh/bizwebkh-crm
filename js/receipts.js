/* ==========================================================================
   BizWeb KH CRM — receipts.js
   New Receipts module. A Receipt is a confirmation that a payment has
   actually been received — distinct from an Invoice (a request for
   payment). Every receipt is a thin reference to an existing Payment
   record (payment_id) — Receipts NEVER creates an independent money
   record. Amount / Payment Type / Payment Method / Reference / Note /
   Recorded By are always read LIVE from the linked payment (and
   paymentSummaryFor() for the Project Value / Previously Paid / Total
   Paid / Remaining Balance block) at render time — never frozen at
   creation, never recomputed independently (see receiptPaymentAndSummary()
   below, the ONE place either is read).

   PDF/print pipeline: reuses the EXACT SAME generic A4 pagination engine
   already built for Quotations/Invoices — measureQuoteDoc() /
   packQuoteSections() / renderQuotePagesHtml() / printQuoteDocFromContainer()
   (js/quotations.js) — and the exact same `.quote-doc-*` / `.quote-page*`
   CSS, including the signature block markup (`.quote-doc-accept`) already
   built for Quotations/Invoices. Nothing is duplicated here; only
   receipt-specific HTML fragments are new.
   ========================================================================== */

/* ---------------------------------------------------------------------- */
/* Permissions (mirrors isFounder()/canEditPayments()/canCancelInvoice()   */
/* conventions exactly — no new permission system invented).              */
/* ---------------------------------------------------------------------- */
function canCancelReceipt(){ return isFounder(); }

/* ---------------------------------------------------------------------- */
/* Receipt <-> Payment linkage lookups                                    */
/* ---------------------------------------------------------------------- */
function receiptsForPayment(paymentId){
  return DB.all('receipts').filter(r=>r.paymentId===paymentId);
}
// The receipt that currently "counts" for a payment — i.e. not cancelled.
// Enforced as a hard rule, both here and at the database level (a partial
// unique index on receipts.payment_id WHERE status='Issued'): a payment can
// have at most ONE active (Issued) receipt at any time, for every role
// including Founder/Admin — there is no override that creates a second
// active receipt side-by-side. The only path to a "new" receipt for a
// payment that already has one is Cancel Receipt (Founder/Admin only) and
// then Generate Receipt again, which then finds no active receipt here and
// proceeds, producing a genuinely new receipt number.
function activeReceiptForPayment(paymentId){
  const active = receiptsForPayment(paymentId).filter(r=>r.status!=='Cancelled');
  if(!active.length) return null;
  return active.slice().sort((a,b)=> new Date(b.createdAt||0) - new Date(a.createdAt||0))[0];
}
function receiptsForProject(projectId){
  return DB.all('receipts').filter(r=>r.projectCode===projectId);
}
function receiptsForInvoice(invoiceId){
  return DB.all('receipts').filter(r=>r.invoiceId===invoiceId);
}

// The ONE place a receipt's live figures are computed — never duplicated
// per surface (list / preview / PDF / Project Detail / Invoice Detail).
// `previouslyPaid` is the sum of every other non-voided payment on this
// project's ledger recorded BEFORE this one, in ledger (date) order — never
// a separate running total kept on the receipt itself, and never simply
// "current live Total Paid minus this amount" (that only happens to agree
// with ledger order when this payment is the most recent one; reprinting an
// older receipt after a later payment was recorded would otherwise fold the
// later payment into "Previously Paid" for the earlier receipt).
// `summary` (Project Value / current live Total Paid / current live
// Remaining) is still read straight from paymentSummaryFor() and is exactly
// right for the payment that is actually the ledger's latest one; for an
// as-of-this-payment "Total Paid so far" / "Remaining Balance so far" —
// which is what a point-in-time receipt document should print — use
// `previouslyPaid + amount` and `confirmedValue - that`, computed once in
// buildReceiptSummaryRows() below rather than trusting summary.totalPaid/
// summary.remaining directly.
function receiptPaymentAndSummary(receipt){
  const payment = receipt ? DB.find('payments', receipt.paymentId) : null;
  const summary = receipt && receipt.projectCode ? paymentSummaryFor(receipt.projectCode) : { confirmedValue:0, totalPaid:0, remaining:0 };
  const amount = payment ? Number(payment.amount)||0 : 0;
  // "Previously Paid" must be the ledger total strictly BEFORE this specific
  // payment, in the project's own chronological payment order (paymentsForProject
  // is date-sorted) — NOT summary.totalPaid - amount. Those two only agree when
  // this payment happens to be the most recent one; the moment a receipt is
  // reprinted/regenerated for an earlier payment after later payments exist
  // (e.g. reissuing the Deposit receipt after the Final Payment was already
  // recorded), totalPaid-amount would wrongly fold later payments into
  // "Previously Paid" for an earlier receipt. Ledger order (by date, then by
  // insertion order for same-day payments) is the correct source of truth.
  let previouslyPaid = 0;
  if(payment && receipt.projectCode){
    const ledger = paymentsForProject(receipt.projectCode);
    for(const p of ledger){
      if(p.id === payment.id) break;
      previouslyPaid += Number(p.amount)||0;
    }
    previouslyPaid = Math.max(0, Math.round(previouslyPaid * 100) / 100);
  }
  return { payment, summary, amount, previouslyPaid };
}

/* ---------------------------------------------------------------------- */
/* Generate Receipt — the ONE place a receipt is ever created. Always      */
/* from an existing recorded payment; never an independent money record.   */
/* ---------------------------------------------------------------------- */
function generateReceiptForPayment(paymentId, onDone){
  const payment = DB.find('payments', paymentId);
  if(!payment){ toast('Payment not found.', 'error'); return; }
  if(payment.voided){ toast('This payment has been voided — a receipt cannot be generated for it.', 'error'); return; }

  // Hard rule, mirrored by a database-level partial unique index on
  // (payment_id) WHERE status='Issued': a payment can have at most one
  // active receipt, for every role including Founder/Admin. No override.
  // The only way to a fresh receipt for a payment that already has one is
  // Cancel Receipt (Founder/Admin only) followed by Generate Receipt again.
  const existing = activeReceiptForPayment(paymentId);
  if(existing){
    toast(`A receipt (${existing.receiptNumber}) already exists for this payment.`, 'error');
    openReceiptPreview(existing.id, false);
    return;
  }

  // If every prior receipt for this payment is Cancelled, this is a
  // controlled reissue — link it for audit lineage and log it distinctly.
  const priorCancelled = receiptsForPayment(paymentId).filter(r=>r.status==='Cancelled');
  const isReissue = priorCancelled.length > 0;
  const mostRecentCancelled = isReissue
    ? priorCancelled.slice().sort((a,b)=> new Date(b.cancelledAt||b.createdAt||0) - new Date(a.cancelledAt||a.createdAt||0))[0]
    : null;

  const proj = payment.projectId ? DB.find('projects', payment.projectId) : null;
  const rec = {
    id: 'RC' + Date.now() + Math.floor(Math.random()*10000),
    receiptNumber: generateReceiptNumber(payment.projectId, payment.date),
    paymentId: payment.id,
    projectCode: payment.projectId,
    invoiceId: payment.invoiceId || null,
    clientName: proj ? proj.clientName : '',
    businessName: proj ? proj.businessName : '',
    receiptDate: todayLocalISO(),
    status: 'Issued',
    createdBy: CURRENT_USER.name,
    createdAt: new Date().toISOString(),
    cancelledBy: null, cancelledAt: null, cancelReason: null,
    reissueOfReceiptId: mostRecentCancelled ? mostRecentCancelled.id : null,
  };
  DB.upsert('receipts', rec);
  logActivity({ userName: CURRENT_USER.name, refType:'project', refId: payment.projectId||rec.id,
    refLabel: `${payment.projectId||''} — ${rec.businessName||rec.clientName}`.trim(),
    type: isReissue ? 'Receipt Reissued' : 'Receipt Generated',
    description: isReissue
      ? `${CURRENT_USER.name} reissued receipt ${rec.receiptNumber} for payment ${payment.paymentNumber||payment.id} (${moneyPrecise(payment.amount)}), replacing cancelled receipt ${mostRecentCancelled.receiptNumber}.`
      : `${CURRENT_USER.name} generated receipt ${rec.receiptNumber} for payment ${payment.paymentNumber||payment.id} (${moneyPrecise(payment.amount)}).` });

  toast(isReissue ? 'Receipt reissued.' : 'Receipt generated.', 'success');
  if(payment.invoiceId && typeof recalcInvoiceStatus==='function') recalcInvoiceStatus(payment.invoiceId);
  if(onDone) onDone(rec);
  refreshAfterLeadOrProjectChange(); // data-freshness fix — see openRecordPaymentModal in js/payments.js
  openReceiptPreview(rec.id, false);
}

/* ---------------------------------------------------------------------- */
/* Void Receipt — Founder/Admin only (canCancelReceipt()). A void requires  */
/* a reason (enforced here too, not just in the modal, so no call site can  */
/* skip it), and ALSO voids the underlying payment — this is the one lever  */
/* that correctly removes a voided receipt's money from EVERY active        */
/* financial total at once (spec: "Voided receipts must not count toward    */
/* any active financial total" — Invoice Received/Status/Balance, Project   */
/* Received Amount, Project Financial Summary, Dashboard Collected Revenue, */
/* and Sales Performance's Collected/commission-basis column ALL already    */
/* key off payment.voided — see totalPaidForProject()/paymentsForProject()  */
/* in js/data.js and js/dashboard.js's Collected Revenue). Neither the       */
/* receipt nor the payment is ever hard-deleted — both stay in their tables  */
/* permanently, visible in Receipts history / Activity Log / receipt detail,*/
/* with who voided it and when recorded on the receipt itself.              */
/* A genuine correction after a void is a NEW payment + NEW receipt (the     */
/* voided payment can no longer receive a fresh receipt — see the voided    */
/* check at the top of generateReceiptForPayment() above) — never a reissue  */
/* of the same payment, since that payment's money is now void.             */
/* ---------------------------------------------------------------------- */
function cancelReceipt(receiptId, reason){
  const rec = DB.find('receipts', receiptId);
  if(!rec) return null;
  reason = (reason||'').trim();
  if(!reason){ toast('A void reason is required.', 'error'); return null; }
  rec.status = 'Cancelled';
  rec.cancelledBy = CURRENT_USER.name;
  rec.cancelledAt = new Date().toISOString();
  rec.cancelReason = reason;
  DB.upsert('receipts', rec);
  // Void the underlying payment too (spec: exclude from every active total,
  // not just this invoice) — same voidedBy/reason, via the exact same
  // voidPaymentEntry() every other "void a payment" path in the app uses
  // (js/data.js), so Dashboard/Projects/Payments/Sales Performance all see
  // it the instant this receipt is voided, with no separate total to drift.
  const linkedPayment = rec.paymentId ? DB.find('payments', rec.paymentId) : null;
  if(linkedPayment && !linkedPayment.voided && typeof voidPaymentEntry==='function'){
    voidPaymentEntry(linkedPayment.id, { voidedBy: CURRENT_USER.name, reason: `Receipt ${rec.receiptNumber} voided: ${reason}` });
  }
  // Voiding a receipt must immediately recompute its invoice's Total Paid /
  // Balance / Status (spec: "Voided receipts must ... update invoice
  // balance/status again") — invoicePaymentsFor() excludes this payment the
  // moment its only active receipt is gone (and now also because the
  // payment itself is voided), so this recalculation is what actually moves
  // the invoice back to e.g. Partially Paid.
  if(linkedPayment && linkedPayment.invoiceId && typeof recalcInvoiceStatus==='function') recalcInvoiceStatus(linkedPayment.invoiceId);
  // Logged here (not by the caller) so every path to cancellation — the modal
  // below, or any future direct call — is captured exactly once, matching
  // generateReceiptForPayment's self-contained logging.
  logActivity({ userName: CURRENT_USER.name, refType:'project', refId: rec.projectCode||rec.id, refLabel: rec.receiptNumber,
    type:'Receipt Voided', description:`${CURRENT_USER.name} voided receipt ${rec.receiptNumber}. Reason: ${rec.cancelReason||'—'}` });
  return rec;
}

function openCancelReceiptModal(id, onDone){
  const rec = DB.find('receipts', id);
  if(!rec) return;
  if(!canCancelReceipt()){ toast('Only Founder/Admin can void a receipt.', 'error'); return; }
  const html = `
    <div class="modal-head"><h3>Void Receipt</h3><button class="modal-close" id="rcxClose">&times;</button></div>
    <div class="modal-body">
      <p style="margin-top:0">Void receipt <b>${escapeHtml(rec.receiptNumber)}</b>?</p>
      <p class="text-muted" style="font-size:12.5px">This also voids the underlying payment — both stay permanently visible in Receipts history and the Activity Log (never hard-deleted), but neither counts toward the invoice or project's received total, Dashboard Collected Revenue, or Sales Performance anymore, and the invoice's balance/status updates immediately. If the payment amount needs correcting, void this receipt and record a brand-new payment afterward (never edit an issued receipt's amount in place).</p>
      <div class="form-field"><label class="required">Reason</label><textarea id="rcx_reason" placeholder="e.g. Issued in error, amount needs correcting…"></textarea></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="rcxCancel">Back</button>
      <button class="btn btn-danger" id="rcxConfirm">Void Receipt</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#rcxClose').onclick = closeModal;
    overlay.querySelector('#rcxCancel').onclick = closeModal;
    overlay.querySelector('#rcxConfirm').onclick = ()=>{
      const reason = overlay.querySelector('#rcx_reason').value.trim();
      if(!reason){ toast('Please provide a reason.', 'error'); return; }
      cancelReceipt(rec.id, reason);
      toast('Receipt voided.', 'success');
      closeModal();
      if(onDone) onDone();
      refreshAfterLeadOrProjectChange(); // data-freshness fix — see openRecordPaymentModal in js/payments.js
    };
  }});
}

/* ---------------------------------------------------------------------- */
/* Shared "Generate Receipt" / "View Receipt" action — reused verbatim by   */
/* Payments (Record Payment confirmation), Project Detail (Payment         */
/* History), and Invoice Detail (Payments / Receipts). Every call site is   */
/* typeof-guarded from the OTHER module's side (receipts.js may not be      */
/* loaded), so this is the only place this markup/wiring is written.        */
/* ---------------------------------------------------------------------- */
function receiptActionButtonHtml(paymentId, cls){
  const existing = activeReceiptForPayment(paymentId);
  const btnCls = cls || 'btn btn-ghost btn-sm';
  return existing
    ? `<button class="${btnCls}" data-view-receipt="${paymentId}">View Receipt</button>`
    : `<button class="${btnCls}" data-generate-receipt="${paymentId}">Generate Receipt</button>`;
}
function receiptNumberCellHtml(paymentId){
  const existing = activeReceiptForPayment(paymentId);
  return existing ? escapeHtml(existing.receiptNumber) : '—';
}
function wireReceiptActionButtons(container, onDone){
  if(!container) return;
  container.querySelectorAll('[data-generate-receipt]').forEach(btn=>{
    btn.onclick = ()=> generateReceiptForPayment(btn.dataset.generateReceipt, onDone);
  });
  container.querySelectorAll('[data-view-receipt]').forEach(btn=>{
    btn.onclick = ()=>{
      const existing = activeReceiptForPayment(btn.dataset.viewReceipt);
      if(existing) openReceiptPreview(existing.id, false);
    };
  });
}

/* ---------------------------------------------------------------------- */
/* Receipts List Page                                                     */
/* ---------------------------------------------------------------------- */
let RCP_FILTER_STATE = { date:'all', project:'', paymentType:'', paymentMethod:'', search:'' };

function renderReceiptsPage(){
  const el = document.getElementById('pageContent');
  const projects = DB.all('projects');
  el.innerHTML = `
    <div class="flex-row" style="justify-content:flex-end;margin-bottom:14px">
      <button class="btn btn-primary btn-sm" id="rcpRecordBtn">+ Record Receipt</button>
    </div>
    <div class="filters-bar" style="margin-bottom:16px">
      <select id="rcpFltDate" class="sel">
        <option value="all" ${RCP_FILTER_STATE.date==='all'?'selected':''}>All Time</option>
        <option value="month" ${RCP_FILTER_STATE.date==='month'?'selected':''}>This Month</option>
        <option value="30d" ${RCP_FILTER_STATE.date==='30d'?'selected':''}>Last 30 Days</option>
        <option value="year" ${RCP_FILTER_STATE.date==='year'?'selected':''}>This Year</option>
      </select>
      <select id="rcpFltProject" class="sel">
        <option value="">All Projects</option>
        ${projects.map(p=>`<option value="${p.id}" ${RCP_FILTER_STATE.project===p.id?'selected':''}>${p.id} — ${escapeHtml(p.businessName)}</option>`).join('')}
      </select>
      <select id="rcpFltType" class="sel">
        <option value="">All Payment Types</option>
        ${PAYMENT_TYPES_ALL.map(t=>`<option value="${t}" ${RCP_FILTER_STATE.paymentType===t?'selected':''}>${t}</option>`).join('')}
      </select>
      <select id="rcpFltMethod" class="sel">
        <option value="">All Payment Methods</option>
        ${PAYMENT_METHODS_ALL.map(m=>`<option value="${m}" ${RCP_FILTER_STATE.paymentMethod===m?'selected':''}>${m}</option>`).join('')}
      </select>
      <div class="search-box">
        ${icon('search')}
        <input type="text" id="rcpFltSearch" placeholder="Search receipt #, client, business, project, invoice…" value="${escapeHtml(RCP_FILTER_STATE.search)}">
      </div>
    </div>
    <div id="rcpTableWrap"></div>
  `;
  document.getElementById('rcpRecordBtn').onclick = ()=> openRecordReceiptModal(()=> renderRcpTable());
  document.getElementById('rcpFltDate').onchange = (e)=>{ RCP_FILTER_STATE.date=e.target.value; renderRcpTable(); };
  document.getElementById('rcpFltProject').onchange = (e)=>{ RCP_FILTER_STATE.project=e.target.value; renderRcpTable(); };
  document.getElementById('rcpFltType').onchange = (e)=>{ RCP_FILTER_STATE.paymentType=e.target.value; renderRcpTable(); };
  document.getElementById('rcpFltMethod').onchange = (e)=>{ RCP_FILTER_STATE.paymentMethod=e.target.value; renderRcpTable(); };
  let searchDebounce;
  document.getElementById('rcpFltSearch').oninput = (e)=>{
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(()=>{ RCP_FILTER_STATE.search=e.target.value; renderRcpTable(); }, 200);
  };
  renderRcpTable();
}

function rcpWithinDateFilter(dateStr){
  if(RCP_FILTER_STATE.date==='all') return true;
  if(!dateStr) return false;
  const d = new Date(dateStr);
  if(isNaN(d)) return false;
  const now = new Date();
  if(RCP_FILTER_STATE.date==='month') return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth();
  if(RCP_FILTER_STATE.date==='30d'){ const cutoff=new Date(now); cutoff.setDate(cutoff.getDate()-30); return d>=cutoff && d<=now; }
  if(RCP_FILTER_STATE.date==='year') return d.getFullYear()===now.getFullYear();
  return true;
}

function filteredReceipts(){
  const f = RCP_FILTER_STATE;
  const q = f.search.trim().toLowerCase();
  return DB.all('receipts').map(r=>({
    r, payment: DB.find('payments', r.paymentId), invoice: r.invoiceId ? DB.find('invoices', r.invoiceId) : null,
  })).filter(({r,payment,invoice})=>{
    if(f.project && r.projectCode!==f.project) return false;
    if(f.paymentType && (!payment || payment.type!==f.paymentType)) return false;
    if(f.paymentMethod && (!payment || payment.method!==f.paymentMethod)) return false;
    if(!rcpWithinDateFilter(r.receiptDate)) return false;
    if(q){
      const hay = `${r.receiptNumber} ${r.clientName} ${r.businessName} ${r.projectCode} ${invoice?invoice.invoiceNumber:''}`.toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  }).sort((a,b)=> new Date(b.r.createdAt||b.r.receiptDate) - new Date(a.r.createdAt||a.r.receiptDate));
}

function renderRcpTable(){
  const wrap = document.getElementById('rcpTableWrap');
  if(!wrap) return;
  const rows = filteredReceipts();
  // True empty state (spec: "Empty state") — ZERO receipts exist at all,
  // regardless of filters. A filtered-to-empty result (receipts DO exist,
  // just none match the current filters) keeps the old, filter-specific
  // copy below instead.
  const noReceiptsAtAll = DB.all('receipts').length === 0;
  const emptyRowHtml = noReceiptsAtAll
    ? `<tr><td colspan="11"><div class="empty-row" style="text-align:center;padding:28px 12px">
         <p style="margin:0 0 14px">No receipts recorded yet.<br>Record payment from an invoice or create a project receipt.</p>
         <div class="flex-row" style="justify-content:center;gap:8px">
           <button class="btn btn-primary btn-sm" id="rcpEmptyRecord">Record Receipt</button>
           <button class="btn btn-secondary btn-sm" id="rcpEmptyViewInvoices">View Invoices</button>
         </div>
       </div></td></tr>`
    : `<tr><td colspan="11"><div class="empty-row">No receipts match the current filters.</div></td></tr>`;
  wrap.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h3>Receipts</h3><span class="text-muted" style="font-size:12px">${rows.length} receipt${rows.length===1?'':'s'}</span></div>
      <div class="panel-body pad">
        <div class="table-wrap scroll-x">
          <table class="data-table">
            <thead>
              <tr>
                <th>Receipt No.</th><th>Date</th><th>Project Code</th><th>Client / Business</th>
                <th>Related Invoice</th><th>Payment Type</th><th>Payment Method</th>
                <th>Amount Received</th><th>Recorded By</th><th>Status</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${rows.length ? rows.map(({r,payment,invoice})=>`
                <tr>
                  <td class="cell-link" data-view="${r.id}">${escapeHtml(r.receiptNumber)}</td>
                  <td>${fmtDate(r.receiptDate)}</td>
                  <td>${escapeHtml(r.projectCode||'—')}</td>
                  <td>${escapeHtml(r.clientName||'—')}<div class="cell-sub">${escapeHtml(r.businessName||'')}</div></td>
                  <td>${invoice?escapeHtml(invoice.invoiceNumber):'—'}</td>
                  <td>${escapeHtml(payment?payment.type:'—')}</td>
                  <td>${escapeHtml(payment?(payment.method||'—'):'—')}</td>
                  <td class="cell-strong">${moneyPrecise(payment?payment.amount:0)}</td>
                  <td>${escapeHtml(payment?(payment.recordedBy||'—'):'—')}</td>
                  <td>${statusBadge(r.status)}</td>
                  <td>
                    <div class="flex-row" style="gap:2px;flex-wrap:wrap">
                      <button class="btn btn-ghost btn-sm" data-view="${r.id}">View</button>
                      <button class="btn btn-ghost btn-sm" data-pdf="${r.id}">Print / Download Receipt</button>
                      ${r.status==='Issued' && canCancelReceipt() ? `<button class="btn btn-ghost btn-sm" style="color:var(--red)" data-cancel="${r.id}">Void</button>` : ''}
                    </div>
                  </td>
                </tr>`).join('') : emptyRowHtml}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
  wrap.querySelectorAll('[data-view]').forEach(x=> x.onclick = ()=> openReceiptPreview(x.dataset.view, false));
  wrap.querySelectorAll('[data-pdf]').forEach(x=> x.onclick = ()=> openReceiptPreview(x.dataset.pdf, true));
  wrap.querySelectorAll('[data-cancel]').forEach(x=> x.onclick = ()=> openCancelReceiptModal(x.dataset.cancel, ()=> renderRcpTable()));
  const emptyRecordBtn = wrap.querySelector('#rcpEmptyRecord');
  if(emptyRecordBtn) emptyRecordBtn.onclick = ()=> openRecordReceiptModal(()=> renderRcpTable());
  const emptyViewInvoicesBtn = wrap.querySelector('#rcpEmptyViewInvoices');
  if(emptyViewInvoicesBtn) emptyViewInvoicesBtn.onclick = ()=>{ window.location.hash = '#invoices'; };
}

/* ---------------------------------------------------------------------- */
/* PDF / Print — reuses the Quotations/Invoices A4 pagination engine        */
/* verbatim (measureQuoteDoc / packQuoteSections / renderQuotePagesHtml /   */
/* printQuoteDocFromContainer, all defined in js/quotations.js and          */
/* completely content-agnostic). Only the section content below is new.    */
/* ---------------------------------------------------------------------- */
function receiptDocTitle(receipt){
  return receipt.status==='Cancelled' ? 'RECEIPT — CANCELLED' : 'RECEIPT';
}
function receiptFullHeaderHtml(receipt){
  return `<div class="quote-doc-head">
    <div class="quote-doc-brand">
      <img class="quote-doc-logo" src="../assets/branding/bizweb-kh-logo-main-print.png" alt="BizWeb KH">
      <div class="text-muted" style="font-size:11px">Tel: 017 400 044 | Telegram: @BizWebKH | www.bizwebkh.com</div>
    </div>
    <div class="quote-doc-meta">
      <div class="khmer-text" style="font-size:13px;color:var(--blue)">បង្កាន់ដៃទទួលប្រាក់</div>
      <div><b>${escapeHtml(receiptDocTitle(receipt))}</b> ${statusBadge(receipt.status)}</div>
      <div>Receipt No: ${escapeHtml(receipt.receiptNumber)}</div>
    </div>
  </div>`;
}
function receiptContHeaderHtml(receipt){
  return `<div class="quote-doc-cont-head"><b>BizWeb KH</b> — ${escapeHtml(receiptDocTitle(receipt))} · Receipt No: ${escapeHtml(receipt.receiptNumber)}</div>`;
}

function buildReceiptSections(receipt){
  const { payment, summary, amount, previouslyPaid } = receiptPaymentAndSummary(receipt);
  const proj = receipt.projectCode ? DB.find('projects', receipt.projectCode) : null;
  const invoice = receipt.invoiceId ? DB.find('invoices', receipt.invoiceId) : null;
  const sections = [];

  const infoRows = [
    `<tr><th>${bilingualLabel('លេខបង្កាន់ដៃ','Receipt No.')}</th><td>${escapeHtml(receipt.receiptNumber)}</td></tr>`,
    `<tr><th>${bilingualLabel('កាលបរិច្ឆេទ','Receipt Date')}</th><td>${fmtDate(receipt.receiptDate)}</td></tr>`,
    `<tr><th>${bilingualLabel('ទទួលបានពី','Received From')}</th><td>${escapeHtml(receipt.clientName||'—')}</td></tr>`,
  ];
  if(receipt.businessName && String(receipt.businessName).trim()){
    infoRows.push(`<tr><th>${bilingualLabel('អាជីវកម្ម','Business')}</th><td>${escapeHtml(receipt.businessName)}</td></tr>`);
  }
  infoRows.push(`<tr><th>${bilingualLabel('គម្រោង','Project')}</th><td>${escapeHtml(receipt.projectCode||'—')}${proj?' — '+escapeHtml(serviceDisplayName(proj.projectType)):''}</td></tr>`);
  infoRows.push(`<tr><th>Related Invoice</th><td>${invoice?escapeHtml(invoice.invoiceNumber):'—'}</td></tr>`);
  infoRows.push(`<tr><th>Payment Type</th><td>${escapeHtml(payment?payment.type:'—')}</td></tr>`);
  infoRows.push(`<tr><th>Payment Method</th><td>${escapeHtml(payment?(payment.method||'—'):'—')}</td></tr>`);
  if(payment && payment.reference) infoRows.push(`<tr><th>Reference</th><td>${escapeHtml(payment.reference)}</td></tr>`);
  sections.push({ id:'info', kind:'block', html:`<table class="quote-doc-infotable">${infoRows.join('')}</table>` });

  sections.push({ id:'amount', kind:'block',
    html:`<h4 class="quote-doc-h">Amount Received</h4><p style="font-size:22px;font-weight:800;color:var(--blue);margin:0">${moneyPrecise(amount)}</p>` });

  if(payment && payment.note){
    sections.push({ id:'note', kind:'block',
      html:`<h4 class="quote-doc-h">Description / Note</h4><p style="font-size:12.5px;margin:0;white-space:pre-wrap">${escapeHtml(payment.note)}</p>` });
  }

  // Total Paid / Remaining Balance on the receipt document are AS OF THIS
  // PAYMENT (previouslyPaid + amount), not summary.totalPaid/summary.remaining
  // (the project's CURRENT live totals). Those two only agree when this
  // payment is the ledger's most recent one — printing/reprinting a receipt
  // for an earlier payment after later payments exist must still show the
  // running balance at the moment this payment was received, exactly like a
  // real, dated receipt would, never a number that silently includes
  // payments that hadn't happened yet.
  const totalPaidAsOf = Math.round((previouslyPaid + amount) * 100) / 100;
  const remainingAsOf = Math.max(0, Math.round((summary.confirmedValue - totalPaidAsOf) * 100) / 100);
  sections.push({ id:'summary', kind:'block',
    html:`<h4 class="quote-doc-h">Payment Summary</h4><table class="quote-doc-table qc-mini-table" style="max-width:380px">
      <tbody>
        <tr><td>Project Value</td><td style="text-align:right">${moneyPrecise(summary.confirmedValue)}</td></tr>
        <tr><td>Previously Paid</td><td style="text-align:right">${moneyPrecise(previouslyPaid)}</td></tr>
        <tr><td>Amount Received</td><td style="text-align:right">${moneyPrecise(amount)}</td></tr>
        <tr><td><b>Total Paid</b></td><td style="text-align:right"><b>${moneyPrecise(totalPaidAsOf)}</b></td></tr>
        <tr><td><b>Remaining Balance</b></td><td style="text-align:right"><b>${moneyPrecise(remainingAsOf)}</b></td></tr>
      </tbody>
    </table>` });

  sections.push({ id:'recordedby', kind:'block',
    html:`<p style="font-size:12px;color:var(--muted);margin:6px 0 0">Recorded By: ${escapeHtml(payment?(payment.recordedBy||'—'):'—')}</p>` });

  if(receipt.status==='Cancelled'){
    sections.push({ id:'cancelled', kind:'block',
      html:`<p style="font-size:12.5px;color:var(--red);font-weight:700;margin:10px 0 0">This receipt was cancelled by ${escapeHtml(receipt.cancelledBy||'—')} on ${fmtDate(receipt.cancelledAt)}${receipt.cancelReason?': '+escapeHtml(receipt.cancelReason):''}.</p>` });
  }

  sections.push({ id:'accept', kind:'block',
    html:`<div class="quote-doc-accept">
      <div class="quote-doc-accept-client">
        <div class="sig-line"></div>
        <span>Client / Payer Signature</span>
      </div>
      <div class="quote-doc-accept-rep">
        <img class="quote-doc-accept-sig" src="../assets/signature/chhean-poli-signature.png" alt="Authorized Signature" width="194" height="68">
        <div class="sig-line"></div>
        <span>BizWeb KH Representative</span>
      </div>
    </div>` });

  return sections.filter(sec=> sec.kind!=='block' || sec.html);
}

async function buildReceiptPagesHtml(receipt){
  try{ if(document.fonts && document.fonts.ready) await document.fonts.ready; }catch(e){}
  const sections = buildReceiptSections(receipt);
  const headerFullHtml = receiptFullHeaderHtml(receipt);
  const headerContHtml = receiptContHeaderHtml(receipt);
  const { measured, headerFullHeight, headerContHeight } = measureQuoteDoc(sections, headerFullHtml, headerContHtml);
  const pageContentHeightPx = qdocMm(QDOC_PAGE_H_MM - 2*QDOC_MARGIN_MM);
  const firstBudget = pageContentHeightPx - headerFullHeight;
  const contBudget = pageContentHeightPx - headerContHeight;
  const pages = packQuoteSections(measured, { firstBudget, contBudget });
  const html = `<div class="quote-pages-wrap">${renderQuotePagesHtml(pages, receipt, headerFullHtml, headerContHtml)}</div>`;
  return { html, pageCount: pages.length };
}

let RCP_PREVIEW_TOKEN = 0;
async function paintReceiptPreview(containerEl, receipt, onDone){
  const token = ++RCP_PREVIEW_TOKEN;
  const { html, pageCount } = await buildReceiptPagesHtml(receipt);
  if(token !== RCP_PREVIEW_TOKEN) return;
  if(!containerEl || !document.body.contains(containerEl)) return;
  containerEl.innerHTML = html;
  if(onDone) onDone(pageCount);
}

// View / Download-PDF / Reprint / Cancel all live in this one modal (spec
// ACTIONS list) — "Reprint" and "Download/Print PDF" both trigger the exact
// same printQuoteDocFromContainer() call (there's no meaningful difference
// between "printing it the first time" and "reprinting it later").
function openReceiptPreview(id, autoPrint=false){
  const rec = DB.find('receipts', id);
  if(!rec) return;
  const html = `
    <div class="modal-head"><h3>Receipt Preview</h3><span id="rpvPageCount" class="text-muted" style="font-size:12px;margin-left:8px"></span><button class="modal-close" id="rpvClose">&times;</button></div>
    <div class="modal-body" style="background:#eef1f6;padding:20px" id="rpvPreviewBody">
      <div class="text-muted" style="padding:60px;text-align:center">Rendering preview…</div>
    </div>
    <div class="modal-foot">
      ${rec.status==='Issued' && canCancelReceipt() ? `<button class="btn btn-danger" id="rpvCancel" style="margin-right:auto">Cancel Receipt</button>` : ''}
      <button class="btn btn-secondary" id="rpvClose2">Close</button>
      <button class="btn btn-outline" id="rpvReprint" disabled>Reprint</button>
      <button class="btn btn-primary" id="rpvPrint" disabled>Download PDF (Print)</button>
    </div>
  `;
  openModal(html, { large:true, onMount:(overlay)=>{
    overlay.querySelector('#rpvClose').onclick = closeModal;
    overlay.querySelector('#rpvClose2').onclick = closeModal;
    const cancelBtn = overlay.querySelector('#rpvCancel');
    if(cancelBtn) cancelBtn.onclick = ()=> openCancelReceiptModal(rec.id, ()=> openReceiptPreview(rec.id, false));
    const body = overlay.querySelector('#rpvPreviewBody');
    const printBtn = overlay.querySelector('#rpvPrint');
    const reprintBtn = overlay.querySelector('#rpvReprint');
    printBtn.onclick = ()=> printQuoteDocFromContainer(body);
    reprintBtn.onclick = ()=> printQuoteDocFromContainer(body);
    paintReceiptPreview(body, rec, (pageCount)=>{
      printBtn.disabled = false;
      reprintBtn.disabled = false;
      const pc = overlay.querySelector('#rpvPageCount');
      if(pc) pc.textContent = `${pageCount} page${pageCount===1?'':'s'}`;
      if(autoPrint) printQuoteDocFromContainer(body);
    });
  }});
}

/* ---------------------------------------------------------------------- */
/* "+ Record Receipt" — Receipts page entry point (spec: "Receipt creation */
/* from Receipts page"). A thin selection wizard only: it never records a   */
/* payment or generates a receipt itself — once the project (and, for Mode  */
/* 1, the invoice) are chosen, it hands off to openRecordPaymentModal()      */
/* (js/payments.js) with { autoReceipt:true }, the exact same combined      */
/* "Record Payment & Generate Receipt" action already used from an          */
/* Invoice's own Record Payment button — so the actual form/validation/     */
/* overpayment-guard/receipt-generation logic is never duplicated here.     */
/* ---------------------------------------------------------------------- */
function openRecordReceiptModal(onDone){
  let mode = 'invoice'; // 'invoice' | 'none'
  let selectedProject = '';
  let selectedInvoice = '';
  let showAllInvoices = false;

  const render = (overlay)=>{
    const projects = DB.all('projects');
    const outstanding = selectedProject ? outstandingInvoicesForProject(selectedProject) : [];
    const allForProject = selectedProject ? DB.all('invoices').filter(i=> i.projectCode===selectedProject && i.status!=='Cancelled') : [];
    const invoiceChoices = showAllInvoices ? allForProject : outstanding;

    overlay.querySelector('.modal-body').innerHTML = `
      <div class="flex-row" style="gap:8px;margin-bottom:16px">
        <button class="btn ${mode==='invoice'?'btn-primary':'btn-secondary'} btn-sm" id="rrModeInvoice" style="flex:1">1. Against an Invoice — Recommended</button>
        <button class="btn ${mode==='none'?'btn-primary':'btn-secondary'} btn-sm" id="rrModeNone" style="flex:1">2. Project Payment without Invoice</button>
      </div>
      <div class="form-field"><label class="required">Project</label>
        <select id="rr_project">
          <option value="">— Select Project —</option>
          ${projects.map(p=>`<option value="${p.id}" ${selectedProject===p.id?'selected':''}>${p.id} — ${escapeHtml(p.businessName)}</option>`).join('')}
        </select>
      </div>
      ${mode==='invoice' ? `
        ${selectedProject ? (invoiceChoices.length ? `
          <div class="form-field"><label class="required">Invoice</label>
            <select id="rr_invoice">
              <option value="">— Select Invoice —</option>
              ${invoiceChoices.map(i=>`<option value="${i.id}" ${selectedInvoice===i.id?'selected':''}>${escapeHtml(i.invoiceNumber)} — Balance ${moneyPrecise(invoiceTotals(i).balance)}</option>`).join('')}
            </select>
          </div>
          <label class="text-muted" style="font-size:12px;display:flex;align-items:center;gap:6px;margin:-6px 0 14px">
            <input type="checkbox" id="rr_showAll" ${showAllInvoices?'checked':''}> Show all invoices (including fully paid)
          </label>
        ` : `<p class="text-muted" style="font-size:12.5px">This project has no outstanding invoices.${!outstanding.length && allForProject.length ? ' <span id="rr_showAllLink" class="cell-link">Show all invoices</span> to pick one anyway.' : ''}</p>`) : `<p class="text-muted" style="font-size:12.5px">Select a project to see its invoices.</p>`}
      ` : `
        <p class="text-muted" style="font-size:12px;background:rgba(217,138,18,.1);border:1px solid #d98a12;border-radius:var(--radius-sm);padding:8px 10px;margin:0 0 4px">This receipt will not be linked to an invoice. Use this only when payment was received without an invoice.</p>
      `}
    `;
    overlay.querySelector('#rrModeInvoice').onclick = ()=>{ mode='invoice'; render(overlay); };
    overlay.querySelector('#rrModeNone').onclick = ()=>{ mode='none'; selectedInvoice=''; render(overlay); };
    overlay.querySelector('#rr_project').onchange = (e)=>{ selectedProject=e.target.value; selectedInvoice=''; showAllInvoices=false; render(overlay); };
    const invoiceSel = overlay.querySelector('#rr_invoice');
    if(invoiceSel) invoiceSel.onchange = (e)=>{ selectedInvoice=e.target.value; };
    const showAllCb = overlay.querySelector('#rr_showAll');
    if(showAllCb) showAllCb.onchange = (e)=>{ showAllInvoices=e.target.checked; render(overlay); };
    const showAllLink = overlay.querySelector('#rr_showAllLink');
    if(showAllLink) showAllLink.onclick = ()=>{ showAllInvoices=true; render(overlay); };

    const continueBtn = overlay.querySelector('#rrContinue');
    continueBtn.disabled = !selectedProject || (mode==='invoice' && !selectedInvoice);
  };

  const html = `
    <div class="modal-head"><h3>Record Receipt</h3><button class="modal-close" id="rrClose">&times;</button></div>
    <div class="modal-body"></div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="rrCancel">Cancel</button>
      <button class="btn btn-primary" id="rrContinue">Continue</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#rrClose').onclick = closeModal;
    overlay.querySelector('#rrCancel').onclick = closeModal;
    render(overlay);
    // Re-wire Continue's own handler every render() call re-renders the modal
    // body but the modal-foot buttons are static, so this single listener
    // (reading the closure's current mode/selectedProject/selectedInvoice at
    // click time) stays correct across every re-render above.
    overlay.querySelector('#rrContinue').onclick = ()=>{
      if(!selectedProject) return;
      if(mode==='invoice' && !selectedInvoice) return;
      closeModal();
      openRecordPaymentModal(
        selectedProject,
        onDone,
        mode==='invoice' ? selectedInvoice : null,
        { autoReceipt:true, forceNoInvoice: mode==='none' }
      );
    };
  }});
}
