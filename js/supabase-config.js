/* ==========================================================================
   BizWeb KH CRM — Supabase config (PRODUCTION)
   ==========================================================================
   Public, browser-safe values only (project URL + anon/publishable key).
   Never put a service_role key, DB password, or SMTP password in this file.

   This file must be loaded AFTER the Supabase JS UMD build
   (https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js)
   and BEFORE any script that touches `supabaseClient` (auth.js, data.js).
   It creates the single shared Supabase client used everywhere in the app.
   ========================================================================== */

const SUPABASE_URL = 'https://mmhyhwhymcfltdudhaxr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1taHlod2h5bWNmbHRkdWRoYXhyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2NDYxMDAsImV4cCI6MjEwMzIyMjEwMH0.3vCah15LBnLb0AvgiPlT5u4kC_RwJZRo10FpwoopXBs';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
