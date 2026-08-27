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
      <div class="kpi-card"><div class="kpi-value">${money(totalProjectValue)}</div><div class="kpi-label">Total Project Value</div></div>
      <div class="kpi-card"><div class="kpi-value" style="color:var(--green)">${money(totalCollected)}</div><div class="kpi-label">Total Collected</div></div>
      <div class="kpi-card"><div class="kpi-value" style="color:var(--red)">${money(totalOutstanding)}</div><div class="kpi-label">Total Outstanding</div></div>
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
                  <td class="cell-strong">${money(s.confirmedValue)}</td>
                  <td style="font-weight:700;color:${s.totalPaid>0?'var(--green)':'inherit'}">${money(s.totalPaid)}</td>
                  <td style="font-weight:700;color:#d98a12">${money(s.remaining)}</td>
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
                  <td class="cell-strong">${money(p.amount)}</td>
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

function openRecordPaymentModal(projectId, onDone){
  const proj = DB.find('projects', projectId);
  if(!proj) return;
  const summary = paymentSummaryFor(projectId);
  const hasDeposit = paymentsForProject(projectId).some(p=>p.type==='Deposit');
  const suggestedNumber = nextPaymentNumberLabel(projectId);

  const html = `
    <div class="modal-head"><h3>Record Payment</h3><button class="modal-close" id="rpClose">&times;</button></div>
    <div class="modal-body">
      <p class="text-muted" style="margin-top:0;font-size:13px">${proj.id} — ${escapeHtml(proj.businessName)} · Project Value ${money(summary.confirmedValue)} · Remaining: <b>${money(summary.remaining)}</b></p>
      <div class="form-grid">
        <div class="form-field"><label class="required">Payment Number</label><input id="rp_number" value="${suggestedNumber}"></div>
        <div class="form-field"><label class="required">Payment Type</label>
          <select id="rp_type">
            ${!hasDeposit ? '<option value="Deposit">Deposit</option>' : ''}
            <option value="Partial Payment">Partial Payment</option>
            <option value="Final Payment">Final Payment</option>
            <option value="Renewal">Renewal</option>
            <option value="Other">Other</option>
          </select>
        </div>
        <div class="form-field"><label class="required">Amount ($)</label><input type="number" id="rp_amount" value="${!hasDeposit ? Math.round(summary.confirmedValue*proj.depositPct/100) : summary.remaining}" min="0.01" step="0.01"></div>
        <div class="form-field"><label class="required">Payment Date</label><input type="date" id="rp_date" value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="form-field"><label class="required">Payment Method</label><select id="rp_method">${PAYMENT_METHODS.map(m=>`<option>${m}</option>`).join('')}</select></div>
        <div class="form-field"><label>Reference</label><input id="rp_ref" placeholder="e.g. bank txn ref, receipt #…"></div>
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
    overlay.querySelector('#rpSave').onclick = ()=>{
      const paymentNumber = overlay.querySelector('#rp_number').value.trim() || suggestedNumber;
      const type = overlay.querySelector('#rp_type').value;
      const amount = Number(overlay.querySelector('#rp_amount').value)||0;
      const date = overlay.querySelector('#rp_date').value;
      const method = overlay.querySelector('#rp_method').value;
      const reference = overlay.querySelector('#rp_ref').value.trim();
      const notes = overlay.querySelector('#rp_notes').value.trim();
      if(amount<=0 || !date){ toast('Please enter a valid amount and date.', 'error'); return; }

      // Never let Total Paid silently exceed Project Value — warn and
      // require explicit confirmation rather than blocking outright, in
      // case the overage is genuinely intentional (e.g. a renewal payment
      // recorded against the same project).
      const currentSummary = paymentSummaryFor(projectId);
      if(amount > currentSummary.remaining + 0.004){
        const proceed = confirm(
          `This payment is greater than the remaining project balance.\n\n` +
          `Remaining Balance: ${money(currentSummary.remaining)}\n` +
          `Amount Entered: ${money(amount)}\n\n` +
          `Record this payment anyway?`
        );
        if(!proceed) return;
      }

      recordPaymentEntry({ projectId, paymentNumber, amount, date, method, type, reference, note: notes, userName: CURRENT_USER.name });
      logActivity({ userName: CURRENT_USER.name, refType:'project', refId: proj.id, refLabel:`${proj.id} — ${proj.businessName}`,
        type: type==='Deposit' ? 'Deposit Recorded' : 'Payment Recorded',
        description:`${CURRENT_USER.name} recorded payment: ${money(amount)} (${type}, ${paymentNumber}) for project ${proj.id}`,
        remark: [reference, notes].filter(Boolean).join(' — ') || null });

      closeModal();
      const newSummary = paymentSummaryFor(projectId);

      // Section 11: never silently change delivery status — offer it instead.
      if(type==='Deposit' && proj.stage==='Confirmed'){
        confirmStageOffer(proj, 'Deposit Paid', 'Payment recorded successfully. Update Project Status to "Deposit Paid"?');
      } else if(newSummary.remaining<=0 && proj.stage==='Final Payment Pending'){
        confirmStageOffer(proj, 'Completed', 'Payment recorded successfully. Update Project Status to "Completed"?');
      } else {
        toast('Payment recorded.', 'success');
      }

      if(onDone) onDone();
      if(currentRoute()==='payments') renderPaymentsPage();
      if(currentRoute()==='dashboard') router();
    };
  }});
}

// Offers (never forces) a follow-on project-stage change right after a
// payment is recorded, per the "Confirmed → Deposit Paid → ... → Completed"
// workflow rule: payments never silently change delivery status.
function confirmStageOffer(proj, suggestedStage, message){
  toast('Payment recorded.', 'success');
  setTimeout(()=>{
    if(confirm(message)) applyProjectStageChange(proj, suggestedStage);
  }, 150);
}
