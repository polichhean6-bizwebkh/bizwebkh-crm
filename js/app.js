/* ==========================================================================
   BizWeb KH CRM — app.js
   App shell: auth guard, sidebar/topbar, router, shared UI helpers
   (formatting, badges, modals, toasts) used by every page module.
   ========================================================================== */

const CURRENT_USER = Auth.requireAuth();
// requireAuth() has already kicked off a redirect to the login page when
// there's no session. Every render function below assumes CURRENT_USER
// exists, so initApp() (at the bottom of this file) only runs when it does —
// this avoids a null-reference crash while that navigation is in flight.

/* ---------------------------------------------------------------------- */
/* Formatting helpers                                                     */
/* ---------------------------------------------------------------------- */

function money(n){
  if(n===null || n===undefined || n==='') return '$0';
  return '$' + Number(n).toLocaleString('en-US', {maximumFractionDigits:0});
}
function fmtDate(d){
  if(!d) return '—';
  const dt = new Date(d);
  if(isNaN(dt)) return '—';
  return dt.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
}
function fmtDateTime(d){
  if(!d) return '—';
  const dt = new Date(d);
  if(isNaN(dt)) return '—';
  return dt.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) + ', ' +
         dt.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
}
// Formats a Date object as a LOCAL calendar date (YYYY-MM-DD) using its own
// getFullYear/getMonth/getDate — never .toISOString(), which formats in UTC
// and can silently shift to the previous day during early-morning hours in
// a timezone ahead of UTC (e.g. Cambodia, ICT = UTC+7: at 02:00 local on
// 2 Sep it's still 19:00 UTC on 1 Sep, so .toISOString() would report
// "yesterday"). Every "what is today's date" computation below goes through
// this, per spec: use the CRM user's own local date, not UTC.
function localDateToISO(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
// Today, as a local YYYY-MM-DD string — used as the `min` on every "pick a
// future/today Next Follow-up Date" input, and as the comparison baseline
// for isPastLocalDate() below.
function todayLocalISO(){ return localDateToISO(new Date()); }
// A plain string comparison ("2026-09-01" < "2026-09-02") is enough here —
// both sides are already zero-padded YYYY-MM-DD, so this deliberately never
// constructs `new Date(dateStr)` for the comparison (a date-only ISO string
// parses as UTC midnight in JS, which reintroduces exactly the timezone bug
// this whole helper exists to avoid). Empty/falsy input is never "past".
function isPastLocalDate(dateStr){
  if(!dateStr) return false;
  return dateStr < todayLocalISO();
}
function daysUntil(dateStr){
  if(!dateStr) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(dateStr); d.setHours(0,0,0,0);
  return Math.round((d-today)/86400000);
}
// Returns an ISO date (YYYY-MM-DD) `days` from today — used to prefill
// Expected Delivery / quotation Valid Until fields, and the Follow-up
// preset chips (Today / Tomorrow / In 3 Days / Next Week). PRE-EXISTING BUG
// FIX: this was called from projects.js (Create Direct Project, Confirm
// Project, createProjectRecord) and quotations.js, but was never defined
// anywhere in the app — every one of those flows threw a ReferenceError and
// silently failed for every role, not just Sales. This is almost certainly
// the root cause behind spec §5's "the existing + Create New Project button
// currently does not work properly for Sales" — it didn't work for anyone.
// Uses localDateToISO (not .toISOString()) for the same timezone-safety
// reason as todayLocalISO() above — the old .toISOString() version could
// have handed the Follow-up preset chips a UTC date one day off from the
// user's actual local "today"/"tomorrow"/etc.
function daysFromNow(days){
  const d = new Date();
  d.setDate(d.getDate() + (Number(days) || 0));
  return localDateToISO(d);
}
function initialsOf(name){
  return String(name||'?').split(' ').filter(Boolean).slice(0,2).map(s=>s[0]).join('').toUpperCase();
}
const AVATAR_COLORS = ['#1d7bff','#18c8ff','#ff8a3d','#7c5cff','#12a775','#e0473c','#d98a12'];
function avatarColorFor(name){
  let h=0; for(let i=0;i<String(name).length;i++) h = (h*31 + name.charCodeAt(i))>>>0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function userByName(name){
  return DB.all('users').find(u=>u.name===name) || null;
}
function userColor(name){
  const u = userByName(name);
  return u ? u.color : avatarColorFor(name);
}
function userInitials(name){
  const u = userByName(name);
  return u ? u.initials : initialsOf(name);
}
function escapeHtml(s){
  return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function statusBadge(status){
  if(!status) return '';
  return `<span class="badge st-${slug(status)}"><span class="badge-dot"></span>${escapeHtml(status)}</span>`;
}
function paymentBadge(status){
  return `<span class="badge pay-${slug(status)}"><span class="badge-dot"></span>${escapeHtml(status)}</span>`;
}
function urgencyOf(dateStr){
  const d = daysUntil(dateStr);
  if(d===null) return null;
  if(d<0) return 'overdue';
  if(d===0) return 'today';
  if(d===1) return 'tomorrow';
  if(d<=7) return 'week';
  return 'later';
}
function urgencyLabel(u){
  return { overdue:'Overdue', today:'Today', tomorrow:'Tomorrow', week:'This Week', later:'Later' }[u] || '';
}
function urgencyChip(dateStr){
  const u = urgencyOf(dateStr);
  if(!u) return '<span class="text-muted">—</span>';
  return `<span class="badge chip-${u}">${urgencyLabel(u)} · ${fmtDate(dateStr)}</span>`;
}

/* ---------------------------------------------------------------------- */
/* Toasts                                                                  */
/* ---------------------------------------------------------------------- */

function ensureToastStack(){
  let el = document.getElementById('toastStack');
  if(!el){
    el = document.createElement('div');
    el.id = 'toastStack';
    el.className = 'toast-stack';
    document.body.appendChild(el);
  }
  return el;
}
function toast(msg, type=''){
  const stack = ensureToastStack();
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  stack.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity .25s'; setTimeout(()=>t.remove(),260); }, 2600);
}

/* ---------------------------------------------------------------------- */
/* Generic modal helper                                                   */
/* ---------------------------------------------------------------------- */

// `xl` is the wide split-view size (Create/Edit Quotation's form+A4-preview
// layout — Quotations typography/layout fix, spec §7) — a fixed-size,
// internally-scrolling modal (own CSS: .modal-box.modal-xl), distinct from
// the older `large` (.modal-lg) size used by every other detail modal.
function openModal(innerHtml, { large=false, xl=false, onMount=null } = {}){
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'activeModalOverlay';
  overlay.innerHTML = `<div class="modal-box ${xl?'modal-xl':(large?'modal-lg':'')}">${innerHtml}</div>`;
  overlay.addEventListener('mousedown', (e)=>{ if(e.target===overlay) closeModal(); });
  document.body.appendChild(overlay);
  if(onMount) onMount(overlay);
  return overlay;
}
function closeModal(){
  const el = document.getElementById('activeModalOverlay');
  if(el) el.remove();
}
document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') closeModal(); });

// Waits for web fonts (e.g. Noto Sans Khmer) to finish loading before
// calling window.print() — the quotation preview can look fine on screen
// the instant it renders, then print/PDF with the Khmer text still on a
// fallback font because the browser hadn't finished fetching the webfont
// yet. document.fonts.ready resolves once every requested font is loaded
// (or immediately if there's nothing to wait for), so this is a no-op
// everywhere except that one race.
function printAfterFontsReady(){
  try{
    if(document.fonts && document.fonts.ready){ document.fonts.ready.then(()=> window.print()); return; }
  }catch(e){ /* fall through to a plain print */ }
  window.print();
}

/* ---------------------------------------------------------------------- */
/* Status-change confirmation modal (leads + projects share this)         */
/* ---------------------------------------------------------------------- */

function openStatusChangeModal({ refType, refId, refLabel, fromStatus, toStatus, currentFollowup, currentProjectCode, onConfirm }){
  const needsLostReason = toStatus === 'Lost';
  // Project Code becomes REQUIRED the first time a lead reaches Quote and
  // Demo Sent or any stage after it (spec §5) — but only when it doesn't
  // already have one. A lead that already carries a code (assigned
  // earlier, or moving backward then forward again) never gets asked
  // again (spec §8/§11): the field simply doesn't render, and the
  // existing code travels with the lead untouched. Confirmed never
  // reaches this modal at all — applyLeadStatusChange (leads.js)
  // redirects it to the dedicated openConfirmProjectModal flow instead,
  // which is where an already-assigned code gets reused (spec §9).
  const needsProjectCode = refType==='lead' && !currentProjectCode && leadStatusRequiresProjectCode(toStatus);
  // On Hold / Future Follow-up (CRM feature): moving a LEAD into this stage
  // shows a Next Follow-up Date field, but it is OPTIONAL — a lead can be
  // put on hold even when the client hasn't committed to a specific date
  // yet ("continue later, no date confirmed"). When a date IS given it
  // must be today or later (min attribute below + the JS check in the
  // Confirm handler, per spec §2/§3) — past dates are rejected outright,
  // they're never silently accepted. Only applies to leads — projects.js
  // reuses this same modal for its own stage changes and has no such field.
  const needsHoldFollowup = refType==='lead' && toStatus === ON_HOLD_STATUS;
  const html = `
    <div class="modal-head">
      <h3>Change Status</h3>
      <button class="modal-close" id="scmClose">&times;</button>
    </div>
    <div class="modal-body">
      <p class="text-muted" style="margin:0 0 6px;font-size:12.5px">${escapeHtml(refLabel)}</p>
      <div class="status-flow">
        ${statusBadge(fromStatus)}
        <span class="arrow">&rarr;</span>
        ${statusBadge(toStatus)}
      </div>
      <div class="form-field" style="margin-bottom:12px">
        <label>Changed by</label>
        <input type="text" value="${escapeHtml(CURRENT_USER.name)}" disabled>
      </div>
      ${needsLostReason ? `
      <div class="form-field" style="margin-bottom:12px">
        <label class="required">Lost Reason</label>
        <select id="scmLostReason">
          <option value="">Select a reason…</option>
          ${LOST_REASONS.map(r=>`<option value="${r}">${r}</option>`).join('')}
        </select>
      </div>` : ''}
      ${needsProjectCode ? `
      <div class="form-field" style="margin-bottom:12px">
        <label class="required">Project Code</label>
        <input type="text" id="scmProjectCode" placeholder="e.g. C046" value="${escapeHtml(suggestNextProjectCode())}" style="text-transform:uppercase">
        <span class="form-hint">Required from "${escapeHtml(toStatus)}" onward — must be unique (not case-sensitive).</span>
      </div>` : ''}
      ${needsHoldFollowup ? `
      <div class="form-field" style="margin-bottom:12px">
        <label>Next Follow-up Date (optional)</label>
        <input type="date" id="scmHoldFollowup" min="${todayLocalISO()}" value="${currentFollowup||''}">
        <span class="form-hint">When should Sales come back to this lead? (e.g. "continue in December" → 01 Dec 2026). Leave blank if no date has been confirmed yet — today or later only.</span>
      </div>` : ''}
      <div class="form-field">
        <label>${needsHoldFollowup ? 'Reason / Note' : 'Remark'} ${needsLostReason?'':'(optional)'}</label>
        <textarea id="scmRemark" placeholder="${needsHoldFollowup ? 'e.g. Client wants to continue later but has not confirmed a specific date.' : 'Add a short note about this change…'}"></textarea>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="scmCancel">Cancel</button>
      <button class="btn btn-primary" id="scmConfirm">Confirm Change</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#scmClose').onclick = closeModal;
    overlay.querySelector('#scmCancel').onclick = closeModal;
    overlay.querySelector('#scmConfirm').onclick = ()=>{
      let remark = overlay.querySelector('#scmRemark').value.trim();
      if(needsLostReason){
        const reasonSel = overlay.querySelector('#scmLostReason');
        const reason = reasonSel.value;
        if(!reason){ reasonSel.style.borderColor='var(--red)'; toast('Please select a lost reason.', 'error'); return; }
        remark = `Lost reason: ${reason}` + (remark ? ` — ${remark}` : '');
      }
      let projectCode;
      if(needsProjectCode){
        const codeInput = overlay.querySelector('#scmProjectCode');
        const normalized = normalizeProjectCode(codeInput.value);
        // A. cannot be empty
        if(!normalized){
          codeInput.style.borderColor='var(--red)';
          toast(`Project Code is required to move to "${toStatus}".`, 'error');
          return;
        }
        // B. cannot duplicate an existing code (case-insensitive, checked
        // against both other leads' reserved codes AND every project id).
        if(isProjectCodeTaken(normalized, { excludeLeadId: refId })){
          codeInput.style.borderColor='var(--red)';
          toast(`Project Code ${normalized} already exists. Please use a unique Project Code.`, 'error');
          return;
        }
        codeInput.style.borderColor='';
        // C/D. trim + normalize capitalization — already done by
        // normalizeProjectCode() above.
        projectCode = normalized;
      }
      let nextFollowup = null;
      if(needsHoldFollowup){
        const dateInput = overlay.querySelector('#scmHoldFollowup');
        nextFollowup = dateInput.value || null;
        // Optional (spec §1) — a blank date is fine and simply means "no
        // date confirmed yet". When a date IS entered it must be today or
        // later (spec §2/§3); the `min` attribute on the input already
        // stops a normal date-picker click from reaching a past date, but
        // this is the second safeguard for a typed/pasted/autofilled value.
        if(nextFollowup && isPastLocalDate(nextFollowup)){
          dateInput.style.borderColor='var(--red)';
          toast('Follow-up date cannot be in the past.', 'error');
          return;
        }
        dateInput.style.borderColor='';
      }
      closeModal();
      onConfirm({
        remark,
        lostReason: needsLostReason ? overlay.querySelector('#scmLostReason').value : null,
        nextFollowup: needsHoldFollowup ? nextFollowup : undefined,
        projectCode: needsProjectCode ? projectCode : undefined,
      });
    };
  }});
}

/* ---------------------------------------------------------------------- */
/* Sidebar / Topbar / Router                                              */
/* ---------------------------------------------------------------------- */

const NAV_ITEMS = [
  { key:'dashboard', label:'Dashboard', icon:'grid' },
  { key:'leads', label:'Lead Records', icon:'users' },
  { key:'pipeline', label:'Pipeline', icon:'columns' },
  { key:'projects', label:'Projects', icon:'briefcase' },
  { key:'quotations', label:'Quotations', icon:'quote' },
  { key:'payments', label:'Payments', icon:'dollar' },
  { key:'activity', label:'Activity Log', icon:'list' },
  { key:'users', label:'Users', icon:'user' },
  { key:'settings', label:'Settings', icon:'gear' },
];

const ICONS = {
  grid:'<path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z"/>',
  users:'<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  columns:'<rect x="3" y="3" width="6" height="18" rx="1"/><rect x="10" y="3" width="6" height="12" rx="1"/><rect x="17" y="3" width="4" height="8" rx="1"/>',
  briefcase:'<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  clock:'<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  dollar:'<path d="M12 1v22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  list:'<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  user:'<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  gear:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><path d="M21 12H9"/>',
  search:'<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/>',
  menu:'<path d="M3 12h18M3 6h18M3 18h18"/>',
  quote:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M9 13h6M9 17h6"/>',
  edit:'<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  x:'<path d="M18 6L6 18M6 6l12 12"/>',
  moon:'<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  sun:'<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>',
  archive:'<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>',
};
// IMPORTANT: width/height="18" here are a SAFE DEFAULT ONLY — plain HTML
// sizing attributes are the lowest-priority box-sizing source in CSS, so
// any stylesheet rule (even a bare `svg{}`) still overrides them. This is
// what stops an icon from ever rendering at its unstyled intrinsic size
// (which some browsers default to ~300x150) if it's dropped into a new
// context — like a modal — that no CSS rule happens to scope to yet.
// See the "search icon bug" fix: the old markup had no such fallback.
function icon(name, extra=''){ return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${ICONS[name]||''}</svg>`; }

const PAGE_TITLES = {
  dashboard:['Dashboard','Overview of leads, pipeline and payments'],
  leads:['Lead Records','Track and manage all sales leads'],
  pipeline:['Pipeline','Track active opportunities from quote to confirmation.'],
  projects:['Projects','Confirmed projects and delivery status'],
  quotations:['Quotations','Create, review, and send client quotations'],
  payments:['Financial Overview','Review payment activity and outstanding balances across all projects'],
  activity:['Activity Log','Full history of who changed what, and when'],
  users:['Users','CRM team members'],
  settings:['Settings','Demo environment preferences'],
};

function renderShell(){
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-brand">
          <div class="logo-mark">BW</div>
          <div class="logo-text"><strong>BizWeb KH</strong><span>Internal CRM</span></div>
        </div>
        <nav class="sidebar-nav" id="sidebarNav"></nav>
        <div class="sidebar-foot">
          <div class="sidebar-user">
            <div class="avatar" style="background:${CURRENT_USER.color}">${CURRENT_USER.initials}</div>
            <div class="who"><strong>${escapeHtml(CURRENT_USER.name)}</strong><span>${escapeHtml(ROLE_LABELS[CURRENT_USER.role] || CURRENT_USER.role)}</span></div>
          </div>
          <div class="logout-link" id="logoutBtn">${icon('logout')} Sign out</div>
        </div>
      </aside>
      <div class="main-col">
        <div class="topbar">
          <button class="menu-toggle-btn" id="menuToggle">${icon('menu')}</button>
          <div>
            <div class="page-title" id="pageTitle"></div>
            <div class="page-sub" id="pageSub"></div>
          </div>
          <div class="topbar-spacer"></div>
          <button class="theme-toggle-btn" id="themeToggle" title="Switch theme" aria-label="Switch between light and dark theme"></button>
        </div>
        <div class="content" id="pageContent"></div>
      </div>
    </div>
  `;
  // Only show nav items this role is permitted to open (see ROLE_PERMISSIONS
  // in auth.js) — a role never sees a menu item it isn't allowed to use.
  document.getElementById('sidebarNav').innerHTML = NAV_ITEMS
    .filter(n=> roleCanAccess(CURRENT_USER.role, n.key))
    .map(n=>`
    <div class="nav-item" data-route="${n.key}">${icon(n.icon)}<span>${n.label}</span>${n.key==='quotations' && typeof QUOTATIONS_MODULE_ENABLED!=='undefined' && !QUOTATIONS_MODULE_ENABLED ? `<span style="margin-left:auto;padding:1px 7px;border-radius:999px;background:#d98a121a;color:#d98a12;font-size:9.5px;font-weight:800;letter-spacing:.3px;text-transform:uppercase;white-space:nowrap">Soon</span>` : ''}</div>
  `).join('');
  document.getElementById('logoutBtn').onclick = async ()=>{ await Auth.logout(); window.location.href = '../login/index.html'; };
  document.getElementById('menuToggle').onclick = ()=> document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarNav').addEventListener('click', (e)=>{
    const item = e.target.closest('.nav-item');
    if(!item) return;
    window.location.hash = '#' + item.dataset.route;
    document.getElementById('sidebar').classList.remove('open');
  });
  wireThemeToggle(document.getElementById('themeToggle'));
}

const ROUTES = {
  dashboard: ()=> renderDashboard(),
  leads: ()=> renderLeadsPage(),
  pipeline: ()=> renderPipelinePage(),
  projects: ()=> renderProjectsPage(),
  quotations: ()=> renderQuotationsPage(),
  payments: ()=> renderPaymentsPage(),
  activity: ()=> renderActivityPage(),
  users: ()=> renderUsersPage(),
  settings: ()=> renderSettingsPage(),
};

function currentRoute(){
  let h = (window.location.hash || '#dashboard').replace('#','');
  // The standalone Follow-ups page was removed and its workflow folded into
  // Pipeline (spec §1/§14) — any old bookmark, link, or typed hash to it
  // now lands on Pipeline instead of a dead page. The renderFollowupsPage()
  // code itself is left intact/unused (never deleted), only unreachable via
  // normal navigation.
  if(h==='followups') h = 'pipeline';
  if(!ROUTES[h]) return 'dashboard';
  // A role can't reach a page it doesn't have menu access to, even by
  // typing/bookmarking the hash directly — falls back to Dashboard.
  if(!roleCanAccess(CURRENT_USER.role, h)) return 'dashboard';
  return h;
}

function router(){
  const route = currentRoute();
  document.querySelectorAll('.nav-item').forEach(el=> el.classList.toggle('active', el.dataset.route===route));
  const [title,sub] = PAGE_TITLES[route];
  document.getElementById('pageTitle').textContent = title;
  document.getElementById('pageSub').textContent = sub;
  document.getElementById('pageContent').innerHTML = '<div class="empty-state">Loading…</div>';
  try{
    ROUTES[route]();
  }catch(err){
    console.error(err);
    document.getElementById('pageContent').innerHTML = `<div class="empty-state">Something went wrong loading this page.</div>`;
  }
}

window.addEventListener('hashchange', router);

function initApp(){
  renderShell();
  router();
}

/* ---------------------------------------------------------------------- */
/* Users & Settings pages (simple enough to live in app.js)               */
/* ---------------------------------------------------------------------- */

// Users who should appear in Sales Performance: has an explicit Sales-type
// role, OR has at least one lead assigned to them — never an unrelated
// operations user with a meaningless all-zero row.
function salesPerformanceNames(){
  const users = DB.all('users');
  const leads = DB.all('leads');
  const salesRoleNames = users.filter(u=>/sales/i.test(u.role)).map(u=>u.name);
  const hasLeadsNames = [...new Set(leads.map(l=>l.assignedSales))];
  return [...new Set([...salesRoleNames, ...hasLeadsNames])].sort();
}

function renderUsersPage(){
  const el = document.getElementById('pageContent');
  const users = DB.all('users');
  const leads = DB.all('leads');
  const activities = DB.all('activities');
  const projects = DB.all('projects');
  const quotations = DB.all('quotations');
  const salesNames = salesPerformanceNames();

  el.innerHTML = `
    <div class="table-wrap scroll-x">
      <table class="data-table">
        <thead><tr><th>User</th><th>Username</th><th>Role</th><th>Leads Assigned</th><th>Active Projects</th></tr></thead>
        <tbody>
          ${users.map(u=>{
            const leadsCount = leads.filter(l=>l.assignedSales===u.name).length;
            const projCount = projects.filter(p=>p.assignedSales===u.name && ACTIVE_PROJECT_STAGES.includes(p.stage)).length;
            return `<tr>
              <td><div class="flex-row"><div class="avatar-sm" style="background:${u.color}">${u.initials}</div><span class="cell-strong">${escapeHtml(u.name)}</span></div></td>
              <td>${escapeHtml(u.username)}</td>
              <td>${escapeHtml(ROLE_LABELS[u.role] || u.role)}</td>
              <td>${leadsCount}</td>
              <td>${projCount}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <p class="text-muted" style="margin:14px 0 24px;font-size:12.5px">Live BizWeb KH team accounts from Supabase. New team members are added by creating a Supabase Auth user + linked <code>profiles</code> row — this page will list them automatically once that's done.</p>

    <div class="section-title">Sales Performance</div>
    <p class="text-muted" style="margin:0 0 10px;font-size:12px">Only users with a Sales role, or who have at least one lead assigned, appear here.</p>
    <div class="table-wrap scroll-x">
      <table class="data-table sales-perf-table">
        <thead><tr><th>Sales Person</th><th>Leads Assigned</th><th>Follow-ups Completed</th><th>Quotations Sent</th><th>Projects Confirmed</th><th>Collected Revenue</th><th>Pipeline Value</th></tr></thead>
        <tbody>
          ${salesNames.map(name=>{
            const myLeads = leads.filter(l=>l.assignedSales===name);
            const followupsCompleted = activities.filter(a=>a.userName===name && a.type==='Follow-up Completed').length;
            const quotationsSent = quotations.filter(q=>q.assignedSales===name && ['Sent','Accepted'].includes(quotationDisplayStatus(q))).length;
            const myProjects = projects.filter(p=>p.assignedSales===name);
            const collected = myProjects.reduce((s,p)=> s + totalPaidForProject(p.id), 0);
            // Archived leads are excluded here too — they're hidden from the
            // Pipeline board (pipeline.js) and Dashboard's Open Pipeline
            // Value, so this column must never disagree with those.
            const pipelineValue = myLeads.filter(l=>!l.archived && OPEN_PIPELINE_STATUSES.includes(l.status)).reduce((s,l)=>s+(l.estimatedValue||0),0);
            return `<tr>
              <td><div class="flex-row"><div class="avatar-sm" style="background:${userColor(name)}">${userInitials(name)}</div><span class="cell-strong">${escapeHtml(name)}</span></div></td>
              <td>${myLeads.length}</td>
              <td>${followupsCompleted}</td>
              <td>${quotationsSent}</td>
              <td>${myProjects.length}</td>
              <td class="cell-strong">${money(collected)}</td>
              <td>${money(pipelineValue)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

let SETTINGS_TAB = 'general';

function renderSettingsPage(){
  SETTINGS_TAB = 'general';
  QS_SUBTAB = 'general';
  QS_DIRTY = false;
  renderSettingsBody();
}

function renderSettingsBody(){
  const el = document.getElementById('pageContent');
  el.innerHTML = `
    <div class="tabs" style="max-width:640px">
      <div class="tab-btn ${SETTINGS_TAB==='general'?'active':''}" data-stab="general">General</div>
      <div class="tab-btn ${SETTINGS_TAB==='prices'?'active':''}" data-stab="prices">Service Price List</div>
      <div class="tab-btn ${SETTINGS_TAB==='quotations'?'active':''}" data-stab="quotations">Quotations</div>
    </div>
    <div id="settingsTabBody"></div>
  `;
  el.querySelectorAll('[data-stab]').forEach(t=> t.onclick = ()=>{
    if(t.dataset.stab===SETTINGS_TAB) return;
    // Leaving the Quotations tab (spec: warn on unsaved edits when the
    // user changes tab or leaves the page, "if practical") — scoped to
    // this in-page tab switch, the one navigation this module can check
    // without hooking into the app's shared router.
    if(SETTINGS_TAB==='quotations' && !qsConfirmDiscardIfDirty()) return;
    SETTINGS_TAB = t.dataset.stab;
    renderSettingsBody();
  });
  const body = document.getElementById('settingsTabBody');
  if(SETTINGS_TAB==='general') body.innerHTML = settingsGeneralTab();
  else if(SETTINGS_TAB==='prices') body.innerHTML = settingsPricesTab();
  else body.innerHTML = settingsQuotationsTab();

  if(SETTINGS_TAB==='general'){
    document.getElementById('resetBtn').onclick = async ()=>{
      if(confirm('This will discard any unsaved local changes and re-sync this browser with the live Supabase data. Continue?')){
        toast('Reloading data from the server…');
        try{
          await DB.reset();
          toast('Data re-synced from the server.', 'success');
        }catch(err){
          console.error('DB.reset() failed', err);
          toast('Could not reload data from the server.', 'error');
        }
        window.location.hash = '#dashboard';
        router();
      }
    };
    document.getElementById('settingsLogout').onclick = async ()=>{ await Auth.logout(); window.location.href = '../login/index.html'; };
    const discountInput = document.getElementById('discountLimitInput');
    if(discountInput){
      discountInput.onchange = ()=>{
        DB.upsert('settings', { discountLimitPct: Math.max(0, Number(discountInput.value)||0) });
        toast('Sales discount authority updated.', 'success');
      };
    }
  } else if(SETTINGS_TAB==='prices'){
    wireSettingsPricesTab();
  } else {
    wireSettingsQuotationsTab();
  }
}

function settingsGeneralTab(){
  const db = DB.read();
  const limit = (db && db.settings && db.settings.discountLimitPct) || 10;
  return `
    <div class="panel" style="max-width:640px;margin-top:14px">
      <div class="panel-head"><h3>Demo Environment</h3></div>
      <div class="panel-body pad">
        <p class="text-muted" style="margin-top:0">This CRM is connected to BizWeb KH's live Supabase backend. Leads, projects, payments, activity and quotations are all stored server-side and shared across every device/user.</p>
        <div class="divider"></div>
        <div class="flex-row" style="justify-content:space-between;margin-bottom:10px">
          <div>
            <strong style="font-size:13.5px">Sales Discount Authority</strong>
            <div class="text-muted" style="font-size:12px">Max discount % Sales can apply before Founder review is required.</div>
          </div>
          ${isFounder() ? `<input type="number" id="discountLimitInput" class="sel" style="width:70px;text-align:right" min="0" max="100" value="${limit}">` : `<span class="cell-strong">${limit}%</span>`}
        </div>
        <div class="divider"></div>
        <div class="flex-row" style="justify-content:space-between;margin-bottom:10px">
          <div>
            <strong style="font-size:13.5px">Reload data from server</strong>
            <div class="text-muted" style="font-size:12px">Discards any unsaved local changes and re-syncs this browser with live Supabase data.</div>
          </div>
          <button class="btn btn-danger btn-sm" id="resetBtn">Reset Data</button>
        </div>
        <div class="flex-row" style="justify-content:space-between">
          <div>
            <strong style="font-size:13.5px">Signed in as</strong>
            <div class="text-muted" style="font-size:12px">${escapeHtml(CURRENT_USER.name)} · ${escapeHtml(ROLE_LABELS[CURRENT_USER.role] || CURRENT_USER.role)}</div>
          </div>
          <button class="btn btn-secondary btn-sm" id="settingsLogout">Sign out</button>
        </div>
      </div>
    </div>
  `;
}

function settingsPricesTab(){
  const services = DB.all('services');
  const editable = isFounder();
  return `
    <p class="text-muted" style="margin:14px 0">The single pricing reference used across the whole CRM — Quotations pull from this list. ${editable?'As Owner/Admin you can edit prices below.':'View-only for your role — Owner/Admin can edit.'}</p>
    <div class="table-wrap scroll-x">
      <table class="data-table">
        <thead><tr>
          <th>Service / Package</th><th>Base Price (Yr 1)</th><th>Year 2 Renewal</th><th>Year 3 Renewal</th>
          <th>Sales Can Quote?</th><th>Founder Review Required?</th><th>Default Delivery</th><th>Status</th>
        </tr></thead>
        <tbody>
          ${services.map(s=>`
            <tr data-svc="${s.id}">
              <td class="cell-strong">${escapeHtml(s.name)}${s.priceIsStartingFrom?' <span class="text-muted" style="font-weight:400;font-size:11px">(from)</span>':''}</td>
              <td>${editable?`<input type="number" class="sel" style="width:90px" data-field="basePrice" value="${s.basePrice}">`:money(s.basePrice)}</td>
              <td>${editable?`<input type="number" class="sel" style="width:90px" data-field="year2Price" value="${s.year2Price}">`:money(s.year2Price)}</td>
              <td>${editable?`<input type="number" class="sel" style="width:90px" data-field="year3Price" value="${s.year3Price}">`:money(s.year3Price)}</td>
              <td>${s.salesCanQuote?'✓ Yes':'No'}</td>
              <td>${s.founderReviewRequired?'✓ Yes':'No'}</td>
              <td>${escapeHtml(s.defaultDelivery)}</td>
              <td>${statusBadge(s.status)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}
function wireSettingsPricesTab(){
  if(!isFounder()) return;
  document.querySelectorAll('#settingsTabBody [data-field]').forEach(input=>{
    input.onchange = ()=>{
      const row = input.closest('[data-svc]');
      const svc = DB.all('services').find(s=>s.id===row.dataset.svc);
      svc[input.dataset.field] = Number(input.value)||0;
      DB.upsert('services', svc);
      toast(`${svc.name} updated.`, 'success');
    };
  });
}

/* ---------------------------------------------------------------------- */
/* Settings -> Quotations tab: one centralized bank-details block (never   */
/* duplicated per quotation, spec §21) + the standard exclusions/notes     */
/* templates by quotation type (spec §12/§20) — Founder/Admin-editable,    */
/* Sales view-only, exactly like the Service Price List tab above.         */
/*                                                                          */
/* UX reorganization (Settings UX improvement task): this used to be one   */
/* very long page (bank details + validity + both templates' exclusions   */
/* and notes, each with its own tiny Save button). It's now split into     */
/* three secondary tabs — General / Website Template / System Template —   */
/* each with exactly ONE "Save Changes" button that persists every field   */
/* on that tab in a single DB.upsert. The underlying settings.bankDetails  */
/* / settings.quotationDefaults data shape is completely UNCHANGED (still  */
/* {exclusions:{website,system}, notes:{website,system}, validityDays}) —  */
/* only how it's edited/saved changed, so existing quotations, the         */
/* per-quotation snapshot behavior (a saved quotation's own                */
/* items/exclusions/importantNotes never re-reads live settings — see      */
/* saveQuotationFromState in quotations.js), and Supabase's stored JSON    */
/* are all untouched. */
let QS_SUBTAB = 'general';
let QS_DIRTY = false;
function qsConfirmDiscardIfDirty(){
  if(!QS_DIRTY) return true;
  const ok = confirm('You have unsaved Quotation Settings changes. Discard them and continue?');
  if(ok) QS_DIRTY = false;
  return ok;
}
function settingsQuotationsTab(){
  const editable = isFounder();
  const subtabs = [
    { key:'general', label:'General' },
    { key:'website', label:'Website Template' },
    { key:'system', label:'System Template' },
  ];
  return `
    <p class="text-muted" style="margin:14px 0">Centralized quotation settings used by every quotation — never duplicated per-record. ${editable?'As Owner/Admin you can edit these below.':'View-only for your role — Owner/Admin can edit.'}</p>
    <div class="tabs" id="qsSubtabs" style="max-width:640px">
      ${subtabs.map(t=>`<div class="tab-btn ${QS_SUBTAB===t.key?'active':''}" data-qstab="${t.key}">${t.label}</div>`).join('')}
    </div>
    <div id="qsSubtabBody">${qsSubtabBodyHtml(editable)}</div>
  `;
}
function qsSubtabBodyHtml(editable){
  if(QS_SUBTAB==='general') return qsGeneralTabHtml(editable);
  return qsTemplateTabHtml(QS_SUBTAB, editable);
}
function qsGeneralTabHtml(editable){
  const bank = bankDetails();
  const qd = quotationDefaults();
  return `
    <div class="panel" style="max-width:640px;margin-bottom:16px">
      <div class="panel-head"><h3>Payment Bank Details</h3></div>
      <div class="panel-body pad">
        <div class="form-grid">
          <div class="form-field"><label>Account Name</label><input id="qs_accountName" value="${escapeHtml(bank.accountName)}" ${editable?'':'disabled'}></div>
          <div class="form-field"><label>Account Number</label><input id="qs_accountNumber" value="${escapeHtml(bank.accountNumber)}" ${editable?'':'disabled'}></div>
          <div class="form-field"><label>Bank Name</label><input id="qs_bankName" value="${escapeHtml(bank.bankName)}" ${editable?'':'disabled'}></div>
          <div class="form-field"><label>Default Memo</label><input id="qs_memo" value="${escapeHtml(bank.memo)}" ${editable?'':'disabled'}></div>
          <div class="form-field full"><label>QR Image URL (optional)</label><input id="qs_qr" value="${escapeHtml(bank.qrImageUrl)}" ${editable?'':'disabled'}></div>
        </div>
      </div>
    </div>
    <div class="panel" style="max-width:640px;margin-bottom:16px">
      <div class="panel-head"><h3>Quotation Defaults</h3></div>
      <div class="panel-body pad">
        <div class="flex-row" style="justify-content:space-between;margin-bottom:12px">
          <div><strong style="font-size:13.5px">Valid Until (days from Quotation Date)</strong></div>
          ${editable?`<input type="number" id="qs_validityDays" class="sel" style="width:70px;text-align:right" value="${qd.validityDays}">`:`<span class="cell-strong">${qd.validityDays}</span>`}
        </div>
        <div class="divider"></div>
        <div class="flex-row" style="justify-content:space-between;margin-top:12px">
          <div><strong style="font-size:13.5px">Default Currency</strong></div>
          <span class="cell-strong">USD</span>
        </div>
        <div class="flex-row" style="justify-content:space-between;margin-top:10px">
          <div><strong style="font-size:13.5px">Quotation Language / Style</strong></div>
          <span class="cell-strong">Bilingual (English / Khmer)</span>
        </div>
        <p class="text-muted" style="font-size:11.5px;margin:10px 0 0">Currency and bilingual formatting reflect the CRM's current quotation logic — not separately configurable.</p>
      </div>
    </div>
    ${editable?`<button class="btn btn-primary" id="qsSaveGeneral">Save Changes</button>`:''}
  `;
}
function qsTemplateTabHtml(type, editable){
  const qd = quotationDefaults();
  const typeLabel = { website:'Website Template', system:'System Template' };
  return `
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h3>${typeLabel[type]} — Standard Exclusions</h3></div>
      <div class="panel-body pad">
        <textarea id="qs_excl_${type}" style="min-height:110px" ${editable?'':'disabled'}>${escapeHtml((qd.exclusions[type]||[]).join('\n'))}</textarea>
        <p class="text-muted" style="font-size:11.5px;margin:6px 0 0">One item per line.</p>
      </div>
    </div>
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h3>${typeLabel[type]} — Important Notes</h3></div>
      <div class="panel-body pad">
        ${(qd.notes[type]||[]).map((n,i)=>`
          <div class="qs-note-card">
            <h4>${escapeHtml(n.title)}</h4>
            <textarea data-note="${type}|${i}" ${editable?'':'disabled'}>${escapeHtml(n.text)}</textarea>
          </div>`).join('')}
      </div>
    </div>
    ${editable?`
    <div class="flex-row" style="gap:10px">
      <button class="btn btn-primary" id="qsSaveTemplate">Save Changes</button>
      <button class="btn btn-outline" id="qsResetTemplate">Reset to Default</button>
    </div>`:''}
  `;
}
function wireSettingsQuotationsTab(){
  wireQsSubtabNav();
  wireQsCurrentSubtabBody();
}
function wireQsSubtabNav(){
  document.querySelectorAll('#qsSubtabs [data-qstab]').forEach(t=> t.onclick = ()=>{
    if(t.dataset.qstab===QS_SUBTAB) return;
    if(!qsConfirmDiscardIfDirty()) return;
    QS_SUBTAB = t.dataset.qstab;
    document.getElementById('qsSubtabs').querySelectorAll('[data-qstab]').forEach(b=> b.classList.toggle('active', b.dataset.qstab===QS_SUBTAB));
    const body = document.getElementById('qsSubtabBody');
    body.innerHTML = qsSubtabBodyHtml(isFounder());
    wireQsCurrentSubtabBody();
  });
}
function wireQsCurrentSubtabBody(){
  QS_DIRTY = false;
  if(!isFounder()) return;
  const body = document.getElementById('qsSubtabBody');
  body.querySelectorAll('input, textarea').forEach(el=>{
    el.addEventListener('input', ()=>{ QS_DIRTY = true; });
  });

  if(QS_SUBTAB==='general'){
    const saveBtn = document.getElementById('qsSaveGeneral');
    if(saveBtn) saveBtn.onclick = ()=>{
      const newBank = {
        accountName: document.getElementById('qs_accountName').value.trim(),
        accountNumber: document.getElementById('qs_accountNumber').value.trim(),
        bankName: document.getElementById('qs_bankName').value.trim(),
        memo: document.getElementById('qs_memo').value.trim(),
        qrImageUrl: document.getElementById('qs_qr').value.trim(),
      };
      const qd = quotationDefaults();
      const validityDays = Math.max(1, Number(document.getElementById('qs_validityDays').value)||30);
      DB.upsert('settings', { bankDetails: newBank, quotationDefaults: { ...qd, validityDays } });
      QS_DIRTY = false;
      toast('Quotation settings saved.', 'success');
    };
  } else {
    const type = QS_SUBTAB;
    const saveBtn = document.getElementById('qsSaveTemplate');
    if(saveBtn) saveBtn.onclick = ()=>{
      const lines = document.getElementById(`qs_excl_${type}`).value.split('\n').map(s=>s.trim()).filter(Boolean);
      const qd = quotationDefaults();
      const notes = (qd.notes[type]||[]).map((n,i)=>{
        const ta = document.querySelector(`[data-note="${type}|${i}"]`);
        return ta ? { ...n, text: ta.value } : n;
      });
      DB.upsert('settings', {
        quotationDefaults: {
          ...qd,
          exclusions: { ...qd.exclusions, [type]: lines },
          notes: { ...qd.notes, [type]: notes },
        }
      });
      QS_DIRTY = false;
      toast('Quotation settings saved.', 'success');
    };
    const resetBtn = document.getElementById('qsResetTemplate');
    if(resetBtn) resetBtn.onclick = ()=>{
      if(!confirm(`Reset ${type==='website'?'Website':'System'} Template exclusions and notes back to the factory default? This cannot be undone.`)) return;
      const qd = quotationDefaults();
      DB.upsert('settings', {
        quotationDefaults: {
          ...qd,
          exclusions: { ...qd.exclusions, [type]: [...DEFAULT_QUOTATION_EXCLUSIONS[type]] },
          notes: { ...qd.notes, [type]: DEFAULT_QUOTATION_NOTES[type].map(n=>({...n})) },
        }
      });
      QS_DIRTY = false;
      toast('Quotation settings saved.', 'success');
      document.getElementById('qsSubtabBody').innerHTML = qsSubtabBodyHtml(true);
      wireQsCurrentSubtabBody();
    };
  }
}

if(CURRENT_USER){ initApp(); }
