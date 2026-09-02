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
      <button class="btn btn-primary" id="pAddLeadBtn">+ Add Lead</button>
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

  document.getElementById('pAddLeadBtn').onclick = ()=> openLeadFormModal(null);
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
  return `
    <div class="pcard ${isOnHold?'pcard-onhold':''}" draggable="true" data-lead-id="${l.id}">
      <div class="pcard-biz">${escapeHtml(l.businessName)}</div>
      <div class="pcard-client">${escapeHtml(l.clientName)}</div>
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
