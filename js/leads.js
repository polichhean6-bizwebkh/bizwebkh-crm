/* ==========================================================================
   BizWeb KH CRM — leads.js
   Leads table (search/filter), Add/Edit Lead form, Lead detail modal with
   full activity history, status-change + reassignment flows.
   ========================================================================== */

let LEADS_FILTER_STATE = { search:'', status:'', sales:'', industry:'', service:'', source:'', followup:'', dateRange:'all', archiveView:'active' };

// Leads not currently archived — the default view everywhere except the
// Lead Records page's own Active/Archived/All filter (spec §15): Pipeline
// and Follow-ups always use this, since an archived lead should never
// reappear there regardless of what the Lead Records filter is set to.
function activeLeads(){ return DB.all('leads').filter(l=>!l.archived); }

// Lead Created Date filter — filters on lead.createdAt (NOT nextFollowup).
// Default is 'all' so nothing is hidden until the user picks a range. A lead
// with no createdAt (no reliable date could be extracted from its source
// documents) is only ever included under "All Time" — it never matches a
// specific range, since that would require guessing a date.
function leadMatchesDateRange(lead, range){
  if(!range || range==='all') return true;
  if(!lead.createdAt) return false;
  const created = new Date(lead.createdAt);
  if(isNaN(created)) return false;
  const now = new Date();
  if(range==='today'){
    return created.toDateString() === now.toDateString();
  }
  if(range==='week'){
    const start = new Date(now); start.setHours(0,0,0,0); start.setDate(start.getDate() - start.getDay());
    const end = new Date(start); end.setDate(end.getDate()+7);
    return created>=start && created<end;
  }
  if(range==='month'){
    return created.getFullYear()===now.getFullYear() && created.getMonth()===now.getMonth();
  }
  return true;
}
let LEADS_PAGE = 1;
const LEADS_PAGE_SIZE = 20;

function renderLeadsPage(){
  const el = document.getElementById('pageContent');
  el.innerHTML = `
    <div id="leadSummaryCards"></div>
    <div class="filters-bar">
      <div class="search-box">
        ${icon('search')}
        <input type="text" id="leadSearch" placeholder="Search client, business, phone, or Lead ID…" value="${escapeHtml(LEADS_FILTER_STATE.search)}">
      </div>
      <select id="fltStatus" class="sel"><option value="">All Statuses</option>${LEAD_STATUSES.map(s=>`<option ${LEADS_FILTER_STATE.status===s?'selected':''}>${s}</option>`).join('')}</select>
      <select id="fltIndustry" class="sel"><option value="">All Industries</option>${INDUSTRIES.map(s=>`<option ${LEADS_FILTER_STATE.industry===s?'selected':''}>${s}</option>`).join('')}</select>
      <select id="fltService" class="sel"><option value="">All Services</option>${SERVICE_TYPES.map(s=>`<option ${LEADS_FILTER_STATE.service===s?'selected':''}>${s}</option>`).join('')}</select>
      <select id="fltSales" class="sel"><option value="">All Sales</option>${salesOwnersList().map(s=>`<option ${LEADS_FILTER_STATE.sales===s?'selected':''}>${s}</option>`).join('')}</select>
      <select id="fltSource" class="sel"><option value="">All Sources</option>${LEAD_SOURCES.map(s=>`<option ${LEADS_FILTER_STATE.source===s?'selected':''}>${s}</option>`).join('')}</select>
      <select id="fltArchive" class="sel" title="Active/Archived leads">
        <option value="active" ${LEADS_FILTER_STATE.archiveView==='active'?'selected':''}>Active</option>
        <option value="archived" ${LEADS_FILTER_STATE.archiveView==='archived'?'selected':''}>Archived</option>
        <option value="all" ${LEADS_FILTER_STATE.archiveView==='all'?'selected':''}>All</option>
      </select>
      <select id="fltDateRange" class="sel" title="Filters by Lead Created Date">
        <option value="all" ${LEADS_FILTER_STATE.dateRange==='all'?'selected':''}>All Time</option>
        <option value="today" ${LEADS_FILTER_STATE.dateRange==='today'?'selected':''}>Today</option>
        <option value="week" ${LEADS_FILTER_STATE.dateRange==='week'?'selected':''}>This Week</option>
        <option value="month" ${LEADS_FILTER_STATE.dateRange==='month'?'selected':''}>This Month</option>
      </select>
      <select id="fltFollowup" class="sel">
        <option value="">Any Follow-up</option>
        <option value="overdue" ${LEADS_FILTER_STATE.followup==='overdue'?'selected':''}>Overdue</option>
        <option value="today" ${LEADS_FILTER_STATE.followup==='today'?'selected':''}>Today</option>
        <option value="week" ${LEADS_FILTER_STATE.followup==='week'?'selected':''}>This Week</option>
      </select>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="addLeadBtn">${icon('grid')} + Add Lead</button>
    </div>
    <div id="leadsTableWrap"></div>
  `;

  const rerender = ()=>{ LEADS_PAGE = 1; renderLeadSummaryCards(); renderLeadsTable(); };
  document.getElementById('leadSearch').oninput = (e)=>{ LEADS_FILTER_STATE.search = e.target.value; rerender(); };
  document.getElementById('fltStatus').onchange = (e)=>{ LEADS_FILTER_STATE.status = e.target.value; rerender(); };
  document.getElementById('fltSales').onchange = (e)=>{ LEADS_FILTER_STATE.sales = e.target.value; rerender(); };
  document.getElementById('fltIndustry').onchange = (e)=>{ LEADS_FILTER_STATE.industry = e.target.value; rerender(); };
  document.getElementById('fltService').onchange = (e)=>{ LEADS_FILTER_STATE.service = e.target.value; rerender(); };
  document.getElementById('fltSource').onchange = (e)=>{ LEADS_FILTER_STATE.source = e.target.value; rerender(); };
  document.getElementById('fltDateRange').onchange = (e)=>{ LEADS_FILTER_STATE.dateRange = e.target.value; rerender(); };
  document.getElementById('fltArchive').onchange = (e)=>{ LEADS_FILTER_STATE.archiveView = e.target.value; rerender(); };
  document.getElementById('fltFollowup').onchange = (e)=>{ LEADS_FILTER_STATE.followup = e.target.value; rerender(); };
  document.getElementById('addLeadBtn').onclick = ()=> openLeadFormModal(null);

  renderLeadSummaryCards();
  renderLeadsTable();
}

function salesOwnersList(){
  const names = new Set(DB.all('users').map(u=>u.name));
  DB.all('leads').forEach(l=>names.add(l.assignedSales));
  return [...names].sort();
}

/* ---------------------------------------------------------------------- */
/* Assigned Sales field — shared by Add/Edit Lead (this file) and Direct  */
/* Project / Edit Project (projects.js). A Sales user never sees a real   */
/* dropdown here (spec §2/§10/§11) — they get a read-only field showing   */
/* who it's assigned to (themselves for anything they're creating), so    */
/* there's no dropdown option that would just produce a permission error. */
/* Founder/Admin (and any other non-Sales role) still get the full        */
/* picker, always including "Unassigned".                                 */
/* ---------------------------------------------------------------------- */

// Temporary/test accounts (e.g. the QA Sales Test account) stay fully
// functional for QA, but must never appear as a normal assignment choice
// to anyone except Founder/Admin (spec §3). Not tied to a DB flag (none
// exists yet) — matched by name so it's trivial to extend/remove later.
const TEST_ACCOUNT_NAMES = ['QA Sales Test'];
function isTestAccountName(name){ return TEST_ACCOUNT_NAMES.includes(name); }

// Users selectable as "Assigned Sales" for a Founder/Admin (or any other
// non-Sales role): Founder/Admin accounts + active Sales accounts, always
// with "Unassigned" available. Test accounts are only included while the
// viewer IS Founder/Admin.
function assignableSalesUserNames(){
  const eligible = DB.all('users').filter(u=> u.role==='founder_admin' || /sales/i.test(u.role));
  const visible = eligible.filter(u=> isFounder() || !isTestAccountName(u.name));
  const names = [...new Set(visible.map(u=>u.name))].sort();
  return ['Unassigned', ...names];
}

// Renders the "Assigned Sales" field for Add/Edit Lead and Create Direct
// Project / Edit Project. `currentValue` is the existing assignment (or
// null/undefined when creating new). For Sales, this is always a disabled,
// read-only field — never a dropdown — showing "Me / <Display Name>"; its
// value on save is always the logged-in Sales user (enforced again at save
// time in each caller, not just here, per spec §2/§5/§10).
function assignedSalesFieldHtml({ id, currentValue }){
  if(canChooseAssignedSales(CURRENT_USER.role)){
    let options = assignableSalesUserNames();
    if(currentValue && !options.includes(currentValue)) options = [...options, currentValue];
    return `<div class="form-field"><label class="required">Assigned Sales</label>
      <select id="${id}">${options.map(s=>`<option ${currentValue===s?'selected':''}>${s}</option>`).join('')}</select></div>`;
  }
  const displayName = (currentValue && currentValue!=='Unassigned') ? currentValue : CURRENT_USER.name;
  return `<div class="form-field"><label>Assigned Sales</label>
    <input id="${id}" value="Me / ${escapeHtml(displayName)}" disabled>
    <span class="form-hint">Automatically assigned to you.</span></div>`;
}

function renderLeadSummaryCards(){
  const el = document.getElementById('leadSummaryCards');
  if(!el) return;
  const all = DB.all('leads');
  const total = all.length;
  const lost = all.filter(l=>l.status==='Lost').length;
  const confirmed = all.filter(l=>l.projectCode && l.status!=='Lost').length;
  const open = total - lost - confirmed;
  const followupDue = all.filter(l=> l.nextFollowup && ['overdue','today'].includes(urgencyOf(l.nextFollowup)) && !['Lost','Confirmed'].includes(l.status)).length;
  const cards = [
    { label:'Total Leads', value: total, color:'#1d7bff' },
    { label:'Open Leads', value: open, color:'#18c8ff' },
    { label:'Confirmed', value: confirmed, color:'#12a775' },
    { label:'Lost', value: lost, color:'#e0473c' },
    { label:'Follow-up Due', value: followupDue, color:'#d98a12' },
  ];
  el.innerHTML = `
    <div class="kpi-grid summary-cards-5">
      ${cards.map(c=>`
        <div class="kpi-card" style="padding:12px 14px">
          <div class="kpi-value" style="font-size:20px;color:${c.color}">${c.value}</div>
          <div class="kpi-label" style="margin-top:4px">${c.label}</div>
        </div>`).join('')}
    </div>
  `;
}

function filteredLeads(){
  const f = LEADS_FILTER_STATE;
  return DB.all('leads').filter(l=>{
    if(f.archiveView==='active' && l.archived) return false;
    if(f.archiveView==='archived' && !l.archived) return false;
    // f.archiveView==='all' → no filtering by archive state
    if(f.search){
      const q = f.search.toLowerCase();
      if(!(l.clientName.toLowerCase().includes(q) || l.businessName.toLowerCase().includes(q) || l.phone.includes(q) || l.id.toLowerCase().includes(q))) return false;
    }
    if(f.status && l.status!==f.status) return false;
    if(f.sales && l.assignedSales!==f.sales) return false;
    if(f.industry && l.industry!==f.industry) return false;
    if(f.service && l.interestedService!==f.service) return false;
    if(f.source && l.leadSource!==f.source) return false;
    if(!leadMatchesDateRange(l, f.dateRange)) return false;
    if(f.followup){
      const u = urgencyOf(l.nextFollowup);
      if(f.followup==='overdue' && u!=='overdue') return false;
      if(f.followup==='today' && u!=='today') return false;
      if(f.followup==='week' && !['today','tomorrow','week'].includes(u)) return false;
    }
    return true;
  }).sort((a,b)=> new Date(b.updatedAt)-new Date(a.updatedAt));
}

function renderLeadsTable(){
  const wrap = document.getElementById('leadsTableWrap');
  const allFiltered = filteredLeads();
  const totalPages = Math.max(1, Math.ceil(allFiltered.length / LEADS_PAGE_SIZE));
  if(LEADS_PAGE > totalPages) LEADS_PAGE = totalPages;
  if(LEADS_PAGE < 1) LEADS_PAGE = 1;
  const startIdx = (LEADS_PAGE-1) * LEADS_PAGE_SIZE;
  const pageLeads = allFiltered.slice(startIdx, startIdx + LEADS_PAGE_SIZE);

  wrap.innerHTML = `
    <div class="table-wrap scroll-x">
      <table class="data-table">
        <thead>
          <tr>
            <th>Lead ID</th><th>Client</th><th>Business</th><th>Industry</th>
            <th>Interested Service</th><th>Est. Value</th>
            <th>Sales</th><th>Status</th><th>Next Follow-up</th><th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${pageLeads.length ? pageLeads.map(l=>`
            <tr>
              <td class="cell-link" data-open="${l.id}">${l.id}</td>
              <td class="cell-strong">${escapeHtml(l.clientName)}</td>
              <td>${escapeHtml(l.businessName)}${l.projectCode ? `<div class="cell-sub">Project ${l.projectCode}${DB.find('projects',l.projectCode) ? ' · '+escapeHtml(DB.find('projects',l.projectCode).stage) : ''}</div>`:''}</td>
              <td>${escapeHtml(industryLabel(l.industry))}</td>
              <td>${escapeHtml(l.interestedService)}</td>
              <td class="cell-strong">${money(l.estimatedValue)}</td>
              <td><div class="flex-row"><div class="avatar-sm" style="background:${userColor(l.assignedSales)}">${userInitials(l.assignedSales)}</div>${escapeHtml(l.assignedSales)}</div></td>
              <td>${statusBadge(l.status)}${l.archived ? `<div class="cell-sub" style="color:var(--muted)">Archived</div>` : ''}</td>
              <td>${urgencyChip(l.nextFollowup)}</td>
              <td><button class="btn btn-secondary btn-sm" data-open="${l.id}">View</button></td>
            </tr>`).join('') : `<tr><td colspan="10"><div class="empty-row">No leads match your filters.</div></td></tr>`}
        </tbody>
      </table>
    </div>
    ${renderLeadsPagination(allFiltered.length, totalPages)}
  `;
  wrap.querySelectorAll('[data-open]').forEach(x=> x.onclick = ()=> openLeadDetailModal(x.dataset.open));
  wrap.querySelectorAll('[data-page]').forEach(x=> x.onclick = ()=>{
    const p = x.dataset.page;
    if(p==='prev') LEADS_PAGE = Math.max(1, LEADS_PAGE-1);
    else if(p==='next') LEADS_PAGE = Math.min(totalPages, LEADS_PAGE+1);
    else LEADS_PAGE = Number(p);
    renderLeadsTable();
  });
}

function renderLeadsPagination(totalCount, totalPages){
  if(totalCount===0) return '';
  const startIdx = (LEADS_PAGE-1)*LEADS_PAGE_SIZE;
  const shownFrom = totalCount ? startIdx+1 : 0;
  const shownTo = Math.min(totalCount, startIdx+LEADS_PAGE_SIZE);

  let pageBtns = '';
  for(let p=1; p<=totalPages; p++){
    if(totalPages>7 && p!==1 && p!==totalPages && Math.abs(p-LEADS_PAGE)>2){
      if(p===2 || p===totalPages-1) pageBtns += `<span style="padding:0 4px;color:var(--muted)">…</span>`;
      continue;
    }
    pageBtns += `<button class="btn ${p===LEADS_PAGE?'btn-primary':'btn-secondary'} btn-sm" data-page="${p}" style="min-width:34px">${p}</button>`;
  }

  return `
    <div class="flex-row" style="justify-content:space-between;flex-wrap:wrap;gap:10px;margin-top:12px">
      <p class="text-muted" style="margin:0;font-size:12px">Showing ${shownFrom}–${shownTo} of ${totalCount} leads</p>
      <div class="flex-row" style="gap:6px">
        <button class="btn btn-secondary btn-sm" data-page="prev" ${LEADS_PAGE<=1?'disabled':''}>Previous</button>
        ${pageBtns}
        <button class="btn btn-secondary btn-sm" data-page="next" ${LEADS_PAGE>=totalPages?'disabled':''}>Next</button>
      </div>
    </div>
  `;
}

/* ---------------------------------------------------------------------- */
/* Add / Edit Lead form                                                   */
/* ---------------------------------------------------------------------- */

function openLeadFormModal(leadId){
  const editing = !!leadId;
  const lead = editing ? DB.find('leads', leadId) : null;
  const html = `
    <div class="modal-head"><h3>${editing?'Edit Lead':'Add New Lead'}</h3><button class="modal-close" id="lfClose">&times;</button></div>
    <div class="modal-body">
      <div class="form-grid">
        <div class="form-field"><label class="required">Client Name</label><input id="lf_clientName" value="${escapeHtml(lead?.clientName||'')}"></div>
        <div class="form-field"><label class="required">Business Name</label><input id="lf_businessName" value="${escapeHtml(lead?.businessName||'')}"></div>
        <div class="form-field"><label class="required">Phone</label><input id="lf_phone" value="${escapeHtml(lead?.phone||'')}"></div>
        <div class="form-field"><label>Telegram</label><input id="lf_telegram" value="${escapeHtml(lead?.telegram||'')}"></div>
        <div class="form-field"><label>Facebook</label><input id="lf_facebook" value="${escapeHtml(lead?.facebook||'')}"></div>
        <div class="form-field"><label class="required">Industry / SME Type</label>
          <select id="lf_industry">${INDUSTRIES.map(s=>`<option ${lead?.industry===s?'selected':''}>${s}</option>`).join('')}</select></div>
        <div class="form-field"><label class="required">Interested Service</label>
          <select id="lf_service">${SERVICE_TYPES.map(s=>`<option ${lead?.interestedService===s?'selected':''}>${s}</option>`).join('')}</select></div>
        <div class="form-field"><label class="required">Estimated Value ($)</label><input type="number" id="lf_value" value="${lead?.estimatedValue||''}"></div>
        <div class="form-field"><label class="required">Lead Source</label>
          <select id="lf_source">${LEAD_SOURCES.map(s=>`<option ${lead?.leadSource===s?'selected':''}>${s}</option>`).join('')}</select></div>
        ${assignedSalesFieldHtml({ id:'lf_sales', currentValue: lead?.assignedSales })}
        <div class="form-field"><label class="required">Current Status</label>
          <select id="lf_status" ${editing?'disabled':''}>${LEAD_STATUSES.map(s=>`<option ${(lead?.status||'New Lead')===s?'selected':''}>${s}</option>`).join('')}</select>
          ${editing?'<span class="form-hint">Use the status button on the lead detail page to change status (it will be logged).</span>':''}
        </div>
        <div class="form-field"><label>Next Follow-up Date</label><input type="date" id="lf_followup" value="${lead?.nextFollowup||''}"></div>
        <div class="form-field full"><label>Notes</label><textarea id="lf_notes">${escapeHtml(lead?.notes||'')}</textarea></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="lfCancel">Cancel</button>
      <button class="btn btn-primary" id="lfSave">${editing?'Save Changes':'Create Lead'}</button>
    </div>
  `;
  openModal(html, { large:true, onMount:(overlay)=>{
    overlay.querySelector('#lfClose').onclick = closeModal;
    overlay.querySelector('#lfCancel').onclick = closeModal;
    overlay.querySelector('#lfSave').onclick = ()=>{
      const val = id => overlay.querySelector(id).value.trim();
      const clientName = val('#lf_clientName'), businessName = val('#lf_businessName'), phone = val('#lf_phone');
      if(!clientName || !businessName || !phone){ toast('Please fill in Client Name, Business Name and Phone.', 'error'); return; }
      const now = new Date().toISOString();

      if(editing){
        lead.clientName = clientName; lead.businessName = businessName; lead.phone = phone;
        lead.telegram = val('#lf_telegram'); lead.facebook = val('#lf_facebook');
        lead.industry = val('#lf_industry'); lead.interestedService = val('#lf_service');
        lead.estimatedValue = Number(val('#lf_value'))||0; lead.leadSource = val('#lf_source');
        // A Sales user never has a real dropdown here (assignedSalesFieldHtml
        // renders a disabled field for them) — enforced again here so a
        // Sales user can never reassign a lead away from themselves, even
        // via a tampered DOM value (spec §2/§11).
        const newSales = canChooseAssignedSales(CURRENT_USER.role) ? val('#lf_sales') : lead.assignedSales;
        if(newSales !== lead.assignedSales){
          logActivity({ userName: CURRENT_USER.name, refType:'lead', refId: lead.id, refLabel:`${lead.clientName} — ${lead.businessName}`,
            type:'Assigned Sales Changed', description:`${CURRENT_USER.name} reassigned lead: ${lead.assignedSales} → ${newSales}`,
            fromValue: lead.assignedSales, toValue: newSales });
          lead.assignedSales = newSales;
        }
        const newFollowup = val('#lf_followup') || null;
        if(newFollowup !== lead.nextFollowup){
          // Same field the Set Follow-up / Reschedule modals write to
          // (spec §10) — Pipeline reads it live, so no separate sync step
          // and no duplicate follow-up record is ever created.
          lead.followUpCreatedBy = lead.followUpCreatedBy || (newFollowup ? CURRENT_USER.name : lead.followUpCreatedBy);
          lead.followUpUpdatedAt = now;
        }
        lead.nextFollowup = newFollowup;
        lead.notes = val('#lf_notes');
        lead.updatedAt = now;
        DB.upsert('leads', lead);
        logActivity({ userName: CURRENT_USER.name, refType:'lead', refId: lead.id, refLabel:`${lead.clientName} — ${lead.businessName}`,
          type:'Lead Edited', description:`${CURRENT_USER.name} edited lead ${lead.id} details.` });
        toast('Lead updated.', 'success');
      } else {
        const id = DB.nextId('L','leads');
        const newLead = {
          id, clientName, businessName, phone,
          telegram: val('#lf_telegram'), facebook: val('#lf_facebook'),
          industry: val('#lf_industry'), interestedService: val('#lf_service'),
          estimatedValue: Number(val('#lf_value'))||0, leadSource: val('#lf_source'),
          // Sales always creates a lead assigned to themselves — no dropdown
          // choice was ever offered to them (spec §2). Founder/Admin's pick
          // (or "Unassigned") is honored as entered.
          assignedSales: canChooseAssignedSales(CURRENT_USER.role) ? val('#lf_sales') : CURRENT_USER.name,
          status: val('#lf_status'),
          nextFollowup: val('#lf_followup') || null, lastContact: null,
          expectedCloseDate: null, quotationStatus:'Not Sent', quotationAmount:null, quotationRef:'',
          demoLink:'', notes: val('#lf_notes'), lostReason:null, projectCode:null,
          archived:false, archivedAt:null, archivedBy:null, archiveReason:null,
          followUpCreatedBy: val('#lf_followup') ? CURRENT_USER.name : null,
          followUpUpdatedAt: val('#lf_followup') ? now : null,
          createdAt: now, updatedAt: now
        };
        DB.upsert('leads', newLead);
        logActivity({ userName: CURRENT_USER.name, refType:'lead', refId: id, refLabel:`${clientName} — ${businessName}`,
          type:'Lead Created', description:`${CURRENT_USER.name} created lead ${id} (${businessName}) from ${newLead.leadSource}.`,
          toValue: newLead.status });
        toast('Lead created.', 'success');
      }
      closeModal();
      if(currentRoute()==='leads') renderLeadsTable();
      if(currentRoute()==='dashboard') router();
    };
  }});
}

/* ---------------------------------------------------------------------- */
/* Lead detail modal                                                      */
/* ---------------------------------------------------------------------- */

let LEAD_DETAIL_TAB = 'overview';

function openLeadDetailModal(leadId){
  LEAD_DETAIL_TAB = 'overview';
  renderLeadDetail(leadId);
}

function renderLeadDetail(leadId){
  const lead = DB.find('leads', leadId);
  if(!lead){ toast('Lead not found.', 'error'); return; }
  const acts = activitiesFor(leadId);

  const html = `
    <div class="modal-head">
      <div>
        <h3>${escapeHtml(lead.clientName)} — ${escapeHtml(lead.businessName)}</h3>
        <div class="text-muted" style="font-size:12px;margin-top:2px">${lead.id}${lead.projectCode?' · Project '+lead.projectCode:''}</div>
      </div>
      <button class="modal-close" id="ldClose">&times;</button>
    </div>
    <div class="modal-body">
      ${lead.archived ? `
      <div class="panel" style="padding:10px 14px;background:var(--gray-soft);border:1px solid var(--line);margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <span class="text-muted" style="font-size:12.5px">This lead is archived — hidden from Lead Records and Pipeline (including its follow-up workflow) by default.${lead.archiveReason?` Reason: ${escapeHtml(lead.archiveReason)}.`:''}</span>
        <button class="btn btn-outline btn-sm" id="ldRestore">Restore Lead</button>
      </div>` : ''}
      <div class="flex-row" style="justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:10px">
        <div class="flex-row">${statusBadge(lead.status)}${lead.lostReason?`<span class="text-muted" style="font-size:12px">Reason: ${escapeHtml(lead.lostReason)}</span>`:''}</div>
        <div class="flex-row" style="flex-wrap:wrap;gap:8px">
          <button class="btn btn-secondary btn-sm" id="ldEdit">Edit</button>
          ${!['Lost','Confirmed'].includes(lead.status) ? `<button class="btn btn-outline btn-sm" id="ldChangeStatus">Change Status</button>`:''}
          ${['Confirmed','Deposit Paid','In Development','Final Payment Pending','Completed'].includes(lead.status) && !lead.projectCode ? `<button class="btn btn-primary btn-sm" id="ldCreateProject">+ Create Project</button>` : ''}
        </div>
      </div>

      <div class="tabs">
        <div class="tab-btn ${LEAD_DETAIL_TAB==='overview'?'active':''}" data-tab="overview">Overview</div>
        <div class="tab-btn ${LEAD_DETAIL_TAB==='quotation'?'active':''}" data-tab="quotation">Quotation & Project</div>
        <div class="tab-btn ${LEAD_DETAIL_TAB==='history'?'active':''}" data-tab="history">Activity History (${acts.length})</div>
      </div>

      <div id="ldTabBody"></div>
    </div>
    <div class="modal-foot" style="justify-content:space-between">
      <div class="flex-row" style="gap:8px">
        ${!lead.archived ? `<button class="btn btn-ghost btn-sm" id="ldArchive" style="color:var(--muted)">Archive Lead</button>` : ''}
        <button class="btn btn-danger btn-sm" id="ldDelete" style="opacity:.85">Delete Lead</button>
      </div>
      <button class="btn btn-secondary" id="ldClose2">Close</button>
    </div>
  `;

  openModal(html, { large:true, onMount:(overlay)=>{
    overlay.querySelector('#ldClose').onclick = closeModal;
    overlay.querySelector('#ldClose2').onclick = closeModal;
    overlay.querySelector('#ldEdit').onclick = ()=> openLeadFormModal(lead.id);
    const changeBtn = overlay.querySelector('#ldChangeStatus');
    if(changeBtn) changeBtn.onclick = ()=> openLeadStatusPicker(lead);
    const createProjBtn = overlay.querySelector('#ldCreateProject');
    if(createProjBtn) createProjBtn.onclick = ()=> createProjectFromLead(lead.id, ()=> renderLeadDetail(lead.id));
    const restoreBtn = overlay.querySelector('#ldRestore');
    if(restoreBtn) restoreBtn.onclick = ()=> restoreLead(lead, ()=> renderLeadDetail(lead.id));
    const archiveBtn = overlay.querySelector('#ldArchive');
    if(archiveBtn) archiveBtn.onclick = ()=> openArchiveLeadModal(lead, ()=> renderLeadDetail(lead.id));
    overlay.querySelector('#ldDelete').onclick = ()=> openDeleteLeadModal(lead);

    overlay.querySelectorAll('.tab-btn').forEach(t=> t.onclick = ()=>{ LEAD_DETAIL_TAB = t.dataset.tab; renderLeadDetail(lead.id); });

    const tabBody = overlay.querySelector('#ldTabBody');
    if(LEAD_DETAIL_TAB==='overview') tabBody.innerHTML = leadOverviewTab(lead);
    else if(LEAD_DETAIL_TAB==='quotation') tabBody.innerHTML = leadQuotationTab(lead);
    else tabBody.innerHTML = leadHistoryTab(acts);

    if(LEAD_DETAIL_TAB==='quotation') wireLinkedQuotations(tabBody);

    if(LEAD_DETAIL_TAB==='overview'){
      const fuBtn = overlay.querySelector('#ldAddFollowup');
      if(fuBtn) fuBtn.onclick = ()=> openFollowupNoteModal(lead.id, ()=> renderLeadDetail(lead.id));
      const setFuBtn = overlay.querySelector('#ldSetFollowup');
      if(setFuBtn) setFuBtn.onclick = ()=> openSetFollowupModal(lead.id, ()=> renderLeadDetail(lead.id));
      const completeFuBtn = overlay.querySelector('#ldCompleteFollowup');
      if(completeFuBtn) completeFuBtn.onclick = ()=> openCompleteFollowupModal(lead.id, ()=> renderLeadDetail(lead.id));
    }
  }});
}

function leadOverviewTab(lead){
  return `
    <div class="two-col">
      <div>
        <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">Client Information</div>
        ${infoRow('Client Name', lead.clientName)}
        ${infoRow('Business Name', lead.businessName)}
        ${infoRow('Phone', lead.phone)}
        ${infoRow('Telegram', lead.telegram)}
        ${infoRow('Facebook', lead.facebook)}
        ${infoRow('Industry / SME Type', lead.industry)}
        ${infoRow('Lead Source', lead.leadSource)}
      </div>
      <div>
        <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">Sales Information</div>
        ${infoRow('Interested Service', lead.interestedService)}
        ${infoRow('Estimated Value', money(lead.estimatedValue))}
        ${infoRow('Assigned Sales', lead.assignedSales)}
        ${infoRow('Expected Close Date', fmtDate(lead.expectedCloseDate))}
        ${infoRow('Current Status', lead.status)}
      </div>
    </div>
    <div class="divider"></div>
    <div class="two-col">
      <div>
        <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">Follow-up</div>
        <div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;font-size:13px;border-bottom:1px solid #f2f5fa">
          <span class="text-muted">Next Follow-up</span>
          <span>${lead.nextFollowup ? urgencyChip(lead.nextFollowup) : '<span class="cell-strong">—</span>'}</span>
        </div>
        ${infoRow('Last Contact', lead.lastContact ? fmtDate(lead.lastContact) : '—')}
      </div>
      <div style="display:flex;align-items:flex-end;justify-content:flex-end">
        ${!['Lost','Confirmed'].includes(lead.status) ? `
        <div class="flex-row" style="flex-wrap:wrap;gap:8px;justify-content:flex-end">
          <button class="btn btn-outline btn-sm" id="ldSetFollowup">${lead.nextFollowup?'Reschedule':'Set Follow-up'}</button>
          <button class="btn btn-outline btn-sm" id="ldCompleteFollowup">Complete Follow-up</button>
          <button class="btn btn-outline btn-sm" id="ldAddFollowup">+ Add Note</button>
        </div>` : ''}
      </div>
    </div>
    ${lead.notes ? `<div class="divider"></div><div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">Notes</div><p style="font-size:13px;margin:0">${escapeHtml(lead.notes)}</p>` : ''}
  `;
}

function leadQuotationTab(lead){
  const proj = lead.projectCode ? DB.find('projects', lead.projectCode) : null;
  const summary = proj ? paymentSummaryFor(proj.id) : null;
  return `
    <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">Quotation</div>
    ${infoRow('Quotation Status', lead.quotationStatus)}
    ${infoRow('Quotation Amount', lead.quotationAmount ? money(lead.quotationAmount) : '—')}
    ${infoRow('Quotation File / Ref', lead.quotationRef || '—')}
    ${infoRow('Demo Link', lead.demoLink || '—')}
    <div class="divider"></div>
    ${linkedQuotationsHtml(lead.id, null)}
    <div class="divider"></div>
    <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">Project</div>
    ${proj ? `
      ${infoRow('Project Code', proj.id)}
      ${infoRow('Project Status', proj.stage)}
      ${infoRow('Project Value', money(summary.confirmedValue))}
      ${infoRow('Total Paid', money(summary.totalPaid))}
      ${infoRow('Remaining Balance', money(summary.remaining))}
      ${infoRow('Payment Status', summary.status)}
    ` : `<p class="text-muted" style="font-size:13px">No project created yet for this lead.</p>`}
  `;
}

function leadHistoryTab(acts){
  if(!acts.length) return `<div class="empty-row">No activity yet.</div>`;
  return `<div class="timeline">${acts.map(a=>`
    <div class="tl-item">
      <div class="tl-dot"></div>
      <div class="tl-body">
        <div class="tl-title"><b>${escapeHtml(a.userName)}</b> — ${escapeHtml(a.type)}</div>
        <div class="tl-meta">${fmtDateTime(a.at)}</div>
        ${a.fromValue || a.toValue ? `<div class="tl-meta" style="margin-top:2px">${escapeHtml(a.fromValue||'—')} → ${escapeHtml(a.toValue||'—')}</div>` : ''}
        ${a.remark ? `<div class="tl-remark">${escapeHtml(a.remark)}</div>` : `${!a.fromValue && !a.toValue ? `<div class="tl-remark">${escapeHtml(a.description)}</div>`:''}`}
      </div>
    </div>`).join('')}</div>`;
}

function infoRow(label, value){
  return `<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;font-size:13px;border-bottom:1px solid #f2f5fa">
    <span class="text-muted">${label}</span><span class="cell-strong" style="text-align:right">${escapeHtml(value||'—')}</span>
  </div>`;
}

/* ---------------------------------------------------------------------- */
/* Status change trigger (choose next status, then confirm modal)         */
/* ---------------------------------------------------------------------- */

function openLeadStatusPicker(lead){
  const options = LEAD_STATUSES.filter(s=>s!==lead.status);
  const html = `
    <div class="modal-head"><h3>Move to which status?</h3><button class="modal-close" id="spClose">&times;</button></div>
    <div class="modal-body">
      <div class="form-field"><label>New Status</label>
        <select id="spSelect">${options.map(s=>`<option>${s}</option>`).join('')}</select>
      </div>
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
      const newStatus = overlay.querySelector('#spSelect').value;
      closeModal();
      applyLeadStatusChange(lead, newStatus);
    };
  }});
}

function applyLeadStatusChange(lead, newStatus){
  // Moving a lead to Confirmed always goes through the dedicated
  // Confirm Project flow (auto-creates the linked Project, with
  // duplicate protection) instead of the generic status-change modal.
  if(newStatus === 'Confirmed'){
    openConfirmProjectModal(lead);
    return;
  }
  openStatusChangeModal({
    refType:'lead', refId: lead.id, refLabel:`${lead.clientName} — ${lead.businessName}`,
    fromStatus: lead.status, toStatus: newStatus,
    onConfirm: ({ remark, lostReason })=>{
      const prevStatus = lead.status;
      lead.status = newStatus;
      lead.updatedAt = new Date().toISOString();
      if(newStatus==='Lost') lead.lostReason = lostReason;
      if(newStatus==='Quotation Sent' && lead.quotationStatus==='Not Sent'){ lead.quotationStatus='Sent'; lead.quotationAmount = lead.estimatedValue; lead.quotationRef = `Q-${lead.id}.pdf`; }
      if(newStatus==='Demo Sent' && !lead.demoLink){ lead.demoLink = `https://demo.bizwebkh.com/${slug(lead.businessName)}`; }
      DB.upsert('leads', lead);
      logActivity({
        userName: CURRENT_USER.name, refType:'lead', refId: lead.id, refLabel:`${lead.clientName} — ${lead.businessName}`,
        type: newStatus==='Lost' ? 'Lead Lost' : 'Status Changed',
        description:`${CURRENT_USER.name} changed status: ${prevStatus} → ${newStatus}`,
        fromValue: prevStatus, toValue: newStatus, remark
      });
      toast(`Status changed to "${newStatus}".`, 'success');
      if(currentRoute()==='leads') renderLeadsTable();
      if(currentRoute()==='pipeline') renderPipelinePage();
      if(currentRoute()==='dashboard') router();
      if(document.getElementById('activeModalOverlay')===null){} // no-op, modal already closed
      // if a lead-detail modal happens to still be relevant elsewhere, caller re-renders it
    }
  });
}

/* ---------------------------------------------------------------------- */
/* Archive / Restore — the preferred way to retire an old/unwanted lead.  */
/* Archiving never deletes anything: the record, its Activity Log and any */
/* linked Project all stay exactly as they are — it just stops showing up */
/* in Lead Records (default view), Pipeline and Follow-ups (spec §15).    */
/* ---------------------------------------------------------------------- */

function openArchiveLeadModal(lead, onDone){
  const html = `
    <div class="modal-head"><h3>Archive Lead</h3><button class="modal-close" id="arClose">&times;</button></div>
    <div class="modal-body">
      <p style="margin-top:0">Archive <b>${escapeHtml(lead.clientName)} — ${escapeHtml(lead.businessName)}</b>?</p>
      <p class="text-muted" style="font-size:12.5px">It will no longer appear in Lead Records (default view) or Pipeline — including its follow-up workflow. Nothing is deleted — its Activity Log and any linked Project stay intact, and it can be restored at any time.</p>
      <div class="form-field"><label>Reason (optional)</label><textarea id="ar_reason" placeholder="e.g. Inactive for 6+ months, no response."></textarea></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="arCancel">Cancel</button>
      <button class="btn btn-primary" id="arConfirm">Archive Lead</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#arClose').onclick = closeModal;
    overlay.querySelector('#arCancel').onclick = closeModal;
    overlay.querySelector('#arConfirm').onclick = ()=>{
      const reason = overlay.querySelector('#ar_reason').value.trim();
      closeModal();
      lead.archived = true;
      lead.archivedAt = new Date().toISOString();
      lead.archivedBy = CURRENT_USER.name;
      lead.archiveReason = reason || null;
      lead.updatedAt = lead.archivedAt;
      DB.upsert('leads', lead);
      logActivity({ userName: CURRENT_USER.name, refType:'lead', refId: lead.id, refLabel:`${lead.clientName} — ${lead.businessName}`,
        type:'Lead Archived', description:`${CURRENT_USER.name} archived lead ${lead.id}.${reason ? ' Reason: '+reason+'.' : ''}`, remark: reason||null });
      toast('Lead archived.', 'success');
      if(currentRoute()==='leads') renderLeadsTable();
      if(currentRoute()==='pipeline') renderPipelinePage();
      if(onDone) onDone();
    };
  }});
}

function restoreLead(lead, onDone){
  lead.archived = false;
  lead.archivedAt = null;
  lead.archivedBy = null;
  lead.archiveReason = null;
  lead.updatedAt = new Date().toISOString();
  DB.upsert('leads', lead);
  logActivity({ userName: CURRENT_USER.name, refType:'lead', refId: lead.id, refLabel:`${lead.clientName} — ${lead.businessName}`,
    type:'Lead Restored', description:`${CURRENT_USER.name} restored lead ${lead.id} from archive.` });
  toast('Lead restored.', 'success');
  if(currentRoute()==='leads') renderLeadsTable();
  if(currentRoute()==='pipeline') renderPipelinePage();
  if(onDone) onDone();
}

/* ---------------------------------------------------------------------- */
/* Delete Lead — permanent, and only ever offered for a lead with no      */
/* linked project. A confirmed lead with a Project is never eligible for  */
/* normal deletion (spec §14) — Archive is offered instead. Permission is */
/* gated by canDeleteLeads() (auth.js), structured for a future real       */
/* permissions table.                                                     */
/* ---------------------------------------------------------------------- */

function openDeleteLeadModal(lead){
  if(!canDeleteLeads(CURRENT_USER.role)){
    toast(`Your role (${ROLE_LABELS[CURRENT_USER.role] || CURRENT_USER.role}) cannot permanently delete leads. Use Archive instead, or ask a Founder/Admin.`, 'error');
    return;
  }
  if(lead.projectCode){
    const html = `
      <div class="modal-head"><h3>Cannot Delete Lead</h3><button class="modal-close" id="blClose">&times;</button></div>
      <div class="modal-body">
        <p style="margin-top:0">This lead is linked to Project <b>${escapeHtml(lead.projectCode)}</b> and cannot be deleted.</p>
        <p class="text-muted" style="font-size:12.5px">Deleting it would break CRM history and project linkage. Archive the lead instead, or manage the linked project.</p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-secondary" id="blCancel">Cancel</button>
        <button class="btn btn-outline" id="blOpenProject">Open Project ${escapeHtml(lead.projectCode)}</button>
        <button class="btn btn-primary" id="blArchive">Archive Instead</button>
      </div>
    `;
    openModal(html, { onMount:(overlay)=>{
      overlay.querySelector('#blClose').onclick = closeModal;
      overlay.querySelector('#blCancel').onclick = closeModal;
      overlay.querySelector('#blOpenProject').onclick = ()=>{ closeModal(); openProjectDetailModal(lead.projectCode); };
      overlay.querySelector('#blArchive').onclick = ()=>{ closeModal(); openArchiveLeadModal(lead, ()=> renderLeadDetail(lead.id)); };
    }});
    return;
  }

  const html = `
    <div class="modal-head"><h3>Delete this lead?</h3><button class="modal-close" id="dlClose">&times;</button></div>
    <div class="modal-body">
      <p style="margin-top:0">This will remove the lead from Lead Records, Pipeline and scheduled follow-ups. This action cannot be undone.</p>
      <div class="panel" style="padding:12px 14px;background:var(--red-soft);border:1px solid var(--line)">
        <div class="cell-strong" style="font-size:14px">${escapeHtml(lead.clientName)} — ${escapeHtml(lead.businessName)}</div>
        <div class="text-muted" style="font-size:12px;margin-top:2px">${lead.id} · ${escapeHtml(lead.status)}</div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="dlCancel">Cancel</button>
      <button class="btn btn-danger" id="dlConfirm">Delete Lead</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#dlClose').onclick = closeModal;
    overlay.querySelector('#dlCancel').onclick = closeModal;
    overlay.querySelector('#dlConfirm').onclick = ()=>{
      closeModal();
      const label = `${lead.clientName} — ${lead.businessName}`;
      const leadId = lead.id;
      // The lead's persistent follow-up history (lead_activities) is cleaned
      // up automatically server-side via its `lead_id` ON DELETE CASCADE FK
      // — no separate client-side cleanup step needed.
      logActivity({ userName: CURRENT_USER.name, refType:'lead', refId: leadId, refLabel: label,
        type:'Lead Deleted', description:`${CURRENT_USER.name} permanently deleted lead ${leadId} (${label}).` });
      DB.remove('leads', leadId);
      toast('Lead deleted.', 'success');
      if(currentRoute()==='leads') renderLeadsTable();
      if(currentRoute()==='pipeline') renderPipelinePage();
      if(currentRoute()==='dashboard') router();
    };
  }});
}
