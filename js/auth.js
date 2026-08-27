/* ==========================================================================
   BizWeb KH CRM — auth.js
   Supabase Auth wrapper.

   Public surface: Auth.login/Auth.logout/Auth.currentUser/Auth.requireAuth/
   Auth.redirectIfLoggedIn/Auth.restoreSession — unchanged shape from the
   old localStorage-only build so every other module (which reads
   CURRENT_USER.name / .role / .color / .initials synchronously) keeps
   working untouched.

   Session shape: { id, email, name, role, color, initials } — `role` is
   the canonical snake_case value from the `profiles.role` enum
   (founder_admin | sales | partner_operations). Use ROLE_LABELS below for
   display text — never show `role` raw in the UI.

   IMPORTANT: Auth.currentUser() is still SYNCHRONOUS (it just reads an
   in-memory + localStorage-cached session object) so app.js's top-level
   `const CURRENT_USER = Auth.requireAuth();` keeps working without being
   rewritten. What makes this safe is Auth.restoreSession() — an async
   function that dashboard/index.html's bootstrap script awaits (together
   with DB.init()) BEFORE app.js is ever loaded, so the in-memory session
   cache is already populated by the time any synchronous Auth.currentUser()
   call happens.
   ========================================================================== */

const Auth = {
  _session: null,

  async login(email, password){
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if(error || !data.session) return null;

    const { data: profile, error: profileErr } = await supabaseClient
      .from('profiles').select('*').eq('id', data.user.id).single();
    if(profileErr || !profile) return null;

    const session = {
      id: data.user.id, email: data.user.email,
      name: profile.name, role: profile.role,
      color: profile.color || '#1d7bff', initials: profile.initials || initialsOfName(profile.name),
    };
    sessionSet(session);
    return session;
  },

  async logout(){
    try{ await supabaseClient.auth.signOut(); }
    catch(e){ console.error('Supabase signOut failed', e); }
    Auth._session = null;
    localStorage.removeItem(BZ_SESSION_KEY);
  },

  // Synchronous — reads the in-memory cache populated by login() or
  // restoreSession(). Falls back to the localStorage mirror (sessionSet())
  // only as a same-tab convenience; the source of truth is always the live
  // Supabase session, re-checked by restoreSession() on every page load.
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

  // Called once by dashboard/index.html's bootstrap script, BEFORE app.js
  // (or any other feature module) is loaded. Confirms there's a live
  // Supabase session, fetches the matching profile, and populates the
  // in-memory session cache used by the synchronous currentUser() above.
  // Returns the session object, or null if there is no live session (the
  // caller is responsible for redirecting to the login page in that case).
  async restoreSession(){
    const { data, error } = await supabaseClient.auth.getSession();
    if(error || !data.session){ Auth._session = null; return null; }

    const { data: profile, error: profileErr } = await supabaseClient
      .from('profiles').select('*').eq('id', data.session.user.id).single();
    if(profileErr || !profile){ Auth._session = null; return null; }

    const session = {
      id: data.session.user.id, email: data.session.user.email,
      name: profile.name, role: profile.role,
      color: profile.color || '#1d7bff', initials: profile.initials || initialsOfName(profile.name),
    };
    sessionSet(session);
    return session;
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
  'founder_admin': null, // null = full access, every nav key
  'sales': [
    'dashboard','leads','pipeline','projects','quotations','payments','activity'
  ],
  'partner_operations': [
    'dashboard','leads','pipeline','projects','quotations','payments','activity','users'
  ],
};

// Display-only labels for the canonical role values — use these anywhere
// a role is shown as text; never render the raw `role` string.
const ROLE_LABELS = {
  founder_admin: 'Founder / Admin',
  sales: 'Senior Sales Consultant',
  partner_operations: 'Business Partner / Operations',
};

function roleCanAccess(role, navKey){
  const allowed = ROLE_PERMISSIONS[role];
  if(allowed === null || allowed === undefined) return true; // unlisted role / Founder = full access, fail-open for any role we haven't explicitly restricted yet
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
