/* ==========================================================================
   BizWeb KH CRM — theme.js
   Light/Dark mode toggle (spec §2). Theme is applied via a `data-theme`
   attribute on <html>, which every CSS variable override in styles.css is
   scoped to ([data-theme="dark"]{...}) — see styles.css's "Theme tokens"
   section for the full palette and the reasoning behind which colors are
   theme-aware vs. left as fixed brand colors.

   IMPORTANT — this file is NOT what prevents a flash of the wrong theme on
   load. That's handled by a tiny synchronous inline <script> placed at the
   very top of <head> in login/index.html and dashboard/index.html, BEFORE
   the stylesheet and before this file are fetched — because by the time an
   external <script src="theme.js"> could run, the page has often already
   painted once in the default (light) theme. The inline snippet duplicates
   just the read-localStorage-and-set-attribute logic for that reason; this
   file is the single source of truth for everything else (the toggle
   button, persisting a change, the icon shown).
   ========================================================================== */

const THEME_STORAGE_KEY = 'crm-theme';

function getStoredTheme(){
  try{ return localStorage.getItem(THEME_STORAGE_KEY); }catch(e){ return null; }
}

// 'light' is the default and is expressed by the ABSENCE of the attribute
// (the :root tokens already ARE the light theme) rather than an explicit
// data-theme="light" — keeps the light path a true no-op against :root.
function applyTheme(theme){
  if(theme==='dark') document.documentElement.setAttribute('data-theme','dark');
  else document.documentElement.removeAttribute('data-theme');
}

function currentTheme(){
  return document.documentElement.getAttribute('data-theme')==='dark' ? 'dark' : 'light';
}

function setTheme(theme){
  applyTheme(theme);
  try{ localStorage.setItem(THEME_STORAGE_KEY, theme); }catch(e){ console.error('Theme preference could not be saved', e); }
}

// Icon shown is the theme a click will SWITCH TO (spec §2's own example):
// a moon while in light mode invites going dark; a sun while in dark mode
// invites going back to light — icon()/ICONS are defined in app.js, which
// has always finished loading by the time renderShell() (and therefore
// this) actually runs, regardless of theme.js's own position in the
// dashboard bootstrap's script list.
function themeToggleIconHtml(theme){
  return icon(theme==='dark' ? 'sun' : 'moon');
}

// Wires the topbar's theme toggle button (spec §2). Safe to call with a
// null element (e.g. a page with no topbar) — just does nothing.
function wireThemeToggle(btn){
  if(!btn) return;
  const render = ()=>{ btn.innerHTML = themeToggleIconHtml(currentTheme()); };
  render();
  btn.onclick = ()=>{
    setTheme(currentTheme()==='dark' ? 'light' : 'dark');
    render();
  };
}
