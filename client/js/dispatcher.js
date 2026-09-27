// JeevanRoute Dispatcher Portal: live emergency log, create form, active queue, summary drawer.
(() => {
  // ───────────── Auth guard ─────────────
  const session = Session.get();
  if (!session?.token || session.user?.role !== 'dispatcher') {
    location.replace('index.html');
    return;
  }
  api('/api/auth/me').catch((err) => {
    if (err.status === 401) { Session.clear(); location.replace('index.html'); }
  });

  const $ = (id) => document.getElementById(id);
  const esc = fmt.escape;
  let meta = null;                       // /api/requests/meta
  const state = {
    view: 'dispatch',
    recent: { offset: 0, ids: new Set() },
    todayCount: 0,
  };

  // Pune localities (from the dataset's demo region) for quick location entry
  const AREAS = [
    ['Shivajinagar', 18.5308, 73.8475], ['Kothrud', 18.5074, 73.8077], ['Aundh', 18.5590, 73.8078],
    ['Hinjewadi', 18.5912, 73.7389], ['Wakad', 18.5975, 73.7700], ['Pimpri', 18.6298, 73.7997],
    ['Viman Nagar', 18.5679, 73.9143], ['Kharadi', 18.5515, 73.9348], ['Hadapsar', 18.5089, 73.9260],
    ['Katraj', 18.4575, 73.8677], ['Swargate', 18.5018, 73.8636], ['Chakan', 18.7606, 73.8636],
    ['Talegaon', 18.7353, 73.6755],
  ];

  // ───────────── Header ─────────────
  $('user-name').textContent = session.user.name;
  $('user-id').textContent = `ID ${session.user.id}`;
  $('user-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = $('user-menu').classList.toggle('hidden') === false;
    $('user-btn').setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', () => $('user-menu').classList.add('hidden'));
  $('logout-btn').addEventListener('click', () => { Session.clear(); location.replace('index.html'); });



  // ───────────── Toasts ─────────────
  function toast(title, body = '', tone = 'info') {
    const colors = {
      info: 'border-outline-variant',
      success: 'border-[#6EE7B7]',
      critical: 'border-[#F87171]',
      warn: 'border-[#D97706]',
    };
    const el = document.createElement('div');
    el.className = `bg-surface-container-lowest border ${colors[tone]} border-l-4 rounded-lg px-space-lg py-space-md shadow-[0_4px_16px_-4px_rgba(11,31,58,0.12)]`;
    el.innerHTML = `<div class="font-label-lg text-label-lg text-on-surface">${esc(title)}</div>${body ? `<div class="font-body-sm text-body-sm text-on-surface-variant mt-0.5">${body}</div>` : ''}`;
    $('toasts').appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 5000);
  }

  // ───────────── Row rendering (Kunal's table design) ─────────────
  const STATUS = {
    CREATED:    { label: 'Awaiting Match', tone: 'standby' },
    MATCHING:   { label: 'Matching',       tone: 'warn' },
    NO_MATCH:   { label: 'No Match',       tone: 'critical' },
    ASSIGNED:   { label: 'Assigned',       tone: 'active' },
    IN_TRANSIT: { label: 'En Route',       tone: 'active' },
    COMPLETED:  { label: 'Completed',      tone: 'done' },
  };
  const TONE = {
    done:     { chip: 'bg-surface-container text-on-surface', dot: 'bg-primary' },
    active:   { chip: 'bg-[#ECFDF5] border border-[#6EE7B7] text-[#065F46]', dot: 'bg-[#36B37E]' },
    standby:  { chip: 'bg-[#F1F5F9] border border-[#CBD5E1] text-[#475569]', dot: 'bg-[#64748B]' },
    warn:     { chip: 'bg-[#FFFBEB] border border-[#FCD34D] text-[#92400E]', dot: 'bg-[#D97706]' },
    critical: { chip: 'bg-[#FEF2F2] border border-[#F87171] text-[#991B1B]', dot: 'bg-[#F54B5E] crit-dot' },
  };

  function statusChip(r) {
    const st = STATUS[r.status] || { label: r.status, tone: 'standby' };
    // Critical patients still waiting for a hospital get the Level-1 treatment
    const tone = r.severity === 'Critical' && ['CREATED', 'MATCHING'].includes(r.status) ? 'critical' : st.tone;
    return `<span class="inline-flex items-center gap-space-xs px-space-sm py-space-xs rounded ${TONE[tone].chip} font-telemetry-sm text-telemetry-sm font-medium">
      <span class="w-1.5 h-1.5 rounded-full ${TONE[tone].dot}"></span><span>${st.label}</span></span>`;
  }

  const isUrgent = (r) => r.severity === 'Critical' || r.severity === 'High';

  function rowHTML(r) {
    const a = r.assignment;
    const facility = a
      ? `<span class="material-symbols-outlined text-outline text-[18px]">local_hospital</span>
         <span class="font-body-md text-body-md font-semibold">${esc(a.hospital_name)}</span>`
      : `<span class="material-symbols-outlined text-outline text-[18px]">pending</span>
         <span class="font-body-md text-body-md text-on-surface-variant italic">Awaiting hospital match</span>`;
    const transit = a
      ? `<span class="font-telemetry-md text-telemetry-md text-on-surface font-semibold">${a.transit_minutes} min ${a.transit_source === 'actual' ? 'transit' : 'ETA'}</span>
         <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">Distance: ${a.distance_km} km</span>`
      : `<span class="font-telemetry-md text-telemetry-md text-on-surface font-semibold">—</span>
         <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">Waiting ${waitText(r.waiting_minutes)}</span>`;
    const critBorder = r.severity === 'Critical' && ['CREATED', 'MATCHING'].includes(r.status) ? 'border-l-2 border-[#F54B5E]' : 'border-l-2 border-transparent';

    return `
<div class="req-row grid grid-cols-1 md:grid-cols-12 gap-space-sm md:gap-space-md px-space-lg py-space-md hover:bg-surface-container-low transition-colors duration-100 items-center border-b border-surface-container-low ${critBorder}" data-id="${esc(r.request_id)}">
  <div class="md:col-span-3 flex flex-col">
    <div class="flex items-center gap-space-xs flex-wrap">
      <span class="font-telemetry-md text-telemetry-md text-on-surface font-semibold tracking-tight">#${esc(r.request_id)}</span>
      <span class="text-outline-variant font-telemetry-sm text-telemetry-sm">•</span>
      <span class="font-label-md text-label-md ${isUrgent(r) ? 'text-tertiary' : 'text-primary'} font-semibold">${esc(r.severity)} ${esc(r.emergency_type)}</span>
    </div>
    <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant mt-0.5">Logged: ${fmt.timeIST(r.created_at)} · Age ${r.patient_age}</span>
  </div>
  <div class="md:col-span-3 flex items-center gap-space-xs text-on-surface">${facility}</div>
  <div class="md:col-span-2 flex flex-col">${transit}</div>
  <div class="md:col-span-2 flex items-center">${statusChip(r)}</div>
  <div class="md:col-span-2 flex items-center justify-start md:justify-end gap-space-xs">
    <button class="px-space-md py-space-xs rounded bg-surface-container-low hover:bg-surface-container text-on-surface font-label-md text-label-md transition-colors flex items-center gap-space-xs" data-summary="${esc(r.request_id)}" type="button">
      <span>View Summary</span><span class="material-symbols-outlined text-[16px]">chevron_right</span>
    </button>
  </div>
</div>`;
  }

  function waitText(mins) {
    if (mins < 1) return '<1 min';
    if (mins < 60) return `${Math.round(mins)} min`;
    const h = Math.floor(mins / 60);
    return h < 24 ? `${h} h ${Math.round(mins % 60)} min` : `${Math.floor(h / 24)} d`;
  }

  const emptyHTML = (text) => `<div class="px-space-lg py-space-xl text-on-surface-variant font-telemetry-sm text-telemetry-sm">${text}</div>`;

  // ───────────── View: Emergency Dispatch (recent log) ─────────────
  async function loadRecent(reset = true) {
    if (reset) { state.recent.offset = 0; state.recent.ids.clear(); }
    try {
      const data = await api(`/api/requests?since_minutes=1440&sort=recent&limit=25&offset=${state.recent.offset}`);
      const html = data.requests.map((r) => { state.recent.ids.add(r.request_id); return rowHTML(r); }).join('');
      if (reset) $('recent-rows').innerHTML = html || emptyHTML('No emergencies in the last 24 hours. Press N to log one.');
      else $('recent-rows').insertAdjacentHTML('beforeend', html);
      state.recent.offset += data.requests.length;
      $('recent-more').classList.toggle('hidden', state.recent.offset >= data.total);
      $('recent-meta').textContent = `${data.total} in the last 24 h`;
    } catch (err) {
      $('recent-rows').innerHTML = emptyHTML(`Could not load emergencies: ${esc(err.message)}`);
    }
  }

  async function loadTodayCount() {
    try {
      const data = await api(`/api/requests?since_minutes=${fmt.minutesSinceMidnightIST()}&limit=1`);
      state.todayCount = data.total;
      renderTodayCount();
    } catch { /* ignore */ }
  }
  const renderTodayCount = () => { $('today-count').textContent = `${state.todayCount} logged today`; };

  $('recent-more').addEventListener('click', () => loadRecent(false));

  // ───────────── Draft emergency (Create → Cart → Start Searching) ─────────────
  const DRAFT_KEY = 'jeevanroute.draft';
  const byId = (list) => Object.fromEntries(list.map(x => [x.id, x]));
  const DEPTS = byId(CATALOG.departments);
  const EQUIP = byId(CATALOG.equipment);

  function newDraft() {
    return {
      ref: `NEW-${Math.floor(1000 + Math.random() * 9000)}`,
      type: 'Road Accident', priority: 'Critical', age: '', beds: 1,
      area: '', lat: null, lng: null,
      departments: [], equipment: [],
    };
  }
  let draft = (() => { try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY)) || newDraft(); } catch { return newDraft(); } })();
  const saveDraft = () => { try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch {} };
  const draftHasItems = () => draft.departments.length + draft.equipment.length > 0;

  // Requirement keys the backend can match (union of the selected items)
  function draftRequirementKeys() {
    const keys = new Set();
    draft.departments.forEach(id => (DEPTS[id].req || []).forEach(k => keys.add(k)));
    draft.equipment.forEach(id => (EQUIP[id].req || []).forEach(k => keys.add(k)));
    if (['Critical', 'High'].includes(draft.priority)) (meta?.severity_defaults?.[draft.priority] || []).forEach(k => keys.add(k));
    return [...keys];
  }
  function draftInfoOnly() {
    return [...draft.departments.map(id => DEPTS[id]), ...draft.equipment.map(id => EQUIP[id])].filter(x => !x.req).map(x => x.name);
  }
  function draftSpecialist() {
    const fromType = meta?.type_defaults?.[draft.type]?.specialist;
    if (fromType) return fromType;
    const item = [...draft.departments.map(id => DEPTS[id]), ...draft.equipment.map(id => EQUIP[id])].find(x => x.specialist);
    return item ? item.specialist : null;
  }

  // Live hospital data: used for card availability + cart preview
  let hospitals = [];
  async function loadHospitals() {
    try { hospitals = (await api('/api/hospitals')).hospitals; } catch { /* keep last */ }
    renderAvailability();
  }
  let availTimer = null;
  function onHospitalUpdate({ hospital }) {
    const i = hospitals.findIndex(h => h.hospital_id === hospital.hospital_id);
    if (i >= 0) hospitals[i] = hospital;
    clearTimeout(availTimer);
    availTimer = setTimeout(renderAvailability, 600);
  }

  // "210 beds free" / "14 hospitals" / "Info only"
  function availabilityText(item) {
    if (!item.req) return { text: 'Info only', live: false };
    if (!hospitals.length) return { text: 'Checking…', live: false };
    const k = item.req[0];
    if (BED_KEYS[k]) {
      const free = hospitals.filter(h => h.accepting_patients).reduce((a, h) => a + h.resources[BED_KEYS[k]].available, 0);
      return { text: `${free} ${k === 'ventilator' ? 'units' : 'beds'} free`, live: free > 0 };
    }
    const n = hospitals.filter(h => hospitalMeets(h, item.req, 1)).length;
    return { text: `${n} hospital${n === 1 ? '' : 's'} ready`, live: n > 0 };
  }

  function renderAvailability() {
    document.querySelectorAll('[data-avail]').forEach(el => {
      const item = DEPTS[el.dataset.avail] || EQUIP[el.dataset.avail];
      const a = availabilityText(item);
      el.textContent = a.text;
      el.className = `font-telemetry-sm text-telemetry-sm ${a.live ? 'text-primary font-semibold' : 'text-on-surface-variant'}`;
    });
    if (state.view === 'cart') renderCart();
  }

  // ───────────── View: Create Emergency (d3) ─────────────
  function buildCreate() {
    $('f-type').innerHTML = meta.emergency_types.map(t => `<option>${esc(t)}</option>`).join('');
    $('f-priority').innerHTML = meta.severities.map(s => `<option value="${s}">${CATALOG.priorities[s].label}</option>`).join('');
    $('f-area').innerHTML = `<option value="">Select Pune area…</option>` + AREAS.map(([n]) => `<option>${n}</option>`).join('')
      + `<option value="__custom">Custom coordinates…</option>`;
    $('presets').innerHTML = Object.keys(CATALOG.presets).map((p, i) => `
      <button class="px-space-md py-space-xs rounded ${i === 0 ? 'bg-surface-container text-primary' : 'bg-surface-container-low text-on-surface'} hover:bg-surface-container font-label-lg text-label-lg" data-preset="${esc(p)}" type="button">${esc(p)}</button>`).join('');

    $('dept-grid').innerHTML = CATALOG.departments.map(d => cardHTML(d, 'dept')).join('');
    $('equip-grid').innerHTML = CATALOG.equipment.map(e => cardHTML(e, 'equip')).join('');
    syncCreate();
  }

  function cardHTML(item, kind) {
    const isDept = kind === 'dept';
    return `
<div class="sel-card bg-surface-container-lowest rounded-xl shadow-sm border-2 border-transparent p-space-lg flex flex-col justify-between gap-space-lg transition-colors" data-card="${item.id}" data-kind="${kind}">
  <div class="flex items-start gap-space-md">
    <div class="w-12 h-12 rounded-lg bg-surface-container-low flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-primary">${item.icon}</span></div>
    <div class="flex flex-col min-w-0">
      <div class="flex items-center gap-space-xs flex-wrap">
        <span class="font-headline-sm text-headline-sm text-on-surface ${isDept ? 'truncate' : ''}" title="${esc(item.name)}">${esc(item.name)}</span>
        ${!isDept && item.tag ? `<span class="px-1.5 py-0.5 rounded bg-surface-container-low font-telemetry-sm text-telemetry-sm text-on-surface-variant">${esc(item.tag)}</span>` : ''}
      </div>
      <span class="font-body-md text-body-md text-on-surface-variant">${esc(item.desc)}</span>
    </div>
  </div>
  <div class="flex items-center justify-between gap-space-sm">
    <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant" data-avail="${item.id}">…</span>
    <button class="add-btn inline-flex items-center gap-space-xs px-space-md py-space-xs rounded bg-surface-container-high hover:bg-surface-container-highest text-on-surface font-label-lg text-label-lg" data-toggle="${item.id}" data-kind="${kind}" type="button">
      <span class="material-symbols-outlined text-[18px]">add</span><span>Add</span></button>
  </div>
</div>`;
  }

  function priorityStyle() {
    const p = CATALOG.priorities[draft.priority];
    $('priority-pill').style.background = p.bg;
    $('priority-dot').style.background = p.color;
    $('f-priority').style.color = p.color;
  }

  function syncCreate() {
    $('f-type').value = draft.type;
    $('f-priority').value = draft.priority;
    $('f-age').value = draft.age;
    $('f-beds').value = draft.beds;
    $('f-area').value = draft.area || '';
    $('f-coords').textContent = draft.lat != null ? `${Number(draft.lat).toFixed(4)}, ${Number(draft.lng).toFixed(4)}` : '';
    priorityStyle();

    document.querySelectorAll('.sel-card').forEach(card => {
      const list = card.dataset.kind === 'dept' ? draft.departments : draft.equipment;
      const on = list.includes(card.dataset.card);
      card.classList.toggle('border-[#006765]', on);
      card.classList.toggle('border-transparent', !on);
      const btn = card.querySelector('.add-btn');
      btn.className = `add-btn inline-flex items-center gap-space-xs px-space-md py-space-xs rounded font-label-lg text-label-lg ${on ? 'bg-primary text-on-primary' : 'bg-surface-container-high hover:bg-surface-container-highest text-on-surface'}`;
      btn.innerHTML = on ? '<span class="material-symbols-outlined text-[18px]">check</span><span>Added</span>' : '<span class="material-symbols-outlined text-[18px]">add</span><span>Add</span>';
      btn.setAttribute('aria-pressed', String(on));
    });
    $('dept-count').textContent = `${draft.departments.length} Selected`;
    $('equip-count').textContent = `${draft.equipment.length} Selected`;
    $('create-bar-text').textContent = `${draft.departments.length} Departments & ${draft.equipment.length} Major Equipment selected`;
    renderAvailability();
    saveDraft();
  }

  function toggleItem(id, kind) {
    const list = kind === 'dept' ? draft.departments : draft.equipment;
    const i = list.indexOf(id);
    i >= 0 ? list.splice(i, 1) : list.push(id);
    if (draft.autoAdded) ['departments', 'equipment'].forEach(k => { draft.autoAdded[k] = draft.autoAdded[k].filter(x => x !== id); });
    $('create-bar-error').classList.add('hidden');
    syncCreate();
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-toggle]');
    if (t) toggleItem(t.dataset.toggle, t.dataset.kind);
    const p = e.target.closest('[data-preset]');
    if (p) {
      const preset = CATALOG.presets[p.dataset.preset];
      draft.departments = [...new Set([...draft.departments, ...preset.departments])];
      draft.equipment = [...new Set([...draft.equipment, ...preset.equipment])];
      syncCreate();
    }
  });

  // Changing the type swaps its suggested items: remove what the OLD type auto-added
  // (unless the dispatcher removed/kept it manually), then add the NEW type's suggestions.
  $('f-type').addEventListener('change', (e) => {
    const auto = draft.autoAdded || { departments: [], equipment: [] };
    draft.departments = draft.departments.filter(id => !auto.departments.includes(id));
    draft.equipment = draft.equipment.filter(id => !auto.equipment.includes(id));
    draft.type = e.target.value;
    const d = CATALOG.typeDefaults[draft.type];
    draft.autoAdded = {
      departments: d.departments.filter(id => !draft.departments.includes(id)),
      equipment: d.equipment.filter(id => !draft.equipment.includes(id)),
    };
    draft.departments.push(...draft.autoAdded.departments);
    draft.equipment.push(...draft.autoAdded.equipment);
    syncCreate();
  });
  $('f-priority').addEventListener('change', (e) => { draft.priority = e.target.value; syncCreate(); });
  $('f-age').addEventListener('input', (e) => { draft.age = e.target.value; saveDraft(); });
  $('f-beds').addEventListener('input', (e) => { draft.beds = Math.max(1, Math.min(10, Number(e.target.value) || 1)); saveDraft(); });
  $('f-area').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === '__custom') {
      const input = prompt('Enter pickup coordinates as "lat, lng"', draft.lat != null ? `${draft.lat}, ${draft.lng}` : '18.5204, 73.8567');
      const m = input && input.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
      if (m) { draft.lat = Number(m[1]); draft.lng = Number(m[2]); draft.area = '__custom'; }
    } else if (v) {
      const [, la, ln] = AREAS.find(a => a[0] === v);
      draft.area = v; draft.lat = la; draft.lng = ln;
    } else {
      draft.area = ''; draft.lat = null; draft.lng = null;
    }
    syncCreate();
  });
  $('f-geo').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('Location unavailable', 'This browser cannot share location.', 'warn');
    navigator.geolocation.getCurrentPosition(
      (pos) => { draft.lat = +pos.coords.latitude.toFixed(6); draft.lng = +pos.coords.longitude.toFixed(6); draft.area = '__custom'; syncCreate(); },
      () => toast('Location blocked', 'Allow location access or pick an area.', 'warn'),
      { timeout: 8000 },
    );
  });

  function validateDraft() {
    const problems = [];
    const age = Number(draft.age);
    if (draft.age === '' || !Number.isInteger(age) || age < 0 || age > 120) problems.push('patient age');
    if (draft.lat == null) problems.push('pickup location');
    if (!draftHasItems()) problems.push('at least one department or equipment');
    return problems;
  }

  $('proceed-btn').addEventListener('click', () => {
    const problems = validateDraft();
    if (problems.length) {
      $('create-bar-error').textContent = `Add ${problems.join(', ')} to continue.`;
      $('create-bar-error').classList.remove('hidden');
      if (problems.includes('patient age')) $('f-age').focus();
      return;
    }
    location.hash = '#cart';
  });

  // ───────────── View: Emergency Cart (d2) ─────────────
  function areaLabel() {
    if (draft.lat == null) return 'Not set';
    return draft.area && draft.area !== '__custom' ? draft.area : `${Number(draft.lat).toFixed(3)}, ${Number(draft.lng).toFixed(3)}`;
  }

  // Preview: capable hospitals + nearest ETA (the real ranking runs on the server)
  function cartPreview() {
    const keys = draftRequirementKeys();
    const capable = hospitals.filter(h => hospitalMeets(h, keys, Number(draft.beds) || 1));
    if (draft.lat == null || !capable.length) return { capable: capable.length, eta: null };
    const nearest = Math.min(...capable.map(h => Geo.roadKm({ lat: draft.lat, lng: draft.lng }, h.location)));
    return { capable: capable.length, eta: Geo.eta(nearest) };
  }

  function cartItemHTML(item, kind) {
    const a = availabilityText(item);
    const code = kind === 'dept' ? item.code : item.tag;
    return `
<div class="flex items-center gap-space-md bg-surface-container-low rounded-lg px-space-lg py-space-md">
  <div class="w-11 h-11 rounded-lg bg-surface-container-lowest flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-primary">${item.icon}</span></div>
  <div class="flex flex-col flex-1 min-w-0">
    <div class="flex items-center gap-space-sm flex-wrap"><span class="font-headline-sm text-headline-sm text-on-surface">${esc(item.name)}</span>
    ${code ? `<span class="px-1.5 py-0.5 rounded ${item.req ? 'bg-surface-container text-primary' : 'bg-surface-container-high text-on-surface-variant'} font-telemetry-sm text-telemetry-sm uppercase">${esc(code)}</span>` : ''}</div>
    <span class="font-body-md text-body-md text-on-surface-variant">${esc(item.desc)}</span>
  </div>
  <span class="hidden sm:inline px-space-sm py-1 rounded font-telemetry-sm text-telemetry-sm ${a.live ? 'bg-secondary-container/40 text-primary' : item.req ? 'bg-tertiary-fixed text-tertiary' : 'bg-surface-container text-on-surface-variant'}">${a.live || !item.req ? esc(a.text) : 'Unavailable'}</span>
  <button class="w-8 h-8 rounded hover:bg-surface-container flex items-center justify-center text-on-surface-variant" data-remove="${item.id}" data-kind="${kind}" type="button" aria-label="Remove ${esc(item.name)}"><span class="material-symbols-outlined">close</span></button>
</div>`;
  }

  function renderCart() {
    if (!meta) return;
    if (!draftHasItems()) {
      $('cart-content').innerHTML = `
<div class="bg-surface-container-lowest rounded-xl shadow-sm p-space-2xl flex flex-col items-center text-center gap-space-md">
  <div class="w-14 h-14 rounded-xl bg-surface-container-low flex items-center justify-center"><span class="material-symbols-outlined text-primary">shopping_cart</span></div>
  <h2 class="font-headline-md text-headline-md text-on-surface">Your emergency cart is empty</h2>
  <p class="font-body-md text-body-md text-on-surface-variant max-w-md">Create an emergency and add the departments and equipment the patient needs. They'll appear here for review before the hospital search.</p>
  <a class="inline-flex items-center gap-space-sm px-space-xl py-space-md bg-tertiary text-on-tertiary rounded-full font-label-lg text-label-lg" href="#create"><span class="material-symbols-outlined text-[20px]">add</span>Create Emergency</a>
</div>`;
      return;
    }
    const p = CATALOG.priorities[draft.priority];
    const depts = draft.departments.map(id => DEPTS[id]);
    const equip = draft.equipment.map(id => EQUIP[id]);
    const criteria = depts.length + equip.length;
    const preview = cartPreview();
    const unavailable = [...depts, ...equip].filter(x => x.req && !availabilityText(x).live);
    const conflicts = preview.capable === 0 ? 'No hospital meets all criteria' : unavailable.length ? `${unavailable.length} item${unavailable.length > 1 ? 's' : ''} unavailable` : 'Zero Protocol Conflicts';

    $('cart-content').innerHTML = `
<div class="grid grid-cols-1 lg:grid-cols-3 gap-space-xl items-start">
  <!-- Requisition -->
  <div class="lg:col-span-2 bg-surface-container-lowest rounded-xl shadow-sm overflow-hidden">
    <div class="h-1.5 bg-tertiary"></div>
    <div class="p-space-xl flex flex-col gap-space-xl">
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-space-md">
        <div class="flex items-center gap-space-md flex-wrap">
          <div class="w-12 h-12 rounded-lg bg-tertiary-fixed flex items-center justify-center"><span class="material-symbols-outlined text-tertiary">e911_emergency</span></div>
          <h2 class="font-headline-lg text-headline-lg text-on-surface">Emergency #${esc(draft.ref)}</h2>
          <span class="px-space-sm py-0.5 rounded bg-tertiary-fixed text-tertiary font-telemetry-sm text-telemetry-sm font-semibold uppercase">Pending Hospital Dispatch</span>
        </div>
        <div class="flex items-center gap-space-xs flex-wrap">
          <span class="inline-flex items-center gap-1 px-space-sm py-1 rounded bg-surface-container-low font-label-lg text-label-lg text-on-surface"><span class="material-symbols-outlined text-[16px] text-tertiary">warning</span>${esc(draft.type)}</span>
          <span class="inline-flex items-center gap-1.5 px-space-sm py-1 rounded font-label-lg text-label-lg" style="background:${p.bg};color:${p.color}"><span class="w-2 h-2 rounded-full" style="background:${p.color}"></span>Priority: ${esc(draft.priority)}</span>
        </div>
      </div>
      <div class="flex flex-wrap gap-x-space-xl gap-y-space-xs font-telemetry-sm text-telemetry-sm text-on-surface-variant -mt-space-md">
        <span>Patient age <b class="text-on-surface">${esc(draft.age)}</b></span>
        <span>Beds <b class="text-on-surface">${esc(draft.beds)}</b></span>
        <span>Pickup <b class="text-on-surface">${esc(areaLabel())}</b></span>
        <span>Specialist <b class="text-on-surface">${esc(draftSpecialist() || 'None')}</b></span>
        <a class="text-primary font-semibold" href="#create">Edit</a>
      </div>

      <div class="flex flex-col gap-space-sm">
        <div class="flex items-center justify-between"><div class="flex items-center gap-space-sm"><h3 class="font-headline-md text-headline-md text-on-surface uppercase">Departments</h3>
          <span class="px-space-sm py-0.5 rounded bg-surface-container font-telemetry-sm text-telemetry-sm text-on-surface">${depts.length} Locked</span></div>
          <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant uppercase">Capacity Mandatory</span></div>
        ${depts.map(d => cartItemHTML(d, 'dept')).join('')}
        <a class="flex items-center justify-between gap-space-md rounded-lg px-space-lg py-space-md shadow-sm hover:bg-surface-container-low" href="#create" data-focus="dept-grid">
          <span class="flex items-center gap-space-md"><span class="w-10 h-10 rounded-full bg-surface-container flex items-center justify-center"><span class="material-symbols-outlined text-primary">add</span></span><span class="font-label-lg text-label-lg text-primary">+ Add another department</span></span>
          <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant flex items-center gap-1">Catalog Shortcut [D]<span class="material-symbols-outlined text-[16px]">chevron_right</span></span></a>
      </div>

      <div class="flex flex-col gap-space-sm">
        <div class="flex items-center justify-between"><div class="flex items-center gap-space-sm"><h3 class="font-headline-md text-headline-md text-on-surface uppercase">Major Equipment</h3>
          <span class="px-space-sm py-0.5 rounded bg-surface-container font-telemetry-sm text-telemetry-sm text-on-surface">${equip.length} Locked</span></div>
          <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant uppercase">Hardware Reservation</span></div>
        ${equip.map(e => cartItemHTML(e, 'equip')).join('')}
        <a class="flex items-center justify-between gap-space-md rounded-lg px-space-lg py-space-md shadow-sm hover:bg-surface-container-low" href="#create" data-focus="equip-grid">
          <span class="flex items-center gap-space-md"><span class="w-10 h-10 rounded-full bg-surface-container flex items-center justify-center"><span class="material-symbols-outlined text-primary">add</span></span><span class="font-label-lg text-label-lg text-primary">+ Add equipment</span></span>
          <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant flex items-center gap-1">Equipment Index [E]<span class="material-symbols-outlined text-[16px]">chevron_right</span></span></a>
      </div>

      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-space-sm rounded-lg bg-surface-container-low px-space-lg py-space-md">
        <span class="flex items-center gap-space-sm font-label-lg text-label-lg text-on-surface"><span class="material-symbols-outlined text-primary">verified</span>Clinical Validation: ${criteria} Criteria Locked</span>
        <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">Geo-Boundary: ${esc(areaLabel())} <span class="mx-1">•</span>
          <span class="${conflicts === 'Zero Protocol Conflicts' ? 'text-primary' : 'text-tertiary'} font-semibold">${conflicts}</span></span>
      </div>
    </div>
  </div>

  <!-- Requisition Summary -->
  <aside class="bg-surface-container-lowest rounded-xl shadow-sm p-space-xl flex flex-col gap-space-lg lg:sticky lg:top-24">
    <div class="flex items-center justify-between"><h2 class="font-headline-md text-headline-md text-on-surface">Requisition Summary</h2>
      <span class="px-space-sm py-0.5 rounded bg-surface-container text-primary font-telemetry-sm text-telemetry-sm font-semibold">VERIFIED</span></div>
    <div class="flex flex-col gap-space-md font-body-lg text-body-lg">
      <div class="flex justify-between"><span class="text-on-surface-variant">Selected Departments</span><span class="font-telemetry-md text-telemetry-md text-on-surface">${depts.length} items</span></div>
      <div class="flex justify-between"><span class="text-on-surface-variant">Major Medical Equipment</span><span class="font-telemetry-md text-telemetry-md text-on-surface">${equip.length} units</span></div>
      <div class="flex justify-between"><span class="text-on-surface-variant">Incident Severity Coeff.</span><span class="font-telemetry-md text-telemetry-md" style="color:${p.color}">${p.level}</span></div>
      <div class="flex justify-between"><span class="text-on-surface-variant">Capable Hospitals</span><span class="font-telemetry-md text-telemetry-md ${preview.capable ? 'text-on-surface' : 'text-tertiary'}">${hospitals.length ? `${preview.capable} of ${hospitals.length}` : '…'}</span></div>
      <div class="flex justify-between"><span class="text-on-surface-variant">Expected Response Radius</span><span class="font-telemetry-md text-telemetry-md text-on-surface">${preview.eta ? `&lt; ${preview.eta} min ETA` : '—'}</span></div>
    </div>
    <div class="h-px bg-surface-container-high"></div>
    <div class="flex items-end justify-between">
      <div class="flex flex-col"><span class="font-headline-md text-headline-md text-on-surface">Total Criteria</span><span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">Mandatory allocation</span></div>
      <span class="font-telemetry-lg text-[28px] text-primary">${criteria} Locked</span>
    </div>
    <button class="w-full py-space-lg rounded-lg bg-tertiary hover:bg-tertiary-container text-on-tertiary font-headline-sm text-headline-sm shadow-sm disabled:opacity-60" id="start-search" type="button">Start Searching....</button>
    <div class="flex items-center justify-center gap-space-md font-label-md text-label-md">
      <a class="text-on-surface underline underline-offset-4" href="#dispatch">Cancel &amp; Return to Dashboard</a><span class="text-outline">•</span>
      <button class="font-telemetry-sm text-telemetry-sm text-on-surface-variant hover:text-tertiary" id="clear-cart" type="button">Clear Cart</button>
    </div>
    <div class="rounded-lg bg-surface-container-low px-space-lg py-space-md text-center font-telemetry-sm text-telemetry-sm text-on-surface-variant leading-6">
      Press <span class="px-1.5 py-0.5 rounded bg-surface-container-lowest text-on-surface font-semibold">ENTER ↵</span> to execute hospital search immediately
    </div>
  </aside>
</div>`;
  }

  document.addEventListener('click', (e) => {
    const r = e.target.closest('[data-remove]');
    if (r) {
      const list = r.dataset.kind === 'dept' ? draft.departments : draft.equipment;
      list.splice(list.indexOf(r.dataset.remove), 1);
      saveDraft();
      renderCart();
    }
    if (e.target.closest('#clear-cart')) {
      draft = newDraft(); saveDraft(); syncCreate(); renderCart();
      toast('Cart cleared');
    }
    if (e.target.closest('#start-search')) startSearch();
    const f = e.target.closest('[data-focus]');
    if (f) state.focusAfterRoute = f.dataset.focus;
  });

  async function startSearch() {
    const problems = validateDraft();
    if (problems.length) {
      toast('Cart incomplete', `Add ${problems.join(', ')} first.`, 'warn');
      location.hash = '#create';
      return;
    }
    const btn = $('start-search');
    btn.disabled = true;
    btn.textContent = 'Logging emergency…';

    const keys = draftRequirementKeys();
    const requirements = Object.fromEntries(meta.requirements.map(k => [k, keys.includes(k)]));
    try {
      const { request, warnings } = await api('/api/requests', {
        method: 'POST',
        body: {
          emergency_type: draft.type,
          severity: draft.priority,
          patient_age: Number(draft.age),
          location: { lat: Number(draft.lat), lng: Number(draft.lng) },
          requirements,
          required_specialist: draftSpecialist(),
          beds_required: Number(draft.beds) || 1,
          additional_needs: draftInfoOnly(),
        },
      });
      toast(`#${request.request_id} logged`, `Hospital search queued for ${esc(request.severity)} ${esc(request.emergency_type)}. ${warnings.map(esc).join(' ')}`, warnings.length ? 'warn' : 'success');
      state.highlight = request.request_id;
      draft = newDraft(); saveDraft(); syncCreate();
      location.hash = '#dispatch';
    } catch (err) {
      toast('Could not log emergency', esc((err.details?.length ? err.details : [err.message]).join(' ')), 'critical');
      btn.disabled = false;
      btn.textContent = 'Start Searching....';
    }
  }

  // ───────────── Summary drawer ─────────────
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-summary]');
    if (b) openSummary(b.dataset.summary);
    if (e.target.closest('[data-close-drawer]')) closeSummary();
  });

  async function openSummary(id) {
    $('drawer-title').textContent = `#${id}`;
    $('drawer-body').innerHTML = emptyHTML('Loading…');
    $('drawer').classList.remove('hidden');
    $('drawer').setAttribute('aria-hidden', 'false');
    document.body.classList.add('drawer-open');
    try {
      const r = await api(`/api/requests/${encodeURIComponent(id)}`);
      $('drawer-body').innerHTML = summaryHTML(r);
    } catch (err) {
      $('drawer-body').innerHTML = emptyHTML(`Could not load: ${esc(err.message)}`);
    }
  }
  function closeSummary() {
    $('drawer').classList.add('hidden');
    $('drawer').setAttribute('aria-hidden', 'true');
    document.body.classList.remove('drawer-open');
  }

  const section = (title, inner) => `<div class="flex flex-col gap-space-sm"><h3 class="font-label-md text-label-md text-on-surface-variant uppercase">${title}</h3>${inner}</div>`;
  const kv = (k, v) => `<div class="flex justify-between gap-space-md py-1 border-b border-surface-container-low"><span class="font-body-sm text-body-sm text-on-surface-variant">${k}</span><span class="font-telemetry-md text-telemetry-md text-on-surface text-right">${v}</span></div>`;

  function summaryHTML(r) {
    const needs = Object.entries(r.requirements).filter(([, v]) => v).map(([k]) =>
      `<span class="px-space-sm py-0.5 rounded bg-surface-container font-label-md text-label-md text-on-surface">${fmt.label(k)}</span>`).join('')
      || '<span class="font-body-sm text-body-sm text-on-surface-variant">General bed only</span>';

    const a = r.assignment;
    const facility = a
      ? kv('Hospital', esc(a.hospital_name)) + kv('Distance', `${a.distance_km} km`) + kv(a.transit_source === 'actual' ? 'Transit time' : 'Estimated ETA', `${a.transit_minutes} min`)
      : `<p class="font-body-sm text-body-sm text-on-surface-variant">No hospital assigned yet. Ranking and reservations arrive in the next update.</p>`;

    const timeline = r.workflow.length
      ? r.workflow.map(w => `
        <div class="border border-outline-variant rounded-lg p-space-md flex flex-col gap-space-xs">
          <div class="flex items-center justify-between gap-space-sm">
            <span class="font-label-lg text-label-lg text-on-surface">${esc(w.hospital_name)}</span>
            <span class="font-telemetry-sm text-telemetry-sm font-semibold ${w.hospital_response === 'ACCEPTED' ? 'text-[#065F46]' : w.hospital_response === 'REJECTED' ? 'text-[#991B1B]' : 'text-[#92400E]'}">${w.hospital_response}</span>
          </div>
          ${w.rejection_reason ? `<span class="font-body-sm text-body-sm text-[#991B1B]">Reason: ${esc(w.rejection_reason)}</span>` : ''}
          <div class="grid grid-cols-2 gap-x-space-md font-telemetry-sm text-telemetry-sm text-on-surface-variant">
            <span>Assigned</span><span class="text-right text-on-surface">${fmt.timeIST(w.assignment_time)}</span>
            ${w.departure_time ? `<span>Departed</span><span class="text-right text-on-surface">${fmt.timeIST(w.departure_time)}</span>` : ''}
            ${w.arrival_time ? `<span>Arrived</span><span class="text-right text-on-surface">${fmt.timeIST(w.arrival_time)}</span>` : ''}
            ${w.handover_time ? `<span>Handed over</span><span class="text-right text-on-surface">${fmt.timeIST(w.handover_time)}</span>` : ''}
          </div>
        </div>`).join('')
      : '<p class="font-body-sm text-body-sm text-on-surface-variant">No hospital contacted yet.</p>';

    const resTone = { CONFIRMED: 'active', PENDING: 'warn', FAILED: 'critical', EXPIRED: 'standby', RELEASED: 'standby', CANCELLED: 'standby' };
    const reservations = r.reservations.length
      ? r.reservations.map(x => `
        <div class="flex items-center justify-between gap-space-sm py-1 border-b border-surface-container-low">
          <div class="flex flex-col"><span class="font-telemetry-md text-telemetry-md text-on-surface">${esc(x.reservation_id)} · ${esc(x.resource_type)}</span>
          <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">${esc(x.hospital_name)} · ${fmt.timeIST(x.requested_at)}</span></div>
          <span class="px-space-sm py-0.5 rounded ${TONE[resTone[x.reservation_status] || 'standby'].chip} font-telemetry-sm text-telemetry-sm">${x.reservation_status}</span>
        </div>`).join('')
      : '<p class="font-body-sm text-body-sm text-on-surface-variant">No beds reserved yet.</p>';

    return `
      <div class="flex items-center gap-space-sm flex-wrap">
        <span class="font-label-lg text-label-lg ${isUrgent(r) ? 'text-tertiary' : 'text-primary'}">${esc(r.severity)} ${esc(r.emergency_type)}</span>
        ${statusChip(r)}
      </div>
      ${section('Patient', kv('Patient ID', esc(r.patient_id)) + kv('Age', r.patient_age) + kv('Beds required', r.beds_required) + kv('Logged', fmt.dateTimeIST(r.created_at)) + kv('Waiting', waitText(r.waiting_minutes)))}
      ${section('Pickup location', kv('Coordinates', `${r.location.lat.toFixed(4)}, ${r.location.lng.toFixed(4)}`) +
        `<a class="font-label-md text-label-md text-primary inline-flex items-center gap-space-xs" href="https://www.google.com/maps?q=${r.location.lat},${r.location.lng}" target="_blank" rel="noopener"><span class="material-symbols-outlined text-[16px]">map</span>Open in Google Maps</a>`)}
      ${section('Needs', `<div class="flex flex-wrap gap-space-xs">${needs}</div>` + (r.required_specialist ? kv('Specialist', esc(r.required_specialist)) : ''))}
      ${r.additional_needs?.length ? section('Also requested (notes for hospital)', `<div class="flex flex-wrap gap-space-xs">${r.additional_needs.map(x =>
        `<span class="px-space-sm py-0.5 rounded bg-surface-container-low border border-outline-variant font-label-md text-label-md text-on-surface-variant">${esc(x)}</span>`).join('')}</div>`) : ''}
      ${section('Assigned facility', facility)}
      ${section('Handover timeline', `<div class="flex flex-col gap-space-sm">${timeline}</div>`)}
      ${section('Bed reservations', reservations)}`;
  }

  // ───────────── Routing between the three views ─────────────
  const VIEWS = { dispatch: 'view-dispatch', create: 'view-create', cart: 'view-cart' };
  const ACTIVE_NAV = 'nav-link px-space-md py-space-xs transition-colors rounded bg-primary-container text-on-primary-container font-semibold';
  const IDLE_NAV = 'nav-link px-space-md py-space-xs transition-colors rounded text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low font-label-md text-label-md';

  function route() {
    const view = (location.hash.replace('#', '') || 'dispatch');
    state.view = VIEWS[view] ? view : 'dispatch';
    Object.entries(VIEWS).forEach(([k, id]) => {
      $(id).classList.toggle('hidden', k !== state.view);
      $(id).classList.toggle('flex', k === state.view);
    });
    document.querySelectorAll('#main-nav .nav-link').forEach(a => {
      const on = a.getAttribute('href') === `#${state.view}`;
      a.className = on ? ACTIVE_NAV : IDLE_NAV;
      on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
    });
    closeSummary();
    window.scrollTo(0, 0);

    if (state.view === 'dispatch') loadRecent(true).then(() => {
      if (state.highlight) {
        document.querySelector(`#recent-rows [data-id="${state.highlight}"]`)?.classList.add('row-new');
        state.highlight = null;
      }
    });
    $('create-bar').classList.toggle('hidden', state.view !== 'create');
    if (state.view === 'cart') renderCart();
    if (state.view === 'create') {
      syncCreate();
      const focus = state.focusAfterRoute; state.focusAfterRoute = null;
      setTimeout(() => focus ? $(focus).scrollIntoView({ behavior: 'smooth', block: 'start' }) : (!draft.age && $('f-age').focus()), 60);
    }
  }
  window.addEventListener('hashchange', route);

  // ───────────── Keyboard ─────────────
  document.addEventListener('keydown', (e) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    if (e.key === 'Escape') closeSummary();
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'n') location.hash = '#create';
    if ((k === 'd' || k === 'e') && state.view === 'cart') {
      state.focusAfterRoute = k === 'd' ? 'dept-grid' : 'equip-grid';
      location.hash = '#create';
    }
    if (e.key === 'Enter' && state.view === 'cart' && draftHasItems() && $('drawer').classList.contains('hidden')) {
      e.preventDefault();
      startSearch();
    }
  });

  // ───────────── Live updates (Socket.io) ─────────────
  function setConnection(online) {
    $('conn-dot').className = `w-2 h-2 rounded-full ${online ? 'bg-primary animate-pulse' : 'bg-[#F54B5E]'}`;
    $('conn-text').textContent = online ? 'System Online' : 'Reconnecting…';
    $('feed-state').textContent = online ? 'Connected' : 'Offline';
  }

  if (window.io) {
    const socket = io();
    socket.on('connect', () => setConnection(true));
    socket.on('disconnect', () => setConnection(false));

    socket.on('request:new', (r) => {
      state.todayCount++; renderTodayCount();
      if (state.view === 'dispatch' && !state.recent.ids.has(r.request_id)) {
        state.recent.ids.add(r.request_id);
        const empty = $('recent-rows').querySelector('.req-row') === null;
        if (empty) $('recent-rows').innerHTML = '';
        $('recent-rows').insertAdjacentHTML('afterbegin', rowHTML(r));
        $('recent-rows').firstElementChild.classList.add('row-new');
        state.recent.offset++;
      }
      if (isUrgent(r)) toast(`🚨 New ${r.severity} emergency`, `#${esc(r.request_id)} · ${esc(r.emergency_type)} · age ${r.patient_age}`, 'critical');
    });

    socket.on('request:update', (r) => {
      document.querySelectorAll(`.req-row[data-id="${r.request_id}"]`).forEach(el => { el.outerHTML = rowHTML(r); });
    });

    socket.on('hospital:update', onHospitalUpdate);
  } else {
    setConnection(false);
  }

  // ───────────── Boot ─────────────
  (async () => {
    try {
      meta = await api('/api/requests/meta');
      buildCreate();
    } catch (err) {
      toast('Server unreachable', esc(err.message), 'critical');
    }
    loadHospitals();
    loadTodayCount();
    route();
  })();
})();
