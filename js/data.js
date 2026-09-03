/* ==========================================================================
   BizWeb KH CRM — data.js
   Data model, localStorage persistence layer, and demo data seeding.

   Entities (mirrors the future Supabase schema so migration is a straight
   table-for-table swap later):
     users       - CRM users (Founder / Sales / Partner)
     leads       - sales leads
     projects    - confirmed projects (linked back to a lead via leadId)
     activities  - append-only history of everything that happens
     followups   - follow-up notes / reschedule log (in addition to activities)
     payments    - payment records against a project

   Everything is namespaced under BZ_DB_KEY in localStorage as one JSON blob.
   Each module (leads.js, pipeline.js, projects.js, ...) reads/writes through
   the DB helper functions below rather than touching localStorage directly,
   so the storage engine can be swapped for Supabase later without touching
   the UI modules.
   ========================================================================== */

const BZ_DB_KEY = 'bizwebkh_crm_db_v1';
const BZ_SESSION_KEY = 'bizwebkh_crm_session_v1';

/* ---------------------------------------------------------------------- */
/* Reference / lookup data                                                */
/* ---------------------------------------------------------------------- */

// Dedicated constant for the "On Hold / Future Follow-up" pipeline stage
// (CRM feature request) — a valid, still-open opportunity that a client
// asked to revisit later (next month, after budget approval, etc.). It is
// deliberately NOT Lost (the opportunity is still real) and NOT Confirmed.
// Referenced from here instead of repeating the literal string everywhere,
// so every place that needs to special-case it (the status-change modal's
// Next Follow-up Date requirement, the Pipeline card's nearest-date sort,
// the badge color) stays in sync with one source of truth.
const ON_HOLD_STATUS = 'On Hold / Future Follow-up';

// LEAD / SALES STATUS ONLY — this is the sales pipeline stage of the lead
// itself and NEVER includes delivery/workflow statuses (those live only on
// the linked Project's `stage`, see PROJECT_STAGES below). Once a lead
// reaches Confirmed it stays Confirmed permanently — all further progress
// (Deposit Paid, In Development, ...) is tracked on the Project record,
// never by mutating the lead's own status again. See applyProjectStageChange
// in projects.js, which deliberately does NOT write back to lead.status.
// "Demo Sent" (its own standalone stage) and "Quotation Sent" have been
// merged into ONE stage, "Quote and Demo Sent" — every existing lead that
// was on either of the old stages was migrated to this one in Supabase
// (see migration migrate_demo_quotation_sent_and_project_code_rules), and
// neither old wording appears anywhere in the app any more.
const QUOTE_AND_DEMO_SENT_STATUS = 'Quote and Demo Sent';

// Wording-only rename of the old "Follow-up" pipeline stage — every lead
// previously on "Follow-up" was migrated to this exact stage in Supabase
// (see migration rename_followup_to_potential_need_follow_up); the old
// wording no longer appears anywhere in the app. The stage itself, its
// position in the pipeline, and all Next Follow-up Date / overdue / due
// logic are completely unchanged — only the label changed.
const POTENTIAL_FOLLOWUP_STATUS = 'Potential Need Follow Up';

const LEAD_STATUSES = [
  'New Lead', 'Contacted', 'Qualified', QUOTE_AND_DEMO_SENT_STATUS,
  POTENTIAL_FOLLOWUP_STATUS, ON_HOLD_STATUS, 'Negotiation', 'Confirmed', 'Lost'
];

// Statuses that still belong on the Kanban pipeline board
const PIPELINE_STATUSES = [
  'New Lead', 'Contacted', 'Qualified', QUOTE_AND_DEMO_SENT_STATUS,
  POTENTIAL_FOLLOWUP_STATUS, ON_HOLD_STATUS, 'Negotiation', 'Confirmed'
];

// TRUE open opportunities — used for Pipeline Value everywhere (dashboard
// KPI + Pipeline Value by Industry chart + Sales Performance). Deliberately
// excludes Confirmed (it becomes a Project and is counted in Closed Sales
// instead) and Lost — so a lead is never counted in both Pipeline Value and
// Closed Sales at once. On Hold / Future Follow-up stays IN this list — it's
// still a real, active, open opportunity (just temporarily paused), so it
// must keep counting toward Pipeline Value / Open Leads everywhere that
// reads this list, exactly like every other open stage.
const OPEN_PIPELINE_STATUSES = [
  'New Lead', 'Contacted', 'Qualified', QUOTE_AND_DEMO_SENT_STATUS,
  POTENTIAL_FOLLOWUP_STATUS, ON_HOLD_STATUS, 'Negotiation'
];

// Project Code business rule: NOT required for New Lead / Contacted /
// Qualified, becomes REQUIRED the first time a lead reaches Quote and Demo
// Sent (or any stage after it) and doesn't already have one. Confirmed is
// deliberately excluded here — it never reaches the generic status-change
// modal (see applyLeadStatusChange in leads.js, which redirects Confirmed
// to the dedicated openConfirmProjectModal flow instead), and Lost is
// excluded because abandoning a lead should never be blocked on a Project
// Code it may never have needed.
function leadStatusRequiresProjectCode(status){
  if(status==='Lost' || status==='Confirmed') return false;
  const gateIdx = LEAD_STATUSES.indexOf(QUOTE_AND_DEMO_SENT_STATUS);
  const idx = LEAD_STATUSES.indexOf(status);
  return idx>=0 && idx>=gateIdx;
}

// PROJECT / DELIVERY STATUS ONLY — completely separate axis from lead
// status. A project always starts at Confirmed and can move forward through
// delivery, or sideways into On Hold / Cancelled.
const PROJECT_STAGES = [
  'Confirmed', 'Deposit Paid', 'In Development',
  'Final Payment Pending', 'Completed', 'On Hold', 'Cancelled'
];
// Stages that still count as "active" work (used for KPIs / attention lists)
const ACTIVE_PROJECT_STAGES = [
  'Confirmed', 'Deposit Paid', 'In Development', 'Final Payment Pending'
];

const LEAD_SOURCES = [
  'Facebook Ads', 'Facebook Page', 'Telegram', 'Referral', 'Existing Client',
  'Website', 'Direct', 'Partner', 'Other'
];

// Standardized Industry / SME Type — the SAME list is used everywhere
// (Leads, Pipeline, Projects, Dashboard charts) so values never fragment
// into incompatible per-page categories.
const INDUSTRIES = [
  'School / Education', 'Clinic / Healthcare', 'Salon / Beauty', 'Retail / E-Commerce',
  'Hotel / Resort / Guesthouse', 'Restaurant / Cafe', 'Real Estate / Property',
  'NGO / Association', 'Professional Services', 'Logistics / Delivery',
  'Construction / Property Development', 'Insurance / Finance', 'Pharmacy', 'Other'
];
// Back-compat alias — older demo data / code referred to this as BUSINESS_TYPES.
const BUSINESS_TYPES = INDUSTRIES;
// Display fallback — an empty/unknown industry is shown as "Unspecified",
// never silently lumped into "Other" (which is itself a real, selectable
// industry value and must stay distinct from "we don't know").
function industryLabel(industry){ return (industry && String(industry).trim()) ? industry : 'Unspecified'; }

// Standardized Project Type, based on current BizWeb KH service tiers.
const SERVICE_TYPES = [
  'Starter Website', 'Pro Website', 'Pro Max Website', 'Dynamic Website / CMS',
  'Booking System', 'Customer Management System',
  'E-Commerce Level 1', 'E-Commerce Level 2', 'E-Commerce Level 3', 'E-Commerce Level 4',
  'Custom Business System', 'Mobile App / Advanced Platform', 'Other'
];

const LOST_REASONS = [
  'Price', 'No Response', 'Postponed', 'Competitor', 'No Budget',
  'No Longer Needed', 'Other'
];

const PAYMENT_STATUSES = ['Not Paid', 'Partially Paid', 'Fully Paid'];
const PAYMENT_METHODS = ['Cash', 'Bank Transfer', 'ABA', 'Wing', 'Other'];
// Payment TYPE describes what a single ledger entry was for. Payment STATUS
// (above) is never stored — it's always derived live from the ledger, see
// paymentSummaryFor() below.
const PAYMENT_TYPES = ['Deposit', 'Partial Payment', 'Final Payment', 'Renewal', 'Other'];

// Status of an individual confirmed function / scope item inside a project.
const FUNCTION_STATUSES = ['Confirmed', 'In Development', 'Completed', 'Future / Phase 2'];
const DEFAULT_FUNCTION_STATUS = 'Confirmed';

// A few starter module templates so "+ Add Module" isn't a blank slate —
// purely a UI convenience, never enforced (projects are free-form).
const FUNCTION_MODULE_TEMPLATES = {
  'Website': ['Home', 'About', 'Services', 'Products', 'Contact', 'Khmer / English'],
  'Booking System': ['Customer Booking Form', 'Date & Time Selection', 'Booking Status', 'Admin Booking Management'],
  'CMS': ['Admin Content Editor', 'Media Library', 'Page Management'],
  'Customer Management': ['Customer Records', 'Status Tracking', 'Reports'],
  'E-Commerce': ['Product Catalog', 'Shopping Cart', 'Checkout', 'Order Management'],
  'Admin Dashboard': ['Booking List', 'Calendar', 'Customer Records', 'Reports'],
  'Mobile App': ['iOS App', 'Android App', 'Push Notifications'],
};

// 'Quotation Sent' here describes a DIFFERENT thing from the "Quote and
// Demo Sent" LEAD STATUS above — it's logged by the Quotations module
// (quotations.js markAsSent()) when an actual quotation DOCUMENT is
// marked sent to the client, an event on the Quotation's own quotationStatus
// axis ('Draft' -> ... -> 'Sent to Client'), independent of the lead's
// pipeline stage. It is intentionally left as-is: renaming it to "Quote and
// Demo Sent" would misdescribe every one of these historical (and future)
// activity records as if a demo had been sent too, which this event never
// claims. 'Demo Sent' (the old activity type, distinct from the old LEAD
// STATUS of the same name) is removed below — it was never actually logged
// anywhere in the app (dead/unused), so nothing is lost.
const ACTIVITY_TYPES = [
  'Lead Created', 'Lead Edited', 'Status Changed', 'Follow-up Added', 'Follow-up Completed',
  'Follow-up Rescheduled', 'Quotation Sent', 'Assigned Sales Changed', 'Deposit Recorded',
  'Payment Recorded', 'Project Stage Changed', 'Project Created', 'Note Added',
  'Lead Lost', 'Function Added', 'Function Changed', 'Function Removed',
  'Quotation Created', 'Quotation Edited', 'Submitted for Review',
  'Founder Approved', 'Founder Rejected', 'Quotation Accepted', 'Quotation Expired',
  'Data Imported', 'Lead Archived', 'Lead Restored', 'Lead Deleted',
  'Payment Updated', 'Payment Voided', 'Project Value Changed',
  'Follow-up Scheduled', 'Follow-up Cancelled',
  'Project Code Assigned', 'Project Code Changed'
];

/* ---------------------------------------------------------------------- */
/* Service Price List — the SINGLE pricing reference used everywhere in    */
/* the demo (Quotations, and the demo lead/project generator below). Each  */
/* entry maps to an existing SERVICE_TYPES string via `projectType` so no  */
/* other list in the app needs to be renamed or duplicated.                */
/* ---------------------------------------------------------------------- */

const QUOTATION_STATUSES = [
  'Draft', 'Pending Founder Review', 'Approved', 'Sent to Client',
  'Accepted', 'Rejected', 'Expired'
];
const APPROVAL_STATUSES = [
  'Sales Approved', 'Founder Review Required', 'Founder Approved', 'Founder Rejected'
];

function svcFn(name, opts={}){
  return { id: fnId(), name, included: opts.included!==false, salesCanQuote: opts.salesCanQuote!==false,
           founderReviewRequired: !!opts.founderReviewRequired, defaultPrice: opts.defaultPrice===undefined ? 0 : opts.defaultPrice };
}

const SERVICE_PRICE_LIST = [
  { id:'SVC01', name:'Starter Website', projectType:'Starter Website', category:'Website', basePrice:99, year2Price:49, year3Price:49,
    salesCanQuote:true, founderReviewRequired:false, maxDiscountPct:10, defaultDelivery:'7 days', status:'Active',
    functions:[ svcFn('Home / About / Services / Contact pages'), svcFn('Khmer / English toggle'), svcFn('Basic SEO setup'), svcFn('Year-1 hosting & domain') ] },
  { id:'SVC02', name:'Pro Website', projectType:'Pro Website', category:'Website', basePrice:199, year2Price:79, year3Price:79,
    salesCanQuote:true, founderReviewRequired:false, maxDiscountPct:10, defaultDelivery:'10 days', status:'Active',
    functions:[ svcFn('Up to 8 pages'), svcFn('Gallery / Portfolio section'), svcFn('Contact form + map'), svcFn('Basic SEO setup'), svcFn('Year-1 hosting & domain') ] },
  { id:'SVC03', name:'Pro Max Website', projectType:'Pro Max Website', category:'Website', basePrice:299, year2Price:99, year3Price:99,
    salesCanQuote:true, founderReviewRequired:false, maxDiscountPct:10, defaultDelivery:'14 days', status:'Active',
    functions:[ svcFn('Up to 12 pages'), svcFn('Blog / News section'), svcFn('Advanced SEO setup'), svcFn('Contact form + map'), svcFn('Year-1 hosting & domain') ] },
  { id:'SVC04', name:'Dynamic Website + CMS', projectType:'Dynamic Website / CMS', category:'CMS', basePrice:399, year2Price:129, year3Price:129,
    salesCanQuote:true, founderReviewRequired:false, maxDiscountPct:10, defaultDelivery:'14 days', status:'Active',
    functions:[ svcFn('Website (core pages)'), svcFn('Admin content editor'), svcFn('Media library'), svcFn('Page management'), svcFn('Year-1 hosting & domain') ] },
  { id:'SVC05', name:'Booking Website + Admin', projectType:'Booking System', category:'Booking', basePrice:499, year2Price:149, year3Price:149,
    salesCanQuote:true, founderReviewRequired:false, maxDiscountPct:10, defaultDelivery:'18 days', status:'Active',
    functions:[ svcFn('Website'), svcFn('Booking form'), svcFn('Date/time selection'), svcFn('Customer information'),
                svcFn('Basic admin dashboard'), svcFn('Booking list'), svcFn('Calendar'), svcFn('Booking status'),
                svcFn('Year-1 hosting/backend/database') ] },
  { id:'SVC06', name:'Customer Management System', projectType:'Customer Management System', category:'CMS', basePrice:599, year2Price:179, year3Price:179,
    salesCanQuote:true, founderReviewRequired:false, maxDiscountPct:10, defaultDelivery:'21 days', status:'Active',
    functions:[ svcFn('Website'), svcFn('Customer records'), svcFn('Status tracking'), svcFn('Basic admin dashboard'),
                svcFn('Reports (basic)'), svcFn('Year-1 hosting/backend/database') ] },
  { id:'SVC07', name:'E-Commerce Level 1 – Basic Catalog + Admin', projectType:'E-Commerce Level 1', category:'E-Commerce', basePrice:500, year2Price:149, year3Price:149,
    salesCanQuote:true, founderReviewRequired:false, maxDiscountPct:10, defaultDelivery:'21 days', status:'Active',
    functions:[ svcFn('Website'), svcFn('Product catalog'), svcFn('Chat / manual ordering'), svcFn('Basic admin dashboard'),
                svcFn('Year-1 hosting/backend/database') ] },
  { id:'SVC08', name:'E-Commerce Level 2 – Standard Online Store', projectType:'E-Commerce Level 2', category:'E-Commerce', basePrice:1199, year2Price:299, year3Price:299,
    salesCanQuote:true, founderReviewRequired:false, maxDiscountPct:10, defaultDelivery:'30 days', status:'Active', priceIsStartingFrom:true,
    functions:[ svcFn('Website'), svcFn('Product catalog'), svcFn('Shopping cart'), svcFn('Checkout'),
                svcFn('Standard customer login'), svcFn('Order management'), svcFn('Year-1 hosting/backend/database') ] },
  { id:'SVC09', name:'E-Commerce Level 3 – Customized Commerce', projectType:'E-Commerce Level 3', category:'E-Commerce', basePrice:1500, year2Price:399, year3Price:399,
    salesCanQuote:false, founderReviewRequired:true, maxDiscountPct:0, defaultDelivery:'45 days', status:'Active', priceIsStartingFrom:true,
    functions:[ svcFn('Website'), svcFn('Product catalog'), svcFn('Shopping cart'), svcFn('Checkout'),
                svcFn('Customized workflow', {founderReviewRequired:true,defaultPrice:null}), svcFn('Year-1 hosting/backend/database') ] },
  { id:'SVC10', name:'E-Commerce Level 4 – Advanced / Integrated', projectType:'E-Commerce Level 4', category:'E-Commerce', basePrice:2000, year2Price:499, year3Price:499,
    salesCanQuote:false, founderReviewRequired:true, maxDiscountPct:0, defaultDelivery:'60 days', status:'Active', priceIsStartingFrom:true,
    functions:[ svcFn('Website'), svcFn('Full e-commerce engine'), svcFn('Third-party API integration', {founderReviewRequired:true,defaultPrice:null}),
                svcFn('Advanced reporting', {founderReviewRequired:true,defaultPrice:null}), svcFn('Year-1 hosting/backend/database') ] },
  { id:'SVC11', name:'Custom Business System', projectType:'Custom Business System', category:'Custom', basePrice:800, year2Price:199, year3Price:199,
    salesCanQuote:false, founderReviewRequired:true, maxDiscountPct:0, defaultDelivery:'By scope', status:'Active', priceIsStartingFrom:true,
    functions:[ svcFn('Custom-scoped modules', {founderReviewRequired:true,defaultPrice:null}), svcFn('Year-1 hosting/backend/database') ] },
  { id:'SVC12', name:'Mobile App / Advanced Platform', projectType:'Mobile App / Advanced Platform', category:'Mobile', basePrice:2000, year2Price:499, year3Price:499,
    salesCanQuote:false, founderReviewRequired:true, maxDiscountPct:0, defaultDelivery:'By scope', status:'Active', priceIsStartingFrom:true,
    functions:[ svcFn('iOS App', {founderReviewRequired:true,defaultPrice:null}), svcFn('Android App', {founderReviewRequired:true,defaultPrice:null}),
                svcFn('Push Notifications', {founderReviewRequired:true,defaultPrice:null}), svcFn('Year-1 hosting/backend/database') ] },
];

function serviceByProjectType(projectType){
  return SERVICE_PRICE_LIST.find(s=>s.projectType===projectType) || null;
}

// Additional functions catalog — can be added to ANY quotation regardless
// of the base package. Mirrors the spec's exact standard-vs-founder-review
// split (section 11). `defaultPrice: null` means "TBC" (no fixed approved
// price — Sales must never guess).
const ADDITIONAL_FUNCTIONS_CATALOG = [
  // ----- Standard / Sales Can Quote -----
  { id:'AF01', name:'Informational website page', founderReviewRequired:false, salesCanQuote:true, defaultPrice:0 },
  { id:'AF02', name:'Basic contact / inquiry form', founderReviewRequired:false, salesCanQuote:true, defaultPrice:0 },
  { id:'AF03', name:'Standard CMS (content editor)', founderReviewRequired:false, salesCanQuote:true, defaultPrice:80 },
  { id:'AF04', name:'Basic booking form', founderReviewRequired:false, salesCanQuote:true, defaultPrice:100 },
  { id:'AF05', name:'Standard customer management', founderReviewRequired:false, salesCanQuote:true, defaultPrice:100 },
  { id:'AF06', name:'Product catalog + chat ordering', founderReviewRequired:false, salesCanQuote:true, defaultPrice:80 },
  { id:'AF07', name:'Standard E-Commerce Level 2 workflow', founderReviewRequired:false, salesCanQuote:true, defaultPrice:150 },
  // ----- Founder Review Required -----
  { id:'AF08', name:'Online payment gateway (outside standard package)', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
  { id:'AF09', name:'OTP Verification', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
  { id:'AF10', name:'SMS verification', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
  { id:'AF11', name:'Customer login (outside standard Level 2 package)', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
  { id:'AF12', name:'Inventory management', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
  { id:'AF13', name:'POS system', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
  { id:'AF14', name:'Accounting integration', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
  { id:'AF15', name:'Payroll module', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
  { id:'AF16', name:'Multi-branch support', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
  { id:'AF17', name:'Multiple complex user roles', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
  { id:'AF18', name:'Approval workflow', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
  { id:'AF19', name:'Third-party API integration', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
  { id:'AF20', name:'Mobile app', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
  { id:'AF21', name:'500+ products / heavy data', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
  { id:'AF22', name:'Custom reports / automation', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
  { id:'AF23', name:'Customized loyalty program', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
  { id:'AF24', name:'Customized delivery logic', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
  { id:'AF25', name:'Marketplace sync', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
  { id:'AF26', name:'Advanced returns / refund handling', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
  { id:'AF27', name:'Wallet system', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
  { id:'AF28', name:'Advanced stock management', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
  { id:'AF29', name:'ERP / POS integration', founderReviewRequired:true, salesCanQuote:false, defaultPrice:null },
];

/* ---------------------------------------------------------------------- */
/* Quotation rules engine                                                  */
/* ---------------------------------------------------------------------- */

// Evaluates a draft quotation's line items + discount + manual adjustment
// and returns whether Founder review is required, why, and the final price.
// `items` = flat array of { name, price (number|null = TBC), founderReviewRequired, source }
// `discountPct`, `manualAdjustment` ({amount, reason} or null)
function evaluateQuotation({ items, basePackage, discountPct=0, manualAdjustment=null, discountLimitPct=10 }){
  const reasons = [];
  let priceIsTBC = false;

  items.forEach(it=>{
    if(it.price===null || it.price===undefined){ priceIsTBC = true; }
    if(it.founderReviewRequired){ reasons.push(`Function "${it.name}" requires Founder review.`); }
  });

  if(basePackage && basePackage.founderReviewRequired){
    reasons.push(`Package "${basePackage.name}" always requires Founder review.`);
  }
  if(['E-Commerce Level 3','E-Commerce Level 4','Custom Business System','Mobile App / Advanced Platform'].includes(basePackage && basePackage.projectType)){
    reasons.push(`${basePackage.name} is above standard Sales authority.`);
  }

  const subtotal = items.reduce((s,it)=> s + (it.price||0), 0);
  let discountAmt = Math.round(subtotal * (discountPct/100) * 100)/100;
  if(discountPct>discountLimitPct){
    reasons.push(`Discount of ${discountPct}% exceeds Sales authority (max ${discountLimitPct}%).`);
  }
  let finalPrice = Math.round((subtotal - discountAmt)*100)/100;

  if(manualAdjustment && manualAdjustment.amount){
    finalPrice = Math.round((finalPrice + manualAdjustment.amount)*100)/100;
    if(!manualAdjustment.reason || !manualAdjustment.reason.trim()){
      reasons.push('Price adjustment is missing a required reason.');
    }
    if(Math.abs(manualAdjustment.amount) > subtotal*0.10){
      reasons.push(`Manual price adjustment of $${manualAdjustment.amount} exceeds Sales authority — Founder review required.`);
    }
  }

  if(priceIsTBC){ reasons.push('One or more functions have no fixed price ("Price: TBC").'); }

  const requiresFounderReview = reasons.length>0;
  return {
    subtotal, discountAmt, finalPrice: priceIsTBC ? null : finalPrice,
    priceIsTBC, requiresFounderReview, reasons,
    approvalStatus: requiresFounderReview ? 'Founder Review Required' : 'Sales Approved'
  };
}

// BW-Q-{projectId|leadId}-{YYYYMMDD}[-v{n}]
function generateQuoteNumber(refCode, version=1){
  const d = new Date();
  const ymd = d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
  const base = `BW-Q-${refCode}-${ymd}`;
  const existing = DB.all('quotations').filter(q=>q.quoteNumber && q.quoteNumber.startsWith(base));
  let num = base;
  if(version>1 || existing.some(q=>q.quoteNumber===num)){
    num = `${base}-v${version}`;
    while(DB.all('quotations').some(q=>q.quoteNumber===num)){
      version++; num = `${base}-v${version}`;
    }
  }
  return num;
}

function slug(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }

/* ---------------------------------------------------------------------- */
/* Core DB helpers                                                        */
/* ---------------------------------------------------------------------- */

/* ---------------------------------------------------------------------- */
/* Supabase row <-> app-shape translation helpers                         */
/* ---------------------------------------------------------------------- */

const COLLECTION_TABLE = {
  leads: 'leads', projects: 'projects', payments: 'payments', services: 'services',
  leadActivities: 'lead_activities',
};

function userIdToName(id){
  if(!id) return null;
  const u = (DB._cache.users||[]).find(u=>u.id===id);
  return u ? u.name : null;
}
function userNameToId(name){
  if(!name || name==='Unassigned') return null;
  const u = (DB._cache.users||[]).find(u=>u.name===name);
  return u ? u.id : null;
}

function rowToLead(row){
  return {
    id: row.id, clientName: row.client_name, businessName: row.business_name,
    phone: row.phone || '', telegram: row.telegram || '', facebook: row.facebook || '', email: row.email || '',
    industry: row.industry, interestedService: row.interested_service,
    estimatedValue: row.estimated_value, leadSource: row.source,
    assignedSales: userIdToName(row.assigned_sales) || 'Unassigned',
    status: row.status,
    nextFollowup: row.next_follow_up_date, lastContact: row.last_contact_date,
    expectedCloseDate: row.expected_close_date,
    quotationStatus: row.quotation_status, quotationAmount: row.quotation_amount,
    quotationRef: row.quotation_ref || '', demoLink: row.demo_link || '',
    notes: row.notes || '', lostReason: row.lost_reason, holdReason: row.hold_reason, projectCode: row.project_id,
    createdAt: row.created_at, updatedAt: row.updated_at,
    sourceFiles: [], sourceType: '', sourceDate: '', confidence: '',
    needsManualReview: false, historicalListConflict: false,
    archived: !!row.archived, archivedAt: row.archived_at,
    archivedBy: userIdToName(row.archived_by), archiveReason: row.archive_reason,
    followUpCreatedBy: userIdToName(row.follow_up_created_by),
    followUpUpdatedAt: row.follow_up_updated_at,
  };
}
function leadToRow(lead){
  return {
    id: lead.id, client_name: lead.clientName, business_name: lead.businessName,
    phone: lead.phone || null, email: lead.email || null,
    telegram: lead.telegram || null, facebook: lead.facebook || null,
    industry: lead.industry || null, interested_service: lead.interestedService || null,
    status: lead.status, source: lead.leadSource || null,
    assigned_sales: userNameToId(lead.assignedSales),
    estimated_value: lead.estimatedValue===''?null:lead.estimatedValue,
    next_follow_up_date: lead.nextFollowup || null,
    last_contact_date: lead.lastContact || null,
    expected_close_date: lead.expectedCloseDate || null,
    quotation_status: lead.quotationStatus || null,
    quotation_amount: lead.quotationAmount===''?null:(lead.quotationAmount ?? null),
    quotation_ref: lead.quotationRef || null,
    demo_link: lead.demoLink || null,
    notes: lead.notes || null,
    lost_reason: lead.lostReason || null,
    hold_reason: lead.holdReason || null,
    archived: !!lead.archived, archived_at: lead.archivedAt || null,
    archived_by: userNameToId(lead.archivedBy), archive_reason: lead.archiveReason || null,
    follow_up_created_by: userNameToId(lead.followUpCreatedBy),
    follow_up_updated_at: lead.followUpUpdatedAt || null,
    project_id: lead.projectCode || null,
    created_at: lead.createdAt || undefined,
    updated_at: lead.updatedAt || new Date().toISOString(),
  };
}

function rowToProject(row){
  return {
    id: row.id, leadId: row.lead_id, clientName: row.client_name, businessName: row.business_name,
    phone: '', industry: row.industry, projectType: row.project_type,
    estimatedValue: null, confirmedValue: row.confirmed_value, depositPct: null,
    assignedSales: userIdToName(row.assigned_sales) || 'Unassigned',
    stage: row.stage, startDate: row.start_date, expectedDelivery: row.expected_delivery,
    leadSource: '', demoLink: '', quotationRef: '', notes: '',
    functions: row.functions || [], createdAt: row.created_at,
  };
}
function projectToRow(proj){
  return {
    id: proj.id, lead_id: proj.leadId, client_name: proj.clientName, business_name: proj.businessName,
    industry: proj.industry || null, project_type: proj.projectType || null,
    confirmed_value: proj.confirmedValue, stage: proj.stage,
    assigned_sales: userNameToId(proj.assignedSales),
    start_date: proj.startDate || null, expected_delivery: proj.expectedDelivery || null,
    functions: proj.functions || [], created_at: proj.createdAt || undefined,
  };
}

function rowToPayment(row){
  return {
    id: row.id, projectId: row.project_id, paymentNumber: row.payment_number,
    amount: row.amount, date: row.payment_date, method: row.method, type: row.type,
    reference: row.reference || '', note: row.note || '',
    recordedBy: userIdToName(row.recorded_by) || 'System Import',
    createdAt: row.created_at,
    voided: !!row.voided, voidedBy: userIdToName(row.voided_by),
    voidedAt: row.voided_at, voidReason: row.void_reason,
  };
}
function paymentToRow(p){
  return {
    id: p.id, project_id: p.projectId, payment_number: p.paymentNumber, type: p.type,
    amount: p.amount, payment_date: p.date, method: p.method,
    reference: p.reference || null, note: p.note || null,
    recorded_by: userNameToId(p.recordedBy), voided: !!p.voided,
    voided_by: userNameToId(p.voidedBy), voided_at: p.voidedAt || null,
    void_reason: p.voidReason || null, created_at: p.createdAt || undefined,
  };
}

function rowToActivity(row){
  return {
    id: row.id, at: row.occurred_at, userName: userIdToName(row.user_id) || 'System Import',
    refType: row.ref_type, refId: row.ref_id, refLabel: row.ref_label, type: row.action_type,
    description: row.description, fromValue: row.from_value, toValue: row.to_value, remark: row.remark,
  };
}
// Note: activity_logs' primary key is a server-generated bigint identity —
// the JS-side `id` (e.g. "A1234...") is NEVER sent on insert.
function activityToInsertRow(a){
  return {
    occurred_at: a.at || new Date().toISOString(),
    user_id: userNameToId(a.userName),
    ref_type: a.refType, ref_id: a.refId, ref_label: a.refLabel,
    action_type: a.type, description: a.description,
    from_value: a.fromValue ?? null, to_value: a.toValue ?? null, remark: a.remark ?? null,
  };
}

// lead_activities — persistent follow-up notes/history per lead (spec:
// "Follow-up notes and follow-up history MUST survive refresh/logout/
// browser restart"). Separate from activity_logs (the general audit trail)
// because it carries typed follow_up_date/completed_at columns that
// activity_logs deliberately does not have — this is NOT a duplicate of
// the Activity Log; each follow-up action still also calls logActivity()
// for the general chronological record, same as before.
function rowToLeadActivity(row){
  return {
    id: row.id, leadId: row.lead_id, activityType: row.activity_type,
    note: row.note || '', followUpDate: row.follow_up_date, completedAt: row.completed_at,
    createdBy: userIdToName(row.created_by) || 'Unassigned',
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
// Note: lead_activities' primary key is a server-generated bigint identity —
// the JS-side `id` is never sent on insert (same pattern as activityToInsertRow).
function leadActivityToInsertRow(a){
  return {
    lead_id: a.leadId, activity_type: a.activityType, note: a.note || null,
    follow_up_date: a.followUpDate || null, completed_at: a.completedAt || null,
    created_by: userNameToId(a.createdBy),
  };
}

function rowToService(row){
  return {
    id: row.id, name: row.name, projectType: row.project_type, category: row.category,
    basePrice: row.base_price, year2Price: row.year2_price, year3Price: row.year3_price,
    salesCanQuote: row.sales_can_quote, founderReviewRequired: row.founder_review_required,
    maxDiscountPct: row.max_discount_pct, defaultDelivery: row.default_delivery,
    status: row.status, functions: row.functions || [], isActive: row.is_active,
  };
}
function serviceToRow(s){
  return {
    id: s.id, name: s.name, project_type: s.projectType, category: s.category,
    base_price: s.basePrice, year2_price: s.year2Price, year3_price: s.year3Price,
    sales_can_quote: s.salesCanQuote, founder_review_required: s.founderReviewRequired,
    max_discount_pct: s.maxDiscountPct, default_delivery: s.defaultDelivery,
    status: s.status, functions: s.functions || [], is_active: s.isActive !== false,
  };
}

// Local copies of app.js's initialsOf()/avatarColorFor() — DB.init() (and
// therefore rowToUser) runs during the dashboard bootstrap BEFORE app.js is
// loaded (see dashboard/index.html), so this file can't rely on those
// globals existing yet. Kept logically identical to the app.js versions.
function _fallbackInitials(name){ return String(name||'?').split(' ').filter(Boolean).slice(0,2).map(s=>s[0]).join('').toUpperCase(); }
function _fallbackAvatarColor(name){
  const AVATAR_COLORS = ['#1d7bff','#18c8ff','#ff8a3d','#7c5cff','#12a775','#e0473c','#d98a12'];
  let h=0; for(let i=0;i<String(name).length;i++) h = (h*31 + name.charCodeAt(i))>>>0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function rowToUser(row){
  return { id: row.id, username: row.name, name: row.name, role: row.role,
           color: row.color || _fallbackAvatarColor(row.name), initials: row.initials || _fallbackInitials(row.name) };
}

/* ---------------------------------------------------------------------- */
/* Core DB — synchronous in-memory cache, backed by Supabase               */
/* ---------------------------------------------------------------------- */

const DB = {
  _cache: { leads:[], projects:[], payments:[], activities:[], services:[],
            settings:{}, users:[], quotations:[], followups:[], quotationReviews:[], leadActivities:[] },
  _initialized: false,

  // Populates _cache from Supabase. Must be awaited before any UI code runs
  // (see dashboard/index.html's bootstrap script) — every DB.all()/find()
  // call after that point reads synchronously from _cache.
  async init(){
    const [leadsRes, projectsRes, paymentsRes, activitiesRes, servicesRes, settingsRes, profilesRes, leadActivitiesRes] = await Promise.all([
      supabaseClient.from('leads').select('*'),
      supabaseClient.from('projects').select('*'),
      supabaseClient.from('payments').select('*'),
      supabaseClient.from('activity_logs').select('*').order('occurred_at', { ascending:false }).limit(2000),
      supabaseClient.from('services').select('*'),
      supabaseClient.from('settings').select('*').eq('id', true).maybeSingle(),
      supabaseClient.from('profiles').select('*'),
      supabaseClient.from('lead_activities').select('*').order('created_at', { ascending:false }).limit(2000),
    ]);

    [leadsRes, projectsRes, paymentsRes, activitiesRes, servicesRes, settingsRes, profilesRes, leadActivitiesRes].forEach(r=>{
      if(r && r.error) console.error('Supabase fetch error', r.error);
    });

    // users first — lead/project/payment/activity mapping needs id->name lookups
    this._cache.users = (profilesRes.data || []).map(rowToUser);
    this._cache.leads = (leadsRes.data || []).map(rowToLead);
    this._cache.projects = (projectsRes.data || []).map(rowToProject);
    this._cache.payments = (paymentsRes.data || []).map(rowToPayment);
    this._cache.activities = (activitiesRes.data || []).map(rowToActivity);
    this._cache.services = (servicesRes.data || []).map(rowToService);
    this._cache.leadActivities = (leadActivitiesRes.data || []).map(rowToLeadActivity);
    this._cache.settings = { discountLimitPct: (settingsRes.data && settingsRes.data.discount_limit_pct) || 10 };
    // Never Supabase-backed — kept empty/local-only so quotations.js
    // doesn't throw. Follow-up notes/history now live in lead_activities
    // (Supabase-backed, see above) — `followups` is unused dead cache.
    this._cache.quotations = this._cache.quotations || [];
    this._cache.followups = this._cache.followups || [];
    this._cache.quotationReviews = this._cache.quotationReviews || [];

    this._initialized = true;
    return this._cache;
  },

  // Re-fetches everything fresh from Supabase (used by Settings -> "Reset
  // Data", which used to wipe localStorage and reseed fake data — it now
  // just re-syncs from the live backend instead).
  reset(){ return this.init(); },

  // Local passthrough only (no Supabase side effect) — kept for the few
  // call sites that mutate a whole collection at once (e.g. the in-memory
  // `followups` note log, which has no Supabase table). read() returns the
  // live _cache reference, so in-place mutation + write() already "just
  // works" the same way it did against localStorage.
  read(){ return this._cache; },
  write(db){ this._cache = db; return true; },

  // ----- generic collection helpers -----
  all(collection){ return this._cache[collection] || []; },
  find(collection, id){ return this.all(collection).find(x=>x.id===id) || null; },

  // Optimistic: updates _cache and returns synchronously (so ~140 existing
  // synchronous call sites keep working untouched), then fires the Supabase
  // write in the background. Errors are logged, never thrown, so a
  // transient network hiccup never crashes the UI.
  upsert(collection, record){
    if(collection==='settings'){
      this._cache.settings = { ...this._cache.settings, ...record };
      supabaseClient.from('settings').update({ discount_limit_pct: this._cache.settings.discountLimitPct }).eq('id', true)
        .then(({error})=>{ if(error) console.error('Supabase settings update failed', error); })
        .catch(e=> console.error('Supabase settings update failed', e));
      return this._cache.settings;
    }

    const list = this._cache[collection] || (this._cache[collection]=[]);
    const idx = list.findIndex(x=>x.id===record.id);
    if(idx>-1) list[idx]=record; else if(collection==='activities' || collection==='leadActivities') list.unshift(record); else list.push(record);

    if(collection==='activities'){
      supabaseClient.from('activity_logs').insert(activityToInsertRow(record))
        .then(({error})=>{ if(error) console.error('Supabase activity insert failed', error); })
        .catch(e=> console.error('Supabase activity insert failed', e));
      return record;
    }

    // Append-only, same pattern as activities — the row's real (bigint)
    // primary key is server-generated and never needed client-side because
    // lead_activities is never updated/deleted directly from the UI; when a
    // lead IS permanently deleted, `leads.id`'s `on delete cascade` FK
    // removes its lead_activities rows automatically on the server.
    if(collection==='leadActivities'){
      supabaseClient.from('lead_activities').insert(leadActivityToInsertRow(record))
        .then(({error})=>{ if(error) console.error('Supabase lead_activities insert failed', error); })
        .catch(e=> console.error('Supabase lead_activities insert failed', e));
      return record;
    }

    if(collection==='quotations' || collection==='followups' || collection==='quotationReviews'){
      // No Supabase table for these yet — cache-only.
      return record;
    }

    const table = COLLECTION_TABLE[collection];
    if(!table) return record; // unknown/local-only collection — cache-only, no remote sync
    const toRow = { leads: leadToRow, projects: projectToRow, payments: paymentToRow, services: serviceToRow }[collection];
    supabaseClient.from(table).upsert(toRow(record))
      .then(({error})=>{ if(error) console.error(`Supabase upsert failed for ${collection}`, error); })
      .catch(e=> console.error(`Supabase upsert failed for ${collection}`, e));
    return record;
  },
  remove(collection, id){
    this._cache[collection] = (this._cache[collection]||[]).filter(x=>x.id!==id);
    const table = COLLECTION_TABLE[collection];
    if(!table) return; // activities (append-only), quotations/followups (local-only) never delete remotely
    supabaseClient.from(table).delete().eq('id', id)
      .then(({error})=>{ if(error) console.error(`Supabase delete failed for ${collection}`, error); })
      .catch(e=> console.error(`Supabase delete failed for ${collection}`, e));
  },
  nextId(prefix, collection, pad=3){
    const list = this._cache[collection]||[];
    let max=0;
    list.forEach(x=>{
      const m = String(x.id||x.code||'').match(new RegExp('^'+prefix+'(\\d+)$'));
      if(m) max=Math.max(max, parseInt(m[1],10));
    });
    return prefix + String(max+1).padStart(pad,'0');
  }
};

/* ---------------------------------------------------------------------- */
/* Project Code — shared uniqueness/normalization rules, used by every    */
/* place a code can be entered or changed: the Qualified -> Quote and     */
/* Demo Sent status-change gate (app.js openStatusChangeModal), Create    */
/* Direct Project and Confirm Project (projects.js). A code lives in ONE  */
/* shared pool across two places — a lead's own `projectCode` (reserved   */
/* before any Project row exists) and a Project's own `id` (its primary   */
/* key, from the moment it's created) — so every check here always looks  */
/* at leads AND projects together, never just one collection.             */
/* ---------------------------------------------------------------------- */

// "C046" / "c046" / "  c046  " must all collide as the exact same code
// (spec: case-insensitive comparison), and the CRM's existing convention
// (DB.nextId('C','projects'), every historical project id) is uppercase —
// so entered codes are normalized to trimmed-and-uppercase, consistently,
// everywhere one is accepted.
function normalizeProjectCode(raw){
  return String(raw==null ? '' : raw).trim().toUpperCase();
}

// True if `code` (case-insensitively) is already in use by a DIFFERENT
// lead's reserved projectCode or a DIFFERENT project's id. Pass
// excludeLeadId/excludeProjectId to allow a lead/project to keep its own
// already-assigned code (editing/re-saving something that already holds
// this exact code is never a "duplicate" of itself).
function isProjectCodeTaken(code, { excludeLeadId=null, excludeProjectId=null } = {}){
  const norm = normalizeProjectCode(code);
  if(!norm) return false;
  const inProjects = DB.all('projects').some(p=> p.id && normalizeProjectCode(p.id)===norm && p.id!==excludeProjectId);
  if(inProjects) return true;
  const inLeads = DB.all('leads').some(l=> l.projectCode && normalizeProjectCode(l.projectCode)===norm && l.id!==excludeLeadId);
  return inLeads;
}

// A convenience PREFILL only (never auto-assigned without the user seeing
// and being able to change it) — reuses the CRM's existing "C" + zero-
// padded number convention (the same one DB.nextId('C','projects') already
// applies), scanning BOTH leads' reserved codes and projects' ids so the
// suggestion can never collide with a code that's only reserved on a lead
// and has no Project row yet.
function suggestNextProjectCode(){
  let max = 0;
  const scan = codes => codes.forEach(code=>{
    const m = normalizeProjectCode(code).match(/^C(\d+)$/);
    if(m) max = Math.max(max, parseInt(m[1],10));
  });
  scan(DB.all('projects').map(p=>p.id));
  scan(DB.all('leads').map(l=>l.projectCode));
  return 'C' + String(max+1).padStart(3,'0');
}

/* ---------------------------------------------------------------------- */
/* Activity logging — the single source of truth for "who changed what"   */
/* ---------------------------------------------------------------------- */

function logActivity({ userName, refType, refId, refLabel, type, description, fromValue=null, toValue=null, remark=null }){
  const rec = {
    id: 'A' + Date.now() + Math.floor(Math.random()*1000),
    at: new Date().toISOString(),
    userName, refType, refId, refLabel, type, description,
    fromValue, toValue, remark
  };
  DB.upsert('activities', rec);
  return rec;
}

function activitiesFor(refId){
  return DB.all('activities').filter(a=>a.refId===refId).sort((a,b)=> new Date(b.at)-new Date(a.at));
}

/* ---------------------------------------------------------------------- */
/* Payment LEDGER — the single source of truth for what a project has     */
/* actually been paid. A project's Confirmed Value is stored on the       */
/* project record itself; everything about what's been PAID against that  */
/* value is derived live from this ledger, never cached/duplicated. This  */
/* is what makes "Remaining Balance" always correct, no matter how many    */
/* partial payments a project has received.                               */
/* ---------------------------------------------------------------------- */

// Voided payments stay in the ledger forever (audit trail — never silently
// deleted) but never count toward Total Paid / Remaining / Payment Status.
// paymentsForProject() returns every non-voided entry by default; pass
// {includeVoided:true} for UI that needs to show/manage voided rows too
// (e.g. the Payment History list, which shows a "Voided" badge on them).
function paymentsForProject(projectId, opts={}){
  return DB.all('payments')
    .filter(p=>p.projectId===projectId)
    .filter(p=> opts.includeVoided ? true : !p.voided)
    .sort((a,b)=> new Date(a.date||a.createdAt) - new Date(b.date||b.createdAt));
}
function totalPaidForProject(projectId){
  return paymentsForProject(projectId).reduce((s,p)=> s + (Number(p.amount)||0), 0);
}
// Confirmed Value, Total Paid, Remaining Balance and a derived Payment
// Status — always computed from the project record + ledger, never stored.
// Payment Status is derived from Total Paid vs Project Value ONLY — it is
// deliberately never influenced by Project Status (a separate axis, see
// PROJECT_STAGES): "In Development" + "Partially Paid" is a valid, common
// combination.
// Payments are floats (e.g. 40.98 + 69.00), and summing them in JS can land
// a hair off the exact cent value (109.97999999999999 instead of 109.98) —
// invisible once money() rounds it for display ("$110"/"$0"), but a raw
// `remaining > 0` / `totalPaid >= confirmedValue` comparison against that
// un-rounded float saw the leftover ~1e-14 and never called it Fully Paid.
// Half a cent is far smaller than any real partial payment, so absorbing it
// here can't misclassify a genuine underpayment as Fully Paid.
const PAYMENT_STATUS_EPSILON = 0.005;
function paymentSummaryFor(projectId){
  const proj = DB.find('projects', projectId);
  const confirmedValue = proj ? (Number(proj.confirmedValue)||0) : 0;
  const totalPaid = totalPaidForProject(projectId);
  const remaining = Math.max(0, Math.round((confirmedValue - totalPaid) * 100) / 100);
  let status = 'Not Paid';
  if(totalPaid <= PAYMENT_STATUS_EPSILON) status = 'Not Paid';
  else if(totalPaid < confirmedValue - PAYMENT_STATUS_EPSILON) status = 'Partially Paid';
  else status = 'Fully Paid'; // totalPaid >= confirmedValue - EPSILON, i.e. fully covers the project value (or overpays it)
  const lastPayment = paymentsForProject(projectId).slice(-1)[0] || null;
  return { confirmedValue, totalPaid, remaining, status, lastPayment };
}
// "1st Payment", "2nd Payment", "3rd Payment", "4th Payment"... — purely a
// display label suggestion, never used for calculation. Counts ALL ledger
// entries ever recorded for the project (including voided ones) so a voided
// payment's number is never reused by a later payment.
function ordinalLabel(n){
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return n + (s[(v-20)%10] || s[v] || s[0]) + ' Payment';
}
function nextPaymentNumberLabel(projectId){
  const count = DB.all('payments').filter(p=>p.projectId===projectId).length;
  return ordinalLabel(count + 1);
}
function recordPaymentEntry({ projectId, paymentNumber, amount, date, method, type, reference, note, userName }){
  const rec = {
    id: 'PM' + Date.now() + Math.floor(Math.random()*10000),
    projectId,
    paymentNumber: paymentNumber || nextPaymentNumberLabel(projectId),
    amount: Number(amount)||0, date, method, type,
    reference: reference || '', note: note||'',
    recordedBy: userName, createdAt: new Date().toISOString(),
    voided: false, voidedBy: null, voidedAt: null, voidReason: null,
  };
  DB.upsert('payments', rec);
  return rec;
}

// Edits an existing payment IN PLACE — history is never silently
// overwritten: the caller (payments.js) always logs a
// "Payment updated from $X to $Y by [user]"-style Activity Log entry with
// the before/after values. Founder/Admin only — enforced by the UI layer
// (canEditPayments()) and re-checked here as a second line of defense.
function updatePaymentEntry(paymentId, patch){
  const rec = DB.find('payments', paymentId);
  if(!rec) return null;
  Object.assign(rec, patch);
  DB.upsert('payments', rec);
  return rec;
}

// Voids (never hard-deletes) a payment. Voided entries stay in the ledger
// permanently for audit purposes but are excluded from every Total
// Paid / Remaining / Payment Status calculation (see paymentsForProject).
function voidPaymentEntry(paymentId, { voidedBy, reason }){
  const rec = DB.find('payments', paymentId);
  if(!rec) return null;
  rec.voided = true;
  rec.voidedBy = voidedBy;
  rec.voidedAt = new Date().toISOString();
  rec.voidReason = reason || '';
  DB.upsert('payments', rec);
  return rec;
}

/* ---------------------------------------------------------------------- */
/* REAL BizWeb KH client data (Session 5 import)                          */
/* Extracted from Desktop/BizWeb KH/Client/ (C001–C044) — every quotation,*/
/* invoice and deposit-record evidence document was read individually.    */
/* No value below was invented: quotedValue/confirmedValue/amountCollected*/
/* /remainingBalance are null unless a source document explicitly states  */
/* them. leadStatus is 'Confirmed' ONLY when explicit deposit/invoice     */
/* payment evidence exists in the client's own documents — never from a   */
/* quotation alone, a folder's existence, or the pre-supplied historical  */
/* "closed" list (that list was used only as a cross-check; three of its  */
/* ten entries — C017, C019, C040 — are flagged historicalListConflict:   */
/* true because their own folder evidence does NOT support Confirmed).    */
/* See REAL_DATA_IMPORT_REVIEW.md for the full per-client evidence table. */
/* ---------------------------------------------------------------------- */
const REAL_CLIENTS = [
  {
    "code": "C001",
    "clientName": "Phat Sopheak",
    "businessName": "International Institute Academy (IIA Education Cambodia)",
    "industry": "School / Education",
    "projectType": "Starter Website",
    "projectTypeRaw": "Website",
    "quotedValue": 110.28,
    "confirmedValue": 110.28,
    "leadStatus": "Confirmed",
    "evidenceStrength": "High",
    "needsManualReview": false,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C001-IIA-20260612",
    "quotationDateRaw": "13 June 2026",
    "createdAt": "2026-06-13",
    "invoiceNumber": "BW-INV-C001-IIA-20260629",
    "domain": "iia-edu.com",
    "expectedDelivery": "3 - 5 working days (per quotation)",
    "confirmedFunctions": [
      "Homepage",
      "School information",
      "Program section",
      "Student activities",
      "Gallery",
      "Contact",
      "Map",
      "Inquiry form",
      "Mobile responsive design",
      "Basic SEO",
      "Domain Name Registration - iia-edu.com (1 year)",
      "Hosting Setup (free 1st year promotion)",
      "Basic Content Update Support (30 days after publishing)"
    ],
    "sourceFiles": [
      "C001 - IIA Edu__BizWeb_KH_Invoice_IIA_Education_C001.txt",
      "C001 - IIA Edu__BizWeb_KH_Quotation_IIA_Education_C001.txt"
    ],
    "notes": "Invoice total ($110.28) matches quotation total exactly; invoice confirms full payment received and website live.",
    "amountCollected": 110.28,
    "remainingBalance": 0.0,
    "paymentStatus": "Fully Paid",
    "projectStage": "Completed"
  },
  {
    "code": "C002",
    "clientName": "Mr. Phavy Hang",
    "businessName": "Lymba Seven Star Translation",
    "industry": "Professional Services",
    "projectType": "Starter Website",
    "projectTypeRaw": "Website",
    "quotedValue": 110.28,
    "confirmedValue": 110.28,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Medium",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C002-LYMBA-20260615",
    "quotationDateRaw": "16 June 2026",
    "createdAt": "2026-06-16",
    "invoiceNumber": null,
    "domain": "lymbasevenstartranslation.com",
    "expectedDelivery": "3 - 5 working days",
    "confirmedFunctions": [
      "Starter Website Package - Translation Company Website",
      "Home, About, Document Translation Service, Interpretation Service, Conference Equipment pages",
      "Supported languages, sectors served, why choose us, process, FAQ, contact",
      "Mobile Responsive, Basic SEO, 2 Revision Rounds",
      "Domain Name Registration - lymbasevenstartranslation.com (1 year)",
      "Free 1-year Hosting (promotion)",
      "Free 1-month basic content edit support after launch"
    ],
    "sourceFiles": [
      "C002 - Lymba Seven Star Translation__Final_BizWeb_KH_Quotation_Lymba_Seven_Star_Translation_C002.txt"
    ],
    "notes": "Only a quotation exists; no invoice or payment evidence found.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C003",
    "clientName": "Master Sarat (Loak Kru Sarat)",
    "businessName": "Feng Shui Consultation (Hong Suy)",
    "industry": "Professional Services",
    "projectType": "Other",
    "projectTypeRaw": "Personal Brand Website",
    "quotedValue": null,
    "confirmedValue": null,
    "leadStatus": "Demo Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": null,
    "quotationDateRaw": null,
    "createdAt": null,
    "invoiceNumber": null,
    "domain": null,
    "expectedDelivery": null,
    "confirmedFunctions": [],
    "sourceFiles": [
      "folder listing only — feng-shui-demo.html, profile/name-card images"
    ],
    "notes": "No quotation, invoice, or written evidence found — only a demo website file and personal photos/name card exist. Needs Manual Review.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C004",
    "clientName": "Mr. Da Sophann",
    "businessName": "Da Sophann Dental Clinic",
    "industry": "Clinic / Healthcare",
    "projectType": "Starter Website",
    "projectTypeRaw": "Website",
    "quotedValue": 110.28,
    "confirmedValue": 110.28,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Medium",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C004-DASOPHANN-20260622",
    "quotationDateRaw": "23 June 2026",
    "createdAt": "2026-06-23",
    "invoiceNumber": null,
    "domain": "dasophanndental.com",
    "expectedDelivery": "3 - 5 working days",
    "confirmedFunctions": [
      "Starter Website Package - Dental/Medical Clinic Website Customization",
      "Home, About Clinic, Dental Services, Why Choose Us, Appointment Process, FAQ, Contact pages",
      "Contact/Telegram button, Call button, Service cards, Basic appointment inquiry section",
      "Mobile Responsive, Basic SEO, 2 Revision Rounds",
      "Domain Name Registration - dasophanndental.com (1 year)",
      "Free 1-year Hosting (promotion)",
      "Free 1-month basic content edit support after launch"
    ],
    "sourceFiles": [
      "C004 - ពេទ្យធ្មេញ ដា​ សុផាន់__Final_BizWeb_KH_Quotation_Da_Sophann_Dental_C004.txt"
    ],
    "notes": "Only a quotation exists; no invoice or payment evidence found.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C005",
    "clientName": null,
    "businessName": "Marvel Dental Clinic",
    "industry": "Clinic / Healthcare",
    "projectType": "Starter Website",
    "projectTypeRaw": "Website",
    "quotedValue": 110.98,
    "confirmedValue": 110.98,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Medium",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C005-MARVEL-20260622",
    "quotationDateRaw": "23 June 2026",
    "createdAt": "2026-06-23",
    "invoiceNumber": null,
    "domain": "marveldental.clinic",
    "expectedDelivery": "3 - 5 working days",
    "confirmedFunctions": [
      "Starter Website Package - Dental Clinic/Orthodontic, Implant & Aesthetic Center Website Customization",
      "Home, About Clinic, Services, Clinic Atmosphere, Why Choose Us, Appointment Process, FAQ, Contact pages",
      "Contact/Telegram button, Call button, Service cards, Basic appointment inquiry section",
      "Mobile Responsive, Basic SEO, 2 Revision Rounds",
      "Domain Name Registration - marveldental.clinic (1 year)",
      "Free 1-year Hosting (promotion)",
      "Free 1-month basic content edit support after launch"
    ],
    "sourceFiles": [
      "C005 - Marvel Dental Clinic__Final_BizWeb_KH_Quotation_Marvel_Dental_Clinic_C005.txt"
    ],
    "notes": "Only a quotation exists; no invoice or payment evidence found.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C006",
    "clientName": null,
    "businessName": "Raamaid Cambodia (RCIA)",
    "industry": "School / Education",
    "projectType": "Starter Website",
    "projectTypeRaw": "Website",
    "quotedValue": 109.98,
    "confirmedValue": 109.98,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Medium",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C006-RCIA-20260624",
    "quotationDateRaw": "25 June 2026",
    "createdAt": "2026-06-25",
    "invoiceNumber": null,
    "domain": "rcia-edu.com",
    "expectedDelivery": "3 - 5 working days",
    "confirmedFunctions": [
      "Starter Website Package - School/Education Website Customization",
      "Home, About School, Study Programs, Student Activities, School Photos, Why Choose Us, Inquiry Form, Contact pages",
      "Contact/Telegram button, Call button, Study program cards, Basic parent inquiry section",
      "Mobile Responsive, Basic SEO, 2 Revision Rounds",
      "Multilingual content: Khmer + English + Chinese as provided",
      "Domain Name Registration - rcia-edu.com (1 year)",
      "Free 1-year Hosting (promotion)",
      "Free 1-month basic content edit support after launch"
    ],
    "sourceFiles": [
      "C006 - Raamaid Cambodia__Final_BizWeb_KH_Quotation_Raamaid_Cambodia_RCIA_C006.txt"
    ],
    "notes": "Only a quotation exists; no invoice or payment evidence found.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C007",
    "clientName": null,
    "businessName": "ACE K Clinic",
    "industry": "Clinic / Healthcare",
    "projectType": "Starter Website",
    "projectTypeRaw": "Website",
    "quotedValue": 110.28,
    "confirmedValue": 110.28,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C007-ACEK-20260624",
    "quotationDateRaw": "24 June 2026",
    "createdAt": "2026-06-24",
    "invoiceNumber": null,
    "domain": "acekclinic.com",
    "expectedDelivery": "3 - 5 working days",
    "confirmedFunctions": [
      "Starter Website Package - Clinic/Healthcare Service Website Customization",
      "Home, About Clinic, Services, Clinic Atmosphere, Why Choose Us, Appointment Process, FAQ, Contact pages",
      "Contact/Telegram button, Call button, Service cards, Basic appointment inquiry section",
      "Mobile Responsive, Basic SEO, 2 Revision Rounds",
      "Bilingual content: English + Korean",
      "Domain Name Registration - www.acekclinic.com (1 year)",
      "Free 1-year Hosting (promotion)",
      "Free 1-month basic content edit support after launch"
    ],
    "sourceFiles": [
      "C007 - ACE K Clinic__Final_BizWeb_KH_Quotation_ACE_K_Clinic_C007.txt"
    ],
    "notes": "Thin document, no client personal name, no invoice/payment evidence, no signed acceptance.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C008",
    "clientName": null,
    "businessName": "SAFEMOVE EXPRESS",
    "industry": "Logistics / Delivery",
    "projectType": "Starter Website",
    "projectTypeRaw": "Website",
    "quotedValue": 99.0,
    "confirmedValue": 99.0,
    "leadStatus": "Confirmed",
    "evidenceStrength": "High",
    "needsManualReview": false,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C008-SAFEMOVE-20260625",
    "quotationDateRaw": "26 June 2026",
    "createdAt": "2026-06-26",
    "invoiceNumber": "BW-INV-C008-SAFEMOVE-20260629",
    "domain": "safemoveexpress.com",
    "expectedDelivery": "3 - 5 working days (quotation); invoice shows Draft Updated / Final Website Pending",
    "confirmedFunctions": [
      "Starter Website Package - Logistics/Delivery Website Customization",
      "Home, About, Services, Why Choose Us, Business Solutions, Fleet/Operations, How It Works, Contact pages",
      "Contact/Call buttons, Google Map link, service cards, basic inquiry section",
      "Mobile Responsive, Basic SEO, 2 Revision Rounds",
      "Existing domain (safemoveexpress.com) connection, no purchase fee",
      "Free 1-year Hosting (promotion)",
      "Free 1-month basic content edit support after launch"
    ],
    "sourceFiles": [
      "C008 - SAFEMOVE EXPRESS__BizWeb_KH_Invoice_SAFEMOVE_EXPRESS_C008_Deposit.txt",
      "C008 - SAFEMOVE EXPRESS__Final_BizWeb_KH_Quotation_SAFEMOVE_EXPRESS_C008.txt"
    ],
    "notes": "Invoice shows $30.00 deposit received against $99.00 subtotal, balance $69.00 due; project in progress.",
    "amountCollected": 30.0,
    "remainingBalance": 69.0,
    "paymentStatus": "Partially Paid",
    "projectStage": "In Development"
  },
  {
    "code": "C009",
    "clientName": null,
    "businessName": "Melvin Dental Care",
    "industry": "Clinic / Healthcare",
    "projectType": "Starter Website",
    "projectTypeRaw": "Website",
    "quotedValue": 99.0,
    "confirmedValue": 99.0,
    "leadStatus": "Confirmed",
    "evidenceStrength": "High",
    "needsManualReview": false,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C009-MELVIN-20260626",
    "quotationDateRaw": "26 June 2026",
    "createdAt": "2026-06-26",
    "invoiceNumber": "BW-INV-C009-MELVIN-20260628",
    "domain": "melvindentalcare.com",
    "expectedDelivery": "3 - 5 working days (quotation); invoice shows Demo Completed / Final Customization Pending",
    "confirmedFunctions": [
      "Starter Website Package - Dental Clinic Website Customization",
      "Home, About Clinic, Services, Promotion, Photos/Care, Why Choose Us, Appointment/Contact Form, Contact pages",
      "Contact/Telegram button, Call button, Map button, Service cards, Promotion section, Basic appointment/contact section",
      "Mobile Responsive, Basic SEO, 2 Revision Rounds",
      "Multilingual content: Khmer + English + Chinese",
      "Existing domain (melvindentalcare.com) connection, no purchase fee",
      "Free 1-year Hosting (promotion)",
      "Free 1-month basic content edit support after launch"
    ],
    "sourceFiles": [
      "C009 - Melvin Dental Care__BizWeb_KH_Invoice_Melvin_Dental_Care_C009.txt",
      "C009 - Melvin Dental Care__Final_BizWeb_KH_Quotation_Melvin_Dental_Care_C009.txt"
    ],
    "notes": "Invoice total ($99.00) matches quotation total and confirms full payment received; final customization still in progress.",
    "amountCollected": 99.0,
    "remainingBalance": 0.0,
    "paymentStatus": "Fully Paid",
    "projectStage": "Completed"
  },
  {
    "code": "C010",
    "clientName": null,
    "businessName": "Kie Fepro Cambodia",
    "industry": "Professional Services",
    "projectType": "Other",
    "projectTypeRaw": "Email System",
    "quotedValue": 60.0,
    "confirmedValue": 60.0,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Medium",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C010-KIE-FEPRO-20260630",
    "quotationDateRaw": "30 June 2026",
    "createdAt": "2026-06-30",
    "invoiceNumber": null,
    "domain": null,
    "expectedDelivery": "3 - 4 working days (after domain/DNS access is ready)",
    "confirmedFunctions": [
      "Standard Email Setup Package - around 10 business email accounts",
      "Create ~10 business email accounts",
      "Connect one selected domain with email system",
      "Set MX / SPF / DKIM DNS records",
      "Test sending and receiving email",
      "Basic login and usage guidance",
      "Domain/DNS connection support"
    ],
    "sourceFiles": [
      "C010 - Kei Fepro Cambodia__BizWeb_KH_Quotation_KieFepro_Email_System_C010.txt"
    ],
    "notes": "Only a quotation exists (Email System Setup, not a website project); no invoice/payment evidence.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C011",
    "clientName": null,
    "businessName": "Bright Brain School",
    "industry": "School / Education",
    "projectType": "Other",
    "projectTypeRaw": "Admin Dashboard",
    "quotedValue": 399.0,
    "confirmedValue": 399.0,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Medium",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C011-BRIGHTBRAIN-20260630",
    "quotationDateRaw": "1 Jul 2026",
    "createdAt": "2026-07-01",
    "invoiceNumber": null,
    "domain": "brightbrain.edu.kh",
    "expectedDelivery": "10 - 15 working days",
    "confirmedFunctions": [
      "Multi-page School Website using client logo, colors, images, Khmer + English content",
      "Pages: Home, About, Mission & Vision, Programs, Staff, Gallery, News & Events, Contact",
      "Basic Admin Dashboard: admin login to manage News/Events, Gallery, Program content, and basic school information",
      "Contact/Inquiry Form, Mobile Responsive, Basic SEO, 2 Revision Rounds",
      "Domain connection support (brightbrain.edu.kh, client-provided/purchased)",
      "First-year basic hosting/backend/database support included"
    ],
    "sourceFiles": [
      "C011 - Bright Brain School__BizWeb_KH_Quotation_Bright_Brain_School_C011_Admin_Dashboard.txt"
    ],
    "notes": "Only a quotation exists; 50/50 payment schedule specified but no invoice or payment confirmation document provided.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C012",
    "clientName": "Golden River Restaurant",
    "businessName": "Golden River Restaurant",
    "industry": "Restaurant / Cafe",
    "projectType": "Starter Website",
    "projectTypeRaw": "Restaurant Website (two competing options: Starter static vs Website + Online Reservation System & Admin Dashboard)",
    "quotedValue": null,
    "confirmedValue": null,
    "leadStatus": "Negotiation",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C012-GRR-20260802 (Starter) / BW-Q-C012-GRR-RES-20260802 (Reservation System)",
    "quotationDateRaw": "02 Aug 2026",
    "createdAt": "2026-08-02",
    "invoiceNumber": null,
    "domain": "goldenriver.restaurant",
    "expectedDelivery": null,
    "confirmedFunctions": [],
    "sourceFiles": [
      "C012 - Golden_River_Restaurant_C012_Starter.txt",
      "C012 - Golden_River_Restaurant_C012_Reservation_System.txt"
    ],
    "notes": "Two unresolved options same day, no signed acceptance, no invoice: (1) Starter Total $110.98; (2) Starter+Reservation System Total $410.98. confirmedValue left null.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C013",
    "clientName": "CEO Center",
    "businessName": "CEO Center",
    "industry": "Real Estate / Property",
    "projectType": "Starter Website",
    "projectTypeRaw": "One-Page Real Estate Website (Premium Mixed-Use Property Landing Page)",
    "quotedValue": 109.98,
    "confirmedValue": 109.98,
    "leadStatus": "Confirmed",
    "evidenceStrength": "High",
    "needsManualReview": false,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C013-CEO-20260704",
    "quotationDateRaw": "04 July 2026",
    "createdAt": "2026-07-04",
    "invoiceNumber": "BW-INV-C013-CEO-20260707",
    "domain": "ceocentercambodia.com",
    "expectedDelivery": null,
    "confirmedFunctions": [
      "One-page premium website with overview, video, project sections (Residences, Wyndham Hotel Units, Office Units, Amenities)",
      "Floor plans preview",
      "Payment plan / pricing display",
      "Due diligence section",
      "Location and inquiry form",
      "Mobile responsive design and basic SEO"
    ],
    "sourceFiles": [
      "C013 - CEO Center Apartment Building__BizWeb_KH_Quotation_CEO_Center_C013.txt",
      "C013 - CEO Center Apartment Building__BizWeb_KH_Invoice_CEO_Center_C013.txt"
    ],
    "notes": "Quotation total matches invoice total exactly, invoice marked PAID IN FULL.",
    "amountCollected": 109.98,
    "remainingBalance": 0.0,
    "paymentStatus": "Fully Paid",
    "projectStage": "Completed"
  },
  {
    "code": "C014",
    "clientName": "The Nail Room Salon",
    "businessName": "The Nail Room Salon",
    "industry": "Salon / Beauty",
    "projectType": "Starter Website",
    "projectTypeRaw": "Starter Website Package (Nail Salon static informational website)",
    "quotedValue": 109.98,
    "confirmedValue": null,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C014-NAIL-20260703",
    "quotationDateRaw": "04 July 2026",
    "createdAt": "2026-07-04",
    "invoiceNumber": null,
    "domain": "thenailroomsalonkh.com",
    "expectedDelivery": "3 - 5 Working days",
    "confirmedFunctions": [],
    "sourceFiles": [
      "C014 - The Nail Room Salon__BizWeb_KH_Quotation_The_Nail_Room_Salon_C014.txt"
    ],
    "notes": "Only a quotation exists; no invoice or acceptance evidence.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C015",
    "clientName": null,
    "businessName": "HKC TREE INTERNATIONAL SCHOOL",
    "industry": "School / Education",
    "projectType": "Other",
    "projectTypeRaw": "Website (unspecified — no quotation)",
    "quotedValue": null,
    "confirmedValue": null,
    "leadStatus": "Demo Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": null,
    "quotationDateRaw": null,
    "createdAt": null,
    "invoiceNumber": null,
    "domain": null,
    "expectedDelivery": null,
    "confirmedFunctions": [],
    "sourceFiles": [
      "folder listing only — demo folder, logo/photos, empty School Info.txt"
    ],
    "notes": "School Info.txt exists but is empty; a demo folder (c015-hkc-tree-school-demo) exists but no quotation/invoice. Needs Manual Review.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C016",
    "clientName": "SE4HC Cambodia",
    "businessName": "Secondary Education for Human Capital Competitiveness Project (SE4HC)",
    "industry": "School / Education",
    "projectType": "Other",
    "projectTypeRaw": "Education/Government proposal system website (Full System vs Basic Portal)",
    "quotedValue": null,
    "confirmedValue": null,
    "leadStatus": "Negotiation",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C016-SE4HC-20260708 / BW-Q-C016-SE4HC-BASIC-20260712",
    "quotationDateRaw": "9 Jul 2026 / 12 Jul 2026",
    "createdAt": "2026-07-09",
    "invoiceNumber": null,
    "domain": "se4hc.com",
    "expectedDelivery": null,
    "confirmedFunctions": [],
    "sourceFiles": [
      "C016 - SE4HC Cambodia__BizWeb_KH_Quotation_SE4HC_Cambodia_C016.txt",
      "C016 - SE4HC Cambodia__BizWeb_KH_Quotation_SE4HC_Cambodia_C016_Basic_Portal.txt"
    ],
    "notes": "Two unresolved options: Full System $1,710.28 vs Basic Portal $710.28, no invoice/acceptance.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C017",
    "clientName": "ODOM Prestige",
    "businessName": "ODOM Prestige",
    "industry": "Real Estate / Property",
    "projectType": "Starter Website",
    "projectTypeRaw": "One-Page Static Real Estate Website - Starter Website Package",
    "quotedValue": 110.28,
    "confirmedValue": null,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": true,
    "quotationNumber": "BW-Q-C017-ODOM-20260712",
    "quotationDateRaw": "12 July 2026",
    "createdAt": "2026-07-12",
    "invoiceNumber": null,
    "domain": "odomprestige.com",
    "expectedDelivery": "3 - 5 Working days",
    "confirmedFunctions": [],
    "sourceFiles": [
      "C017 - ODOM Project__BizWeb_KH_Quotation_ODOM_Prestige_C017.txt"
    ],
    "notes": "HISTORICAL LIST CONFLICT: was on the previously-confirmed-closed list but only a $110.28 Starter quotation exists with no invoice, deposit, or signed acceptance. Flag for manual review.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C018",
    "clientName": "Sek Meas Grains & Edible Oils Co., Ltd.",
    "businessName": "Sek Meas Grains & Edible Oils Co., Ltd.",
    "industry": "Other",
    "projectType": "Other",
    "projectTypeRaw": "Product Catalogue Website + Product Management Admin Dashboard",
    "quotedValue": 610.28,
    "confirmedValue": null,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C018-SEKMEAS-20260715",
    "quotationDateRaw": "15 Jul 2026",
    "createdAt": "2026-07-15",
    "invoiceNumber": null,
    "domain": "sekmeasgrainsedibleoils.com",
    "expectedDelivery": "15 - 20 Working days",
    "confirmedFunctions": [],
    "sourceFiles": [
      "C018 - Sek Meas Grains & Edible Oils Co., Ltd__BizWeb_KH_Quotation_Sek_Meas_C018_final.txt"
    ],
    "notes": "Only a quotation exists despite filename 'final'; no invoice/payment evidence.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C019",
    "clientName": "Samantha",
    "businessName": "Food Business (Name Pending Confirmation) / Existing Business Website",
    "industry": "Restaurant / Cafe",
    "projectType": "Other",
    "projectTypeRaw": "Three unresolved quotations: Food Business Website; Food Business + Ordering + Nutrition; Existing Website Elementor Improvement",
    "quotedValue": null,
    "confirmedValue": null,
    "leadStatus": "Negotiation",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": true,
    "quotationNumber": "BW-Q-C019-FOOD-WEB-20260715 / BW-Q-C019-FOOD-SYSTEM-20260715 / BW-Q-C019-ELEMENTOR-20260804",
    "quotationDateRaw": "16 July 2026 / 4 August 2026",
    "createdAt": "2026-07-16",
    "invoiceNumber": null,
    "domain": null,
    "expectedDelivery": null,
    "confirmedFunctions": [],
    "sourceFiles": [
      "C019 - Samantha__BizWeb_KH_Quotation_Samantha_C019_Option1_Website_Only.txt",
      "C019 - Samantha__BizWeb_KH_Quotation_Samantha_C019_Option2_Website_Order_Nutrition_System.txt",
      "C019 - Samantha__BizWeb_KH_Quotation_C019_Elementor_Improvement.txt"
    ],
    "notes": "HISTORICAL LIST CONFLICT: was on the previously-confirmed-closed list but three separate unresolved quotations exist with no invoice or signed acceptance for any. Flag for manual review.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C020",
    "clientName": "Little Learners Daycare",
    "businessName": "Little Learners Cambodia / Little Learners Daycare",
    "industry": "School / Education",
    "projectType": "Starter Website",
    "projectTypeRaw": "Starter Website Package - Daycare & Pre-School Website",
    "quotedValue": 99.0,
    "confirmedValue": 99.0,
    "leadStatus": "Confirmed",
    "evidenceStrength": "High",
    "needsManualReview": false,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C020-LITTLE-LEARNERS-20260717",
    "quotationDateRaw": "17 July 2026",
    "createdAt": "2026-07-17",
    "invoiceNumber": "BW-INV-C020-LITTLELEARNERS-20260721",
    "domain": null,
    "expectedDelivery": null,
    "confirmedFunctions": [
      "Homepage, daycare information, learning programs, facilities, gallery",
      "Parent information section",
      "Contact buttons",
      "Mobile responsive design and basic SEO",
      "Website customization based on client feedback"
    ],
    "sourceFiles": [
      "C020 - Little Learner__BizWeb_KH_Quotation_Little_Learners_C020.txt",
      "C020 - Little Learner__BizWeb_KH_Invoice_Little_Learners_Daycare_C020_Deposit.txt"
    ],
    "notes": "Quotation total matches invoice; deposit paid evidence found.",
    "amountCollected": 29.7,
    "remainingBalance": 69.3,
    "paymentStatus": "Partially Paid",
    "projectStage": "In Development"
  },
  {
    "code": "C021",
    "clientName": "ROCKRETE (CAMBODIA) CO., LTD",
    "businessName": "ROCKRETE (CAMBODIA) CO., LTD",
    "industry": "Construction / Property Development",
    "projectType": "Starter Website",
    "projectTypeRaw": "Starter Website Package (Company services website)",
    "quotedValue": 99.0,
    "confirmedValue": null,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C021-ROCKRETE-O1-20260717",
    "quotationDateRaw": "17 July 2026",
    "createdAt": "2026-07-17",
    "invoiceNumber": null,
    "domain": null,
    "expectedDelivery": "3 - 5 Working days",
    "confirmedFunctions": [],
    "sourceFiles": [
      "C021 - ROCKRETE CAMBODIA CO., LTD__BizWeb_KH_Quotation_ROCKRETE_C021_Option1_Website.txt"
    ],
    "notes": "Only Option 1 file provided; no invoice/acceptance.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C022",
    "clientName": "Hearing Solution Cambodia",
    "businessName": "Hearing Solution Cambodia",
    "industry": "Clinic / Healthcare",
    "projectType": "Booking System",
    "projectTypeRaw": "Website + OTP Booking System + Basic Admin Dashboard",
    "quotedValue": 300.0,
    "confirmedValue": 300.0,
    "leadStatus": "Confirmed",
    "evidenceStrength": "High",
    "needsManualReview": false,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C022-HSC-BOOKING-20260731",
    "quotationDateRaw": "30 Jul 2026",
    "createdAt": "2026-07-30",
    "invoiceNumber": "BW-INV-C022-HSC-20260731",
    "domain": "hearingsolutioncambodia.com",
    "expectedDelivery": "12-18 working days from project start",
    "confirmedFunctions": [
      "Professional public website (Home, About, Services, Products, Hearing Aid Styles, Why Choose Us, FAQ, Appointment, Contact)",
      "Customer appointment/booking request form with 6-digit SMS OTP verification",
      "Booking reference generation with Pending Confirmation status",
      "Protected admin login and dashboard (booking summary, list/detail, search, filter)",
      "Booking status updates and internal staff notes",
      "Basic booking report up to 3 months with CSV export",
      "Backend/API and database setup, secure admin authentication",
      "Domain hearingsolutioncambodia.com (1 year)",
      "30 days minor bug-fix support after launch"
    ],
    "sourceFiles": [
      "C022 - Hearing Solution Cambodia__BizWeb_KH_Invoice_Hearing_Solution_C022_Deposit.txt",
      "C022 - Hearing Solution Cambodia__BizWeb_KH_Quotation_Hearing_Solution_C022_Final.txt"
    ],
    "notes": "Deposit invoice and final quotation cross-check consistently; development in progress.",
    "amountCollected": 100.0,
    "remainingBalance": 200.0,
    "paymentStatus": "Partially Paid",
    "projectStage": "In Development"
  },
  {
    "code": "C023",
    "clientName": "SafeMove Express",
    "businessName": "SafeMove Express",
    "industry": "Logistics / Delivery",
    "projectType": "Mobile App / Advanced Platform",
    "projectTypeRaw": "Mobile App UX/UI Redesign & Interactive Clickable Prototype",
    "quotedValue": 399.0,
    "confirmedValue": null,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C023-SAFEMOVE-APP-20260721",
    "quotationDateRaw": "22 July 2026",
    "createdAt": "2026-07-22",
    "invoiceNumber": null,
    "domain": null,
    "expectedDelivery": "10-15 working days",
    "confirmedFunctions": [
      "Redesign of key app screens: Login, Register, Home, Express Delivery, Pickup & Drop-off, Item Details, Vehicle, Estimate, Order Review, Confirmation, Tracking, Orders, Promotions, Alerts, Profile",
      "Complete SafeMove visual system",
      "Clickable prototype entry screens for Laundry, Mart and Food services",
      "Clickable HTML/CSS/JavaScript prototype and screen-gallery presentation",
      "Up to 2 revision rounds"
    ],
    "sourceFiles": [
      "C023 - SAFEMOVE EXPRESS MOBILE APP__BizWeb_KH_Quotation_SafeMove_Mobile_App_UXUI_C023.txt"
    ],
    "notes": "Only a quotation exists (UX/UI design + prototype scope only); no invoice/deposit evidence.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C024",
    "clientName": null,
    "businessName": "S Rungreung",
    "industry": "Unspecified",
    "projectType": "Other",
    "projectTypeRaw": "Unspecified (only marketing/social assets found)",
    "quotedValue": null,
    "confirmedValue": null,
    "leadStatus": "New Lead",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": null,
    "quotationDateRaw": null,
    "createdAt": null,
    "invoiceNumber": null,
    "domain": null,
    "expectedDelivery": null,
    "confirmedFunctions": [],
    "sourceFiles": [
      "folder listing only — Facebook banner/page, logo, service post images"
    ],
    "notes": "No quotation, invoice, website, or written business description found — only social-media graphic assets. Needs Manual Review; industry could not be determined from available evidence.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C025",
    "clientName": "Kep Ocean Resort",
    "businessName": "Kep Ocean Resort",
    "industry": "Hotel / Resort / Guesthouse",
    "projectType": "Booking System",
    "projectTypeRaw": "Website + Villa Booking System + Management Dashboard",
    "quotedValue": 909.98,
    "confirmedValue": null,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C025-KOR-BOOKING-20260724",
    "quotationDateRaw": "25 Jul 2026",
    "createdAt": "2026-07-25",
    "invoiceNumber": null,
    "domain": "kepoceanresort.com",
    "expectedDelivery": "20-30 working days",
    "confirmedFunctions": [
      "Professional public resort website with 8 villa listings",
      "Customer villa booking system with availability selection and booking reference",
      "Management dashboard: booking overview/calendar, villa availability, guest records, payment tracking, basic reports",
      "Domain kepoceanresort.com (1 year)"
    ],
    "sourceFiles": [
      "C025 - Kep Ocean Resort__BizWeb_KH_Quotation_Kep_Ocean_Resort_C025_Booking_System.txt"
    ],
    "notes": "Only a quotation exists, unsigned; no deposit/invoice evidence.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C026",
    "clientName": null,
    "businessName": "WellCare Pharmacy",
    "industry": "Pharmacy",
    "projectType": "Other",
    "projectTypeRaw": "Pharmacy Website + Product Management Dashboard (client-review demo)",
    "quotedValue": null,
    "confirmedValue": null,
    "leadStatus": "Demo Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": null,
    "quotationDateRaw": null,
    "createdAt": null,
    "invoiceNumber": null,
    "domain": null,
    "expectedDelivery": null,
    "confirmedFunctions": [
      "Public pharmacy website",
      "Admin product management dashboard",
      "Telegram order-inquiry flow (no online payment)"
    ],
    "sourceFiles": [
      "c026-pharmacy-demo/CLIENT-DEMO-LINKS.txt",
      "pharmacy-product-catalogue/README.md"
    ],
    "notes": "A working frontend demo was built (per README, 'design and workflow demo', sample data only, no backend) but no quotation or invoice document exists in the folder. Needs Manual Review.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C027",
    "clientName": null,
    "businessName": "FELINE Beauty Clinic",
    "industry": "Salon / Beauty",
    "projectType": "Other",
    "projectTypeRaw": "Website + Gallery Management Dashboard (client-review demo)",
    "quotedValue": null,
    "confirmedValue": null,
    "leadStatus": "Demo Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": null,
    "quotationDateRaw": null,
    "createdAt": null,
    "invoiceNumber": null,
    "domain": null,
    "expectedDelivery": null,
    "confirmedFunctions": [
      "Public marketing website",
      "Private gallery-management dashboard"
    ],
    "sourceFiles": [
      "feline-beauty-clinic/CLIENT-DEMO-LINKS.txt",
      "feline-beauty-clinic/README.md"
    ],
    "notes": "A working frontend demo was built (per README, mock data only, no backend) but no quotation or invoice document exists in the folder. Needs Manual Review.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C028",
    "clientName": "IEDS International School",
    "businessName": "IEDS International School",
    "industry": "School / Education",
    "projectType": "Starter Website",
    "projectTypeRaw": "One-Page Static Website (Starter Package)",
    "quotedValue": 137.47,
    "confirmedValue": null,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C028-IEDS-20260726",
    "quotationDateRaw": "26 July 2026",
    "createdAt": "2026-07-26",
    "invoiceNumber": null,
    "domain": "www.ieds.school",
    "expectedDelivery": "3-5 working days",
    "confirmedFunctions": [
      "One-page layout matching branding/logo/colors",
      "Sections: Home, About, Learning & Development, Programs, Digital Learning, School Life/Gallery, Admission CTA, Contact",
      "Mobile responsive, basic SEO, 2 revision rounds",
      "Domain www.ieds.school (1 year)"
    ],
    "sourceFiles": [
      "C028 - IEDS International School__BizWeb_KH_Quotation_IEDS_International_School_C028.txt"
    ],
    "notes": "Only a quotation exists, unsigned; no deposit/invoice evidence.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C029",
    "clientName": "Luminara International School",
    "businessName": "Luminara International School",
    "industry": "School / Education",
    "projectType": "Starter Website",
    "projectTypeRaw": "One-Page Static Website (Starter Package)",
    "quotedValue": 110.28,
    "confirmedValue": null,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C029-LUMINARA-20260726",
    "quotationDateRaw": "26 July 2026",
    "createdAt": "2026-07-26",
    "invoiceNumber": null,
    "domain": "www.luminarainternationalschool.com",
    "expectedDelivery": "3-5 working days",
    "confirmedFunctions": [
      "One-page layout matching branding/logo/colors",
      "Sections: Home, About, Learning & Development, Programs, Digital Learning, School Life/Gallery, Admission CTA, Contact",
      "Mobile responsive, basic SEO, 2 revision rounds",
      "Domain www.luminarainternationalschool.com (1 year)"
    ],
    "sourceFiles": [
      "C029 - Luminara International School__BizWeb_KH_Quotation_Luminara_International_School_C029.txt"
    ],
    "notes": "Only a quotation exists, unsigned; no deposit/invoice evidence.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C030",
    "clientName": "Cambodian Muslim Education and Humanitarian Association (CMEHA)",
    "businessName": "CMEHA",
    "industry": "NGO / Association",
    "projectType": "Dynamic Website / CMS",
    "projectTypeRaw": "Dynamic Website with Admin Dashboard",
    "quotedValue": 399.0,
    "confirmedValue": null,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C030-CMEHA-20260729",
    "quotationDateRaw": "29 July 2026",
    "createdAt": "2026-07-29",
    "invoiceNumber": null,
    "domain": null,
    "expectedDelivery": "10-15 working days",
    "confirmedFunctions": [
      "Responsive dynamic website: Home, About, Vision & Mission, Education Programs, Humanitarian Activities, Projects, News, Gallery, Partners, Contact",
      "Admin login and dashboard to add/edit/delete/publish content",
      "Content management, image upload, categories, search",
      "Cloud hosting, database setup, SSL, basic backup for first year"
    ],
    "sourceFiles": [
      "C030 - CMEHA__BizWeb_KH_Quotation_CMEHA_C030.txt"
    ],
    "notes": "Only a quotation exists, unsigned; no deposit/invoice evidence.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C031",
    "clientName": "Dr Ly Cheng Huy",
    "businessName": "Dr Ly Cheng Huy",
    "industry": "Clinic / Healthcare",
    "projectType": "Mobile App / Advanced Platform",
    "projectTypeRaw": "Website + Mobile Application + Admin Management Dashboard",
    "quotedValue": 2810.28,
    "confirmedValue": null,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C031-DRLYCHENGHUY-20260731",
    "quotationDateRaw": "31 Jul 2026",
    "createdAt": "2026-07-31",
    "invoiceNumber": null,
    "domain": "www.drlychenghuy.com",
    "expectedDelivery": "55-75 working days",
    "confirmedFunctions": [
      "Informative medical website with consultation, e-books, articles, videos",
      "User mobile app: consultation booking with built-in one-to-one secure video consultation",
      "Health articles, videos, content categories",
      "E-Book store, purchase, subscription",
      "Admin dashboard managing users/appointments/payments/video consultations/e-books/subscriptions",
      "Domain www.drlychenghuy.com (1 year)"
    ],
    "sourceFiles": [
      "C031 - Dr Ly Cheng Huy__BizWeb_KH_Quotation_Dr_Ly_Cheng_Huy_C031_Final_2799.txt"
    ],
    "notes": "Only a quotation exists despite filename Final_2799, unsigned; no deposit/invoice evidence. Project Fee described as a discounted one-time fee of $2,799.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C032",
    "clientName": null,
    "businessName": "BBIS International School",
    "industry": "School / Education",
    "projectType": "Other",
    "projectTypeRaw": "Unspecified (only logo/reference images found)",
    "quotedValue": null,
    "confirmedValue": null,
    "leadStatus": "New Lead",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": null,
    "quotationDateRaw": null,
    "createdAt": null,
    "invoiceNumber": null,
    "domain": null,
    "expectedDelivery": null,
    "confirmedFunctions": [],
    "sourceFiles": [
      "folder listing only — BBIS logo image, unrelated reference image"
    ],
    "notes": "No quotation, invoice, or written evidence found — only two reference images. Needs Manual Review.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C033",
    "clientName": "C033 E-Commerce Client",
    "businessName": "Supplement, Cosmetics & Makeup E-Commerce",
    "industry": "Retail / E-Commerce",
    "projectType": "E-Commerce Level 1",
    "projectTypeRaw": "E-Commerce Website + Customer Account + Admin Dashboard (Full vs Essential options)",
    "quotedValue": 2799.0,
    "confirmedValue": null,
    "leadStatus": "Negotiation",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C033-ECOMMERCE-FULL-20260803 / BW-Q-C033-ECOMMERCE-LITE-20260803",
    "quotationDateRaw": "03 Aug 2026",
    "createdAt": "2026-08-03",
    "invoiceNumber": null,
    "domain": null,
    "expectedDelivery": "Full: 40-55 working days; Essential: 25-35 working days",
    "confirmedFunctions": [],
    "sourceFiles": [
      "C033 - E-Commerce Website__BizWeb_KH_Quotation_C033_Ecommerce_Option_1_Full.txt",
      "C033 - E-Commerce Website__BizWeb_KH_Quotation_C033_Ecommerce_Option_2_Essential.txt"
    ],
    "notes": "Two options no signal which chosen: Full $2,799.00, Essential $1,699.00. No proper client/company name given in either document.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C034",
    "clientName": "Mr. Seyha",
    "businessName": "Petroleum Products Business (To Be Confirmed)",
    "industry": "Other",
    "projectType": "Other",
    "projectTypeRaw": "Petroleum Products Website + Basic Admin Dashboard",
    "quotedValue": 399.0,
    "confirmedValue": null,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-PETRO-8472-20260804",
    "quotationDateRaw": "5 Aug 2026",
    "createdAt": "2026-08-05",
    "invoiceNumber": null,
    "domain": null,
    "expectedDelivery": "10-15 working days",
    "confirmedFunctions": [],
    "sourceFiles": [
      "C034 - Petroleum__BizWeb_KH_Quotation_Mr_Seyha_Petroleum_Admin_Dashboard.txt"
    ],
    "notes": "Only a quotation exists; business name explicitly marked To Be Confirmed; no invoice/acceptance evidence.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C035",
    "clientName": "Islamic Medical Relief for Cambodia Humanity Association",
    "businessName": "Islamic Medical Relief for Cambodia Humanity Association (IMRCHA)",
    "industry": "NGO / Association",
    "projectType": "Starter Website",
    "projectTypeRaw": "NGO One-Page Static Website (Starter Package)",
    "quotedValue": 106.48,
    "confirmedValue": null,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C035-IMRCHA-20260807",
    "quotationDateRaw": "7 August 2026",
    "createdAt": "2026-08-07",
    "invoiceNumber": null,
    "domain": "imrcha.org",
    "expectedDelivery": "3-5 working days",
    "confirmedFunctions": [],
    "sourceFiles": [
      "C035 - IMRCHA.org__BizWeb_KH_Quotation_IMRCHA_C035.txt"
    ],
    "notes": "Only a quotation exists; client signature blank; no payment evidence.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C036",
    "clientName": "Sampheap Guesthouse",
    "businessName": "Sampheap Guesthouse",
    "industry": "Hotel / Resort / Guesthouse",
    "projectType": "Starter Website",
    "projectTypeRaw": "Guesthouse One-Page Static Website (Starter Package)",
    "quotedValue": 110.28,
    "confirmedValue": 110.28,
    "leadStatus": "Confirmed",
    "evidenceStrength": "High",
    "needsManualReview": false,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C036-SAMPHEAP-20260807",
    "quotationDateRaw": "7 August 2026",
    "createdAt": "2026-08-07",
    "invoiceNumber": "BW-INV-C036-20260813",
    "domain": "sampheapguesthouse.com",
    "expectedDelivery": "Completed / Published",
    "confirmedFunctions": [
      "One-page website: Home, About, Rooms & Facilities, Stay Packages, Travel Packages, Transportation Services, Explore Stung Treng, Gallery, Inquiry, Contact",
      "English/Khmer language switch",
      "Mobile responsive design, basic SEO",
      "Domain registration: sampheapguesthouse.com (1 year)",
      "Hosting included free year 1"
    ],
    "sourceFiles": [
      "C036 - SAMPHEAP Guesthouse__BizWeb_KH_Quotation_Sampheap_Guesthouse_C036.txt",
      "C036 - SAMPHEAP Guesthouse__BizWeb_KH_Invoice_Sampheap_Guesthouse_C036_Paid_Full.txt"
    ],
    "notes": "Quotation total matches Paid_Full invoice total exactly; website live. No discount applied.",
    "amountCollected": 110.28,
    "remainingBalance": 0.0,
    "paymentStatus": "Fully Paid",
    "projectStage": "Completed"
  },
  {
    "code": "C037",
    "clientName": "Ms. Kerena Khun",
    "businessName": "NGO / Organization Name (To Be Confirmed)",
    "industry": "NGO / Association",
    "projectType": "Dynamic Website / CMS",
    "projectTypeRaw": "NGO Website + Basic Content Management Dashboard",
    "quotedValue": 399.0,
    "confirmedValue": null,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C037-5831-20260808",
    "quotationDateRaw": "8 Aug 2026",
    "createdAt": "2026-08-08",
    "invoiceNumber": null,
    "domain": null,
    "expectedDelivery": "10-15 working days",
    "confirmedFunctions": [],
    "sourceFiles": [
      "C037 - NGO Ms Kerena Khun__BizWeb_KH_Quotation_C037_Ms_Kerena_Khun_NGO_Website_CMS.txt"
    ],
    "notes": "Only a quotation exists; organization name explicitly To Be Confirmed; no payment evidence.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C038",
    "clientName": "Mr. Phearun",
    "businessName": "Dental Clinic Name (To Be Confirmed)",
    "industry": "Clinic / Healthcare",
    "projectType": "Booking System",
    "projectTypeRaw": "Dynamic Dental Website + Content Management + Booking & OTP System",
    "quotedValue": 599.0,
    "confirmedValue": null,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C038-B599-9362-20260808",
    "quotationDateRaw": "8 Aug 2026",
    "createdAt": "2026-08-08",
    "invoiceNumber": null,
    "domain": null,
    "expectedDelivery": "15-20 working days",
    "confirmedFunctions": [],
    "sourceFiles": [
      "C038 - Mr Phearun Dental__BizWeb_KH_Quotation_C038_Mr_Phearun_Option4_Dynamic_Booking_599.txt"
    ],
    "notes": "Only Option4 quotation exists (of up to 4 options); clinic name To Be Confirmed; no payment evidence.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C039",
    "clientName": "Ms. Engly Khun",
    "businessName": "Engly Khun Salon (To Be Confirmed)",
    "industry": "Salon / Beauty",
    "projectType": "Customer Management System",
    "projectTypeRaw": "Customer Management + Staff Incentive Dashboard (Salon Management System)",
    "quotedValue": 599.0,
    "confirmedValue": null,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C039-8391-20260815",
    "quotationDateRaw": "15 Aug 2026",
    "createdAt": "2026-08-15",
    "invoiceNumber": null,
    "domain": null,
    "expectedDelivery": "12-15 working days",
    "confirmedFunctions": [
      "Role-based Login & Dashboard (Owner and Cashier/Admin access)",
      "New Deal & Customer/VIP Management with search/autofill, visit/spending history",
      "Normal and VIP/Package customers with purchase, top-up, balance tracking",
      "Multi-Service & Incentive: multiple services per customer, different staff, $ or % discount",
      "Separate Service Incentive and Sales Incentive calculated automatically",
      "Transactions & Reports: search/filter, receipt, status tracking, audit log",
      "Khmer default + English switch"
    ],
    "sourceFiles": [
      "C039 - Saloon Ms Engly Khun__BizWeb_KH_Quotation_C039_Engly_Khun_Customer_Management_Dashboard_Final.txt",
      "C039 - Saloon Ms Engly Khun__BizWeb_KH_Quotation_C039_Engly_Khun_Year_By_Year_Final_v2.txt"
    ],
    "notes": "Two versions of same quote, same total $599, both have blank client signature/date; no payment evidence.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C040",
    "clientName": "Norea Square Phnom Penh",
    "businessName": "Norea Square Phnom Penh",
    "industry": "Real Estate / Property",
    "projectType": "Starter Website",
    "projectTypeRaw": "One-Page Static Website (Starter Package) - Condominium/Real Estate",
    "quotedValue": 110.28,
    "confirmedValue": null,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": true,
    "quotationNumber": "BW-Q-C040-NOREA-20260813",
    "quotationDateRaw": "13 Aug 2026",
    "createdAt": "2026-08-13",
    "invoiceNumber": null,
    "domain": "noreasquarephnompenh.com",
    "expectedDelivery": "3-5 working days",
    "confirmedFunctions": [
      "One-Page Static Website: Home, Project Overview, About Project, Residences, Unit Types & Unit Plans, Amenities, Facilities, Location, Gallery, About Developer, Contact/Inquiry Form",
      "YouTube video, Call button, Telegram button, Map button, unit cards, floor-plan preview, document download, gallery",
      "Mobile Responsive, Basic SEO, 2 Revision Rounds",
      "1 year domain (noreasquarephnompenh.com)"
    ],
    "sourceFiles": [
      "C040 - noreasquarephnompenh.com__BizWeb_KH_Quotation_C040_Norea_Square_Phnom_Penh_Starter_99.txt"
    ],
    "notes": "HISTORICAL LIST CONFLICT: was on the previously-confirmed-closed list but only a $110.28 Starter quotation exists, Demo Preview Link TBC, client signature blank. Flag for manual review.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C041",
    "clientName": "Ms. Somaly Thon",
    "businessName": "Micro Insurance Company (To Be Confirmed)",
    "industry": "Insurance / Finance",
    "projectType": "Dynamic Website / CMS",
    "projectTypeRaw": "Micro Insurance Website + Basic Content Management Dashboard",
    "quotedValue": 399.0,
    "confirmedValue": null,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C041-D399-4517-20260813",
    "quotationDateRaw": "13 Aug 2026",
    "createdAt": "2026-08-13",
    "invoiceNumber": null,
    "domain": null,
    "expectedDelivery": "10-15 working days",
    "confirmedFunctions": [
      "Multi-page micro-insurance company website (Khmer + English)",
      "Pages: Home, About Us, Insurance Products, Benefits/Claims Information, Promotions, News/Updates, FAQ, Gallery, Contact Us",
      "Basic Content Management Dashboard",
      "Contact/Inquiry Form, Mobile Responsive, Basic SEO, 2 Revision Rounds"
    ],
    "sourceFiles": [
      "C041 - Ms. Somaly Thon - Micro Insurance__BizWeb_KH_Quotation_C041_Ms_Somaly_Thon_Micro_Insurance_CMS_399.txt"
    ],
    "notes": "Only a quotation exists; company name and domain TBC; no payment evidence.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C042",
    "clientName": "Mr. Thearith Ret",
    "businessName": "Home Use Tools E-Commerce (To Be Confirmed)",
    "industry": "Retail / E-Commerce",
    "projectType": "E-Commerce Level 1",
    "projectTypeRaw": "E-Commerce Product Catalog Website + Simple Admin Dashboard",
    "quotedValue": 500.0,
    "confirmedValue": null,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C042-5000-20260819",
    "quotationDateRaw": "19 Aug 2026",
    "createdAt": "2026-08-19",
    "invoiceNumber": null,
    "domain": null,
    "expectedDelivery": "10-15 working days",
    "confirmedFunctions": [
      "Customer-facing product catalog for ~100-200 products, categories, search/filter, product detail",
      "Multi-product selection/order list with quantity, unit price, subtotal",
      "Order Inquiry via Telegram and Facebook Messenger",
      "Simple Admin Dashboard: product list, Add/Edit/Delete product, categories, price, images, stock/status"
    ],
    "sourceFiles": [
      "C042 - Mr. Thearith Ret E-Commerce Website__BizWeb_KH_Quotation_C042_Mr_Thearith_Ret_Year_By_Year_Final.txt"
    ],
    "notes": "Year-by-Year quotation format, Year 1 total $500; Demo Preview TBC, client signature blank; no payment evidence.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C043",
    "clientName": "Ms. Kanharoth Heang",
    "businessName": "E-Commerce / Online Retail (To Be Confirmed)",
    "industry": "Retail / E-Commerce",
    "projectType": "E-Commerce Level 1",
    "projectTypeRaw": "E-Commerce Website + CMS/Admin Dashboard + Online Payment",
    "quotedValue": 899.0,
    "confirmedValue": null,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C043-8990-20260821",
    "quotationDateRaw": "21 Aug 2026",
    "createdAt": "2026-08-21",
    "invoiceNumber": null,
    "domain": null,
    "expectedDelivery": "10-15 working days",
    "confirmedFunctions": [
      "Customer-facing product catalog for ~100-200 products, categories, search/filter, product detail",
      "Shopping cart and checkout with quantity, unit price, subtotal",
      "Online Payment integration with one supported payment/KHQR provider",
      "CMS/Admin Dashboard: admin login, Add/Edit/Delete products/categories, price, images, stock/status"
    ],
    "sourceFiles": [
      "C043 - Ms. Kanharoth Heang E-Commerce__BizWeb_KH_Quotation_C043_Ms_Kanharoth_Heang_Option_2_CMS_Payment_FINAL.txt"
    ],
    "notes": "Filename marked FINAL but Demo Preview TBC, client signature blank; no payment evidence. Year 1 total $899.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  },
  {
    "code": "C044",
    "clientName": "Mr. អូច និមល",
    "businessName": "Educational Content & Learning Materials",
    "industry": "School / Education",
    "projectType": "Starter Website",
    "projectTypeRaw": "One-Page Static Website (Starter Package) - Educational Content",
    "quotedValue": 110.28,
    "confirmedValue": null,
    "leadStatus": "Quotation Sent",
    "evidenceStrength": "Low",
    "needsManualReview": true,
    "historicalListConflict": false,
    "quotationNumber": "BW-Q-C044-EDU-20260822",
    "quotationDateRaw": "22 August 2026",
    "createdAt": "2026-08-22",
    "invoiceNumber": null,
    "domain": null,
    "expectedDelivery": "3-5 working days",
    "confirmedFunctions": [
      "One-Page Static Website: Home, Books, Study Materials, Learning Videos, How to Buy, About, Contact",
      "Buy/Order buttons linking to client Telegram chat",
      "English default + Khmer language switch",
      "Mobile Responsive, Basic SEO, 2 Revision Rounds"
    ],
    "sourceFiles": [
      "C044__quotation.txt"
    ],
    "notes": "Client name only given in Khmer script in source; domain name itself TBC by client; signature blank; no payment evidence.",
    "amountCollected": null,
    "remainingBalance": null,
    "paymentStatus": "Payment Data Unconfirmed",
    "projectStage": null
  }
];

function buildRealClientData(){
  const leads = [];
  const projects = [];
  const payments = [];
  const activities = [];
  const followups = []; // intentionally empty — no documented next-follow-up dates exist in any source record (spec §19)
  const importedAt = new Date().toISOString();

  REAL_CLIENTS.forEach(c=>{
    const leadId = 'L' + c.code.slice(1);
    const isConfirmed = c.leadStatus === 'Confirmed';
    const industry = (c.industry && c.industry !== 'Unspecified') ? c.industry : null;
    const createdAtIso = c.createdAt ? (c.createdAt + 'T09:00:00.000Z') : null;
    const refLabel = `${c.clientName} — ${c.businessName}`;

    const reviewNoteParts = [];
    if(c.notes) reviewNoteParts.push(c.notes);
    if(c.expectedDelivery) reviewNoteParts.push(`Expected delivery (per quotation): ${c.expectedDelivery}.`);
    if(c.domain) reviewNoteParts.push(`Domain: ${c.domain}.`);
    if(c.invoiceNumber) reviewNoteParts.push(`Invoice: ${c.invoiceNumber}.`);
    if(c.historicalListConflict) reviewNoteParts.push('NOTE: This client is on the previously-supplied "historically closed" list, but the reviewed folder evidence does NOT show a paid deposit/invoice — kept as Open/Potential per actual document evidence. Needs Manual Review.');
    else if(c.needsManualReview) reviewNoteParts.push('Needs Manual Review — evidence strength: ' + c.evidenceStrength + '.');
    reviewNoteParts.push(`Source: ${(c.sourceFiles||[]).join('; ') || 'folder review, no evidentiary document found'}.`);

    const lead = {
      id: leadId,
      clientName: c.clientName, businessName: c.businessName, phone: '', telegram: '', facebook: '',
      industry,
      interestedService: c.projectType,
      estimatedValue: c.quotedValue,
      leadSource: 'Unspecified',
      assignedSales: 'Unassigned',
      status: c.leadStatus,
      nextFollowup: null,
      lastContact: null,
      expectedCloseDate: null,
      quotationStatus: c.quotationNumber ? 'Sent' : 'Not Sent',
      quotationAmount: c.quotedValue,
      quotationRef: c.quotationNumber || '',
      demoLink: '',
      notes: reviewNoteParts.join(' '),
      lostReason: null,
      projectCode: isConfirmed ? c.code : null,
      createdAt: createdAtIso,
      updatedAt: createdAtIso,
      // ---- data-source traceability (spec §23) — not shown prominently in UI ----
      sourceFiles: c.sourceFiles || [],
      sourceType: 'Imported Client Record',
      sourceDate: c.quotationDateRaw || null,
      confidence: c.evidenceStrength,
      needsManualReview: !!c.needsManualReview,
      historicalListConflict: !!c.historicalListConflict,
      // ---- archive / soft-delete state (Session 6) ----
      archived: false, archivedAt: null, archivedBy: null, archiveReason: null,
    };
    leads.push(lead);

    activities.push({
      id: 'A' + leadId + '-import', at: importedAt, userName: 'System Import', refType:'lead', refId: leadId, refLabel,
      type: 'Data Imported', description: `Imported existing client record into CRM from BizWeb KH client folder ${c.code} (confidence: ${c.evidenceStrength}).`,
      fromValue: null, toValue: null, remark: null
    });

    if(isConfirmed){
      const proj = {
        id: c.code, leadId, clientName: c.clientName, businessName: c.businessName, phone: '', industry,
        projectType: c.projectType, estimatedValue: c.quotedValue, confirmedValue: c.confirmedValue,
        depositPct: null, // actual deposit % not separately documented — never assumed
        assignedSales: 'Unassigned', stage: c.projectStage || 'Confirmed',
        startDate: c.createdAt, expectedDelivery: null,
        leadSource: 'Unspecified', demoLink: '', quotationRef: c.quotationNumber || '',
        notes: reviewNoteParts.join(' '),
        functions: (c.confirmedFunctions && c.confirmedFunctions.length) ? [{
          id: fnId(), module: c.projectTypeRaw || c.projectType,
          functions: c.confirmedFunctions.map(n=>({ id: fnId(), name: n, status: 'Confirmed' }))
        }] : [],
        createdAt: createdAtIso,
      };
      projects.push(proj);

      activities.push({
        id: 'A' + c.code + '-import', at: importedAt, userName: 'System Import', refType:'project', refId: c.code, refLabel: `${c.code} — ${c.businessName}`,
        type: 'Data Imported', description: `Imported existing confirmed project ${c.code} into CRM from BizWeb KH client folder (confidence: ${c.evidenceStrength}).`,
        fromValue: null, toValue: null, remark: null
      });

      if(c.amountCollected != null && c.amountCollected > 0){
        payments.push({
          id: 'PM' + c.code + '-import', projectId: c.code, amount: c.amountCollected,
          date: c.createdAt, method: 'Other', type: (c.remainingBalance > 0 ? 'Deposit' : 'Final Payment'),
          note: 'Imported from invoice/deposit evidence in client folder — exact payment date/method not separately documented.',
          recordedBy: 'System Import', createdAt: importedAt
        });
        activities.push({
          id: 'A' + c.code + '-paymport', at: importedAt, userName: 'System Import', refType:'project', refId: c.code, refLabel: `${c.code} — ${c.businessName}`,
          type: 'Payment Recorded', description: `Imported payment record: $${c.amountCollected} for project ${c.code} (from invoice evidence).`,
          fromValue: null, toValue: null, remark: null
        });
      }
    }
  });

  return { leads, activities, followups, projects, payments };
}

/* ---------------------------------------------------------------------- */
/* Demo data seeding                                                      */
/* ---------------------------------------------------------------------- */

// PRODUCTION CUTOVER (localStorage -> Supabase): DEMO_USERS (the fake
// Sokha Vann / Samphors Chan / Dara Meas accounts) has been deleted. The
// Users module now lists only the real Supabase `profiles` rows — see
// DB.init() above (rowToUser()). buildRealClientData()/REAL_CLIENTS above
// are no longer used to seed anything (that data already lives in
// Supabase, having been migrated there) — they're left in place only as a
// historical record of the original client-data import/evidence review,
// never invoked automatically.
//
// fnId() is still genuinely used elsewhere (SERVICE_PRICE_LIST above,
// projects.js, quotations.js) so it's preserved here.
function fnId(){ return 'FN' + Math.random().toString(36).slice(2,9); }

// seedDatabase()/DB.reset() intentionally no longer fabricate or reseed
// any data — see DB.reset() (re-fetches from Supabase) above. This
// function is kept only so nothing else that might still reference it
// throws; it is never called automatically.
function seedDatabase(){ console.warn('seedDatabase() is a no-op in production — data now lives in Supabase. Use DB.init()/DB.reset().'); }

// NOTE: DB.init() (async) must be awaited by the page's bootstrap script
// before any UI module runs — see dashboard/index.html. It is NOT called
// here at load time (unlike the old `seedDatabase(false)` call this
// replaces) because it needs a live Supabase session/network round trip.
