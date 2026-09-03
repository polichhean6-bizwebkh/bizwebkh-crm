/* ==========================================================================
   BizWeb KH CRM — quotations.js
   Quotations list, Create Quotation flow (Lead / Project / New Client),
   Service Price List–driven pricing with Sales-authority + Founder-review
   rules, branded preview + PDF (browser print), and the Sent → Accepted →
   Project-creation workflow.
   ========================================================================== */

function isFounder(){ return /Founder/i.test(CURRENT_USER.role); }
function discountLimitPct(){ const db = DB.read(); return (db && db.settings && db.settings.discountLimitPct) || 10; }
// A service's own Maximum Sales Discount (set on the Service Price List)
// overrides the global default when present.
function effectiveDiscountLimit(svc){ return (svc && svc.maxDiscountPct!=null) ? svc.maxDiscountPct : discountLimitPct(); }

/* ---------------------------------------------------------------------- */
/* List page                                                              */
/* ---------------------------------------------------------------------- */

let QUOT_FILTER = { search:'', status:'', approval:'' };

// ---------------------------------------------------------------------- //
// Session 5: the Quotations module is temporarily disabled ("Coming
// Soon") — BizWeb KH wants to deploy the CRM sooner and the quotation
// generator is not finished yet. Nothing below this flag is deleted: the
// full list/create/edit/accept workflow (renderQuotationsPageFull, etc.)
// still exists intact, it's just not the page that's shown right now.
// Flip QUOTATIONS_MODULE_ENABLED back to true once the module is ready.
// ---------------------------------------------------------------------- //
const QUOTATIONS_MODULE_ENABLED = false;

function renderQuotationsPage(){
  if(!QUOTATIONS_MODULE_ENABLED){
    renderQuotationsComingSoon();
    return;
  }
  renderQuotationsPageFull();
}

function renderQuotationsComingSoon(){
  const el = document.getElementById('pageContent');
  el.innerHTML = `
    <div class="panel" style="min-height:60vh;display:flex;align-items:center;justify-content:center">
      <div style="text-align:center;max-width:440px;padding:40px 20px">
        <div class="coming-soon-icon" style="width:56px;height:56px;border-radius:16px;display:flex;align-items:center;justify-content:center;margin:0 auto 18px">${icon('list')}</div>
        <h2 style="margin:0 0 8px;font-size:20px;color:var(--text)">Quotation Management</h2>
        <div class="coming-soon-badge" style="display:inline-block;margin-bottom:14px;padding:3px 10px;border-radius:999px;font-size:11.5px;font-weight:700;letter-spacing:.3px;text-transform:uppercase">Coming Soon</div>
        <p style="color:var(--muted);font-size:13.5px;line-height:1.6;margin:0">
          The quotation module is currently being prepared. For now, quotations continue to be created using the existing BizWeb KH quotation process.
        </p>
      </div>
    </div>
  `;
}

function renderQuotationsPageFull(){
  const el = document.getElementById('pageContent');
  el.innerHTML = `
    <div class="filters-bar">
      <div class="search-box">
        ${icon('search')}
        <input type="text" id="qSearch" placeholder="Search quote no., client, or business…" value="${escapeHtml(QUOT_FILTER.search)}">
      </div>
      <select id="qFltStatus" class="sel"><option value="">All Statuses</option>${QUOTATION_STATUSES.map(s=>`<option ${QUOT_FILTER.status===s?'selected':''}>${s}</option>`).join('')}</select>
      <select id="qFltApproval" class="sel"><option value="">All Approval</option>${APPROVAL_STATUSES.map(s=>`<option ${QUOT_FILTER.approval===s?'selected':''}>${s}</option>`).join('')}</select>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="createQuoteBtn">${icon('grid')} + Create Quotation</button>
    </div>
    <div id="quotTableWrap"></div>
  `;
  document.getElementById('qSearch').oninput = e=>{ QUOT_FILTER.search=e.target.value; renderQuotTable(); };
  document.getElementById('qFltStatus').onchange = e=>{ QUOT_FILTER.status=e.target.value; renderQuotTable(); };
  document.getElementById('qFltApproval').onchange = e=>{ QUOT_FILTER.approval=e.target.value; renderQuotTable(); };
  document.getElementById('createQuoteBtn').onclick = ()=> openCreateQuotationModal();
  renderQuotTable();
}

function filteredQuotations(){
  const f = QUOT_FILTER;
  return DB.all('quotations').filter(q=>{
    if(f.search){
      const s = f.search.toLowerCase();
      if(!(q.quoteNumber.toLowerCase().includes(s) || q.clientName.toLowerCase().includes(s) || q.businessName.toLowerCase().includes(s))) return false;
    }
    if(f.status && q.quotationStatus!==f.status) return false;
    if(f.approval && q.approvalStatus!==f.approval) return false;
    return true;
  }).sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
}

function renderQuotTable(){
  const wrap = document.getElementById('quotTableWrap');
  const rows = filteredQuotations();
  wrap.innerHTML = `
    <div class="table-wrap scroll-x">
      <table class="data-table">
        <thead><tr>
          <th>Quote No.</th><th>Client</th><th>Business</th><th>Project / Package</th><th>Value</th>
          <th>Sales</th><th>Status</th><th>Created</th><th>Valid Until</th><th>Approval</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${rows.length ? rows.map(q=>`
            <tr>
              <td class="cell-link" data-open="${q.id}">${q.quoteNumber}</td>
              <td class="cell-strong">${escapeHtml(q.clientName)}</td>
              <td>${escapeHtml(q.businessName)}</td>
              <td>${escapeHtml(q.projectType)}</td>
              <td class="cell-strong">${q.priceIsTBC?'TBC':money(q.finalPrice)}</td>
              <td><div class="flex-row"><div class="avatar-sm" style="background:${userColor(q.assignedSales)}">${userInitials(q.assignedSales)}</div>${escapeHtml(q.assignedSales)}</div></td>
              <td>${statusBadge(q.quotationStatus)}</td>
              <td>${fmtDate(q.createdAt)}</td>
              <td>${fmtDate(q.validUntil)}</td>
              <td>${statusBadge(q.approvalStatus)}</td>
              <td>
                <div class="flex-row" style="gap:6px;flex-wrap:wrap">
                  <button class="btn btn-secondary btn-sm" data-open="${q.id}">View</button>
                  <button class="btn btn-ghost btn-sm" data-preview="${q.id}">Preview</button>
                </div>
              </td>
            </tr>`).join('') : `<tr><td colspan="11"><div class="empty-row">No quotations yet. Use "+ Create Quotation" to start one.</div></td></tr>`}
        </tbody>
      </table>
    </div>
    <p class="text-muted" style="margin-top:10px;font-size:12px">Showing ${rows.length} of ${DB.all('quotations').length} quotations</p>
  `;
  wrap.querySelectorAll('[data-open]').forEach(x=> x.onclick = ()=> openQuotationDetailModal(x.dataset.open));
  wrap.querySelectorAll('[data-preview]').forEach(x=> x.onclick = ()=> openQuotationPreview(x.dataset.preview));
}

/* ---------------------------------------------------------------------- */
/* Create Quotation                                                       */
/* ---------------------------------------------------------------------- */

// draftItems holds the live-editable line items while the create modal is open
let QC_STATE = null;

function openCreateQuotationModal(prefill={}){
  QC_STATE = {
    sourceType: prefill.sourceType || 'lead', // lead | project | new
    leadId: prefill.leadId || null,
    projectId: prefill.projectId || null,
    clientName:'', businessName:'', phone:'', telegram:'', email:'', industry:'', assignedSales: CURRENT_USER.name,
    projectType:'', discountPct:0, adjustment:0, adjustmentReason:'',
    items: [], editingId: prefill.editingId || null,
  };
  if(QC_STATE.leadId) applyLeadToQC(QC_STATE.leadId);
  if(QC_STATE.projectId) applyProjectToQC(QC_STATE.projectId);
  renderCreateQuotationModal();
}

function applyLeadToQC(leadId){
  const lead = DB.find('leads', leadId);
  if(!lead) return;
  Object.assign(QC_STATE, {
    leadId: lead.id, projectId: null,
    clientName: lead.clientName, businessName: lead.businessName, phone: lead.phone,
    telegram: lead.telegram||'', email:'', industry: lead.industry, assignedSales: lead.assignedSales,
    projectType: lead.interestedService || QC_STATE.projectType,
  });
  loadPackageFunctions(QC_STATE.projectType);
}
function applyProjectToQC(projectId){
  const proj = DB.find('projects', projectId);
  if(!proj) return;
  Object.assign(QC_STATE, {
    projectId: proj.id, leadId: proj.leadId||null,
    clientName: proj.clientName, businessName: proj.businessName, phone: proj.phone||'',
    telegram:'', email:'', industry: proj.industry, assignedSales: proj.assignedSales,
    projectType: proj.projectType || QC_STATE.projectType,
  });
  loadPackageFunctions(QC_STATE.projectType);
}
function loadPackageFunctions(projectType){
  const svc = serviceByProjectType(projectType);
  if(!svc){ QC_STATE.items = []; return; }
  // Base package price is its own priced line item; included functions are
  // bundled into that price (shown at $0 — informational scope, not
  // separately charged) unless the Service Price List gives one its own
  // defaultPrice (used for founder-review "no fixed price" functions, where
  // defaultPrice is null / TBC).
  const baseItem = { id: fnId(), module: svc.category, name: `${svc.name} (Base Package${svc.priceIsStartingFrom?' — starting from':''})`,
    price: svc.basePrice, founderReviewRequired: svc.founderReviewRequired, included: true };
  const fnItems = svc.functions.map(f=>({ id:fnId(), module: svc.category, name:f.name,
    price: f.defaultPrice===null ? null : 0, founderReviewRequired: f.founderReviewRequired, included: f.included }));
  QC_STATE.items = [baseItem, ...fnItems];
}

function renderCreateQuotationModal(){
  const s = QC_STATE;
  const leads = DB.all('leads');
  const projects = DB.all('projects');
  const svc = serviceByProjectType(s.projectType);
  const evalRes = evaluateQuotation({
    items: s.items.filter(i=>i.included!==false).map(i=>({name:i.name, price:i.price, founderReviewRequired:i.founderReviewRequired})),
    basePackage: svc, discountPct: Number(s.discountPct)||0,
    manualAdjustment: s.adjustment ? { amount:Number(s.adjustment), reason:s.adjustmentReason } : null,
    discountLimitPct: effectiveDiscountLimit(svc),
  });

  const html = `
    <div class="modal-head"><h3>${s.editingId?'Edit Quotation':'Create Quotation'}</h3><button class="modal-close" id="cqClose">&times;</button></div>
    <div class="modal-body">
      <div class="form-field" style="margin-bottom:12px">
        <label>Source</label>
        <div class="flex-row" style="gap:8px;flex-wrap:wrap">
          <button class="btn btn-sm ${s.sourceType==='lead'?'btn-primary':'btn-outline'}" data-src="lead">A. Existing Lead</button>
          <button class="btn btn-sm ${s.sourceType==='project'?'btn-primary':'btn-outline'}" data-src="project">B. Existing Project</button>
          <button class="btn btn-sm ${s.sourceType==='new'?'btn-primary':'btn-outline'}" data-src="new">C. New / Direct Client</button>
        </div>
      </div>

      ${s.sourceType==='lead' ? `
        <div class="form-field" style="margin-bottom:12px">
          <label>Link to Lead</label>
          <select id="cq_leadPick" class="sel" style="width:100%">
            <option value="">Select a lead…</option>
            ${leads.map(l=>`<option value="${l.id}" ${s.leadId===l.id?'selected':''}>${l.id} — ${escapeHtml(l.clientName)} — ${escapeHtml(l.businessName)}</option>`).join('')}
          </select>
        </div>` : ''}
      ${s.sourceType==='project' ? `
        <div class="form-field" style="margin-bottom:12px">
          <label>Link to Project</label>
          <select id="cq_projPick" class="sel" style="width:100%">
            <option value="">Select a project…</option>
            ${projects.map(p=>`<option value="${p.id}" ${s.projectId===p.id?'selected':''}>${p.id} — ${escapeHtml(p.clientName)} — ${escapeHtml(p.businessName)}</option>`).join('')}
          </select>
        </div>` : ''}

      <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">Client Information</div>
      <div class="form-grid">
        <div class="form-field"><label class="required">Client Name</label><input id="cq_clientName" value="${escapeHtml(s.clientName)}" ${s.sourceType!=='new'?'disabled':''}></div>
        <div class="form-field"><label class="required">Business Name</label><input id="cq_businessName" value="${escapeHtml(s.businessName)}" ${s.sourceType!=='new'?'disabled':''}></div>
        <div class="form-field"><label>Phone</label><input id="cq_phone" value="${escapeHtml(s.phone)}" ${s.sourceType!=='new'?'disabled':''}></div>
        <div class="form-field"><label>Telegram</label><input id="cq_telegram" value="${escapeHtml(s.telegram)}"></div>
        <div class="form-field"><label>Email</label><input id="cq_email" value="${escapeHtml(s.email)}"></div>
        <div class="form-field"><label class="required">Industry</label>
          <select id="cq_industry" class="sel" ${s.sourceType!=='new'?'disabled':''}>${INDUSTRIES.map(i=>`<option ${s.industry===i?'selected':''}>${i}</option>`).join('')}</select>
        </div>
        <div class="form-field"><label class="required">Assigned Sales</label>
          <select id="cq_sales" class="sel">${salesOwnersList().map(n=>`<option ${s.assignedSales===n?'selected':''}>${n}</option>`).join('')}</select>
        </div>
      </div>

      <div class="divider"></div>
      <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">Project / Service</div>
      <div class="form-field" style="margin-bottom:12px">
        <label class="required">Package (from Service Price List)</label>
        <select id="cq_package" class="sel" style="width:100%">
          <option value="">Select a package…</option>
          ${SERVICE_PRICE_LIST.map(p=>`<option value="${p.projectType}" ${s.projectType===p.projectType?'selected':''}>${p.name} — ${p.priceIsStartingFrom?'from ':''}$${p.basePrice}</option>`).join('')}
        </select>
      </div>

      <div id="cq_itemsWrap">${quotationItemsEditorHtml(s.items)}</div>
      <button class="btn btn-outline btn-sm" id="cq_addFn" style="margin:8px 0 16px">+ Add Function</button>

      <div class="divider"></div>
      <div class="form-grid">
        <div class="form-field"><label>Discount %</label><input type="number" id="cq_discount" value="${s.discountPct}" min="0" max="100"></div>
        <div class="form-field"><label>Manual Price Adjustment ($)</label><input type="number" id="cq_adjust" value="${s.adjustment}"></div>
        <div class="form-field full"><label>Reason for Price Adjustment ${s.adjustment?'<span class="required"></span>':'(required if adjusting)'}</label><input id="cq_adjustReason" value="${escapeHtml(s.adjustmentReason)}" placeholder='e.g. "Client already has hosting."'></div>
      </div>

      <div id="cq_authorityBanner">${authorityBannerHtml(evalRes)}</div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="cqCancel">Cancel</button>
      <button class="btn btn-primary" id="cqSave">${s.editingId?'Save Changes':'Save as Draft'}</button>
    </div>
  `;

  openModal(html, { large:true, onMount:(overlay)=>{
    overlay.querySelector('#cqClose').onclick = closeModal;
    overlay.querySelector('#cqCancel').onclick = closeModal;

    overlay.querySelectorAll('[data-src]').forEach(b=> b.onclick = ()=>{
      s.sourceType = b.dataset.src;
      if(s.sourceType==='new'){ s.leadId=null; s.projectId=null; }
      renderCreateQuotationModal();
    });

    const leadPick = overlay.querySelector('#cq_leadPick');
    if(leadPick) leadPick.onchange = ()=>{ if(leadPick.value){ applyLeadToQC(leadPick.value); renderCreateQuotationModal(); } };
    const projPick = overlay.querySelector('#cq_projPick');
    if(projPick) projPick.onchange = ()=>{ if(projPick.value){ applyProjectToQC(projPick.value); renderCreateQuotationModal(); } };

    overlay.querySelector('#cq_clientName').oninput = e=> s.clientName = e.target.value;
    overlay.querySelector('#cq_businessName').oninput = e=> s.businessName = e.target.value;
    overlay.querySelector('#cq_phone').oninput = e=> s.phone = e.target.value;
    overlay.querySelector('#cq_telegram').oninput = e=> s.telegram = e.target.value;
    overlay.querySelector('#cq_email').oninput = e=> s.email = e.target.value;
    const industrySel = overlay.querySelector('#cq_industry');
    if(industrySel) industrySel.onchange = e=> s.industry = e.target.value;
    overlay.querySelector('#cq_sales').onchange = e=> s.assignedSales = e.target.value;

    overlay.querySelector('#cq_package').onchange = e=>{
      s.projectType = e.target.value;
      loadPackageFunctions(s.projectType);
      renderCreateQuotationModal();
    };

    overlay.querySelector('#cq_addFn').onclick = ()=> openAddQuotationFunctionModal((fnDef)=>{
      s.items.push({ id: fnId(), module:'Add-on', name: fnDef.name, price: fnDef.defaultPrice, founderReviewRequired: fnDef.founderReviewRequired, included:true });
      renderCreateQuotationModal();
    });

    wireQuotationItemsEditor(overlay, s);

    overlay.querySelector('#cq_discount').oninput = e=>{ s.discountPct = e.target.value; refreshAuthorityBanner(overlay, s); };
    overlay.querySelector('#cq_adjust').oninput = e=>{ s.adjustment = e.target.value; refreshAuthorityBanner(overlay, s); };
    overlay.querySelector('#cq_adjustReason').oninput = e=>{ s.adjustmentReason = e.target.value; };

    overlay.querySelector('#cqSave').onclick = ()=> saveQuotationFromState(s);
  }});
}

function quotationItemsEditorHtml(items){
  if(!items.length) return `<div class="empty-row">Select a package to load its included functions.</div>`;
  return `
    <div class="table-wrap scroll-x">
      <table class="data-table">
        <thead><tr><th>Include</th><th>Module</th><th>Function</th><th>Price</th><th></th></tr></thead>
        <tbody>
          ${items.map(it=>`
            <tr data-item="${it.id}">
              <td><input type="checkbox" data-inc="${it.id}" ${it.included!==false?'checked':''}></td>
              <td>${escapeHtml(it.module)}</td>
              <td>${escapeHtml(it.name)}${it.founderReviewRequired?' <span class="badge chip-overdue" style="margin-left:4px">Founder Review</span>':''}</td>
              <td>${it.price===null||it.price===undefined?'TBC':money(it.price)}</td>
              <td><span class="icon-btn" data-remove-item="${it.id}" title="Remove" style="font-size:15px;cursor:pointer">&times;</span></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}
function wireQuotationItemsEditor(overlay, s){
  overlay.querySelectorAll('[data-inc]').forEach(cb=> cb.onchange = ()=>{
    const it = s.items.find(x=>x.id===cb.dataset.inc);
    it.included = cb.checked;
    refreshAuthorityBanner(overlay, s);
  });
  overlay.querySelectorAll('[data-remove-item]').forEach(x=> x.onclick = ()=>{
    s.items = s.items.filter(i=>i.id!==x.dataset.removeItem);
    renderCreateQuotationModal();
  });
}
function refreshAuthorityBanner(overlay, s){
  const svc = serviceByProjectType(s.projectType);
  const evalRes = evaluateQuotation({
    items: s.items.filter(i=>i.included!==false).map(i=>({name:i.name, price:i.price, founderReviewRequired:i.founderReviewRequired})),
    basePackage: svc, discountPct: Number(s.discountPct)||0,
    manualAdjustment: s.adjustment ? { amount:Number(s.adjustment), reason:s.adjustmentReason } : null,
    discountLimitPct: effectiveDiscountLimit(svc),
  });
  overlay.querySelector('#cq_authorityBanner').innerHTML = authorityBannerHtml(evalRes);
}
function authorityBannerHtml(evalRes){
  if(evalRes.requiresFounderReview){
    return `<div class="panel" style="border-color:var(--orange,#d98a12);background:#fff8ec;padding:12px 14px;margin-top:12px">
      <strong style="color:#a56206">⚠ Founder Review Required</strong>
      <ul style="margin:6px 0 0;padding-left:18px;font-size:12.5px;color:var(--navy)">${evalRes.reasons.map(r=>`<li>${escapeHtml(r)}</li>`).join('')}</ul>
      <div style="margin-top:8px;font-size:13px">Estimated Price: <b>${evalRes.priceIsTBC?'TBC':money(evalRes.finalPrice)}</b></div>
    </div>`;
  }
  return `<div class="panel" style="border-color:var(--green,#12a775);background:#eefaf4;padding:12px 14px;margin-top:12px">
    <strong style="color:#0d8a5f">✓ Within Sales Quoting Authority</strong>
    <div style="margin-top:8px;font-size:13px">Final Price: <b>${money(evalRes.finalPrice)}</b> ${evalRes.discountAmt?`(after ${money(evalRes.discountAmt)} discount)`:''}</div>
  </div>`;
}

function openAddQuotationFunctionModal(onPick){
  const html = `
    <div class="modal-head"><h3>Add Function</h3><button class="modal-close" id="afqClose">&times;</button></div>
    <div class="modal-body">
      <div class="form-field" style="margin-bottom:12px">
        <label>Choose from catalog</label>
        <select id="afq_pick" class="sel" style="width:100%">
          <option value="">Select a function…</option>
          ${ADDITIONAL_FUNCTIONS_CATALOG.map(a=>`<option value="${a.id}">${escapeHtml(a.name)} — ${a.defaultPrice===null?'TBC (Founder review)':'$'+a.defaultPrice}</option>`).join('')}
        </select>
      </div>
      <div class="divider"></div>
      <p class="text-muted" style="font-size:12px;margin:0 0 8px">Or add a custom function not in the catalog — this always requires Founder review (price shows as TBC).</p>
      <div class="form-field"><label>Custom Function Name</label><input id="afq_custom" placeholder="e.g. Loyalty points system"></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="afqCancel">Cancel</button>
      <button class="btn btn-primary" id="afqAdd">Add Function</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#afqClose').onclick = closeModal;
    overlay.querySelector('#afqCancel').onclick = closeModal;
    overlay.querySelector('#afqAdd').onclick = ()=>{
      const pickId = overlay.querySelector('#afq_pick').value;
      const custom = overlay.querySelector('#afq_custom').value.trim();
      if(pickId){
        const def = ADDITIONAL_FUNCTIONS_CATALOG.find(a=>a.id===pickId);
        closeModal(); onPick(def); return;
      }
      if(custom){
        closeModal(); onPick({ name: custom, defaultPrice: null, founderReviewRequired: true }); return;
      }
      toast('Pick a function from the catalog, or type a custom one.', 'error');
    };
  }});
}

function saveQuotationFromState(s){
  if(!s.clientName || !s.businessName){ toast('Client Name and Business Name are required.', 'error'); return; }
  if(!s.projectType){ toast('Please select a package.', 'error'); return; }
  if(s.adjustment && !s.adjustmentReason.trim()){ toast('A Reason for Price Adjustment is required.', 'error'); return; }

  const svc = serviceByProjectType(s.projectType);
  const activeItems = s.items.filter(i=>i.included!==false);
  const evalRes = evaluateQuotation({
    items: activeItems.map(i=>({name:i.name, price:i.price, founderReviewRequired:i.founderReviewRequired})),
    basePackage: svc, discountPct: Number(s.discountPct)||0,
    manualAdjustment: s.adjustment ? { amount:Number(s.adjustment), reason:s.adjustmentReason } : null,
    discountLimitPct: effectiveDiscountLimit(svc),
  });

  const refCode = s.projectId || s.leadId || 'DIRECT' + Date.now().toString().slice(-4);

  let quotation, isNewVersion = false, version = 1;
  if(s.editingId){
    const existing = DB.find('quotations', s.editingId);
    if(existing && existing.quotationStatus==='Draft'){
      quotation = existing; // edit in place
    } else if(existing){
      isNewVersion = true; version = (existing.version||1) + 1;
    }
  }
  if(!quotation){
    quotation = {
      id: 'QT' + Math.random().toString(36).slice(2,9).toUpperCase(),
      createdAt: new Date().toISOString(),
      createdBy: CURRENT_USER.name,
      version,
      previousVersionId: isNewVersion ? s.editingId : null,
    };
    quotation.quoteNumber = generateQuoteNumber(refCode, version);
  }

  Object.assign(quotation, {
    leadId: s.leadId, projectId: s.projectId,
    clientName: s.clientName, businessName: s.businessName, phone: s.phone, telegram: s.telegram, email: s.email,
    industry: s.industry, projectType: s.projectType, assignedSales: s.assignedSales,
    items: activeItems.map(i=>({ id:i.id, module:i.module, name:i.name, price:i.price, founderReviewRequired:i.founderReviewRequired, scopeStatus:'Confirmed' })),
    discountPct: Number(s.discountPct)||0,
    manualAdjustment: s.adjustment ? { amount:Number(s.adjustment), reason:s.adjustmentReason } : null,
    basePrice: evalRes.subtotal, finalPrice: evalRes.finalPrice, priceIsTBC: evalRes.priceIsTBC,
    approvalStatus: evalRes.approvalStatus, reasons: evalRes.reasons,
    quotationStatus: quotation.quotationStatus && quotation.quotationStatus!=='Draft' ? quotation.quotationStatus : 'Draft',
    validUntil: quotation.validUntil || daysFromNow(14),
  });

  DB.upsert('quotations', quotation);

  logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId: quotation.id, refLabel:`${quotation.quoteNumber} — ${quotation.businessName}`,
    type: (s.editingId && !isNewVersion) ? 'Quotation Edited' : 'Quotation Created',
    description: `${CURRENT_USER.name} ${(s.editingId && !isNewVersion)?'edited':(isNewVersion?'created version '+version+' of':'created')} quotation ${quotation.quoteNumber}. Value: ${evalRes.priceIsTBC?'TBC':money(evalRes.finalPrice)}.`,
    remark: evalRes.requiresFounderReview ? 'Founder review required.' : null
  });

  toast(`Quotation ${quotation.quoteNumber} saved as Draft.`, 'success');
  closeModal();
  if(currentRoute()==='quotations') renderQuotTable();
  openQuotationDetailModal(quotation.id);
}

/* ---------------------------------------------------------------------- */
/* Quotation detail / actions                                             */
/* ---------------------------------------------------------------------- */

function openQuotationDetailModal(id){
  const q = DB.find('quotations', id);
  if(!q){ toast('Quotation not found.', 'error'); return; }
  const reviews = DB.all('quotationReviews').filter(r=>r.quotationId===id);
  const acts = activitiesFor(id);
  const withinAuthority = q.approvalStatus==='Sales Approved' || q.approvalStatus==='Founder Approved';

  const html = `
    <div class="modal-head">
      <div><h3>${q.quoteNumber}</h3><div class="text-muted" style="font-size:12px;margin-top:2px">${escapeHtml(q.clientName)} — ${escapeHtml(q.businessName)} · v${q.version||1}</div></div>
      <button class="modal-close" id="qdClose">&times;</button>
    </div>
    <div class="modal-body">
      <div class="flex-row" style="justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:10px">
        <div class="flex-row" style="gap:8px;flex-wrap:wrap">${statusBadge(q.quotationStatus)}${statusBadge(q.approvalStatus)}</div>
        <div class="flex-row" style="flex-wrap:wrap;gap:8px" id="qdActions"></div>
      </div>
      <div id="qdAuthority">${authorityBannerHtml({ requiresFounderReview: q.approvalStatus==='Founder Review Required', reasons: q.reasons||[], priceIsTBC:q.priceIsTBC, finalPrice:q.finalPrice, discountAmt:0 })}</div>

      <div class="two-col" style="margin-top:14px">
        <div>
          ${infoRow('Client', q.clientName)}
          ${infoRow('Business', q.businessName)}
          ${infoRow('Industry', q.industry)}
          ${infoRow('Package', q.projectType)}
        </div>
        <div>
          ${infoRow('Assigned Sales', q.assignedSales)}
          ${infoRow('Created', fmtDate(q.createdAt))}
          ${infoRow('Valid Until', fmtDate(q.validUntil))}
          ${infoRow('Linked', q.projectId ? 'Project '+q.projectId : (q.leadId ? 'Lead '+q.leadId : 'Direct client (no lead)'))}
        </div>
      </div>

      <div class="divider"></div>
      <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">Scope of Work</div>
      <div class="table-wrap scroll-x">
        <table class="data-table">
          <thead><tr><th>Module</th><th>Function</th><th>Price</th></tr></thead>
          <tbody>${q.items.map(it=>`<tr><td>${escapeHtml(it.module)}</td><td>${escapeHtml(it.name)}</td><td>${it.price===null||it.price===undefined?'TBC':money(it.price)}</td></tr>`).join('')}</tbody>
        </table>
      </div>

      <div class="divider"></div>
      <div class="two-col">
        <div>
          ${infoRow('Subtotal', money(q.basePrice))}
          ${infoRow('Discount', q.discountPct+'%')}
        </div>
        <div>
          ${q.manualAdjustment ? infoRow('Price Adjustment', money(q.manualAdjustment.amount)+' — '+escapeHtml(q.manualAdjustment.reason)) : ''}
          ${infoRow('Final Price', q.priceIsTBC?'TBC':money(q.finalPrice))}
        </div>
      </div>

      ${reviews.length ? `
      <div class="divider"></div>
      <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">Founder Review</div>
      ${reviews.map(r=>`<div class="mini-row"><div class="mini-main"><div class="mini-title">${escapeHtml(r.reviewer)} — ${escapeHtml(r.decision)}</div><div class="mini-sub">${escapeHtml(r.comment||'')}</div></div><div class="mini-right">${fmtDateTime(r.timestamp)}</div></div>`).join('')}
      ` : ''}

      <div class="divider"></div>
      <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">Activity History (${acts.length})</div>
      ${acts.length ? acts.map(a=>`<div class="mini-row"><div class="mini-main"><div class="mini-title"><b>${escapeHtml(a.userName)}</b> — ${escapeHtml(a.type)}</div><div class="mini-sub">${escapeHtml(a.description)}</div></div><div class="mini-right">${fmtDateTime(a.at)}</div></div>`).join('') : `<div class="empty-row">No activity yet.</div>`}
    </div>
    <div class="modal-foot"><button class="btn btn-secondary" id="qdClose2">Close</button></div>
  `;

  openModal(html, { large:true, onMount:(overlay)=>{
    overlay.querySelector('#qdClose').onclick = closeModal;
    overlay.querySelector('#qdClose2').onclick = closeModal;

    const actionsEl = overlay.querySelector('#qdActions');
    const btns = [];
    btns.push(`<button class="btn btn-outline btn-sm" id="qaPreview">Preview</button>`);
    btns.push(`<button class="btn btn-outline btn-sm" id="qaPdf">Download PDF</button>`);

    if(q.quotationStatus==='Draft'){
      btns.push(`<button class="btn btn-ghost btn-sm" id="qaEdit">Edit</button>`);
      if(withinAuthority){
        btns.push(`<button class="btn btn-primary btn-sm" id="qaSend">Mark as Sent</button>`);
      } else {
        btns.push(`<button class="btn btn-primary btn-sm" id="qaSubmit">Submit for Review</button>`);
      }
    }
    if(q.quotationStatus==='Pending Founder Review' && isFounder()){
      btns.push(`<button class="btn btn-primary btn-sm" id="qaApprove">Approve</button>`);
      btns.push(`<button class="btn btn-danger btn-sm" id="qaReject">Reject</button>`);
      btns.push(`<button class="btn btn-ghost btn-sm" id="qaComment">Add Comment</button>`);
    }
    if(q.quotationStatus==='Approved'){
      btns.push(`<button class="btn btn-primary btn-sm" id="qaSend">Mark as Sent</button>`);
    }
    if(q.quotationStatus==='Sent to Client'){
      btns.push(`<button class="btn btn-primary btn-sm" id="qaAccept">Mark as Accepted</button>`);
      btns.push(`<button class="btn btn-ghost btn-sm" id="qaExpire">Mark as Expired</button>`);
    }
    actionsEl.innerHTML = btns.join('');

    overlay.querySelector('#qaPreview').onclick = ()=> openQuotationPreview(q.id);
    overlay.querySelector('#qaPdf').onclick = ()=> openQuotationPreview(q.id, true);
    const editBtn = overlay.querySelector('#qaEdit');
    if(editBtn) editBtn.onclick = ()=> openCreateQuotationModal({ editingId:q.id, sourceType: q.projectId?'project':(q.leadId?'lead':'new'), leadId:q.leadId, projectId:q.projectId, ...loadStateFromQuotation(q) });
    const submitBtn = overlay.querySelector('#qaSubmit');
    if(submitBtn) submitBtn.onclick = ()=> submitForReview(q.id);
    const sendBtn = overlay.querySelector('#qaSend');
    if(sendBtn) sendBtn.onclick = ()=> markAsSent(q.id);
    const approveBtn = overlay.querySelector('#qaApprove');
    if(approveBtn) approveBtn.onclick = ()=> openFounderReviewModal(q.id, 'approve');
    const rejectBtn = overlay.querySelector('#qaReject');
    if(rejectBtn) rejectBtn.onclick = ()=> openFounderReviewModal(q.id, 'reject');
    const commentBtn = overlay.querySelector('#qaComment');
    if(commentBtn) commentBtn.onclick = ()=> openFounderReviewModal(q.id, 'comment');
    const acceptBtn = overlay.querySelector('#qaAccept');
    if(acceptBtn) acceptBtn.onclick = ()=> markAsAccepted(q.id);
    const expireBtn = overlay.querySelector('#qaExpire');
    if(expireBtn) expireBtn.onclick = ()=> markAsExpired(q.id);
  }});
}

function loadStateFromQuotation(q){
  return {
    clientNamePrefill: q.clientName
  };
}

function submitForReview(id){
  const q = DB.find('quotations', id);
  q.quotationStatus = 'Pending Founder Review';
  DB.upsert('quotations', q);
  logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId:q.id, refLabel:`${q.quoteNumber} — ${q.businessName}`,
    type:'Submitted for Review', description:`${CURRENT_USER.name} submitted quotation ${q.quoteNumber} for Founder review.`,
    fromValue:'Draft', toValue:'Pending Founder Review' });
  DB.upsert('quotationReviews', { id:'QR'+q.id+Date.now(), quotationId:q.id, reviewer:'', decision:'Pending', comment:'', timestamp:new Date().toISOString() });
  toast('Submitted for Founder review.', 'success');
  openQuotationDetailModal(id);
  if(currentRoute()==='quotations') renderQuotTable();
}

function markAsSent(id){
  const q = DB.find('quotations', id);
  q.quotationStatus = 'Sent to Client';
  DB.upsert('quotations', q);
  logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId:q.id, refLabel:`${q.quoteNumber} — ${q.businessName}`,
    type:'Quotation Sent', description:`${CURRENT_USER.name} sent quotation ${q.quoteNumber} / Amount: ${q.priceIsTBC?'TBC':money(q.finalPrice)}`,
    toValue:'Sent to Client' });
  toast('Quotation marked as sent.', 'success');
  openQuotationDetailModal(id);
  if(currentRoute()==='quotations') renderQuotTable();
}

function markAsExpired(id){
  const q = DB.find('quotations', id);
  q.quotationStatus = 'Expired';
  DB.upsert('quotations', q);
  logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId:q.id, refLabel:`${q.quoteNumber} — ${q.businessName}`,
    type:'Quotation Expired', description:`${CURRENT_USER.name} marked quotation ${q.quoteNumber} as expired.`, toValue:'Expired' });
  toast('Quotation marked as expired.');
  openQuotationDetailModal(id);
  if(currentRoute()==='quotations') renderQuotTable();
}

function openFounderReviewModal(id, mode){
  const q = DB.find('quotations', id);
  const titles = { approve:'Approve Quotation', reject:'Reject Quotation', comment:'Add Review Comment' };
  const html = `
    <div class="modal-head"><h3>${titles[mode]}</h3><button class="modal-close" id="frClose">&times;</button></div>
    <div class="modal-body">
      <p class="text-muted" style="margin-top:0;font-size:13px">${q.quoteNumber} — ${escapeHtml(q.businessName)}</p>
      ${mode==='approve' ? `<div class="form-field" style="margin-bottom:12px"><label>Edit Price (optional)</label><input type="number" id="fr_price" value="${q.priceIsTBC?'':q.finalPrice}" placeholder="Leave blank to approve as quoted"></div>` : ''}
      <div class="form-field"><label ${mode!=='comment'?'class="required"':''}>Review Note</label><textarea id="fr_comment" placeholder='e.g. "Price approved at $899." or "Increase to $1,199 because customer login + loyalty included."'></textarea></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="frCancel">Cancel</button>
      <button class="btn ${mode==='reject'?'btn-danger':'btn-primary'}" id="frSave">${mode==='approve'?'Approve':mode==='reject'?'Reject':'Save Comment'}</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#frClose').onclick = closeModal;
    overlay.querySelector('#frCancel').onclick = closeModal;
    overlay.querySelector('#frSave').onclick = ()=>{
      const comment = overlay.querySelector('#fr_comment').value.trim();
      if(mode!=='comment' && !comment){ toast('A review note is required.', 'error'); return; }
      const priceInput = overlay.querySelector('#fr_price');
      if(mode==='approve'){
        if(priceInput && priceInput.value){ q.finalPrice = Number(priceInput.value); q.priceIsTBC = false; }
        q.approvalStatus = 'Founder Approved';
        q.quotationStatus = 'Approved';
        DB.upsert('quotations', q);
        logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId:q.id, refLabel:`${q.quoteNumber} — ${q.businessName}`,
          type:'Founder Approved', description:`${CURRENT_USER.name} approved quotation ${q.quoteNumber} at ${money(q.finalPrice)}.`,
          fromValue:'Pending Founder Review', toValue:'Approved', remark: comment||null });
      } else if(mode==='reject'){
        q.approvalStatus = 'Founder Rejected';
        q.quotationStatus = 'Rejected';
        DB.upsert('quotations', q);
        logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId:q.id, refLabel:`${q.quoteNumber} — ${q.businessName}`,
          type:'Founder Rejected', description:`${CURRENT_USER.name} rejected quotation ${q.quoteNumber}.`,
          fromValue:'Pending Founder Review', toValue:'Rejected', remark: comment||null });
      } else {
        logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId:q.id, refLabel:`${q.quoteNumber} — ${q.businessName}`,
          type:'Quotation Edited', description:`${CURRENT_USER.name} commented on ${q.quoteNumber}: "${comment}"`, remark: comment });
      }
      DB.upsert('quotationReviews', { id:'QR'+q.id+Date.now(), quotationId:q.id, reviewer: CURRENT_USER.name, decision: mode==='approve'?'Approved':mode==='reject'?'Rejected':'Comment', comment, timestamp:new Date().toISOString() });
      closeModal();
      toast('Saved.', 'success');
      openQuotationDetailModal(id);
      if(currentRoute()==='quotations') renderQuotTable();
    };
  }});
}

/* ---------------------------------------------------------------------- */
/* Accepted → Project link                                                */
/* ---------------------------------------------------------------------- */

function markAsAccepted(id){
  const q = DB.find('quotations', id);
  q.quotationStatus = 'Accepted';
  DB.upsert('quotations', q);
  logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId:q.id, refLabel:`${q.quoteNumber} — ${q.businessName}`,
    type:'Quotation Accepted', description:`${CURRENT_USER.name} marked quotation ${q.quoteNumber} as Accepted. Value: ${money(q.finalPrice)}.`,
    toValue:'Accepted' });

  // Accepting a quotation is the sales-confirmation moment — the linked
  // lead moves to Confirmed here too (and stays Confirmed permanently; see
  // LEAD_STATUSES). This keeps Lead → Quotation → Project as one flow
  // instead of the lead silently sitting at "Quotation Sent" forever.
  const lead = q.leadId ? DB.find('leads', q.leadId) : null;
  if(lead && lead.status!=='Confirmed'){
    const prevStatus = lead.status;
    lead.status = 'Confirmed';
    lead.updatedAt = new Date().toISOString();
    DB.upsert('leads', lead);
    logActivity({ userName: CURRENT_USER.name, refType:'lead', refId: lead.id, refLabel:`${lead.clientName} — ${lead.businessName}`,
      type:'Status Changed', description:`${CURRENT_USER.name} changed status: ${prevStatus} → Confirmed`,
      fromValue: prevStatus, toValue:'Confirmed', remark:`Quotation ${q.quoteNumber} accepted.` });
  }

  // Duplicate protection: if this lead (or a manually-linked project) is
  // already tied to a Project, link the quotation to it instead of
  // creating a second Project record.
  const linkedExisting = q.projectId ? DB.find('projects', q.projectId) : (lead && lead.projectCode ? DB.find('projects', lead.projectCode) : null);
  if(!linkedExisting){
    if(confirm(`Create Project from this Quotation?\n\n${q.quoteNumber} — ${q.businessName}\nConfirmed Value: ${money(q.finalPrice)}`)){
      createProjectFromQuotation(q);
    } else {
      toast('Quotation accepted. No project was created.', 'success');
      openQuotationDetailModal(id);
    }
  } else {
    // Reuse the existing project — copy the quotation's confirmed value +
    // functions onto it (accepted quotation value becomes authoritative)
    // rather than duplicating.
    q.projectId = linkedExisting.id;
    DB.upsert('quotations', q);
    applyQuotationOntoProject(q, linkedExisting);
    toast(`Quotation accepted — linked to existing project ${linkedExisting.id}.`, 'success');
    openQuotationDetailModal(id);
  }
  if(currentRoute()==='quotations') renderQuotTable();
}

// Copies an accepted quotation's value + scope onto an already-existing
// Project (used both by createProjectFromQuotation for a brand new project,
// and when accepting a quotation for a lead that already has one).
function applyQuotationOntoProject(q, proj){
  proj.confirmedValue = q.finalPrice || q.basePrice || proj.confirmedValue || 0;
  proj.quotationRef = q.quoteNumber;
  const groups = {};
  q.items.forEach(it=>{
    if(!groups[it.module]) groups[it.module] = { id: fnId(), module: it.module, functions: [] };
    groups[it.module].functions.push({ id: fnId(), name: it.name, status:'Confirmed' });
  });
  proj.functions = Object.values(groups);
  DB.upsert('projects', proj);
  logActivity({ userName: CURRENT_USER.name, refType:'project', refId: proj.id, refLabel:`${proj.id} — ${proj.businessName}`,
    type:'Function Changed', description:`${CURRENT_USER.name} applied accepted quotation ${q.quoteNumber} to project ${proj.id} — Confirmed Value and Scope updated.`,
    remark:`Confirmed Value: ${money(proj.confirmedValue)}.` });
}

function createProjectFromQuotation(q){
  const lead = q.leadId ? DB.find('leads', q.leadId) : null;
  // Reuse the lead's already-reserved Project Code (spec §9: one Project
  // Code per project, never a newly-generated one when a code already
  // exists) — this path used to always mint a fresh code via
  // DB.nextId('C','projects'), which would have silently orphaned a code
  // already assigned back at Qualified -> Quote and Demo Sent.
  const code = (lead && lead.projectCode) ? lead.projectCode : suggestNextProjectCode();

  const proj = createProjectRecord({
    code, lead, confirmedValue: q.finalPrice || q.basePrice || 0, depositPct:50,
    overrides: {
      clientName: q.clientName, businessName: q.businessName, phone: q.phone,
      industry: q.industry, projectType: q.projectType, assignedSales: q.assignedSales,
      notes: `Created from quotation ${q.quoteNumber}.`,
    }
  });

  // VERY IMPORTANT: copy confirmed functions from the quotation into the
  // project's Confirmed Functions / Scope, grouped by module.
  const groups = {};
  q.items.forEach(it=>{
    if(!groups[it.module]) groups[it.module] = { id: fnId(), module: it.module, functions: [] };
    groups[it.module].functions.push({ id: fnId(), name: it.name, status:'Confirmed' });
  });
  proj.functions = Object.values(groups);
  proj.quotationRef = q.quoteNumber;
  DB.upsert('projects', proj);

  q.projectId = proj.id;
  DB.upsert('quotations', q);

  logActivity({ userName: CURRENT_USER.name, refType:'project', refId: proj.id, refLabel:`${proj.id} — ${proj.businessName}`,
    type:'Project Created', description:`${CURRENT_USER.name} created project ${proj.id} from accepted quotation ${q.quoteNumber}. Confirmed Value: ${money(proj.confirmedValue)}.`,
    toValue:'Confirmed', remark:`Functions copied from ${q.quoteNumber}.` });

  toast(`Project ${proj.id} created from ${q.quoteNumber}.`, 'success');
  closeModal();
  openProjectDetailModal(proj.id);
}

/* ---------------------------------------------------------------------- */
/* Branded preview + PDF (browser print)                                  */
/* ---------------------------------------------------------------------- */

function openQuotationPreview(id, autoPrint=false){
  const q = DB.find('quotations', id);
  if(!q) return;
  const grouped = {};
  q.items.forEach(it=>{ if(!grouped[it.module]) grouped[it.module]=[]; grouped[it.module].push(it); });

  const year1 = q.priceIsTBC ? 'TBC' : money(q.finalPrice);
  const svc = serviceByProjectType(q.projectType);
  const year2 = svc ? (svc.year2Price ? '~'+money(svc.year2Price)+' / year' : 'TBC') : 'TBC';
  const year3 = svc ? (svc.year3Price ? '~'+money(svc.year3Price)+' / year' : 'TBC') : 'TBC';

  const html = `
    <div class="modal-head"><h3>Quotation Preview</h3><button class="modal-close" id="qpClose">&times;</button></div>
    <div class="modal-body" style="background:#eef1f6;padding:20px">
      <div class="quote-doc" id="quoteDocPrintable">
        <div class="quote-doc-head">
          <div class="quote-doc-brand"><div class="logo-mark">BW</div><div><strong>BizWeb KH</strong><div class="text-muted" style="font-size:11px">Web &amp; Digital Solutions — Cambodia</div></div></div>
          <div class="quote-doc-meta">
            <div><b>Quotation No:</b> ${q.quoteNumber}</div>
            <div><b>Date:</b> ${fmtDate(q.createdAt)}</div>
            <div><b>Valid Until:</b> ${fmtDate(q.validUntil)}</div>
          </div>
        </div>
        <div class="quote-doc-clientbox">
          <div><b>Client:</b> ${escapeHtml(q.clientName)}</div>
          <div><b>Business:</b> ${escapeHtml(q.businessName)}</div>
          <div><b>Project:</b> ${escapeHtml(q.projectType)}</div>
        </div>
        <h4 class="quote-doc-h">Project Summary</h4>
        <p style="font-size:12.5px;margin:0 0 10px">A ${escapeHtml(q.projectType)} solution scoped and quoted for ${escapeHtml(q.businessName)}, including the functions listed below.</p>

        <h4 class="quote-doc-h">Scope of Work</h4>
        ${Object.entries(grouped).map(([module,items])=>`
          <div style="margin-bottom:8px">
            <div style="font-weight:700;font-size:12.5px;color:var(--navy,#0b2545)">${escapeHtml(module)}</div>
            <ul style="margin:4px 0 0;padding-left:18px;font-size:12.5px">${items.map(it=>`<li>${escapeHtml(it.name)}</li>`).join('')}</ul>
          </div>
        `).join('')}

        <h4 class="quote-doc-h">Pricing</h4>
        <table class="quote-doc-table">
          <thead><tr><th>Year</th><th>Details</th><th>Amount</th></tr></thead>
          <tbody>
            <tr><td>Year 1</td><td>Development, Hosting, Domain, Maintenance</td><td>${year1}</td></tr>
            <tr><td>Year 2</td><td>Renewal (hosting / maintenance)</td><td>${year2}</td></tr>
            <tr><td>Year 3</td><td>Renewal (hosting / maintenance)</td><td>${year3}</td></tr>
          </tbody>
        </table>

        <h4 class="quote-doc-h">Payment Schedule</h4>
        <p style="font-size:12.5px;margin:0">50% deposit to begin work, 50% balance due before final delivery/publish. Yearly renewals billed separately from Year 2 onward.</p>

        <h4 class="quote-doc-h">Important Notes</h4>
        <ul style="margin:4px 0 0;padding-left:18px;font-size:12px;color:var(--muted)">
          <li>Prices marked TBC are subject to Founder review and confirmation before final approval.</li>
          <li>This quotation is valid until ${fmtDate(q.validUntil)}.</li>
          <li>Scope changes after acceptance may require a revised quotation.</li>
        </ul>

        <div class="quote-doc-accept">
          <div><div class="sig-line"></div><span>Client Signature / Date</span></div>
          <div><div class="sig-line"></div><span>BizWeb KH Representative / Date</span></div>
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="qpClose2">Close</button>
      <button class="btn btn-primary" id="qpPrint">Download PDF (Print)</button>
    </div>
  `;
  openModal(html, { large:true, onMount:(overlay)=>{
    overlay.querySelector('#qpClose').onclick = closeModal;
    overlay.querySelector('#qpClose2').onclick = closeModal;
    overlay.querySelector('#qpPrint').onclick = ()=> window.print();
    if(autoPrint) setTimeout(()=> window.print(), 200);
  }});
}

/* ---------------------------------------------------------------------- */
/* Small helper for embedding a linked-quotations list inside Lead /       */
/* Project detail tabs (called from leads.js / projects.js)                */
/* ---------------------------------------------------------------------- */

function linkedQuotationsHtml(leadId, projectId){
  const list = DB.all('quotations').filter(q=> (leadId && q.leadId===leadId) || (projectId && q.projectId===projectId));
  return `
    <div class="flex-row" style="justify-content:space-between;margin-bottom:8px">
      <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin:0">Quotations</div>
      <span class="cell-link" style="font-size:12px" data-new-quote="${leadId||''}|${projectId||''}">+ New Quotation</span>
    </div>
    ${list.length ? list.map(q=>`
      <div class="mini-row" data-quote-row="${q.id}" style="cursor:pointer">
        <div class="mini-main"><div class="mini-title">${q.quoteNumber}</div><div class="mini-sub">${q.priceIsTBC?'TBC':money(q.finalPrice)} · ${escapeHtml(q.assignedSales)}</div></div>
        <div class="mini-right">${statusBadge(q.quotationStatus)}</div>
      </div>`).join('') : `<div class="empty-row">No quotations yet.</div>`}
  `;
}
function wireLinkedQuotations(container){
  container.querySelectorAll('[data-quote-row]').forEach(el=> el.onclick = ()=> openQuotationDetailModal(el.dataset.quoteRow));
  const newBtn = container.querySelector('[data-new-quote]');
  if(newBtn) newBtn.onclick = ()=>{
    const [leadId, projectId] = newBtn.dataset.newQuote.split('|');
    if(projectId) openCreateQuotationModal({ sourceType:'project', projectId });
    else if(leadId) openCreateQuotationModal({ sourceType:'lead', leadId });
    else openCreateQuotationModal({ sourceType:'new' });
  };
}
