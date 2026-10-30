/* ==========================================================================
   BizWeb KH CRM — auth.js  (Neon Auth)
   Neon Auth wrapper. Same public surface as the Supabase build:
   Auth.login/Auth.logout/Auth.currentUser/Auth.requireAuth/
   Auth.redirectIfLoggedIn/Auth.restoreSession — so every other module (which reads
   CURRENT_USER.name / .role / .color / .initials synchronously) keeps working untouched.

   Session shape: { id, email, name, role, color, initials } — `role` is the canonical
   snake_case value (founder_admin | sales | sales_rep | partner_operations | finance).
   Use ROLE_LABELS below for display text — never show `role` raw in the UI.

   What changed from the Supabase build:
     * sign-in / session / refresh / sign-out go through the pinned Neon Auth SDK (js/neon-client.js)
     * the profile is read with GET /api/me (role + status) instead of a table read
     * an invited user's first successful sign-in activates the account (POST /api/me/activate);
       a deactivated user is refused exactly as before
     * the "last login" stamp is POST /api/me/touch-login
   Auth.currentUser() is still SYNCHRONOUS: dashboard/index.html awaits Auth.restoreSession()
   and DB.init() BEFORE app.js is loaded, then calls Auth.completeSession() to add the display
   fields (name/colour/initials) from the loaded staff list.
   ========================================================================== */

const Auth = {
  _session: null,
  // Why restoreSession() returned null: { state: 'auth_required'|'not_authorized'|'backend_unavailable', reason, requestId }
  lastStatus: null,

  async login(email, password){
    Auth._loginBlockedReason = null;
    let data, error;
    try{ ({ data, error } = await BZ.authClient.signInWithPassword({ email, password })); }
    catch(e){ Auth._loginBlockedReason = 'Cannot reach the sign-in service. Check your internet connection and try again.'; return null; }
    if(error || !data || !data.session){
      if(error && (error.status === 0 || /fetch|network/i.test(String(error.message||'')))) Auth._loginBlockedReason = 'Cannot reach the sign-in service. Check your internet connection and try again.';
      else if(error && error.status === 429) Auth._loginBlockedReason = 'Too many sign-in attempts. Please wait a minute and try again.';
      else if(error && (error.code === 'BANNED_USER' || /banned|suspended/i.test(String(error.message||'')))) Auth._loginBlockedReason = 'This account has been suspended. Please contact your Founder/Admin.';
      return null;
    }

    let me = await BZ.api('GET', '/api/me');
    if(me.status === 0 || me.status >= 500){
      Auth._loginBlockedReason = 'Signed in, but the CRM server is not answering. Please try again in a moment.';
      try{ await BZ.authClient.signOut(); }catch(e){}
      return null;
    }
    if(me.status !== 200 || !me.body){
      // no CRM profile, or the account is refused
      Auth._loginBlockedReason = me.status === 403 ? 'This account has no access to the CRM. Please contact your Founder/Admin.' : null;
      try{ await BZ.authClient.signOut(); }catch(e){ console.error('signOut failed', e); }
      Auth._session = null;
      return null;
    }

    // Deactivated staff must never reach a live session, even though their password still works.
    if(me.body.status === 'inactive'){
      try{ await BZ.authClient.signOut(); }catch(e){ console.error('signOut failed', e); }
      Auth._session = null;
      Auth._loginBlockedReason = 'This account has been deactivated. Please contact your Founder/Admin.';
      return null;
    }
    // An invited user who now has a working password (set through the emailed link) becomes Active on first sign-in.
    if(me.body.status === 'invited'){
      const act = await BZ.api('POST', '/api/me/activate');
      if(act.status !== 200){
        try{ await BZ.authClient.signOut(); }catch(e){}
        Auth._session = null;
        Auth._loginBlockedReason = 'Your invitation could not be activated. Please use the link in your invitation email to set a password, or contact your Founder/Admin.';
        return null;
      }
      me = await BZ.api('GET', '/api/me');
    }

    const session = { id: me.body.id, email: data.user && data.user.email || email, name: '', role: me.body.role, color: '#1d7bff', initials: '' };
    sessionSet(session);
    // Best-effort — never block login on this.
    try{ await BZ.api('POST', '/api/me/touch-login'); }catch(e){ console.error('touch-login failed', e); }
    return session;
  },

  // Last blocked-login reason (set by login() when it rejects an invited/inactive/unreachable case) —
  // login/index.html reads this once, right after a failed login() call.
  _loginBlockedReason: null,
  consumeLoginBlockedReason(){
    const r = Auth._loginBlockedReason;
    Auth._loginBlockedReason = null;
    return r;
  },

  async logout(){
    try{ await BZ.authClient.signOut(); }
    catch(e){ console.error('Neon Auth signOut failed', e); }
    Auth._session = null;
    try{ localStorage.removeItem(BZ_SESSION_KEY); }catch(e){}
  },

  // Synchronous — reads the in-memory cache populated by login() or restoreSession().
  currentUser(){
    if(Auth._session) return Auth._session;
    try{
      const raw = localStorage.getItem(BZ_SESSION_KEY);
      if(!raw) return null;
      return JSON.parse(raw);
    }catch(e){ return null; }
  },

  requireAuth(){
    const u = this.currentUser();
    if(!u){ window.location.href = getLoginPath(); }
    return u;
  },

  redirectIfLoggedIn(){
    const u = this.currentUser();
    if(u){ window.location.href = getDashboardPath(); }
  },

  // Called once by dashboard/index.html's bootstrap script, BEFORE DB.init(). Confirms there is a live Neon Auth
  // session and that the CRM accepts it (GET /api/me). Returns the minimal session, or null with Auth.lastStatus saying why.
  // A failure is NEVER silent: backend problems are reported as 'backend_unavailable', not as "signed out".
  async restoreSession(){
    Auth.lastStatus = null;
    let token = null;
    try{ token = await BZ.getToken(); }catch(e){ token = null; }
    if(!token){ Auth._session = null; try{ localStorage.removeItem(BZ_SESSION_KEY); }catch(e){} Auth.lastStatus = { state: 'auth_required', reason: 'no session' }; return null; }

    const me = await BZ.api('GET', '/api/me');
    if(me.status === 0 || me.status >= 500){ Auth._session = null; Auth.lastStatus = { state: 'backend_unavailable', reason: me.body && me.body.error || ('http ' + me.status), requestId: me.requestId }; return null; }
    if(me.status === 401){ Auth._session = null; try{ localStorage.removeItem(BZ_SESSION_KEY); }catch(e){} Auth.lastStatus = { state: 'auth_required', reason: me.body && me.body.error }; return null; }
    if(me.status !== 200 || !me.body || !me.body.id){
      Auth._session = null;
      try{ await BZ.authClient.signOut(); }catch(e){}
      try{ localStorage.removeItem(BZ_SESSION_KEY); }catch(e){}
      Auth.lastStatus = { state: 'not_authorized', reason: me.body && me.body.error || ('http ' + me.status), requestId: me.requestId };
      return null;
    }
    // A user deactivated mid-session must be kicked out on their very next page load.
    if(me.body.status !== 'active'){
      Auth._session = null;
      try{ await BZ.authClient.signOut(); }catch(e){}
      try{ localStorage.removeItem(BZ_SESSION_KEY); }catch(e){}
      Auth.lastStatus = { state: 'not_authorized', reason: me.body.status === 'invited' ? 'not_activated' : 'inactive' };
      return null;
    }
    let email = '';
    try{ const g = await BZ.authClient.getSession(); email = (g && g.data && g.data.session && g.data.session.user && g.data.session.user.email) || ''; }catch(e){}
    const session = { id: me.body.id, email, name: '', role: me.body.role, color: '#1d7bff', initials: '' };
    sessionSet(session);
    return session;
  },

  // Called by the bootstrap AFTER DB.init(): adds the display fields from the staff list that came with the bootstrap response.
  completeSession(){
    const s = Auth._session; if(!s) return null;
    const u = (typeof DB !== 'undefined' ? DB.all('users') : []).find(x=>x.id === s.id);
    if(!u) return null;     // the server guarantees the caller's own profile is present; if not, the caller treats this as a failed bootstrap
    s.name = u.name; s.role = u.role; s.color = u.color || '#1d7bff'; s.initials = u.initials || initialsOfName(u.name);
    sessionSet(s);
    return s;
  }
};

function initialsOfName(name){
  return String(name||'?').split(' ').filter(Boolean).slice(0,2).map(s=>s[0]).join('').toUpperCase();
}

function sessionSet(user){
  Auth._session = user;
  try{ localStorage.setItem(BZ_SESSION_KEY, JSON.stringify(user)); }
  catch(e){ console.error('Session cache write failed', e); }
}

// Path helpers so login/ and dashboard/ can cross-link regardless of depth
function getLoginPath(){ return '../login/index.html'; }
function getDashboardPath(){ return '../dashboard/index.html'; }

/* ---------------------------------------------------------------------- */
/* Role-based access — a per-nav-key allow list keyed by the CANONICAL     */
/* snake_case role value (matches the `profiles.role` DB enum exactly:    */
/* founder_admin | sales | partner_operations). Any nav key not listed for */
/* a role is hidden from that role's sidebar and its page redirects home   */
/* if opened directly. See ROLE_LABELS for the matching display text.      */
/* ---------------------------------------------------------------------- */
const ROLE_PERMISSIONS = {
  'founder_admin': null, // null = full access, every nav key (includes Settings -> Users & Roles)
  'sales': [
    'dashboard','leads','pipeline','projects','quotations','invoices','receipts','payments','activity'
  ],
  'sales_rep': [
    'dashboard','leads','pipeline','projects','quotations','invoices','receipts','payments','activity'
  ],
  'partner_operations': [
    'dashboard','leads','pipeline','projects','quotations','invoices','receipts','payments','activity','users'
  ],
  'finance': [
    'dashboard','invoices','receipts','payments','activity'
  ],
};

// Display-only labels for the canonical role values — use these anywhere
// a role is shown as text; never render the raw `role` string. Keep in
// lockstep with ROLE_LABELS in supabase/functions/staff-manage/index.ts.
const ROLE_LABELS = {
  founder_admin: 'Founder / Admin',
  sales: 'Senior Sales Consultant',
  sales_rep: 'Sales',
  partner_operations: 'Operations / IT',
  finance: 'Finance',
};

function roleCanAccess(role, navKey){
  const allowed = ROLE_PERMISSIONS[role];
  if(allowed === null) return true; // only an explicit null (Founder/Admin) means full access
  if(!Array.isArray(allowed)) return false; // any role not explicitly listed above is fail-CLOSED, not fail-open
  return allowed.includes(navKey);
}

/* ---------------------------------------------------------------------- */
/* Lead delete permission — structured the same way as ROLE_PERMISSIONS   */
/* above so it maps cleanly onto a future `permissions` table instead of  */
/* a scattered if/else. Archiving a lead is never gated by this (it's     */
/* non-destructive and reversible) — only PERMANENT deletion is.          */
/*   founder_admin        -> can permanently delete unlinked leads         */
/*   sales                -> cannot permanently delete leads               */
/*   partner_operations   -> no delete unless explicitly granted           */
/* ---------------------------------------------------------------------- */
const LEAD_DELETE_ROLES = ['founder_admin'];
function canDeleteLeads(role){ return LEAD_DELETE_ROLES.includes(role); }

/* ---------------------------------------------------------------------- */
/* Payment edit/void permission — Founder/Admin only for now (spec §5/§6). */
/* ---------------------------------------------------------------------- */
const PAYMENT_EDIT_ROLES = ['founder_admin'];
function canEditPayments(role){ return PAYMENT_EDIT_ROLES.includes(role); }

/* ---------------------------------------------------------------------- */
/* Assigned Sales selection — a Sales user may only ever assign a new Lead */
/* or Direct Project to THEMSELVES (never to Founder/Admin or another     */
/* Sales person); Founder/Admin can freely choose/reassign. UI must hide  */
/* the dropdown entirely for a role that can't use it, not just disable   */
/* the options (role-aware UI — see leads.js assignedSalesFieldHtml()).   */
/* ---------------------------------------------------------------------- */
function canChooseAssignedSales(role){ return role !== 'sales'; }

/* ---------------------------------------------------------------------- */
/* isFounder() — the single shared Founder/Admin check used throughout    */
/* the app (leads.js, app.js Settings/Users&Roles, etc.). BUG FIX ("CRM – */
/* Fix + Add Lead Button Regression"): this function was called in 15+    */
/* places across js/app.js and js/leads.js but was never actually         */
/* defined anywhere in the codebase — every call threw                    */
/* "ReferenceError: isFounder is not defined" at runtime. Add/Edit Lead's */
/* click handler (openLeadFormModal -> assignedSalesFieldHtml ->          */
/* assignableSalesUserNames) always hit this immediately and unconditio-  */
/* nally, so the button appeared to silently do nothing — the exception   */
/* aborted the click handler before openModal() was ever reached, with no */
/* user-visible error. Defining it once here (reads the same global       */
/* CURRENT_USER every other role check in this app already relies on)     */
/* fixes every call site at once, instead of patching each one inline.    */
/* ---------------------------------------------------------------------- */
function isFounder(){ return CURRENT_USER.role === 'founder_admin'; }
