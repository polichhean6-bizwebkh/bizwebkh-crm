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
              <td><div class="cell-strong">${escapeHtml(q.clientName)}</div>${q.businessName?`<div class="text-muted" style="font-size:11.5px">${escapeHtml(q.businessName)}</div>`:''}</td>
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

// A brand-new quotation defaults Year 1 Maintenance to Included/Free ($0) —
// the friendly, common case per the spec's own example ("Free Maintenance —
// 1 Year, Cost = $0"). Editing an EXISTING quotation instead defaults to
// 'not_included' (see loadStateFromQuotation) whenever the saved record has
// no `maintenance` object at all, so opening an old quotation created
// before this feature existed never silently adds new maintenance wording/
// terms to it (spec §16: never overwrite old quotation terms).
function defaultMaintenanceState(){
  return { year1Mode:'included', year1Cost:0, year2Cost:0, year3Cost:0, year2DisplayMode:'estimated', year3DisplayMode:'estimated' };
}

/* ---------------------------------------------------------------------- */
/* Annual Cost Breakdown — the ONE canonical Year 1 / Year 2 / Year 3      */
/* pricing model (Quotations restructure spec). Replaces the old scattered */
/* "Domain & Infrastructure" / "Maintenance & Support" / "Year-by-Year     */
/* Cost" sections with a single consolidated data shape:                   */
/*                                                                          */
/*   annualCost = {                                                        */
/*     year1: { domain, domainMode:'included'|'separate'|'client_own',     */
/*              hosting, hostingIncluded, maintenance, maintenanceMode },   */
/*     year2: { domain, hosting, maintenance, displayMode },                */
/*     year3: { domain, hosting, maintenance, displayMode },                */
/*   }                                                                      */
/*                                                                          */
/* `displayMode`/`maintenanceMode`('included'|'paid'|'not_included') reuse  */
/* the exact same mode strings `qcYearAmountDisplay()`/the legacy           */
/* `maintenance` object already used (spec §27) — nothing new to learn.    */
/*                                                                          */
/* PERSISTENCE — no DB schema/migration was added for this (spec §28: no   */
/* migration/backfill scripts). The canonical `annualCost` object is        */
/* stored as a hidden entry inside the quotation's existing `importantNotes`*/
/* jsonb array (already a free-form per-quotation snapshot column) under a  */
/* reserved key that every render path filters out of the visible notes    */
/* list — see visibleImportantNotes()/ANNUAL_COST_HIDDEN_NOTE_KEYS. A       */
/* legacy-mirror `maintenance` object (+ domainCost/domainIncluded/         */
/* domainRenewalEstimate/year2Total/year3Total) is ALSO still written on    */
/* every save, kept in sync with annualCost, purely so every other existing */
/* consumer (buildQuoteSections' Year 2/3 math, maintenanceWordingNotes(),  */
/* the dashboard/list-table Year 1 Total reads, etc.) keeps working         */
/* completely unchanged — Sales/Founder only ever SEE and edit one set of   */
/* fields (the new Annual Cost Breakdown section); the mirror is invisible  */
/* plumbing, not a second editable source of truth.                        */
/* ---------------------------------------------------------------------- */
const ANNUAL_COST_HIDDEN_NOTE_KEYS = new Set(['__annualCost','__showDetailedBreakdown']);

function defaultAnnualCostState(svc){
  const d = defaultAnnualCostForService(svc);
  return { year1:{...d.year1}, year2:{...d.year2}, year3:{...d.year3} };
}

// Deep-ish clone + shape-guard so a stored/legacy-derived object can never
// crash the form on a missing sub-key (older/partial saves, hand-edited
// fixtures in tests, etc.).
function normalizeAnnualCost(ac){
  const y1 = (ac && ac.year1) || {};
  const y2 = (ac && ac.year2) || {};
  const y3 = (ac && ac.year3) || {};
  return {
    year1: { domain:Number(y1.domain)||0, domainMode: y1.domainMode||'included',
             hosting:Number(y1.hosting)||0, hostingIncluded: y1.hostingIncluded!==false,
             maintenance:Number(y1.maintenance)||0, maintenanceMode: y1.maintenanceMode||'included' },
    year2: { domain:Number(y2.domain)||0, hosting:Number(y2.hosting)||0, maintenance:Number(y2.maintenance)||0, displayMode: y2.displayMode||'estimated' },
    year3: { domain:Number(y3.domain)||0, hosting:Number(y3.hosting)||0, maintenance:Number(y3.maintenance)||0, displayMode: y3.displayMode||'estimated' },
  };
}

function extractAnnualCost(importantNotes){
  const note = (importantNotes||[]).find(n=>n.key==='__annualCost');
  if(!note) return null;
  try{ const parsed = JSON.parse(note.text); return normalizeAnnualCost(parsed); }catch(e){ return null; }
}
function extractShowDetailedBreakdown(importantNotes){
  const note = (importantNotes||[]).find(n=>n.key==='__showDetailedBreakdown');
  return !!(note && note.text==='1');
}
// The two hidden bookkeeping notes appended at save time (see saveQuotationFromState).
function annualCostHiddenNotes(annualCost, showDetailedBreakdown){
  return [
    { key:'__annualCost', title:'', text: JSON.stringify(annualCost) },
    { key:'__showDetailedBreakdown', title:'', text: showDetailedBreakdown ? '1' : '0' },
  ];
}
// Every place that renders `importantNotes` to a human (Create form's H.
// section, the printed document's Important Notes list) must go through
// this — never iterate importantNotes directly — so the hidden Annual Cost
// payload is never accidentally printed as a note.
function visibleImportantNotes(importantNotes){
  return (importantNotes||[]).filter(n=> !ANNUAL_COST_HIDDEN_NOTE_KEYS.has(n.key));
}

// READ-TIME-ONLY legacy migration (spec §28): a quotation saved before this
// feature existed carries none of the hidden notes above — this derives an
// equivalent annualCost shape from its old flat fields
// (domainCost/domainIncluded/domainRenewalEstimate/year2Total/year3Total/
// maintenance), following the exact same precedent as the pre-existing
// `maintenance: q.maintenance || {defaults}` fallback. NEVER writes back to
// the record — purely a display/edit-form convenience so an old quotation
// can be opened in the new Annual Cost Breakdown editor without silently
// losing or renumbering anything it already had.
function annualCostFromLegacy(q){
  const maint = q.maintenance || { year1Mode:'not_included', year1Cost:0, year2Cost:0, year3Cost:0, year2DisplayMode:'estimated', year3DisplayMode:'estimated' };
  return normalizeAnnualCost({
    year1: {
      domain: Number(q.domainCost)||0,
      domainMode: q.domainCost==null ? 'included' : (q.domainIncluded===false ? 'separate' : 'included'),
      hosting: 0, hostingIncluded: true, // legacy quotations never separated hosting out of the base package price
      maintenance: Number(maint.year1Cost)||0, maintenanceMode: maint.year1Mode || 'not_included',
    },
    // Legacy year2Total/year3Total were already a single combined
    // domain+hosting renewal figure — kept whole in `hosting` here (domain
    // left at 0) so re-deriving never double-counts or shifts what a
    // previously-printed document already showed.
    year2: { domain:0, hosting: Number(q.year2Total)||0, maintenance: Number(maint.year2Cost)||0, displayMode: maint.year2DisplayMode||'estimated' },
    year3: { domain:0, hosting: Number(q.year3Total)||0, maintenance: Number(maint.year3Cost)||0, displayMode: maint.year3DisplayMode||'estimated' },
  });
}
// The single entry point the Edit-modal loader uses: prefer the new stored
// model, fall back to deriving one from legacy fields. Never used by
// buildQuoteSections (which needs to tell the two cases apart — see its own
// `extractAnnualCost(q.importantNotes)` call — so an already-printed legacy
// document's numbers never shift).
function resolvedAnnualCost(q){
  return extractAnnualCost(q.importantNotes) || annualCostFromLegacy(q);
}

// Year 1 TOTAL formula (spec §10): Development + scope add-ons + discount/
// adjustment are already exactly what evaluateQuotation()'s `finalPrice`
// computes over the package's base item + scope items — this only adds the
// three NEW Year-1 chargeable components on top. Domain: charged only when
// "Charged Separately" (Included/Client-Own both mean $0 added — the cost,
// if any, is either already inside the base package price or genuinely
// zero for an existing/client-owned domain). Hosting: charged only when NOT
// bundled/included. Maintenance: charged only when NOT Included/Free.
function qcAnnualYear1Charge(y1){
  const domain = y1.domainMode==='separate' ? (Number(y1.domain)||0) : 0;
  const hosting = y1.hostingIncluded ? 0 : (Number(y1.hosting)||0);
  const maintenance = y1.maintenanceMode==='paid' ? (Number(y1.maintenance)||0) : 0;
  return domain + hosting + maintenance;
}
// Year 2/3 TOTAL formula (spec §10): Domain + Hosting/Backend/Database +
// Maintenance — Development is NEVER included again after Year 1.
function qcAnnualYearTotal(yr){
  return (Number(yr.domain)||0) + (Number(yr.hosting)||0) + (Number(yr.maintenance)||0);
}

// The ONE place that turns live Create/Edit form state into every derived
// number the rest of the form/preview/save path needs — called by
// renderCreateQuotationModal, refreshQcPreview AND saveQuotationFromState
// so all three can never drift out of sync with each other (spec §29: "no
// stale totals").
function qcComputeQuoteTotals(s){
  const svc = serviceByProjectType(s.packageKey);
  const activeItems = s.items.filter(i=>i.included!==false).map(i=>({name:i.name, price:i.price, founderReviewRequired:i.founderReviewRequired}));
  const evalRes = evaluateQuotation({
    items: activeItems, basePackage: svc, discountPct: Number(s.discountPct)||0,
    manualAdjustment: s.adjustment ? { amount:Number(s.adjustment), reason:s.adjustmentReason } : null,
    discountLimitPct: effectiveDiscountLimit(svc),
  });
  const annualCost = normalizeAnnualCost(s.annualCost);
  const year1Charge = qcAnnualYear1Charge(annualCost.year1);
  const year1Total = evalRes.priceIsTBC ? null : Math.round((evalRes.finalPrice + year1Charge)*100)/100;
  const year2Total = qcAnnualYearTotal(annualCost.year2);
  const year3Total = qcAnnualYearTotal(annualCost.year3);
  const schedule = computePaymentSchedule(evalRes.priceIsTBC?0:year1Total, s.paymentPreset, s.customStages);
  return { svc, evalRes, annualCost, year1Development: svc?svc.basePrice:0, year1Charge, year1Total, year2Total, year3Total, schedule };
}

// The Year-1 PAYMENT SCHEDULE total, additive-only: the stored/displayed
// scope total (year1ScopeTotal) is never mutated by maintenance — this is
// computed only at the specific points that need a maintenance-inclusive
// number (the payment-schedule split, and the printed Year 1 Amount cell),
// keeping `year1Total` itself pure scope/hosting everywhere else (dashboard
// KPIs, lead.quotationAmount, the quotations list-table Amount column).
function qcYear1PaymentTotal(maintenance, year1ScopeTotal){
  const m = maintenance || {};
  const scope = Number(year1ScopeTotal) || 0;
  const addOn = (m.year1Mode==='paid') ? (Number(m.year1Cost)||0) : 0;
  return scope + addOn;
}

// Formats a Year 2/3 renewal amount per its display mode (spec §3) — never
// forces a single fixed renewal total onto every quotation.
function qcYearAmountDisplay(amount, mode){
  if(mode==='tbc') return 'To be confirmed';
  const amt = Number(amount)||0;
  if(mode==='exact') return money(amt)+'/year';
  return '~'+money(amt)+'/year'; // 'estimated' (default)
}

// The two maintenance wording notes (spec §14) — regenerated fresh from the
// live maintenance state every time (never stored as static text), and only
// added when maintenance was actually mentioned on this quotation at all.
function maintenanceWordingNotes(maintenance){
  const m = maintenance;
  if(!m || m.year1Mode==='not_included') return [];
  const notes = [
    { key:'maintenanceY1', title:'Year 1 Maintenance', text: m.year1Mode==='included'
        ? 'Basic maintenance and support included for Year 1.'
        : `Year 1 maintenance is billed separately at ${money(Number(m.year1Cost)||0)}. Standard maintenance covers minor bug fixes, basic CMS/admin guidance, and small support within the existing scope — it does not include new features, major redesign, new integrations, or major workflow changes.` },
    { key:'maintenanceRenewal', title:'Maintenance Renewal', text:'Annual maintenance and support is billed separately from Year 2 onward at the quoted/confirmed annual rate. Standard maintenance covers minor bug fixes, basic CMS/admin guidance, and small support within the existing scope — it does not include new features, major redesign, new integrations, or major workflow changes.' },
  ];
  return notes;
}

// Non-destructive display filter for spec §15: hides a standard exclusion
// from the PRINTED/displayed list when a currently-active scope item's name
// clearly overlaps with it (e.g. "Online Payment" added to scope hides
// "Online payment gateway" from Not Included) — the underlying stored
// `exclusions` array is never mutated, so toggling the scope item back off
// instantly restores the exclusion with zero data-loss risk.
const EXCLUSION_FILTER_STOPWORDS = new Set(['the','and','for','with','from','this','that','system','management','support','service','services']);
function significantWords(text){
  return String(text||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w=>w.length>=5 && !EXCLUSION_FILTER_STOPWORDS.has(w));
}
function activeScopeMentionsExclusion(items, exclusionText){
  const exWords = significantWords(exclusionText);
  if(!exWords.length) return false;
  const scopeWords = new Set();
  (items||[]).forEach(it=> significantWords(it.name).forEach(w=>scopeWords.add(w)));
  return exWords.some(w=>scopeWords.has(w));
}
function visibleExclusions(items, exclusions){
  return (exclusions||[]).filter(x=>!activeScopeMentionsExclusion(items, x));
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
    domainName:'',
    // Annual Cost Breakdown (spec §D) — the ONE editable source of Year 1/2/3
    // pricing; `maintenance` below is kept only as an internal legacy mirror
    // (see the big comment above defaultAnnualCostState) never shown as its
    // own form section any more.
    annualCost: defaultAnnualCostState(null),
    showDetailedBreakdown: false,
    maintenance: defaultMaintenanceState(),
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
  // Package selection also drives the Annual Cost Breakdown's default
  // numbers (spec §16: "Package selection controls ... default yearly
  // costs") — same reset-on-package-change convention already used for
  // items/exclusions below, so switching packages never leaves stale
  // numbers from a different package's pricing shape behind.
  QC_STATE.annualCost = defaultAnnualCostState(svc);
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
  // A handful of edits still require a full remount (package change, item
  // include/remove, Add Scope Item, discount/adjustment, payment preset,
  // quotation date) rather than the lighter refreshQcPreview path. A full
  // remount would otherwise always jump the left panel back to its top
  // (spec §12) — captured here and restored after the new DOM mounts so
  // the user's place in a long form is never lost.
  const prevOverlay = document.getElementById('activeModalOverlay');
  const prevScrollTop = prevOverlay ? (prevOverlay.querySelector('.qc-edit-col')||{}).scrollTop : null;

  const s = QC_STATE;
  const svc = serviceByProjectType(s.packageKey);
  const activeItems = s.items.filter(i=>i.included!==false).map(i=>({name:i.name, price:i.price, founderReviewRequired:i.founderReviewRequired}));
  const evalRes = evaluateQuotation({
    items: activeItems, basePackage: svc, discountPct: Number(s.discountPct)||0,
    manualAdjustment: s.adjustment ? { amount:Number(s.adjustment), reason:s.adjustmentReason } : null,
    discountLimitPct: effectiveDiscountLimit(svc),
  });
  const totals = qcComputeQuoteTotals(s);
  const schedule = totals.schedule;
  const qd = quotationDefaults();

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
            <div class="form-field"><label class="required">Client Name</label><input id="cq_clientName" value="${escapeHtml(s.clientName)}" ${s.sourceType!=='new'?'readonly class="field-locked"':''}></div>
            <div class="form-field"><label>Business Name <span class="text-muted" style="font-weight:400">(optional)</span></label><input id="cq_businessName" value="${escapeHtml(s.businessName)}" placeholder="Leave blank if the client has no business/trade name" ${s.sourceType!=='new'?'readonly class="field-locked"':''}></div>
            <div class="form-field"><label>Phone</label><input id="cq_phone" value="${escapeHtml(s.phone)}" ${s.sourceType!=='new'?'readonly class="field-locked"':''}></div>
            <div class="form-field"><label>Telegram</label><input id="cq_telegram" value="${escapeHtml(s.telegram)}"></div>
            <div class="form-field"><label class="required">Industry</label>
              <select id="cq_industry" class="sel" ${s.sourceType!=='new'?'disabled':''}>${INDUSTRIES.map(i=>`<option ${s.industry===i?'selected':''}>${i}</option>`).join('')}</select>
            </div>
            <div class="form-field"><label class="required">Assigned Sales</label>
              ${canChooseAssignedSales(CURRENT_USER.role)
                ? `<select id="cq_sales" class="sel">${salesOwnersList().map(n=>`<option ${s.assignedSales===n?'selected':''}>${n}</option>`).join('')}</select>`
                : `<input value="${escapeHtml(s.assignedSales)}" readonly class="field-locked">`}
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
            <div class="form-field"><label>Project Code <span class="field-auto-badge">Auto</span></label><input value="${escapeHtml(s.projectCode||'Assigned when quotation is sent to a Pipeline project')}" readonly></div>
            <div class="form-field"><label>Quote No. (preview) <span class="field-auto-badge">Auto</span></label><input value="${s.packageKey?qcQuoteNumberPreview():'—'}" readonly></div>
            <div class="form-field"><label class="required">Quotation Date</label><input type="date" id="cq_qdate" value="${s.quotationDate}" ${isFounder()?'':'readonly class="field-locked"'}></div>
            <div class="form-field"><label class="required">Valid Until</label><input type="date" id="cq_validUntil" value="${s.validUntil}" ${isFounder()?'':'readonly class="field-locked"'}></div>
            <div class="form-field full"><label>Demo Link</label><input id="cq_demoLink" value="${escapeHtml(s.demoLink)}" placeholder="https://..."></div>
          </div>

          <div class="divider"></div>
          <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">C. Scope of Work / Functions</div>
          <div id="cq_itemsWrap">${quotationItemsEditorHtml(s.items)}</div>
          <button class="btn btn-outline btn-sm" id="cq_addFn" style="margin:8px 0 16px">+ Add Scope Item</button>
          <div class="text-muted" style="font-size:12px;margin:-8px 0 14px">Standard exclusions for this package (Founder/Admin-editable in Settings → Quotations):</div>
          <ul style="margin:-8px 0 16px;padding-left:18px;font-size:12.5px;color:var(--muted)">${visibleExclusions(s.items.filter(i=>i.included!==false), s.exclusions).map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul>

          <div class="divider"></div>
          <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">D. Annual Cost Breakdown</div>
          <div class="form-field" style="margin-bottom:10px"><label>Domain Name</label><input id="cq_domainName" value="${escapeHtml(s.domainName)}" placeholder="e.g. example.com"></div>
          ${annualCostBreakdownHtml(s, totals.svc, totals)}

          <div class="divider"></div>
          <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">E. Payment Schedule</div>
          <div class="form-field" style="margin-bottom:12px">
            <label>Preset</label>
            <select id="cq_paymentPreset" class="sel">
              ${['30/70','30/30/40','20/40/40','50/50','Custom'].map(p=>`<option value="${p}" ${s.paymentPreset===p?'selected':''}>${p}</option>`).join('')}
            </select>
          </div>
          <div class="table-wrap scroll-x">
            <table class="data-table qc-mini-table"><thead><tr><th>Stage</th><th>%</th><th>Amount</th></tr></thead>
            <tbody>${schedule.map(st=>`<tr><td>${escapeHtml(st.label)}</td><td>${st.pct}%</td><td>${money(st.amount)}</td></tr>`).join('')}</tbody></table>
          </div>
          <p class="text-muted" style="font-size:11.5px;margin:6px 0 16px">Stages always sum exactly to the Year 1 Total (${totals.evalRes.priceIsTBC?'TBC':money(totals.year1Total)}) and auto-update whenever any Year 1 cost above changes.</p>

          <div class="divider"></div>
          <div class="section-title" style="font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">F. Notes</div>
          <div class="mini-row"><div class="mini-main"><div class="mini-title">Standard Notes Applied ✓</div><div class="mini-sub">${(s.packageKey?(quotationDefaults().notes[quotationTypeForProjectType(s.packageKey)]||[]).length:0)} standard note(s) for this quotation type will print automatically — managed in Settings → Quotations.</div></div></div>
          <div class="form-field" style="margin:10px 0 16px"><label>Client-Specific Note (optional)</label><textarea id="cq_clientNote" placeholder="Anything specific to this client — never overrides the standard notes above.">${escapeHtml(s.clientNote)}</textarea></div>

          <div class="divider"></div>
          <div class="qc-collapsible-head ${s._showAdjustments?'open':''}" id="cq_toggleAdjustments">
            <span class="car">▸</span> Founder/Admin Pricing Adjustment
          </div>
          ${isFounder() ? `
          <div id="cq_adjustmentsBody" ${s._showAdjustments?'':'hidden'} style="margin-top:10px">
            <div class="form-grid">
              <div class="form-field"><label>Discount %</label><input type="number" id="cq_discount" value="${s.discountPct}" min="0" max="100"></div>
              <div class="form-field"><label>Manual Price Adjustment ($)</label><input type="number" id="cq_adjust" value="${s.adjustment}"></div>
              <div class="form-field full"><label>Reason for Price Adjustment ${s.adjustment?'<span class="required"></span>':'(required if adjusting)'}</label><input id="cq_adjustReason" value="${escapeHtml(s.adjustmentReason)}" placeholder='e.g. "Client already has hosting."'></div>
            </div>
          </div>` : `<div id="cq_adjustmentsBody" ${s._showAdjustments?'':'hidden'} style="margin-top:10px"><input value="Discount 0% — not permitted for your role" readonly class="field-locked"></div>`}

          <div id="cq_authorityBanner">${authorityBannerHtml({...totals.evalRes, finalPrice: totals.year1Total})}</div>
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
              <div id="cq_livePreview"><div class="quote-doc-loading">Rendering preview…</div></div>
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
    const editCol = overlay.querySelector('.qc-edit-col');
    if(editCol && prevScrollTop!=null) editCol.scrollTop = prevScrollTop;
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
    const livePreviewEl = overlay.querySelector('#cq_livePreview');
    if(livePreviewEl) paintQuotePreview(livePreviewEl, qcStateToPreviewQuotation(s, evalRes, schedule), ()=>qcApplyZoom(overlay));

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

    // Annual Cost Breakdown wiring (spec §D) — every Year 1/2/3 field routes
    // through refreshQcPreview (never a full remount) so editing costs never
    // disturbs left-panel scroll position or preview zoom (spec §12/§13).
    // The only fields that need a remount are the ones that change what
    // OTHER fields on screen look like (a mode toggle enabling/disabling a
    // sibling input, or the readonly/locked state of the domain amount).
    const ac = normalizeAnnualCost(s.annualCost);
    s.annualCost = ac;
    const y1Domain = overlay.querySelector('#cq_y1_domain'); if(y1Domain) y1Domain.oninput = e=>{ ac.year1.domain = e.target.value; refreshQcPreview(overlay); };
    const y1DomainMode = overlay.querySelector('#cq_y1_domainMode'); if(y1DomainMode) y1DomainMode.onchange = e=>{ ac.year1.domainMode = e.target.value; renderCreateQuotationModal(); };
    const y1Hosting = overlay.querySelector('#cq_y1_hosting'); if(y1Hosting) y1Hosting.oninput = e=>{ ac.year1.hosting = e.target.value; refreshQcPreview(overlay); };
    const y1HostingInc = overlay.querySelector('#cq_y1_hostingIncluded'); if(y1HostingInc) y1HostingInc.onchange = e=>{ ac.year1.hostingIncluded = e.target.checked; renderCreateQuotationModal(); };
    const y1Maint = overlay.querySelector('#cq_y1_maint'); if(y1Maint) y1Maint.oninput = e=>{ ac.year1.maintenance = e.target.value; refreshQcPreview(overlay); };
    const y1MaintInc = overlay.querySelector('#cq_y1_maintIncluded'); if(y1MaintInc) y1MaintInc.onchange = e=>{ ac.year1.maintenanceMode = e.target.checked?'included':'paid'; renderCreateQuotationModal(); };
    const y2Domain = overlay.querySelector('#cq_y2_domain'); if(y2Domain) y2Domain.oninput = e=>{ ac.year2.domain = e.target.value; refreshQcPreview(overlay); };
    const y2Hosting = overlay.querySelector('#cq_y2_hosting'); if(y2Hosting) y2Hosting.oninput = e=>{ ac.year2.hosting = e.target.value; refreshQcPreview(overlay); };
    const y2Maint = overlay.querySelector('#cq_y2_maint'); if(y2Maint) y2Maint.oninput = e=>{ ac.year2.maintenance = e.target.value; refreshQcPreview(overlay); };
    const y2Disp = overlay.querySelector('#cq_y2_display'); if(y2Disp) y2Disp.onchange = e=>{ ac.year2.displayMode = e.target.value; refreshQcPreview(overlay); };
    const y3Domain = overlay.querySelector('#cq_y3_domain'); if(y3Domain) y3Domain.oninput = e=>{ ac.year3.domain = e.target.value; refreshQcPreview(overlay); };
    const y3Hosting = overlay.querySelector('#cq_y3_hosting'); if(y3Hosting) y3Hosting.oninput = e=>{ ac.year3.hosting = e.target.value; refreshQcPreview(overlay); };
    const y3Maint = overlay.querySelector('#cq_y3_maint'); if(y3Maint) y3Maint.oninput = e=>{ ac.year3.maintenance = e.target.value; refreshQcPreview(overlay); };
    const y3Disp = overlay.querySelector('#cq_y3_display'); if(y3Disp) y3Disp.onchange = e=>{ ac.year3.displayMode = e.target.value; refreshQcPreview(overlay); };
    const showDetailed = overlay.querySelector('#cq_showDetailed'); if(showDetailed) showDetailed.onchange = e=>{ s.showDetailedBreakdown = e.target.checked; refreshQcPreview(overlay); };

    const toggleAdj = overlay.querySelector('#cq_toggleAdjustments');
    if(toggleAdj) toggleAdj.onclick = ()=>{
      s._showAdjustments = !s._showAdjustments;
      toggleAdj.classList.toggle('open', s._showAdjustments);
      const body = overlay.querySelector('#cq_adjustmentsBody');
      if(body) body.hidden = !s._showAdjustments;
    };

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

    overlay.querySelector('#cq_paymentPreset').onchange = e=>{ s.paymentPreset = e.target.value; renderCreateQuotationModal(); };
    overlay.querySelector('#cq_clientNote').oninput = e=>{ s.clientNote = e.target.value; refreshQcPreview(overlay); };

    overlay.querySelector('#cqSave').onclick = ()=> saveQuotationFromState(s);
  }});
}

function refreshQcPreview(overlay){
  const s = QC_STATE;
  const totals = qcComputeQuoteTotals(s);
  overlay.querySelector('#cq_authorityBanner').innerHTML = authorityBannerHtml({...totals.evalRes, finalPrice: totals.year1Total});
  // Keep the three per-year mini totals in the Annual Cost Breakdown panel
  // itself live too (spec §29: "no stale totals") — every other field in
  // that section already routes through this same function.
  const y1TotalEl = overlay.querySelector('.qc-year-block:nth-of-type(1) .qc-year-total');
  if(y1TotalEl) y1TotalEl.textContent = totals.evalRes.priceIsTBC ? 'TBC' : money(totals.year1Total);
  const y2TotalEl = overlay.querySelector('.qc-year-block:nth-of-type(2) .qc-year-total');
  if(y2TotalEl) y2TotalEl.textContent = qcYearAmountDisplay(totals.year2Total, totals.annualCost.year2.displayMode);
  const y3TotalEl = overlay.querySelector('.qc-year-block:nth-of-type(3) .qc-year-total');
  if(y3TotalEl) y3TotalEl.textContent = qcYearAmountDisplay(totals.year3Total, totals.annualCost.year3.displayMode);
  const preview = overlay.querySelector('#cq_livePreview');
  if(preview) paintQuotePreview(preview, qcStateToPreviewQuotation(s, totals.evalRes, totals.schedule), ()=>qcApplyZoom(overlay));
  else qcApplyZoom(overlay);
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

// Opened from INSIDE the Create/Edit Quotation modal — this is always a
// CHILD modal (openChildModal/closeChildModal, its own separate overlay
// stacked on top), never openModal()/closeModal(), specifically so opening
// or cancelling it can never touch, remount, or reset the parent Create
// Quotation modal's DOM, form state, scroll position, or preview zoom
// (spec §6/§7 — this is the actual fix for the reported "Cancel resets
// Create Quotation" bug: the two modals no longer share one overlay).
function openAddQuotationFunctionModal(onPick){
  const html = `
    <div class="modal-head"><h3>Add Scope Item</h3><button class="modal-close" id="afqClose">&times;</button></div>
    <div class="modal-body">
      <div class="form-field" style="margin-bottom:4px">
        <label>A. Add Existing Function</label>
        <select id="afq_pick" class="sel" style="width:100%">
          <option value="">Select a function…</option>
          ${ADDITIONAL_FUNCTIONS_CATALOG.map(a=>`<option value="${a.id}">${escapeHtml(a.name)} — ${a.defaultPrice===null?'TBC (Founder review)':'$'+a.defaultPrice}</option>`).join('')}
        </select>
      </div>
      <div class="flex-row" style="justify-content:center;margin:10px 0"><span class="text-muted" style="font-size:11.5px;font-weight:700;letter-spacing:.4px">OR</span></div>
      <div class="form-field" style="margin-bottom:4px">
        <label>B. Add Custom Function</label>
        <input id="afq_custom" placeholder="Custom item name — e.g. Loyalty points system">
      </div>
      <p class="text-muted" style="font-size:11.5px;margin:8px 0 0">Pick one option — a custom item always requires Founder review (price shows as TBC), matching the spec's advanced-feature warning (OTP, Payment Gateway, Mobile App, Multi-Branch, Advanced API Integration, Custom Workflow, etc.).</p>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="afqCancel">Cancel</button>
      <button class="btn btn-primary" id="afqAdd" disabled>Add</button>
    </div>
  `;
  openChildModal(html, { onMount:(overlay)=>{
    const pickSel = overlay.querySelector('#afq_pick');
    const customInput = overlay.querySelector('#afq_custom');
    const addBtn = overlay.querySelector('#afqAdd');
    // Neither option is required on its own, but they're mutually exclusive:
    // picking a catalog function clears/disables the custom name field and
    // vice versa, and the Add button activates only once exactly one valid
    // option is provided (spec §8).
    const sync = ()=>{
      const hasPick = !!pickSel.value;
      const hasCustom = !!customInput.value.trim();
      customInput.disabled = hasPick;
      pickSel.disabled = hasCustom;
      addBtn.disabled = !(hasPick || hasCustom);
    };
    pickSel.onchange = sync;
    customInput.oninput = sync;
    sync();

    overlay.querySelector('#afqClose').onclick = closeChildModal;
    overlay.querySelector('#afqCancel').onclick = closeChildModal;
    addBtn.onclick = ()=>{
      const pickId = pickSel.value;
      const custom = customInput.value.trim();
      if(pickId){
        const def = ADDITIONAL_FUNCTIONS_CATALOG.find(a=>a.id===pickId);
        closeChildModal(); onPick(def); return;
      }
      if(custom){
        closeChildModal(); onPick({ name: custom, defaultPrice: null, founderReviewRequired: true }); return;
      }
      toast('Pick an item from the catalog, or type a custom one.', 'error');
    };
  }});
}

function quotationItemsEditorHtml(items){
  if(!items.length) return `<div class="empty-row">Select a package to load its included scope items.</div>`;
  return `
    <div class="table-wrap scroll-x">
      <table class="data-table qc-mini-table">
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

// The consolidated "D. Annual Cost Breakdown" section — replaces the old
// "Domain & Infrastructure" / "Maintenance & Support" / "Year-by-Year Cost"
// sections with ONE Year 1 / Year 2 / Year 3 block each (spec §2). Every
// dollar figure here has exactly one home — no duplicate Domain Cost,
// Domain Renewal Estimate, or Maintenance Cost fields anywhere else on the
// form (spec §9).
function annualCostBreakdownHtml(s, svc, totals){
  const hostingLabel = hostingLabelForService(svc);
  const ac = totals.annualCost;
  const y1 = ac.year1, y2 = ac.year2, y3 = ac.year3;
  const y1DomainNote = y1.domainMode==='client_own'
    ? `<div class="text-muted" style="font-size:11px;margin-top:4px">Existing / client-owned domain — no domain cost charged.</div>` : '';
  const y1HostingBadge = y1.hostingIncluded ? `<span class="field-included-badge">Included</span>` : '';
  const y1MaintBadge = y1.maintenanceMode==='included' ? `<span class="field-included-badge">Included / Free</span>` : '';
  return `
    <div class="qc-year-block">
      <div class="qc-year-head"><h4>Year 1</h4><span class="qc-year-total">${totals.evalRes.priceIsTBC?'TBC':money(totals.year1Total)}</span></div>
      <div class="form-grid">
        <div class="form-field"><label>Website / System Development <span class="field-auto-badge">Auto</span></label>
          <input value="${money(totals.year1Development)}" readonly class="field-locked"></div>
        <div class="form-field"><label>Domain ($)</label><input type="number" id="cq_y1_domain" value="${y1.domain}" ${y1.domainMode!=='separate'?'readonly class="field-locked"':''}></div>
        <div class="form-field"><label>Domain Status</label>
          <select id="cq_y1_domainMode" class="sel">
            <option value="included" ${y1.domainMode==='included'?'selected':''}>Included</option>
            <option value="separate" ${y1.domainMode==='separate'?'selected':''}>Charged Separately</option>
            <option value="client_own" ${y1.domainMode==='client_own'?'selected':''}>Client Own Domain</option>
          </select>
          ${y1DomainNote}
        </div>
        <div class="form-field"><label>${escapeHtml(hostingLabel)} ($) ${y1HostingBadge}</label><input type="number" id="cq_y1_hosting" value="${y1.hosting}" ${y1.hostingIncluded?'readonly class="field-locked"':''}></div>
        <div class="form-field"><label>&nbsp;</label>
          <label style="display:flex;align-items:center;gap:6px;font-weight:400;font-size:12.5px;padding-top:8px"><input type="checkbox" id="cq_y1_hostingIncluded" ${y1.hostingIncluded?'checked':''}> Included in package price</label>
        </div>
        <div class="form-field"><label>Maintenance & Support ($) ${y1MaintBadge}</label><input type="number" id="cq_y1_maint" value="${y1.maintenanceMode==='included'?0:y1.maintenance}" ${y1.maintenanceMode==='included'?'readonly class="field-locked"':''}></div>
        <div class="form-field"><label>&nbsp;</label>
          <label style="display:flex;align-items:center;gap:6px;font-weight:400;font-size:12.5px;padding-top:8px"><input type="checkbox" id="cq_y1_maintIncluded" ${y1.maintenanceMode==='included'?'checked':''}> Included / Free</label>
        </div>
      </div>
    </div>

    <div class="qc-year-block">
      <div class="qc-year-head"><h4>Year 2</h4><span class="qc-year-total">${qcYearAmountDisplay(totals.year2Total, y2.displayMode)}</span></div>
      <div class="form-grid">
        <div class="form-field"><label>Domain Renewal ($)</label><input type="number" id="cq_y2_domain" value="${y2.domain}"></div>
        <div class="form-field"><label>${escapeHtml(hostingLabel)} ($)</label><input type="number" id="cq_y2_hosting" value="${y2.hosting}"></div>
        <div class="form-field"><label>Maintenance & Support ($)</label><input type="number" id="cq_y2_maint" value="${y2.maintenance}"></div>
        <div class="form-field"><label>Amount Display</label>
          <select id="cq_y2_display" class="sel">
            <option value="exact" ${y2.displayMode==='exact'?'selected':''}>Exact Amount</option>
            <option value="estimated" ${y2.displayMode==='estimated'?'selected':''}>Estimated Amount</option>
            <option value="tbc" ${y2.displayMode==='tbc'?'selected':''}>To be confirmed</option>
          </select>
        </div>
      </div>
    </div>

    <div class="qc-year-block" style="margin-bottom:6px">
      <div class="qc-year-head"><h4>Year 3</h4><span class="qc-year-total">${qcYearAmountDisplay(totals.year3Total, y3.displayMode)}</span></div>
      <div class="form-grid">
        <div class="form-field"><label>Domain Renewal ($)</label><input type="number" id="cq_y3_domain" value="${y3.domain}"></div>
        <div class="form-field"><label>${escapeHtml(hostingLabel)} ($)</label><input type="number" id="cq_y3_hosting" value="${y3.hosting}"></div>
        <div class="form-field"><label>Maintenance & Support ($)</label><input type="number" id="cq_y3_maint" value="${y3.maintenance}"></div>
        <div class="form-field"><label>Amount Display</label>
          <select id="cq_y3_display" class="sel">
            <option value="exact" ${y3.displayMode==='exact'?'selected':''}>Exact Amount</option>
            <option value="estimated" ${y3.displayMode==='estimated'?'selected':''}>Estimated Amount</option>
            <option value="tbc" ${y3.displayMode==='tbc'?'selected':''}>To be confirmed</option>
          </select>
        </div>
      </div>
    </div>
    <p class="text-muted" style="font-size:11.5px;margin:0 0 6px">Development is a one-time, Year-1-only cost. Year 2 and Year 3 are renewal/support costs only — Development is never charged again.</p>
    ${isFounder() ? `<label style="display:flex;align-items:center;gap:6px;font-weight:400;font-size:12.5px;margin:8px 0 16px"><input type="checkbox" id="cq_showDetailed" ${s.showDetailedBreakdown?'checked':''}> Show Detailed Annual Breakdown on the client-facing document</label>` : ''}
  `;
}

function saveQuotationFromState(s){
  // Business Name is OPTIONAL (spec §1) — Client Name alone is enough to
  // create and save a quotation. Business Name still saves/prints if the
  // client has one; when blank, quoteInfoRows() below simply omits that row
  // from the client-facing document rather than showing an empty
  // "Business Name: " line.
  if(!s.clientName || !s.clientName.trim()){ toast('Client Name is required.', 'error'); return; }
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

  // Annual Cost Breakdown totals (spec §10) — Year 1 Total = development +
  // scope add-ons − discount + adjustment (already exactly what `evalRes`
  // above computes) PLUS the chargeable Year 1 domain/hosting/maintenance
  // amounts. Year 2/3 = domain + hosting/backend/database + maintenance,
  // never Development again.
  const annualCost = normalizeAnnualCost(s.annualCost);
  const year1Charge = qcAnnualYear1Charge(annualCost.year1);
  const year1Total = evalRes.priceIsTBC ? null : Math.round((evalRes.finalPrice + year1Charge)*100)/100;
  const year2Total = qcAnnualYearTotal(annualCost.year2);
  const year3Total = qcAnnualYearTotal(annualCost.year3);
  const schedule = computePaymentSchedule(evalRes.priceIsTBC?0:year1Total, s.paymentPreset, s.customStages);
  const code = s.projectCode || s.leadId || ('DIRECT'+Date.now().toString().slice(-4));
  // Legacy-mirror maintenance object — kept in sync with annualCost so every
  // existing consumer (buildQuoteSections' Year 2/3 math for records not
  // using the new model, maintenanceWordingNotes(), etc.) keeps working
  // unchanged. Sales/Founder never edit this directly any more — it's
  // derived, not a second source of truth.
  const legacyMaintenance = {
    year1Mode: annualCost.year1.maintenanceMode, year1Cost: annualCost.year1.maintenance,
    year2Cost: annualCost.year2.maintenance, year3Cost: annualCost.year3.maintenance,
    year2DisplayMode: annualCost.year2.displayMode, year3DisplayMode: annualCost.year3.displayMode,
  };

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
  const withClientNote = s.clientNote ? [...notesList, { key:'clientNote', title:'Client-Specific Note', text:s.clientNote }] : notesList;
  const finalNotes = [...withClientNote, ...annualCostHiddenNotes(annualCost, !!s.showDetailedBreakdown)];

  const quotation = {
    id, quoteNumber, rootQuotationId, version, previousVersionId,
    leadId: s.leadId, projectCode: s.projectCode || null,
    clientName: s.clientName, businessName: s.businessName, phone: s.phone, telegram: s.telegram,
    industry: s.industry, interestedService: s.interestedService,
    packageKey: s.packageKey, packageName: svc ? svc.name : s.packageKey,
    quotationType: quotationTypeForProjectType(s.packageKey),
    assignedSales: s.assignedSales,
    currency:'USD',
    domainName: s.domainName,
    domainCost: annualCost.year1.domain, domainIncluded: annualCost.year1.domainMode!=='separate', domainRenewalEstimate: annualCost.year2.domain,
    maintenance: legacyMaintenance,
    year1Total, year2Total, year3Total,
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
    logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId: quotation.id, refLabel:`${quotation.quoteNumber} — ${quotation.businessName||quotation.clientName}`,
      type:'Quotation Superseded', description:`${CURRENT_USER.name} created revision v${version} of ${existing.quoteNumber} — the previous version is now Superseded.`,
      fromValue: existing.quoteNumber, toValue: quotation.quoteNumber });
  }

  logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId: quotation.id, refLabel:`${quotation.quoteNumber} — ${quotation.businessName||quotation.clientName}`,
    type: (s.editingId && !isNewRevision) ? 'Quotation Updated' : 'Quotation Created',
    description: `${CURRENT_USER.name} ${(s.editingId && !isNewRevision)?'updated':(isNewRevision?'created revision v'+version+' of':'created')} quotation ${quotation.quoteNumber}. Year 1 Total: ${evalRes.priceIsTBC?'TBC':money(year1Total)}.`,
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
    // Maintenance wording notes (maintenanceY1 / maintenanceRenewal) are
    // regenerated fresh at save time from the live maintenance state — never
    // carried over as static text — so they're filtered out here the same
    // way the per-client `clientNote` already is, to avoid duplicating them
    // when this quotation is re-edited and re-saved.
    notesOverride: q.importantNotes && q.importantNotes.length
      ? q.importantNotes.filter(n=> n.key!=='clientNote' && n.key!=='maintenanceY1' && n.key!=='maintenanceRenewal' && !ANNUAL_COST_HIDDEN_NOTE_KEYS.has(n.key))
      : null,
    clientNote:'',
    domainName: q.domainName,
    // Editing an EXISTING quotation defaults to 'not_included' whenever the
    // saved record has no `maintenance` object at all (created before this
    // feature existed), so opening it for editing never silently adds new
    // maintenance terms it never had (spec §16). Compare defaultMaintenanceState()
    // above, used only for BRAND-NEW quotations.
    maintenance: q.maintenance || { year1Mode:'not_included', year1Cost:0, year2Cost:0, year3Cost:0, year2DisplayMode:'estimated', year3DisplayMode:'estimated' },
    // Annual Cost Breakdown (spec §D/§28): prefer the record's own stored
    // model; a quotation saved before this feature existed gets one safely
    // DERIVED from its legacy flat fields, never rewritten in the DB.
    annualCost: resolvedAnnualCost(q),
    showDetailedBreakdown: extractShowDetailedBreakdown(q.importantNotes),
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
      <div><h3>${q.quoteNumber}</h3><div class="text-muted" style="font-size:12px;margin-top:2px">${escapeHtml(q.clientName)}${q.businessName?' — '+escapeHtml(q.businessName):''} · v${q.version||1}</div></div>
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
          ${infoRow('Business', q.businessName || '— (not provided)')}
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
  logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId:q.id, refLabel:`${q.quoteNumber} — ${q.businessName||q.clientName}`,
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
  logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId:q.id, refLabel:`${q.quoteNumber} — ${q.businessName||q.clientName}`,
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
      <p class="text-muted" style="margin-top:0;font-size:13px">${q.quoteNumber} — ${escapeHtml(q.businessName||q.clientName)}</p>
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
        logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId:q.id, refLabel:`${q.quoteNumber} — ${q.businessName||q.clientName}`,
          type:'Quotation Approved', description:`${CURRENT_USER.name} approved quotation ${q.quoteNumber} at ${money(q.year1Total)}.`,
          fromValue:'Awaiting Approval', toValue:'Approved', remark: comment });
      } else {
        q.approvalStatus = 'Founder Rejected';
        q.status = 'Rejected';
        DB.upsert('quotations', q);
        logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId:q.id, refLabel:`${q.quoteNumber} — ${q.businessName||q.clientName}`,
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
  logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId:q.id, refLabel:`${q.quoteNumber} — ${q.businessName||q.clientName}`,
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
    logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId:q.id, refLabel:`${q.quoteNumber} — ${q.businessName||q.clientName}`,
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

  logActivity({ userName: CURRENT_USER.name, refType:'quotation', refId:q.id, refLabel:`${q.quoteNumber} — ${q.businessName||q.clientName}`,
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
  const ac = normalizeAnnualCost(s.annualCost);
  const year1Charge = qcAnnualYear1Charge(ac.year1);
  const year1Total = evalRes.priceIsTBC ? null : Math.round((evalRes.finalPrice + year1Charge)*100)/100;
  // Legacy-mirror fields (domainCost/domainIncluded/domainRenewalEstimate/
  // year2Total/year3Total/maintenance) are still populated here too — see
  // the big comment above defaultAnnualCostState() — purely so
  // buildQuoteSections' existing Year 2/3 math keeps working unchanged for
  // this preview the same way it does for a saved quotation.
  const legacyMaintenance = {
    year1Mode: ac.year1.maintenanceMode, year1Cost: ac.year1.maintenance,
    year2Cost: ac.year2.maintenance, year3Cost: ac.year3.maintenance,
    year2DisplayMode: ac.year2.displayMode, year3DisplayMode: ac.year3.displayMode,
  };
  const baseNotes = s.clientNote ? [...notesList, {key:'clientNote',title:'Client-Specific Note',text:s.clientNote}] : notesList;
  return {
    quoteNumber: s.packageKey ? qcQuoteNumberPreview() : 'BW-Q-PREVIEW',
    clientName: s.clientName, businessName: s.businessName, industry: s.industry,
    packageName: svc?svc.name:s.packageKey, packageKey: s.packageKey,
    quotationType: s.packageKey ? quotationTypeForProjectType(s.packageKey) : 'website',
    quotationDate: s.quotationDate, validUntil: s.validUntil, demoLink: s.demoLink,
    items: s.items.filter(i=>i.included!==false),
    exclusions: s.exclusions,
    domainName: s.domainName,
    domainCost: ac.year1.domain, domainIncluded: ac.year1.domainMode!=='separate', domainRenewalEstimate: ac.year2.domain,
    year1Total, priceIsTBC: evalRes.priceIsTBC,
    year2Total: ac.year2.domain + ac.year2.hosting, // combined figure, matches the legacy field's historical meaning
    year3Total: ac.year3.domain + ac.year3.hosting,
    maintenance: legacyMaintenance,
    paymentSchedule: schedule,
    importantNotes: [...baseNotes, ...annualCostHiddenNotes(ac, !!s.showDetailedBreakdown)],
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

/* ---------------------------------------------------------------------- */
/* A4 pagination engine (spec: "A4 preview must be real A4")               */
/*                                                                          */
/* One content model, one measuring pass, one packing algorithm — used for */
/* the live Create/Edit preview, the standalone Preview/Print modal, AND   */
/* what actually gets printed/saved as PDF. This is the single source of  */
/* truth spec item 24 asks for: nothing here is duplicated per surface.    */
/*                                                                          */
/* Pipeline:                                                                */
/*   buildQuoteSections(q)      — PURE. Turns a quotation into an ordered  */
/*                                 list of section descriptors (blocks that */
/*                                 must never be split, and "groups" like   */
/*                                 tables/lists that CAN split by row/item, */
/*                                 repeating their header when they do).    */
/*   measureQuoteDoc(...)       — the only DOM-touching step. Renders every */
/*                                 section once in a hidden A4-width host   */
/*                                 and reads back real pixel heights.       */
/*   packQuoteSections(...)     — PURE. Greedy bin-packing of the measured  */
/*                                 sections into pages, never splitting a   */
/*                                 row/list-item, always keeping a repeated */
/*                                 table header with the rows that follow.  */
/*   renderQuotePagesHtml(...)  — PURE. Wraps packed page bodies in real    */
/*                                 210mm×297mm .quote-page containers with  */
/*                                 a full header on page 1 and a condensed  */
/*                                 continuation header + "Page N of M"      */
/*                                 footer on every page.                    */
/*   buildQuotePagesHtml(q)     — orchestrates the four steps above.        */
/*   paintQuotePreview(...)     — renders into a container, on screen.      */
/*   printQuoteDocFromContainer — prints EXACTLY that already-rendered      */
/*                                 DOM (see its own comment for why).       */
/* ---------------------------------------------------------------------- */

const QDOC_MM_TO_PX = 96/25.4;
const QDOC_PAGE_W_MM = 210, QDOC_PAGE_H_MM = 297, QDOC_MARGIN_MM = 15;
function qdocMm(n){ return n*QDOC_MM_TO_PX; }

// Every row/list-item of the client-facing document, in document order.
// `kind:'block'` = never split, never repeated (info table, domain note,
// bank details, signature). `kind:'group'` = a heading + a repeatable-header
// wrapper (a <table><thead>...</thead><tbody> or an <ol>) around a list of
// items that CAN be split across pages — the packer repeats `headingHtml`/
// `wrapOpenHtml` (which, for real tables, already contains the <thead> —
// exactly what spec item 8 means by "repeat the table header") on every
// page a group continues onto, and NEVER splits a single item's own html.
function buildQuoteSections(q){
  const bank = bankDetails();
  const labels = yearCostLabels(q.quotationType);
  const grouped = {};
  (q.items||[]).forEach(it=>{ if(!grouped[it.module]) grouped[it.module]=[]; grouped[it.module].push(it); });

  // NEW model (Annual Cost Breakdown) vs LEGACY quotation (spec §28): a
  // quotation saved under the new consolidated Year 1/2/3 editor carries a
  // hidden `__annualCost` note (see the big comment above
  // defaultAnnualCostState in the state-init section) — everything below
  // branches on its presence so an already-printed LEGACY document's
  // numbers/wording never shift by even a cent; only quotations actually
  // created/edited under the new model get the new Year 1 domain/hosting
  // line-item wording and the Year 2/3 domain-inclusive total.
  const storedAnnualCost = extractAnnualCost(q.importantNotes);
  const usingNewModel = !!storedAnnualCost;
  const showDetailed = usingNewModel && extractShowDetailedBreakdown(q.importantNotes);

  // Maintenance-aware Year-by-Year Budget (spec §2/§3): the base
  // year1/2/3 totals never absorb maintenance silently — a Year-1-paid
  // maintenance add-on is shown as its own clearly-labeled line item, and
  // Year 2/3 renewal + maintenance are broken out separately underneath the
  // headline amount so it's always clear what the renewal consists of.
  // `q.maintenance` (the legacy-mirror object) is NOT one of the columns
  // actually persisted to Supabase (pre-existing, unrelated gap — out of
  // scope here) — so for a NEW-model quotation, after a reload it can be
  // undefined even though real Year 1/2/3 maintenance data exists. Derive
  // `maint` from the reliably-persisted `storedAnnualCost` whenever
  // possible; only fall back to `q.maintenance`/the hard default for a
  // genuinely LEGACY record.
  const maint = usingNewModel
    ? { year1Mode: storedAnnualCost.year1.maintenanceMode, year1Cost: storedAnnualCost.year1.maintenance,
        year2Cost: storedAnnualCost.year2.maintenance, year3Cost: storedAnnualCost.year3.maintenance,
        year2DisplayMode: storedAnnualCost.year2.displayMode, year3DisplayMode: storedAnnualCost.year3.displayMode }
    : (q.maintenance || { year1Mode:'not_included', year1Cost:0, year2Cost:0, year3Cost:0, year2DisplayMode:'estimated', year3DisplayMode:'estimated' });
  const maintActive = maint.year1Mode && maint.year1Mode!=='not_included';
  const mentionsMaintenance = (label)=> /maintenance/i.test(label);
  let y1Label = (maintActive && !mentionsMaintenance(labels.y1)) ? `${labels.y1} & Maintenance` : labels.y1;
  let y2Label = (Number(maint.year2Cost)>0 && !mentionsMaintenance(labels.y2)) ? `${labels.y2} & Maintenance` : labels.y2;
  let y3Label = (Number(maint.year3Cost)>0 && !mentionsMaintenance(labels.y3)) ? `${labels.y3} & Maintenance` : labels.y3;
  const y1MaintAddOn = maint.year1Mode==='paid' ? (Number(maint.year1Cost)||0) : 0;
  // LEGACY: q.year1Total never included Year 1 maintenance — add it here at
  // display time (unchanged formula). NEW model: q.year1Total already IS
  // the full chargeable total (development + domain + hosting +
  // maintenance + add-ons − discount, spec §10) — adding y1MaintAddOn again
  // would double-count it.
  const y1Amount = q.priceIsTBC ? 'TBC' : money((Number(q.year1Total)||0) + (usingNewModel?0:y1MaintAddOn));
  let y2Base, y2Maint, y3Base, y3Maint, y2Amount, y3Amount, y1Breakdown='', y2Breakdown='', y3Breakdown='';
  if(usingNewModel){
    const y1 = storedAnnualCost.year1, y2 = storedAnnualCost.year2, y3 = storedAnnualCost.year3;
    y2Base = y2.domain + y2.hosting; y2Maint = y2.maintenance;
    y3Base = y3.domain + y3.hosting; y3Maint = y3.maintenance;
    y2Amount = qcYearAmountDisplay(y2Base + y2Maint, y2.displayMode||'estimated');
    y3Amount = qcYearAmountDisplay(y3Base + y3Maint, y3.displayMode||'estimated');
    // Year 1 domain wording (spec §4/§6/§23): Charged Separately shows its
    // own dollar breakdown line; Client Own Domain says so explicitly
    // (spec §26 TEST C — this exact phrase must appear); Included stays a
    // single combined line (no change to y1Label).
    if(y1.domainMode==='separate' && y1.domain>0 && !/domain/i.test(y1Label)) y1Label = `${y1Label} & Domain`;
    const domainNameSuffix = q.domainName ? ` (${escapeHtml(q.domainName)})` : '';
    if(y1.domainMode==='client_own'){
      y1Breakdown = `<div class="text-muted" style="font-size:10.5px;margin-top:2px">Existing / client-owned domain${domainNameSuffix} — no domain cost charged.</div>`;
    } else if(y1.domainMode==='separate' && y1.domain>0){
      y1Breakdown = `<div class="text-muted" style="font-size:10.5px;margin-top:2px">Domain${domainNameSuffix} ${money(y1.domain)}</div>`;
    } else if(q.domainName){
      y1Breakdown = `<div class="text-muted" style="font-size:10.5px;margin-top:2px">Domain: ${escapeHtml(q.domainName)}</div>`;
    }
    if(showDetailed){
      const y1Parts = [];
      if(!y1.hostingIncluded && y1.hosting>0) y1Parts.push(`${hostingLabelForService(serviceByProjectType(q.packageKey))} ${money(y1.hosting)}`);
      if(y1.maintenanceMode==='paid' && y1.maintenance>0) y1Parts.push(`Maintenance ${money(y1.maintenance)}`);
      if(y1Parts.length) y1Breakdown += `<div class="text-muted" style="font-size:10.5px;margin-top:2px">${y1Parts.join(' / ')}</div>`;
      y2Breakdown = `<div class="text-muted" style="font-size:10.5px;margin-top:2px">Domain ${money(y2.domain)} / Hosting ${money(y2.hosting)} / Maintenance ${money(y2.maintenance)}</div>`;
      y3Breakdown = `<div class="text-muted" style="font-size:10.5px;margin-top:2px">Domain ${money(y3.domain)} / Hosting ${money(y3.hosting)} / Maintenance ${money(y3.maintenance)}</div>`;
    }
  } else {
    y2Base = Number(q.year2Total)||0;
    y2Maint = Number(maint.year2Cost)||0;
    y3Base = Number(q.year3Total)||0;
    y3Maint = Number(maint.year3Cost)||0;
    y2Amount = q.year2Total!=null ? qcYearAmountDisplay(y2Base + y2Maint, maint.year2DisplayMode||'estimated') : 'TBC';
    y3Amount = q.year3Total!=null ? qcYearAmountDisplay(y3Base + y3Maint, maint.year3DisplayMode||'estimated') : 'TBC';
    y2Breakdown = (q.year2Total!=null && y2Maint>0) ? `<div class="text-muted" style="font-size:10.5px;margin-top:2px">Renewal ${money(y2Base)} + Maintenance ${money(y2Maint)}</div>` : '';
    y3Breakdown = (q.year3Total!=null && y3Maint>0) ? `<div class="text-muted" style="font-size:10.5px;margin-top:2px">Renewal ${money(y3Base)} + Maintenance ${money(y3Maint)}</div>` : '';
  }
  const visibleExcl = visibleExclusions(q.items, q.exclusions);

  const sections = [];

  sections.push({ id:'info', kind:'block',
    html:`<table class="quote-doc-infotable">${quoteInfoRows(q)}</table>` });

  const moduleEntries = Object.entries(grouped);
  sections.push({ id:'scope', kind:'group',
    headingHtml:`<h4 class="quote-doc-h">Scope of Work</h4>`,
    contHeadingHtml:`<h4 class="quote-doc-h">Scope of Work (continued)</h4>`,
    wrapOpenHtml:'', wrapCloseHtml:'',
    items: moduleEntries.length ? moduleEntries.map(([module,items])=>({
      html:`<div class="quote-doc-scopegroup"><div class="quote-doc-scopegroup-title">${escapeHtml(module)}</div><ul class="quote-doc-scopegroup-list">${items.map(it=>`<li>${escapeHtml(it.name)}${it.price===null||it.price===undefined?' — TBC':''}</li>`).join('')}</ul></div>`
    })) : [{ html:`<p class="text-muted" style="font-size:12.5px">Select a package to load scope.</p>` }],
  });

  sections.push({ id:'yearbudget', kind:'group',
    headingHtml:`<h4 class="quote-doc-h">Year-by-Year Budget</h4>`,
    contHeadingHtml:`<h4 class="quote-doc-h">Year-by-Year Budget (continued)</h4>`,
    wrapOpenHtml:`<table class="quote-doc-table"><thead><tr><th>Year</th><th>Details</th><th>Amount</th></tr></thead><tbody>`,
    wrapCloseHtml:`</tbody></table>`,
    items:[
      { html:`<tr><td>Year 1</td><td>${escapeHtml(y1Label)}${y1Breakdown}</td><td>${y1Amount}</td></tr>` },
      { html:`<tr><td>Year 2</td><td>${escapeHtml(y2Label)}${y2Breakdown}</td><td>${y2Amount}</td></tr>` },
      { html:`<tr><td>Year 3</td><td>${escapeHtml(y3Label)}${y3Breakdown}</td><td>${y3Amount}</td></tr>` },
    ],
  });

  // The old standalone "Domain" block is folded into the Year 1 row above
  // for any quotation created/edited under the new Annual Cost Breakdown
  // (spec §9/§23 — one source of truth, no duplicate domain line). Kept
  // exactly as before for a LEGACY quotation so its already-printed layout
  // never shifts.
  if(!usingNewModel && (q.domainName || q.domainCost!=null)){
    sections.push({ id:'domain', kind:'block',
      html:`<h4 class="quote-doc-h">Domain</h4><p style="font-size:12.5px;margin:0">${q.domainName?escapeHtml(q.domainName)+' — ':''}${q.domainIncluded?'included in Year 1':'not included'} (est. ${money(q.domainCost)}); renewal est. ${money(q.domainRenewalEstimate)}/year.</p>` });
  }

  const paymentFootNote = (!usingNewModel && maintActive && y1MaintAddOn>0) ? `<p class="text-muted" style="font-size:11px;margin:4px 0 0">Includes Year 1 maintenance (${money(y1MaintAddOn)}).</p>` : '';
  sections.push({ id:'payment', kind:'group',
    headingHtml:`<h4 class="quote-doc-h">Payment Schedule</h4>`,
    contHeadingHtml:`<h4 class="quote-doc-h">Payment Schedule (continued)</h4>`,
    wrapOpenHtml:`<table class="quote-doc-table qc-mini-table"><thead><tr><th>Stage</th><th>%</th><th>Amount</th></tr></thead><tbody>`,
    wrapCloseHtml:`</tbody></table>${paymentFootNote}`,
    items:(q.paymentSchedule||[]).map(st=>({ html:`<tr><td>${escapeHtml(st.label)}</td><td>${st.pct}%</td><td>${money(st.amount)}</td></tr>` })),
  });

  const noteItems = [];
  visibleImportantNotes(q.importantNotes).forEach(n=> noteItems.push({ html:`<li><b>${escapeHtml(n.title)}:</b> ${escapeHtml(n.text)}</li>` }));
  maintenanceWordingNotes(maint).forEach(n=> noteItems.push({ html:`<li><b>${escapeHtml(n.title)}:</b> ${escapeHtml(n.text)}</li>` }));
  if(visibleExcl.length) noteItems.push({ html:`<li><b>Not Included:</b> ${visibleExcl.map(escapeHtml).join(', ')}.</li>` });
  if(!noteItems.length) noteItems.push({ html:`<li>No additional notes.</li>` });
  sections.push({ id:'notes', kind:'group',
    headingHtml:`<h4 class="quote-doc-h">Important Notes</h4>`,
    contHeadingHtml:`<h4 class="quote-doc-h">Important Notes (continued)</h4>`,
    wrapOpenHtml:`<ol class="quote-doc-notes-list">`, wrapCloseHtml:`</ol>`,
    items: noteItems,
  });

  sections.push({ id:'bank', kind:'block',
    html:`<h4 class="quote-doc-h">Payment Bank Details</h4><div class="quote-doc-bankbox"><div><b>Account Name:</b> ${escapeHtml(bank.accountName)}</div><div><b>Account Number:</b> ${escapeHtml(bank.accountNumber)}</div><div><b>Bank Name:</b> ${escapeHtml(bank.bankName)}</div>${bank.memo?`<div><b>Memo:</b> ${escapeHtml(bank.memo)}</div>`:''}${bank.qrImageUrl?`<img src="${bank.qrImageUrl}" style="width:90px;margin-top:6px" alt="Payment QR">`:''}</div>` });

  sections.push({ id:'accept', kind:'block',
    html:`<div class="quote-doc-accept"><div><div class="sig-line"></div><span>Client Signature / Date</span></div><div><div class="sig-line"></div><span>BizWeb KH Representative / Date</span></div></div>` });

  return sections;
}

// Business Name is OPTIONAL (spec §1): its row is simply omitted from the
// client-facing document when blank — never shown empty, never silently
// replaced with Client Name (that substitution only happens in internal,
// non-client-facing labels like Activity Log entries — see the
// `businessName||clientName` fallbacks used there, kept deliberately
// separate from this function).
function quoteInfoRows(q){
  const rows = [
    `<tr><th>${bilingualLabel('ឈ្មោះអតិថិជន','Client Name')}</th><td>${escapeHtml(q.clientName)}</td></tr>`,
  ];
  if(q.businessName && String(q.businessName).trim()){
    rows.push(`<tr><th>${bilingualLabel('ឈ្មោះអាជីវកម្ម','Business Name')}</th><td>${escapeHtml(q.businessName)}</td></tr>`);
  }
  rows.push(`<tr><th>${bilingualLabel('គម្រោង','Project')}</th><td>${escapeHtml(q.packageName)}${q.industry?' — '+escapeHtml(q.industry):''}</td></tr>`);
  rows.push(`<tr><th>${bilingualLabel('កាលបរិច្ឆេទ','Date')}</th><td>${fmtDate(q.quotationDate)}</td></tr>`);
  rows.push(`<tr><th>${bilingualLabel('សុពលភាព','Valid Until')}</th><td>${fmtDate(q.validUntil)}</td></tr>`);
  if(q.demoLink) rows.push(`<tr><th>Demo Preview Link</th><td>${escapeHtml(q.demoLink)}</td></tr>`);
  return rows.join('');
}

function quoteFullHeaderHtml(q){
  const title = quotationTitleBlock(q.quotationType);
  return `<div class="quote-doc-head">
    <div class="quote-doc-brand">
      <img class="quote-doc-logo" src="../assets/branding/bizweb-kh-logo-main-print.png" alt="BizWeb KH">
      <div class="text-muted" style="font-size:11px">Tel: 017 400 044 | Telegram: @BizWebKH | www.bizwebkh.com</div>
    </div>
    <div class="quote-doc-meta">
      <div class="khmer-text" style="font-size:13px;color:var(--blue)">${title.khmer}</div>
      <div><b>${title.english}</b></div>
      <div>Quote No: ${escapeHtml(q.quoteNumber)}</div>
    </div>
  </div>`;
}
// Condensed continuation header (spec §10): every page after the first gets
// a small "BizWeb KH — <type> · Quote No: X" line instead of the full
// logo/header block, so page 2+ isn't wasting A4 real estate on a repeat of
// the branding block while still always identifying which quotation/page a
// loose printed sheet belongs to.
function quoteContHeaderHtml(q){
  const title = quotationTitleBlock(q.quotationType);
  return `<div class="quote-doc-cont-head"><b>BizWeb KH</b> — ${escapeHtml(title.english)} · Quote No: ${escapeHtml(q.quoteNumber)}</div>`;
}

// Flat (non-paginated) concatenation of every section's full content — used
// by automated tests to assert "nothing entered on the form is missing from
// the document" (spec §6) without needing a real browser to measure/paginate.
// Never used for actual rendering.
function quoteSectionsPlainHtml(q){
  const sections = buildQuoteSections(q);
  return quoteFullHeaderHtml(q) + sections.map(sec=>{
    if(sec.kind==='block') return sec.html;
    return sec.headingHtml + sec.wrapOpenHtml + sec.items.map(i=>i.html).join('') + sec.wrapCloseHtml;
  }).join('');
}

// The only DOM-touching step in the whole pipeline. Renders every block/
// group once, at the real A4 content width, in a hidden host — and reads
// back real pixel heights, so the exact same numbers a print engine would
// use for A4 layout drive the on-screen page split too (spec §16).
function measureQuoteDoc(sections, headerFullHtml, headerContHtml){
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-10000px;top:0;visibility:hidden;width:${QDOC_PAGE_W_MM - 2*QDOC_MARGIN_MM}mm;`;
  host.className = 'quote-doc quote-doc-measure';
  document.body.appendChild(host);

  function measureHtml(html){
    host.innerHTML = html;
    return host.getBoundingClientRect().height;
  }

  const headerFullHeight = measureHtml(headerFullHtml);
  const headerContHeight = measureHtml(headerContHtml);

  const measured = sections.map(sec=>{
    if(sec.kind==='block'){
      return { ...sec, height: measureHtml(sec.html) };
    }
    const headingHeight = measureHtml(sec.headingHtml);
    const contHeadingHeight = measureHtml(sec.contHeadingHtml);
    const wrapOpenHeight = measureHtml(sec.wrapOpenHtml + sec.wrapCloseHtml);
    // Measure every item's real height together, inside its actual wrapper,
    // so table-row/list-item borders & padding come out exactly as they'll
    // render on a page — tag each item's own outer tag so it can be read
    // back individually after the whole group is rendered once.
    host.innerHTML = sec.wrapOpenHtml + sec.items.map((it,i)=> it.html.replace(/^(<\w+)/, `$1 data-qi="${i}"`)).join('') + sec.wrapCloseHtml;
    const items = sec.items.map((it,i)=>{
      const el = host.querySelector(`[data-qi="${i}"]`);
      return { html: it.html, height: el ? el.getBoundingClientRect().height : 0 };
    });
    return { ...sec, headingHeight, contHeadingHeight, wrapOpenHeight, wrapCloseHeight:0, items };
  });

  document.body.removeChild(host);
  return { measured, headerFullHeight, headerContHeight };
}

// PURE greedy bin-packer: places measured sections into pages, never
// splitting a plain block, never splitting a single group item, and always
// re-emitting a group's heading (+ its repeatable wrapper, which for a real
// table already contains the <thead> — spec §8) whenever that group
// continues onto a new page. `firstBudget`/`contBudget` are the usable body
// height (px) of page 1 (larger header) vs. every page after it (smaller
// continuation header) — see buildQuotePagesHtml for how they're derived.
function packQuoteSections(measured, opts){
  const { firstBudget, contBudget } = opts;
  const pages = [];
  let curItems, curUsed, curBudget;
  function startPage(){ curItems = []; curUsed = 0; curBudget = pages.length===0 ? firstBudget : contBudget; pages.push(curItems); }
  function remaining(){ return curBudget - curUsed; }
  function place(html, height){ curItems.push(html); curUsed += height; }
  startPage();

  for(const sec of measured){
    if(sec.kind==='block'){
      if(sec.height <= remaining() || curItems.length===0){
        place(sec.html, sec.height);
      } else {
        startPage();
        place(sec.html, sec.height);
      }
      continue;
    }

    const atomicHeight = sec.headingHeight + sec.wrapOpenHeight + sec.wrapCloseHeight + sec.items.reduce((s,i)=>s+i.height,0);
    if(atomicHeight <= remaining()){
      place(sec.headingHtml + sec.wrapOpenHtml + sec.items.map(i=>i.html).join('') + sec.wrapCloseHtml, atomicHeight);
      continue;
    }
    // Doesn't fit in what's left of the current page — if the WHOLE group
    // would fit cleanly on a fresh page, start one rather than splitting it
    // unnecessarily (keeps short/typical quotations reading as clean,
    // unsplit sections — splitting is reserved for genuinely long content).
    if(curItems.length>0 && atomicHeight <= contBudget){
      startPage();
      place(sec.headingHtml + sec.wrapOpenHtml + sec.items.map(i=>i.html).join('') + sec.wrapCloseHtml, atomicHeight);
      continue;
    }

    // Must split across pages — never mid-row/mid-item (spec §7/§8).
    let idx = 0, usingCont = false;
    while(idx < sec.items.length){
      const headingHtml = usingCont ? sec.contHeadingHtml : sec.headingHtml;
      const headingHeight = usingCont ? sec.contHeadingHeight : sec.headingHeight;
      const overhead = headingHeight + sec.wrapOpenHeight + sec.wrapCloseHeight;
      if(curItems.length>0 && remaining() < overhead + sec.items[idx].height){
        startPage();
      }
      let segHeight = overhead;
      const segItems = [];
      while(idx < sec.items.length){
        const it = sec.items[idx];
        // Always place at least one item per page-segment (guarantees
        // forward progress even if a single item is taller than a full
        // page's budget) — otherwise only add more while they still fit.
        if(segItems.length>0 && segHeight + it.height > remaining()) break;
        segItems.push(it); segHeight += it.height; idx++;
      }
      place(headingHtml + sec.wrapOpenHtml + segItems.map(i=>i.html).join('') + sec.wrapCloseHtml, segHeight);
      usingCont = true;
      if(idx < sec.items.length) startPage();
    }
  }
  return pages.map(items=>items.join(''));
}

function renderQuotePagesHtml(pageBodies, q, headerFullHtml, headerContHtml){
  const total = pageBodies.length;
  return pageBodies.map((body, i)=>{
    const pageNum = i+1;
    const header = i===0 ? headerFullHtml : `<div class="quote-page-cont-head-wrap">${headerContHtml}</div>`;
    return `<div class="quote-doc quote-page" data-page="${pageNum}">
      ${header}
      <div class="quote-page-body">${body}</div>
      <div class="quote-doc-footer">Page ${pageNum} of ${total}</div>
    </div>`;
  }).join('');
}

// Orchestrates the full pipeline for one quotation. Async only because it
// waits for webfonts (Khmer) to finish loading before measuring — sizing
// Khmer text with a fallback font's metrics would produce a page split that
// stops matching reality the instant the real font swaps in.
async function buildQuotePagesHtml(q){
  try{ if(document.fonts && document.fonts.ready) await document.fonts.ready; }catch(e){}
  const sections = buildQuoteSections(q);
  const headerFullHtml = quoteFullHeaderHtml(q);
  const headerContHtml = quoteContHeaderHtml(q);
  const { measured, headerFullHeight, headerContHeight } = measureQuoteDoc(sections, headerFullHtml, headerContHtml);
  const pageContentHeightPx = qdocMm(QDOC_PAGE_H_MM - 2*QDOC_MARGIN_MM);
  const firstBudget = pageContentHeightPx - headerFullHeight;
  const contBudget = pageContentHeightPx - headerContHeight;
  const pages = packQuoteSections(measured, { firstBudget, contBudget });
  const html = `<div class="quote-pages-wrap">${renderQuotePagesHtml(pages, q, headerFullHtml, headerContHtml)}</div>`;
  return { html, pageCount: pages.length };
}

// Guards against a slower, now-stale render clobbering a faster, newer one
// when the user edits several fields in quick succession (each edit kicks
// off its own async buildQuotePagesHtml — only the LAST one requested
// should ever reach the DOM).
let QC_PREVIEW_TOKEN = 0;
async function paintQuotePreview(containerEl, q, onDone){
  const token = ++QC_PREVIEW_TOKEN;
  const { html, pageCount } = await buildQuotePagesHtml(q);
  if(token !== QC_PREVIEW_TOKEN) return; // superseded by a newer render
  if(!containerEl || !document.body.contains(containerEl)) return; // modal closed meanwhile
  containerEl.innerHTML = html;
  if(onDone) onDone(pageCount);
}

// Prints EXACTLY the already-rendered `.quote-pages-wrap` the user is
// looking at, by moving a copy of it to be a direct child of <body> and
// hiding everything else for the duration of the print — never the old
// "hide everything, show one flowing element inside the modal" trick.
// That old approach depended on none of the modal's own ancestors clipping
// or scroll-constraining the printed node (spec §17/§18's actual root
// cause: `.modal-box` is a scrollable, height-capped container, so a print
// target left nested inside it was never guaranteed to lay out at its full
// natural height). Printing a dedicated body-level copy removes that
// dependency entirely — nothing about the modal's own layout can clip it.
function printQuoteDocFromContainer(containerEl){
  const wrap = containerEl && containerEl.querySelector('.quote-pages-wrap');
  if(!wrap){ toast('Preview is still rendering — please wait a moment and try again.', 'error'); return; }
  const existing = document.getElementById('qcPrintRoot');
  if(existing) existing.remove();
  const root = document.createElement('div');
  root.id = 'qcPrintRoot';
  root.appendChild(wrap.cloneNode(true));
  document.body.appendChild(root);
  const cleanup = ()=>{
    const el = document.getElementById('qcPrintRoot');
    if(el) el.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  // Fallback in case `afterprint` never fires (some "Save as PDF" flows).
  setTimeout(cleanup, 20000);
  printAfterFontsReady();
}

function openQuotationPreview(id, autoPrint=false){
  const q = DB.find('quotations', id);
  if(!q) return;
  const html = `
    <div class="modal-head"><h3>Quotation Preview</h3><span id="qpPageCount" class="text-muted" style="font-size:12px;margin-left:8px"></span><button class="modal-close" id="qpClose">&times;</button></div>
    <div class="modal-body" style="background:#eef1f6;padding:20px" id="qpPreviewBody">
      <div class="text-muted" style="padding:60px;text-align:center">Rendering preview…</div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="qpClose2">Close</button>
      <button class="btn btn-primary" id="qpPrint" disabled>Download PDF (Print)</button>
    </div>
  `;
  openModal(html, { large:true, onMount:(overlay)=>{
    overlay.querySelector('#qpClose').onclick = closeModal;
    overlay.querySelector('#qpClose2').onclick = closeModal;
    const body = overlay.querySelector('#qpPreviewBody');
    const printBtn = overlay.querySelector('#qpPrint');
    printBtn.onclick = ()=> printQuoteDocFromContainer(body);
    paintQuotePreview(body, q, (pageCount)=>{
      if(!document.body.contains(overlay)) return;
      const badge = overlay.querySelector('#qpPageCount');
      if(badge) badge.textContent = `${pageCount} page${pageCount===1?'':'s'}`;
      printBtn.disabled = false;
      // Same font/paint-ready wait as the manual Print button — an
      // auto-triggered print (the list page's PDF action) is exactly the
      // case most likely to fire before the Khmer webfont/pagination has
      // finished, which is why this now waits for the real page count
      // instead of a blind setTimeout.
      if(autoPrint) printQuoteDocFromContainer(body);
    });
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
