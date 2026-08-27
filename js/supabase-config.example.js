/* ==========================================================================
   BizWeb KH CRM — Supabase config placeholder (SCAFFOLD ONLY)
   ==========================================================================
   This file is NOT wired into the app yet. The app still runs entirely on
   localStorage (js/data.js) as of this commit.

   When a future session has real Supabase credentials:
     1. Copy this file to js/supabase-config.js (git-ignored — see .gitignore)
     2. Fill in the two values below with the project's PUBLIC URL and
        PUBLISHABLE / ANON key only — never the service_role key.
     3. Follow AUTH_MIGRATION_NOTE.md to swap auth.js / data.js internals.

   Only public, browser-safe values belong in this file. If you are ever
   tempted to paste a service_role key, a database password, or an SMTP
   password here — stop, that value does not belong in frontend code at all.
   ========================================================================== */

const SUPABASE_URL = '';       // e.g. 'https://xxxxxxxx.supabase.co'
const SUPABASE_ANON_KEY = '';  // publishable / anon key only
