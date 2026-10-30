/* BizWeb KH CRM - PRODUCTION backend configuration (Neon, Architecture B).
   Public, browser-safe values only (no secret). Every request is authorised by the signed-in user's token and re-checked on the server.
   Browser -> Neon Auth -> Neon Function API -> Neon PostgreSQL */
(function(){
  var cfg = {
    mode: 'production',
    api:  'https://br-tiny-queen-b3li15g1-crm.compute.c-4.ap-southeast-1.aws.neon.tech',
    auth: 'https://ep-broad-star-b3sn716z.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth'
  };
  window.BZ_CONFIG = cfg;
})();
