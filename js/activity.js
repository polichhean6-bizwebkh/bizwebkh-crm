/* ==========================================================================
   BizWeb KH CRM — activity.js
   Central Activity Log page: every user action across leads, pipeline,
   projects, follow-ups and payments, filterable by user / type / date / ref.
   ========================================================================== */

let ACTIVITY_FILTER_STATE = { user:'', type:'', date:'', ref:'' };

function renderActivityPage(){
  const el = document.getElementById('pageContent');
  const users = DB.all('users').map(u=>u.name);

  el.innerHTML = `
    <div class="filters-bar">
      <select id="aFltUser" class="sel"><option value="">All Users</option>${users.map(u=>`<option ${ACTIVITY_FILTER_STATE.user===u?'selected':''}>${u}</option>`).join('')}</select>
      <select id="aFltType" class="sel"><option value="">All Activity Types</option>${ACTIVITY_TYPES.map(t=>`<option ${ACTIVITY_FILTER_STATE.type===t?'selected':''}>${t}</option>`).join('')}</select>
      <input type="date" id="aFltDate" class="sel" value="${ACTIVITY_FILTER_STATE.date}">
      <div class="search-box" style="min-width:200px">
        ${icon('search')}
        <input type="text" id="aFltRef" placeholder="Search lead / project id or name…" value="${escapeHtml(ACTIVITY_FILTER_STATE.ref)}">
      </div>
      <div class="spacer"></div>
      <button class="btn btn-secondary" id="aFltClear">Clear Filters</button>
    </div>
    <div id="activityTableWrap"></div>
  `;

  document.getElementById('aFltUser').onchange = (e)=>{ ACTIVITY_FILTER_STATE.user=e.target.value; renderActivityTable(); };
  document.getElementById('aFltType').onchange = (e)=>{ ACTIVITY_FILTER_STATE.type=e.target.value; renderActivityTable(); };
  document.getElementById('aFltDate').onchange = (e)=>{ ACTIVITY_FILTER_STATE.date=e.target.value; renderActivityTable(); };
  document.getElementById('aFltRef').oninput = (e)=>{ ACTIVITY_FILTER_STATE.ref=e.target.value; renderActivityTable(); };
  document.getElementById('aFltClear').onclick = ()=>{ ACTIVITY_FILTER_STATE = { user:'', type:'', date:'', ref:'' }; renderActivityPage(); };

  renderActivityTable();
}

function filteredActivities(){
  const f = ACTIVITY_FILTER_STATE;
  return DB.all('activities').filter(a=>{
    if(f.user && a.userName!==f.user) return false;
    if(f.type && a.type!==f.type) return false;
    if(f.date && !a.at.startsWith(f.date)) return false;
    if(f.ref){
      const q = f.ref.toLowerCase();
      if(!(a.refId.toLowerCase().includes(q) || (a.refLabel||'').toLowerCase().includes(q))) return false;
    }
    return true;
  }).sort((a,b)=> new Date(b.at)-new Date(a.at));
}

function renderActivityTable(){
  const wrap = document.getElementById('activityTableWrap');
  const acts = filteredActivities().slice(0, 400);
  wrap.innerHTML = `
    <div class="table-wrap scroll-x">
      <table class="data-table">
        <thead><tr><th>Date / Time</th><th>User</th><th>Lead / Project</th><th>Activity Type</th><th>Description</th></tr></thead>
        <tbody>
          ${acts.length ? acts.map(a=>`
            <tr>
              <td>${fmtDateTime(a.at)}</td>
              <td><div class="flex-row"><div class="avatar-sm" style="background:${userColor(a.userName)}">${userInitials(a.userName)}</div>${escapeHtml(a.userName)}</div></td>
              <td class="cell-link" data-open="${a.refId}" data-type="${a.refType}">${escapeHtml(a.refId)}<div class="cell-sub">${escapeHtml(a.refLabel||'')}</div></td>
              <td>${activityTypeBadge(a.type)}</td>
              <td style="max-width:420px">${escapeHtml(a.description)}${a.remark ? `<div class="cell-sub">"${escapeHtml(a.remark)}"</div>`:''}</td>
            </tr>`).join('') : `<tr><td colspan="5"><div class="empty-row">No activity matches your filters.</div></td></tr>`}
        </tbody>
      </table>
    </div>
    <p class="text-muted" style="margin-top:10px;font-size:12px">Showing ${acts.length} of ${DB.all('activities').length} activity records</p>
  `;
  wrap.querySelectorAll('[data-open]').forEach(x=> x.onclick = ()=>{
    if(x.dataset.type==='project') openProjectDetailModal(x.dataset.open);
    else openLeadDetailModal(x.dataset.open);
  });
}

const ACTIVITY_TYPE_COLORS = {
  'Lead Created':'#1d7bff','Status Changed':'#7c5cff','Follow-up Added':'#18c8ff',
  'Follow-up Rescheduled':'#d98a12','Quotation Sent':'#c9760a','Demo Sent':'#7c5cff',
  'Assigned Sales Changed':'#526584','Deposit Recorded':'#12a775','Payment Recorded':'#12a775',
  'Project Stage Changed':'#155fcc','Project Created':'#1d7bff','Note Added':'#526584','Lead Lost':'#e0473c'
};
function activityTypeBadge(type){
  const c = ACTIVITY_TYPE_COLORS[type] || '#526584';
  return `<span class="badge" style="background:${c}1a;color:${c}"><span class="badge-dot"></span>${escapeHtml(type)}</span>`;
}
