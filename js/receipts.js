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
  if(onDone) onDone(rec);
  refreshAfterLeadOrProjectChange(); // data-freshness fix — see openRecordPaymentModal in js/payments.js
  openReceiptPreview(rec.id, false);
}

/* ---------------------------------------------------------------------- */
/* Cancel Receipt — Founder/Admin only. Never touches the underlying       */
/* payment — cancelling a receipt is purely a document-lifecycle action.   */
/* Re-issuing after a real payment-amount correction is a controlled       */
/* workflow: cancel the old receipt, then Generate Receipt again.          */
/* ---------------------------------------------------------------------- */
function cancelReceipt(receiptId, reason){
  const rec = DB.find('receipts', receiptId);
  if(!rec) return null;
  rec.status = 'Cancelled';
  rec.cancelledBy = CURRENT_USER.name;
  rec.cancelledAt = new Date().toISOString();
  rec.cancelReason = reason || '';
  DB.upsert('receipts', rec);
  // Logged here (not by the caller) so every path to cancellation — the modal
  // below, or any future direct call — is captured exactly once, matching
  // generateReceiptForPayment's self-contained logging.
  logActivity({ userName: CURRENT_USER.name, refType:'project', refId: rec.projectCode||rec.id, refLabel: rec.receiptNumber,
    type:'Receipt Cancelled', description:`${CURRENT_USER.name} cancelled receipt ${rec.receiptNumber}. Reason: ${rec.cancelReason||'—'}` });
  return rec;
}

function openCancelReceiptModal(id, onDone){
  const rec = DB.find('receipts', id);
  if(!rec) return;
  if(!canCancelReceipt()){ toast('Only Founder/Admin can cancel a receipt.', 'error'); return; }
  const html = `
    <div class="modal-head"><h3>Cancel Receipt</h3><button class="modal-close" id="rcxClose">&times;</button></div>
    <div class="modal-body">
      <p style="margin-top:0">Cancel receipt <b>${escapeHtml(rec.receiptNumber)}</b>?</p>
      <p class="text-muted" style="font-size:12.5px">This does not affect the underlying payment record — the payment stays in the ledger untouched. If the payment amount needs correcting, cancel this receipt and generate a new one afterward (never edit an issued receipt's amount in place).</p>
      <div class="form-field"><label class="required">Reason</label><textarea id="rcx_reason" placeholder="e.g. Issued in error, amount needs correcting…"></textarea></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="rcxCancel">Back</button>
      <button class="btn btn-danger" id="rcxConfirm">Cancel Receipt</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#rcxClose').onclick = closeModal;
    overlay.querySelector('#rcxCancel').onclick = closeModal;
    overlay.querySelector('#rcxConfirm').onclick = ()=>{
      const reason = overlay.querySelector('#rcx_reason').value.trim();
      if(!reason){ toast('Please provide a reason.', 'error'); return; }
      cancelReceipt(rec.id, reason);
      toast('Receipt cancelled.', 'success');
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
        ${PAYMENT_TYPES.map(t=>`<option value="${t}" ${RCP_FILTER_STATE.paymentType===t?'selected':''}>${t}</option>`).join('')}
      </select>
      <select id="rcpFltMethod" class="sel">
        <option value="">All Payment Methods</option>
        ${PAYMENT_METHODS.map(m=>`<option value="${m}" ${RCP_FILTER_STATE.paymentMethod===m?'selected':''}>${m}</option>`).join('')}
      </select>
      <div class="search-box">
        ${icon('search')}
        <input type="text" id="rcpFltSearch" placeholder="Search receipt #, client, business, project, invoice…" value="${escapeHtml(RCP_FILTER_STATE.search)}">
      </div>
    </div>
    <div id="rcpTableWrap"></div>
  `;
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
                      <button class="btn btn-ghost btn-sm" data-pdf="${r.id}">PDF</button>
                      ${r.status==='Issued' && canCancelReceipt() ? `<button class="btn btn-ghost btn-sm" style="color:var(--red)" data-cancel="${r.id}">Cancel</button>` : ''}
                    </div>
                  </td>
                </tr>`).join('') : `<tr><td colspan="11"><div class="empty-row">No receipts match the current filters.</div></td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
  wrap.querySelectorAll('[data-view]').forEach(x=> x.onclick = ()=> openReceiptPreview(x.dataset.view, false));
  wrap.querySelectorAll('[data-pdf]').forEach(x=> x.onclick = ()=> openReceiptPreview(x.dataset.pdf, true));
  wrap.querySelectorAll('[data-cancel]').forEach(x=> x.onclick = ()=> openCancelReceiptModal(x.dataset.cancel, ()=> renderRcpTable()));
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
