/* ==========================================================================
   BizWeb KH CRM — quotations.js
   Quotations MVP: list + summary cards, Create Quotation (lead/opportunity
   autocomplete -> auto-fill -> package/scope/pricing/payment schedule ->
   live A4 preview), Sales-authority + Founder-review workflow, versioning
   (edit-after-Sent creates a new revision, old one -> Superseded), branded
   bilingual preview + PDF (browser print), and Accepted -> Convert to
   Project.
   ========================================================================== */

function isFounder(){ return /Founder/i.test(CURRENT_USER.role); }
function discountLimitPct(){ const db = DB.read(); return (db && db.settings && db.settings.discountLimitPct) || 10; }
// A service's own Maximum Sales Discount (set on the Service Price List)
// overrides the global default when present.
function effectiveDiscountLimit(svc){ return (svc && svc.maxDiscountPct!=null) ? svc.maxDiscountPct : discountLimitPct(); }

const QUOTATIONS_MODULE_ENABLED = true;

/* ---------------------------------------------------------------------- */
/* List page                                                              */
/* ---------------------------------------------------------------------- */

let QUOT_FILTER = { search:'', status:'', sales:'' };

function renderQuotationsPage(){
  const el = document.getElementById('pageContent');
  el.innerHTML = `
    <div id="quotSummaryCards"></div>
    <div class="filters-bar">
      <div class="search-box">
        ${icon('search')}
        <input type="text" id="qSearch" placeholder="Search quote no., project code, client, or business…" value="${escapeHtml(QUOT_FILTER.search)}">
      </div>
      <select id="qFltStatus" class="sel"><option value="">All Statuses</option>${QUOTATION_STATUSES.map(s=>`<option ${QUOT_FILTER.status===s?'selected':''}>${s}</option>`).join('')}</select>
      <select id="qFltSales" class="sel"><option value="">All Sales</option>${salesOwnersList().map(s=>`<option ${QUOT_FILTER.sales===s?'selected':''}>${s}</option>`).join('')}</select>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="createQuoteBtn">${icon('quote')} + Create Quotation</button>
    </div>
    <div id="quotTableWrap"></div>
  `;
  document.getElementById('qSearch').oninput = e=>{ QUOT_FILTER.search=e.target.value; renderQuotTable(); };
  document.getElementById('qFltStatus').onchange = e=>{ QUOT_FILTER.status=e.target.value; renderQuotTable(); };
  document.getElementById('qFltSales').onchange = e=>{ QUOT_FILTER.sales=e.target.value; renderQuotTable(); };
  document.getElementById('createQuoteBtn').onclick = ()=> openCreateQuotationModal();
  renderQuotSummaryCards();
  renderQuotTable();
}

// Live quotations = everything except Superseded (historical-only, reached
// via a newer revision's Version History) — never counted or listed here
// unless the user explicitly filters the Status dropdown to "Superseded".
function liveQuotations(){
  return DB.all('quotations').filter(q=>q.status!=='Superseded');
}

function renderQuotSummaryCards(){
  const wrap = document.getElementById('quotSummaryCards');
  const list = liveQuotations();
  const draft = list.filter(q=>q.status==='Draft').length;
  const awaiting = list.filter(q=>q.status==='Awaiting Approval').length;
  const sent = list.filter(q=>quotationDisplayStatus(q)==='Sent').length;
  const accepted = list.filter(q=>q.status==='Accepted').length;
  const totalValue = list.reduce((s,q)=> s + (Number(q.year1Total)||0), 0);
  wrap.innerHTML = `
    <div class="kpi-grid summary-cards-5" style="margin-bottom:14px">
      <div class="kpi-card" style="padding:12px 14px"><div class="kpi-value" style="font-size:20px">${draft}</div><div class="kpi-label" style="margin-top:4px">Draft</div></div>
      <div class="kpi-card" style="padding:12px 14px"><div class="kpi-value" style="font-size:20px;color:var(--amber)">${awaiting}</div><div class="kpi-label" style="margin-top:4px">Awaiting Approval</div></div>
      <div class="kpi-card" style="padding:12px 14px"><div class="kpi-value" style="font-size:20px;color:var(--blue)">${sent}</div><div class="kpi-label" style="margin-top:4px">Sent</div></div>
      <div class="kpi-card" style="padding:12px 14px"><div class="kpi-value" style="font-size:20px;color:var(--green)">${accepted}</div><div class="kpi-label" style="margin-top:4px">Accepted</div></div>
      <div class="kpi-card" style="padding:12px 14px"><div class="kpi-value" style="font-size:20px">${money(totalValue)}</div><div class="kpi-label" style="margin-top:4px">Total Quoted Value</div></div>
    </div>
  `;
}

function filteredQuotations(){
  const f = QUOT_FILTER;
  const base = f.status==='Superseded' ? DB.all('quotations') : liveQuotations();
  return base.filter(q=>{
    if(f.search){
      const s = f.search.toLowerCase();
      const hay = [q.quoteNumber, q.projectCode, q.clientName, q.businessName].filter(Boolean).join(' ').toLowerCase();
      if(!hay.includes(s)) return false;
    }
    if(f.status && quotationDisplayStatus(q)!==f.status && q.status!==f.status) return false;
    if(f.sales && q.assignedSales!==f.sales) return false;
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
          <th>Quote No.</th><th>Project Code</th><th>Client / Business</th><th>Package</th><th>Amount</th>
          <th>Sales</th><th>Status</th><th>Date</th><th>Valid Until</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${rows.length ? rows.map(q=>`
            <tr>
              <td class="cell-link" data-open="${q.id}">${q.quoteNumber}${q.version>1?` <span class="text-muted" style="font-weight:400">v${q.version}</span>`:''}</td>
              <td>${escapeHtml(q.projectCode||'—')}</td>
              <td><div class="cell-strong">${escapeHtml(q.clientName)}</div><div class="text-muted" style="font-size:11.5px">${escapeHtml(q.businessName)}</div></td>
              <td>${escapeHtml(q.packageName||q.packageKey||'')}</td>
              <td class="cell-strong">${q.priceIsTBC?'TBC':money(q.year1Total)}</td>
              <td><div class="flex-row"><div class="avatar-sm" style="background:${userColor(q.assignedSales)}">${userInitials(q.assignedSales)}</div>${escapeHtml(q.assignedSales)}</div></td>
              <td>${statusBadge(quotationDisplayStatus(q))}</td>
              <td>${fmtDate(q.quotationDate||q.createdAt)}</td>
              <td>${fmtDate(q.validUntil)}</td>
              <td>
                <div class="flex-row" style="gap:6px;flex-wrap:wrap">
                  <button class="btn btn-secondary btn-sm" data-open="${q.id}">View</button>
                  <button class="btn btn-ghost btn-sm" data-dup="${q.id}">Duplicate</button>
                  <button class="btn btn-ghost btn-sm" data-pdf="${q.id}">PDF</button>
                </div>
              </td>
            </tr>`).join('') : `<tr><td colspan="10"><div class="empty-row">No quotations yet. Use "+ Create Quotation" to start one.</div></td></tr>`}
        </tbody>
      </table>
    </div>
    <p class="text-muted" style="margin-top:10px;font-size:12px">Showing ${rows.length} of ${liveQuotations().length} quotations</p>
  `;
  wrap.querySelectorAll('[data-open]').forEach(x=> x.onclick = ()=> openQuotationDetailModal(x.dataset.open));
  wrap.querySelectorAll('[data-pdf]').forEach(x=> x.onclick = ()=> openQuotationPreview(x.dataset.pdf, true));
  wrap.querySelectorAll('[data-dup]').forEach(x=> x.onclick = ()=> duplicateQuotation(x.dataset.dup));
}

function duplicateQuotation(id){
  const q = DB.find('quotations', id);
  if(!q) return;
  openCreateQuotationModal({ leadId: q.leadId, sourceType: q.leadId ? 'lead' : 'new', duplicateFrom: q.id });
}

/* ---------------------------------------------------------------------- */
/* Create Quotation — Step 1: lead / opportunity autocomplete             */
/* ---------------------------------------------------------------------- */

let QC_STATE = null;
let QC_TAB = 'edit'; // 'edit' | 'preview' — used on narrow screens only
// Live preview zoom: 'fit' (recomputed to the panel's current width) or a
// literal scale factor (1 = 100%). Typography/layout fix — purely a screen
// convenience, never applied to the printed/PDF document itself.
let QC_ZOOM = 'fit';
const QC_A4_PAGE_WIDTH_PX = 794; // 210mm at 96dpi — the physical page width the preview scales from

// Any lead/opportunity that a quotation can be created against — never
// creates a duplicate lead: this always searches EXISTING Lead Records
// (spec §3), Pipeline opportunities preferred/sorted first, never filtered
// down to only "eligible" ones the way Add-to-Pipeline is (a quotation can
// legitimately be created against a lead at any stage).
function quotationSearchableLeads(){
  return DB.all('leads').filter(l=>!l.archived);
}
function digitsOnly(s){ return String(s||'').replace(/\D/g,''); }
function quotationLeadMatches(l, nq){
  if(!nq) return true;
  const fields = [l.id, l.clientName, l.businessName, l.interestedService, l.interestedService?serviceDisplayName(l.interestedService):null, l.projectCode].filter(Boolean).map(v=>String(v).toLowerCase());
  if(fields.some(f=>f.includes(nq))) return true;
  const qDigits = digitsOnly(nq);
  return qDigits.length>=3 && digitsOnly(l.phone).includes(qDigits);
}
function quotationLeadSuggestions(query){
  const nq = String(query||'').trim().toLowerCase();
  let leads = quotationSearchableLeads();
  if(nq) leads = leads.filter(l=>quotationLeadMatches(l, nq));
  // Pipeline opportunities preferred/sorted first (spec §3), then the rest,
  // each group newest-first.
  leads.sort((a,b)=>{
    const pa = PIPELINE_STATUSES.includes(a.status) ? 0 : 1;
    const pb = PIPELINE_STATUSES.includes(b.status) ? 0 : 1;
    if(pa!==pb) return pa-pb;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
  return leads.slice(0, 10);
}

function openCreateQuotationModal(prefill={}){
  let base = null;
  if(prefill.duplicateFrom){
    const src = DB.find('quotations', prefill.duplicateFrom);
    if(src) base = loadStateFromQuotation(src, { asDuplicate:true });
  }
  QC_STATE = base || {
    sourceType: prefill.sourceType || 'lead', // lead | new
    leadId: prefill.leadId || null,
    clientName:'', businessName:'', phone:'', telegram:'', industry:'', interestedService:'',
    assignedSales: CURRENT_USER.name,
    packageKey:'', discountPct:0, adjustment:0, adjustmentReason:'',
    items: [], exclusions: [], notesOverride: null, clientNote:'',
    domainName:'', domainCost: DEFAULT_DOMAIN_COST_ESTIMATE, domainIncluded:true, domainRenewalEstimate: DEFAULT_DOMAIN_COST_ESTIMATE,
    paymentPreset: '30/70', customStages:null,
    quotationDate: todayLocalISO(), validUntil: daysFromNow(quotationDefaults().validityDays),
    demoLink:'', editingId: null, versionOf: null,
  };
  if(QC_STATE.leadId) applyLeadToQC(QC_STATE.leadId);
  QC_TAB = 'edit';
  QC_ZOOM = 'fit';
  renderCreateQuotationModal();
}

function applyLeadToQC(leadId){
  const lead = DB.find('leads', leadId);
  if(!lead) return;
  Object.assign(QC_STATE, {
    leadId: lead.id, sourceType:'lead', projectCode: lead.projectCode || null,
    clientName: lead.clientName, businessName: lead.businessName, phone: lead.phone,
    telegram: lead.telegram||'', industry: lead.industry, interestedService: lead.interestedService||'',
    assignedSales: canChooseAssignedSales(CURRENT_USER.role) ? lead.assignedSales : CURRENT_USER.name,
  });
  if(!QC_STATE.packageKey && lead.interestedService){
    const svc = serviceByProjectType(lead.interestedService);
    if(svc) selectPackageOnQC(svc.projectType);
  }
}

function selectPackageOnQC(projectType){
  const svc = serviceByProjectType(projectType);
  QC_STATE.packageKey = projectType;
  QC_STATE.quotationType = svc ? quotationTypeForProjectType(svc.projectType) : 'website';
  if(!svc){ QC_STATE.items = []; QC_STATE.exclusions = []; return; }
  const baseItem = { id: fnId(), module: svc.category, name: `${svc.shortName || svc.name} (Base Package${svc.priceIsStartingFrom?' — starting from':''})`,
    price: svc.basePrice, founderReviewRequired: svc.founderReviewRequired, included: true };
  const fnItems = svc.functions.map(f=>({ id:fnId(), module: svc.category, name:f.name,
    price: f.defaultPrice===null ? null : 0, founderReviewRequired: f.founderReviewRequired, included: f.included }));
  QC_STATE.items = [baseItem, ...fnItems];
  QC_STATE.exclusions = [...(quotationDefaults().exclusions[QC_STATE.quotationType]||[])];
}

function qcQuoteNumberPreview(){
  const code = QC_STATE.projectCode || QC_STATE.leadId || 'DIRECT';
  return generateQuoteNumber(code, QC_STATE.quotationDate);
}

function renderCreateQuotationModal(){
  const s = QC_STATE;
  const svc = serviceByProjectType(s.packageKey);
  const activeItems = s.items.filter(i=>i.included!==false).map(i=>({name:i.name, price:i.price, founderReviewRequired:i.founderReviewRequired}));
  const evalRes = evaluateQuotation({
    items: activeItems, basePackage: svc, discountPct: Number(s.discountPct)||0,
    manualAdjustment: s.adjustment ? { amount:Number(s.adjustment), reason:s.adjustmentReason } : null,
    discountLimitPct: effectiveDiscountLimit(svc),
  });
  const year1 = evalRes.finalPrice;
  const paymentTotal = evalRes.priceIsTBC ? 0 : year1;
  const schedule = computePaymentSchedule(paymentTotal, s.paymentPreset, s.customStages);
  const notesList = s.notesOverride || (s.packageKey ? (quotationDefaults().notes[quotationTypeForProjectType(s.packageKey)]||[]) : []);

  const html = `
    <div class="modal-head">
      <h3>${s.editingId?'Edit Quotation':'Create Quotation'}</h3>
      <div class="qc-tabs">
        <div class="tab-btn ${QC_TAB==='edit'?'active':''}" data-qctab="edit">Edit</div>
        <div class="tab-btn ${QC_TAB==='preview'?'active':''}" data-qctab="preview">Preview</div>
      </div>
      <button class="modal-close" id="cqClose">&times;</button>
    </div>
    <div class="modal-body qc-modal-body">
      <div class="qc-split">
        <div class="qc-edit-col" ${QC_TAB!=='edit'?'data-hide-narrow="1"':''}>

          <div class="form-field" style="margin-bottom:12px">
            <label>Source</label>
            <div class="flex-row" style="gap:8px;flex-wrap:wrap">
              <button class="btn btn-sm ${s.sourceType==='lead'?'btn-primary':'btn-outline'}" data-src="lead">Existing Lead / Opportunity</button>
              <button class="btn btn-sm ${s.sourceType==='new'?'btn-primary':'btn-outline'}" data-src="new">New / Direct Client</button>
            </div>
          </div>

          ${s.sourceType==='lead' ? `
          <div class="form-field full" style="margin-bottom:12px">
            <label class="required">Select Lead</label>
            <div class="search-box" id="qcSearchBox" style="max-width:100%">
              ${icon('search')}
              <input type="text" id="qcSearch" placeholder="Search by Lead ID, Client Name, Business Name, Phone, or Project Code…" autocomplete="off">
            </div>
            <div id="qcResults" class="atp-dropdown" style="display:none"></div>
            ${s.leadId ? `<div class="text-muted" style="font-size:12px;margin-top:6px">Linked: ${escapeHtml(s.leadId)} — ${escapeHtml(s.clientName)} — ${escapeHtml(s.businessName)}</div>` : ''}
          </div>` : ''}

          <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">A. Client Information</div>
          <div class="form-grid">
            <div class="form-field"><label class="required">Client Name</label><input id="cq_clientName" value="${escapeHtml(s.clientName)}" ${s.sourceType!=='new'?'disabled':''}></div>
            <div class="form-field"><label class="required">Business Name</label><input id="cq_businessName" value="${escapeHtml(s.businessName)}" ${s.sourceType!=='new'?'disabled':''}></div>
            <div class="form-field"><label>Phone</label><input id="cq_phone" value="${escapeHtml(s.phone)}" ${s.sourceType!=='new'?'disabled':''}></div>
            <div class="form-field"><label>Telegram</label><input id="cq_telegram" value="${escapeHtml(s.telegram)}"></div>
            <div class="form-field"><label class="required">Industry</label>
              <select id="cq_industry" class="sel" ${s.sourceType!=='new'?'disabled':''}>${INDUSTRIES.map(i=>`<option ${s.industry===i?'selected':''}>${i}</option>`).join('')}</select>
            </div>
            <div class="form-field"><label class="required">Assigned Sales</label>
              ${canChooseAssignedSales(CURRENT_USER.role)
                ? `<select id="cq_sales" class="sel">${salesOwnersList().map(n=>`<option ${s.assignedSales===n?'selected':''}>${n}</option>`).join('')}</select>`
                : `<input value="${escapeHtml(s.assignedSales)}" disabled>`}
            </div>
          </div>

          <div class="divider"></div>
          <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">B. Project Information</div>
          <div class="form-grid">
            <div class="form-field full">
              <label class="required">Package (from Service Price List)</label>
              <select id="cq_package" class="sel" style="width:100%">
                <option value="">Select a package…</option>
                ${SERVICE_PRICE_LIST.map(p=>`<option value="${p.projectType}" ${s.packageKey===p.projectType?'selected':''}>${p.name} — ${p.priceIsStartingFrom?'from ':''}$${p.basePrice}${p.salesCanQuote?'':' (Founder Review)'}</option>`).join('')}
              </select>
            </div>
            <div class="form-field"><label>Project Code</label><input value="${escapeHtml(s.projectCode||'Assigned when quotation is sent to a Pipeline project')}" disabled></div>
            <div class="form-field"><label>Quote No. (preview)</label><input value="${s.packageKey?qcQuoteNumberPreview():'—'}" disabled></div>
            <div class="form-field"><label class="required">Quotation Date</label><input type="date" id="cq_qdate" value="${s.quotationDate}" ${isFounder()?'':'disabled'}></div>
            <div class="form-field"><label class="required">Valid Until</label><input type="date" id="cq_validUntil" value="${s.validUntil}" ${isFounder()?'':'disabled'}></div>
            <div class="form-field full"><label>Demo Link</label><input id="cq_demoLink" value="${escapeHtml(s.demoLink)}" placeholder="https://..."></div>
          </div>

          <div class="divider"></div>
          <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">Domain</div>
          <div class="form-grid">
            <div class="form-field"><label>Domain Name</label><input id="cq_domainName" value="${escapeHtml(s.domainName)}" placeholder="e.g. example.com"></div>
            <div class="form-field"><label>Domain Cost ($)</label><input type="number" id="cq_domainCost" value="${s.domainCost}"></div>
            <div class="form-field"><label>Domain Included in Year 1?</label>
              <select id="cq_domainIncluded" class="sel"><option value="yes" ${s.domainIncluded?'selected':''}>Yes</option><option value="no" ${!s.domainIncluded?'selected':''}>No</option></select>
            </div>
            <div class="form-field"><label>Domain Renewal Estimate ($/yr)</label><input type="number" id="cq_domainRenewal" value="${s.domainRenewalEstimate}"></div>
          </div>

          <div class="divider"></div>
          <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">C. Scope of Work</div>
          <div id="cq_itemsWrap">${quotationItemsEditorHtml(s.items)}</div>
          <button class="btn btn-outline btn-sm" id="cq_addFn" style="margin:8px 0 16px">+ Add Custom Scope Item</button>
          <div class="text-muted" style="font-size:12px;margin:-8px 0 14px">Standard exclusions for this package (Founder/Admin-editable in Settings → Quotations):</div>
          <ul style="margin:-8px 0 16px;padding-left:18px;font-size:12.5px;color:var(--muted)">${s.exclusions.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul>

          <div class="divider"></div>
          <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">D. Year-by-Year Costs</div>
          <div class="form-grid">
            <div class="form-field"><label>Year 1 Total (auto)</label><input value="${evalRes.priceIsTBC?'TBC':money(year1)}" disabled></div>
            <div class="form-field"><label>Year 2 Renewal ($/yr)</label><input type="number" id="cq_year2" value="${s.year2Total!=null?s.year2Total:(svc?svc.year2Price:0)}" ${isFounder()?'':'disabled'}></div>
            <div class="form-field"><label>Year 3 Renewal ($/yr)</label><input type="number" id="cq_year3" value="${s.year3Total!=null?s.year3Total:(svc?svc.year3Price:0)}" ${isFounder()?'':'disabled'}></div>
          </div>

          <div class="divider"></div>
          ${isFounder() ? `
          <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">Pricing Adjustments (Founder/Admin only)</div>
          <div class="form-grid">
            <div class="form-field"><label>Discount %</label><input type="number" id="cq_discount" value="${s.discountPct}" min="0" max="100"></div>
            <div class="form-field"><label>Manual Price Adjustment ($)</label><input type="number" id="cq_adjust" value="${s.adjustment}"></div>
            <div class="form-field full"><label>Reason for Price Adjustment ${s.adjustment?'<span class="required"></span>':'(required if adjusting)'}</label><input id="cq_adjustReason" value="${escapeHtml(s.adjustmentReason)}" placeholder='e.g. "Client already has hosting."'></div>
          </div>
          <div class="divider"></div>` : `
          <div class="form-field" style="margin-bottom:12px"><label>Discount %</label><input value="0" disabled></div>
          <div class="divider"></div>`}

          <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">E. Payment Schedule</div>
          <div class="form-field" style="margin-bottom:12px">
            <label>Preset</label>
            <select id="cq_paymentPreset" class="sel">
              ${['30/70','30/30/40','50/50','Custom'].map(p=>`<option value="${p}" ${s.paymentPreset===p?'selected':''}>${p}</option>`).join('')}
            </select>
          </div>
          <div class="table-wrap scroll-x">
            <table class="data-table"><thead><tr><th>Stage</th><th>%</th><th>Amount</th></tr></thead>
            <tbody>${schedule.map(st=>`<tr><td>${escapeHtml(st.label)}</td><td>${st.pct}%</td><td>${money(st.amount)}</td></tr>`).join('')}</tbody></table>
          </div>
          <p class="text-muted" style="font-size:11.5px;margin:6px 0 16px">Stages always sum exactly to the Year 1 Total (${evalRes.priceIsTBC?'TBC':money(year1)}).</p>

          <div class="divider"></div>
          <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">F. Important Notes</div>
          ${notesList.map(n=>`<div class="mini-row"><div class="mini-main"><div class="mini-title">${escapeHtml(n.title)}</div><div class="mini-sub">${escapeHtml(n.text)}</div></div></div>`).join('')}
          <div class="form-field" style="margin:10px 0 16px"><label>Client-Specific Note (optional)</label><textarea id="cq_clientNote" placeholder="Anything specific to this client — never overrides the standard notes above.">${escapeHtml(s.clientNote)}</textarea></div>

          <div id="cq_authorityBanner">${authorityBannerHtml(evalRes)}</div>
        </div>

        <div class="qc-preview-col" ${QC_TAB!=='preview'?'data-hide-narrow="1"':''}>
          <div class="qc-preview-toolbar">
            <span class="text-muted" style="font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px">Quotation Preview</span>
            <div class="qc-zoom-controls">
              <button class="btn btn-ghost btn-sm ${QC_ZOOM==='fit'?'active':''}" data-zoom="fit" title="Fit to panel width">Fit</button>
              <button class="btn btn-ghost btn-sm ${QC_ZOOM===1?'active':''}" data-zoom="100" title="Actual size">100%</button>
              <button class="btn btn-ghost btn-sm" data-zoom="out" title="Zoom out">&minus;</button>
              <button class="btn btn-ghost btn-sm" data-zoom="in" title="Zoom in">+</button>
            </div>
          </div>
          <div class="qc-preview-canvas" id="qcPreviewCanvas">
            <div class="qc-a4-scale" id="qcA4Scale">
              <div id="cq_livePreview">${quotationPreviewDocHtml(qcStateToPreviewQuotation(s, evalRes, schedule))}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="cqCancel">Cancel</button>
      <button class="btn btn-primary" id="cqSave">${s.editingId?'Save Revision':'Save as Draft'}</button>
    </div>
  `;

  openModal(html, { xl:true, onMount:(overlay)=>{
    overlay.querySelector('#cqClose').onclick = closeModal;
    overlay.querySelector('#cqCancel').onclick = closeModal;
    overlay.querySelectorAll('[data-qctab]').forEach(t=> t.onclick = ()=>{ QC_TAB = t.dataset.qctab; renderCreateQuotationModal(); });
    overlay.querySelectorAll('[data-zoom]').forEach(b=> b.onclick = ()=>{
      const z = b.dataset.zoom;
      if(z==='fit') QC_ZOOM = 'fit';
      else if(z==='100') QC_ZOOM = 1;
      else if(z==='in') QC_ZOOM = Math.min(2, (QC_ZOOM==='fit'?qcCurrentFitZoom(overlay):QC_ZOOM) + 0.1);
      else if(z==='out') QC_ZOOM = Math.max(0.3, (QC_ZOOM==='fit'?qcCurrentFitZoom(overlay):QC_ZOOM) - 0.1);
      renderCreateQuotationModal();
    });
    qcApplyZoom(overlay);
    qcWireResize(overlay);

    overlay.querySelectorAll('[data-src]').forEach(b=> b.onclick = ()=>{
      s.sourceType = b.dataset.src;
      if(s.sourceType==='new'){ s.leadId=null; s.projectCode=null; }
      renderCreateQuotationModal();
    });

    const searchInput = overlay.querySelector('#qcSearch');
    if(searchInput){
      const resultsEl = overlay.querySelector('#qcResults');
      const renderResults = ()=>{
        const matches = quotationLeadSuggestions(searchInput.value);
        resultsEl.style.display = 'block';
        resultsEl.innerHTML = matches.length ? matches.map(l=>`
          <div class="atp-row" data-pick="${l.id}">
            <div class="mini-main"><div class="mini-title">${escapeHtml(l.id)} — ${escapeHtml(l.clientName)}</div><div class="mini-sub">${escapeHtml(l.businessName)} · ${escapeHtml(l.status)}</div></div>
            <span class="atp-pill ${PIPELINE_STATUSES.includes(l.status)?'atp-pill-select':'atp-pill-notqualified'}">${PIPELINE_STATUSES.includes(l.status)?'Pipeline':l.status}</span>
          </div>`).join('') : `<div class="empty-row">No matching Lead Record found.</div>`;
        resultsEl.querySelectorAll('[data-pick]').forEach(r=> r.onclick = ()=>{
          applyLeadToQC(r.dataset.pick);
          renderCreateQuotationModal();
        });
      };
      searchInput.oninput = renderResults;
      searchInput.onfocus = renderResults;
    }

    const cn = overlay.querySelector('#cq_clientName'); if(cn) cn.oninput = e=>{ s.clientName = e.target.value; refreshQcPreview(overlay); };
    const bn = overlay.querySelector('#cq_businessName'); if(bn) bn.oninput = e=>{ s.businessName = e.target.value; refreshQcPreview(overlay); };
    const ph = overlay.querySelector('#cq_phone'); if(ph) ph.oninput = e=> s.phone = e.target.value;
    overlay.querySelector('#cq_telegram').oninput = e=> s.telegram = e.target.value;
    const industrySel = overlay.querySelector('#cq_industry');
    if(industrySel) industrySel.onchange = e=> s.industry = e.target.value;
    const salesSel = overlay.querySelector('#cq_sales');
    if(salesSel) salesSel.onchange = e=> s.assignedSales = e.target.value;

    overlay.querySelector('#cq_package').onchange = e=>{
      selectPackageOnQC(e.target.value);
      renderCreateQuotationModal();
    };
    overlay.querySelector('#cq_qdate').onchange = e=>{ s.quotationDate = e.target.value; renderCreateQuotationModal(); };
    overlay.querySelector('#cq_validUntil').onchange = e=>{ s.validUntil = e.target.value; refreshQcPreview(overlay); };
    overlay.querySelector('#cq_demoLink').oninput = e=>{ s.demoLink = e.target.value; refreshQcPreview(overlay); };

    overlay.querySelector('#cq_domainName').oninput = e=>{ s.domainName = e.target.value; refreshQcPreview(overlay); };
    overlay.querySelector('#cq_domainCost').oninput = e=>{ s.domainCost = e.target.value; refreshQcPreview(overlay); };
    overlay.querySelector('#cq_domainIncluded').onchange = e=>{ s.domainIncluded = e.target.value==='yes'; refreshQcPreview(overlay); };
    overlay.querySelector('#cq_domainRenewal').oninput = e=>{ s.domainRenewalEstimate = e.target.value; refreshQcPreview(overlay); };

    overlay.querySelector('#cq_addFn').onclick = ()=> openAddQuotationFunctionModal((fnDef)=>{
      s.items.push({ id: fnId(), module:'Add-on', name: fnDef.name, price: fnDef.defaultPrice, founderReviewRequired: fnDef.founderReviewRequired, included:true });
      renderCreateQuotationModal();
    });
    wireQuotationItemsEditor(overlay, s);

    const discountInput = overlay.querySelector('#cq_discount');
    if(discountInput) discountInput.oninput = e=>{ s.discountPct = e.target.value; renderCreateQuotationModal(); };
    const adjustInput = overlay.querySelector('#cq_adjust');
    if(adjustInput) adjustInput.oninput = e=>{ s.adjustment = e.target.value; renderCreateQuotationModal(); };
    const adjustReason = overlay.querySelector('#cq_adjustReason');
    if(adjustReason) adjustReason.oninput = e=>{ s.adjustmentReason = e.target.value; };
    const y2 = overlay.querySelector('#cq_year2'); if(y2) y2.oninput = e=>{ s.year2Total = e.target.value; refreshQcPreview(overlay); };
    const y3 = overlay.querySelector('#cq_year3'); if(y3) y3.oninput = e=>{ s.year3Total = e.target.value; refreshQcPreview(overlay); };

    overlay.querySelector('#cq_paymentPreset').onchange = e=>{ s.paymentPreset = e.target.value; renderCreateQuotationModal(); };
    overlay.querySelector('#cq_clientNote').oninput = e=>{ s.clientNote = e.target.value; refreshQcPreview(overlay); };

    overlay.querySelector('#cqSave').onclick = ()=> saveQuotationFromState(s);
  }});
}

function refreshQcPreview(overlay){
  const s = QC_STATE;
  const svc = serviceByProjectType(s.packageKey);
  const activeItems = s.items.filter(i=>i.included!==false).map(i=>({name:i.name, price:i.price, founderReviewRequired:i.founderReviewRequired}));
  const evalRes = evaluateQuotation({
    items: activeItems, basePackage: svc, discountPct: Number(s.discountPct)||0,
    manualAdjustment: s.adjustment ? { amount:Number(s.adjustment), reason:s.adjustmentReason } : null,
    discountLimitPct: effectiveDiscountLimit(svc),
  });
  const schedule = computePaymentSchedule(evalRes.priceIsTBC?0:evalRes.finalPrice, s.paymentPreset, s.customStages);
  overlay.querySelector('#cq_authorityBanner').innerHTML = authorityBannerHtml(evalRes);
  const preview = overlay.querySelector('#cq_livePreview');
  if(preview) preview.innerHTML = quotationPreviewDocHtml(qcStateToPreviewQuotation(s, evalRes, schedule));
  qcApplyZoom(overlay);
}

/* ---------------------------------------------------------------------- */
/* Live preview zoom (screen-only — never affects the printed document)   */
/* ---------------------------------------------------------------------- */

// The actual "Fit" ratio for the panel's current width — used both to
// render the page and as the starting point for +/- so zooming in/out
// always feels continuous from whatever "Fit" was just showing.
function qcCurrentFitZoom(overlay){
  const canvas = overlay.querySelector('#qcPreviewCanvas');
  if(!canvas) return 1;
  const available = canvas.clientWidth - 32; // minus the canvas's own side padding
  if(!available || available<=0) return 1;
  return Math.max(0.3, Math.min(1.5, available / QC_A4_PAGE_WIDTH_PX));
}
function qcApplyZoom(overlay){
  const canvas = overlay.querySelector('#qcPreviewCanvas');
  const scaleEl = overlay.querySelector('#qcA4Scale');
  if(!canvas || !scaleEl) return;
  const z = QC_ZOOM==='fit' ? qcCurrentFitZoom(overlay) : QC_ZOOM;
  // `zoom` (not `transform:scale`) so the panel's scrollable height tracks
  // the scaled page automatically — no manual height/overflow math needed
  // to keep the internal vertical scrollbar correct at any zoom level.
  scaleEl.style.zoom = z;
}
// Recomputes "Fit" on window resize while a Create/Edit Quotation modal is
// open. Only one listener is ever live at a time (each call removes the
// previous one first) so re-rendering the modal repeatedly never piles up
// duplicate handlers.
let QC_RESIZE_HANDLER = null;
function qcWireResize(overlay){
  if(QC_RESIZE_HANDLER) window.removeEventListener('resize', QC_RESIZE_HANDLER);
  QC_RESIZE_HANDLER = ()=>{
    if(!document.body.contains(overlay)){ window.removeEventListener('resize', QC_RESIZE_HANDLER); QC_RESIZE_HANDLER = null; return; }
    if(QC_ZOOM==='fit') qcApplyZoom(overlay);
  };
  window.addEventListener('resize', QC_RESIZE_HANDLER);
}

function authorityBannerHtml(evalRes){
  if(evalRes.requiresFounderReview){
    return `<div class="panel" style="border-color:var(--orange,#d98a12);background:#fff8ec;padding:12px 14px;margin-top:12px">
      <strong style="color:#a56206">⚠ Founder Review Required</strong>
      <ul style="margin:6px 0 0;padding-left:18px;font-size:12.5px;color:var(--navy)">${evalRes.reasons.map(r=>`<li>${escapeHtml(r)}</li>`).join('')}</ul>
      <div style="margin-top:8px;font-size:13px">Estimated Year 1 Total: <b>${evalRes.priceIsTBC?'TBC':money(evalRes.finalPrice)}</b></div>
    </div>`;
  }
  return `<div class="panel" style="border-color:var(--green,#12a775);background:#eefaf4;padding:12px 14px;margin-top:12px">
    <strong style="color:#0d8a5f">✓ Within Sales Quoting Authority</strong>
    <div style="margin-top:8px;font-size:13px">Year 1 Total: <b>${money(evalRes.finalPrice)}</b> ${evalRes.discountAmt?`(after ${money(evalRes.discountAmt)} discount)`:''}</div>
  </div>`;
}

function openAddQuotationFunctionModal(onPick){
  const html = `
    <div class="modal-head"><h3>Add Scope Item</h3><button class="modal-close" id="afqClose">&times;</button></div>
    <div class="modal-body">
      <div class="form-field" style="margin-bottom:12px">
        <label>Choose from catalog</label>
        <select id="afq_pick" class="sel" style="width:100%">
          <option value="">Select a function…</option>
          ${ADDITIONAL_FUNCTIONS_CATALOG.map(a=>`<option value="${a.id}">${escapeHtml(a.name)} — ${a.defaultPrice===null?'TBC (Founder review)':'$'+a.defaultPrice}</option>`).join('')}
        </select>
      </div>
      <div class="divider"></div>
      <p class="text-muted" style="font-size:12px;margin:0 0 8px">Or add a custom item not in the catalog — this always requires Founder review (price shows as TBC), matching the spec's advanced-feature warning (OTP, Payment Gateway, Mobile App, Multi-Branch, Advanced API Integration, Custom Workflow, etc.).</p>
      <div class="form-field"><label>Custom Item Name</label><input id="afq_custom" placeholder="e.g. Loyalty points system"></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="afqCancel">Cancel</button>
      <button class="btn btn-primary" id="afqAdd">Add</button>
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
      toast('Pick an item from the catalog, or type a custom one.', 'error');
    };
  }});
}

function quotationItemsEditorHtml(items){
  if(!items.length) return `<div class="empty-row">Select a package to load its included scope items.</div>`;
  return `
    <div class="table-wrap scroll-x">
      <table class="data-table">
        <thead><tr><th>Include</th><th>Module</th><th>Item</th><th>Price</th><th></th></tr></thead>
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
    renderCreateQuotationModal();
  });
  overlay.querySelectorAll('[data-remove-item]').forEach(x=> x.onclick = ()=>{
    s.items = s.items.filter(i=>i.id!==x.dataset.removeItem);
    renderCreateQuotationModal();
  });
}

/* ---------------------------------------------------------------------- */
/* Save                                                                    */
/* ---------------------------------------------------------------------- */

function saveQuotationFromState(s){
  if(!s.clientName || !s.businessName){ toast('Client Name and Business Name are required.', 'error'); return; }
  if(!s.packageKey){ toast('Please select a package.', 'error'); return; }
  if(isFounder() && s.adjustment && !s.adjustmentReason.trim()){ toast('A Reason for Price Adjustment is required.', 'error'); return; }

  const svc = serviceByProjectType(s.packageKey);
  const activeItems = s.items.filter(i=>i.included!==false);
  const evalRes = evaluateQuotation({
    items: activeItems.map(i=>({name:i.name, price:i.price, founderReviewRequired:i.founderReviewRequired})),
    basePackage: svc, discountPct: isFounder() ? (Number(s.discountPct)||0) : 0,
    manualAdjustment: (isFounder() && s.adjustment) ? { amount:Number(s.adjustment), reason:s.adjustmentReason } : null,
    discountLimitPct: effectiveDiscountLimit(svc),
  });

  const year1Total = evalRes.priceIsTBC ? null : evalRes.finalPrice;
  const schedule = computePaymentSchedule(year1Total||0, s.paymentPreset, s.customStages);
  const code = s.projectCode || s.leadId || ('DIRECT'+Date.now().toString().slice(-4));

  let existing = s.editingId ? DB.find('quotations', s.editingId) : null;
  let isNewRevision = false;
  let id, rootQuotationId, version, previousVersionId, quoteNumber, createdAt, createdBy;

  if(existing && existing.status==='Draft'){
    // Draft is mutable in place — no version bump, same id/number.
    id = existing.id; rootQuotationId = existing.rootQuotationId || existing.id;
    version = existing.version||1; previousVersionId = existing.previousVersionId||null;
    quoteNumber = existing.quoteNumber; createdAt = existing.createdAt; createdBy = existing.createdBy;
  } else if(existing){
    // Already Sent/Approved/Accepted/etc — editing creates a NEW revision row
    // and marks the old one Superseded (spec §22): every version is kept,
    // nothing is silently overwritten.
    isNewRevision = true;
    id = 'QT' + Math.random().toString(36).slice(2,9).toUpperCase();
    rootQuotationId = existing.rootQuotationId || existing.id;
    version = (existing.version||1) + 1;
    previousVersionId = existing.id;
    quoteNumber = generateQuoteNumber(code, s.quotationDate);
    createdAt = new Date().toISOString(); createdBy = CURRENT_USER.name;
  } else {
    id = 'QT' + Math.random().toString(36).slice(2,9).toUpperCase();
    rootQuotationId = id; version = 1; previousVersionId = null;
    quoteNumber = generateQuoteNumber(code, s.quotationDate);
    createdAt = new Date().toISOString(); createdBy = CURRENT_USER.name;
  }

  const notesList = s.notesOverride || (quotationDefaults().notes[QC_STATE.quotationType]||[]);
  const finalNotes = s.clientNote ? [...notesList, { key:'clientNote', title:'Client-Specific Note', text:s.clientNote }] : notesList;

  const quotation = {
    id, quoteNumber, rootQuotationId, version, previousVersionId,
    leadId: s.leadId, projectCode: s.projectCode || null,
    clientName: s.clientName, businessName: s.businessName, phone: s.phone, telegram: s.telegram,
    industry: s.industry, interestedService: s.interestedService,
    packageKey: s.packageKey, packageName: svc ? svc.name : s.packageKey,
    quotationType: quotationTypeForProjectType(s.packageKey),
    assignedSales: s.assignedSales,
    currency:'USD',
    domainName: s.domainName, domainCost: s.domainCost, domainIncluded: s.domainIncluded, domainRenewalEstimate: s.domainRenewalEstimate,
    year1Total, year2Total: s.year2Total!=null?Number(s.year2Total):(svc?svc.year2Price:null),
    year3Total: s.year3Total!=null?Number(s.year3Total):(svc?svc.year3Price:null),
    discountPct: isFounder() ? (Number(s.discountPct)||0) : 0,
    manualAdjustment: (isFounder() && s.adjustment) ? { amount:Number(s.adjustment), reason:s.adjustmentReason } : null,
    paymentPreset: s.paymentPreset, quotationDate: s.quotationDate, validUntil: s.validUntil,
    demoLink: s.demoLink,
    items: activeItems.map(i=>({ id:i.id, module:i.module, name:i.name, price:i.price, founderReviewRequired:i.founderReviewRequired })),
    exclusions: s.exclusions, importantNotes: finalNotes, paymentSchedule: schedule,
    reasons: evalRes.reasons,
    status: (existing && existing.status==='Draft') ? existing.status : 'Draft',
    approvalStatus: evalRes.approvalStatus,
    createdBy, approvedBy: existing ? existing.approvedBy : null,
    createdAt,
  };

  DB.upsert('quotations', quotation);

  if(isNewRevision){
    existing.status = 'Superseded';
    DB.upsert('quotations', existing);
    logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId: quotation.id, refLabel:`${quotation.quoteNumber} — ${quotation.businessName}`,
      type:'Quotation Superseded', description:`${CURRENT_USER.name} created revision v${version} of ${existing.quoteNumber} — the previous version is now Superseded.`,
      fromValue: existing.quoteNumber, toValue: quotation.quoteNumber });
  }

  logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId: quotation.id, refLabel:`${quotation.quoteNumber} — ${quotation.businessName}`,
    type: (s.editingId && !isNewRevision) ? 'Quotation Updated' : 'Quotation Created',
    description: `${CURRENT_USER.name} ${(s.editingId && !isNewRevision)?'updated':(isNewRevision?'created revision v'+version+' of':'created')} quotation ${quotation.quoteNumber}. Year 1 Total: ${evalRes.priceIsTBC?'TBC':money(evalRes.finalPrice)}.`,
    remark: evalRes.requiresFounderReview ? 'Founder review required.' : null });

  toast(`Quotation ${quotation.quoteNumber} saved as Draft.`, 'success');
  closeModal();
  if(currentRoute()==='quotations'){ renderQuotSummaryCards(); renderQuotTable(); }
  openQuotationDetailModal(quotation.id);
}

function loadStateFromQuotation(q, { asDuplicate=false } = {}){
  return {
    sourceType: q.leadId ? 'lead' : 'new', leadId: q.leadId, projectCode: q.projectCode,
    clientName: q.clientName, businessName: q.businessName, phone: q.phone, telegram: q.telegram,
    industry: q.industry, interestedService: q.interestedService,
    assignedSales: q.assignedSales, packageKey: q.packageKey, quotationType: q.quotationType,
    discountPct: q.discountPct||0, adjustment: q.manualAdjustment?q.manualAdjustment.amount:0, adjustmentReason: q.manualAdjustment?q.manualAdjustment.reason:'',
    items: (q.items||[]).map(i=>({...i, included:true})), exclusions: [...(q.exclusions||[])],
    notesOverride: q.importantNotes && q.importantNotes.length ? q.importantNotes.filter(n=>n.key!=='clientNote') : null,
    clientNote:'',
    domainName: q.domainName, domainCost: q.domainCost, domainIncluded: q.domainIncluded, domainRenewalEstimate: q.domainRenewalEstimate,
    year1Total: null, year2Total: q.year2Total, year3Total: q.year3Total,
    paymentPreset: q.paymentPreset||'30/70', customStages:null,
    quotationDate: asDuplicate ? todayLocalISO() : q.quotationDate,
    validUntil: asDuplicate ? daysFromNow(quotationDefaults().validityDays) : q.validUntil,
    demoLink: q.demoLink||'',
    editingId: asDuplicate ? null : q.id,
  };
}

/* ---------------------------------------------------------------------- */
/* Quotation detail / actions / status workflow                           */
/* ---------------------------------------------------------------------- */

function versionHistoryFor(q){
  const chain = [];
  let cur = q;
  while(cur){
    chain.unshift(cur);
    cur = cur.previousVersionId ? DB.find('quotations', cur.previousVersionId) : null;
  }
  // also append any known newer versions
  let next = DB.all('quotations').find(x=>x.previousVersionId===q.id);
  let tail = [];
  while(next){ tail.push(next); next = DB.all('quotations').find(x=>x.previousVersionId===next.id); }
  return [...chain, ...tail];
}

function openQuotationDetailModal(id){
  const q = DB.find('quotations', id);
  if(!q){ toast('Quotation not found.', 'error'); return; }
  const acts = activitiesFor(id);
  const displayStatus = quotationDisplayStatus(q);
  const withinAuthority = q.approvalStatus==='Sales Approved' || q.approvalStatus==='Founder Approved';
  const history = versionHistoryFor(q);
  const linkedProject = q.projectCode ? DB.find('projects', q.projectCode) : null;

  const html = `
    <div class="modal-head">
      <div><h3>${q.quoteNumber}</h3><div class="text-muted" style="font-size:12px;margin-top:2px">${escapeHtml(q.clientName)} — ${escapeHtml(q.businessName)} · v${q.version||1}</div></div>
      <button class="modal-close" id="qdClose">&times;</button>
    </div>
    <div class="modal-body">
      <div class="flex-row" style="justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:10px">
        <div class="flex-row" style="gap:8px;flex-wrap:wrap">${statusBadge(displayStatus)}${q.approvalStatus?statusBadge(q.approvalStatus):''}</div>
        <div class="flex-row" style="flex-wrap:wrap;gap:8px" id="qdActions"></div>
      </div>
      ${q.reasons && q.reasons.length ? authorityBannerHtml({ requiresFounderReview: q.approvalStatus==='Founder Review Required', reasons:q.reasons, priceIsTBC:q.priceIsTBC, finalPrice:q.year1Total }) : ''}

      <div class="two-col" style="margin-top:14px">
        <div>
          ${infoRow('Client', q.clientName)}
          ${infoRow('Business', q.businessName)}
          ${infoRow('Industry', q.industry)}
          ${infoRow('Package', q.packageName)}
          ${infoRow('Project Code', q.projectCode||'—')}
        </div>
        <div>
          ${infoRow('Assigned Sales', q.assignedSales)}
          ${infoRow('Quotation Date', fmtDate(q.quotationDate))}
          ${infoRow('Valid Until', fmtDate(q.validUntil))}
          ${infoRow('Linked', q.projectCode ? 'Project '+q.projectCode : (q.leadId ? 'Lead '+q.leadId : 'Direct client (no lead)'))}
        </div>
      </div>

      <div class="divider"></div>
      <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">Scope of Work</div>
      <div class="table-wrap scroll-x">
        <table class="data-table">
          <thead><tr><th>Module</th><th>Item</th><th>Price</th></tr></thead>
          <tbody>${(q.items||[]).map(it=>`<tr><td>${escapeHtml(it.module)}</td><td>${escapeHtml(it.name)}</td><td>${it.price===null||it.price===undefined?'TBC':money(it.price)}</td></tr>`).join('')}</tbody>
        </table>
      </div>

      <div class="divider"></div>
      <div class="two-col">
        <div>
          ${infoRow('Year 1 Total', q.priceIsTBC?'TBC':money(q.year1Total))}
          ${infoRow('Year 2 Renewal', money(q.year2Total)+'/yr')}
          ${infoRow('Year 3 Renewal', money(q.year3Total)+'/yr')}
        </div>
        <div>
          ${infoRow('Discount', (q.discountPct||0)+'%')}
          ${q.manualAdjustment ? infoRow('Price Adjustment', money(q.manualAdjustment.amount)+' — '+escapeHtml(q.manualAdjustment.reason)) : ''}
        </div>
      </div>

      ${history.length>1 ? `
      <div class="divider"></div>
      <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">Version History (${history.length})</div>
      ${history.map(v=>`<div class="mini-row" style="cursor:pointer" data-hist="${v.id}"><div class="mini-main"><div class="mini-title">v${v.version} — ${v.quoteNumber}</div><div class="mini-sub">${fmtDateTime(v.createdAt)}</div></div><div class="mini-right">${statusBadge(v.id===q.id?displayStatus:v.status)}</div></div>`).join('')}
      ` : ''}

      ${linkedProject ? `<div class="divider"></div><div class="mini-row"><div class="mini-main"><div class="mini-title">Converted to Project ${linkedProject.id}</div></div></div>` : ''}

      <div class="divider"></div>
      <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">Activity History (${acts.length})</div>
      ${acts.length ? acts.map(a=>`<div class="mini-row"><div class="mini-main"><div class="mini-title"><b>${escapeHtml(a.userName)}</b> — ${escapeHtml(a.type)}</div><div class="mini-sub">${escapeHtml(a.description)}</div></div><div class="mini-right">${fmtDateTime(a.at)}</div></div>`).join('') : `<div class="empty-row">No activity yet.</div>`}
    </div>
    <div class="modal-foot"><button class="btn btn-secondary" id="qdClose2">Close</button></div>
  `;

  openModal(html, { large:true, onMount:(overlay)=>{
    overlay.querySelector('#qdClose').onclick = closeModal;
    overlay.querySelector('#qdClose2').onclick = closeModal;
    overlay.querySelectorAll('[data-hist]').forEach(x=> x.onclick = ()=> openQuotationDetailModal(x.dataset.hist));

    const actionsEl = overlay.querySelector('#qdActions');
    const btns = [];
    btns.push(`<button class="btn btn-outline btn-sm" id="qaPreview">Preview</button>`);
    btns.push(`<button class="btn btn-outline btn-sm" id="qaPdf">Download PDF</button>`);

    if(q.status==='Draft'){
      btns.push(`<button class="btn btn-ghost btn-sm" id="qaEdit">Edit</button>`);
      if(withinAuthority) btns.push(`<button class="btn btn-primary btn-sm" id="qaSend">Mark as Sent</button>`);
      else btns.push(`<button class="btn btn-primary btn-sm" id="qaSubmit">Submit for Approval</button>`);
    }
    if(q.status==='Awaiting Approval' && isFounder()){
      btns.push(`<button class="btn btn-primary btn-sm" id="qaApprove">Approve</button>`);
      btns.push(`<button class="btn btn-danger btn-sm" id="qaReject">Reject</button>`);
    }
    if(q.status==='Approved'){
      btns.push(`<button class="btn btn-primary btn-sm" id="qaSend">Mark as Sent</button>`);
    }
    if(q.status==='Sent'){
      btns.push(`<button class="btn btn-ghost btn-sm" id="qaEdit">Edit (new revision)</button>`);
      btns.push(`<button class="btn btn-primary btn-sm" id="qaAccept">Mark as Accepted</button>`);
      btns.push(`<button class="btn btn-ghost btn-sm" id="qaReject2">Mark as Rejected</button>`);
    }
    if(q.status==='Accepted' && !linkedProject){
      btns.push(`<button class="btn btn-primary btn-sm" id="qaConvert">Convert to Project</button>`);
    }
    actionsEl.innerHTML = btns.join('');

    overlay.querySelector('#qaPreview').onclick = ()=> openQuotationPreview(q.id);
    overlay.querySelector('#qaPdf').onclick = ()=> openQuotationPreview(q.id, true);
    const editBtn = overlay.querySelector('#qaEdit');
    if(editBtn) editBtn.onclick = ()=>{ QC_STATE = loadStateFromQuotation(q); QC_STATE.projectCode = q.projectCode; QC_TAB='edit'; renderCreateQuotationModal(); };
    const submitBtn = overlay.querySelector('#qaSubmit');
    if(submitBtn) submitBtn.onclick = ()=> submitForApproval(q.id);
    const sendBtn = overlay.querySelector('#qaSend');
    if(sendBtn) sendBtn.onclick = ()=> markAsSent(q.id);
    const approveBtn = overlay.querySelector('#qaApprove');
    if(approveBtn) approveBtn.onclick = ()=> openFounderReviewModal(q.id, 'approve');
    const rejectBtn = overlay.querySelector('#qaReject');
    if(rejectBtn) rejectBtn.onclick = ()=> openFounderReviewModal(q.id, 'reject');
    const reject2Btn = overlay.querySelector('#qaReject2');
    if(reject2Btn) reject2Btn.onclick = ()=> openFounderReviewModal(q.id, 'reject');
    const acceptBtn = overlay.querySelector('#qaAccept');
    if(acceptBtn) acceptBtn.onclick = ()=> markAsAccepted(q.id);
    const convertBtn = overlay.querySelector('#qaConvert');
    if(convertBtn) convertBtn.onclick = ()=> convertQuotationToProject(q.id);
  }});
}

function submitForApproval(id){
  const q = DB.find('quotations', id);
  q.status = 'Awaiting Approval';
  DB.upsert('quotations', q);
  logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId:q.id, refLabel:`${q.quoteNumber} — ${q.businessName}`,
    type:'Quotation Submitted for Approval', description:`${CURRENT_USER.name} submitted quotation ${q.quoteNumber} for Founder approval.`,
    fromValue:'Draft', toValue:'Awaiting Approval' });
  toast('Submitted for Founder approval.', 'success');
  openQuotationDetailModal(id);
  if(currentRoute()==='quotations'){ renderQuotSummaryCards(); renderQuotTable(); }
}

function markAsSent(id){
  const q = DB.find('quotations', id);
  q.status = 'Sent';
  DB.upsert('quotations', q);
  logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId:q.id, refLabel:`${q.quoteNumber} — ${q.businessName}`,
    type:'Quotation Sent', description:`${CURRENT_USER.name} sent quotation ${q.quoteNumber} / Year 1 Total: ${q.priceIsTBC?'TBC':money(q.year1Total)}`,
    toValue:'Sent' });
  toast('Quotation marked as sent.', 'success');
  openQuotationDetailModal(id);
  if(currentRoute()==='quotations'){ renderQuotSummaryCards(); renderQuotTable(); }
}

function openFounderReviewModal(id, mode){
  const q = DB.find('quotations', id);
  const titles = { approve:'Approve Quotation', reject:'Reject Quotation' };
  const html = `
    <div class="modal-head"><h3>${titles[mode]}</h3><button class="modal-close" id="frClose">&times;</button></div>
    <div class="modal-body">
      <p class="text-muted" style="margin-top:0;font-size:13px">${q.quoteNumber} — ${escapeHtml(q.businessName)}</p>
      ${mode==='approve' ? `<div class="form-field" style="margin-bottom:12px"><label>Edit Year 1 Total (optional)</label><input type="number" id="fr_price" value="${q.priceIsTBC?'':q.year1Total}" placeholder="Leave blank to approve as quoted"></div>` : ''}
      <div class="form-field"><label class="required">Review Note</label><textarea id="fr_comment" placeholder='e.g. "Price approved at $899." or "Rejected — scope needs revision."'></textarea></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="frCancel">Cancel</button>
      <button class="btn ${mode==='reject'?'btn-danger':'btn-primary'}" id="frSave">${mode==='approve'?'Approve':'Reject'}</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#frClose').onclick = closeModal;
    overlay.querySelector('#frCancel').onclick = closeModal;
    overlay.querySelector('#frSave').onclick = ()=>{
      const comment = overlay.querySelector('#fr_comment').value.trim();
      if(!comment){ toast('A review note is required.', 'error'); return; }
      const priceInput = overlay.querySelector('#fr_price');
      if(mode==='approve'){
        if(priceInput && priceInput.value){ q.year1Total = Number(priceInput.value); q.priceIsTBC = false; }
        q.approvalStatus = 'Founder Approved';
        q.status = 'Approved';
        q.approvedBy = CURRENT_USER.name;
        DB.upsert('quotations', q);
        logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId:q.id, refLabel:`${q.quoteNumber} — ${q.businessName}`,
          type:'Quotation Approved', description:`${CURRENT_USER.name} approved quotation ${q.quoteNumber} at ${money(q.year1Total)}.`,
          fromValue:'Awaiting Approval', toValue:'Approved', remark: comment });
      } else {
        q.approvalStatus = 'Founder Rejected';
        q.status = 'Rejected';
        DB.upsert('quotations', q);
        logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId:q.id, refLabel:`${q.quoteNumber} — ${q.businessName}`,
          type:'Quotation Rejected', description:`${CURRENT_USER.name} rejected quotation ${q.quoteNumber}.`,
          fromValue: q.status, toValue:'Rejected', remark: comment });
      }
      closeModal();
      toast('Saved.', 'success');
      openQuotationDetailModal(id);
      if(currentRoute()==='quotations'){ renderQuotSummaryCards(); renderQuotTable(); }
    };
  }});
}

/* ---------------------------------------------------------------------- */
/* Accepted -> Convert to Project                                         */
/* ---------------------------------------------------------------------- */

function markAsAccepted(id){
  const q = DB.find('quotations', id);
  q.status = 'Accepted';
  DB.upsert('quotations', q);
  logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId:q.id, refLabel:`${q.quoteNumber} — ${q.businessName}`,
    type:'Quotation Accepted', description:`${CURRENT_USER.name} marked quotation ${q.quoteNumber} as Accepted. Value: ${money(q.year1Total)}.`,
    toValue:'Accepted' });

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
  toast('Quotation accepted.', 'success');
  openQuotationDetailModal(id);
  if(currentRoute()==='quotations'){ renderQuotSummaryCards(); renderQuotTable(); }
}

function convertQuotationToProject(id){
  const q = DB.find('quotations', id);
  const lead = q.leadId ? DB.find('leads', q.leadId) : null;
  const linkedExisting = q.projectCode ? DB.find('projects', q.projectCode) : (lead && lead.projectCode ? DB.find('projects', lead.projectCode) : null);

  const groups = {};
  (q.items||[]).forEach(it=>{
    if(!groups[it.module]) groups[it.module] = { id: fnId(), module: it.module, functions: [] };
    groups[it.module].functions.push({ id: fnId(), name: it.name, status:'Confirmed' });
  });

  if(linkedExisting){
    linkedExisting.confirmedValue = q.year1Total || linkedExisting.confirmedValue || 0;
    linkedExisting.quotationRef = q.quoteNumber;
    linkedExisting.functions = Object.values(groups);
    DB.upsert('projects', linkedExisting);
    q.projectCode = linkedExisting.id;
    DB.upsert('quotations', q);
    logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId:q.id, refLabel:`${q.quoteNumber} — ${q.businessName}`,
      type:'Quotation Converted to Project', description:`${CURRENT_USER.name} linked quotation ${q.quoteNumber} to existing project ${linkedExisting.id}.`, toValue: linkedExisting.id });
    toast(`Linked to existing project ${linkedExisting.id}.`, 'success');
    openQuotationDetailModal(id);
    return;
  }

  const code = (lead && lead.projectCode) ? lead.projectCode : (q.projectCode || suggestNextProjectCode());
  const proj = createProjectRecord({
    code, lead, confirmedValue: q.year1Total || 0, depositPct:50,
    overrides: {
      clientName: q.clientName, businessName: q.businessName, phone: q.phone,
      industry: q.industry, projectType: q.packageKey, assignedSales: q.assignedSales,
      notes: `Created from quotation ${q.quoteNumber}.`,
    }
  });
  proj.functions = Object.values(groups);
  proj.quotationRef = q.quoteNumber;
  DB.upsert('projects', proj);

  q.projectCode = proj.id;
  DB.upsert('quotations', q);

  logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId:q.id, refLabel:`${q.quoteNumber} — ${q.businessName}`,
    type:'Quotation Converted to Project', description:`${CURRENT_USER.name} converted quotation ${q.quoteNumber} to project ${proj.id}. Confirmed Value: ${money(proj.confirmedValue)}.`,
    toValue: proj.id });
  logActivity({ userName: CURRENT_USER.name, refType:'project', refId: proj.id, refLabel:`${proj.id} — ${proj.businessName}`,
    type:'Project Created', description:`${CURRENT_USER.name} created project ${proj.id} from accepted quotation ${q.quoteNumber}. Confirmed Value: ${money(proj.confirmedValue)}.`,
    toValue:'Confirmed', remark:`Functions copied from ${q.quoteNumber}.` });

  toast(`Project ${proj.id} created from ${q.quoteNumber}.`, 'success');
  closeModal();
  if(typeof openProjectDetailModal==='function') openProjectDetailModal(proj.id);
}

/* ---------------------------------------------------------------------- */
/* Branded bilingual A4 preview + PDF (browser print)                     */
/* ---------------------------------------------------------------------- */

// Adapts the live Create-Quotation form state into a preview-shaped object
// (same shape as a saved quotation) so the preview renderer can be reused
// for both the live edit-preview pane and the saved-quotation preview modal.
function qcStateToPreviewQuotation(s, evalRes, schedule){
  const svc = serviceByProjectType(s.packageKey);
  const notesList = s.notesOverride || (s.packageKey ? (quotationDefaults().notes[quotationTypeForProjectType(s.packageKey)]||[]) : []);
  return {
    quoteNumber: s.packageKey ? qcQuoteNumberPreview() : 'BW-Q-PREVIEW',
    clientName: s.clientName, businessName: s.businessName, industry: s.industry,
    packageName: svc?svc.name:s.packageKey, packageKey: s.packageKey,
    quotationType: s.packageKey ? quotationTypeForProjectType(s.packageKey) : 'website',
    quotationDate: s.quotationDate, validUntil: s.validUntil, demoLink: s.demoLink,
    items: s.items.filter(i=>i.included!==false),
    exclusions: s.exclusions,
    domainName: s.domainName, domainCost: s.domainCost, domainIncluded: s.domainIncluded, domainRenewalEstimate: s.domainRenewalEstimate,
    year1Total: evalRes.finalPrice, priceIsTBC: evalRes.priceIsTBC,
    year2Total: s.year2Total!=null?Number(s.year2Total):(svc?svc.year2Price:null),
    year3Total: s.year3Total!=null?Number(s.year3Total):(svc?svc.year3Price:null),
    paymentSchedule: schedule,
    importantNotes: s.clientNote ? [...notesList, {key:'clientNote',title:'Client-Specific Note',text:s.clientNote}] : notesList,
  };
}

function quotationTitleBlock(quotationType){
  return quotationType==='system'
    ? { khmer:'សំណើតម្លៃប្រព័ន្ធ', english:'SYSTEM QUOTATION' }
    : { khmer:'សំណើតម្លៃគេហទំព័រ', english:'WEBSITE QUOTATION' };
}

// Two-line bilingual table label (Khmer on its own line so Noto Sans Khmer
// gets the extra line-height it needs, English underneath) — used for every
// row of the client-info table. See the .quote-doc-infotable th CSS for the
// per-script font-family split.
function bilingualLabel(khmer, english){
  return `<span class="khmer-label">${khmer}</span><span class="en-label">${escapeHtml(english)}</span>`;
}

function quotationPreviewDocHtml(q){
  const title = quotationTitleBlock(q.quotationType);
  const bank = bankDetails();
  const labels = yearCostLabels(q.quotationType);
  const grouped = {};
  (q.items||[]).forEach(it=>{ if(!grouped[it.module]) grouped[it.module]=[]; grouped[it.module].push(it); });

  return `
    <div class="quote-doc" id="quoteDocPrintable">
      <div class="quote-doc-head">
        <div class="quote-doc-brand"><div class="logo-mark">BW</div><div><strong>BizWeb KH</strong><div class="text-muted" style="font-size:11px">Tel: 017 400 044 | Telegram: @BizWebKH | www.bizwebkh.com</div></div></div>
        <div class="quote-doc-meta">
          <div class="khmer-text" style="font-size:13px;color:var(--blue)">${title.khmer}</div>
          <div><b>${title.english}</b></div>
          <div>Quote No: ${escapeHtml(q.quoteNumber)}</div>
        </div>
      </div>

      <table class="quote-doc-infotable">
        <tr><th>${bilingualLabel('ឈ្មោះអតិថិជន','Client Name')}</th><td>${escapeHtml(q.clientName)}</td></tr>
        <tr><th>${bilingualLabel('ឈ្មោះអាជីវកម្ម','Business Name')}</th><td>${escapeHtml(q.businessName)}</td></tr>
        <tr><th>${bilingualLabel('គម្រោង','Project')}</th><td>${escapeHtml(q.packageName)}${q.industry?' — '+escapeHtml(q.industry):''}</td></tr>
        <tr><th>${bilingualLabel('កាលបរិច្ឆេទ','Date')}</th><td>${fmtDate(q.quotationDate)}</td></tr>
        <tr><th>${bilingualLabel('សុពលភាព','Valid Until')}</th><td>${fmtDate(q.validUntil)}</td></tr>
        ${q.demoLink ? `<tr><th>Demo Preview Link</th><td>${escapeHtml(q.demoLink)}</td></tr>` : ''}
      </table>

      <h4 class="quote-doc-h">Scope of Work</h4>
      ${Object.entries(grouped).map(([module,items])=>`
        <div style="margin-bottom:8px">
          <div style="font-weight:700;font-size:12.5px;color:var(--navy,#0b2545)">${escapeHtml(module)}</div>
          <ul style="margin:4px 0 0;padding-left:18px;font-size:12.5px">${items.map(it=>`<li>${escapeHtml(it.name)}${it.price===null||it.price===undefined?' — TBC':''}</li>`).join('')}</ul>
        </div>
      `).join('') || `<p class="text-muted" style="font-size:12.5px">Select a package to load scope.</p>`}

      <h4 class="quote-doc-h">Year-by-Year Budget</h4>
      <table class="quote-doc-table">
        <thead><tr><th>Year</th><th>Details</th><th>Amount</th></tr></thead>
        <tbody>
          <tr><td>Year 1</td><td>${escapeHtml(labels.y1)}</td><td>${q.priceIsTBC?'TBC':money(q.year1Total)}</td></tr>
          <tr><td>Year 2</td><td>${escapeHtml(labels.y2)}</td><td>${q.year2Total!=null?'~'+money(q.year2Total)+'/year':'TBC'}</td></tr>
          <tr><td>Year 3</td><td>${escapeHtml(labels.y3)}</td><td>${q.year3Total!=null?'~'+money(q.year3Total)+'/year':'TBC'}</td></tr>
        </tbody>
      </table>

      ${q.domainName || q.domainCost!=null ? `
      <h4 class="quote-doc-h">Domain</h4>
      <p style="font-size:12.5px;margin:0">${q.domainName?escapeHtml(q.domainName)+' — ':''}${q.domainIncluded?'included in Year 1':'not included'} (est. ${money(q.domainCost)}); renewal est. ${money(q.domainRenewalEstimate)}/year.</p>
      ` : ''}

      <h4 class="quote-doc-h">Payment Schedule</h4>
      <table class="quote-doc-table">
        <thead><tr><th>Stage</th><th>%</th><th>Amount</th></tr></thead>
        <tbody>${(q.paymentSchedule||[]).map(st=>`<tr><td>${escapeHtml(st.label)}</td><td>${st.pct}%</td><td>${money(st.amount)}</td></tr>`).join('')}</tbody>
      </table>

      <div class="quote-doc-bottom">
        <div>
          <h4 class="quote-doc-h">Important Notes</h4>
          <ol style="margin:4px 0 0;padding-left:18px;font-size:11.5px;color:var(--muted)">
            ${(q.importantNotes||[]).map(n=>`<li><b>${escapeHtml(n.title)}:</b> ${escapeHtml(n.text)}</li>`).join('')}
            ${(q.exclusions||[]).length ? `<li><b>Not Included:</b> ${q.exclusions.map(escapeHtml).join(', ')}.</li>` : ''}
          </ol>
        </div>
        <div>
          <h4 class="quote-doc-h">Payment Bank Details</h4>
          <div style="font-size:12px;line-height:1.9">
            <div><b>Account Name:</b> ${escapeHtml(bank.accountName)}</div>
            <div><b>Account Number:</b> ${escapeHtml(bank.accountNumber)}</div>
            <div><b>Bank Name:</b> ${escapeHtml(bank.bankName)}</div>
            ${bank.memo?`<div><b>Memo:</b> ${escapeHtml(bank.memo)}</div>`:''}
            ${bank.qrImageUrl?`<img src="${bank.qrImageUrl}" style="width:90px;margin-top:6px" alt="Payment QR">`:''}
          </div>
        </div>
      </div>

      <div class="quote-doc-accept">
        <div><div class="sig-line"></div><span>Client Signature / Date</span></div>
        <div><div class="sig-line"></div><span>BizWeb KH Representative / Date</span></div>
      </div>
    </div>
  `;
}

function openQuotationPreview(id, autoPrint=false){
  const q = DB.find('quotations', id);
  if(!q) return;
  const html = `
    <div class="modal-head"><h3>Quotation Preview</h3><button class="modal-close" id="qpClose">&times;</button></div>
    <div class="modal-body" style="background:#eef1f6;padding:20px">${quotationPreviewDocHtml(q)}</div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="qpClose2">Close</button>
      <button class="btn btn-primary" id="qpPrint">Download PDF (Print)</button>
    </div>
  `;
  openModal(html, { large:true, onMount:(overlay)=>{
    overlay.querySelector('#qpClose').onclick = closeModal;
    overlay.querySelector('#qpClose2').onclick = closeModal;
    overlay.querySelector('#qpPrint').onclick = printAfterFontsReady;
    // Same font-ready wait as the manual Print button — an auto-triggered
    // print (e.g. the list page's PDF action) is exactly the case most
    // likely to fire before the Khmer webfont has finished loading.
    if(autoPrint) setTimeout(printAfterFontsReady, 200);
  }});
}

/* ---------------------------------------------------------------------- */
/* Small helper for embedding a linked-quotations list inside Lead /       */
/* Project detail tabs (called from leads.js / projects.js)                */
/* ---------------------------------------------------------------------- */

function linkedQuotationsHtml(leadId, projectId){
  const list = DB.all('quotations').filter(q=> q.status!=='Superseded' && ((leadId && q.leadId===leadId) || (projectId && q.projectCode===projectId)));
  return `
    <div class="flex-row" style="justify-content:space-between;margin-bottom:8px">
      <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin:0">Quotations</div>
      <span class="cell-link" style="font-size:12px" data-new-quote="${leadId||''}|${projectId||''}">+ New Quotation</span>
    </div>
    ${list.length ? list.map(q=>`
      <div class="mini-row" data-quote-row="${q.id}" style="cursor:pointer">
        <div class="mini-main"><div class="mini-title">${q.quoteNumber}</div><div class="mini-sub">${q.priceIsTBC?'TBC':money(q.year1Total)} · ${escapeHtml(q.assignedSales)}</div></div>
        <div class="mini-right">${statusBadge(quotationDisplayStatus(q))}</div>
      </div>`).join('') : `<div class="empty-row">No quotations yet.</div>`}
  `;
}
function wireLinkedQuotations(container){
  container.querySelectorAll('[data-quote-row]').forEach(el=> el.onclick = ()=> openQuotationDetailModal(el.dataset.quoteRow));
  const newBtn = container.querySelector('[data-new-quote]');
  if(newBtn) newBtn.onclick = ()=>{
    const [leadId, projectId] = newBtn.dataset.newQuote.split('|');
    if(leadId) openCreateQuotationModal({ sourceType:'lead', leadId });
    else openCreateQuotationModal({ sourceType:'new' });
  };
}
