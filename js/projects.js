/* ==========================================================================
   BizWeb KH CRM — projects.js
   Projects table, project detail/history modal, stage-change flow, and
   lead → project conversion (assigns a project code, keeps lead linked).
   ========================================================================== */

let PROJECTS_FILTER_STATE = { search:'', stage:'', industry:'', type:'', sales:'' };

function renderProjectsPage(){
  const el = document.getElementById('pageContent');
  el.innerHTML = `
    <div class="filters-bar">
      <div class="search-box">
        ${icon('search')}
        <input type="text" id="projSearch" placeholder="Search project code, client, or business…" value="${escapeHtml(PROJECTS_FILTER_STATE.search)}">
      </div>
      <select id="pFltStage" class="sel"><option value="">All Statuses</option>${PROJECT_STAGES.map(s=>`<option ${PROJECTS_FILTER_STATE.stage===s?'selected':''}>${s}</option>`).join('')}</select>
      <select id="pFltIndustry" class="sel"><option value="">All Industries</option>${INDUSTRIES.map(s=>`<option ${PROJECTS_FILTER_STATE.industry===s?'selected':''}>${s}</option>`).join('')}</select>
      <select id="pFltType" class="sel"><option value="">All Project Types</option>${SERVICE_TYPES.map(s=>`<option value="${escapeHtml(s)}" ${PROJECTS_FILTER_STATE.type===s?'selected':''}>${escapeHtml(serviceDisplayName(s))}</option>`).join('')}</select>
      <select id="pFltSales" class="sel"><option value="">All Sales</option>${salesOwnersList().map(s=>`<option ${PROJECTS_FILTER_STATE.sales===s?'selected':''}>${s}</option>`).join('')}</select>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="createProjectBtn">${icon('grid')} + Create Direct Project</button>
    </div>
    <div id="projectsTableWrap"></div>
  `;
  document.getElementById('projSearch').oninput = (e)=>{ PROJECTS_FILTER_STATE.search=e.target.value; renderProjectsTable(); };
  document.getElementById('pFltStage').onchange = (e)=>{ PROJECTS_FILTER_STATE.stage=e.target.value; renderProjectsTable(); };
  document.getElementById('pFltIndustry').onchange = (e)=>{ PROJECTS_FILTER_STATE.industry=e.target.value; renderProjectsTable(); };
  document.getElementById('pFltType').onchange = (e)=>{ PROJECTS_FILTER_STATE.type=e.target.value; renderProjectsTable(); };
  document.getElementById('pFltSales').onchange = (e)=>{ PROJECTS_FILTER_STATE.sales=e.target.value; renderProjectsTable(); };
  document.getElementById('createProjectBtn').onclick = ()=> openCreateProjectManualModal();
  renderProjectsTable();
}

function filteredProjects(){
  const f = PROJECTS_FILTER_STATE;
  return DB.all('projects').filter(p=>{
    if(f.search){
      const q = f.search.toLowerCase();
      if(!(p.clientName.toLowerCase().includes(q) || p.businessName.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))) return false;
    }
    if(f.stage && p.stage!==f.stage) return false;
    if(f.industry && p.industry!==f.industry) return false;
    if(f.type && p.projectType!==f.type) return false;
    if(f.sales && p.assignedSales!==f.sales) return false;
    return true;
  }).sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
}

function renderProjectsTable(){
  const wrap = document.getElementById('projectsTableWrap');
  const projects = filteredProjects();
  // Simplified column set (spec §1): Industry and Expected Delivery dropped,
  // Client + Business merged into one column, and Action is View-only —
  // editing now happens from inside Project View, not from the table.
  wrap.innerHTML = `
    <div class="table-wrap scroll-x">
      <table class="data-table">
        <thead>
          <tr>
            <th>Project Code</th><th>Client / Business</th><th>Project Type</th>
            <th>Project Value</th><th>Paid</th><th>Remaining</th><th>Sales</th><th>Status</th><th>Payment Status</th><th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${projects.length ? projects.map(p=>{
            const s = paymentSummaryFor(p.id);
            return `
            <tr>
              <td class="cell-link" data-open="${p.id}">${p.id}${!p.leadId ? '<div class="cell-sub">Direct</div>':''}</td>
              <td class="cell-strong">${escapeHtml(p.clientName)}<div class="cell-sub">${escapeHtml(p.businessName)}</div></td>
              <td>${escapeHtml(serviceDisplayName(p.projectType))}</td>
              <td class="cell-strong">${money(s.confirmedValue)}</td>
              <td style="font-weight:700;color:${s.totalPaid>0?'var(--green)':'inherit'}">${money(s.totalPaid)}</td>
              <td style="font-weight:700;color:${s.remaining>0?'#d98a12':'var(--green)'}">${money(s.remaining)}</td>
              <td><div class="flex-row"><div class="avatar-sm" style="background:${userColor(p.assignedSales)}">${userInitials(p.assignedSales)}</div>${escapeHtml(p.assignedSales)}</div></td>
              <td>${statusBadge(p.stage)}</td>
              <td>${paymentBadge(s.status)}</td>
              <td><button class="btn btn-secondary btn-sm" data-open="${p.id}">View</button></td>
            </tr>`;}).join('') : `<tr><td colspan="10"><div class="empty-row">No projects match your filters. Confirm a lead, or create one directly.</div></td></tr>`}
        </tbody>
      </table>
    </div>
    <p class="text-muted" style="margin-top:10px;font-size:12px">Showing ${projects.length} of ${DB.all('projects').length} projects</p>
  `;
  wrap.querySelectorAll('[data-open]').forEach(x=> x.onclick = ()=> openProjectDetailModal(x.dataset.open));
}

/* ---------------------------------------------------------------------- */
/* Create project from a confirmed lead (legacy manual trigger — kept for  */
/* the lead detail modal's "+ Create Project" button on already-Confirmed */
/* leads that somehow don't have a project yet)                           */
/* ---------------------------------------------------------------------- */

function createProjectFromLead(leadId, onDone){
  const lead = DB.find('leads', leadId);
  if(!lead) return;
  if(lead.projectCode){ toast('This lead already has a project.', 'error'); return; }

  const html = `
    <div class="modal-head"><h3>Create Project from Lead</h3><button class="modal-close" id="cpClose">&times;</button></div>
    <div class="modal-body">
      <p class="text-muted" style="margin-top:0;font-size:13px">This creates a new Project record linked to lead ${lead.id}. The lead's history stays intact — nothing is overwritten.</p>
      <div class="form-grid">
        <div class="form-field"><label class="required">Project Code</label><input id="cp_code" value="${escapeHtml(suggestNextProjectCode())}" style="text-transform:uppercase"></div>
        <div class="form-field"><label class="required">Confirmed Value ($)</label><input type="number" id="cp_value" value="${lead.estimatedValue||0}"></div>
        <div class="form-field"><label class="required">Deposit %</label><input type="number" id="cp_depositPct" value="50"></div>
        <div class="form-field"><label>Start Date</label><input type="date" id="cp_start" value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="form-field full"><label>Expected Delivery</label><input type="date" id="cp_delivery" value="${daysFromNow(21)}"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="cpCancel">Cancel</button>
      <button class="btn btn-primary" id="cpSave">Create Project</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#cpClose').onclick = closeModal;
    overlay.querySelector('#cpCancel').onclick = closeModal;
    overlay.querySelector('#cpSave').onclick = ()=>{
      const codeInput = overlay.querySelector('#cp_code');
      const code = normalizeProjectCode(codeInput.value);
      if(!code){ codeInput.style.borderColor='var(--red)'; toast('Project Code is required.', 'error'); return; }
      if(isProjectCodeTaken(code, { excludeLeadId: lead.id })){
        codeInput.style.borderColor='var(--red)';
        toast(`Project Code ${code} already exists. Please use a unique Project Code.`, 'error');
        return;
      }
      codeInput.style.borderColor='';
      const confirmedValue = Number(overlay.querySelector('#cp_value').value)||0;
      const depositPct = Number(overlay.querySelector('#cp_depositPct').value)||0;
      const startDate = overlay.querySelector('#cp_start').value;
      const expectedDelivery = overlay.querySelector('#cp_delivery').value;

      createProjectRecord({ code, lead, confirmedValue, depositPct, startDate, expectedDelivery });
      logActivity({ userName: CURRENT_USER.name, refType:'project', refId: code, refLabel:`${code} — ${lead.businessName}`,
        type:'Project Created', description:`${CURRENT_USER.name} created project ${code} from lead ${lead.id}. Confirmed Value: ${money(confirmedValue)}.`, toValue:'Confirmed' });

      toast(`Project ${code} created.`, 'success');
      closeModal();
      if(onDone) onDone();
      if(currentRoute()==='projects') renderProjectsTable();
      if(currentRoute()==='dashboard') router();
    };
  }});
}

/* ---------------------------------------------------------------------- */
/* Shared record-creation helper — builds the Project + Payment records   */
/* from a lead (or from raw fields for direct/manual creation) without    */
/* re-asking for information the lead already has.                       */
/* ---------------------------------------------------------------------- */

function createProjectRecord({ code, lead, confirmedValue, depositPct=50, startDate, expectedDelivery, overrides={} }){
  const now = new Date().toISOString();

  // NOTE on money fields: `confirmedValue` is the only authoritative value
  // stored on the project. `depositPct` is a planned/reference percentage
  // only (never assumed to be 50% — flexible per project). Total Paid /
  // Remaining Balance / Payment Status are NEVER stored here — they are
  // always derived live from the payment ledger via paymentSummaryFor(),
  // so they can never drift out of sync with what Payments actually shows.
  const proj = {
    id: code,
    leadId: lead ? lead.id : null,
    clientName: overrides.clientName ?? lead?.clientName ?? '',
    businessName: overrides.businessName ?? lead?.businessName ?? '',
    phone: overrides.phone ?? lead?.phone ?? '',
    industry: overrides.industry ?? lead?.industry ?? '',
    projectType: overrides.projectType ?? lead?.interestedService ?? '',
    estimatedValue: lead ? (lead.estimatedValue ?? null) : (overrides.estimatedValue ?? null),
    confirmedValue: Number(confirmedValue)||0,
    depositPct,
    assignedSales: overrides.assignedSales ?? lead?.assignedSales ?? CURRENT_USER.name,
    stage: 'Confirmed',
    startDate: startDate || new Date().toISOString().slice(0,10),
    expectedDelivery: expectedDelivery || daysFromNow(21),
    leadSource: overrides.leadSource ?? lead?.leadSource ?? 'Direct',
    demoLink: lead?.demoLink || '',
    quotationRef: lead?.quotationRef || '',
    notes: overrides.notes ?? lead?.notes ?? '',
    functions: [],
    createdAt: now
  };
  DB.upsert('projects', proj);

  if(lead){
    lead.projectCode = code;
    lead.updatedAt = now;
    DB.upsert('leads', lead);
  }

  return proj;
}

// Simple obvious-duplicate check for Direct Project creation (spec §5) —
// same business name (case-insensitive) or same phone number already on
// an existing project, OR on an existing LEAD that isn't yet tied to any
// project. Deliberately loose/fast rather than a fuzzy match; it only
// needs to catch the obvious "someone already entered this client"
// case, not every possible near-duplicate.
//
// The lead half of this check was added after the C017/ODOM Prestige
// incident (see the reconciliation activity log on lead L017): a Direct
// Project was created for a business that already had an open lead, but
// the only duplicate check at the time compared against other PROJECTS,
// never against LEADS — so nothing caught it and the two records stayed
// disconnected until manually reconciled. This does not retroactively
// detect that specific case (the lead's business/client name and the
// project's business/client name were genuinely different text — see the
// final report), but it now catches the much more common case of staff
// re-entering the same business/phone as an existing, still-open lead.
function findLikelyDuplicateProjects({ businessName, phone }){
  const bn = (businessName||'').trim().toLowerCase();
  const ph = (phone||'').trim();
  if(!bn && !ph) return [];
  const projectMatches = DB.all('projects').filter(p=>{
    const sameBiz = bn && p.businessName && p.businessName.trim().toLowerCase()===bn;
    const samePhone = ph && p.phone && p.phone.trim()===ph;
    return sameBiz || samePhone;
  }).map(p=> ({ id:p.id, businessName:p.businessName, kind:'project' }));
  const leadMatches = DB.all('leads').filter(l=>{
    // Skip leads that already have their own actual project row — that's
    // not a disconnected-duplicate risk, just a normal converted lead.
    if(l.projectCode && DB.find('projects', l.projectCode)) return false;
    const sameBiz = bn && l.businessName && l.businessName.trim().toLowerCase()===bn;
    const samePhone = ph && l.phone && l.phone.trim()===ph;
    return sameBiz || samePhone;
  }).map(l=> ({ id:l.id, businessName:l.businessName, kind:'lead' }));
  return [...projectMatches, ...leadMatches];
}

/* ---------------------------------------------------------------------- */
/* Project detail modal                                                   */
/* ---------------------------------------------------------------------- */

// Project View v2 (spec, second pass): the header + a compact "key info"
// block are the only things visible at first glance. Everything else —
// Scope, Payment History, Activity, Notes, Quotations — lives in
// collapsed-by-default <details> sections below, so nothing is duplicated
// and nothing overwhelms someone who just wants a quick status check.
// PROJECT_DETAIL_OPEN_SECTIONS tracks which section keys are expanded so
// re-renders (after edits/toggles) don't collapse sections the user just
// opened.
let PROJECT_DETAIL_OPEN_SECTIONS = new Set();

function openProjectDetailModal(code){
  PROJECT_DETAIL_OPEN_SECTIONS = new Set();
  renderProjectDetail(code);
}

function renderProjectDetail(code){
  const proj = DB.find('projects', code);
  if(!proj){ toast('Project not found.', 'error'); return; }
  const summary = paymentSummaryFor(code);
  const ledger = paymentsForProject(code, { includeVoided:true }).slice().reverse();
  const acts = activitiesFor(code);
  const fnCount = (proj.functions||[]).reduce((s,m)=>s+m.functions.length,0);

  // "Record Payment" is only ever shown while a balance remains (spec §2/§5/
  // §8) — a Fully Paid or Completed+Fully-Paid project never shows it, by
  // default, avoiding a dead-end action nobody should take.
  const showRecordPayment = summary.remaining > 0.004;

  const html = `
    <div class="modal-head">
      <div>
        <h3>${proj.id} — ${escapeHtml(proj.businessName)}</h3>
        <div class="text-muted" style="font-size:12px;margin-top:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          ${statusBadge(proj.stage)}
          <span>${escapeHtml(proj.clientName)} · ${escapeHtml(serviceDisplayName(proj.projectType))}</span>
        </div>
      </div>
      <button class="modal-close" id="pdClose">&times;</button>
    </div>
    <div class="modal-body">
      <div class="flex-row" style="justify-content:flex-end;margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <button class="btn btn-outline btn-sm" id="pdEditProject">Edit Project</button>
        ${proj.stage!=='Completed' ? `<button class="btn btn-outline btn-sm" id="pdChangeStage">Change Stage</button>` : ''}
        ${showRecordPayment ? `<button class="btn btn-primary btn-sm" id="pdRecordPayment">Record Payment</button>` : ''}
      </div>

      ${projectKeyInfoHtml(proj, summary)}

      <div class="pd-sections">
        ${collapsibleSectionHtml('scope', `View Scope (${fnCount})`, `<div id="pdScopeBody">${projectFunctionsTab(proj)}</div>`)}
        ${collapsibleSectionHtml('payments', 'Payment History', paymentHistoryTableHtml(ledger))}
        ${collapsibleSectionHtml('activity', `Activity (${acts.length})`, leadHistoryTab(acts))}
        ${collapsibleSectionHtml('notes', 'Notes / Additional Details', projectNotesDetailsHtml(proj))}
        ${collapsibleSectionHtml('quotations', 'Quotations', linkedQuotationsHtml(null, proj.id))}
      </div>
    </div>
    <div class="modal-foot"><button class="btn btn-secondary" id="pdClose2">Close</button></div>
  `;

  openModal(html, { large:true, onMount:(overlay)=>{
    overlay.querySelector('#pdClose').onclick = closeModal;
    overlay.querySelector('#pdClose2').onclick = closeModal;
    overlay.querySelector('#pdEditProject').onclick = ()=>{ closeModal(); openEditProjectModal(proj.id); };
    const stageBtn = overlay.querySelector('#pdChangeStage');
    if(stageBtn) stageBtn.onclick = ()=> openProjectStagePicker(proj);
    const payBtn = overlay.querySelector('#pdRecordPayment');
    if(payBtn) payBtn.onclick = ()=> openRecordPaymentModal(proj.id, ()=> renderProjectDetail(proj.id));

    wireCollapsibleSections(overlay);
    wireFunctionsTab(overlay.querySelector('[data-section="scope"]') || overlay, proj);
    wireLinkedQuotations(overlay);
    wirePaymentHistory(overlay, proj);
  }});
}

/* ---------------------------------------------------------------------- */
/* Payment History table — Project View's Payment Summary tab. Shown here */
/* AND reachable from Edit Project (spec §9 — payment management is never */
/* locked behind only the Payments tab).                                  */
/* ---------------------------------------------------------------------- */

function paymentHistoryTableHtml(ledger){
  if(!ledger.length) return `<p class="text-muted" style="font-size:12.5px;margin:8px 0 0">No payments recorded yet.</p>`;
  const canEdit = canEditPayments(CURRENT_USER.role);
  // Columns kept to exactly what's needed at a glance (spec §8) — "Recorded
  // By" moves into the same small sub-row already used for Voided/Note
  // details below each row, rather than crowding the main row with an
  // eighth column. Edit is a small ghost-button link, not a large CTA.
  return `
    <div class="table-wrap scroll-x">
      <table class="data-table payment-history-table">
        <thead>
          <tr><th>Payment #</th><th>Type</th><th>Amount</th><th>Payment Date</th><th>Method</th><th>Reference</th><th>Action</th></tr>
        </thead>
        <tbody>
          ${ledger.map(p=>`
            <tr style="${p.voided?'opacity:.55':''}">
              <td class="cell-strong">${escapeHtml(p.paymentNumber||'—')}</td>
              <td>${escapeHtml(p.type)}</td>
              <td class="cell-strong" style="${p.voided?'text-decoration:line-through':''}">${money(p.amount)}</td>
              <td>${fmtDate(p.date)}</td>
              <td>${escapeHtml(p.method||'—')}</td>
              <td>${escapeHtml(p.reference||'—')}</td>
              <td>
                ${p.voided
                  ? `<span class="badge st-cancelled"><span class="badge-dot"></span>Voided</span>`
                  : canEdit
                    ? `<div class="flex-row" style="gap:2px">
                         <button class="btn btn-ghost btn-sm" data-edit-payment="${p.id}" title="Edit payment" aria-label="Edit payment" style="padding:5px 8px">${icon('edit')}</button>
                         <button class="btn btn-ghost btn-sm" style="color:var(--red);padding:5px 8px" data-void-payment="${p.id}" title="Void payment" aria-label="Void payment">${icon('x')}</button>
                       </div>`
                    : `<span class="text-muted" style="font-size:11.5px">—</span>`}
              </td>
            </tr>
            ${p.voided ? `<tr><td colspan="7" style="padding-top:0"><span class="text-muted" style="font-size:11px">Voided by ${escapeHtml(p.voidedBy||'—')} on ${fmtDate(p.voidedAt)}${p.voidReason?' — '+escapeHtml(p.voidReason):''}</span></td></tr>` : `<tr><td colspan="7" style="padding-top:0"><span class="text-muted" style="font-size:11px">Recorded by ${escapeHtml(p.recordedBy||'—')}</span></td></tr>`}
            ${p.note ? `<tr><td colspan="7" style="padding-top:0"><span class="text-muted" style="font-size:11px">${escapeHtml(p.note)}</span></td></tr>` : ''}
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function wirePaymentHistory(tabBody, proj){
  tabBody.querySelectorAll('[data-edit-payment]').forEach(btn=>{
    btn.onclick = ()=> openEditPaymentModal(btn.dataset.editPayment, proj, ()=> renderProjectDetail(proj.id));
  });
  tabBody.querySelectorAll('[data-void-payment]').forEach(btn=>{
    btn.onclick = ()=> openVoidPaymentModal(btn.dataset.voidPayment, proj, ()=> renderProjectDetail(proj.id));
  });
}

function openEditPaymentModal(paymentId, proj, onDone){
  if(!canEditPayments(CURRENT_USER.role)){ toast('Only Founder/Admin can edit payments.', 'error'); return; }
  const payment = DB.all('payments').find(p=>p.id===paymentId);
  if(!payment) return;
  const html = `
    <div class="modal-head"><h3>Edit Payment — ${escapeHtml(payment.paymentNumber||'')}</h3><button class="modal-close" id="epyClose">&times;</button></div>
    <div class="modal-body">
      <div class="pd-keyinfo" style="margin-bottom:14px">
        <div>
          ${infoRow('Project Code', proj.id)}
          ${infoRow('Client / Business', `${escapeHtml(proj.clientName||'—')}${proj.businessName?' — '+escapeHtml(proj.businessName):''}`)}
        </div>
        <div>
          ${infoRow('Current Project Value', money(proj.confirmedValue))}
        </div>
      </div>
      <div class="form-grid">
        <div class="form-field"><label class="required">Payment Number</label><input id="epy_number" value="${escapeHtml(payment.paymentNumber||'')}" placeholder="e.g. 1st Payment"></div>
        <div class="form-field"><label class="required">Payment Type</label>
          <select id="epy_type">${PAYMENT_TYPES.map(t=>`<option ${payment.type===t?'selected':''}>${t}</option>`).join('')}</select>
        </div>
        <div class="form-field"><label class="required">Amount ($)</label><input type="number" id="epy_amount" value="${payment.amount}" min="0.01" step="0.01"></div>
        <div class="form-field"><label class="required">Payment Date</label><input type="date" id="epy_date" value="${payment.date||''}"></div>
        <div class="form-field"><label class="required">Payment Method</label><select id="epy_method">${PAYMENT_METHODS.map(m=>`<option ${payment.method===m?'selected':''}>${m}</option>`).join('')}</select></div>
        <div class="form-field"><label>Reference</label><input id="epy_reference" value="${escapeHtml(payment.reference||'')}" placeholder="e.g. bank txn ref, receipt #…"></div>
        <div class="form-field full"><label>Note</label><textarea id="epy_note">${escapeHtml(payment.note||'')}</textarea></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="epyCancel">Cancel</button>
      <button class="btn btn-primary" id="epySave">Save Changes</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#epyClose').onclick = closeModal;
    overlay.querySelector('#epyCancel').onclick = closeModal;
    overlay.querySelector('#epySave').onclick = ()=>{
      // Second line of defense — the button is already hidden from Sales in
      // the table, but never trust the UI alone for a founder-only action.
      if(!canEditPayments(CURRENT_USER.role)){ toast('Only Founder/Admin can edit payments.', 'error'); return; }

      const newNumber = overlay.querySelector('#epy_number').value.trim();
      const newAmount = Number(overlay.querySelector('#epy_amount').value)||0;
      const newDate = overlay.querySelector('#epy_date').value;
      const newMethod = overlay.querySelector('#epy_method').value;
      const newType = overlay.querySelector('#epy_type').value;
      const newReference = overlay.querySelector('#epy_reference').value.trim();
      const newNote = overlay.querySelector('#epy_note').value.trim();
      if(!newNumber){ toast('Please enter a payment number.', 'error'); return; }
      if(newAmount<=0){ toast('Please enter a valid amount.', 'error'); return; }
      if(!newDate){ toast('Please select a payment date.', 'error'); return; }
      if(!newType){ toast('Please select a payment type.', 'error'); return; }
      if(!newMethod){ toast('Please select a payment method.', 'error'); return; }

      // If raising the amount would push Total Paid past Project Value,
      // warn and require confirmation before proceeding (same guard as
      // Record Payment — see openRecordPaymentModal). This is a warning,
      // not a hard block — spec §4 only requires blocking if an existing
      // rule already does, and none does here.
      const otherPaid = paymentsForProject(proj.id).filter(p=>p.id!==payment.id).reduce((s,p)=>s+p.amount,0);
      const newTotal = otherPaid + newAmount;
      if(newTotal > proj.confirmedValue + 0.004){
        if(!confirm(`This payment is greater than the remaining project balance.\n\nProject Value: ${money(proj.confirmedValue)}\nTotal Paid (with this edit): ${money(newTotal)}\n\nSave anyway?`)) return;
      }

      // Track every field that actually changed for the audit trail (spec
      // §5: "changed fields, old value, new value"), not just amount.
      const changes = [];
      if(newNumber !== (payment.paymentNumber||'')) changes.push({ field:'Payment Number', from: payment.paymentNumber||'—', to: newNumber });
      if(newType !== payment.type) changes.push({ field:'Type', from: payment.type||'—', to: newType });
      if(newAmount !== payment.amount) changes.push({ field:'Amount', from: money(payment.amount), to: money(newAmount) });
      if(newDate !== (payment.date||'')) changes.push({ field:'Payment Date', from: fmtDate(payment.date)||'—', to: fmtDate(newDate) });
      if(newMethod !== (payment.method||'')) changes.push({ field:'Method', from: payment.method||'—', to: newMethod });
      if(newReference !== (payment.reference||'')) changes.push({ field:'Reference', from: payment.reference||'—', to: newReference||'—' });
      if(newNote !== (payment.note||'')) changes.push({ field:'Note', from: payment.note||'—', to: newNote||'—' });

      if(!changes.length){ toast('No changes to save.', 'success'); closeModal(); return; }

      updatePaymentEntry(payment.id, { paymentNumber:newNumber, amount:newAmount, date:newDate, method:newMethod, type:newType, reference:newReference, note:newNote });

      // Build the audit description in the spec's example format:
      // "Payment edited for C017 — 1st Payment: amount changed from $41 to $XX"
      // extended with one clause per additional changed field.
      const changeClauses = changes.map(c=>`${c.field.toLowerCase()} changed from ${c.from} to ${c.to}`).join('; ');
      const description = `Payment edited for ${proj.id} — ${newNumber||payment.paymentNumber||payment.id}: ${changeClauses} (by ${CURRENT_USER.name}).`;

      // leadHistoryTab() (js/leads.js) only renders the full `description`
      // text when fromValue/toValue are BOTH empty — otherwise it shows just
      // "from → to" and hides the description entirely. So: for the common
      // single-field edit, keep the compact "$41 → $50"-style display by
      // setting fromValue/toValue; for a multi-field edit, leave them unset
      // so the full multi-field description renders instead.
      const single = changes.length===1 ? changes[0] : null;
      logActivity({ userName: CURRENT_USER.name, refType:'project', refId: proj.id, refLabel:`${proj.id} — ${proj.businessName}`,
        type:'Payment Updated', description,
        fromValue: single ? single.from : null, toValue: single ? single.to : null });

      toast('Payment updated.', 'success');
      closeModal();
      if(onDone) onDone();
      if(currentRoute()==='payments') renderPaymentsPage();
      if(currentRoute()==='dashboard') router();
    };
  }});
}

function openVoidPaymentModal(paymentId, proj, onDone){
  if(!canEditPayments(CURRENT_USER.role)){ toast('Only Founder/Admin can void payments.', 'error'); return; }
  const payment = DB.all('payments').find(p=>p.id===paymentId);
  if(!payment) return;
  const html = `
    <div class="modal-head"><h3>Void Payment</h3><button class="modal-close" id="vpClose">&times;</button></div>
    <div class="modal-body">
      <p style="margin-top:0">Void <b>${escapeHtml(payment.paymentNumber||'')} — ${money(payment.amount)}</b>?</p>
      <p class="text-muted" style="font-size:12.5px">This is not a permanent delete — the record stays in the ledger marked "Voided" for audit purposes, but it will no longer count toward Total Paid.</p>
      <div class="form-field"><label class="required">Reason</label><textarea id="vp_reason" placeholder="e.g. Duplicate entry, payment reversed by bank…"></textarea></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="vpCancel">Cancel</button>
      <button class="btn btn-danger" id="vpConfirm">Void Payment</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#vpClose').onclick = closeModal;
    overlay.querySelector('#vpCancel').onclick = closeModal;
    overlay.querySelector('#vpConfirm').onclick = ()=>{
      const reason = overlay.querySelector('#vp_reason').value.trim();
      if(!reason){ toast('Please provide a reason for voiding this payment.', 'error'); return; }
      voidPaymentEntry(payment.id, { voidedBy: CURRENT_USER.name, reason });
      logActivity({ userName: CURRENT_USER.name, refType:'project', refId: proj.id, refLabel:`${proj.id} — ${proj.businessName}`,
        type:'Payment Voided', description:`${CURRENT_USER.name} voided payment ${payment.paymentNumber||payment.id} (${money(payment.amount)}). Reason: ${reason}` });
      toast('Payment voided.', 'success');
      closeModal();
      if(onDone) onDone();
      if(currentRoute()==='payments') renderPaymentsPage();
      if(currentRoute()==='dashboard') router();
    };
  }});
}

// Compact "key info" block (spec §3) — the only project data shown at
// first glance, immediately below the header/actions. Project Code and
// Project Status are deliberately NOT repeated here — they're already in
// the modal header. Nothing here duplicates anything shown elsewhere, and
// nothing here is behind a collapsible section.
function projectKeyInfoHtml(proj, summary){
  return `
    <div class="pd-keyinfo">
      <div>
        ${infoRow('Project Value', money(summary.confirmedValue))}
        ${infoRow('Paid', money(summary.totalPaid))}
        ${infoRow('Remaining', money(summary.remaining))}
        ${infoRow('Payment Status', summary.status)}
      </div>
      <div>
        ${infoRow('Project Type', serviceDisplayName(proj.projectType))}
        ${infoRow('Assigned Sales', proj.assignedSales)}
        ${infoRow('Start Date', fmtDate(proj.startDate))}
        ${infoRow('Expected Delivery', fmtDate(proj.expectedDelivery))}
      </div>
    </div>
  `;
}

// Notes / Additional Details collapsible section body (spec §4D) — the
// secondary/technical fields (Industry, Phone, estimate/quotation
// footnotes, and the actual notes text) that don't belong in the compact
// key-info block above.
function projectNotesDetailsHtml(proj){
  return `
    <div class="two-col">
      <div>
        ${infoRow('Client', proj.clientName)}
        ${infoRow('Business', proj.businessName)}
        ${infoRow('Phone', proj.phone || '—')}
      </div>
      <div>
        ${infoRow('Industry', industryLabel(proj.industry))}
        ${infoRow('Source', proj.leadId ? 'From lead '+proj.leadId : 'Direct project (no lead)')}
      </div>
    </div>
    ${proj.estimatedValue!=null && proj.estimatedValue!==proj.confirmedValue ? `<p class="text-muted" style="font-size:11.5px;margin:10px 0 0">Originally estimated at ${money(proj.estimatedValue)} before confirmation.</p>` : ''}
    ${proj.quotationRef ? `<p class="text-muted" style="font-size:11.5px;margin:4px 0 0">Confirmed from quotation ${escapeHtml(proj.quotationRef)}.</p>` : ''}
    <div class="divider"></div>
    <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">Notes</div>
    <p style="font-size:13px;margin:6px 0 0">${proj.notes ? escapeHtml(proj.notes) : '<span class="text-muted">No notes added.</span>'}</p>
  `;
}

// Generic collapsible section — native <details>/<summary> so it's fully
// accessible/keyboard-usable with no extra JS needed for the open/close
// behavior itself; wireCollapsibleSections() below only needs to track
// which keys are open across re-renders (see PROJECT_DETAIL_OPEN_SECTIONS).
function collapsibleSectionHtml(key, title, bodyHtml){
  const isOpen = PROJECT_DETAIL_OPEN_SECTIONS.has(key);
  return `
    <details class="pd-section" data-section="${key}" ${isOpen ? 'open' : ''}>
      <summary class="pd-section-summary">
        <span class="pd-section-caret">▶</span>
        <span>${title}</span>
      </summary>
      <div class="pd-section-body">${bodyHtml}</div>
    </details>
  `;
}

function wireCollapsibleSections(overlay){
  overlay.querySelectorAll('.pd-section').forEach(det=>{
    det.addEventListener('toggle', ()=>{
      const key = det.dataset.section;
      if(det.open) PROJECT_DETAIL_OPEN_SECTIONS.add(key);
      else PROJECT_DETAIL_OPEN_SECTIONS.delete(key);
    });
  });
}

/* ---------------------------------------------------------------------- */
/* Confirmed Functions / Scope — module + function editor                 */
/* ---------------------------------------------------------------------- */

function projectFunctionsTab(proj){
  const modules = proj.functions || [];
  return `
    <p class="text-muted" style="margin:0 0 14px;font-size:12.5px">The exact features confirmed for this project, grouped by module. Nothing here is locked to a fixed template — add whatever this client actually agreed to.</p>
    <div id="fnModulesList">
      ${modules.length ? modules.map(m=>functionModuleHtml(m)).join('') : `<div class="empty-row">No functions added yet. Use "+ Add Module" to start scoping this project.</div>`}
    </div>
    <button class="btn btn-outline btn-sm" id="fnAddModule" style="margin-top:10px">+ Add Module</button>
  `;
}

function functionModuleHtml(m){
  return `
    <div class="panel" style="margin-bottom:12px" data-module-id="${m.id}">
      <div class="panel-head" style="padding:10px 14px">
        <h3 style="font-size:13.5px">${escapeHtml(m.module)}</h3>
        <div class="flex-row" style="gap:10px">
          <span class="cell-link" style="font-size:12px" data-add-fn="${m.id}">+ Add Function</span>
          <span class="cell-link" style="font-size:12px;color:var(--red)" data-remove-module="${m.id}">Remove Module</span>
        </div>
      </div>
      <div class="panel-body pad" style="padding:10px 14px">
        ${m.functions.length ? m.functions.map(f=>`
          <div class="mini-row" style="padding:7px 0">
            <div class="mini-main"><span style="font-size:13px">${escapeHtml(f.name)}</span></div>
            <div class="flex-row" style="gap:8px">
              <select class="sel" style="font-size:11.5px;padding:4px 8px" data-status-fn="${f.id}" data-module="${m.id}">
                ${FUNCTION_STATUSES.map(s=>`<option ${f.status===s?'selected':''}>${s}</option>`).join('')}
              </select>
              ${statusBadge(f.status)}
              <span class="icon-btn" data-remove-fn="${f.id}" data-module="${m.id}" title="Remove function" style="font-size:15px;line-height:1">&times;</span>
            </div>
          </div>`).join('') : `<div class="text-muted" style="font-size:12.5px;padding:6px 0">No functions in this module yet.</div>`}
      </div>
    </div>
  `;
}

function wireFunctionsTab(overlay, proj){
  function persistAndRerender(){
    DB.upsert('projects', proj);
    // Keep the Scope section expanded across the re-render — the user was
    // just actively editing it.
    PROJECT_DETAIL_OPEN_SECTIONS.add('scope');
    renderProjectDetail(proj.id);
  }

  overlay.querySelector('#fnAddModule')?.addEventListener('click', ()=>{
    openAddModuleModal((moduleName, firstFunctionName)=>{
      if(!proj.functions) proj.functions = [];
      const mod = { id: fnId(), module: moduleName, functions: [] };
      if(firstFunctionName){
        mod.functions.push({ id: fnId(), name: firstFunctionName, status: DEFAULT_FUNCTION_STATUS });
      }
      proj.functions.push(mod);
      logActivity({ userName: CURRENT_USER.name, refType:'project', refId: proj.id, refLabel:`${proj.id} — ${proj.businessName}`,
        type:'Function Added', description:`${CURRENT_USER.name} added module: "${moduleName}"${firstFunctionName ? ' with function "'+firstFunctionName+'"' : ''}.` });
      persistAndRerender();
    });
  });

  overlay.querySelectorAll('[data-add-fn]').forEach(el=>{
    el.onclick = ()=>{
      const moduleId = el.dataset.addFn;
      const mod = proj.functions.find(m=>m.id===moduleId);
      openAddFunctionModal(mod.module, (fnName)=>{
        mod.functions.push({ id: fnId(), name: fnName, status: DEFAULT_FUNCTION_STATUS });
        logActivity({ userName: CURRENT_USER.name, refType:'project', refId: proj.id, refLabel:`${proj.id} — ${proj.businessName}`,
          type:'Function Added', description:`${CURRENT_USER.name} added function: "${fnName}" (${mod.module}).` });
        persistAndRerender();
      });
    };
  });

  overlay.querySelectorAll('[data-status-fn]').forEach(sel=>{
    sel.onchange = ()=>{
      const moduleId = sel.dataset.module, funcId = sel.dataset.statusFn;
      const mod = proj.functions.find(m=>m.id===moduleId);
      const fn = mod.functions.find(f=>f.id===funcId);
      const oldStatus = fn.status;
      fn.status = sel.value;
      if(oldStatus !== fn.status){
        logActivity({ userName: CURRENT_USER.name, refType:'project', refId: proj.id, refLabel:`${proj.id} — ${proj.businessName}`,
          type:'Function Changed', description:`${CURRENT_USER.name} changed function: "${fn.name}" ${oldStatus} → ${fn.status}`,
          fromValue: oldStatus, toValue: fn.status });
      }
      persistAndRerender();
    };
  });

  overlay.querySelectorAll('[data-remove-fn]').forEach(el=>{
    el.onclick = ()=>{
      const moduleId = el.dataset.module, funcId = el.dataset.removeFn;
      const mod = proj.functions.find(m=>m.id===moduleId);
      const fn = mod.functions.find(f=>f.id===funcId);
      if(!confirm(`Remove function "${fn.name}"?`)) return;
      mod.functions = mod.functions.filter(f=>f.id!==funcId);
      logActivity({ userName: CURRENT_USER.name, refType:'project', refId: proj.id, refLabel:`${proj.id} — ${proj.businessName}`,
        type:'Function Removed', description:`${CURRENT_USER.name} removed function: "${fn.name}" (${mod.module}).` });
      persistAndRerender();
    };
  });

  overlay.querySelectorAll('[data-remove-module]').forEach(el=>{
    el.onclick = ()=>{
      const moduleId = el.dataset.removeModule;
      const mod = proj.functions.find(m=>m.id===moduleId);
      if(!confirm(`Remove module "${mod.module}" and all ${mod.functions.length} function(s) in it?`)) return;
      proj.functions = proj.functions.filter(m=>m.id!==moduleId);
      logActivity({ userName: CURRENT_USER.name, refType:'project', refId: proj.id, refLabel:`${proj.id} — ${proj.businessName}`,
        type:'Function Removed', description:`${CURRENT_USER.name} removed module: "${mod.module}" (${mod.functions.length} function(s)).` });
      persistAndRerender();
    };
  });
}

function openAddModuleModal(onSave){
  const templateNames = Object.keys(FUNCTION_MODULE_TEMPLATES);
  const html = `
    <div class="modal-head"><h3>Add Module</h3><button class="modal-close" id="amClose">&times;</button></div>
    <div class="modal-body">
      <div class="form-field" style="margin-bottom:12px">
        <label class="required">Module Name</label>
        <input id="am_name" list="am_templates" placeholder="e.g. Website, Booking System, Admin Dashboard…">
        <datalist id="am_templates">${templateNames.map(n=>`<option value="${n}">`).join('')}</datalist>
      </div>
      <div class="form-field"><label>First Function (optional)</label><input id="am_fn" placeholder="e.g. Home Page"></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="amCancel">Cancel</button>
      <button class="btn btn-primary" id="amSave">Add Module</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#amClose').onclick = closeModal;
    overlay.querySelector('#amCancel').onclick = closeModal;
    overlay.querySelector('#amSave').onclick = ()=>{
      const name = overlay.querySelector('#am_name').value.trim();
      if(!name){ toast('Please enter a module name.', 'error'); return; }
      const fnName = overlay.querySelector('#am_fn').value.trim();
      closeModal();
      onSave(name, fnName || null);
    };
  }});
}

function openAddFunctionModal(moduleName, onSave){
  const html = `
    <div class="modal-head"><h3>Add Function</h3><button class="modal-close" id="afClose">&times;</button></div>
    <div class="modal-body">
      <p class="text-muted" style="margin-top:0;font-size:12.5px">Module: <b>${escapeHtml(moduleName)}</b></p>
      <div class="form-field"><label class="required">Function Name</label><input id="af_name" placeholder="e.g. Date & Time Selection"></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="afCancel">Cancel</button>
      <button class="btn btn-primary" id="afSave">Add Function</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#afClose').onclick = closeModal;
    overlay.querySelector('#afCancel').onclick = closeModal;
    overlay.querySelector('#afSave').onclick = ()=>{
      const name = overlay.querySelector('#af_name').value.trim();
      if(!name){ toast('Please enter a function name.', 'error'); return; }
      closeModal();
      onSave(name);
    };
  }});
}

/* ---------------------------------------------------------------------- */
/* Edit Project (core fields — Confirmed Functions are edited in-place    */
/* on the detail modal, not here)                                         */
/* ---------------------------------------------------------------------- */

function openEditProjectModal(code){
  const proj = DB.find('projects', code);
  if(!proj) return;
  const html = `
    <div class="modal-head"><h3>Edit Project — ${proj.id}</h3><button class="modal-close" id="epClose">&times;</button></div>
    <div class="modal-body">
      <div class="form-grid">
        <div class="form-field"><label class="required">Client Name</label><input id="ep_clientName" value="${escapeHtml(proj.clientName)}"></div>
        <div class="form-field"><label class="required">Business Name</label><input id="ep_businessName" value="${escapeHtml(proj.businessName)}"></div>
        <div class="form-field"><label>Phone</label><input id="ep_phone" value="${escapeHtml(proj.phone||'')}"></div>
        <div class="form-field"><label class="required">Industry / SME Type</label><select id="ep_industry">${INDUSTRIES.map(s=>`<option ${proj.industry===s?'selected':''}>${s}</option>`).join('')}</select></div>
        <div class="form-field"><label class="required">Project Type</label><select id="ep_projectType">${SERVICE_TYPES.map(s=>`<option value="${escapeHtml(s)}" ${proj.projectType===s?'selected':''}>${escapeHtml(serviceDisplayName(s))}</option>`).join('')}</select></div>
        <div class="form-field"><label class="required">Confirmed Value ($)</label><input type="number" id="ep_value" value="${proj.confirmedValue}"></div>
        ${assignedSalesFieldHtml({ id:'ep_sales', currentValue: proj.assignedSales })}
        <div class="form-field"><label>Start Date</label><input type="date" id="ep_start" value="${proj.startDate||''}"></div>
        <div class="form-field"><label>Expected Delivery</label><input type="date" id="ep_delivery" value="${proj.expectedDelivery||''}"></div>
        <div class="form-field full"><label>Notes</label><textarea id="ep_notes">${escapeHtml(proj.notes||'')}</textarea></div>
      </div>
      <p class="text-muted" style="font-size:11.5px;margin-top:10px">Project Status changes are logged separately — use "Change Stage" on the project detail view. Payments are recorded and managed from the project detail view too, not here.</p>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="epCancel">Cancel</button>
      <button class="btn btn-primary" id="epSave">Save Changes</button>
    </div>
  `;
  openModal(html, { large:true, onMount:(overlay)=>{
    overlay.querySelector('#epClose').onclick = closeModal;
    overlay.querySelector('#epCancel').onclick = closeModal;
    overlay.querySelector('#epSave').onclick = ()=>{
      const val = id => overlay.querySelector(id).value.trim();
      proj.clientName = val('#ep_clientName');
      proj.businessName = val('#ep_businessName');
      proj.phone = val('#ep_phone');
      proj.industry = val('#ep_industry');
      proj.projectType = val('#ep_projectType');
      const newValue = Number(val('#ep_value'))||0;
      const oldValue = proj.confirmedValue;
      proj.confirmedValue = newValue;
      // Remaining Balance is never stored — it's derived live from the
      // payment ledger via paymentSummaryFor(), so simply changing the
      // Confirmed Value here is enough; nothing else needs recalculating.
      // A Sales user's field is disabled/read-only (see
      // assignedSalesFieldHtml) — enforced again here so a tampered DOM
      // value can never reassign a project away from them (spec §10/§11).
      proj.assignedSales = canChooseAssignedSales(CURRENT_USER.role) ? val('#ep_sales') : proj.assignedSales;
      proj.startDate = val('#ep_start');
      proj.expectedDelivery = val('#ep_delivery');
      proj.notes = val('#ep_notes');
      DB.upsert('projects', proj);
      logActivity({ userName: CURRENT_USER.name, refType:'project', refId: proj.id, refLabel:`${proj.id} — ${proj.businessName}`,
        type:'Note Added', description:`${CURRENT_USER.name} updated project ${proj.id} details.` });
      if(newValue!==oldValue){
        logActivity({ userName: CURRENT_USER.name, refType:'project', refId: proj.id, refLabel:`${proj.id} — ${proj.businessName}`,
          type:'Project Value Changed', description:`${CURRENT_USER.name} changed Project Value for ${proj.id} from ${money(oldValue)} to ${money(newValue)}.`,
          fromValue: String(oldValue), toValue: String(newValue) });
      }
      toast('Project updated.', 'success');
      closeModal();
      refreshAfterLeadOrProjectChange();
    };
  }});
}

function openProjectStagePicker(proj){
  const options = PROJECT_STAGES.filter(s=>s!==proj.stage);
  const html = `
    <div class="modal-head"><h3>Move to which stage?</h3><button class="modal-close" id="spClose">&times;</button></div>
    <div class="modal-body">
      <div class="form-field"><label>New Stage</label><select id="spSelect">${options.map(s=>`<option>${s}</option>`).join('')}</select></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="spCancel">Cancel</button>
      <button class="btn btn-primary" id="spNext">Continue</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#spClose').onclick = closeModal;
    overlay.querySelector('#spCancel').onclick = closeModal;
    overlay.querySelector('#spNext').onclick = ()=>{
      const newStage = overlay.querySelector('#spSelect').value;
      closeModal();
      applyProjectStageChange(proj, newStage);
    };
  }});
}

function applyProjectStageChange(proj, newStage){
  openStatusChangeModal({
    refType:'project', refId: proj.id, refLabel:`${proj.id} — ${proj.businessName}`,
    fromStatus: proj.stage, toStatus: newStage,
    onConfirm: ({ remark })=>{
      const prevStage = proj.stage;
      proj.stage = newStage;
      DB.upsert('projects', proj);

      // Project stage and Lead status are deliberately SEPARATE axes (see
      // LEAD_STATUSES) — a lead that reached Confirmed stays Confirmed
      // forever; delivery progress only ever changes the Project's stage,
      // never writes back to the lead.

      logActivity({
        userName: CURRENT_USER.name, refType:'project', refId: proj.id, refLabel:`${proj.id} — ${proj.businessName}`,
        type:'Project Stage Changed', description:`${CURRENT_USER.name} changed ${proj.id}: ${prevStage} → ${newStage}`,
        fromValue: prevStage, toValue: newStage, remark
      });
      toast(`Project ${proj.id} moved to "${newStage}".`, 'success');
      if(currentRoute()==='projects') renderProjectsTable();
      if(currentRoute()==='dashboard') router();
    }
  });
}

/* ---------------------------------------------------------------------- */
/* Pipeline / Leads → Confirmed: the automatic project-creation workflow. */
/* This is the ONE path a lead takes to "Confirmed" — from the lead detail*/
/* status picker or a Pipeline card drag — so it is the single place that */
/* copies lead fields onto a new Project record. No duplicate entry.      */
/* ---------------------------------------------------------------------- */

function openConfirmProjectModal(lead){
  const prevStatus = lead.status;
  // A lead can carry a Project Code that was reserved earlier (spec §5/§9
  // — assigned back at Qualified -> Quote and Demo Sent) with NO Project
  // row yet; that's the normal case now, not a duplicate. Only an actual
  // matching Project row means "already converted" (the genuine duplicate-
  // protection case below).
  const existingProject = lead.projectCode ? DB.find('projects', lead.projectCode) : null;

  // ----- duplicate protection: this lead already converted to a project -----
  if(existingProject){
    const proj = existingProject;
    const html = `
      <div class="modal-head"><h3>Project Already Created</h3><button class="modal-close" id="dupClose">&times;</button></div>
      <div class="modal-body">
        <p style="margin-top:0">This lead is already linked to a project — a new one will not be created.</p>
        <div class="panel" style="padding:14px 16px;background:#f7faff;border:1px solid var(--line)">
          <div class="cell-strong" style="font-size:15px">Project already created: ${lead.projectCode}</div>
          <div class="text-muted" style="font-size:12.5px;margin-top:2px">${proj ? escapeHtml(proj.businessName) : ''}</div>
        </div>
        <div class="form-field" style="margin-top:16px">
          <label>Remark (optional)</label>
          <textarea id="dupRemark" placeholder="Add a note about this status change…"></textarea>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-secondary" id="dupCancel">Cancel</button>
        <button class="btn btn-outline" id="dupOpenProject">Open Project</button>
        <button class="btn btn-primary" id="dupConfirm">Set Status to Confirmed</button>
      </div>
    `;
    openModal(html, { onMount:(overlay)=>{
      overlay.querySelector('#dupClose').onclick = closeModal;
      overlay.querySelector('#dupCancel').onclick = closeModal;
      overlay.querySelector('#dupOpenProject').onclick = ()=>{ closeModal(); openProjectDetailModal(lead.projectCode); };
      overlay.querySelector('#dupConfirm').onclick = ()=>{
        const remark = overlay.querySelector('#dupRemark').value.trim();
        closeModal();
        lead.status = 'Confirmed';
        lead.updatedAt = new Date().toISOString();
        DB.upsert('leads', lead);
        logActivity({ userName: CURRENT_USER.name, refType:'lead', refId: lead.id, refLabel:`${lead.clientName} — ${lead.businessName}`,
          type:'Status Changed', description:`${CURRENT_USER.name} changed status: ${prevStatus} → Confirmed`,
          fromValue: prevStatus, toValue:'Confirmed', remark: remark || `No new project created — already linked to ${lead.projectCode}.` });
        toast(`Status changed to "Confirmed". Project ${lead.projectCode} was not duplicated.`, 'success');
        refreshAfterLeadOrProjectChange();
      };
    }});
    return;
  }

  // ----- normal path: collect confirmed value + dates, then auto-create -----
  // Under the current flow a lead reaching Confirmed almost always already
  // has a Project Code (assigned back at Qualified -> Quote and Demo Sent)
  // — spec §9: use it as-is, never generate a new one. The editable
  // suggested-code fallback only still applies to a legacy lead that
  // somehow reached this point without ever getting one (pre-dates this
  // feature, or jumped straight from an early stage) — the Founder/Admin
  // enters it here, same as before, never auto-invented silently.
  const hasExistingCode = !!lead.projectCode;
  const suggestedCode = hasExistingCode ? lead.projectCode : suggestNextProjectCode();
  const html = `
    <div class="modal-head"><h3>Confirm Project</h3><button class="modal-close" id="cfClose">&times;</button></div>
    <div class="modal-body">
      <p class="text-muted" style="margin:0 0 14px;font-size:12.5px">Moving <b>${escapeHtml(lead.clientName)} — ${escapeHtml(lead.businessName)}</b> from <b>${escapeHtml(prevStatus)}</b> to <b>Confirmed</b> will automatically create a linked Project — no need to re-enter this client's information.</p>
      <div class="two-col" style="margin-bottom:12px">
        <div>
          ${infoRow('Client', lead.clientName)}
          ${infoRow('Business', lead.businessName)}
          ${infoRow('Industry', lead.industry)}
        </div>
        <div>
          ${infoRow('Project Type', serviceDisplayName(lead.interestedService))}
          ${infoRow('Assigned Sales', lead.assignedSales)}
          ${infoRow('Estimated Value', money(lead.estimatedValue))}
        </div>
      </div>
      <div class="divider"></div>
      <div class="form-grid">
        <div class="form-field"><label class="required">Confirmed Project Value ($)</label><input type="number" id="cf_value" value="${lead.estimatedValue||0}"></div>
        <div class="form-field"><label class="required">Project Code</label><input id="cf_code" value="${escapeHtml(suggestedCode)}" ${hasExistingCode?'disabled':''} style="text-transform:uppercase">${hasExistingCode?`<span class="form-hint">Already assigned to this lead — reused as-is.</span>`:''}</div>
        <div class="form-field"><label>Deposit %</label><input type="number" id="cf_depositPct" value="50"></div>
        <div class="form-field"><label>Start Date</label><input type="date" id="cf_start" value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="form-field full"><label>Expected Delivery</label><input type="date" id="cf_delivery" value="${daysFromNow(21)}"></div>
        <div class="form-field full"><label>Remark (optional)</label><textarea id="cf_remark" placeholder="e.g. Client confirmed Option 2."></textarea></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="cfCancel">Cancel</button>
      <button class="btn btn-primary" id="cfConfirm">Confirm &amp; Create Project</button>
    </div>
  `;
  openModal(html, { large:true, onMount:(overlay)=>{
    overlay.querySelector('#cfClose').onclick = closeModal;
    overlay.querySelector('#cfCancel').onclick = closeModal;
    overlay.querySelector('#cfConfirm').onclick = ()=>{
      const codeInput = overlay.querySelector('#cf_code');
      const code = normalizeProjectCode(codeInput.value);
      if(!code){ codeInput.style.borderColor='var(--red)'; toast('Project Code is required.', 'error'); return; }
      // A code this lead already carries is never a "duplicate" of itself
      // (excludeLeadId) — this only actually blocks a genuinely different
      // code that collides with some other lead/project.
      if(isProjectCodeTaken(code, { excludeLeadId: lead.id })){
        codeInput.style.borderColor='var(--red)';
        toast(`Project Code ${code} already exists. Please use a unique Project Code.`, 'error');
        return;
      }
      codeInput.style.borderColor='';
      const confirmedValue = Number(overlay.querySelector('#cf_value').value)||0;
      if(confirmedValue<=0){ toast('Please enter a Confirmed Project Value greater than $0.', 'error'); return; }
      const depositPct = Number(overlay.querySelector('#cf_depositPct').value)||0;
      const startDate = overlay.querySelector('#cf_start').value;
      const expectedDelivery = overlay.querySelector('#cf_delivery').value;
      const remark = overlay.querySelector('#cf_remark').value.trim();
      closeModal();

      // 1. lead status -> Confirmed, logged
      lead.status = 'Confirmed';
      lead.updatedAt = new Date().toISOString();
      DB.upsert('leads', lead);
      logActivity({ userName: CURRENT_USER.name, refType:'lead', refId: lead.id, refLabel:`${lead.clientName} — ${lead.businessName}`,
        type:'Status Changed', description:`${CURRENT_USER.name} changed status: ${prevStatus} → Confirmed`,
        fromValue: prevStatus, toValue:'Confirmed', remark });

      // 2. auto-create the linked project (no re-entry of client info)
      createProjectRecord({ code, lead, confirmedValue, depositPct, startDate, expectedDelivery });

      // 3. activity: system created project (on both the project and the lead)
      logActivity({ userName: CURRENT_USER.name, refType:'project', refId: code, refLabel:`${code} — ${lead.businessName}`,
        type:'Project Created', description:`${CURRENT_USER.name} changed status: ${prevStatus} → Confirmed. System created Project: ${code} (Confirmed Value: ${money(confirmedValue)}).`,
        toValue:'Confirmed', remark });
      logActivity({ userName: CURRENT_USER.name, refType:'lead', refId: lead.id, refLabel:`${lead.clientName} — ${lead.businessName}`,
        type:'Project Created', description:`System created Project: ${code} (Confirmed Value: ${money(confirmedValue)}) from lead ${lead.id}.` });

      toast(`Lead confirmed — Project ${code} created automatically.`, 'success');
      refreshAfterLeadOrProjectChange();

      // Spec §12: a Confirmed lead no longer needs normal sales follow-up
      // (delivery is now tracked on the Project) — offer to clear it rather
      // than silently removing a date the user may be deliberately keeping
      // for a special reason.
      if(lead.nextFollowup){
        const keptDate = lead.nextFollowup;
        setTimeout(()=>{
          if(confirm(`This lead is now Confirmed — delivery is tracked on Project ${code} instead of sales follow-up.\n\nRemove the scheduled follow-up (${fmtDate(keptDate)})?\n\nChoose Cancel to keep it for a special reason.`)){
            lead.nextFollowup = null;
            lead.followUpUpdatedAt = new Date().toISOString();
            DB.upsert('leads', lead);
            logActivity({ userName: CURRENT_USER.name, refType:'lead', refId: lead.id, refLabel:`${lead.clientName} — ${lead.businessName}`,
              type:'Follow-up Cancelled', description:`${CURRENT_USER.name} removed the sales follow-up for ${lead.clientName} — now tracked via Project ${code} instead.`,
              fromValue: keptDate, toValue: null });
            refreshAfterLeadOrProjectChange();
          }
        }, 150);
      }
    };
  }});
}

// Re-render whatever page/modal is currently open after a lead↔project
// mutation, since the change can affect Pipeline, Leads, Projects and
// Dashboard simultaneously.
function refreshAfterLeadOrProjectChange(){
  if(currentRoute()==='leads') renderLeadsTable();
  if(currentRoute()==='pipeline') renderPipelinePage();
  if(currentRoute()==='projects') renderProjectsTable();
  if(currentRoute()==='dashboard') router();
}

/* ---------------------------------------------------------------------- */
/* Direct project creation ("+ Create Direct Project" on the Projects     */
/* page) — for a confirmed client that was NOT previously recorded as a   */
/* Lead (spec §5). This is exceptional/direct business only — the normal  */
/* Lead → Pipeline → Confirmed flow creates its project automatically     */
/* and never goes through this modal.                                     */
/* ---------------------------------------------------------------------- */

function openCreateProjectManualModal(){
  let linkedLead = null;

  const html = `
    <div class="modal-head"><h3>Create Direct Project</h3><button class="modal-close" id="mpClose">&times;</button></div>
    <div class="modal-body">
      <p class="text-muted" style="margin-top:0;font-size:12.5px">Use this only for a confirmed client that was not previously recorded as a Lead.</p>
      <div class="form-field full" style="margin-bottom:14px">
        <label>Lead Link</label>
        <div class="flex-row" style="gap:16px;font-size:13px">
          <label class="flex-row" style="gap:6px;cursor:pointer"><input type="radio" name="mp_linkmode" value="link" checked> Link to Existing Lead</label>
          <label class="flex-row" style="gap:6px;cursor:pointer"><input type="radio" name="mp_linkmode" value="none"> No Existing Lead</label>
        </div>
      </div>
      <div id="mpLeadSearchWrap" style="margin-bottom:16px">
        <div class="search-box" style="max-width:100%">
          ${icon('search')}
          <input type="text" id="mpLeadSearch" placeholder="Search lead by name, business, phone, or ID…">
        </div>
        <div id="mpLeadResults" style="margin-top:8px;max-height:160px;overflow-y:auto;border:1px solid var(--line);border-radius:9px"></div>
        <div id="mpLeadSelected" style="margin-top:8px"></div>
      </div>

      <div class="form-grid">
        <div class="form-field"><label class="required">Project Code</label><input id="mp_code" value="${escapeHtml(suggestNextProjectCode())}" style="text-transform:uppercase"></div>
        <div class="form-field"><label class="required">Client Name</label><input id="mp_clientName"></div>
        <div class="form-field"><label class="required">Business Name</label><input id="mp_businessName"></div>
        <div class="form-field"><label>Phone</label><input id="mp_phone"></div>
        <div class="form-field"><label class="required">Industry / SME Type</label><select id="mp_industry">${INDUSTRIES.map(s=>`<option>${s}</option>`).join('')}</select></div>
        <div class="form-field"><label class="required">Project Type</label><select id="mp_projectType">${SERVICE_TYPES.map(s=>`<option value="${escapeHtml(s)}">${escapeHtml(serviceDisplayName(s))}</option>`).join('')}</select></div>
        <div class="form-field"><label class="required">Confirmed Value ($)</label><input type="number" id="mp_value" placeholder="e.g. 599" min="1"></div>
        <div class="form-field"><label>Deposit %</label><input type="number" id="mp_depositPct" value="50"></div>
        ${assignedSalesFieldHtml({ id:'mp_sales', currentValue: CURRENT_USER.name })}
        <div class="form-field"><label class="required">Project Status</label><select id="mp_stage">${PROJECT_STAGES.map(s=>`<option>${s}</option>`).join('')}</select></div>
        <div class="form-field"><label>Start Date</label><input type="date" id="mp_start" value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="form-field"><label>Expected Delivery</label><input type="date" id="mp_delivery" value="${daysFromNow(21)}"></div>
        <div class="form-field full"><label>Notes</label><textarea id="mp_notes" placeholder="Optional notes…"></textarea></div>
      </div>
      <p class="text-muted" style="font-size:11.5px;margin:10px 0 0">Confirmed Functions / Scope can be added from the project's detail page after it's created.</p>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="mpCancel">Cancel</button>
      <button class="btn btn-primary" id="mpSave">Create Project</button>
    </div>
  `;

  openModal(html, { large:true, onMount:(overlay)=>{
    overlay.querySelector('#mpClose').onclick = closeModal;
    overlay.querySelector('#mpCancel').onclick = closeModal;

    const searchWrap = overlay.querySelector('#mpLeadSearchWrap');
    const resultsEl = overlay.querySelector('#mpLeadResults');
    const selectedEl = overlay.querySelector('#mpLeadSelected');

    function fillFromLead(lead){
      linkedLead = lead;
      overlay.querySelector('#mp_clientName').value = lead.clientName;
      overlay.querySelector('#mp_businessName').value = lead.businessName;
      overlay.querySelector('#mp_phone').value = lead.phone;
      overlay.querySelector('#mp_industry').value = lead.industry;
      overlay.querySelector('#mp_projectType').value = lead.interestedService;
      overlay.querySelector('#mp_value').value = lead.estimatedValue || 0;
      // A Sales user's Assigned Sales field is a fixed read-only "self"
      // field (see assignedSalesFieldHtml) — linking a lead must never
      // silently reassign the Direct Project to whoever that lead already
      // belonged to (spec §5/§10).
      if(canChooseAssignedSales(CURRENT_USER.role)) overlay.querySelector('#mp_sales').value = lead.assignedSales;
      overlay.querySelector('#mp_notes').value = lead.notes || '';
      resultsEl.innerHTML = '';
      resultsEl.style.display = 'none';
      overlay.querySelector('#mpLeadSearch').value = '';
      // A truthy lead.projectCode alone no longer means "already has a
      // project" — under the current flow it may just be a code reserved
      // earlier (Qualified -> Quote and Demo Sent) with NO Project row
      // yet. Only an actual matching Project row is a genuine duplicate.
      const existing = lead.projectCode ? DB.find('projects', lead.projectCode) : null;
      if(existing){
        selectedEl.innerHTML = `<div class="login-error" style="margin:0">This lead already has project <b>${lead.projectCode}</b> — ${escapeHtml(existing.businessName)}. Creating a new project here would duplicate it. <span class="cell-link" id="mpOpenExisting">Open existing project</span> or unlink first.</div>`;
        overlay.querySelector('#mpOpenExisting').onclick = ()=>{ closeModal(); openProjectDetailModal(lead.projectCode); };
        overlay.querySelector('#mpSave').disabled = true;
      } else {
        // Reuse the lead's already-reserved code as-is (spec §9) rather
        // than the generic suggested one, and lock it — the same rule
        // Confirm Project applies.
        const codeInput = overlay.querySelector('#mp_code');
        if(lead.projectCode){ codeInput.value = lead.projectCode; codeInput.disabled = true; }
        else { codeInput.disabled = false; }
        selectedEl.innerHTML = `<div class="flex-row" style="justify-content:space-between;background:#f7faff;border:1px solid var(--line);border-radius:9px;padding:9px 12px">
          <span class="cell-strong" style="font-size:13px">Linked: ${escapeHtml(lead.id)} — ${escapeHtml(lead.clientName)} (${escapeHtml(lead.businessName)})</span>
          <span class="cell-link" id="mpUnlink" style="font-size:12px">Unlink</span>
        </div>`;
        overlay.querySelector('#mpUnlink').onclick = ()=>{
          linkedLead = null; selectedEl.innerHTML=''; overlay.querySelector('#mpSave').disabled = false;
          codeInput.disabled = false;
        };
        overlay.querySelector('#mpSave').disabled = false;
      }
    }

    overlay.querySelector('#mpLeadSearch').oninput = (e)=>{
      const q = e.target.value.trim().toLowerCase();
      if(!q){ resultsEl.innerHTML=''; resultsEl.style.display='none'; return; }
      const matches = DB.all('leads').filter(l=>
        l.clientName.toLowerCase().includes(q) || l.businessName.toLowerCase().includes(q) ||
        l.phone.includes(q) || l.id.toLowerCase().includes(q)
      ).slice(0,8);
      resultsEl.style.display = matches.length ? 'block' : 'none';
      resultsEl.innerHTML = matches.map(l=>`
        <div class="mini-row" style="cursor:pointer" data-pick="${l.id}">
          <div class="mini-main">
            <div class="mini-title">${escapeHtml(l.clientName)} — ${escapeHtml(l.businessName)}</div>
            <div class="mini-sub">${l.id} · ${escapeHtml(l.industry)}${l.projectCode ? ' · already has project '+l.projectCode : ''}</div>
          </div>
        </div>`).join('');
      resultsEl.querySelectorAll('[data-pick]').forEach(row=>{
        row.onclick = ()=> fillFromLead(DB.find('leads', row.dataset.pick));
      });
    };

    overlay.querySelectorAll('input[name="mp_linkmode"]').forEach(radio=>{
      radio.onchange = ()=>{
        const linking = overlay.querySelector('input[name="mp_linkmode"]:checked').value === 'link';
        searchWrap.style.display = linking ? '' : 'none';
        if(!linking){ linkedLead = null; selectedEl.innerHTML=''; overlay.querySelector('#mpSave').disabled = false; }
      };
    });

    overlay.querySelector('#mpSave').onclick = ()=>{
      const codeInput = overlay.querySelector('#mp_code');
      const code = normalizeProjectCode(codeInput.value);
      if(!code){ codeInput.style.borderColor='var(--red)'; toast('Project Code is required.', 'error'); return; }
      // A code the linked lead already reserved for itself is never a
      // "duplicate" of itself (excludeLeadId) — only a genuinely different
      // collision (another lead/project) is blocked.
      if(isProjectCodeTaken(code, { excludeLeadId: linkedLead ? linkedLead.id : null })){
        codeInput.style.borderColor='var(--red)';
        toast(`Project Code ${code} already exists. Please use a unique Project Code.`, 'error');
        return;
      }
      codeInput.style.borderColor='';
      const clientName = overlay.querySelector('#mp_clientName').value.trim();
      const businessName = overlay.querySelector('#mp_businessName').value.trim();
      if(!clientName || !businessName){ toast('Please fill in Client Name and Business Name.', 'error'); return; }
      // An ACTUAL existing project (not just a reserved code) is still a
      // hard block — fillFromLead() already disables Save for that case,
      // this is defense-in-depth against a tampered/disabled-input bypass.
      if(linkedLead && linkedLead.projectCode && DB.find('projects', linkedLead.projectCode)){
        toast('This lead already has a project — cannot create a duplicate.', 'error'); return;
      }

      const confirmedValue = Number(overlay.querySelector('#mp_value').value)||0;
      if(confirmedValue<=0){ toast('Please enter a Confirmed Value greater than $0.', 'error'); return; }
      const depositPct = Number(overlay.querySelector('#mp_depositPct').value)||0;
      const stage = overlay.querySelector('#mp_stage').value;
      const phone = overlay.querySelector('#mp_phone').value.trim();

      // Obvious-duplicate check (spec §5): same business name or same
      // phone already on an existing project OR an existing, still-open
      // lead. Warns rather than blocks outright, in case it's genuinely a
      // second, unrelated project for a repeat client (e.g. the same
      // person commissioning a different business).
      const dupes = findLikelyDuplicateProjects({ businessName, phone });
      if(dupes.length){
        const list = dupes.map(d=> d.kind==='lead'
          ? `${d.id} — ${d.businessName} (existing Lead, not yet linked to a project)`
          : `${d.id} — ${d.businessName}`
        ).join('\n');
        const hasUnlinkedLead = dupes.some(d=>d.kind==='lead') && !linkedLead;
        const suggestion = hasUnlinkedLead
          ? '\n\nConsider choosing "Link to Existing Lead" above and searching for one of these leads instead, so this project stays connected to its lead history.'
          : '';
        if(!confirm(`A project or lead with a similar business name or phone number already exists:\n\n${list}${suggestion}\n\nCreate this Direct Project anyway?`)) return;
      }

      // Sales always creates a Direct Project assigned to themselves — no
      // dropdown choice was ever offered to them (spec §5/§10), enforced
      // again here in case of a tampered DOM value.
      const assignedSales = canChooseAssignedSales(CURRENT_USER.role) ? overlay.querySelector('#mp_sales').value : CURRENT_USER.name;

      const proj = createProjectRecord({
        code, lead: linkedLead, confirmedValue, depositPct,
        startDate: overlay.querySelector('#mp_start').value,
        expectedDelivery: overlay.querySelector('#mp_delivery').value,
        overrides: {
          clientName, businessName, phone,
          industry: overlay.querySelector('#mp_industry').value,
          projectType: overlay.querySelector('#mp_projectType').value,
          assignedSales,
          notes: overlay.querySelector('#mp_notes').value.trim(),
          leadSource: linkedLead ? undefined : 'Direct',
        }
      });
      proj.stage = stage;
      DB.upsert('projects', proj);

      logActivity({ userName: CURRENT_USER.name, refType:'project', refId: code, refLabel:`${code} — ${businessName}`,
        type:'Project Created',
        description: linkedLead
          ? `${CURRENT_USER.name} created project ${code} manually, linked to lead ${linkedLead.id}. Client: ${clientName}. Value: ${money(confirmedValue)}.`
          : `${CURRENT_USER.name} created project ${code}. Client: ${clientName}. Value: ${money(confirmedValue)}.`,
        toValue: stage });

      if(linkedLead){
        logActivity({ userName: CURRENT_USER.name, refType:'lead', refId: linkedLead.id, refLabel:`${linkedLead.clientName} — ${linkedLead.businessName}`,
          type:'Project Created', description:`${CURRENT_USER.name} manually linked this lead to new project ${code}.` });
      }

      toast(`Project ${code} created.`, 'success');
      closeModal();
      refreshAfterLeadOrProjectChange();
    };
  }});
}
