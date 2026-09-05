/* ==========================================================================
   BizWeb KH CRM — pipeline.js
   Kanban pipeline board with drag-and-drop; every drop triggers the shared
   status-change confirmation modal before anything is committed.

   Pipeline is now also the sales FOLLOW-UP workspace (the standalone
   Follow-ups page was removed — see app.js currentRoute() and
   followups.js). It reads/writes the exact same lead records as Lead
   Records — no separate follow-up dataset is created or maintained here.
   ========================================================================== */

let PIPELINE_FILTER_STATE = { sales:'', industry:'', followup:'' };

/* ---------------------------------------------------------------------- */
/* Drag auto-scroll — native HTML5 drag-and-drop never auto-scrolls a      */
/* custom scroll container (or the page) on its own, so a card near the    */
/* bottom of a tall column, or a target stage several columns away, was    */
/* unreachable while still holding the drag. This drives scrolling         */
/* manually off the pointer position reported by 'dragover' events, via a  */
/* requestAnimationFrame loop that only runs while a pcard drag is in      */
/* progress. It does NOT touch overflow/CSS, lock scrolling, or change     */
/* pipeline data — purely a drag-time scroll assist.                       */
/* ---------------------------------------------------------------------- */
const PIPELINE_DRAG_SCROLL = { active:false, x:0, y:0, raf:null };
const DRAG_SCROLL_EDGE = 80;       // px from an edge that starts auto-scroll
const DRAG_SCROLL_MAX_SPEED = 22;  // px per animation frame, right at the edge

function pipelineDragScrollTick(){
  if(!PIPELINE_DRAG_SCROLL.active){ PIPELINE_DRAG_SCROLL.raf = null; return; }
  const board = document.getElementById('pipelineBoard');
  const { x, y } = PIPELINE_DRAG_SCROLL;

  // Horizontal — scroll the pipeline board itself so distant stages
  // (far left/right) can be reached without releasing the card.
  if(board){
    const rect = board.getBoundingClientRect();
    if(x < rect.left + DRAG_SCROLL_EDGE){
      const strength = Math.min(1, (rect.left + DRAG_SCROLL_EDGE - x) / DRAG_SCROLL_EDGE);
      board.scrollLeft -= DRAG_SCROLL_MAX_SPEED * strength;
    } else if(x > rect.right - DRAG_SCROLL_EDGE){
      const strength = Math.min(1, (x - (rect.right - DRAG_SCROLL_EDGE)) / DRAG_SCROLL_EDGE);
      board.scrollLeft += DRAG_SCROLL_MAX_SPEED * strength;
    }
  }

  // Vertical — the page itself scrolls (no dedicated vertical scroll
  // container wraps the board), so this scrolls the window/viewport.
  const vh = window.innerHeight;
  if(y < DRAG_SCROLL_EDGE){
    const strength = Math.min(1, (DRAG_SCROLL_EDGE - y) / DRAG_SCROLL_EDGE);
    window.scrollBy(0, -DRAG_SCROLL_MAX_SPEED * strength);
  } else if(y > vh - DRAG_SCROLL_EDGE){
    const strength = Math.min(1, (y - (vh - DRAG_SCROLL_EDGE)) / DRAG_SCROLL_EDGE);
    window.scrollBy(0, DRAG_SCROLL_MAX_SPEED * strength);
  }

  PIPELINE_DRAG_SCROLL.raf = requestAnimationFrame(pipelineDragScrollTick);
}

function startPipelineDragScroll(clientX, clientY){
  PIPELINE_DRAG_SCROLL.x = clientX;
  PIPELINE_DRAG_SCROLL.y = clientY;
  if(PIPELINE_DRAG_SCROLL.active) return;
  PIPELINE_DRAG_SCROLL.active = true;
  if(!PIPELINE_DRAG_SCROLL.raf) PIPELINE_DRAG_SCROLL.raf = requestAnimationFrame(pipelineDragScrollTick);
}

function stopPipelineDragScroll(){
  PIPELINE_DRAG_SCROLL.active = false;
  if(PIPELINE_DRAG_SCROLL.raf){ cancelAnimationFrame(PIPELINE_DRAG_SCROLL.raf); PIPELINE_DRAG_SCROLL.raf = null; }
}

// One document-level 'dragover' listener tracks the live pointer position
// while ANY pipeline card drag is in progress. Wired once (guarded by the
// flag below) rather than inside renderPipelinePage(), so repeated
// re-renders of the Pipeline page never stack up duplicate listeners. It
// only records position — it never calls preventDefault(), so it can't
// interfere with the existing per-column dragover/drop handling below.
if(!window.__pipelineDragScrollWired){
  window.__pipelineDragScrollWired = true;
  document.addEventListener('dragover', (e)=>{
    if(!PIPELINE_DRAG_SCROLL.active) return;
    PIPELINE_DRAG_SCROLL.x = e.clientX;
    PIPELINE_DRAG_SCROLL.y = e.clientY;
  });
}

// Follow-up filter predicate. 'due' mirrors the Dashboard's "Follow-ups
// Due" KPI exactly (overdue-or-today) — it exists as its own option so
// clicking that KPI card opens Pipeline pre-filtered to precisely what it
// counted (spec §9), not an approximation.
function leadMatchesFollowupFilter(lead, filter){
  if(!filter) return true;
  if(filter==='none') return !lead.nextFollowup;
  if(!lead.nextFollowup) return false;
  if(filter==='due') return daysUntil(lead.nextFollowup) <= 0;
  return urgencyOf(lead.nextFollowup) === filter;
}

function renderPipelinePage(){
  const el = document.getElementById('pageContent');

  // Preserve the user's current Pipeline viewport across this re-render —
  // most importantly after a drag-and-drop status change, which used to
  // rebuild the whole board and snap back to scrollLeft/scrollTop 0. This
  // is captured from whatever is on screen RIGHT NOW (not some earlier
  // "before the drag started" snapshot), so it naturally preserves
  // wherever the drag auto-scroll left the viewport, and applies equally
  // to a filter/counter-chip re-render (no reason those should jump the
  // view back to the start either). Only fires when the Pipeline board is
  // already on screen — a fresh navigation into Pipeline has nothing to
  // preserve and just renders normally.
  const prevBoard = document.getElementById('pipelineBoard');
  const prevScrollLeft = prevBoard ? prevBoard.scrollLeft : 0;
  const prevScrollTop = prevBoard ? window.scrollY : 0;

  // Board columns respect Sales / Industry / Follow-up filters together —
  // Confirmed leads normally have no outstanding follow-up (spec §12), so a
  // Follow-up filter naturally shows few/no Confirmed cards, which is
  // correct rather than something to special-case.
  const boardLeads = activeLeads().filter(l=>{
    if(!PIPELINE_STATUSES.includes(l.status)) return false;
    if(PIPELINE_FILTER_STATE.sales && l.assignedSales!==PIPELINE_FILTER_STATE.sales) return false;
    if(PIPELINE_FILTER_STATE.industry && l.industry!==PIPELINE_FILTER_STATE.industry) return false;
    if(!leadMatchesFollowupFilter(l, PIPELINE_FILTER_STATE.followup)) return false;
    return true;
  });

  // Follow-up counters (spec §8) — deliberately scoped to TRUE open
  // opportunities (OPEN_PIPELINE_STATUSES, i.e. excluding Confirmed) so a
  // Confirmed lead's now-irrelevant sales follow-up never inflates them
  // (spec §12). Sales/Industry filters still narrow the counters, so the
  // numbers always match what's actually visible on the board below.
  const counterLeads = activeLeads().filter(l=>{
    if(!OPEN_PIPELINE_STATUSES.includes(l.status)) return false;
    if(PIPELINE_FILTER_STATE.sales && l.assignedSales!==PIPELINE_FILTER_STATE.sales) return false;
    if(PIPELINE_FILTER_STATE.industry && l.industry!==PIPELINE_FILTER_STATE.industry) return false;
    return true;
  });
  const overdueCount = counterLeads.filter(l=>urgencyOf(l.nextFollowup)==='overdue').length;
  const todayCount = counterLeads.filter(l=>urgencyOf(l.nextFollowup)==='today').length;
  const weekCount = counterLeads.filter(l=>['tomorrow','week'].includes(urgencyOf(l.nextFollowup))).length;

  const salesList = [...new Set(activeLeads().map(l=>l.assignedSales).filter(Boolean))].sort();
  const industryList = [...new Set(activeLeads().filter(l=>PIPELINE_STATUSES.includes(l.status)).map(l=>l.industry).filter(Boolean))].sort();

  el.innerHTML = `
    <div class="filters-bar">
      ${isFounder() ? `<button class="btn btn-outline" id="pArchiveBtn" style="margin-right:4px">${icon('archive','width="15" height="15"')} Archive</button>` : ''}
      <select id="pFltSales" class="sel">
        <option value="">All Sales</option>
        ${salesList.map(s=>`<option value="${escapeHtml(s)}" ${PIPELINE_FILTER_STATE.sales===s?'selected':''}>${escapeHtml(s)}</option>`).join('')}
      </select>
      <select id="pFltFollowup" class="sel">
        <option value="">All Follow-ups</option>
        <option value="overdue" ${PIPELINE_FILTER_STATE.followup==='overdue'?'selected':''}>Overdue</option>
        <option value="today" ${PIPELINE_FILTER_STATE.followup==='today'?'selected':''}>Today</option>
        <option value="tomorrow" ${PIPELINE_FILTER_STATE.followup==='tomorrow'?'selected':''}>Tomorrow</option>
        <option value="week" ${PIPELINE_FILTER_STATE.followup==='week'?'selected':''}>This Week</option>
        <option value="none" ${PIPELINE_FILTER_STATE.followup==='none'?'selected':''}>No Follow-up</option>
      </select>
      <select id="pFltIndustry" class="sel">
        <option value="">All Industries</option>
        ${industryList.map(s=>`<option value="${escapeHtml(s)}" ${PIPELINE_FILTER_STATE.industry===s?'selected':''}>${escapeHtml(industryLabel(s))}</option>`).join('')}
      </select>
      <div class="spacer"></div>
      ${isFounder() ? `<button class="btn btn-primary" id="pAddToPipelineBtn">+ Add to Pipeline</button>` : ''}
    </div>

    <div class="flex-row followup-counters" style="gap:8px;flex-wrap:wrap;margin-bottom:14px">
      <button type="button" class="fu-counter-chip chip-overdue ${PIPELINE_FILTER_STATE.followup==='overdue'?'active':''}" data-count-filter="overdue">Overdue <b>${overdueCount}</b></button>
      <button type="button" class="fu-counter-chip chip-today ${PIPELINE_FILTER_STATE.followup==='today'?'active':''}" data-count-filter="today">Today <b>${todayCount}</b></button>
      <button type="button" class="fu-counter-chip chip-week ${PIPELINE_FILTER_STATE.followup==='week'?'active':''}" data-count-filter="week">This Week <b>${weekCount}</b></button>
      ${PIPELINE_FILTER_STATE.followup ? `<button type="button" class="fu-counter-chip chip-clear" data-count-filter="">Clear filter &times;</button>` : ''}
      <div class="text-muted" style="font-size:11.5px;margin-left:4px">Drag a card to another column to move it through the pipeline. Every move requires confirmation and is logged.</div>
    </div>

    <div class="pipeline-board" id="pipelineBoard">
      ${PIPELINE_STATUSES.map(st=>{
        let cards = boardLeads.filter(l=>l.status===st);
        // On Hold / Future Follow-up sorts nearest follow-up date first
        // (spec §6) — a lead with no date at all (shouldn't normally
        // happen, the status-change modal requires one) sorts to the end
        // rather than crashing on an invalid Date comparison. Every other
        // column keeps its normal (unsorted / natural DB) order — this is
        // the one column where "what needs attention soonest" is the whole
        // point of the view.
        if(st===ON_HOLD_STATUS){
          cards = [...cards].sort((a,b)=>{
            if(!a.nextFollowup && !b.nextFollowup) return 0;
            if(!a.nextFollowup) return 1;
            if(!b.nextFollowup) return -1;
            return new Date(a.nextFollowup) - new Date(b.nextFollowup);
          });
        }
        const total = cards.reduce((s,l)=>s+(l.estimatedValue||0),0);
        return `
        <div class="pipeline-col" data-status="${st}">
          <div class="pipeline-col-head">
            <div>
              <div class="col-title">${st}</div>
              <div class="text-muted" style="font-size:10.5px;margin-top:2px">${money(total)}</div>
            </div>
            <div class="col-count">${cards.length}</div>
          </div>
          <div class="pipeline-cards" data-status="${st}">
            ${cards.map(l=>pipelineCardHtml(l)).join('')}
          </div>
        </div>`;
      }).join('')}
    </div>
  `;

  // Pipeline deliberately has no "+ Add Lead" button (spec §6/§9) — new
  // leads are created in Lead Records only; Pipeline's own primary action
  // is "+ Add to Pipeline", which selects an EXISTING lead.
  const addToPipelineBtn = document.getElementById('pAddToPipelineBtn');
  if(addToPipelineBtn) addToPipelineBtn.onclick = ()=> openAddToPipelineModal();
  const archiveBtn = document.getElementById('pArchiveBtn');
  if(archiveBtn) archiveBtn.onclick = ()=> openArchivedPipelineModal();
  document.getElementById('pFltSales').onchange = (e)=>{ PIPELINE_FILTER_STATE.sales=e.target.value; renderPipelinePage(); };
  document.getElementById('pFltFollowup').onchange = (e)=>{ PIPELINE_FILTER_STATE.followup=e.target.value; renderPipelinePage(); };
  document.getElementById('pFltIndustry').onchange = (e)=>{ PIPELINE_FILTER_STATE.industry=e.target.value; renderPipelinePage(); };
  el.querySelectorAll('[data-count-filter]').forEach(btn=>{
    btn.onclick = ()=>{
      const val = btn.dataset.countFilter;
      PIPELINE_FILTER_STATE.followup = (PIPELINE_FILTER_STATE.followup===val) ? '' : val;
      renderPipelinePage();
    };
  });

  el.querySelectorAll('.pcard').forEach(card=>{
    card.addEventListener('dragstart', (e)=>{
      card.classList.add('dragging');
      e.dataTransfer.setData('text/plain', card.dataset.leadId);
      startPipelineDragScroll(e.clientX, e.clientY);
    });
    // dragend always fires after a drop (successful or not) and after a
    // cancelled drag (Escape, dropped outside a valid target) alike, so
    // this is the single place that reliably stops auto-scroll — no
    // stuck/frozen scroll state is left behind either way (spec §7 TEST E).
    card.addEventListener('dragend', ()=>{
      card.classList.remove('dragging');
      stopPipelineDragScroll();
    });
    card.addEventListener('click', ()=> openLeadDetailModal(card.dataset.leadId));
  });

  // Project Code edit icon (Founder/Admin only, see isFounder() gate in
  // pipelineCardHtml) — must stop propagation so clicking it opens the
  // small Edit Project Code modal instead of the card's own click handler
  // opening the full Lead Detail modal underneath it.
  el.querySelectorAll('[data-edit-code]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const lead = DB.find('leads', btn.dataset.editCode);
      if(lead) openEditProjectCodeModal(lead, ()=> renderPipelinePage());
    });
    // A draggable ancestor card intercepts mousedown for drag-start
    // detection — without this, a click on the little edit icon can be
    // swallowed as an aborted drag instead of registering as a click.
    btn.addEventListener('mousedown', (e)=> e.stopPropagation());
  });

  el.querySelectorAll('.pipeline-col').forEach(col=>{
    col.addEventListener('dragover', (e)=>{ e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', ()=> col.classList.remove('drag-over'));
    col.addEventListener('drop', (e)=>{
      e.preventDefault();
      col.classList.remove('drag-over');
      const leadId = e.dataTransfer.getData('text/plain');
      const targetStatus = col.dataset.status;
      const lead = DB.find('leads', leadId);
      if(!lead || lead.status===targetStatus) return;
      applyLeadStatusChange(lead, targetStatus);
    });
  });

  // Restore the viewport captured above. Setting it right away covers the
  // normal case (layout from the innerHTML assignment above is already
  // committed by the time synchronous script resumes); the rAF pass is a
  // second application as a safeguard against any layout that only
  // settles on the next frame, so the restore always sticks rather than
  // being silently overridden by the browser's own scroll handling.
  if(prevBoard){
    const newBoard = document.getElementById('pipelineBoard');
    if(newBoard) newBoard.scrollLeft = prevScrollLeft;
    window.scrollTo(0, prevScrollTop);
    requestAnimationFrame(()=>{
      const boardAgain = document.getElementById('pipelineBoard');
      if(boardAgain) boardAgain.scrollLeft = prevScrollLeft;
      window.scrollTo(0, prevScrollTop);
    });
  }
}

function pipelineCardHtml(l){
  // On Hold / Future Follow-up gets a small purple accent stripe (spec §2:
  // a distinct non-red amber/purple accent) plus its note/reason shown
  // right on the card, since that's the one column where "why is this
  // paused and when do we revisit it" is the point of glancing at the
  // board (spec §6).
  const isOnHold = l.status === ON_HOLD_STATUS;
  // Project Code becomes required from Quote and Demo Sent onward — the
  // card shows it from that same point forward on the board, so it never
  // disappears again once a lead moves past Quote and Demo Sent into
  // Follow-up / On Hold / Negotiation / Confirmed. Deliberately NOT using
  // leadStatusRequiresProjectCode() here: that function returns false for
  // Confirmed (it has its own dedicated Confirm-Project flow, so it's
  // excluded from the generic status-change gate), but a Confirmed card on
  // the board should still visibly show the code it already has. Missing
  // codes are shown, never hidden, so a Founder/Admin scanning the board
  // can spot an old historical lead that still needs one.
  const codeGateIdx = PIPELINE_STATUSES.indexOf(QUOTE_AND_DEMO_SENT_STATUS);
  const showCode = PIPELINE_STATUSES.indexOf(l.status) >= codeGateIdx;
  return `
    <div class="pcard ${isOnHold?'pcard-onhold':''}" draggable="true" data-lead-id="${l.id}">
      <div class="pcard-biz">${escapeHtml(l.businessName)}</div>
      <div class="pcard-client">${escapeHtml(l.clientName)}</div>
      ${showCode ? `
      <div class="pcard-code-row">
        <span class="pcard-code ${l.projectCode?'':'pcard-code-unset'}">Code: ${l.projectCode ? escapeHtml(l.projectCode) : 'Not Set'}</span>
        ${isFounder() ? `<button type="button" class="pcard-code-edit" data-edit-code="${l.id}" title="Edit Project Code">${icon('edit','width="12" height="12"')}</button>` : ''}
      </div>` : ''}
      <span class="pcard-svc">${escapeHtml(l.interestedService)}</span>
      <div class="pcard-row">
        <span class="pcard-value">${money(l.estimatedValue)}</span>
        <div class="avatar-sm" style="background:${userColor(l.assignedSales)}" title="${escapeHtml(l.assignedSales)}">${userInitials(l.assignedSales)}</div>
      </div>
      <div class="pcard-row" style="margin-top:6px">
        <span class="text-muted">Next:</span>
        ${l.nextFollowup ? urgencyChip(l.nextFollowup) : '<span class="text-muted">—</span>'}
      </div>
      ${isOnHold && l.holdReason ? `<div class="pcard-note">${escapeHtml(l.holdReason)}</div>` : ''}
    </div>
  `;
}

/* ---------------------------------------------------------------------- */
/* Add to Pipeline — Founder/Admin only (sales-restructure task). Pipeline */
/* now starts at Quote and Demo Sent; New Lead / Contacted / Qualified are */
/* managed only in Lead Records. This is the one bridge between the two:  */
/* it selects an EXISTING lead (never creates a new one), requires a      */
/* unique Project Code, and advances that SAME lead straight to Quote and */
/* Demo Sent via advanceLeadToPipeline() (leads.js). Reachable from the   */
/* Pipeline page's own button, from a Qualified lead's row action in Lead */
/* Records, and from that lead's own Detail modal (spec §12) — all three  */
/* open this exact same modal.                                            */
/* ---------------------------------------------------------------------- */
function openAddToPipelineModal(opts={}){
  if(!isFounder()){ toast('Only Founder/Admin can add a lead to Pipeline.', 'error'); return; }
  const { preselectedLeadId=null, onDone=null } = opts;

  // Eligibility (spec §4 default/recommended): Qualified leads only. A
  // lead that has already been added to Pipeline is no longer Qualified
  // (its status is already Quote and Demo Sent or later), so it is
  // structurally excluded here — satisfying the duplicate-protection rule
  // (spec §9) without any extra bookkeeping.
  //
  // IMPORTANT (root-cause fix — see renderResults() below): eligibleLeads()
  // is used ONLY for the default list shown when the search box is empty,
  // and for the final Confirm-time re-check. The SEARCH itself must query
  // every live, non-archived lead (searchableLeads()) — not just the
  // pre-filtered eligible ones — otherwise a real, existing Lead ID like
  // L045 that happens to already be past Qualified (e.g. already in
  // Pipeline, or still Contacted) is invisible to the search entirely and
  // falls through to the generic "No qualified leads available" message,
  // which is exactly the reported bug. Searching the full live dataset and
  // then labelling each match by its actual status gives the user a
  // truthful answer instead.
  function eligibleLeads(){
    return searchableLeads().filter(l=> l.status==='Qualified');
  }
  function searchableLeads(){
    return DB.all('leads').filter(l=> !l.archived);
  }

  let selectedLead = preselectedLeadId ? DB.find('leads', preselectedLeadId) : null;
  if(selectedLead && selectedLead.status !== 'Qualified'){
    toast('This lead is already in the Pipeline.', 'error');
    selectedLead = null;
  }

  const html = `
    <div class="modal-head"><h3>Add to Pipeline</h3><button class="modal-close" id="atpClose">&times;</button></div>
    <div class="modal-body">
      <div class="form-field full" style="margin-bottom:14px">
        <label class="required">Select Lead</label>
        <div class="search-box" style="max-width:100%">
          ${icon('search')}
          <input type="text" id="atpSearch" placeholder="Search by Lead ID, client, business, phone, or service…">
        </div>
        <div id="atpResults" style="margin-top:8px;max-height:180px;overflow-y:auto;border:1px solid var(--line);border-radius:9px"></div>
        <div id="atpSelected" style="margin-top:8px"></div>
      </div>
      <div id="atpCodeWrap" style="display:none">
        <div class="form-field">
          <label class="required">Project Code</label>
          <input id="atpCode" placeholder="e.g. C046" style="text-transform:uppercase">
          <span class="form-hint">Must be unique across all leads and projects (not case-sensitive).</span>
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="atpCancel">Cancel</button>
      <button class="btn btn-primary" id="atpConfirm" disabled>Confirm</button>
    </div>
  `;

  openModal(html, { large:true, onMount:(overlay)=>{
    overlay.querySelector('#atpClose').onclick = closeModal;
    overlay.querySelector('#atpCancel').onclick = closeModal;

    const resultsEl = overlay.querySelector('#atpResults');
    const selectedEl = overlay.querySelector('#atpSelected');
    const codeWrap = overlay.querySelector('#atpCodeWrap');
    const codeInput = overlay.querySelector('#atpCode');
    const confirmBtn = overlay.querySelector('#atpConfirm');

    function renderSelected(){
      if(!selectedLead){
        selectedEl.innerHTML = '';
        codeWrap.style.display = 'none';
        confirmBtn.disabled = true;
        return;
      }
      selectedEl.innerHTML = `
        <div style="background:var(--surface-2);border:1px solid var(--line);border-radius:9px;padding:10px 12px;font-size:13px">
          <div class="flex-row" style="justify-content:space-between">
            <span class="cell-strong">${escapeHtml(selectedLead.id)} — ${escapeHtml(selectedLead.clientName)} (${escapeHtml(selectedLead.businessName)})</span>
            <span class="cell-link" id="atpUnselect" style="font-size:12px">Change</span>
          </div>
          <div class="text-muted" style="margin-top:6px;font-size:12px">
            Interested Service: ${escapeHtml(selectedLead.interestedService)} · Est. Value: ${money(selectedLead.estimatedValue)}<br>
            Assigned Sales: ${escapeHtml(selectedLead.assignedSales||'—')} · Current Status: ${statusBadge(selectedLead.status)}
          </div>
        </div>`;
      overlay.querySelector('#atpUnselect').onclick = ()=>{ selectedLead=null; codeInput.value=''; renderSelected(); if(typeof renderResults==='function') renderResults(); };
      codeWrap.style.display = 'block';
      if(!codeInput.value) codeInput.value = suggestNextProjectCode();
      confirmBtn.disabled = false;
    }
    renderSelected();

    // Search — queries the SAME lead records shown in Lead Records (no
    // separate list/database). Case-insensitive, partial-match on Lead ID,
    // Client Name, Business Name, Interested Service and (if already
    // assigned) Project Code; phone matching strips all non-digit
    // characters from both the query and the stored number first, so a
    // query like "012 587" still matches a phone stored without spaces
    // (spec Part A §1 — "tolerant of spaces"). Root cause of the original
    // bug wasn't the matching logic itself (it always matched correctly
    // against whatever WAS eligible) — it was that the modal showed a
    // completely blank results panel with no explanation whenever the
    // search box was empty AND whenever zero Qualified leads existed to
    // find, which reads exactly like "search is broken" with no way to
    // tell the difference from actually-broken. Fixed below by always
    // rendering *something* — a default eligible list, or one of two
    // explicit empty-state messages (spec Part A §4).
    function normalizeQuery(s){ return (s||'').toLowerCase().trim(); }
    function digitsOnly(s){ return (s||'').replace(/\D/g,''); }
    function matchesQuery(l, nq){
      if(!nq) return true;
      if(l.id.toLowerCase().includes(nq)) return true;
      if(l.clientName.toLowerCase().includes(nq)) return true;
      if(l.businessName.toLowerCase().includes(nq)) return true;
      if((l.interestedService||'').toLowerCase().includes(nq)) return true;
      if(l.projectCode && l.projectCode.toLowerCase().includes(nq)) return true;
      const qDigits = digitsOnly(nq);
      if(qDigits && digitsOnly(l.phone).includes(qDigits)) return true;
      return false;
    }
    function resultRowHtml(l){
      return `
        <div class="mini-row" style="cursor:pointer" data-pick="${l.id}">
          <div class="mini-main">
            <div class="mini-title">${l.id} — ${escapeHtml(l.businessName)}</div>
            <div class="mini-sub">Client: ${escapeHtml(l.clientName)} · ${escapeHtml(l.interestedService)} · ${money(l.estimatedValue)}</div>
          </div>
          ${statusBadge(l.status)}
        </div>`;
    }
    // A search match that ISN'T eligible is still shown — never silently
    // dropped — labelled with exactly why it can't be selected right now
    // (spec §4): already in Pipeline, or a real status but not yet
    // Qualified. Not clickable (no data-pick), and visually muted so it
    // reads clearly as "found, but not selectable" rather than a normal
    // result.
    function ineligibleRowHtml(l, message){
      return `
        <div class="mini-row" style="cursor:default;opacity:.7">
          <div class="mini-main">
            <div class="mini-title">${l.id} — ${escapeHtml(l.businessName)}</div>
            <div class="mini-sub">Client: ${escapeHtml(l.clientName)}</div>
            <div class="mini-sub" style="color:var(--red);margin-top:2px">${escapeHtml(message)}</div>
          </div>
          ${statusBadge(l.status)}
        </div>`;
    }
    function ineligibleMessageFor(l){
      if(PIPELINE_STATUSES.includes(l.status)){
        return `This lead is already in the Pipeline (Stage: ${l.status}).`;
      }
      return `Lead found, but current status is ${l.status}. Only Qualified leads can be added to Pipeline.`;
    }
    function wireResultRows(){
      resultsEl.querySelectorAll('[data-pick]').forEach(row=>{
        row.onclick = ()=>{
          selectedLead = DB.find('leads', row.dataset.pick);
          resultsEl.innerHTML = ''; resultsEl.style.display = 'none';
          overlay.querySelector('#atpSearch').value = '';
          codeInput.value = '';
          renderSelected();
        };
      });
    }
    function renderResults(){
      resultsEl.style.display = 'block';
      const nq = normalizeQuery(overlay.querySelector('#atpSearch').value);

      if(!nq){
        // Empty search box → show a reasonable default list of eligible
        // (Qualified) leads rather than nothing (spec Part A §4). Only
        // when there truly are none at all do we show the "none available"
        // empty state — a query that later fails to match anything gets
        // its own distinct "no match" message instead (see below).
        const eligible = eligibleLeads();
        if(eligible.length === 0){
          resultsEl.innerHTML = `<div class="text-muted" style="padding:10px;font-size:12.5px">No qualified leads available to add to Pipeline.</div>`;
          return;
        }
        resultsEl.innerHTML = eligible.slice(0,20).map(resultRowHtml).join('');
        wireResultRows();
        return;
      }

      // Root-cause fix: search the FULL live lead dataset (not just the
      // pre-filtered eligible list) so a real lead like L045 is always
      // found and truthfully labelled, even when it isn't eligible.
      const matches = searchableLeads().filter(l=>matchesQuery(l, nq)).slice(0,20);
      if(matches.length === 0){
        resultsEl.innerHTML = `<div class="text-muted" style="padding:10px;font-size:12.5px">No matching Lead Record found.</div>`;
        return;
      }
      resultsEl.innerHTML = matches.map(l=> l.status==='Qualified' ? resultRowHtml(l) : ineligibleRowHtml(l, ineligibleMessageFor(l))).join('');
      wireResultRows();
    }
    overlay.querySelector('#atpSearch').oninput = renderResults;
    // Show the default eligible list (or the right empty state) the moment
    // the modal opens, instead of waiting for the first keystroke.
    if(!selectedLead) renderResults();

    confirmBtn.onclick = ()=>{
      if(!selectedLead){ toast('Please select a lead.', 'error'); return; }
      // Defense in depth against a race — the lead may have been advanced
      // by someone else between opening this modal and clicking Confirm.
      const fresh = DB.find('leads', selectedLead.id);
      if(!fresh || fresh.status !== 'Qualified'){
        toast('This lead is already in the Pipeline.', 'error');
        selectedLead = null; renderSelected();
        return;
      }
      const normalized = normalizeProjectCode(codeInput.value);
      if(!normalized){
        codeInput.style.borderColor='var(--red)';
        toast('Project Code is required.', 'error');
        return;
      }
      if(isProjectCodeTaken(normalized, { excludeLeadId: fresh.id })){
        codeInput.style.borderColor='var(--red)';
        toast(`Project Code ${normalized} is already in use.`, 'error');
        return;
      }
      codeInput.style.borderColor='';
      advanceLeadToPipeline(fresh, normalized);
      toast(`${fresh.id} added to Pipeline as ${normalized}.`, 'success');
      closeModal();
      if(currentRoute()==='pipeline') renderPipelinePage();
      if(currentRoute()==='leads') renderLeadsTable();
      if(onDone) onDone();
    };
  }});
}

/* ---------------------------------------------------------------------- */
/* Pipeline Archive view — Founder/Admin only. Shows archived SALES        */
/* OPPORTUNITIES (leads that were actually in the Pipeline lifecycle) as   */
/* a compact table, separate from Lead Records' own Active/Archived/All    */
/* filter (which still lists every archived lead, early-stage included).   */
/* Eligibility is deliberately "current status is a Pipeline stage OR a    */
/* Project Code was ever assigned" rather than PIPELINE_STATUSES alone —   */
/* the latter would silently miss a lead archived long ago whose status    */
/* predates the sales-restructure task (e.g. still 'Qualified' from        */
/* before Project Codes existed at that stage) but that already has a      */
/* Project Code, i.e. genuinely was a pipeline opportunity. Restoring one   */
/* of those falls back to Quote and Demo Sent (restoreLeadToPipeline, see  */
/* leads.js) since its stale stage no longer exists on the board.          */
/* Archiving a lead here NEVER touches its linked Project (if any) — a     */
/* Confirmed opportunity's Project stays fully visible/untouched under      */
/* Projects regardless of whether the Pipeline card itself is archived.    */
/* ---------------------------------------------------------------------- */
function archivedPipelineOpportunities(){
  return DB.all('leads').filter(l=> l.archived && (PIPELINE_STATUSES.includes(l.status) || !!l.projectCode));
}

function openArchivedPipelineModal(){
  if(!isFounder()){ toast('Only Founder/Admin can view the Pipeline Archive.', 'error'); return; }
  const items = archivedPipelineOpportunities().sort((a,b)=> new Date(b.archivedAt||0) - new Date(a.archivedAt||0));

  const html = `
    <div class="modal-head"><h3>Pipeline Archive</h3><button class="modal-close" id="apClose">&times;</button></div>
    <div class="modal-body">
      ${items.length===0 ? `<div class="text-muted" style="padding:24px 4px;text-align:center">No archived opportunities.</div>` : `
      <div class="table-wrap scroll-x">
        <table class="data-table">
          <thead>
            <tr>
              <th>Lead ID</th><th>Project Code</th><th>Client</th><th>Business</th>
              <th>Service</th><th>Est. Value</th><th>Last Pipeline Stage</th>
              <th>Archived Date</th><th>Archived By</th><th>Archive Reason</th><th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(l=>`
              <tr>
                <td class="cell-link" data-view="${l.id}">${l.id}</td>
                <td>${l.projectCode ? escapeHtml(l.projectCode) : '—'}</td>
                <td class="cell-strong">${escapeHtml(l.clientName)}</td>
                <td>${escapeHtml(l.businessName)}</td>
                <td>${escapeHtml(l.interestedService||'—')}</td>
                <td class="cell-strong">${money(l.estimatedValue)}</td>
                <td>${statusBadge(l.status)}</td>
                <td class="cell-nowrap">${l.archivedAt ? fmtDate(l.archivedAt) : '—'}</td>
                <td>${escapeHtml(l.archivedBy||'—')}</td>
                <td class="text-muted" style="max-width:200px">${l.archiveReason ? escapeHtml(l.archiveReason) : '—'}</td>
                <td>
                  <div class="flex-row" style="gap:6px;flex-wrap:wrap">
                    <button class="btn btn-secondary btn-sm" data-view="${l.id}">View</button>
                    <button class="btn btn-primary btn-sm" data-restore="${l.id}">Restore</button>
                  </div>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`}
    </div>
    <div class="modal-foot"><button class="btn btn-secondary" id="apClose2">Close</button></div>
  `;

  openModal(html, { large:true, onMount:(overlay)=>{
    overlay.querySelector('#apClose').onclick = closeModal;
    overlay.querySelector('#apClose2').onclick = closeModal;
    overlay.querySelectorAll('[data-view]').forEach(el=>{
      el.onclick = ()=>{ closeModal(); openLeadDetailModal(el.dataset.view); };
    });
    overlay.querySelectorAll('[data-restore]').forEach(btn=>{
      btn.onclick = ()=>{
        const lead = DB.find('leads', btn.dataset.restore);
        if(!lead) return;
        openRestoreToPipelineModal(lead, ()=> openArchivedPipelineModal());
      };
    });
  }});
}

function openRestoreToPipelineModal(lead, onDone){
  if(!isFounder()){ toast('Only Founder/Admin can restore an opportunity.', 'error'); return; }
  const fallback = !PIPELINE_STATUSES.includes(lead.status);
  const targetStage = fallback ? QUOTE_AND_DEMO_SENT_STATUS : lead.status;
  const html = `
    <div class="modal-head"><h3>Restore to Pipeline</h3><button class="modal-close" id="rpClose">&times;</button></div>
    <div class="modal-body">
      <p style="margin-top:0">Restore this opportunity to Pipeline?</p>
      <p class="text-muted" style="font-size:12.5px">
        <b>${escapeHtml(lead.clientName)} — ${escapeHtml(lead.businessName)}</b> (${lead.id}${lead.projectCode?' · Project '+escapeHtml(lead.projectCode):''}) will be restored to its last valid Pipeline stage: ${statusBadge(targetStage)}
        ${fallback ? `<br><span style="margin-top:4px;display:inline-block">Its previous stage (${escapeHtml(lead.status)}) no longer exists on the board, so it will fall back to ${QUOTE_AND_DEMO_SENT_STATUS}.</span>` : ''}
      </p>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" id="rpCancel">Cancel</button>
      <button class="btn btn-primary" id="rpConfirm">Restore</button>
    </div>
  `;
  openModal(html, { onMount:(overlay)=>{
    overlay.querySelector('#rpClose').onclick = closeModal;
    overlay.querySelector('#rpCancel').onclick = closeModal;
    overlay.querySelector('#rpConfirm').onclick = ()=>{
      closeModal();
      restoreLeadToPipeline(lead, onDone);
    };
  }});
}
