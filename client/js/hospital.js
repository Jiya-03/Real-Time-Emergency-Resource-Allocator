// JeevanRoute Hospital Portal: dashboard, request review, resources, active cases, handover, history.
// A new bed request from an ambulance triggers a full-screen alarm with a siren until staff respond.
(() => {
  const session = Session.get();
  if (!session?.token || session.user?.role !== 'hospital') { location.replace('index.html'); return; }
  api('/api/auth/me').catch((err) => { if (err.status === 401) { Session.clear(); location.replace('index.html'); } });

  const $ = (id) => document.getElementById(id);
  const esc = fmt.escape;
  const HID = session.user.hospital_id;
  const state = {
    view: 'dashboard', param: null,
    items: [],          // /api/reservations → pending + confirmed (with workflow + ETA)
    hospital: null,     // /api/hospitals/:id
    history: [],
    meta: { reject_reasons: ['No Bed', 'No Equipment', 'Specialist Unavailable', 'Stale Data', 'Other'], hold_minutes: 10 },
    draftCaps: null,
    checklists: {},     // request_id → Set of checked items (handover)
    alarmQueue: [],     // request_ids waiting to be acknowledged
    seenAlarms: new Set(),
    broadcastIds: new Set(),   // requests that were sent to several hospitals at once
  };

  // ───────────── Labels ─────────────
  const TYPE_NOUN = { 'Road Accident': 'Trauma', Cardiac: 'Cardiac', Stroke: 'Stroke', Burn: 'Burns', Respiratory: 'Respiratory Distress', Other: 'Emergency' };
  const SEV_PREFIX = { Critical: 'Critical', High: 'Acute', Moderate: 'Moderate', Low: 'Minor' };
  const PRIORITY = { Critical: ['Critical', 'Code Red', '#b51735', '#ffdada'], High: ['Severe', 'Code Orange', '#b45309', '#ffedd5'], Moderate: ['Urgent', 'Code Yellow', '#92400e', '#fef3c7'], Low: ['Routine', 'Code Green', '#065f46', '#d1fae5'] };
  const condition = (r) => `${SEV_PREFIX[r.severity] || ''} ${TYPE_NOUN[r.emergency_type] || r.emergency_type}`.trim();
  const unit = (id) => id ? `A-${String(parseInt(id.replace(/\D/g, ''), 10)).padStart(2, '0')}` : 'A-12';
  const urgent = (r) => r.severity === 'Critical' || r.severity === 'High';
  const mmss = (sec) => { const s = Math.max(0, Math.round(sec)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const ago = (iso) => { const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`; };

  const DEPT = { trauma_care: ['Trauma & Emergency', 'emergency'], icu: ['ICU (Intensive Care)', 'monitor_heart'], operation_theatre: ['Operation Theatre', 'medical_services'],
                 cardiology: ['Cardiology', 'cardiology'], neurology: ['Neurology', 'neurology'], blood_bank: ['Blood Bank', 'bloodtype'], dialysis: ['Dialysis', 'nephrology'] };
  const EQUIP = { ventilator: ['Mechanical Ventilator', 'air'], oxygen: ['Oxygen Support Bed', 'pulmonology'] };
  const depts = (r) => Object.keys(DEPT).filter(k => r.requirements[k]).map(k => DEPT[k][0]);
  const equips = (r) => [...Object.keys(EQUIP).filter(k => r.requirements[k]).map(k => EQUIP[k][0]), ...(r.additional_needs || [])];

  function vitals(r) {
    const f = r.field_report || {};
    const sbp = f.bp ? Number(String(f.bp).split('/')[0]) : null;
    const unstable = (sbp !== null && sbp < 90) || (f.hr && f.hr > 120) || (f.spo2 && f.spo2 < 94);
    return { ...f, sbp, unstable, has: !!(f.bp || f.hr || f.spo2) };
  }

  const chip = (text, cls = 'bg-surface-container-low text-on-surface') => `<span class="px-space-sm py-0.5 rounded ${cls} font-label-md text-label-md">${esc(text)}</span>`;
  const empty = (text, icon = 'inbox') => `<div class="bg-surface-container-lowest rounded-xl shadow-sm px-space-xl py-space-2xl flex flex-col items-center gap-space-sm text-center">
    <span class="material-symbols-outlined text-[32px] text-outline">${icon}</span><span class="font-body-md text-body-md text-on-surface-variant">${text}</span></div>`;

  // ───────────── Header / session ─────────────
  $('side-hosp').textContent = session.user.name;
  $('hosp-sub').textContent = `${session.user.name} • Emergency Operations`;
  $('user-id').textContent = `ID ${HID}`;
  const logout = () => { Session.clear(); location.replace('index.html'); };
  $('logout-btn').addEventListener('click', logout);
  $('logout-btn-2').addEventListener('click', logout);
  $('user-btn').addEventListener('click', (e) => { e.stopPropagation(); $('user-menu').classList.toggle('hidden'); });
  document.addEventListener('click', () => $('user-menu').classList.add('hidden'));
  $('bell-btn').addEventListener('click', () => { location.hash = '#requests'; });

  function tickClock() {
    const now = new Date();
    const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(now));
    $('greeting').textContent = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    $('clock').textContent = fmt.timeIST(now.toISOString());
  }

  function toast(title, body = '', tone = 'info') {
    const colors = { info: 'border-outline-variant', success: 'border-[#6EE7B7]', critical: 'border-[#F87171]', warn: 'border-[#D97706]' };
    const el = document.createElement('div');
    el.className = `bg-surface-container-lowest border ${colors[tone]} border-l-4 rounded-lg px-space-lg py-space-md shadow-[0_4px_16px_-4px_rgba(11,31,58,0.12)]`;
    el.innerHTML = `<div class="font-label-lg text-label-lg text-on-surface">${esc(title)}</div>${body ? `<div class="font-body-sm text-body-sm text-on-surface-variant mt-0.5">${body}</div>` : ''}`;
    $('toasts').appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 6000);
  }

  // ───────────── Siren arming ─────────────
  function renderArm() {
    const armed = Siren.armed();
    $('arm-btn').className = `inline-flex items-center gap-space-xs px-space-md py-space-xs rounded-full font-label-md text-label-md border ${armed ? 'border-[#6EE7B7] text-[#065F46] bg-[#ECFDF5]' : 'border-[#FCD34D] text-[#92400E] bg-[#FFFBEB] animate-pulse'}`;
    $('arm-btn').innerHTML = `<span class="material-symbols-outlined text-[16px]">${armed ? 'volume_up' : 'volume_off'}</span>${armed ? 'Siren armed' : 'Arm siren'}`;
    $('arm-banner').classList.toggle('hidden', armed);
    $('arm-banner').classList.toggle('flex', !armed);
  }
  function armOnce() {
    Siren.arm();
    setTimeout(renderArm, 50);
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  }
  ['click', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, () => { if (!Siren.armed()) armOnce(); }, { capture: true }));
  $('arm-btn').addEventListener('click', () => { armOnce(); if (Siren.armed()) toast('Siren armed', 'Incoming requests will sound a loud alarm.', 'success'); });
  $('test-alert-btn').addEventListener('click', () => {
    armOnce();
    const sample = state.items.find(i => i.status === 'PENDING');
    showAlarm(sample || { reservation_id: null, request: { request_id: 'TEST', emergency_type: 'Road Accident', severity: 'Critical', patient_age: 34, requirements: { icu: true, trauma_care: true, operation_theatre: true }, field_report: { bp: '84/52', hr: 128, spo2: 91 }, ambulance_id: 'AMB-012' }, eta_min: 11, distance_km: 4.8, reservations: [{ expires_at: new Date(Date.now() + 600000).toISOString() }], test: true });
  });

  // ───────────── FULL-SCREEN ALARM ─────────────
  let alarmItem = null;
  let titleFlash = null;
  function showAlarm(item) {
    alarmItem = item;
    const r = item.request;
    const [pl] = PRIORITY[r.severity] || PRIORITY.Moderate;
    const v = vitals(r);
    $('alarm-title').textContent = `${condition(r)} (${(PRIORITY[r.severity] || [])[1] || ''})`;
    $('alarm-facts').innerHTML = [
      ['Ambulance', `${unit(r.ambulance_id)}`],
      ['ETA', `${item.eta_min ?? '—'} min`],
      ['Patient', `Age ${r.patient_age}`],
      ['Priority', pl],
    ].map(([k, val]) => `<div class="rounded-lg bg-surface-container-low px-space-md py-space-sm"><div class="font-label-md text-label-md text-on-surface-variant uppercase">${k}</div><div class="font-telemetry-lg text-telemetry-lg text-on-surface">${esc(val)}</div></div>`).join('');
    $('alarm-needs').innerHTML = [...depts(r).map(d => chip(d, 'bg-surface-container text-primary')), ...equips(r).map(e => chip(e, 'bg-tertiary-fixed text-tertiary'))].join('')
      + (r.required_specialist ? chip(r.required_specialist, 'bg-surface-container-high text-on-surface') : '');
    const race = (r.broadcast_round > 0 || state.broadcastIds.has(r.request_id)) ? 'Also sent to other suitable hospitals. The FIRST to accept gets this patient. ' : '';
    $('alarm-notes').textContent = race + (v.has ? `Vitals: ${[v.bp && `BP ${v.bp}`, v.hr && `HR ${v.hr}`, v.spo2 && `SpO₂ ${v.spo2}%`].filter(Boolean).join(' · ')}${v.unstable ? ' · UNSTABLE' : ''}${v.notes ? `. "${v.notes}"` : ''}`
      : (item.test ? 'This is a test alert.' : 'No field vitals transmitted.'));
    $('alarm-countdown').dataset.countdown = item.reservations?.[0]?.expires_at || '';
    const more = state.alarmQueue.filter(id => id !== r.request_id).length;
    $('alarm-queue').textContent = more ? `+${more} more request${more > 1 ? 's' : ''} waiting` : '';
    $('alarm').classList.remove('hidden'); $('alarm').classList.add('flex');
    $('alarm-card').classList.remove('alarm-shake'); void $('alarm-card').offsetWidth; $('alarm-card').classList.add('alarm-shake');

    if (Siren.start()) setTimeout(() => Siren.announce(`Emergency request. ${condition(r)}. Ambulance ${item.eta_min ?? ''} minutes away.`), 1500);
    if (navigator.vibrate && navigator.userActivation?.hasBeenActive) navigator.vibrate([400, 200, 400, 200, 800]);
    clearInterval(titleFlash);
    let on = false;
    titleFlash = setInterval(() => { document.title = (on = !on) ? '🚨 INCOMING EMERGENCY' : 'JeevanRoute — Hospital Portal'; }, 700);
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted' && !item.test) {
      try { new Notification('🚨 Incoming emergency', { body: `${condition(r)} · Ambulance ${unit(r.ambulance_id)} · ${item.eta_min} min`, requireInteraction: true }); } catch {}
    }
    tick();
  }
  function closeAlarm() {
    Siren.stop();
    try { speechSynthesis.cancel(); } catch {}
    clearInterval(titleFlash); document.title = 'JeevanRoute — Hospital Portal';
    $('alarm').classList.add('hidden'); $('alarm').classList.remove('flex');
    if (alarmItem) state.alarmQueue = state.alarmQueue.filter(id => id !== alarmItem.request.request_id);
    alarmItem = null;
  }
  function nextAlarm() {
    const nextId = state.alarmQueue[0];
    const item = nextId && state.items.find(i => i.request.request_id === nextId && i.status === 'PENDING');
    if (item) showAlarm(item); else state.alarmQueue = [];
  }
  $('alarm-review').addEventListener('click', () => {
    const id = alarmItem?.request.request_id;
    const isTest = alarmItem?.test;
    closeAlarm();
    if (id && !isTest) location.hash = `#requests/${encodeURIComponent(id)}`;
  });
  $('alarm-silence').addEventListener('click', () => { closeAlarm(); setTimeout(nextAlarm, 400); });

  // ───────────── Data ─────────────
  async function loadItems() {
    try {
      state.items = (await api('/api/reservations')).items;
    } catch (err) { toast('Could not load requests', esc(err.message), 'critical'); }
    render();
  }
  async function loadHospital() {
    try { state.hospital = await api(`/api/hospitals/${encodeURIComponent(HID)}`); } catch { /* keep last */ }
    render();
  }
  async function loadHistory() {
    try { state.history = (await api('/api/reservations/history')).items; } catch { /* keep last */ }
    render();
  }

  const pending = () => state.items.filter(i => i.status === 'PENDING');
  const confirmed = () => state.items.filter(i => i.status === 'CONFIRMED');
  const enRoute = () => confirmed().filter(i => !i.workflow?.arrival_time);
  const atBay = () => confirmed().filter(i => i.workflow?.arrival_time && i.workflow?.handover_status !== 'COMPLETED');

  // ───────────── Shared bits ─────────────
  function priorityChip(r) {
    const [label, , color, bg] = PRIORITY[r.severity] || PRIORITY.Moderate;
    return `<span class="inline-flex items-center gap-1 px-space-sm py-0.5 rounded font-telemetry-sm text-telemetry-sm" style="background:${bg};color:${color}"><span class="w-1.5 h-1.5 rounded-full" style="background:${color}"></span>Priority: ${label}</span>`;
  }
  function caseStatus(i) {
    const w = i.workflow || {};
    if (i.status === 'PENDING') return ['Awaiting your response', 'bg-tertiary-fixed text-tertiary'];
    if (w.handover_status === 'COMPLETED') return ['Handed over', 'bg-surface-container text-on-surface'];
    if (w.arrival_time) return ['Arrived · Handover ready', 'bg-[#ECFDF5] text-[#065F46]'];
    if (w.departure_time) return ['En route · Bay prepared', 'bg-secondary-container/40 text-primary'];
    return ['Accepted · Crew preparing', 'bg-surface-container-low text-on-surface'];
  }
  function etaCell(i) {
    const w = i.workflow || {};
    if (w.arrival_time) return `<span class="font-telemetry-md text-telemetry-md text-on-surface">Arrived ${fmt.timeIST(w.arrival_time)}</span>`;
    if (i.arrival_eta) return `<span class="font-telemetry-md text-telemetry-md text-tertiary font-semibold" data-eta="${esc(i.arrival_eta)}">…</span>`;
    return `<span class="font-telemetry-md text-telemetry-md text-on-surface">~${i.eta_min} min · ${i.distance_km} km</span>`;
  }

  // ───────────── DASHBOARD (h1) ─────────────
  function renderDashboard() {
    const p = pending(), c = confirmed();
    const urgentCount = p.filter(i => urgent(i.request)).length;
    const heldUnits = c.reduce((a, i) => a + i.reservations.reduce((b, r) => b + r.quantity, 0), 0);
    const heldTypes = [...new Set(c.flatMap(i => i.reservations.map(r => r.resource_type)))];
    const stat = (label, value, icon, iconCls, foot) => `
      <div class="bg-surface-container-lowest rounded-xl shadow-sm p-space-lg flex flex-col gap-space-sm">
        <div class="flex items-start justify-between"><span class="font-label-md text-label-md text-on-surface-variant uppercase">${label}</span>
          <span class="w-10 h-10 rounded-lg ${iconCls} flex items-center justify-center"><span class="material-symbols-outlined">${icon}</span></span></div>
        <span class="font-display-lg text-[40px] leading-none ${label.startsWith('Emergency') && value ? 'text-tertiary' : 'text-on-surface'}">${value}</span>
        <span class="font-body-sm text-body-sm">${foot}</span></div>`;
    $('stats').innerHTML =
      stat('Emergency Requests', p.length, 'notifications_active', 'bg-tertiary-fixed text-tertiary',
        urgentCount ? `<span class="inline-flex items-center gap-1 px-space-sm py-0.5 rounded bg-tertiary text-on-tertiary font-telemetry-sm text-telemetry-sm">● ${urgentCount} Urgent Action Required</span>` : '<span class="text-on-surface-variant">No urgent requests</span>') +
      stat('Active Cases', c.length, 'airport_shuttle', 'bg-surface-container text-primary',
        `<span class="text-on-surface-variant flex items-center gap-1"><span class="material-symbols-outlined text-[16px] text-primary">navigation</span>${enRoute().filter(i => i.workflow?.departure_time).length} in transit · ${atBay().length} at the bay</span>`) +
      stat('Resources Reserved', heldUnits, 'lock', 'bg-surface-container text-primary',
        `<span class="text-on-surface-variant flex items-center gap-1"><span class="material-symbols-outlined text-[16px] text-primary">check_circle</span>${heldTypes.length ? esc(heldTypes.join(', ')) + ' locked' : 'Nothing held right now'}</span>`);

    $('dash-pending-chip').textContent = `${p.length} pending`;
    $('dash-requests').innerHTML = p.length ? p.map((i, idx) => idx === 0 ? bigRequestCard(i) : smallRequestCard(i)).join('') : empty('No incoming requests. Ambulance requests will appear here and sound the alarm.', 'notifications_off');
    $('dash-active-chip').textContent = `${c.length} tracked`;
    $('dash-updated').textContent = `Updated: ${fmt.timeIST(new Date().toISOString())}`;
    $('dash-active').innerHTML = casesTable(c, { compact: true });
  }

  function bigRequestCard(i) {
    const r = i.request, v = vitals(r);
    const box = (icon, label, value, cls = 'text-on-surface') => `<div class="flex items-center gap-space-sm"><span class="w-9 h-9 rounded-lg bg-surface-container-lowest flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-[18px] text-primary">${icon}</span></span>
      <div class="flex flex-col"><span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant uppercase">${label}</span><span class="font-label-lg text-label-lg ${cls}">${value}</span></div></div>`;
    return `
<div class="bg-surface-container-lowest rounded-xl shadow-sm overflow-hidden ${urgent(r) ? 'ring-2 ring-[#F54B5E]/40' : ''}">
  <div class="h-1.5 bg-tertiary"></div>
  <div class="p-space-lg flex flex-col lg:flex-row gap-space-lg">
    <div class="flex-1 flex flex-col gap-space-md min-w-0">
      <div class="flex items-center gap-space-sm flex-wrap">
        <span class="inline-flex items-center gap-1 px-space-sm py-1 rounded bg-tertiary text-on-tertiary font-telemetry-sm text-telemetry-sm font-semibold"><span class="material-symbols-outlined text-[14px]">e911_emergency</span>EMERGENCY REQUEST</span>
        <span class="font-telemetry-md text-telemetry-md text-on-surface">#${esc(r.request_id)}</span><span class="text-outline">·</span>
        <span class="font-headline-sm text-headline-sm text-on-surface">${esc(condition(r))}</span>${priorityChip(r)}
      </div>
      <div class="rounded-lg bg-surface-container-low p-space-md grid grid-cols-2 md:grid-cols-4 gap-space-md">
        ${box('airport_shuttle', 'Ambulance', `${unit(r.ambulance_id)} (ALS Unit)`)}
        ${box('timer', 'Transit ETA', `${i.eta_min} min`, 'text-tertiary')}
        ${box('near_me', 'Distance', `${i.distance_km} km`)}
        ${box('monitor_heart', 'Vitals (pre-hospital)', v.has ? `${v.bp ? `BP ${esc(v.bp)}` : ''} ${v.hr ? `· HR ${v.hr}` : ''}` : 'Not sent', v.unstable ? 'text-tertiary' : 'text-on-surface')}
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-space-md">
        <div class="flex flex-wrap items-center gap-space-xs"><span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant uppercase mr-1">Required departments:</span>${depts(r).map(d => chip(d)).join('') || chip('General bed')}</div>
        <div class="flex flex-wrap items-center gap-space-xs"><span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant uppercase mr-1">Major equipment:</span>${equips(r).map(e => chip(e, 'bg-tertiary-fixed text-tertiary')).join('') || '<span class="font-body-sm text-body-sm text-on-surface-variant">None</span>'}</div>
      </div>
    </div>
    <div class="lg:w-64 flex flex-col items-stretch justify-center gap-space-sm">
      <span class="self-end inline-flex items-center gap-space-xs px-space-sm py-0.5 rounded-full bg-tertiary-fixed text-tertiary font-telemetry-sm text-telemetry-sm"><span class="w-2 h-2 rounded-full bg-tertiary animate-pulse"></span>Waiting · <span data-countdown="${esc(i.reservations[0].expires_at)}">--:--</span></span>
      <a class="py-space-md rounded-lg bg-tertiary hover:bg-tertiary-container text-on-tertiary font-headline-sm text-headline-sm flex items-center justify-center gap-space-sm" href="#requests/${encodeURIComponent(r.request_id)}">Review Request <span class="font-telemetry-sm opacity-75">[Enter]</span><span class="material-symbols-outlined">arrow_forward</span></a>
    </div>
  </div>
</div>`;
  }

  function smallRequestCard(i) {
    const r = i.request;
    return `
<div class="bg-surface-container-lowest rounded-xl shadow-sm border-l-4 ${urgent(r) ? 'border-tertiary' : 'border-[#FF7A86]'} px-space-lg py-space-md flex flex-col lg:flex-row lg:items-center gap-space-md">
  <div class="flex-1 flex flex-col gap-space-xs min-w-0">
    <div class="flex items-center gap-space-sm flex-wrap">
      <span class="inline-flex items-center gap-1 px-space-sm py-0.5 rounded bg-tertiary-fixed text-tertiary font-telemetry-sm text-telemetry-sm font-semibold">✱ EMERGENCY REQUEST</span>
      <span class="font-telemetry-md text-telemetry-md">#${esc(r.request_id)}</span><span class="text-outline">·</span><span class="font-label-lg text-label-lg">${esc(condition(r))}</span>${priorityChip(r)}
    </div>
    <div class="flex items-center gap-space-md flex-wrap font-telemetry-sm text-telemetry-sm text-on-surface-variant">
      <span class="flex items-center gap-1"><span class="material-symbols-outlined text-[16px] text-primary">airport_shuttle</span>Amb ${unit(r.ambulance_id)} · Transit ETA: <b class="text-tertiary">${i.eta_min} min</b></span>
      <span class="flex items-center gap-1">REQUIRED: ${depts(r).slice(0, 3).map(d => chip(d)).join('')}</span>
    </div>
  </div>
  <div class="flex flex-col items-end gap-space-xs">
    <span class="font-telemetry-sm text-telemetry-sm text-tertiary">● Waiting · <span data-countdown="${esc(i.reservations[0].expires_at)}">--:--</span></span>
    <a class="px-space-lg py-space-sm rounded-lg bg-surface-container-low hover:bg-surface-container font-label-lg text-label-lg flex items-center gap-space-xs" href="#requests/${encodeURIComponent(r.request_id)}">Review Request<span class="material-symbols-outlined text-[18px]">arrow_forward</span></a>
  </div>
</div>`;
  }

  function casesTable(list, { compact = false } = {}) {
    if (!list.length) return `<div class="px-space-lg py-space-xl font-telemetry-sm text-telemetry-sm text-on-surface-variant">No active cases. Accepted patients appear here until handover.</div>`;
    const rows = list.map(i => {
      const r = i.request; const [st, stCls] = caseStatus(i); const w = i.workflow || {};
      const action = w.arrival_time
        ? `<a class="px-space-md py-space-xs rounded bg-primary text-on-primary font-label-md text-label-md" href="#handover/${encodeURIComponent(r.request_id)}">Handover</a>`
        : `<button class="px-space-md py-space-xs rounded bg-surface-container-low hover:bg-surface-container font-label-md text-label-md" data-arrive="${esc(r.request_id)}" type="button">Mark arrived</button>`;
      return `<div class="grid grid-cols-2 md:grid-cols-12 gap-space-sm md:gap-space-md px-space-lg py-space-md items-center border-b border-surface-container-low last:border-b-0 hover:bg-surface-container-low">
        <span class="md:col-span-2 flex items-center gap-space-xs font-telemetry-md text-telemetry-md"><span class="material-symbols-outlined text-[18px] text-primary">personal_injury</span>#${esc(r.request_id)}</span>
        <span class="md:col-span-3 font-label-lg text-label-lg">${esc(condition(r))}<span class="block font-telemetry-sm text-telemetry-sm text-on-surface-variant">Age ${r.patient_age}</span></span>
        <span class="md:col-span-2"><span class="px-space-sm py-0.5 rounded bg-surface-container-low font-telemetry-sm text-telemetry-sm">Amb ${unit(r.ambulance_id)}</span></span>
        <span class="md:col-span-2">${etaCell(i)}</span>
        <span class="md:col-span-2"><span class="px-space-sm py-1 rounded-full ${stCls} font-telemetry-sm text-telemetry-sm">● ${st}</span></span>
        <span class="md:col-span-1 flex justify-end gap-space-xs"><a class="w-8 h-8 rounded bg-surface-container-low hover:bg-surface-container flex items-center justify-center" href="#live/${encodeURIComponent(r.request_id)}" title="Track live route" aria-label="Track live route"><span class="material-symbols-outlined text-[18px] text-primary">near_me</span></a>${action}</span>
      </div>`;
    }).join('');
    return `<div class="hidden md:grid grid-cols-12 gap-space-md px-space-lg py-space-sm bg-surface-container-low font-label-md text-label-md text-on-surface-variant uppercase">
      <span class="col-span-2">Case ID</span><span class="col-span-3">Diagnosis / Condition</span><span class="col-span-2">Unit ID</span><span class="col-span-2">ETA / Timing</span><span class="col-span-2">Operational status</span><span class="col-span-1"></span></div>${rows}`;
  }

  // ───────────── REQUESTS list + DETAIL (h2) ─────────────
  function renderRequests() {
    const p = pending();
    $('requests-list').innerHTML = p.length ? p.map((i, idx) => idx === 0 ? bigRequestCard(i) : smallRequestCard(i)).join('') : empty('No requests waiting for your response.', 'task_alt');
  }

  function corridorSVG(i) {
    const w = i.workflow || {};
    let prog = 0.06;
    if (w.arrival_time) prog = 1;
    else if (w.departure_time) prog = Math.min(0.97, (Date.now() - new Date(w.departure_time)) / (i.eta_min * 60000));
    const x = 40 + prog * 300, y = 120 - Math.sin(prog * Math.PI) * 55 + (prog > .5 ? (prog - .5) * 20 : 0);
    return `<svg viewBox="0 0 380 160" class="w-full h-40 rounded-lg bg-surface-container-low" aria-label="Ambulance route progress">
      <path d="M40 120 C 120 120, 150 50, 220 60 S 320 30, 340 40" fill="none" stroke="#d6e3ff" stroke-width="10" stroke-linecap="round"/>
      <path d="M40 120 C 120 120, 150 50, 220 60 S 320 30, 340 40" fill="none" stroke="#006765" stroke-width="4" class="route-dash"/>
      <circle cx="340" cy="40" r="9" fill="#006765"/><text x="300" y="22" font-size="11" fill="#071c36" font-family="monospace">${esc(session.user.name.split(' ')[0])} Gate</text>
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="8" fill="#b51735"><animate attributeName="r" values="7;10;7" dur="1.2s" repeatCount="indefinite"/></circle>
      <text x="16" y="150" font-size="11" fill="#3d4948" font-family="monospace">Unit ${unit(i.request.ambulance_id)} · ${w.arrival_time ? 'docked' : w.departure_time ? 'en route' : 'at scene'}</text></svg>`;
  }

  function resourceCheckRows(i) {
    const r = i.request, h = state.hospital;
    const held = i.status === 'CONFIRMED' ? Object.fromEntries(i.reservations.map(x => [x.resource_type, x.quantity])) : {};
    const lockWord = i.status === 'PENDING' ? 'LOCKS ON ACCEPT' : 'LOCK READY';
    const rows = [];
    const bed = (key, label, resKey, icon) => {
      if (!r.requirements[key] && !(key === 'general' && !r.requirements.icu && !r.requirements.oxygen)) return;
      const res = h?.resources[resKey]; const hl = held[label === 'ICU' ? 'ICU' : label] || 0;
      const ok = hl > 0 || (res && res.available >= r.beds_required);
      rows.push([`${label === 'ICU' ? 'ICU (Intensive Care)' : label} (Bed)`, icon, ok ? 'AVAILABLE' : 'UNAVAILABLE', res ? `${hl ? `${hl} held for this patient · ` : ''}${res.available} free of ${res.total}` : '—', hl ? 'HELD' : ok ? lockWord : 'NO CAPACITY']);
    };
    bed('icu', 'ICU', 'icu', 'monitor_heart');
    bed('oxygen', 'Oxygen Bed', 'oxygen_bed', 'pulmonology');
    bed('general', 'General Bed', 'general_bed', 'bed');
    if (r.requirements.ventilator) {
      const res = h?.resources.ventilator; const hl = held.Ventilator || 0;
      const ok = hl > 0 || (res && res.available >= 1);
      rows.push(['Mechanical Ventilator (Equipment)', 'air', ok ? 'AVAILABLE' : 'UNAVAILABLE', res ? `${hl ? `${hl} held · ` : ''}${res.available} units free of ${res.total}` : '—', hl ? 'HELD' : ok ? lockWord : 'NO CAPACITY']);
    }
    for (const k of ['trauma_care', 'cardiology', 'neurology', 'operation_theatre', 'blood_bank', 'dialysis']) {
      if (!r.requirements[k]) continue;
      const ok = !!h?.services[k];
      rows.push([`${DEPT[k][0]} (Dept)`, DEPT[k][1], ok ? 'AVAILABLE' : 'NOT OFFERED', ok ? 'Service active' : 'Not offered at this hospital', ok ? 'LOCK READY' : '—']);
    }
    if (r.required_specialist) {
      const ok = h?.specialists.includes(r.required_specialist);
      rows.push([`${r.required_specialist} (Specialist)`, 'stethoscope', ok ? 'ON STAFF' : 'NOT ON STAFF', ok ? 'On call' : 'Not listed on staff', ok ? 'LOCK READY' : '—']);
    }
    for (const n of r.additional_needs || []) rows.push([`${n} (Requested)`, 'info', 'NOT TRACKED', 'Confirm on the floor', 'CHECK']);
    return rows;
  }

  function renderDetail() {
    const id = state.param;
    const i = state.items.find(x => x.request.request_id === id);
    const el = $('view-detail');
    if (!i) { el.innerHTML = `<a class="inline-flex items-center gap-space-xs font-label-lg text-label-lg w-fit" href="#requests"><span class="material-symbols-outlined text-[18px]">arrow_back</span>Back to Emergency Requests</a>${empty('This request is no longer active (answered, cancelled or expired).', 'task_alt')}`; return; }
    const r = i.request, v = vitals(r), isPending = i.status === 'PENDING';
    const [pl, code, pc, pbg] = PRIORITY[r.severity] || PRIORITY.Moderate;
    const rows = resourceCheckRows(i);
    const conflicts = rows.filter(x => ['UNAVAILABLE', 'NOT OFFERED', 'NOT ON STAFF'].includes(x[2])).length;
    const statusTone = { AVAILABLE: 'bg-[#ECFDF5] text-[#065F46]', 'ON STAFF': 'bg-[#ECFDF5] text-[#065F46]', UNAVAILABLE: 'bg-tertiary-fixed text-tertiary', 'NOT OFFERED': 'bg-tertiary-fixed text-tertiary', 'NOT ON STAFF': 'bg-tertiary-fixed text-tertiary', 'NOT TRACKED': 'bg-surface-container text-on-surface-variant' };
    const [st, stCls] = caseStatus(i);
    const w = i.workflow || {};
    el.innerHTML = `
<div class="flex flex-col md:flex-row md:items-center justify-between gap-space-md">
  <div class="flex flex-col gap-space-sm">
    <a class="inline-flex items-center gap-space-xs px-space-md py-space-xs rounded-lg bg-surface-container-low font-label-md text-label-md w-fit" href="#requests"><span class="material-symbols-outlined text-[16px]">arrow_back</span>Back to Emergency Requests</a>
    <div class="flex items-center gap-space-sm flex-wrap"><h1 class="font-headline-lg text-headline-lg text-on-surface">Emergency Request Details</h1><span class="px-space-sm py-0.5 rounded bg-surface-container font-telemetry-md text-telemetry-md">#${esc(r.request_id)}</span></div>
    <span class="inline-flex w-fit items-center gap-space-xs px-space-sm py-0.5 rounded-full ${isPending ? 'bg-tertiary-fixed text-tertiary' : stCls} font-telemetry-sm text-telemetry-sm font-semibold uppercase"><span class="w-2 h-2 rounded-full ${isPending ? 'bg-tertiary animate-pulse' : 'bg-current'}"></span>${isPending ? 'Awaiting hospital response' : esc(st)}</span>
  </div>
  ${isPending ? `<div class="flex flex-col items-end"><span class="font-telemetry-lg text-[30px] text-tertiary" data-countdown="${esc(i.reservations[0].expires_at)}">--:--</span><span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">before the hold expires</span></div>` : ''}
</div>

<div class="grid grid-cols-1 lg:grid-cols-3 gap-space-lg">
  <div class="lg:col-span-2 bg-surface-container-lowest rounded-xl shadow-sm p-space-lg flex flex-col gap-space-md">
    <div class="flex items-center gap-space-md flex-wrap">
      <div class="w-12 h-12 rounded-lg flex items-center justify-center" style="background:${pbg}"><span class="material-symbols-outlined" style="color:${pc}">e911_emergency</span></div>
      <h2 class="font-headline-lg text-headline-lg text-on-surface">${esc(condition(r))} (${code})</h2>
      <span class="px-space-sm py-0.5 rounded font-telemetry-sm text-telemetry-sm font-semibold text-white" style="background:${pc}">PRIORITY ${['Critical', 'High', 'Moderate', 'Low'].indexOf(r.severity) + 1}</span>
    </div>
    <span class="inline-flex w-fit items-center gap-space-xs px-space-sm py-0.5 rounded bg-surface-container-low font-telemetry-sm text-telemetry-sm"><span class="material-symbols-outlined text-[14px] text-tertiary">schedule</span>Triage request received: <b class="text-tertiary">${ago(i.reservations[0].requested_at)}</b></span>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-space-md">
      <div class="rounded-lg bg-surface-container-low p-space-md"><div class="font-telemetry-sm text-telemetry-sm text-on-surface-variant uppercase">Ambulance Unit</div><div class="font-headline-sm text-headline-sm flex items-center gap-1"><span class="material-symbols-outlined text-primary text-[18px]">airport_shuttle</span>Unit ${unit(r.ambulance_id)}</div><div class="font-body-sm text-body-sm text-on-surface-variant">Paramedic crew · age ${r.patient_age} patient</div></div>
      <div class="rounded-lg bg-surface-container-low p-space-md"><div class="font-telemetry-sm text-telemetry-sm text-on-surface-variant uppercase">Estimated Arrival</div>${i.arrival_eta ? `<div class="font-display-lg text-[30px] text-tertiary" data-eta="${esc(i.arrival_eta)}">…</div>` : `<div class="font-display-lg text-[30px] text-tertiary">${i.eta_min} <span class="font-label-md">MIN</span></div>`}<div class="font-body-sm text-body-sm text-on-surface-variant">${i.distance_km} km by road</div></div>
      <div class="rounded-lg bg-surface-container-low p-space-md"><div class="font-telemetry-sm text-telemetry-sm text-on-surface-variant uppercase">Telemetry Status</div>
        ${v.has ? `<div class="font-headline-sm text-headline-sm flex items-center gap-1"><span class="material-symbols-outlined text-primary text-[18px]">ecg</span>${v.bp ? `BP ${esc(v.bp)}` : ''}${v.hr ? ` • HR ${v.hr}` : ''}</div><div class="font-body-sm text-body-sm ${v.unstable ? 'text-tertiary' : 'text-[#065F46]'}">${v.unstable ? 'Unstable hemodynamics' : 'Stable'}${v.spo2 ? ` · SpO₂ ${v.spo2}%` : ''}</div>`
          : '<div class="font-body-md text-body-md text-on-surface-variant">No vitals transmitted</div>'}</div>
    </div>
    <div class="rounded-lg bg-surface-container-low p-space-md flex flex-col gap-space-xs">
      <span class="font-telemetry-sm text-telemetry-sm text-primary uppercase flex items-center gap-1"><span class="material-symbols-outlined text-[16px]">description</span>Field paramedic dispatch log</span>
      <p class="font-body-md text-body-md text-on-surface">${v.notes ? `“${esc(v.notes)}”` : `${esc(r.severity)} ${esc(r.emergency_type)}, patient age ${r.patient_age}. Needs ${esc([...depts(r), ...equips(r)].join(', ') || 'a general bed')}${r.required_specialist ? `; ${esc(r.required_specialist)} requested` : ''}. ${r.beds_required > 1 ? `${r.beds_required} beds required.` : ''}`}</p>
    </div>
  </div>
  <div class="bg-surface-container-lowest rounded-xl shadow-sm p-space-lg flex flex-col gap-space-md">
    <div class="flex items-center justify-between"><span class="font-headline-sm text-headline-sm flex items-center gap-1"><span class="material-symbols-outlined text-primary text-[18px]">route</span>Live Green Corridor</span><span class="px-space-sm py-0.5 rounded bg-surface-container text-primary font-telemetry-sm text-telemetry-sm">GPS ${w.departure_time && !w.arrival_time ? 'ACTIVE' : 'STANDBY'}</span></div>
    ${corridorSVG(i)}
    <a class="py-space-sm rounded-lg bg-surface-container-low hover:bg-surface-container font-label-md text-label-md flex items-center justify-center gap-space-xs" href="#live/${encodeURIComponent(r.request_id)}"><span class="material-symbols-outlined text-[16px] text-primary">near_me</span>Open live route map</a>
    <div class="grid grid-cols-2 gap-space-sm font-telemetry-sm text-telemetry-sm"><span class="text-on-surface-variant">Pickup</span><span class="text-right">${r.location.lat.toFixed(3)}, ${r.location.lng.toFixed(3)}</span>
      <span class="text-on-surface-variant">Bed hold</span><span class="text-right">${esc(i.reservations.map(x => `${x.quantity}× ${x.resource_type}`).join(' + '))}</span></div>
  </div>
</div>

<div class="bg-surface-container-lowest rounded-xl shadow-sm p-space-lg flex flex-col gap-space-md">
  <div class="flex items-center justify-between"><div class="flex flex-col"><span class="font-telemetry-sm text-telemetry-sm text-primary uppercase flex items-center gap-1"><span class="material-symbols-outlined text-[16px]">fact_check</span>Capacity validation engine</span><h2 class="font-headline-lg text-headline-lg">Resource Availability Check</h2></div>
    <span class="px-space-sm py-0.5 rounded font-telemetry-sm text-telemetry-sm ${conflicts ? 'bg-tertiary-fixed text-tertiary' : 'bg-[#ECFDF5] text-[#065F46]'}">${conflicts ? `${conflicts} conflict${conflicts > 1 ? 's' : ''}` : 'All requirements met'}</span></div>
  <div class="rounded-lg overflow-hidden border border-surface-container-low">
    <div class="hidden md:grid grid-cols-12 gap-space-md px-space-lg py-space-sm bg-surface-container-low font-label-md text-label-md text-on-surface-variant uppercase"><span class="col-span-4">Required by dispatch (#${esc(r.request_id)})</span><span class="col-span-2">Status</span><span class="col-span-4">${esc(session.user.name.split(' ')[0])} real-time availability</span><span class="col-span-2 text-right">Lock</span></div>
    ${rows.map(([name, icon, stt, detail, lock]) => `<div class="grid grid-cols-2 md:grid-cols-12 gap-space-sm md:gap-space-md px-space-lg py-space-md items-center border-t border-surface-container-low">
      <span class="md:col-span-4 flex items-center gap-space-sm font-label-lg text-label-lg"><span class="w-8 h-8 rounded bg-surface-container-low flex items-center justify-center"><span class="material-symbols-outlined text-[18px] text-primary">${icon}</span></span>${esc(name)}</span>
      <span class="md:col-span-2"><span class="px-space-sm py-0.5 rounded font-telemetry-sm text-telemetry-sm ${statusTone[stt] || ''}">${stt}</span></span>
      <span class="md:col-span-4 font-body-md text-body-md">${esc(detail)}</span>
      <span class="md:col-span-2 md:text-right"><span class="px-space-sm py-0.5 rounded font-telemetry-sm text-telemetry-sm ${lock === 'HELD' ? 'bg-primary text-on-primary' : lock === 'LOCK READY' || lock === 'LOCKS ON ACCEPT' ? 'bg-secondary-container/40 text-primary' : 'bg-surface-container text-on-surface-variant'}">${lock}</span></span></div>`).join('')}
  </div>
</div>

<div class="bg-surface-container-lowest rounded-xl shadow-sm p-space-lg flex flex-col md:flex-row md:items-center justify-between gap-space-md">
  <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">${isPending ? 'Key command: Press <b>[Enter]</b> to accept or <b>[Esc]</b> to go back.' : 'This patient is confirmed. Track arrival in Active Cases / Handover.'}</span>
  <div class="flex gap-space-md">
    ${isPending ? `<button class="px-space-lg py-space-md rounded-lg bg-surface-container-low hover:bg-surface-container font-label-lg text-label-lg flex items-center gap-space-xs" data-reject="${esc(i.reservation_id)}" type="button"><span class="material-symbols-outlined text-[18px]">block</span>Reject Request</button>
      <button class="px-space-xl py-space-md rounded-lg bg-tertiary hover:bg-tertiary-container text-on-tertiary font-headline-sm text-headline-sm flex items-center gap-space-sm" data-accept="${esc(i.reservation_id)}" type="button">Accept &amp; Reserve Resources<span class="material-symbols-outlined">arrow_forward</span></button>`
    : w.arrival_time ? `<a class="px-space-xl py-space-md rounded-lg bg-primary text-on-primary font-label-lg text-label-lg" href="#handover/${encodeURIComponent(r.request_id)}">Open Handover</a>`
    : `<button class="px-space-xl py-space-md rounded-lg bg-primary text-on-primary font-label-lg text-label-lg" data-arrive="${esc(r.request_id)}" type="button">Mark ambulance arrived</button>`}
  </div>
</div>`;
  }

  // ───────────── RESOURCES (h3) ─────────────
  const CAP = [['icu', 'ICU Beds', 'Critical care', 'monitor_heart', 'ICU'], ['ventilator', 'Mechanical Ventilators', 'Invasive respiratory support', 'air', 'Ventilator'],
               ['oxygen_bed', 'Oxygen Beds', 'High-flow O₂ therapy', 'pulmonology', 'Oxygen Bed'], ['general_bed', 'General Beds', 'Ward admission', 'bed', 'General Bed']];
  function renderResources() {
    const h = state.hospital; if (!h) return;
    $('res-updated').textContent = `Updated ${ago(h.freshness.last_updated)} · ${h.freshness.status.toUpperCase()}`;
    const heldBy = {};
    confirmed().forEach(i => i.reservations.forEach(x => { heldBy[x.resource_type] = (heldBy[x.resource_type] || 0) + x.quantity; }));
    $('res-capacity').innerHTML = CAP.map(([k, name, sub, icon, label]) => {
      const res = h.resources[k]; const val = state.draftCaps?.[k] ?? res.available;
      const changed = state.draftCaps?.[k] !== undefined && state.draftCaps[k] !== res.available;
      const tone = res.total === 0 ? 'bg-surface-container text-on-surface-variant' : val === 0 ? 'bg-tertiary-fixed text-tertiary' : val / res.total < 0.15 ? 'bg-[#FFFBEB] text-[#92400E]' : 'bg-[#ECFDF5] text-[#065F46]';
      const tlabel = res.total === 0 ? 'Not equipped' : val === 0 ? 'At capacity' : val / res.total < 0.15 ? 'Limited' : 'Available';
      return `<div class="bg-surface-container-lowest rounded-xl shadow-sm p-space-lg flex flex-col gap-space-md">
        <div class="flex items-start justify-between gap-space-sm"><div class="flex flex-col"><span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant uppercase">${sub}</span><span class="font-headline-sm text-headline-sm">${name}</span></div><span class="material-symbols-outlined text-primary">${icon}</span></div>
        <span class="w-fit px-space-sm py-0.5 rounded-full font-telemetry-sm text-telemetry-sm ${tone}">● ${tlabel}</span>
        <div class="rounded-lg bg-surface-container-low p-space-sm flex flex-col gap-space-xs"><span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">Available units</span>
          <div class="flex items-center justify-between"><button class="w-9 h-9 rounded bg-surface-container-lowest border border-outline-variant font-headline-sm disabled:opacity-40" data-step="${k}" data-d="-1" type="button" ${val <= 0 ? 'disabled' : ''} aria-label="One fewer">−</button>
          <span class="font-display-lg text-[30px] ${changed ? 'text-[#D97706]' : ''}">${val}</span>
          <button class="w-9 h-9 rounded bg-surface-container-lowest border border-outline-variant font-headline-sm disabled:opacity-40" data-step="${k}" data-d="1" type="button" ${val >= res.total ? 'disabled' : ''} aria-label="One more">+</button></div></div>
        <div class="flex justify-between font-telemetry-sm text-telemetry-sm"><span class="text-on-surface-variant">of ${res.total} total</span><span>Reserved: <b class="${heldBy[label] ? 'text-tertiary' : ''}">${heldBy[label] || 0}</b></span></div>
      </div>`;
    }).join('');
    $('res-publish').disabled = !state.draftCaps || !CAP.some(([k]) => state.draftCaps[k] !== undefined && state.draftCaps[k] !== h.resources[k].available);

    const DEPTS = [['trauma_care', 'Trauma & Emergency', 'LVL-1 adult resus', 'emergency'], ['cardiology', 'Cardiology', 'STEMI code ready', 'cardiology'],
                   ['operation_theatre', 'Operation Theatre', 'Emergency suites', 'medical_services'], ['neurology', 'Neurology', 'Acute stroke / TBI', 'neurology'],
                   ['blood_bank', 'Blood Bank', 'O-neg / FFP reserve', 'bloodtype'], ['dialysis', 'Dialysis', 'Acute renal / CRRT', 'nephrology'], ['burn_unit', 'Burns Unit', 'Specialized isolation', 'local_fire_department']];
    const offered = DEPTS.filter(d => h.services[d[0]]).length;
    $('dept-legend').innerHTML = `<span class="text-primary">● Available (${offered})</span> · <span>● Not offered (${DEPTS.length - offered})</span>`;
    $('res-depts').innerHTML = DEPTS.map(([k, name, sub, icon]) => {
      const on = h.services[k];
      return `<div class="bg-surface-container-lowest rounded-xl shadow-sm p-space-lg flex flex-col gap-space-sm ${on ? '' : 'opacity-70'}">
        <div class="flex items-start justify-between gap-space-sm"><div class="flex items-center gap-space-sm"><span class="w-10 h-10 rounded-lg bg-surface-container-low flex items-center justify-center"><span class="material-symbols-outlined text-primary">${icon}</span></span>
          <div class="flex flex-col"><span class="font-headline-sm text-headline-sm">${name}</span><span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant uppercase">${sub}</span></div></div>
          <span class="px-space-sm py-0.5 rounded-full font-telemetry-sm text-telemetry-sm ${on ? 'bg-[#ECFDF5] text-[#065F46]' : 'bg-tertiary-fixed text-tertiary'}">● ${on ? 'Available' : 'Not offered'}</span></div>
      </div>`;
    }).join('') + `<div class="bg-surface-container-lowest rounded-xl shadow-sm p-space-lg flex flex-col gap-space-sm md:col-span-2">
        <span class="font-headline-sm text-headline-sm flex items-center gap-space-xs"><span class="material-symbols-outlined text-primary">stethoscope</span>Specialists on call</span>
        <div class="flex flex-wrap gap-space-xs">${h.specialists.map(s => chip(s, 'bg-surface-container text-primary')).join('') || '<span class="font-body-sm text-body-sm text-on-surface-variant">None listed</span>'}</div></div>`;
    $('res-footer').innerHTML = `Last update ${fmt.timeIST(h.freshness.last_updated)} by <b>${esc(h.update_source)}</b> · version v${h.version}`;
    const stale = h.freshness.status === 'stale';
    $('res-conflicts').textContent = stale ? 'Data is STALE: tap Quick Sync to re-confirm' : 'No protocol conflicts';
    $('res-conflicts').parentElement.className = `font-telemetry-sm text-telemetry-sm ${stale ? 'text-tertiary' : 'text-primary'} flex items-center gap-space-xs`;
  }
  $('res-capacity').addEventListener('click', (e) => {
    const b = e.target.closest('[data-step]'); if (!b || !state.hospital) return;
    const k = b.dataset.step; state.draftCaps = state.draftCaps || {};
    const cur = state.draftCaps[k] ?? state.hospital.resources[k].available;
    state.draftCaps[k] = Math.max(0, Math.min(state.hospital.resources[k].total, cur + Number(b.dataset.d)));
    $('res-error').classList.add('hidden'); renderResources();
  });
  $('res-publish').addEventListener('click', async () => {
    const h = state.hospital; const changes = {};
    CAP.forEach(([k]) => { if (state.draftCaps?.[k] !== undefined && state.draftCaps[k] !== h.resources[k].available) changes[k] = state.draftCaps[k]; });
    try {
      const res = await api(`/api/hospitals/${encodeURIComponent(HID)}/resources`, { method: 'PATCH', body: { ...changes, version: h.version, source: 'Hospital Staff' } });
      state.hospital = res.hospital; state.draftCaps = null;
      toast('Capacity published', 'Every ambulance now sees the new numbers.', 'success');
    } catch (err) {
      if (err.status === 409) {
        state.hospital = err.body.current || h; state.draftCaps = null;
        $('res-error').textContent = 'Numbers changed while you were editing (a bed hold or another staff member). Showing the latest. Re-apply your change.';
        $('res-error').classList.remove('hidden');
      } else toast('Could not publish', esc(err.message), 'critical');
    }
    renderResources();
  });
  async function quickSync() {
    try {
      const res = await api(`/api/hospitals/${encodeURIComponent(HID)}/confirm`, { method: 'POST', body: { source: 'Hospital Staff' } });
      state.hospital = res.hospital; renderResources();
      toast('All numbers re-confirmed', 'Your data is marked fresh for the ranking engine.', 'success');
    } catch (err) { toast('Could not sync', esc(err.message), 'critical'); }
  }
  $('res-sync').addEventListener('click', quickSync);

  // ───────────── ACTIVE CASES ─────────────
  function renderActive() { $('active-table').innerHTML = casesTable(confirmed()); }

  // ───────────── HANDOVER (h4) ─────────────
  const CHECKLIST = [
    ['debrief', 'Paramedic verbal debrief received', 'Mechanism of injury / history handed over'],
    ['vitals', 'Primary vitals & telemetry transferred', 'Latest BP, HR and SpO₂ captured to the record'],
    ['airway', 'Airway & breathing verified', 'Airway patent, oxygenation adequate'],
    ['lines', 'IV lines & medications verified', 'Access, fluids and drugs given en route reviewed'],
  ];
  function renderHandover() {
    const bay = atBay(), inbound = enRoute();
    const completedToday = state.history.filter(x => x.handover_status === 'COMPLETED' && x.handover_time && (Date.now() - new Date(x.handover_time)) < 24 * 3600e3).length;
    const sel = bay.find(i => i.request.request_id === state.param) || bay[0];
    const el = $('view-handover');
    const tabs = `<div class="flex items-center gap-space-sm flex-wrap">
      <span class="px-space-md py-space-xs rounded-full border border-outline-variant bg-surface-container-lowest font-label-md text-label-md">▲ Active Inbound <b>${inbound.length}</b></span>
      <span class="px-space-md py-space-xs rounded-full border border-[#F87171] bg-surface-container-lowest font-label-md text-label-md text-tertiary">● Ready for Handover <b>${bay.length}</b></span>
      <span class="px-space-md py-space-xs rounded-full border border-outline-variant bg-surface-container-lowest font-label-md text-label-md">✓ Completed Today <b>${completedToday}</b></span></div>`;

    let main;
    if (!sel) {
      main = empty('No ambulance at the bay. When an ambulance arrives, mark it arrived from the queue on the right or from Active Cases.', 'local_shipping');
    } else {
      const r = sel.request, v = vitals(r), w = sel.workflow;
      const checked = state.checklists[r.request_id] || new Set();
      const allChecked = CHECKLIST.every(([k]) => checked.has(k));
      const standby = [...sel.reservations.map(x => [`${x.quantity}× ${x.resource_type}`, 'Reserved']), ...depts(r).filter(d => !d.startsWith('ICU')).map(d => [d, 'Alerted']),
                       ...(r.required_specialist ? [[r.required_specialist, 'Paged']] : []), ...(r.additional_needs || []).map(n => [n, 'Check'])];
      const vbox = (label, val, sub, bad) => `<div class="rounded-lg bg-surface-container-lowest p-space-sm"><div class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">${label}</div><div class="font-telemetry-lg text-telemetry-lg ${bad ? 'text-tertiary' : ''}">${val ?? '—'}</div><div class="font-telemetry-sm text-telemetry-sm ${bad ? 'text-tertiary' : 'text-on-surface-variant'}">${sub}</div></div>`;
      main = `
<div class="rounded-xl bg-tertiary-fixed px-space-lg py-space-md flex items-center justify-between gap-space-md">
  <span class="flex items-center gap-space-sm font-headline-sm text-headline-sm text-tertiary"><span class="w-9 h-9 rounded-full bg-tertiary text-on-tertiary flex items-center justify-center ring-pulse"><span class="material-symbols-outlined text-[20px]">local_shipping</span></span>Bay Dock: Ambulance ${unit(r.ambulance_id)} arrived <span class="px-space-sm py-0.5 rounded bg-tertiary text-on-tertiary font-telemetry-sm text-telemetry-sm">+${Math.max(0, Math.round((Date.now() - new Date(w.arrival_time)) / 60000))}m</span></span>
  <span class="hidden md:inline font-telemetry-sm text-telemetry-sm text-tertiary">Station: TRAUMA-RESUS</span>
</div>
<div class="bg-surface-container-lowest rounded-xl shadow-sm p-space-lg flex flex-col gap-space-lg">
  <div class="flex items-center justify-between flex-wrap gap-space-sm"><h2 class="font-headline-lg text-headline-lg flex items-center gap-space-sm"><span class="w-3 h-3 rounded-full bg-tertiary animate-pulse"></span>Ambulance Arrived • Ready for Handover</h2>${priorityChip(r)}</div>
  <div class="grid grid-cols-1 md:grid-cols-3 gap-space-md">
    <div class="rounded-lg bg-surface-container-low p-space-md"><div class="font-telemetry-sm text-telemetry-sm text-on-surface-variant uppercase">Emergency ID</div><div class="font-telemetry-lg text-telemetry-lg">#${esc(r.request_id)}</div><div class="font-body-sm text-body-sm text-tertiary">${esc(condition(r))} · age ${r.patient_age}</div></div>
    <div class="rounded-lg bg-surface-container-low p-space-md"><div class="font-telemetry-sm text-telemetry-sm text-on-surface-variant uppercase">Assigned Transport</div><div class="font-headline-sm text-headline-sm flex items-center gap-1"><span class="material-symbols-outlined text-primary text-[18px]">airport_shuttle</span>Ambulance ${unit(r.ambulance_id)}</div><div class="font-body-sm text-body-sm text-on-surface-variant">Paramedic crew</div></div>
    <div class="rounded-lg bg-surface-container-low p-space-md"><div class="font-telemetry-sm text-telemetry-sm text-on-surface-variant uppercase">Dock Timestamp</div><div class="font-telemetry-lg text-telemetry-lg">${fmt.timeIST(w.arrival_time)}</div><div class="font-body-sm text-body-sm text-on-surface-variant">Docked ${ago(w.arrival_time)}</div></div>
  </div>
  <div class="rounded-lg bg-surface-container-low p-space-md flex flex-col gap-space-sm">
    <span class="font-label-lg text-label-lg flex items-center gap-1"><span class="material-symbols-outlined text-tertiary text-[18px]">monitor_heart</span>Transit Vitals at Handoff</span>
    ${v.has ? `<div class="grid grid-cols-2 md:grid-cols-4 gap-space-sm">
      ${vbox('Blood Pressure', v.bp, v.sbp !== null && v.sbp < 90 ? 'Hypotensive' : 'mmHg', v.sbp !== null && v.sbp < 90)}
      ${vbox('Oxygen SpO₂', v.spo2 ? `${v.spo2}%` : null, v.spo2 && v.spo2 < 94 ? 'Borderline hypoxia' : 'on O₂', v.spo2 && v.spo2 < 94)}
      ${vbox('Heart Rate', v.hr ? `${v.hr} BPM` : null, v.hr > 120 ? 'Sinus tachycardia' : 'Normal range', v.hr > 120)}
      ${vbox('Crew Note', '📝', v.notes ? esc(v.notes.slice(0, 40)) + (v.notes.length > 40 ? '…' : '') : 'None', false)}</div>`
      : '<span class="font-body-sm text-body-sm text-on-surface-variant">No vitals were transmitted from the field. Capture on arrival.</span>'}
  </div>
  <div class="grid grid-cols-1 md:grid-cols-2 gap-space-md">
    <div class="rounded-lg border border-surface-container-high p-space-md flex flex-col gap-space-sm">
      <div class="flex justify-between"><span class="font-label-lg text-label-lg">Reserved Resources on Standby</span><span class="font-telemetry-sm text-telemetry-sm text-primary">${standby.length}/${standby.length} READY</span></div>
      ${standby.map(([n, t]) => `<div class="flex items-center justify-between gap-space-sm"><span class="flex items-center gap-space-xs font-body-md text-body-md"><span class="material-symbols-outlined text-[18px] text-primary">check_circle</span>${esc(n)}</span><span class="px-space-sm py-0.5 rounded ${t === 'Check' ? 'bg-surface-container text-on-surface-variant' : 'bg-secondary-container/40 text-primary'} font-telemetry-sm text-telemetry-sm">${t}</span></div>`).join('')}
    </div>
    <div class="rounded-lg border border-surface-container-high p-space-md flex flex-col gap-space-sm">
      <div class="flex justify-between"><span class="font-label-lg text-label-lg">Clinical Handover Checklist</span><span class="font-telemetry-sm text-telemetry-sm ${allChecked ? 'text-primary' : 'text-tertiary'}">${checked.size}/${CHECKLIST.length} VERIFIED</span></div>
      ${CHECKLIST.map(([k, t, d]) => `<label class="flex items-start gap-space-sm cursor-pointer"><input type="checkbox" class="mt-1 w-4 h-4 accent-[#006765]" data-check="${k}" data-req="${esc(r.request_id)}" ${checked.has(k) ? 'checked' : ''}>
        <span class="flex flex-col"><span class="font-label-lg text-label-lg">${t}</span><span class="font-body-sm text-body-sm text-on-surface-variant">${d}</span></span></label>`).join('')}
    </div>
  </div>
  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-space-md pt-space-sm border-t border-surface-container-low">
    <button class="px-space-lg py-space-sm rounded-lg bg-surface-container-low hover:bg-surface-container font-label-lg text-label-lg flex items-center gap-space-xs w-fit" onclick="window.print()" type="button"><span class="material-symbols-outlined text-[18px]">print</span>Print Triage Packet</button>
    <button class="px-space-xl py-space-md rounded-lg bg-tertiary hover:bg-tertiary-container text-on-tertiary font-headline-sm text-headline-sm flex items-center justify-center gap-space-sm disabled:opacity-40 disabled:cursor-not-allowed" data-complete="${esc(r.request_id)}" type="button" ${allChecked ? '' : 'disabled'} title="${allChecked ? '' : 'Tick all 4 checklist items first'}">Complete Handover &amp; Admit<span class="material-symbols-outlined">arrow_forward</span></button>
  </div>
</div>`;
    }

    const h = state.hospital;
    const queue = inbound.length ? inbound.map(i => {
      const r = i.request; const w = i.workflow || {};
      const prog = w.departure_time ? Math.min(100, ((Date.now() - new Date(w.departure_time)) / (i.eta_min * 60000)) * 100) : 4;
      return `<div class="bg-surface-container-lowest rounded-xl shadow-sm p-space-md flex flex-col gap-space-sm">
        <div class="flex items-center justify-between"><span class="font-telemetry-md text-telemetry-md">#${esc(r.request_id)}</span><span class="px-space-sm py-0.5 rounded bg-tertiary-fixed text-tertiary font-telemetry-sm text-telemetry-sm">● ${esc(condition(r))}</span></div>
        <div class="flex items-center justify-between rounded-lg bg-surface-container-low p-space-sm">
          <span class="flex items-center gap-space-xs"><span class="w-9 h-9 rounded bg-primary text-on-primary flex items-center justify-center"><span class="material-symbols-outlined text-[18px]">airport_shuttle</span></span><span class="flex flex-col"><span class="font-label-lg text-label-lg">Ambulance ${unit(r.ambulance_id)}</span><span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">${w.departure_time ? 'En route · telemetry linked' : 'Preparing to depart'}</span></span></span>
          <span class="flex flex-col items-end">${i.arrival_eta ? `<span class="font-telemetry-lg text-telemetry-lg text-primary" data-eta-clock="${esc(i.arrival_eta)}">--:--</span>` : `<span class="font-telemetry-lg text-telemetry-lg text-primary">~${i.eta_min}m</span>`}<span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">ETA</span></span>
        </div>
        <div class="h-1.5 rounded-full bg-surface-container-low overflow-hidden"><div class="h-full bg-primary" style="width:${prog.toFixed(0)}%"></div></div>
        <div class="flex flex-wrap gap-space-xs">${i.reservations.map(x => chip(`${x.resource_type} ×${x.quantity}`, 'bg-surface-container text-primary')).join('')}</div>
        <div class="grid grid-cols-2 gap-space-xs"><a class="py-space-sm rounded-lg bg-surface-container-low hover:bg-surface-container font-label-md text-label-md flex items-center justify-center gap-space-xs" href="#live/${encodeURIComponent(r.request_id)}"><span class="material-symbols-outlined text-[16px]">near_me</span>Track live</a>
        <button class="py-space-sm rounded-lg bg-surface-container-low hover:bg-surface-container font-label-md text-label-md flex items-center justify-center gap-space-xs" data-arrive="${esc(r.request_id)}" type="button"><span class="material-symbols-outlined text-[16px]">where_to_vote</span>Mark arrived</button></div>
      </div>`;
    }).join('') : `<div class="bg-surface-container-lowest rounded-xl shadow-sm p-space-md font-body-sm text-body-sm text-on-surface-variant">No ambulances en route.</div>`;

    el.innerHTML = `
<div class="flex flex-col md:flex-row md:items-end justify-between gap-space-md">
  <div class="flex flex-col gap-space-xs"><span class="px-space-sm py-0.5 rounded bg-tertiary text-on-tertiary font-telemetry-sm text-telemetry-sm w-fit">TRIAGE STAGE 4</span><h1 class="font-display-lg text-display-lg">Active Emergency Cases &amp; Handover</h1></div>
  ${tabs}
</div>
${bay.length > 1 ? `<div class="flex gap-space-xs flex-wrap">${bay.map(i => `<a class="px-space-md py-space-xs rounded-full font-label-md text-label-md ${i === sel ? 'bg-primary text-on-primary' : 'bg-surface-container-low'}" href="#handover/${encodeURIComponent(i.request.request_id)}">#${esc(i.request.request_id)}</a>`).join('')}</div>` : ''}
<div class="grid grid-cols-1 lg:grid-cols-3 gap-space-lg items-start">
  <div class="lg:col-span-2 flex flex-col gap-space-md">${main}</div>
  <div class="flex flex-col gap-space-md">
    <div class="flex items-center justify-between"><span class="font-headline-sm text-headline-sm flex items-center gap-1"><span class="material-symbols-outlined text-primary">sync_alt</span>Active En Route Queue</span><span class="px-space-sm py-0.5 rounded-full bg-secondary-container/40 text-primary font-telemetry-sm text-telemetry-sm">${inbound.length} in transit</span></div>
    ${queue}
    ${h ? `<div class="bg-surface-container-lowest rounded-xl shadow-sm p-space-md flex flex-col gap-space-sm">
      <span class="font-label-lg text-label-lg flex items-center gap-1"><span class="material-symbols-outlined text-primary text-[18px]">local_hospital</span>Intake Department Load</span>
      <div class="grid grid-cols-2 gap-space-sm">${CAP.map(([k, name]) => { const res = h.resources[k]; return `<div class="rounded-lg bg-surface-container-low p-space-sm"><div class="font-telemetry-sm text-telemetry-sm text-on-surface-variant uppercase">${name.replace('Mechanical ', '')}</div><div class="font-telemetry-md text-telemetry-md">${res.total - res.available} / ${res.total} used</div><div class="font-telemetry-sm text-telemetry-sm ${res.available ? 'text-primary' : 'text-tertiary'}">${res.available} available</div></div>`; }).join('')}</div>
    </div>` : ''}
  </div>
</div>`;
  }
  document.addEventListener('change', (e) => {
    const c = e.target.closest('[data-check]'); if (!c) return;
    const set = state.checklists[c.dataset.req] || (state.checklists[c.dataset.req] = new Set());
    c.checked ? set.add(c.dataset.check) : set.delete(c.dataset.check);
    renderHandover();
  });

  // ───────────── LIVE ROUTE (h5) ─────────────
  // Map of the ambulance moving from the pickup to the confirmed hospital, which hospitals were
  // contacted and how they answered, and a live log. Drawn in SVG from real coordinates, so it
  // works offline; a Google Maps / Leaflet layer can replace the dotted background later.
  const AREAS = [['Shivajinagar', 18.5308, 73.8475], ['Kothrud', 18.5074, 73.8077], ['Aundh', 18.5590, 73.8078], ['Hinjewadi', 18.5912, 73.7389],
    ['Wakad', 18.5975, 73.7700], ['Pimpri', 18.6298, 73.7997], ['Viman Nagar', 18.5679, 73.9143], ['Kharadi', 18.5515, 73.9348], ['Hadapsar', 18.5089, 73.9260],
    ['Katraj', 18.4575, 73.8677], ['Swargate', 18.5018, 73.8636], ['Chakan', 18.7606, 73.8636], ['Talegaon', 18.7353, 73.6755]].map(([name, lat, lng]) => ({ name, lat, lng }));
  const REQ_CHIPS = [['icu', 'ICU', 'icu'], ['ventilator', 'Ventilator', 'ventilator'], ['oxygen', 'O₂ Bed', 'oxygen_bed'], ['trauma_care', 'Trauma'], ['cardiology', 'Cardiac'],
    ['neurology', 'Neuro'], ['operation_theatre', 'OT'], ['blood_bank', 'Blood Bank'], ['dialysis', 'Dialysis']];
  const RES_KEY = { ICU: 'icu', Ventilator: 'ventilator', 'Oxygen Bed': 'oxygen_bed', 'General Bed': 'general_bed' };
  const COS_LAT = Math.cos((18.55 * Math.PI) / 180);
  const hav = (a, b) => {
    const r = (d) => (d * Math.PI) / 180, dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
    return 2 * 6371 * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2));
  };
  const hhmm = (iso) => fmt.timeIST(iso).replace(' IST', '');
  const shortName = (n = '') => n.replace(/\s+(Hospital|Medical|Multispeciality|Multi-speciality|Healthcare|Health|Institute).*$/i, '').slice(0, 22);
  state.live = { id: null, detail: null, rankings: [], view: null, log: {} };

  function defaultLiveId() {
    const c = confirmed();
    const moving = c.find(i => i.workflow?.departure_time && !i.workflow?.arrival_time);
    return (moving || c[0] || pending()[0])?.request.request_id
      || state.history.find(x => x.response === 'ACCEPTED' && x.request)?.request.request_id || null;
  }

  async function loadLive(id) {
    if (!state.allHospitals) {
      api('/api/hospitals').then(r => { state.allHospitals = Object.fromEntries(r.hospitals.map(h => [h.hospital_id, h])); if (state.view === 'live') renderLive(); }).catch(() => {});
    }
    if (!id) { state.live.id = null; state.live.detail = null; if (state.view === 'live') renderLive(); return; }
    try {
      const [detail, rk] = await Promise.all([
        api(`/api/requests/${encodeURIComponent(id)}`),
        api(`/api/requests/${encodeURIComponent(id)}/rankings`).catch(() => ({ rankings: [] })),
      ]);
      if (state.live.id !== id) { state.live.view = null; state.live.fitted = false; state.live.fix = null; }   // new case → re-fit the map
      api(`/api/requests/${encodeURIComponent(id)}/position`).then(r => { if (r.position && state.live.id === id) { state.live.fix = r.position; liveTick(); } }).catch(() => {});
      detail.reservations = (detail.reservations || []).map(x => ({ ...x, status: x.status || x.reservation_status }));
      Object.assign(state.live, { id, detail, rankings: rk.rankings || [], error: null });
    } catch (err) { Object.assign(state.live, { id, detail: null, error: err.message }); }
    if (state.view === 'live') renderLive();
  }

  const hospLoc = (hid) => state.allHospitals?.[hid]?.location || state.live.rankings.find(x => x.hospital_id === hid)?.location || (hid === HID ? state.hospital?.location : null);
  const hospName = (hid) => state.allHospitals?.[hid]?.name || state.live.rankings.find(x => x.hospital_id === hid)?.hospital_name || hid;

  // Everything the page needs about the current case, derived once per draw
  function liveModel() {
    const d = state.live.detail; if (!d) return null;
    const wfs = d.workflow || [];
    const acc = [...wfs].reverse().find(w => w.hospital_response === 'ACCEPTED');
    const pend = d.reservations.find(x => x.status === 'PENDING' && x.hospital_id === HID) || d.reservations.find(x => x.status === 'PENDING');
    const destId = acc?.hospital_id || pend?.hospital_id || wfs[wfs.length - 1]?.hospital_id || HID;
    const item = state.items.find(i => i.request.request_id === d.request_id && destId === HID);
    const rank = state.live.rankings.find(x => x.hospital_id === destId);
    const pickup = d.location, dest = hospLoc(destId);
    const km = item?.distance_km ?? rank?.distance_km ?? (dest ? Math.round((hav(pickup, dest) * 1.35 + 0.3) * 10) / 10 : null);
    const eta = item?.eta_min ?? (rank ? Math.round(rank.eta_min) : km ? Math.round((km / 28) * 60 + 2) : null);
    const w = acc || {};
    let prog = 0;
    if (w.arrival_time || w.handover_time) prog = 1;
    else if (w.departure_time && eta) prog = Math.min(0.97, Math.max(0.02, (Date.now() - new Date(w.departure_time)) / (eta * 60000)));
    const arriveAt = w.departure_time && eta ? new Date(new Date(w.departure_time).getTime() + eta * 60000) : null;
    const left = w.arrival_time ? 0 : arriveAt ? Math.max(0, Math.ceil((arriveAt - Date.now()) / 60000)) : eta;
    const phase = w.handover_time ? 'done' : w.arrival_time ? 'arrived' : w.departure_time ? 'enroute' : acc ? 'preparing' : pend ? 'waiting' : 'none';
    return { d, wfs, acc, pend, destId, destName: hospName(destId), pickup, dest, km, eta, prog, left, phase, w };
  }

  function phaseLabel(m) {
    const to = shortName(m.destName).toUpperCase();
    return { done: `HANDED OVER AT ${to}`, arrived: `ARRIVED AT ${to}`, enroute: `EN ROUTE TO ${to} (ETA ${m.left} MIN)`, preparing: `CREW PREPARING · ${to} CONFIRMED`,
      waiting: `AWAITING CONFIRMATION FROM ${to}`, none: 'AWAITING HOSPITAL ASSIGNMENT' }[m.phase];
  }

  function renderLive() {
    const el = $('view-live');
    const cases = [...confirmed(), ...pending()];
    const switcher = cases.length > 1 || (state.live.id && !cases.some(i => i.request.request_id === state.live.id))
      ? `<div class="flex gap-space-xs flex-wrap">${cases.map(i => `<a class="px-space-md py-space-xs rounded-full font-label-md text-label-md ${i.request.request_id === state.live.id ? 'bg-primary text-on-primary' : 'bg-surface-container-low hover:bg-surface-container'}" href="#live/${encodeURIComponent(i.request.request_id)}">#${esc(i.request.request_id)} · ${esc(unit(i.request.ambulance_id))}</a>`).join('')}</div>` : '';
    if (!state.live.id) { el.innerHTML = `<h1 class="font-display-lg text-display-lg">Live Route</h1>${empty('No ambulance is heading to you right now. Accepted cases appear here with a live route map.', 'near_me_disabled')}`; return; }
    const m = liveModel();
    if (!m) { el.innerHTML = `<h1 class="font-display-lg text-display-lg">Live Route</h1>${empty(state.live.error ? `Could not load #${esc(state.live.id)}: ${esc(state.live.error)}` : 'Loading route…', 'near_me')}`; return; }
    const r = m.d;

    el.innerHTML = `
<div class="bg-surface-container-lowest rounded-xl shadow-sm px-space-lg py-space-md flex items-center gap-space-md flex-wrap">
  <button class="inline-flex items-center gap-space-xs px-space-md py-space-xs rounded-lg bg-surface-container-low hover:bg-surface-container font-label-md text-label-md" id="live-back" type="button"><span class="material-symbols-outlined text-[16px]">arrow_back</span>Back</button>
  <span class="inline-flex items-center gap-space-xs px-space-md py-space-xs rounded-lg bg-tertiary-fixed border border-[#F87171]/40 font-label-lg text-label-lg"><span class="text-tertiary font-semibold">✱ EMERGENCY #${esc(r.request_id)}</span><span class="text-on-surface">· ${esc(condition(r))}</span></span>
  ${priorityChip(r)}
  <span class="ml-auto font-telemetry-sm text-telemetry-sm text-on-surface-variant">Logged ${fmt.timeIST(r.created_at)} · Age ${r.patient_age}</span>
</div>
${switcher}
<div class="grid grid-cols-1 lg:grid-cols-3 gap-space-lg items-start">
  <div class="lg:col-span-2 flex flex-col gap-space-lg">
    <div class="relative z-0 rounded-xl border border-surface-container-high overflow-hidden map-dots map-grab select-none h-[440px] md:h-[500px]" id="live-map" aria-label="Live ambulance route map">
      <svg class="absolute inset-0 w-full h-full" id="live-svg"></svg>
      <div class="absolute inset-0 pointer-events-none" id="live-pins"></div>
      <div class="absolute top-space-lg left-space-lg flex flex-col bg-surface-container-lowest rounded-lg shadow-sm border border-surface-container-high overflow-hidden" id="live-ctrls">
        <button class="w-10 h-10 flex items-center justify-center hover:bg-surface-container-low font-headline-sm" data-map="in" type="button" aria-label="Zoom in">+</button>
        <button class="w-10 h-10 flex items-center justify-center hover:bg-surface-container-low border-t border-surface-container-low font-headline-sm" data-map="out" type="button" aria-label="Zoom out">−</button>
        <button class="w-10 h-10 flex items-center justify-center hover:bg-surface-container-low border-t border-surface-container-low text-primary" data-map="fit" type="button" aria-label="Re-center on route"><span class="material-symbols-outlined text-[20px]">my_location</span></button>
      </div>
      <div class="absolute top-space-lg right-space-lg z-[1000] hidden md:flex flex-col gap-1 bg-surface-container-lowest/90 rounded-lg border border-surface-container-high px-space-md py-space-sm font-telemetry-sm text-telemetry-sm">
        <span class="flex items-center gap-space-xs"><span class="w-2.5 h-2.5 rounded-full bg-tertiary"></span>Pickup</span>
        <span class="flex items-center gap-space-xs"><span class="w-2.5 h-2.5 rounded bg-primary"></span>Destination</span>
        <span class="flex items-center gap-space-xs"><span class="w-2.5 h-2.5 rounded-full bg-outline"></span>Other hospitals</span>
      </div>
      <div class="absolute bottom-space-lg left-space-lg right-space-lg z-[1000] flex pointer-events-none">
        <span class="inline-flex items-center gap-space-xs px-space-md py-space-xs rounded-lg bg-surface-container-lowest/95 border border-surface-container-high font-body-sm text-body-sm text-on-surface-variant max-w-full truncate"><span class="material-symbols-outlined text-[16px] text-primary">map</span><span id="live-caption"></span></span>
      </div>
    </div>
    <div class="bg-surface-container-lowest rounded-xl shadow-sm px-space-lg py-space-md flex flex-col gap-space-sm">
      <div class="flex items-center justify-between"><span class="font-label-lg text-label-lg flex items-center gap-space-xs uppercase"><span class="material-symbols-outlined text-[18px] text-primary">notifications</span>Live Updates</span>
        <span class="font-telemetry-sm text-telemetry-sm text-primary flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-primary animate-pulse"></span>Live</span></div>
      <div class="flex flex-col gap-1 font-telemetry-sm text-telemetry-sm max-h-56 overflow-y-auto" id="live-log">${liveLogHTML(m)}</div>
    </div>
  </div>
  <div class="bg-surface-container-lowest rounded-xl shadow-sm p-space-lg flex flex-col gap-space-md" id="live-panel">${livePanelHTML(m)}</div>
</div>`;
    $('live-back').addEventListener('click', () => { history.length > 1 ? history.back() : (location.hash = '#active'); });
    drawMap();
  }

  function reqChips(r, hid, reservedTypes = []) {
    const h = state.allHospitals?.[hid] || (hid === HID ? state.hospital : null);
    const chips = [];
    for (const t of reservedTypes) chips.push([`${t} Reserved ✓`, true]);
    for (const [k, label, resKey] of REQ_CHIPS) {
      if (!r.requirements[k]) continue;
      if (resKey && reservedTypes.some(t => RES_KEY[t] === resKey)) continue;
      const ok = !h ? null : resKey ? h.resources[resKey]?.available > 0 : !!h.services[k];
      chips.push([`${label}${ok === null ? '' : ok ? (reservedTypes.length ? ' Available ✓' : ' ✓') : ' ✗'}`, ok !== false]);
    }
    if (!chips.length) chips.push(['General Bed ✓', true]);
    return chips.map(([t, ok]) => `<span class="px-space-sm py-0.5 rounded font-telemetry-sm text-telemetry-sm ${ok ? 'bg-secondary-container/40 text-primary' : 'bg-tertiary-fixed text-tertiary'}">${esc(t)}</span>`).join('');
  }

  function livePanelHTML(m) {
    const r = m.d;
    // one card per contacted hospital (latest contact first), with its answer
    const contacted = [];
    const seen = new Set();
    for (const w of [...m.wfs].reverse()) {
      if (seen.has(w.hospital_id)) continue; seen.add(w.hospital_id);
      const res = m.d.reservations.filter(x => x.hospital_id === w.hospital_id);
      contacted.push({ w, res });
    }
    const n = { contacted: contacted.length, waiting: contacted.filter(c => c.w.hospital_response === 'PENDING').length, accepted: contacted.filter(c => c.w.hospital_response === 'ACCEPTED').length, declined: contacted.filter(c => c.w.hospital_response === 'REJECTED').length };

    const banner = m.acc ? `
<div class="rounded-lg border border-[#6EE7B7] bg-[#ECFDF5] p-space-md flex flex-col gap-space-sm">
  <span class="font-label-lg text-label-lg text-[#065F46] flex items-center gap-space-xs uppercase"><span class="material-symbols-outlined text-[20px]">check_circle</span>Hospital confirmed: ${esc(m.destName)}</span>
  <span class="font-label-lg text-label-lg text-on-surface flex items-center gap-space-xs uppercase"><span class="w-2 h-2 rounded-full ${m.phase === 'enroute' ? 'bg-primary animate-pulse' : 'bg-[#10B981]'}"></span>${{ preparing: 'Crew preparing to depart', enroute: 'Ambulance en route', arrived: 'Ambulance arrived · handover in progress', done: 'Patient handed over' }[m.phase]}</span>
  <div class="rounded bg-surface-container-lowest px-space-md py-space-sm flex items-center justify-between gap-space-sm">
    <span class="font-body-md text-body-md">Destination: <b>${esc(m.destName)}</b></span>
    <span class="px-space-sm py-0.5 rounded bg-secondary-container/40 text-primary font-telemetry-sm text-telemetry-sm" id="live-eta-chip">${m.phase === 'enroute' ? `ETA: ${m.left} min` : m.phase === 'preparing' ? `~${m.eta} min drive` : m.phase === 'done' ? 'Closed' : 'Docked'}</span>
  </div>
  ${m.destId === HID ? (m.phase === 'enroute' || m.phase === 'preparing' ? `<button class="py-space-sm rounded-lg bg-primary text-on-primary font-label-lg text-label-lg flex items-center justify-center gap-space-xs" data-arrive="${esc(r.request_id)}" type="button"><span class="material-symbols-outlined text-[18px]">where_to_vote</span>Mark arrived at bay</button>`
    : m.phase === 'arrived' ? `<a class="py-space-sm rounded-lg bg-tertiary text-on-tertiary font-label-lg text-label-lg flex items-center justify-center gap-space-xs" href="#handover/${encodeURIComponent(r.request_id)}"><span class="material-symbols-outlined text-[18px]">sync_alt</span>Open handover checklist</a>` : '') : ''}
</div>` : m.pend ? `
<div class="rounded-lg border border-[#FCD34D] bg-[#FFFBEB] p-space-md flex flex-col gap-space-sm">
  <span class="font-label-lg text-label-lg text-[#92400E] flex items-center gap-space-xs uppercase"><span class="material-symbols-outlined text-[20px]">hourglass_top</span>Awaiting confirmation: ${esc(hospName(m.pend.hospital_id))}</span>
  <span class="font-body-sm text-body-sm text-on-surface-variant">Beds are held for <b data-countdown="${esc(m.pend.expires_at)}">--:--</b>. The ambulance waits at the scene until a hospital accepts.</span>
  ${m.pend.hospital_id === HID ? `<a class="py-space-sm rounded-lg bg-tertiary text-on-tertiary font-label-lg text-label-lg flex items-center justify-center gap-space-xs" href="#requests/${encodeURIComponent(r.request_id)}">Review &amp; respond<span class="material-symbols-outlined text-[18px]">arrow_forward</span></a>` : ''}
</div>` : `<div class="rounded-lg bg-surface-container-low p-space-md font-body-md text-body-md text-on-surface-variant">No hospital has confirmed this case yet.</div>`;

    const statusChip = (w) => ({
      ACCEPTED: '<span class="px-space-sm py-0.5 rounded bg-[#10B981] text-white font-telemetry-sm text-telemetry-sm font-semibold">✓ REQUEST ACCEPTED</span>',
      PENDING: '<span class="px-space-sm py-0.5 rounded bg-tertiary-fixed text-tertiary font-telemetry-sm text-telemetry-sm">● Waiting for response</span>',
      REJECTED: `<span class="px-space-sm py-0.5 rounded bg-surface-container text-on-surface-variant font-telemetry-sm text-telemetry-sm">✕ Declined${w.rejection_reason ? ` · ${esc(w.rejection_reason)}` : ''}</span>`,
      WITHDRAWN: '<span class="px-space-sm py-0.5 rounded bg-surface-container-low text-on-surface-variant font-telemetry-sm text-telemetry-sm">Withdrawn</span>',
    }[w.hospital_response] || '');
    const cards = contacted.map(({ w, res }) => {
      const confirmedTypes = res.filter(x => x.status === 'CONFIRMED').map(x => x.resource_type);
      const last = res[0] && (res.map(x => x.confirmed_at || x.requested_at).sort().pop());
      const isAcc = w.hospital_response === 'ACCEPTED';
      return `<div class="rounded-lg border ${isAcc ? 'border-[#6EE7B7] bg-[#F0FDF9]' : 'border-surface-container-high'} p-space-md flex flex-col gap-space-sm">
        <div class="flex items-start justify-between gap-space-sm"><span class="font-label-lg text-label-lg">${esc(w.hospital_name || hospName(w.hospital_id))}${w.hospital_id === HID ? ' <span class="font-telemetry-sm text-telemetry-sm text-primary">(you)</span>' : ''}</span>${statusChip(w)}</div>
        <div class="flex flex-wrap gap-space-xs">${reqChips(r, w.hospital_id, isAcc ? [...new Set(confirmedTypes)] : [])}</div>
        <div class="flex items-center justify-between font-telemetry-sm text-telemetry-sm">
          <span class="${w.hospital_response === 'PENDING' ? 'text-tertiary' : 'text-on-surface-variant'}">${w.hospital_response === 'PENDING' ? '● Waiting for response' : isAcc ? 'Resources locked' : w.hospital_response === 'WITHDRAWN' ? (m.acc ? `Filled by ${esc(shortName(m.destName))}` : 'Cancelled by dispatcher') : 'Declined'}</span>
          <span class="text-on-surface-variant">Updated ${ago(last || w.assignment_time)}</span></div>
      </div>`;
    }).join('');

    const contactedIds = new Set(contacted.map(c => c.w.hospital_id));
    const backups = state.live.rankings.filter(x => x.eligible && !contactedIds.has(x.hospital_id)).slice(0, 3);
    const backupHTML = backups.length ? `
<div class="flex flex-col gap-space-sm pt-space-sm border-t border-surface-container-low">
  <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant uppercase">Backup options (ranking engine)</span>
  ${backups.map(b => `<div class="rounded-lg bg-surface-container-low px-space-md py-space-sm flex items-center justify-between gap-space-sm">
    <span class="flex flex-col min-w-0"><span class="font-label-md text-label-md truncate">${esc(b.hospital_name)}</span><span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">Rank #${b.rank} · ${b.distance_km} km · ~${Math.round(b.eta_min)} min</span></span>
    <span class="px-space-sm py-0.5 rounded bg-surface-container text-on-surface-variant font-telemetry-sm text-telemetry-sm shrink-0">Standby</span></div>`).join('')}
</div>` : '';

    return `
<h2 class="font-headline-md text-headline-md">Hospital Requests</h2>
<div class="rounded-lg bg-surface-container-low px-space-md py-space-sm flex items-center justify-between gap-space-sm font-telemetry-sm text-telemetry-sm">
  <span><b>${n.contacted}</b> Contacted</span><span class="text-outline-variant">·</span>
  <span class="text-tertiary"><b>${n.waiting}</b> Waiting</span><span class="text-outline-variant">·</span>
  ${n.declined ? `<span class="text-on-surface-variant"><b>${n.declined}</b> Declined</span><span class="text-outline-variant">·</span>` : ''}
  <span class="text-[#065F46]"><b>${n.accepted}</b> Accepted</span>
</div>
${banner}
${cards || '<div class="font-body-sm text-body-sm text-on-surface-variant">No hospital contacted yet.</div>'}
${backupHTML}`;
  }

  // Timeline from the stored timestamps + events seen live on this page
  function liveLogHTML(m) {
    const d = m.d, rows = [];
    rows.push([d.created_at, `Emergency logged · ${d.severity} ${d.emergency_type} · Ambulance ${unit(d.ambulance_id)} dispatched`, '']);
    // one line per alert wave (a broadcast sends to many hospitals at the same instant), then each answer
    const groups = {};
    for (const x of d.reservations) (groups[`${x.hospital_id}|${x.requested_at}`] ||= []).push(x);
    const waves = {};
    for (const g of Object.values(groups)) (waves[g[0].requested_at] ||= []).push(g);
    const filledAt = d.reservations.find(y => y.hospital_id === m.destId && y.confirmed_at)?.confirmed_at;
    for (const [at, gs] of Object.entries(waves)) {
      const names = gs.map(g => g[0].hospital_name || hospName(g[0].hospital_id));
      const need = gs[0].map(y => `${y.quantity}× ${y.resource_type}`).join(' + ');
      rows.push([at, gs.length > 1 ? `Alert broadcast to ${gs.length} hospitals (${need}): ${names.join(', ')}` : `Request sent to ${names[0]} (${need})`, '']);
      for (const g of gs) {
        const x = g[0], name = x.hospital_name || hospName(x.hospital_id);
        const w = m.wfs.find(y => y.hospital_id === x.hospital_id);
        if (x.confirmed_at) rows.push([x.confirmed_at, `${name} accepted first & locked resources`, 'ok']);
        else if (x.status === 'EXPIRED') rows.push([x.expires_at, `${name} did not respond in time`, 'bad']);
        else if (w?.hospital_response === 'WITHDRAWN') { if (!m.acc) rows.push([null, `Request to ${name} withdrawn by dispatcher`, '', at]); }
        else if (['RELEASED', 'CANCELLED', 'FAILED'].includes(x.status) && !(state.live.log[d.request_id] || []).some(e => e[1].startsWith(name))) {
          rows.push([null, x.status === 'FAILED' ? `${name} could not accept · last bed already gone` : `${name} declined${w?.rejection_reason ? ` (${w.rejection_reason})` : ''}`, 'bad', at]);
        }
      }
    }
    const stoodDown = m.wfs.filter(w => w.hospital_response === 'WITHDRAWN').length;
    if (m.acc && stoodDown) rows.push([filledAt, `${stoodDown} other hospital${stoodDown > 1 ? 's' : ''} stood down automatically`, '']);
    for (const e of state.live.log[d.request_id] || []) rows.push(e);
    const w = m.w;
    if (w.departure_time) rows.push([w.departure_time, `Route generated automatically · Ambulance ${unit(d.ambulance_id)} en route to ${m.destName}`, 'ok']);
    if (w.arrival_time) rows.push([w.arrival_time, `Ambulance docked at ${m.destName}`, 'ok']);
    if (w.handover_time) rows.push([w.handover_time, 'Clinical handover completed · patient admitted', 'ok']);
    rows.sort((a, b) => new Date(a[0] || a[3]) - new Date(b[0] || b[3]));
    const tone = { ok: 'text-[#047857]', bad: 'text-tertiary', '': 'text-on-surface' };
    return rows.map(([t, text, k], idx) => `<div class="flex gap-space-md ${idx === rows.length - 1 ? 'log-new' : ''}"><span class="text-on-surface-variant shrink-0 w-10">${t ? hhmm(t) : '··:··'}</span><span class="${tone[k]}">${esc(text)}</span></div>`).join('');
  }

  // ── Map (screen-space SVG + HTML pins; pan by dragging, zoom with the buttons)
  const toWorld = (p) => ({ x: p.lng * COS_LAT, y: -p.lat });
  function fitView(points, W, H) {
    const ws = points.filter(Boolean).map(toWorld);
    const xs = ws.map(p => p.x), ys = ws.map(p => p.y);
    const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
    const pad = 90;
    const scale = Math.max(600, Math.min(40000, Math.min((W - 2 * pad) / Math.max(maxx - minx, 0.07), (H - 2 * pad) / Math.max(maxy - miny, 0.045))));
    return { cx: (minx + maxx) / 2, cy: (miny + maxy) / 2, scale };
  }
  function routeGeom(P0, P3) {
    const dx = P3.x - P0.x, dy = P3.y - P0.y, len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * len * 0.16, ny = (dx / len) * len * 0.16;
    const P1 = { x: P0.x + dx / 3 + nx, y: P0.y + dy / 3 + ny }, P2 = { x: P0.x + (2 * dx) / 3 - nx, y: P0.y + (2 * dy) / 3 - ny };
    const at = (t) => { const u = 1 - t; return { x: u ** 3 * P0.x + 3 * u * u * t * P1.x + 3 * u * t * t * P2.x + t ** 3 * P3.x, y: u ** 3 * P0.y + 3 * u * u * t * P1.y + 3 * u * t * t * P2.y + t ** 3 * P3.y }; };
    const table = [0]; let prev = at(0);
    for (let i = 1; i <= 60; i++) { const p = at(i / 60); table.push(table[i - 1] + Math.hypot(p.x - prev.x, p.y - prev.y)); prev = p; }
    const pointAt = (frac) => {                     // position by distance travelled, not by t
      const target = frac * table[60]; let i = 1;
      while (i < 60 && table[i] < target) i++;
      const t = (i - 1 + (target - table[i - 1]) / ((table[i] - table[i - 1]) || 1)) / 60;
      return at(Math.min(1, Math.max(0, t)));
    };
    return { d: `M${P0.x.toFixed(1)} ${P0.y.toFixed(1)} C${P1.x.toFixed(1)} ${P1.y.toFixed(1)} ${P2.x.toFixed(1)} ${P2.y.toFixed(1)} ${P3.x.toFixed(1)} ${P3.y.toFixed(1)}`, pointAt };
  }

  function drawMap() {
    const box = $('live-map'); const m = liveModel();
    if (!box || !m) return;
    if (LiveMap.available()) { drawRealMap(m); return; }
    const W = box.clientWidth, H = box.clientHeight;
    const others = [...new Set([...state.live.rankings.slice(0, 6).map(x => x.hospital_id), ...m.wfs.map(w => w.hospital_id)])].filter(id => id !== m.destId);
    if (!state.live.view) state.live.view = fitView([m.pickup, m.dest], W, H);   // focus on the route; zoom out to see other hospitals
    const v = state.live.view;
    const S = (p) => { const w = toWorld(p); return { x: (w.x - v.cx) * v.scale + W / 2, y: (w.y - v.cy) * v.scale + H / 2 }; };

    // decorative road network between neighbouring localities
    const roads = [];
    AREAS.forEach((a, i) => AREAS.map((b, j) => [j, hav(a, b)]).filter(([j]) => j !== i).sort((x, y) => x[1] - y[1]).slice(0, 2)
      .forEach(([j]) => { if (i < j || !roads.some(r => r[0] === j && r[1] === i)) roads.push([i, j]); }));
    const roadSvg = roads.map(([i, j]) => { const a = S(AREAS[i]), b = S(AREAS[j]); return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#dde5f2" stroke-width="6" stroke-linecap="round"/>`; }).join('');

    let routeSvg = '', geom = null;
    if (m.dest) {
      geom = routeGeom(S(m.pickup), S(m.dest));
      const moving = m.phase === 'enroute';
      routeSvg = `<path d="${geom.d}" fill="none" stroke="#b7ece9" stroke-width="12" stroke-linecap="round" opacity=".55"/>
        <path d="${geom.d}" fill="none" stroke="${m.acc ? '#006765' : '#6d7978'}" stroke-width="4" stroke-linecap="round" class="${moving || m.phase === 'preparing' ? 'route-dash' : ''}" ${m.acc ? '' : 'stroke-dasharray="4 7"'}/>
        <path d="${geom.d}" fill="none" stroke="#006765" stroke-width="5" stroke-linecap="round" pathLength="1" stroke-dasharray="${m.prog.toFixed(4)} 1" id="live-prog"/>`;
    }
    $('live-svg').innerHTML = roadSvg + routeSvg;
    state.live.geom = geom;

    const pin = (p, html, extra = '') => { const s = S(p); return `<div class="map-pin ${extra}" style="left:${s.x.toFixed(1)}px;top:${s.y.toFixed(1)}px">${html}</div>`; };
    const areaPins = AREAS.map(a => pin(a, `<span class="font-telemetry-sm text-[10px] uppercase tracking-wider text-[#9fb0c8] whitespace-nowrap">${a.name}</span>`)).join('');
    const otherPins = others.map(id => { const loc = hospLoc(id); if (!loc) return '';
      const w = m.wfs.find(x => x.hospital_id === id); const declined = w?.hospital_response === 'REJECTED';
      return pin(loc, `<div class="flex flex-col items-center gap-0.5 map-pin-hit" title="${esc(hospName(id))}"><span class="w-3.5 h-3.5 rounded-full border-2 border-white shadow ${declined ? 'bg-tertiary-container' : w ? 'bg-[#D97706]' : 'bg-outline'}"></span><span class="px-1 rounded bg-surface-container-lowest/85 text-[10px] font-telemetry-sm text-on-surface-variant whitespace-nowrap">${esc(shortName(hospName(id)))}${declined ? ' ✕' : ''}</span></div>`); }).join('');
    const nearestArea = AREAS.map(a => [a, hav(a, m.pickup)]).sort((a, b) => a[1] - b[1])[0];
    const pickupPin = pin(m.pickup, `<div class="flex flex-col items-center gap-1"><span class="w-5 h-5 rounded-full bg-tertiary border-[3px] border-white shadow-md ${m.phase === 'waiting' || m.phase === 'none' ? 'ring-pulse' : ''}"></span><span class="px-space-sm py-0.5 rounded bg-surface-container-lowest shadow-sm font-telemetry-sm text-telemetry-sm text-tertiary whitespace-nowrap">Pickup${nearestArea && nearestArea[1] < 4 ? ` · ${nearestArea[0].name}` : ''}</span></div>`);
    const destPin = m.dest ? pin(m.dest, `<div class="flex flex-col items-center gap-1"><span class="w-9 h-9 rounded-lg bg-primary text-on-primary flex items-center justify-center shadow-md border-2 border-white"><span class="material-symbols-outlined text-[20px]">local_hospital</span></span><span class="px-space-sm py-0.5 rounded bg-surface-container-lowest shadow-sm font-label-md text-label-md whitespace-nowrap">${esc(m.destName)}${m.destId === HID ? ' (you)' : ''}</span></div>`) : '';
    const amb = geom ? geom.pointAt(m.prog) : S(m.pickup);
    const ambPin = `<div class="map-pin" id="live-amb" style="left:${amb.x.toFixed(1)}px;top:${amb.y.toFixed(1)}px;z-index:5;transform:translate(-50%,calc(-100% + 24px))"><div class="flex flex-col-reverse items-center gap-space-sm">
        <span class="w-12 h-12 rounded-xl bg-[#6fd7d3]/40 flex items-center justify-center amb-halo"><span class="w-9 h-9 rounded-lg bg-inverse-surface text-[#6fd7d3] flex items-center justify-center"><span class="material-symbols-outlined text-[22px]">airport_shuttle</span></span></span>
        <span class="px-space-md py-space-xs rounded-lg bg-surface-container-lowest shadow-md border border-surface-container-high flex items-center gap-space-xs whitespace-nowrap"><span class="font-label-lg text-label-lg">Ambulance ${esc(unit(m.d.ambulance_id))}</span><span class="text-outline">·</span><span class="w-2 h-2 rounded-full ${m.phase === 'enroute' ? 'bg-primary animate-pulse' : m.phase === 'waiting' ? 'bg-[#D97706]' : 'bg-[#10B981]'}"></span><span class="font-telemetry-sm text-telemetry-sm text-primary" id="live-amb-label">${esc(phaseLabel(m))}</span></span></div></div>`;
    $('live-pins').innerHTML = areaPins + otherPins + pickupPin + destPin + ambPin;
    $('live-caption').textContent = m.acc
      ? `Automated route active: ${m.destName} (${m.km ?? '—'} km · ${m.phase === 'enroute' ? 'High-priority navigation active' : m.phase === 'preparing' ? 'Green corridor requested' : 'Route complete'})`
      : `Route preview to ${m.destName} (${m.km ?? '—'} km) · waiting for hospital confirmation`;
  }

  // Moves the ambulance every second without rebuilding the page
  function liveTick() {
    if (state.view === 'live' && state.live.lm && LiveMap.available()) { realTick(); return; }
    if (state.view !== 'live' || !state.live.geom) return;
    const m = liveModel(); if (!m) return;
    const p = state.live.geom.pointAt(m.prog);
    const a = $('live-amb'); if (a) { a.style.left = `${p.x.toFixed(1)}px`; a.style.top = `${p.y.toFixed(1)}px`; }
    $('live-prog')?.setAttribute('stroke-dasharray', `${m.prog.toFixed(4)} 1`);
    if ($('live-amb-label')) $('live-amb-label').textContent = phaseLabel(m);
    if ($('live-eta-chip') && m.phase === 'enroute') $('live-eta-chip').textContent = `ETA: ${m.left} min`;
  }

  // map controls: zoom buttons, drag to pan, refit on resize
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-map]'); if (!b || !state.live.view) return;
    const v = state.live.view;
    if (b.dataset.map === 'in') v.scale = Math.min(60000, v.scale * 1.4);
    if (b.dataset.map === 'out') v.scale = Math.max(400, v.scale / 1.4);
    if (b.dataset.map === 'fit') state.live.view = null;
    drawMap();
  });
  let drag = null;
  document.addEventListener('pointerdown', (e) => {
    const box = e.target.closest('#live-map'); if (!box || e.target.closest('button') || !state.live.view) return;
    drag = { x: e.clientX, y: e.clientY, cx: state.live.view.cx, cy: state.live.view.cy };
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag || !state.live.view) return;
    state.live.view.cx = drag.cx - (e.clientX - drag.x) / state.live.view.scale;
    state.live.view.cy = drag.cy - (e.clientY - drag.y) / state.live.view.scale;
    drawMap();
  });
  document.addEventListener('pointerup', () => { drag = null; });
  window.addEventListener('resize', () => { if (state.view === 'live') { if (state.live.lm) state.live.lm.invalidate(); else { state.live.view = null; drawMap(); } } });

  // ── Real street map (Leaflet + OSRM road route). The ambulance moves with the crew's live position
  //    (GPS or their simulated drive) when it is streaming, otherwise along the route by elapsed time.
  const LL = (p) => p ? [p.lat, p.lng] : null;
  const routeKeyOf = (m) => `${state.live.id}|${m.destId}`;
  function drawRealMap(m) {
    const box = $('live-map'); if (!box) return;
    if (!state.live.lmEl) { state.live.lmEl = document.createElement('div'); state.live.lmEl.className = 'lm-map absolute inset-0'; }
    box.prepend(state.live.lmEl);
    ['live-svg', 'live-pins', 'live-ctrls'].forEach(id => $(id)?.classList.add('hidden'));
    box.classList.remove('map-grab', 'map-dots');
    if (!state.live.lm) state.live.lm = LiveMap.create(state.live.lmEl, { center: LL(m.pickup), zoom: 13 });
    const lm = state.live.lm;
    setTimeout(() => lm.invalidate(), 30);
    lm.setPickup(LL(m.pickup), 'Pickup');
    const others = m.acc ? [] : m.wfs.filter(w => w.hospital_id !== m.destId && w.hospital_response !== 'WITHDRAWN')
      .map(w => ({ id: w.hospital_id, name: shortName(hospName(w.hospital_id)), latlng: LL(hospLoc(w.hospital_id)), tone: w.hospital_response === 'PENDING' ? 'waiting' : 'declined' }));
    lm.setHospitals([...others, { id: m.destId, name: `${shortName(m.destName)}${m.destId === HID ? ' (you)' : ''}`, latlng: LL(m.dest), tone: m.acc ? 'accepted' : 'waiting' }]);
    const key = routeKeyOf(m);
    if (m.dest && state.live.routeKey !== key && !state.live.routing) {
      state.live.routing = true;
      LiveMap.route(LL(m.pickup), LL(m.dest)).then(rt => {
        state.live.routing = false; state.live.route = rt; state.live.routeKey = key; state.live.fitted = false;
        if (state.view === 'live' && state.live.detail) drawRealMap(liveModel());
      });
    }
    const rt = state.live.routeKey === key ? state.live.route : null;
    lm.setRoute(rt, { active: !!m.acc && m.phase !== 'done' });
    if (!state.live.fitted) { state.live.fitted = true; lm.fit(rt ? rt.coords : [LL(m.pickup), LL(m.dest)], 60); }
    state.live.geom = null;
    realTick();
  }
  function realTick() {
    const m = liveModel(); const lm = state.live.lm; if (!m || !lm) return;
    const rt = state.live.routeKey === routeKeyOf(m) ? state.live.route : null;
    const fix = state.live.fix && state.live.fix.request_id === state.live.id && Date.now() - new Date(state.live.fix.at) < 30000 ? state.live.fix : null;
    let pos;
    if (m.phase === 'enroute' && fix) {
      const ll = [fix.lat, fix.lng];
      pos = { latlng: ll, frac: rt ? LiveMap.snap(rt, ll).frac : m.prog, eta: fix.eta_min ?? m.left, src: fix.source };
    } else if (rt) pos = { latlng: LiveMap.pointAt(rt, m.prog).latlng, frac: m.prog, eta: m.left };
    else pos = { latlng: LL(m.pickup), frac: 0, eta: m.left };
    const label = phaseLabel({ ...m, left: pos.eta });
    lm.setAmbulance(pos.latlng, `Ambulance ${esc(unit(m.d.ambulance_id))} · <span class="lm-state">● ${esc(label)}${pos.src === 'gps' ? ' · LIVE GPS' : ''}</span>`);
    if (rt) lm.setProgress(rt, pos.frac);
    if ($('live-eta-chip') && m.phase === 'enroute') $('live-eta-chip').textContent = `ETA: ${pos.eta} min`;
    if ($('live-caption')) $('live-caption').textContent = m.acc
      ? (rt ? `Automated route active: ${m.destName} (${rt.distance_km} km${rt.source === 'osrm' ? ' by road' : ' est.'} · ${m.phase === 'enroute' ? (fix ? `live ${fix.source === 'gps' ? 'GPS' : 'tracking'} from the ambulance` : 'High-priority navigation active') : m.phase === 'preparing' ? 'crew preparing to depart' : 'route complete'})` : `Calculating road route to ${m.destName}…`)
      : `Route preview to ${m.destName} · waiting for hospital confirmation`;
  }

  function liveEvent(requestId, text, tone) {
    (state.live.log[requestId] ||= []).push([new Date().toISOString(), text, tone]);
    if (state.view === 'live' && state.live.id === requestId) loadLive(requestId);
  }

  // ───────────── HISTORY ─────────────
  function renderHistory() {
    const list = state.history;
    if (!list.length) { $('history-table').innerHTML = `<div class="px-space-lg py-space-xl font-telemetry-sm text-telemetry-sm text-on-surface-variant">No cases in the last 24 hours.</div>`; return; }
    const tone = { ACCEPTED: 'bg-[#ECFDF5] text-[#065F46]', REJECTED: 'bg-tertiary-fixed text-tertiary', PENDING: 'bg-[#FFFBEB] text-[#92400E]', WITHDRAWN: 'bg-surface-container text-on-surface-variant' };
    $('history-table').innerHTML = `<div class="hidden md:grid grid-cols-12 gap-space-md px-space-lg py-space-sm bg-surface-container-low font-label-md text-label-md text-on-surface-variant uppercase">
      <span class="col-span-2">Contacted</span><span class="col-span-2">Case</span><span class="col-span-3">Condition</span><span class="col-span-2">Response</span><span class="col-span-3">Outcome</span></div>` +
      list.map(x => `<div class="grid grid-cols-2 md:grid-cols-12 gap-space-sm md:gap-space-md px-space-lg py-space-md items-center border-t border-surface-container-low">
        <span class="md:col-span-2 font-telemetry-sm text-telemetry-sm">${fmt.dateTimeIST(x.assignment_time)}</span>
        <span class="md:col-span-2 font-telemetry-md text-telemetry-md">#${esc(x.request?.request_id)}</span>
        <span class="md:col-span-3 font-label-lg text-label-lg">${x.request ? esc(condition(x.request)) : '—'}</span>
        <span class="md:col-span-2"><span class="px-space-sm py-0.5 rounded font-telemetry-sm text-telemetry-sm ${tone[x.response] || ''}">${x.response}${x.rejection_reason ? ` · ${esc(x.rejection_reason)}` : ''}</span></span>
        <span class="md:col-span-3 font-body-sm text-body-sm text-on-surface-variant">${x.handover_status === 'COMPLETED' ? `Handed over ${fmt.timeIST(x.handover_time)}` : x.arrival_time ? `Arrived ${fmt.timeIST(x.arrival_time)}` : x.departure_time ? 'En route' : x.response === 'ACCEPTED' ? 'Accepted' : x.response === 'WITHDRAWN' ? 'Filled by another hospital / withdrawn' : '—'}</span>
      </div>`).join('');
  }

  // ───────────── Actions ─────────────
  async function accept(resId) {
    try {
      await api(`/api/reservations/${encodeURIComponent(resId)}`, { method: 'PATCH', body: { action: 'accept' } });
      toast('Patient accepted', 'Resources reserved. The ambulance has been notified.', 'success');
      location.hash = '#active';
    } catch (err) {
      toast(err.body?.code === 'ALREADY_FILLED' ? 'Too late: another hospital accepted first' : 'Could not accept', esc(err.message), err.body?.code === 'ALREADY_FILLED' ? 'warn' : 'critical');
      if (err.status === 409) location.hash = '#requests';
    }
    loadItems();
  }
  let rejectId = null, rejectReason = null;
  function openReject(resId) {
    rejectId = resId; rejectReason = null;
    const i = state.items.find(x => x.reservation_id === resId);
    $('reject-sub').textContent = i ? `#${i.request.request_id} · ${condition(i.request)}. The held bed goes back to availability and the dispatcher picks another hospital.` : '';
    $('reject-reasons').innerHTML = state.meta.reject_reasons.map(r => `<label class="flex items-center gap-space-sm px-space-md py-space-sm rounded-lg border border-outline-variant cursor-pointer hover:bg-surface-container-low">
      <input type="radio" name="reject-reason" value="${esc(r)}" class="accent-[#b51735]"><span class="font-body-md text-body-md">${esc(r)}</span></label>`).join('');
    $('reject-confirm').disabled = true;
    $('reject-dialog').classList.remove('hidden'); $('reject-dialog').classList.add('flex');
  }
  const closeReject = () => { $('reject-dialog').classList.add('hidden'); $('reject-dialog').classList.remove('flex'); };
  $('reject-reasons').addEventListener('change', (e) => { rejectReason = e.target.value; $('reject-confirm').disabled = false; });
  $('reject-confirm').addEventListener('click', async () => {
    try {
      await api(`/api/reservations/${encodeURIComponent(rejectId)}`, { method: 'PATCH', body: { action: 'reject', reason: rejectReason } });
      toast('Request rejected', 'The bed was released back to availability.', 'info');
      location.hash = '#requests';
    } catch (err) { toast('Could not reject', esc(err.message), 'critical'); }
    closeReject(); loadItems();
  });
  async function handoff(requestId, step) {
    try {
      await api(`/api/requests/${encodeURIComponent(requestId)}/handoff`, { method: 'POST', body: { step } });
      if (step === 'arrive') { toast('Ambulance arrived', 'Complete the clinical checklist to admit the patient.', 'success'); location.hash = `#handover/${encodeURIComponent(requestId)}`; }
      if (step === 'complete') { toast('Handover complete', `#${esc(requestId)} admitted. The case is closed for the ambulance.`, 'success'); delete state.checklists[requestId]; loadHistory(); }
    } catch (err) { toast('Could not update', esc(err.message), 'critical'); }
    loadItems();
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-accept]'); if (a) accept(a.dataset.accept);
    const rj = e.target.closest('[data-reject]'); if (rj) openReject(rj.dataset.reject);
    const ar = e.target.closest('[data-arrive]'); if (ar) handoff(ar.dataset.arrive, 'arrive');
    const cp = e.target.closest('[data-complete]'); if (cp && !cp.disabled) handoff(cp.dataset.complete, 'complete');
    if (e.target.closest('[data-close-reject]')) closeReject();
  });
  document.addEventListener('keydown', (e) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && document.activeElement.type !== 'checkbox' && document.activeElement.type !== 'radio';
    if (!$('alarm').classList.contains('hidden')) {
      if (e.key === 'Enter') { e.preventDefault(); $('alarm-review').click(); }
      if (e.key === 'Escape') $('alarm-silence').click();
      return;
    }
    if (e.key === 'Escape') { if (!$('reject-dialog').classList.contains('hidden')) closeReject(); else if (state.view === 'detail') location.hash = '#requests'; }
    if (typing) return;
    if (e.key === 'Enter' && state.view === 'detail') { const b = document.querySelector('#view-detail [data-accept]'); if (b) { e.preventDefault(); b.click(); } }
    if (e.key === 'Enter' && state.view === 'dashboard') { const first = pending()[0]; if (first) location.hash = `#requests/${encodeURIComponent(first.request.request_id)}`; }
    if ((e.key === 's' || e.key === 'S') && state.view === 'resources' && !e.ctrlKey && !e.metaKey) quickSync();
  });

  // ───────────── Routing + render ─────────────
  const VIEWS = ['dashboard', 'requests', 'detail', 'resources', 'active', 'live', 'handover', 'history'];
  function route() {
    const [v, p] = (location.hash.replace('#', '') || 'dashboard').split('/');
    state.view = v === 'requests' && p ? 'detail' : VIEWS.includes(v) ? v : 'dashboard';
    state.param = p ? decodeURIComponent(p) : null;
    VIEWS.forEach(x => { $(`view-${x}`).classList.toggle('hidden', x !== state.view); $(`view-${x}`).classList.toggle('flex', x === state.view); });
    const navKey = state.view === 'detail' ? 'requests' : state.view;
    document.querySelectorAll('.side-link').forEach(a => {
      const on = a.getAttribute('href') === `#${navKey}`;
      on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
      if (a.closest('#mobile-nav')) a.className = `side-link shrink-0 px-space-md py-space-xs rounded font-label-md text-label-md ${on ? '' : 'bg-surface-container-low'}`;
    });
    if (state.view === 'history' || state.view === 'handover') loadHistory();
    if (state.view === 'live') {
      if (!state.param) { state.param = defaultLiveId(); if (state.param) history.replaceState(null, '', `#live/${encodeURIComponent(state.param)}`); }
      if (state.param !== state.live.id) { state.live.detail = null; state.live.view = null; state.live.fitted = false; state.live.fix = null; state.live.id = state.param; }
      loadLive(state.param);
    }
    render();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  function render() {
    const p = pending();
    $('nav-live').classList.toggle('hidden', !p.length);
    $('bell-dot').classList.toggle('hidden', !p.length);
    $('nav-handover-dot').classList.toggle('hidden', !atBay().length);
    $('nav-live-dot').classList.toggle('hidden', !enRoute().some(i => i.workflow?.departure_time));
    ({ live: renderLive, dashboard: renderDashboard, requests: renderRequests, detail: renderDetail, resources: renderResources, active: renderActive, handover: renderHandover, history: renderHistory }[state.view] || renderDashboard)();
    tick();
  }

  function tick() {
    document.querySelectorAll('[data-countdown]').forEach(el => {
      if (!el.dataset.countdown) return;
      const left = (new Date(el.dataset.countdown) - Date.now()) / 1000;
      el.textContent = mmss(left);
    });
    document.querySelectorAll('[data-eta]').forEach(el => {
      const left = (new Date(el.dataset.eta) - Date.now()) / 60000;
      el.textContent = left <= 0 ? 'Arriving now' : `${Math.ceil(left)} min ETA`;
    });
    document.querySelectorAll('[data-eta-clock]').forEach(el => { el.textContent = mmss((new Date(el.dataset.etaClock) - Date.now()) / 1000); });
  }
  setInterval(() => { tick(); tickClock(); liveTick(); }, 1000);
  setInterval(() => { if (state.view === 'handover' || state.view === 'detail') render(); }, 15000);   // progress bars / "docked x min ago"
  setInterval(loadHospital, 60000);                                                                    // freshness ages

  // ───────────── Live updates ─────────────
  function setConnection(online) {
    $('conn-dot').className = `w-2.5 h-2.5 rounded-full shrink-0 ${online ? 'bg-primary animate-pulse' : 'bg-tertiary'}`;
    $('conn-text').textContent = online ? `Hospital online · ${HID}` : 'Reconnecting…';
    $('footer-conn').textContent = online ? 'Connected' : 'Offline';
  }
  if (window.io) {
    const socket = io();
    socket.on('connect', () => { setConnection(true); loadItems(); loadHospital(); });
    socket.on('disconnect', () => setConnection(false));
    socket.on('reservation:update', async (p) => {
      const rid = p.request?.request_id;
      if (rid && rid === state.live.id) {
        const name = p.hospital_name || p.hospital_id;
        const msg = { held: [`Request sent to ${name}`, ''], accepted: [`${name} accepted & locked resources`, 'ok'], rejected: [`${name} declined${p.reason ? ` (${p.reason})` : ''} · beds released`, 'bad'],
          cancelled: [`Request to ${name} withdrawn by dispatcher`, 'bad'], expired: [`${name} did not respond · hold expired`, 'bad'] }[p.action];
        if (msg && ['rejected', 'cancelled'].includes(p.action)) liveEvent(rid, msg[0], msg[1]); else loadLive(rid);
      }
      if (p.hospital_id !== HID) return;
      await loadItems();
      if (p.action === 'held' && p.broadcast) state.broadcastIds.add(p.request.request_id);
      if (p.action === 'held') {
        const item = state.items.find(i => i.request.request_id === p.request.request_id && i.status === 'PENDING');
        if (item && !state.seenAlarms.has(item.reservation_id)) {
          state.seenAlarms.add(item.reservation_id);
          state.alarmQueue.push(item.request.request_id);
          if (!alarmItem) showAlarm(item); else $('alarm-queue').textContent = `+${state.alarmQueue.length - 1} more waiting`;
        }
      }
      if (['cancelled', 'expired', 'filled'].includes(p.action)) {
        if (alarmItem?.request.request_id === p.request.request_id) { closeAlarm(); nextAlarm(); }
        state.alarmQueue = state.alarmQueue.filter(x => x !== p.request.request_id);
        if (p.action === 'filled') toast('Filled by another hospital', `#${esc(p.request.request_id)} was accepted by ${esc(p.filled_by || 'another hospital')}. No action needed.`, 'info');
        else toast(p.action === 'cancelled' ? 'Request withdrawn by ambulance' : 'Request expired (no response)', `#${esc(p.request.request_id)} · no longer waiting for you.`, p.action === 'expired' ? 'warn' : 'info');
        if (state.view === 'detail' && state.param === p.request.request_id) render();
      }
    });
    socket.on('ambulance:position', (p) => {
      if (p.request_id !== state.live.id) return;
      state.live.fix = p;
      if (state.view === 'live') liveTick();
    });
    socket.on('handoff:update', (p) => {
      if (p.request?.request_id && p.request.request_id === state.live.id) loadLive(state.live.id);
      if (p.hospital_id !== HID) return;
      if (p.step === 'depart') toast(`🚑 Ambulance ${unit(p.request.ambulance_id)} en route`, `#${esc(p.request.request_id)} · ${esc(condition(p.request))} · <a class="text-primary underline" href="#live/${encodeURIComponent(p.request.request_id)}">Track live route</a>`, 'info');
      loadItems();
    });
    socket.on('hospital:update', (p) => {
      if (p.hospital?.hospital_id !== HID) return;
      state.hospital = p.hospital;
      if (['resources', 'handover', 'detail'].includes(state.view)) render();
    });
  } else setConnection(false);

  // ───────────── Boot ─────────────
  tickClock(); renderArm();
  (async () => {
    try { state.meta = await api('/api/reservations/meta'); } catch { /* defaults */ }
    await Promise.all([loadHospital(), loadItems()]);
    route();
    // Requests already waiting when staff open the portal also get the alarm
    const waiting = pending();
    if (waiting.length) {
      waiting.forEach(i => { state.seenAlarms.add(i.reservation_id); state.alarmQueue.push(i.request.request_id); });
      showAlarm(waiting[0]);
    }
  })();
})();
