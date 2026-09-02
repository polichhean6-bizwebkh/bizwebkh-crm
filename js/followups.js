/* ==========================================================================
   BizWeb KH CRM — followups.js
   Follow-up MODAL LOGIC (Set Follow-up / Reschedule / Complete Follow-up /
   Add Note) — used from Pipeline and Lead View, the two places the sales
   follow-up workflow now lives (the standalone Follow-ups page below is
   kept in the codebase, per spec §1, but is no longer reachable from
   normal navigation — see app.js currentRoute()).

   All of this writes to the exact same canonical lead record Lead Records
   and Pipeline already read — nothing here creates a second/duplicate
   follow-up dataset. `db.followups` stays a plain append-only note log
   (unchanged data shape from prior sessions), never a source of truth for
   next_follow_up_date/last_contact — those always live directly on the
   lead record itself.
   ========================================================================== */

/* ---------------------------------------------------------------------- */
/* Shared "pick a follow-up date" control — spec §5's preset options,     */
/* reused by both Set Follow-up and Reschedule (and Complete Follow-up's  */
/* "schedule next?" step) so the UX is identical everywhere it appears.   */
/* ---------------------------------------------------------------------- */

function followupPresetChipsHtml(idPrefix, currentValue){
  return `
    <div class="flex-row" style="flex-wrap:wrap;gap:6px;margin-bottom:10px">
      <button type="button" class="btn btn-outline btn-sm" data-fu-preset="${idPrefix}:today">Today</button>
      <button type="button" class="btn btn-outline btn-sm" data-fu-preset="${idPrefix}:tomorrow">Tomorrow</button>
      <button type="button" class="btn btn-outline btn-sm" data-fu-preset="${idPrefix}:3days">In 3 Days</button>
      <button type="button" class="btn btn-outline btn-sm" data-fu-preset="${idPrefix}:nextweek">Next Week</button>
    </div>
    <div class="form-field"><label>Custom Date</label><input type="date" id="${idPrefix}_date" min="${todayLocalISO()}" value="${currentValue||''}"></div>
  `;
}

function wireFollowupPresetChips(overlay, idPrefix){
  overlay.querySelectorAll(`[data-fu-preset^="${idPrefix}:"]`).forEach(btn=>{
    btn.onclick = ()=>{
      const key = btn.dataset.fuPreset.split(':')[1];
      const dateInput = overlay.querySelector(`#${idPrefix}_date`);
      if(key==='today') dateInput.value = daysFromNow(0);
      else if(key==='tomorrow') dateInput.value = daysFromNow(1);
      else if(key==='3days') dateInput.value = daysFromNow(3);
      else if(key==='nextweek') dateInput.value = daysFromNow(7);
      overlay.querySelectorAll(`[data-fu-preset^="${idPrefix}:"]`).forEach(b=> b.classList.remove('btn-primary'));
      overlay.querySelectorAll(`[data-fu-preset^="${idPrefix}:"]`).forEach(b=> b.classList.add('btn-outline'));
      btn.classList.remove('btn-outline'); btn.classList.add('btn-primary');
    };
  });
}

/* ---------------------------------------------------------------------- */
/* Set Follow-up / Reschedule (spec §5) — one shared modal; title and      */
/* Activity Log type/wording adapt to whether a follow-up date already     */
/* exists on the lead. Saves next_follow_up_date, follow_up_created_by     */
/* and follow_up_updated_at directly on the canonical lead record — the    */
/* same record Lead Records and Pipeline both read, so nothing needs a     */
/* separate sync step.                                                     */
/* ---------------------------------------------------------------------- */

function openSetFollowupModal(leadId, onDone){
  const lead = DB.find('leads', leadId);
  if(!lead) return;
  const isReschedule = !!lead.nextFollowup;
  const html = `
    <div class="modal-head"><h3>${isReschedule ? 'Reschedule Follow-up' : 'Set Follow-up'}</h3><button class="modal-close" id="sfClose">&times;</button></div>
    <div class="modal-body">
      <p class="text-muted" style="margin-top:0;font-size:13px">${escapeHtml(lead.clientName)} — ${escapeHtml(lead.businessName)}</p>
      ${isReschedule ? `<div class="form-field" style="margin-bottom:10px"><label>Current Follow-up Date</label><input value="${fmtDate(lead.nextFollowup)}" disabled></div>` : ''}
      ${followupPresetChipsHtml('sf', lead.nextFollowup)}
      ${isReschedule ? `<div class="form-field"><label>Reason (optional)</label><textarea id="sf_reason" placeholder="Why is this being rescheduled?"></textarea></div>` : ''}
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="sfNoFollowup">No Follow-up</button>
      <button class="btn btn-secondary" id="sfCancel">Cancel</button>
      <button class="btn btn-primary" id="sfSave">Save</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#sfClose').onclick = closeModal;
    overlay.querySelector('#sfCancel').onclick = closeModal;
    wireFollowupPresetChips(overlay, 'sf');

    function commit(newDate){
      const oldDate = lead.nextFollowup;
      const now = new Date().toISOString();
      lead.nextFollowup = newDate || null;
      lead.followUpCreatedBy = lead.followUpCreatedBy || (newDate ? CURRENT_USER.name : lead.followUpCreatedBy);
      lead.followUpUpdatedAt = now;
      lead.updatedAt = now;
      DB.upsert('leads', lead);

      if(!newDate){
        const reason = null;
        DB.upsert('leadActivities', { leadId: lead.id, activityType:'follow_up_cancelled',
          note: reason, followUpDate: null, completedAt: null, createdBy: CURRENT_USER.name, createdAt: now });
        logActivity({ userName: CURRENT_USER.name, refType:'lead', refId: lead.id, refLabel:`${lead.clientName} — ${lead.businessName}`,
          type:'Follow-up Cancelled', description:`${CURRENT_USER.name} removed the follow-up${oldDate?` (was ${fmtDate(oldDate)})`:''} for ${lead.clientName}.`,
          fromValue: oldDate, toValue: null });
        toast('Follow-up removed.', 'success');
      } else if(isReschedule){
        const reason = overlay.querySelector('#sf_reason')?.value.trim();
        DB.upsert('leadActivities', { leadId: lead.id, activityType:'follow_up_rescheduled',
          note: reason || null, followUpDate: newDate, completedAt: null, createdBy: CURRENT_USER.name, createdAt: now });
        logActivity({ userName: CURRENT_USER.name, refType:'lead', refId: lead.id, refLabel:`${lead.clientName} — ${lead.businessName}`,
          type:'Follow-up Rescheduled', description:`${CURRENT_USER.name} rescheduled follow-up: ${oldDate?fmtDate(oldDate):'—'} → ${fmtDate(newDate)}`,
          fromValue: oldDate, toValue: newDate, remark: reason || null });
        toast('Follow-up rescheduled.', 'success');
      } else {
        DB.upsert('leadActivities', { leadId: lead.id, activityType:'follow_up_scheduled',
          note: null, followUpDate: newDate, completedAt: null, createdBy: CURRENT_USER.name, createdAt: now });
        logActivity({ userName: CURRENT_USER.name, refType:'lead', refId: lead.id, refLabel:`${lead.clientName} — ${lead.businessName}`,
          type:'Follow-up Scheduled', description:`${CURRENT_USER.name} scheduled a follow-up for ${fmtDate(newDate)}.`,
          toValue: newDate });
        toast('Follow-up scheduled.', 'success');
      }
      closeModal();
      if(onDone) onDone();
      if(currentRoute()==='dashboard') router();
    }

    overlay.querySelector('#sfSave').onclick = ()=>{
      const dateInput = overlay.querySelector('#sf_date');
      const newDate = dateInput.value;
      if(!newDate){ toast('Please choose a date, or use "No Follow-up".', 'error'); return; }
      if(isPastLocalDate(newDate)){ dateInput.style.borderColor='var(--red)'; toast('Follow-up date cannot be in the past.', 'error'); return; }
      commit(newDate);
    };
    overlay.querySelector('#sfNoFollowup').onclick = ()=> commit(null);
  }});
}

// Kept as an explicit alias — "Reschedule" (spec §4) is the same shared
// modal as Set Follow-up; it only ever shows the Reschedule title/copy when
// the lead already has a next_follow_up_date, which openSetFollowupModal
// already detects on its own.
function openRescheduleModal(leadId, onDone){ openSetFollowupModal(leadId, onDone); }

/* ---------------------------------------------------------------------- */
/* Complete Follow-up (spec §6) — records completion, updates Last        */
/* Contact, logs it, then asks whether/when to schedule the next one.     */
/* Never touches the lead's sales stage.                                  */
/* ---------------------------------------------------------------------- */

function openCompleteFollowupModal(leadId, onDone){
  const lead = DB.find('leads', leadId);
  if(!lead) return;
  const html = `
    <div class="modal-head"><h3>Complete Follow-up</h3><button class="modal-close" id="cfClose">&times;</button></div>
    <div class="modal-body">
      <p class="text-muted" style="margin-top:0;font-size:13px">${escapeHtml(lead.clientName)} — ${escapeHtml(lead.businessName)}</p>
      <div class="form-field"><label>Completion Note (optional)</label><textarea id="cfNote" placeholder="What was discussed / outcome…"></textarea></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="cfCancel">Cancel</button>
      <button class="btn btn-primary" id="cfSave">Mark Completed</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#cfClose').onclick = closeModal;
    overlay.querySelector('#cfCancel').onclick = closeModal;
    overlay.querySelector('#cfSave').onclick = ()=>{
      const note = overlay.querySelector('#cfNote').value.trim();
      const today = new Date().toISOString().slice(0,10);
      const now = new Date().toISOString();
      lead.lastContact = today;
      lead.updatedAt = now;
      DB.upsert('leads', lead);

      DB.upsert('leadActivities', { leadId, activityType:'follow_up_completed',
        note: note || null, followUpDate: null, completedAt: now, createdBy: CURRENT_USER.name, createdAt: now });

      logActivity({ userName: CURRENT_USER.name, refType:'lead', refId: lead.id, refLabel:`${lead.clientName} — ${lead.businessName}`,
        type:'Follow-up Completed',
        description:`${CURRENT_USER.name} completed follow-up with ${lead.clientName}${note?`: "${note}"`:''}. Last Contact updated to ${fmtDate(today)}.`,
        remark: note || null });

      toast('Follow-up marked completed.', 'success');
      closeModal();
      if(onDone) onDone();
      if(currentRoute()==='dashboard') router();

      // Spec §6: always ASK whether to schedule the next follow-up — never
      // silently set or silently skip one — and never touch the sales stage.
      setTimeout(()=> openScheduleNextFollowupModal(leadId, onDone), 150);
    };
  }});
}

function openScheduleNextFollowupModal(leadId, onDone){
  const lead = DB.find('leads', leadId);
  if(!lead) return;
  const html = `
    <div class="modal-head"><h3>Schedule next follow-up?</h3><button class="modal-close" id="snClose">&times;</button></div>
    <div class="modal-body">
      <p class="text-muted" style="margin-top:0;font-size:13px">${escapeHtml(lead.clientName)} — ${escapeHtml(lead.businessName)}</p>
      ${followupPresetChipsHtml('sn', '')}
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="snNone">No Further Follow-up</button>
      <button class="btn btn-primary" id="snSave">Schedule</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#snClose').onclick = closeModal;
    wireFollowupPresetChips(overlay, 'sn');

    function commit(newDate){
      const now = new Date().toISOString();
      lead.nextFollowup = newDate || null;
      if(newDate) lead.followUpCreatedBy = CURRENT_USER.name;
      lead.followUpUpdatedAt = now;
      lead.updatedAt = now;
      DB.upsert('leads', lead);
      DB.upsert('leadActivities', { leadId: lead.id, activityType: newDate ? 'follow_up_scheduled' : 'follow_up_cancelled',
        note: null, followUpDate: newDate || null, completedAt: null, createdBy: CURRENT_USER.name, createdAt: now });
      logActivity({ userName: CURRENT_USER.name, refType:'lead', refId: lead.id, refLabel:`${lead.clientName} — ${lead.businessName}`,
        type: newDate ? 'Follow-up Scheduled' : 'Follow-up Cancelled',
        description: newDate ? `${CURRENT_USER.name} scheduled the next follow-up for ${fmtDate(newDate)}.` : `${CURRENT_USER.name} chose no further follow-up for ${lead.clientName}.`,
        toValue: newDate || null });
      toast(newDate ? 'Next follow-up scheduled.' : 'No further follow-up scheduled.', 'success');
      closeModal();
      if(onDone) onDone();
      if(currentRoute()==='dashboard') router();
    }

    overlay.querySelector('#snSave').onclick = ()=>{
      const dateInput = overlay.querySelector('#sn_date');
      const newDate = dateInput.value;
      if(!newDate){ toast('Please choose a date, or use "No Further Follow-up".', 'error'); return; }
      if(isPastLocalDate(newDate)){ dateInput.style.borderColor='var(--red)'; toast('Follow-up date cannot be in the past.', 'error'); return; }
      commit(newDate);
    };
    overlay.querySelector('#snNone').onclick = ()=> commit(null);
  }});
}

/* ---------------------------------------------------------------------- */
/* Add Note (spec §4) — logs a follow-up note without changing the next   */
/* follow-up date. Updates Last Contact, same as before.                  */
/* ---------------------------------------------------------------------- */

function openFollowupNoteModal(leadId, onDone){
  const lead = DB.find('leads', leadId);
  const html = `
    <div class="modal-head"><h3>Add Follow-up Note</h3><button class="modal-close" id="fnClose">&times;</button></div>
    <div class="modal-body">
      <p class="text-muted" style="margin-top:0;font-size:13px">${escapeHtml(lead.clientName)} — ${escapeHtml(lead.businessName)}</p>
      <div class="form-field"><label class="required">Note</label><textarea id="fnNote" placeholder="What happened during this follow-up?"></textarea></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="fnCancel">Cancel</button>
      <button class="btn btn-primary" id="fnSave">Save Note</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#fnClose').onclick = closeModal;
    overlay.querySelector('#fnCancel').onclick = closeModal;
    overlay.querySelector('#fnSave').onclick = ()=>{
      const note = overlay.querySelector('#fnNote').value.trim();
      if(!note){ toast('Please write a note.', 'error'); return; }
      const now = new Date().toISOString();
      DB.upsert('leadActivities', { leadId, activityType:'note_added', note,
        followUpDate: null, completedAt: null, createdBy: CURRENT_USER.name, createdAt: now });
      lead.lastContact = new Date().toISOString().slice(0,10);
      DB.upsert('leads', lead);
      logActivity({ userName: CURRENT_USER.name, refType:'lead', refId: lead.id, refLabel:`${lead.clientName} — ${lead.businessName}`,
        type:'Follow-up Added', description:`${CURRENT_USER.name} added follow-up note: "${note}"` });
      toast('Follow-up note saved.', 'success');
      closeModal();
      if(onDone) onDone();
    };
  }});
}

/* ==========================================================================
   Standalone Follow-ups PAGE — UNUSED as of this session. The Follow-ups
   sidebar tab and route were removed (spec §1) and its workflow folded
   into Pipeline (see pipeline.js) + the modals above. This function is
   kept, unmodified in behavior, purely so no follow-up logic is deleted;
   it is never called from normal navigation (see app.js currentRoute(),
   which redirects any "#followups" hash straight to Pipeline instead).
   ========================================================================== */

let fuFilters = { sales:'', status:'', search:'' };

function renderFollowupsPage(){
  const el = document.getElementById('pageContent');
  let leads = activeLeads().filter(l=> l.nextFollowup && !['Lost','Confirmed'].includes(l.status));

  const salesList = [...new Set(activeLeads().map(l=>l.assignedSales).filter(Boolean))].sort();
  const statusList = LEAD_STATUSES.filter(s=> !['Lost','Confirmed'].includes(s));

  if(fuFilters.sales) leads = leads.filter(l=> l.assignedSales===fuFilters.sales);
  if(fuFilters.status) leads = leads.filter(l=> l.status===fuFilters.status);
  if(fuFilters.search){
    const q = fuFilters.search.toLowerCase();
    leads = leads.filter(l=> (l.clientName||'').toLowerCase().includes(q) || (l.businessName||'').toLowerCase().includes(q) || (l.phone||'').toLowerCase().includes(q));
  }

  const groups = { overdue:[], today:[], tomorrow:[], week:[], later:[] };
  leads.forEach(l=>{ const u = urgencyOf(l.nextFollowup); if(groups[u]) groups[u].push(l); });
  Object.values(groups).forEach(g=> g.sort((a,b)=> new Date(a.nextFollowup)-new Date(b.nextFollowup)));

  const groupDefs = [
    ['overdue','Overdue'], ['today','Today'], ['tomorrow','Tomorrow'], ['week','This Week'], ['later','Later']
  ];

  const el2 = el;
  el2.innerHTML = `
    <div class="filters-bar">
      <div class="search-box">
        ${icon('search')}
        <input type="text" id="fuSearch" placeholder="Search client, business, or phone…" value="${escapeHtml(fuFilters.search)}">
      </div>
      <select id="fuSales" class="sel">
        <option value="">All Sales</option>
        ${salesList.map(s=>`<option value="${escapeHtml(s)}" ${fuFilters.sales===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}
      </select>
      <select id="fuStatus" class="sel">
        <option value="">All Statuses</option>
        ${statusList.map(s=>`<option value="${s}" ${fuFilters.status===s?'selected':''}>${s}</option>`).join('')}
      </select>
      <div class="spacer"></div>
      <div class="text-muted" style="font-size:12.5px">${leads.length} lead${leads.length===1?'':'s'} with an upcoming follow-up.</div>
    </div>
    ${groupDefs.map(([key,label])=>{
      const items = groups[key];
      if(!items.length) return '';
      return `
        <div class="fu-group-head"><h4>${label}</h4><span class="count">${items.length}</span></div>
        <div class="table-wrap scroll-x" style="margin-bottom:6px">
          <table class="data-table">
            <thead><tr><th>Client</th><th>Business</th><th>Phone</th><th>Sales</th><th>Status</th><th>Next Follow-up</th><th>Last Contact</th><th>Action</th></tr></thead>
            <tbody>
              ${items.map(l=>`
                <tr>
                  <td class="cell-strong">${escapeHtml(l.clientName)}</td>
                  <td>${escapeHtml(l.businessName)}</td>
                  <td>${escapeHtml(l.phone)}</td>
                  <td><div class="flex-row"><div class="avatar-sm" style="background:${userColor(l.assignedSales)}">${userInitials(l.assignedSales)}</div>${escapeHtml(l.assignedSales)}</div></td>
                  <td>${statusBadge(l.status)}</td>
                  <td>${fmtDate(l.nextFollowup)}</td>
                  <td>${fmtDate(l.lastContact)}</td>
                  <td>
                    <div class="flex-row" style="flex-wrap:wrap;gap:6px">
                      <button class="btn btn-primary btn-sm" data-complete="${l.id}">Complete Follow-up</button>
                      <button class="btn btn-secondary btn-sm" data-call="${l.id}">Call</button>
                      <button class="btn btn-secondary btn-sm" data-note="${l.id}">Add Note</button>
                      <button class="btn btn-secondary btn-sm" data-resched="${l.id}">Reschedule</button>
                      <button class="btn btn-outline btn-sm" data-open="${l.id}">Open Lead</button>
                    </div>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      `;
    }).join('') || `<div class="empty-state">${icon('clock')}<div>No follow-ups match these filters.</div></div>`}
  `;

  el2.querySelector('#fuSales').onchange = (e)=>{ fuFilters.sales = e.target.value; renderFollowupsPage(); };
  el2.querySelector('#fuStatus').onchange = (e)=>{ fuFilters.status = e.target.value; renderFollowupsPage(); };
  el2.querySelector('#fuSearch').oninput = (e)=>{ fuFilters.search = e.target.value; renderFollowupsPage(); };

  el2.querySelectorAll('[data-open]').forEach(x=> x.onclick = ()=> openLeadDetailModal(x.dataset.open));
  el2.querySelectorAll('[data-note]').forEach(x=> x.onclick = ()=> openFollowupNoteModal(x.dataset.note, renderFollowupsPage));
  el2.querySelectorAll('[data-resched]').forEach(x=> x.onclick = ()=> openRescheduleModal(x.dataset.resched, renderFollowupsPage));
  el2.querySelectorAll('[data-complete]').forEach(x=> x.onclick = ()=> openCompleteFollowupModal(x.dataset.complete, renderFollowupsPage));
  el2.querySelectorAll('[data-call]').forEach(x=> x.onclick = ()=>{
    const lead = DB.find('leads', x.dataset.call);
    logActivity({ userName: CURRENT_USER.name, refType:'lead', refId: lead.id, refLabel:`${lead.clientName} — ${lead.businessName}`,
      type:'Note Added', description:`${CURRENT_USER.name} contacted ${lead.clientName} by phone.` });
    lead.lastContact = new Date().toISOString().slice(0,10);
    DB.upsert('leads', lead);
    toast(`Marked call with ${lead.clientName}.`, 'success');
    renderFollowupsPage();
  });
}
