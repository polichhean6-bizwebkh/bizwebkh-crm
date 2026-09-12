/* ==========================================================================
   BizWeb KH CRM — dashboard.js
   KPI cards + recent-activity widgets for the Dashboard page.
   ========================================================================== */

// Renders one KPI card — pulled out so the three grouped rows below (spec
// §1) all share exactly the same markup instead of copy-pasting it per row.
function kpiCardHtml(k){
  // Two independent, optional click-through wirings a card can carry:
  //  - k.go        -> plain hash navigation to a module page (data-go, same
  //                   attribute/handler already used by "See all" links)
  //  - k.goPipeline -> pre-set Pipeline's Follow-up filter, then jump there
  //                   (data-go-pipeline, pre-existing mechanism)
  // A card gets at most one of the two. Neither Pipeline nor Projects has an
  // existing stage-level filter mechanism reusable from the Dashboard (see
  // spec §5's "don't over-engineer routing" note), so stage-specific
  // Financial Performance cards intentionally just navigate to the general
  // module page rather than a filtered view.
  const clickAttrs = k.goPipeline ? `data-go-pipeline="${k.goPipeline}" style="cursor:pointer" title="Open in Pipeline"`
                    : k.go ? `data-go="${k.go}" style="cursor:pointer" title="Open ${escapeHtml(k.goLabel||k.go)}"`
                    : '';
  // Optional extras (Sales Pipeline Value cards — dashboard metric-clarity
  // task): `k.count` is a small "N opportunities" line shown between the
  // dollar value and the label; `k.sub` is the small subtitle line under the
  // label; `k.strong` makes the headline "Total Open Pipeline" card read as
  // visually stronger than its peers (larger value + accent left border +
  // faint tint) without turning it into a separately-stacked amount.
  const cardClass = 'kpi-card' + (k.strong ? ' kpi-card-strong' : '');
  // Same hex+alpha-suffix convention already used for the icon background
  // above (`${k.color}1a`), just an even fainter tint (05 ≈ 2% opacity) so
  // the "stronger" card reads as emphasized, not as a separate colored box.
  const strongStyle = k.strong ? `style="--kpi-accent:${k.color};background:${k.color}0d"` : '';
  return `
    <div class="${cardClass}" ${strongStyle} ${clickAttrs}>
      <div class="kpi-top">
        <div class="kpi-icon" style="background:${k.color}1a;color:${k.color}">${icon(k.icon)}</div>
      </div>
      <div class="kpi-value">${k.value}</div>
      ${k.count!=null ? `<div class="kpi-count">${escapeHtml(k.count)}</div>` : ''}
      <div class="kpi-label">${k.label}</div>
      ${k.sub ? `<div class="kpi-sub">${escapeHtml(k.sub)}</div>` : ''}
    </div>`;
}
// Renders one labeled KPI row/group (e.g. "Sales Pipeline", "Project
// Delivery" — spec §1). `gridClass` lets a 2-card row (Project Delivery)
// use a matching 2-column grid instead of stretching across 4 columns.
// `helpText`, when given, adds the same shared "?" help-button/tooltip
// mechanism already used on the Lead Records summary cards (see
// wireKpiHelpTooltips in leads.js) next to the group title, instead of
// inventing a new tooltip pattern.
function kpiGroupHtml(title, items, gridClass='kpi-grid', helpText=''){
  const help = helpText
    ? ` <button type="button" class="kpi-help-btn" data-help-text="${escapeHtml(helpText)}" aria-label="What does ${escapeHtml(title)} mean?">?</button>`
    : '';
  return `
    <div class="kpi-group">
      <div class="kpi-group-title">${escapeHtml(title)}${help}</div>
      <div class="${gridClass}">${items.map(kpiCardHtml).join('')}</div>
    </div>`;
}

function renderDashboard(){
  const el = document.getElementById('pageContent');
  const leads = DB.all('leads');
  const projects = DB.all('projects');
  const activities = DB.all('activities');
  const payments = DB.all('payments').filter(p=>!p.voided); // voided payments never count toward Collected Revenue

  // ----- KPI logic (see README "Dashboard KPI logic" — deliberately avoids
  // double-counting a lead in both Pipeline Value and Closed Sales) -----
  const totalLeads = leads.length;
  const openLeadsAll = leads.filter(l=>l.status!=='Lost' && l.status!=='Confirmed');
  // Follow-ups Due: next_follow_up_date <= today, excluding Confirmed, Lost
  // and Archived leads (a Confirmed lead's delivery is tracked on its
  // Project, not sales follow-up; an archived lead is retired from active
  // work entirely) — matches the Pipeline "Due" follow-up filter exactly,
  // which is what clicking this KPI card opens (see the `go` wiring below).
  const followupDue = activeLeads().filter(l=> l.nextFollowup && daysUntil(l.nextFollowup)<=0 && !['Lost','Confirmed'].includes(l.status)).length;
  const confirmedProjects = projects.length; // every row in Projects, regardless of stage
  const activeProjects = projects.filter(p=>ACTIVE_PROJECT_STAGES.includes(p.stage)).length;

  // Open Pipeline Value: ONLY true open opportunities (excludes Confirmed
  // and Lost) — a lead that reached Confirmed is a Project now and is
  // counted in Closed Sales instead, never here too. Also excludes archived
  // leads (activeLeads()) — an archived lead is hidden from the Pipeline
  // board itself (see pipeline.js), so it must never still count toward
  // Open Pipeline Value here, or the two would disagree.
  const openLeads = activeLeads().filter(l=>OPEN_PIPELINE_STATUSES.includes(l.status));
  const pipelineValue = openLeads.reduce((s,l)=>s+(l.estimatedValue||0),0);

  // Financial Performance stage breakdown (spec §1/§2, rebuild): each of the
  // 3 named-stage cards is a thin sum over the exact same `openLeads` set
  // used for Total Pipeline Value above — just narrowed to one exact stage
  // string (see data.js for the single source of truth on each stage's
  // exact wording: QUOTE_AND_DEMO_SENT_STATUS, POTENTIAL_FOLLOWUP_STATUS —
  // 'Negotiation' has no dedicated constant elsewhere in the codebase either,
  // so it's matched literally here exactly like every other stage check in
  // the app does). No new per-lead math — only new grouping of the existing
  // per-lead estimatedValue already summed for pipelineValue.
  const quoteDemoSentLeads = openLeads.filter(l=>l.status===QUOTE_AND_DEMO_SENT_STATUS);
  const potentialFollowupLeads = openLeads.filter(l=>l.status===POTENTIAL_FOLLOWUP_STATUS);
  const negotiationLeads = openLeads.filter(l=>l.status==='Negotiation');
  const quoteDemoSentValue = quoteDemoSentLeads.reduce((s,l)=>s+(l.estimatedValue||0),0);
  const potentialFollowupValue = potentialFollowupLeads.reduce((s,l)=>s+(l.estimatedValue||0),0);
  const negotiationValue = negotiationLeads.reduce((s,l)=>s+(l.estimatedValue||0),0);

  // "Other Open Pipeline" (dashboard metric-clarity task) — a catch-all for
  // every OPEN_PIPELINE_STATUSES stage that doesn't get its own named card
  // above (today that's just ON_HOLD_STATUS, but this stays correct if a
  // new open stage is ever added to OPEN_PIPELINE_STATUSES without also
  // getting a dedicated card here). Computed as a DIRECT sum over the
  // remaining open-stage records — i.e. filtering the same `openLeads` set
  // OUT of the three named stages — rather than as `pipelineValue minus the
  // three named totals`, per spec: the two approaches must agree, but a
  // direct sum can never silently drift out of sync with pipelineValue if
  // OPEN_PIPELINE_STATUSES ever changes shape.
  const namedOpenStatuses = [QUOTE_AND_DEMO_SENT_STATUS, POTENTIAL_FOLLOWUP_STATUS, 'Negotiation'];
  const otherOpenLeads = openLeads.filter(l=>!namedOpenStatuses.includes(l.status));
  const otherOpenPipelineValue = otherOpenLeads.reduce((s,l)=>s+(l.estimatedValue||0),0);

  // Dev-only sanity check (never shown to users) — the direct sum above must
  // always equal the total minus the three named stages, or one of the two
  // calculations has drifted.
  if(typeof console!=='undefined' && console.assert){
    console.assert(
      Math.abs((quoteDemoSentValue+potentialFollowupValue+negotiationValue+otherOpenPipelineValue) - pipelineValue) < 0.005,
      'Dashboard: Sales Pipeline Value cards do not sum to Total Open Pipeline'
    );
  }

  // Closed Sales Value: every Project's Confirmed Value (projects only ever
  // exist for Confirmed-or-later / non-Lost opportunities).
  const closedSalesValue = projects.reduce((s,p)=>s+(p.confirmedValue||0),0);

  // All money figures below come from the SAME payment ledger the Payments
  // page reads — so Dashboard, Payments and Sales Performance can never
  // show three different numbers for the same thing.
  const collectedRevenue = payments.reduce((s,p)=> s + (Number(p.amount)||0), 0);
  const outstanding = projects.reduce((s,p)=> s + paymentSummaryFor(p.id).remaining, 0);

  // KPI cards are grouped into three business-meaning rows (spec §1) rather
  // than one flat grid — the calculations above are completely unchanged,
  // this only changes how the same numbers are laid out. "Pending
  // Quotations" has been removed from here (Dashboard-only quotation
  // widget) — Quotations itself is unaffected, it's still fully reachable
  // from its own sidebar entry/module exactly as before.
  const pipelineKpis = [
    { label:'Total Leads', value: totalLeads, icon:'users', color:'#1d7bff' },
    { label:'Open Leads', value: openLeadsAll.length, icon:'grid', color:'#18c8ff' },
    { label:'Follow-ups Due', value: followupDue, icon:'clock', color:'#d98a12', goPipeline:'due' },
  ];
  const deliveryKpis = [
    { label:'Confirmed Projects', value: confirmedProjects, icon:'briefcase', color:'#12a775' },
    { label:'Active Projects', value: activeProjects, icon:'columns', color:'#155fcc' },
  ];
  // Dashboard metric-clarity task: "Financial Performance" is split into two
  // clearly separated sections so the numbers visibly sum to the headline
  // total instead of reading as one undifferentiated wall of money figures.
  //
  // A. SALES PIPELINE VALUE — every card here is CURRENT-STAGE-ONLY and
  //    mutually exclusive (each open lead contributes to exactly one of the
  //    4 named-stage cards + "Other Open Pipeline"), summing exactly to
  //    Total Open Pipeline. Each card also shows the underlying opportunity
  //    count (same filtered array already built above, just `.length`) so
  //    the current-stage framing is visible at a glance, not just in the
  //    subtitle/tooltip. Click-through still targets the general Pipeline
  //    page (no existing per-stage filter mechanism to route to — same
  //    reasoning as the original Financial Performance rebuild).
  const oppWord = n => n===1 ? 'opportunity' : 'opportunities';
  const salesPipelineKpis = [
    { label:'Total Open Pipeline', value: money(pipelineValue), count:`${openLeads.length} ${oppWord(openLeads.length)}`,
      sub:'All active opportunities', icon:'columns', color:'#ff8a3d', go:'pipeline', goLabel:'Pipeline', strong:true },
    { label: pipelineStageLabel(QUOTE_AND_DEMO_SENT_STATUS), value: money(quoteDemoSentValue), count:`${quoteDemoSentLeads.length} ${oppWord(quoteDemoSentLeads.length)}`,
      sub:'Currently at this stage', icon:'list', color:'#1d7bff', go:'pipeline', goLabel:'Pipeline' },
    { label: pipelineStageLabel(POTENTIAL_FOLLOWUP_STATUS), value: money(potentialFollowupValue), count:`${potentialFollowupLeads.length} ${oppWord(potentialFollowupLeads.length)}`,
      sub:'Currently awaiting follow-up', icon:'clock', color:'#d98a12', go:'pipeline', goLabel:'Pipeline' },
    { label:'Negotiation', value: money(negotiationValue), count:`${negotiationLeads.length} ${oppWord(negotiationLeads.length)}`,
      sub:'Currently under negotiation', icon:'grid', color:'#7c5cff', go:'pipeline', goLabel:'Pipeline' },
    { label:'Other Open Pipeline', value: money(otherOpenPipelineValue), count:`${otherOpenLeads.length} ${oppWord(otherOpenLeads.length)}`,
      sub:'Other active pipeline stages', icon:'grid', color:'#5a6b8c', go:'pipeline', goLabel:'Pipeline' },
  ];
  // B. REVENUE PERFORMANCE — unchanged definitions/calculations from the
  //    immediately preceding task, just relabeled as its own section.
  const revenuePerformanceKpis = [
    { label:'Closed Sales Value', value: money(closedSalesValue), icon:'briefcase', color:'#0d8a5f', go:'projects', goLabel:'Projects' },
    { label:'Collected Revenue', value: money(collectedRevenue), icon:'dollar', color:'#12a775', go:'payments', goLabel:'Payments' },
    { label:'Outstanding Balance', value: money(outstanding), icon:'dollar', color:'#e0473c', go:'payments', goLabel:'Payments' },
  ];

  const recentLeads = [...leads].sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt)).slice(0,6);
  const dueToday = activeLeads().filter(l=> urgencyOf(l.nextFollowup)==='today' && !['Lost','Confirmed'].includes(l.status));
  const recentStatusChanges = activities.filter(a=>a.type==='Status Changed' || a.type==='Project Stage Changed').slice(0,6);
  const recentPayments = [...payments].sort((a,b)=> new Date(b.date||b.createdAt) - new Date(a.date||a.createdAt)).slice(0,6);
  const attentionProjects = projects.filter(p=>{
    if(!ACTIVE_PROJECT_STAGES.includes(p.stage)) return false;
    const overdue = p.expectedDelivery && daysUntil(p.expectedDelivery)<0;
    const unpaidBalance = p.stage==='Final Payment Pending' && paymentSummaryFor(p.id).remaining>0;
    return overdue || unpaidBalance;
  }).slice(0,6);

  // ----- data for the two Industry charts (donut if ≤6 categories, else -----
  // ----- a horizontal bar list so a busy breakdown never renders as a  -----
  // ----- broken tiny ring) -----
  const pipelineByIndustry = groupByIndustry(openLeads, l=>industryLabel(l.industry), l=>l.estimatedValue||0);
  const closedByIndustry = groupByIndustry(projects, p=>industryLabel(p.industry), p=>p.confirmedValue||0);

  el.innerHTML = `
    ${kpiGroupHtml('Sales Pipeline', pipelineKpis)}
    ${kpiGroupHtml('Project Delivery', deliveryKpis, 'kpi-grid-2')}
    ${kpiGroupHtml('Sales Pipeline Value', salesPipelineKpis, 'kpi-grid-5',
      'Pipeline stage values represent each opportunity\'s current stage only.')}
    ${kpiGroupHtml('Revenue Performance', revenuePerformanceKpis, 'kpi-grid-3')}
    <div class="two-col" style="margin-bottom:16px">
      <div class="panel">
        <div class="panel-head"><h3>Pipeline Value by Industry</h3></div>
        <div class="panel-body pad">
          ${industryBarChartHtml(pipelineByIndustry, { totalLabel:'Total Open Pipeline', emptyText:'No pipeline data yet.' })}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Closed Sales by Industry</h3></div>
        <div class="panel-body pad">
          ${industryBarChartHtml(closedByIndustry, { totalLabel:'Total Closed Sales', emptyText:'No confirmed sales data yet.' })}
        </div>
      </div>
    </div>

    <div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h3>Leads by Source</h3></div>
      <div class="panel-body pad">
        ${leadsBySourceHtml(leads)}
      </div>
    </div>

    <div class="dash-grid">
      <div class="stack">
        <div class="panel">
          <div class="panel-head"><h3>Recent Leads</h3><span class="see-all" data-go="leads">See all</span></div>
          <div class="panel-body">
            ${recentLeads.length ? recentLeads.map(l=>`
              <div class="mini-row">
                <div class="mini-main">
                  <div class="mini-title">${escapeHtml(l.businessName)} <span class="text-muted" style="font-weight:600">— ${escapeHtml(l.clientName)}</span></div>
                  <div class="mini-sub">${l.id} · ${escapeHtml(l.assignedSales)} · ${money(l.estimatedValue)}</div>
                </div>
                <div class="mini-right">${statusBadge(l.status, pipelineStageLabel(l.status))}<div style="margin-top:4px">${fmtDate(l.createdAt)}</div></div>
              </div>`).join('') : `<div class="empty-row">No leads yet.</div>`}
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><h3>Follow-ups Due Today</h3><span class="see-all" data-go-pipeline="today">See all</span></div>
          <div class="panel-body">
            ${dueToday.length ? dueToday.map(l=>`
              <div class="mini-row">
                <div class="mini-main">
                  <div class="mini-title">${escapeHtml(l.clientName)} — ${escapeHtml(l.businessName)}</div>
                  <div class="mini-sub">${escapeHtml(l.assignedSales)} · ${escapeHtml(l.phone)}</div>
                </div>
                <div class="mini-right">${statusBadge(l.status, pipelineStageLabel(l.status))}</div>
              </div>`).join('') : `<div class="empty-row">Nothing due today. 🎉</div>`}
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="panel">
          <div class="panel-head"><h3>Recent Status Changes</h3><span class="see-all" data-go="activity">See all</span></div>
          <div class="panel-body">
            ${recentStatusChanges.length ? recentStatusChanges.map(a=>`
              <div class="mini-row">
                <div class="mini-main">
                  <div class="mini-title"><b>${escapeHtml(a.userName)}</b> changed ${escapeHtml(a.refLabel)}</div>
                  <div class="mini-sub">${escapeHtml(a.fromValue||'')} → ${escapeHtml(a.toValue||'')}${a.remark ? ' · '+escapeHtml(a.remark):''}</div>
                </div>
                <div class="mini-right">${fmtDateTime(a.at)}</div>
              </div>`).join('') : `<div class="empty-row">No status changes yet.</div>`}
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><h3>Recent Payments</h3><span class="see-all" data-go="payments">See all</span></div>
          <div class="panel-body">
            ${recentPayments.length ? recentPayments.map(p=>{
              const proj = DB.find('projects', p.projectId);
              return `
              <div class="mini-row">
                <div class="mini-main">
                  <div class="mini-title">${proj?escapeHtml(proj.businessName):p.projectId} <span class="text-muted" style="font-weight:600">(${p.projectId})</span></div>
                  <div class="mini-sub">${escapeHtml(p.type)} · ${money(p.amount)}</div>
                </div>
                <div class="mini-right">${fmtDate(p.date)}</div>
              </div>`;
            }).join('') : `<div class="empty-row">No payments recorded yet.</div>`}
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><h3>Projects Needing Attention</h3><span class="see-all" data-go="projects">See all</span></div>
          <div class="panel-body">
            ${attentionProjects.length ? attentionProjects.map(p=>`
              <div class="mini-row">
                <div class="mini-main">
                  <div class="mini-title">${p.id} — ${escapeHtml(p.businessName)}</div>
                  <div class="mini-sub">${escapeHtml(p.assignedSales)} · delivery ${fmtDate(p.expectedDelivery)}</div>
                </div>
                <div class="mini-right">${statusBadge(p.stage)}</div>
              </div>`).join('') : `<div class="empty-row">All active projects on track.</div>`}
          </div>
        </div>
      </div>
    </div>
  `;

  el.querySelectorAll('[data-go]').forEach(x=> x.onclick = ()=>{ window.location.hash = '#'+x.dataset.go; });
  // "Open in Pipeline" shortcuts (spec §9/§14): the Follow-ups Due KPI card
  // and the Follow-ups Due Today panel's "See all" link both used to point
  // at the now-removed standalone Follow-ups page — they now pre-set
  // Pipeline's Follow-up filter and jump straight there instead.
  el.querySelectorAll('[data-go-pipeline]').forEach(x=> x.onclick = ()=>{
    PIPELINE_FILTER_STATE.followup = x.dataset.goPipeline;
    window.location.hash = '#pipeline';
  });
  // Wires the "Sales Pipeline Value" section-header help button — same
  // shared hover/click/keyboard tooltip mechanism as Lead Records' KPI
  // cards (leads.js), reused rather than reinvented.
  if(typeof wireKpiHelpTooltips === 'function') wireKpiHelpTooltips(el);
}

/* ---------------------------------------------------------------------- */
/* Industry ranked bar charts — plain HTML/CSS, no chart library/canvas   */
/* or SVG involved (replaces the old donut, which rendered unusably small */
/* — see industryBarChartHtml() below).                                   */
/* ---------------------------------------------------------------------- */

// Fixed industry -> color map (NOT index-based) so the same industry is
// always the same color on every chart, regardless of which industries
// happen to appear or in what order they're sorted — this was the root
// cause of the two Dashboard charts being able to disagree on a color
// before. Anything not in this list (a future industry, or a literal
// "Unspecified" bucket) falls back to a single stable neutral color.
const INDUSTRY_COLOR_MAP = {
  'Retail / E-Commerce': '#1d7bff',
  'Clinic / Healthcare': '#18c8ff',
  'School / Education': '#ff6b5b',
  'Hotel / Resort / Guesthouse': '#a855f7',
  'Real Estate / Property': '#7c5cff',
  'Logistics / Delivery': '#12a775',
  'NGO / Association': '#0aa1c9',
  'Insurance / Finance': '#5ec8f2',
  'Professional Services': '#526584',
  'Other': '#ff8a3d',
  'Salon / Beauty': '#f2994a',
  'Restaurant / Cafe': '#d98a12',
  'Construction / Property Development': '#8a6d3b',
  'Pharmacy': '#2fae7a',
  'Unspecified': '#9aa7bb',
};
function colorForIndustry(name){
  return INDUSTRY_COLOR_MAP[name] || INDUSTRY_COLOR_MAP['Unspecified'];
}

function groupByIndustry(items, industryFn, valueFn){
  const map = {};
  items.forEach(item=>{
    const key = industryFn(item) || 'Other';
    const val = valueFn(item) || 0;
    if(!map[key]) map[key] = { count:0, value:0 };
    map[key].count += 1;
    map[key].value += val;
  });
  return map;
}

// Horizontal ranked bar chart — replaces the old donut (it rendered an
// unusably tiny ring with the legend crowding out the rest of the card).
// Sorted highest-first; bar WIDTH is scaled to the top industry's value
// (industry value / max value), never to percentage-of-total, so a chart
// with many small slivers next to one big one still reads clearly instead
// of compressing every bar down toward zero width.
//
// At most MAX_ROWS rows are ever shown — beyond that, the smallest
// remaining industries are folded into a single "Other / Remaining" row
// (spec §6) so the card never needs internal scrolling and never grows
// past a predictable height.
const INDUSTRY_BAR_MAX_ROWS = 8;

function industryBarChartHtml(dataMap, { totalLabel, emptyText }){
  const entries = Object.entries(dataMap).filter(([,d])=>d.value>0).sort((a,b)=>b[1].value-a[1].value);
  if(!entries.length){
    return `<div class="empty-row">${escapeHtml(emptyText||'No data yet.')}</div>`;
  }

  const total = entries.reduce((s,[,d])=>s+d.value,0);

  let shown = entries;
  if(entries.length > INDUSTRY_BAR_MAX_ROWS){
    const top = entries.slice(0, INDUSTRY_BAR_MAX_ROWS-1);
    const rest = entries.slice(INDUSTRY_BAR_MAX_ROWS-1);
    const combined = rest.reduce((acc,[,d])=>({ count: acc.count+d.count, value: acc.value+d.value }), { count:0, value:0 });
    // Re-sort after folding the tail in — the combined "Other / Remaining"
    // bucket can easily outweigh one of the individually-shown top
    // industries, so it must take its real rank by value, not just get
    // appended last, or the chart would stop reading as sorted descending.
    shown = [...top, ['Other / Remaining', combined]].sort((a,b)=>b[1].value-a[1].value);
  }

  const max = Math.max(...shown.map(([,d])=>d.value));

  const rows = shown.map(([industry,d])=>{
    const pct = total ? Math.round((d.value/total)*100) : 0;
    const widthPct = max ? Math.max((d.value/max)*100, 2) : 0;
    const color = industry==='Other / Remaining' ? INDUSTRY_COLOR_MAP['Other'] : colorForIndustry(industry);
    return `
      <div class="industry-bar-row">
        <div class="industry-bar-label" title="${escapeHtml(industry)}">${escapeHtml(industry)}</div>
        <div class="industry-bar-track"><div class="industry-bar-fill" style="width:${widthPct}%;background:${color}"></div></div>
        <div class="industry-bar-meta">
          <span class="industry-bar-amount">${money(d.value)}</span>
          <span class="industry-bar-pct">${pct}%</span>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="industry-bars-head"><span class="total-label">${escapeHtml(totalLabel||'Total')}</span><span class="total-value">${money(total)}</span></div>
    <div class="industry-bars-list">${rows}</div>
  `;
}

function leadsBySourceHtml(leads){
  const counts = {};
  LEAD_SOURCES.forEach(s=> counts[s]=0);
  leads.forEach(l=> counts[l.leadSource] = (counts[l.leadSource]||0)+1);
  const max = Math.max(1, ...Object.values(counts));
  const rows = Object.entries(counts).filter(([,c])=>c>0).sort((a,b)=>b[1]-a[1]);
  if(!rows.length) return `<div class="empty-row">No lead source data yet.</div>`;
  return rows.map(([source,count])=>`
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
      <div style="width:130px;font-size:12.5px;font-weight:700;color:var(--navy);flex:0 0 130px">${escapeHtml(source)}</div>
      <div class="progress-track" style="flex:1"><div class="progress-fill" style="width:${(count/max)*100}%"></div></div>
      <div style="width:26px;text-align:right;font-size:12.5px;font-weight:800;color:var(--muted)">${count}</div>
    </div>
  `).join('');
}
