/* ==========================================================================
   BizWeb KH CRM — neon-client.js
   The only place the browser talks to the backend:
     Neon Auth  (sign in, session, refresh, sign out, password reset)  — @neondatabase/auth 0.5.0-beta, pinned, vendored in js/vendor/
     Neon Function API (everything else)                                — Bearer token on every request

   Must be loaded AFTER js/vendor/neon-auth.bundle.js and js/neon-config.js.
   No secret lives here: the browser holds only the signed-in user's own token.
   ========================================================================== */

const BZ = (function(){
  const cfg = window.BZ_CONFIG;
  const authClient = NeonAuthSDK.createAuthClient(cfg.auth, { adapter: NeonAuthSDK.SupabaseAuthAdapter() });

  function jwtExp(t){
    try{ return JSON.parse(atob(t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).exp || 0; }catch(e){ return 0; }
  }

  // Access tokens live 15 minutes. Refresh a little before expiry so a long-open tab keeps working.
  async function getToken(opts){
    const force = !!(opts && opts.forceRefresh);
    let t = null;
    try{ const r = await authClient.getSession(); t = (r && r.data && r.data.session && r.data.session.access_token) || null; }catch(e){ t = null; }
    if(t && (force || jwtExp(t) - Date.now()/1000 < 60)){
      try{
        const r = await authClient.refreshSession();
        t = (r && r.data && r.data.session && r.data.session.access_token) || null;
        if(!t){ const g = await authClient.getSession(); t = (g && g.data && g.data.session && g.data.session.access_token) || null; }
      }catch(e){ /* keep the old token; the API will say if it is really expired */ }
    }
    return t;
  }

  let authLostHandler = null;
  function onAuthLost(fn){ authLostHandler = fn; }

  // One HTTP call. Never throws: always resolves to { status, body, requestId, retryAfter }.
  // status 0 = the request never got an answer (offline, DNS, CORS, timeout).
  async function api(method, path, body, opts){
    opts = opts || {};
    const doFetch = async (token)=>{
      const ctl = new AbortController(); const timer = setTimeout(()=>ctl.abort(), opts.timeoutMs || 25000);
      try{
        const r = await fetch(cfg.api + path, {
          method, signal: ctl.signal,
          headers: Object.assign({ 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, opts.headers || {}),
          body: body === undefined ? undefined : JSON.stringify(body)
        });
        let j = null; try{ j = await r.json(); }catch(e){ /* non-JSON body */ }
        return { status: r.status, body: j, requestId: r.headers.get('x-request-id') || null, retryAfter: Number(r.headers.get('retry-after') || 0) };
      }catch(e){
        return { status: 0, body: { error: e && e.name === 'AbortError' ? 'timeout' : 'network' }, requestId: null, retryAfter: 0 };
      }finally{ clearTimeout(timer); }
    };
    let token = await getToken();
    if(!token){ if(authLostHandler) authLostHandler('no_session'); return { status: 401, body: { error: 'unauthenticated' }, requestId: null, retryAfter: 0 }; }
    let res = await doFetch(token);
    // A 401 means the server refused BEFORE doing anything, so it is always safe to refresh once and repeat — including for writes.
    if(res.status === 401 && res.body && (res.body.error === 'token_expired' || res.body.error === 'invalid_token')){
      const t2 = await getToken({ forceRefresh: true });
      if(t2 && t2 !== token){ res = await doFetch(t2); }
      if(res.status === 401 && authLostHandler) authLostHandler(res.body && res.body.error);
    }
    return res;
  }

  // Turns a failed result into a short message a staff member can act on. Never shows SQL, stack traces or table names.
  function explain(res, fallback){
    const s = res && res.status, code = res && res.body && res.body.error, msg = res && res.body && res.body.message;
    const ref = res && res.requestId ? ' (ref ' + String(res.requestId).slice(0, 8) + ')' : '';
    if(s === 0) return (code === 'timeout' ? 'The server took too long to answer.' : 'Cannot reach the server. Check your internet connection.') + ' Your data was not saved. Please try again.';
    if(s === 401) return 'Your session has expired. Please sign in again.';
    if(s === 403){
      if(code === 'inactive') return 'This account has been deactivated. Please contact your Founder/Admin.';
      if(code === 'not_activated') return 'This account has not been activated yet.';
      if(code === 'no_profile') return 'This account has no CRM profile. Please contact your Founder/Admin.';
      return 'You do not have permission to do that.';
    }
    if(s === 404) return (fallback ? fallback + ' ' : '') + 'The record no longer exists. Please refresh the page.';
    if(s === 409){
      if(code === 'conflict') return 'This record was changed by someone else since you opened it. Please refresh the page and try again.';
      if(code === 'code_taken') return 'That project code is already in use. Please choose another.';
      if(code === 'duplicate') return msg || 'This already exists.';
      if(code === 'reference_missing_or_in_use' || code === 'not_deletable') return 'This record is linked to other records and cannot be deleted or changed this way.';
      return msg || 'This change conflicts with existing data.';
    }
    if(s === 400 || s === 422){
      if(code === 'invalid_value') return 'One of the values is not allowed. Please check the form.';
      return (msg ? msg : 'Some of the information is not valid. Please check the form.');
    }
    if(s === 413) return 'That is too much data to save at once.';
    if(s === 429) return 'Too many requests. Please wait ' + Math.max(1, (res.retryAfter || 5)) + ' seconds and try again.';
    if(s === 503 || s === 502 || s === 504) return 'The server is temporarily unavailable. Your data was not saved. Please try again in a moment.' + ref;
    return (fallback || 'Something went wrong. Your data was not saved.') + ref;
  }

  return { config: cfg, authClient, getToken, api, explain, onAuthLost };
})();
