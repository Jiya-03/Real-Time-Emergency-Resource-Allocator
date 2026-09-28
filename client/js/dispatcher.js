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
    active:   { chip: 'bg-surface-container text-on-surface', dot: 'bg-[#36B37E]' },
    standby:  { chip: 'bg-surface-container text-on-surface', dot: 'bg-outline' },
    warn:     { chip: 'bg-surface-container text-on-surface', dot: 'bg-[#D97706]' },
    critical: { chip: 'bg-surface-container text-tertiary', dot: 'bg-tertiary crit-dot' },
  };

  // "Severe Trauma", "Acute Cardiac", "Respiratory Distress"… (clinical wording from the design)
  const TYPE_NOUN = { 'Road Accident': 'Trauma', Cardiac: 'Cardiac', Stroke: 'Stroke', Burn: 'Burns', Respiratory: 'Respiratory Distress', Other: 'Emergency' };
  const SEV_PREFIX = { Critical: 'Severe', High: 'Acute', Moderate: 'Moderate', Low: 'Minor' };
  const clinicalLabel = (r) => `${TYPE_NOUN[r.emergency_type] || r.emergency_type} · ${condOf(r).key}`;

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
      : `<span class="material-symbols-outlined text-outline text-[18px]">local_hospital</span>
         <span class="font-body-md text-body-md text-on-surface-variant">Awaiting hospital match</span>`;
    const transit = a
      ? `<span class="font-telemetry-md text-telemetry-md text-on-surface font-semibold">${a.transit_minutes} min ${a.transit_source === 'actual' ? 'transit' : 'ETA'}</span>
         <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">Distance: ${a.distance_km} km</span>`
      : `<span class="font-telemetry-md text-telemetry-md text-on-surface font-semibold">—</span>
         <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">Waiting ${waitText(r.waiting_minutes)}</span>`;
    return `
<div class="req-row grid grid-cols-1 md:grid-cols-12 gap-space-sm md:gap-space-md px-space-lg py-space-md hover:bg-surface-container-low transition-colors duration-100 items-center border-b border-surface-container-low last:border-b-0 cursor-pointer" data-id="${esc(r.request_id)}" data-summary="${esc(r.request_id)}" role="button" tabindex="0" title="Open summary">
  <div class="md:col-span-3 flex flex-col">
    <div class="flex items-center gap-space-xs flex-wrap">
      <span class="font-telemetry-md text-telemetry-md text-on-surface font-semibold tracking-tight">#${esc(r.request_id)}</span>
      <span class="text-outline-variant font-telemetry-sm text-telemetry-sm">•</span>
      <span class="font-label-md text-label-md ${isUrgent(r) ? 'text-tertiary' : 'text-primary'} font-semibold">${esc(clinicalLabel(r))}</span>
    </div>
    <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant mt-0.5">Logged: ${fmt.timeIST(r.created_at)}</span>
  </div>
  <div class="md:col-span-3 flex items-center gap-space-xs text-on-surface">${facility}</div>
  <div class="md:col-span-2 flex flex-col">${transit}</div>
  <div class="md:col-span-2 flex items-center">${statusChip(r)}</div>
  <div class="hidden md:flex md:col-span-2 items-center justify-end"><span class="material-symbols-outlined text-outline">chevron_right</span></div>
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
  const DRAFT_KEY = 'jeevanroute.draft.v2';
  // The dispatcher rides in Ambulance A-12 (AMB-012 in the dataset): its GPS is the default pickup point
  const AMBULANCE = { name: 'Ambulance A-12 GPS', lat: 18.625969, lng: 73.79929 };
  const byId = (list) => Object.fromEntries(list.map(x => [x.id, x]));
  const DEPTS = byId(CATALOG.departments);
  const EQUIP = byId(CATALOG.equipment);

  function newDraft() {
    return {
      ref: `NEW-${Math.floor(1000 + Math.random() * 9000)}`,
      type: 'Road Accident', priority: 'Critical', age: '', beds: 1,
      area: AMBULANCE.name, lat: AMBULANCE.lat, lng: AMBULANCE.lng,
      report: { bp: '', hr: '', spo2: '', notes: '' },
      departments: [], equipment: [],
    };
  }
  let draft = (() => { try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY)) || newDraft(); } catch { return newDraft(); } })();
  if (!CATALOG.conditions[draft.priority]) draft.priority = CATALOG.conditionForSeverity[draft.priority] || 'Critical';   // older saved drafts
  const saveDraft = () => { try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch {} };
  const draftHasItems = () => draft.departments.length + draft.equipment.length > 0;

  // Requirement keys the backend can match (union of the selected items)
  function draftRequirementKeys() {
    const keys = new Set();
    draft.departments.forEach(id => (DEPTS[id].req || []).forEach(k => keys.add(k)));
    draft.equipment.forEach(id => (EQUIP[id].req || []).forEach(k => keys.add(k)));
    const sev = CATALOG.conditions[draft.priority].severity;
    if (['Critical', 'High'].includes(sev)) (meta?.severity_defaults?.[sev] || []).forEach(k => keys.add(k));
    if (['Respiratory', 'Burn'].includes(draft.type)) keys.add('oxygen');
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
    // don't rebuild the cart while the crew is typing the field report
    if (state.view === 'cart' && !document.activeElement?.closest?.('[data-report]')) renderCart();
  }

  // ───────────── View: Create Emergency (d3) ─────────────
  function buildCreate() {
    $('f-type').innerHTML = meta.emergency_types.map(t => `<option>${esc(t)}</option>`).join('');
    $('f-priority').innerHTML = Object.entries(CATALOG.conditions).map(([k, c]) => `<option value="${k}" title="${c.hint}">${k} · ${c.code}</option>`).join('');
    $('f-area').innerHTML = `<option>${AMBULANCE.name}</option>` + AREAS.map(([n]) => `<option>${n}</option>`).join('')
      + `<option value="__geo">My current location</option><option value="__custom">Custom coordinates…</option>`;
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
    const p = CATALOG.conditions[draft.priority];
    $('priority-pill').style.background = p.bg;
    $('priority-pill').title = `${draft.priority}: ${p.hint}. Click to change.`;
    $('priority-dot').style.background = p.color;
    $('f-priority').style.color = p.color;
    $('priority-caret').style.color = p.color;
  }

  function syncCreate() {
    $('f-type').value = draft.type;
    $('f-priority').value = draft.priority;
    $('f-age').value = draft.age;
    if (draft.area === '__custom' && !$('f-area').querySelector('option[value="__pin"]')) {
      $('f-area').insertAdjacentHTML('afterbegin', '<option value="__pin">Pinned location</option>');
    }
    $('f-area').value = draft.area === '__custom' ? '__pin' : (draft.area || AMBULANCE.name);
    $('f-area').title = draft.lat != null ? `${Number(draft.lat).toFixed(4)}, ${Number(draft.lng).toFixed(4)}` : '';
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
  $('f-area').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === '__pin') return;
    if (v === '__geo') {
      if (!navigator.geolocation) { toast('Location unavailable', 'This browser cannot share location.', 'warn'); return syncCreate(); }
      navigator.geolocation.getCurrentPosition(
        (pos) => { draft.lat = +pos.coords.latitude.toFixed(6); draft.lng = +pos.coords.longitude.toFixed(6); draft.area = '__custom'; syncCreate(); },
        () => { toast('Location blocked', 'Allow location access or pick an area.', 'warn'); syncCreate(); },
        { timeout: 8000 },
      );
      return;
    } else if (v === '__custom') {
      const input = prompt('Enter pickup coordinates as "lat, lng"', draft.lat != null ? `${draft.lat}, ${draft.lng}` : '18.5204, 73.8567');
      const m = input && input.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
      if (m) { draft.lat = Number(m[1]); draft.lng = Number(m[2]); draft.area = '__custom'; }
    } else if (v === AMBULANCE.name) {
      draft.area = v; draft.lat = AMBULANCE.lat; draft.lng = AMBULANCE.lng;
    } else {
      const [, la, ln] = AREAS.find(a => a[0] === v);
      draft.area = v; draft.lat = la; draft.lng = ln;
    }
    syncCreate();
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
    if (draft.lat == null || !capable.length) return { capable: capable.length, inRadius: 0, eta: null };
    const dists = capable.map(h => Geo.roadKm({ lat: draft.lat, lng: draft.lng }, h.location));
    const nearest = Math.min(...dists);
    return { capable: capable.length, inRadius: dists.filter(d => d <= 15).length, eta: Geo.eta(nearest) };
  }

  function cartItemHTML(item, kind) {
    const a = availabilityText(item);
    const code = item.code || item.tag;
    return `
<div class="flex items-center gap-space-md bg-surface-container-low rounded-lg px-space-lg py-space-md">
  <div class="w-11 h-11 rounded-lg bg-surface-container-lowest flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-primary">${item.icon}</span></div>
  <div class="flex flex-col flex-1 min-w-0">
    <div class="flex items-center gap-space-sm flex-wrap"><span class="font-headline-sm text-headline-sm text-on-surface">${esc(item.name)}</span>
    ${code ? `<span class="px-1.5 py-0.5 rounded ${item.req ? 'bg-surface-container text-primary' : 'bg-surface-container-high text-on-surface-variant'} font-telemetry-sm text-telemetry-sm uppercase">${esc(code)}</span>` : ''}</div>
    <span class="font-body-md text-body-md text-on-surface-variant">${esc(item.desc)}</span>
  </div>
  <span class="hidden sm:inline px-space-sm py-1 rounded font-telemetry-sm text-telemetry-sm ${a.live ? 'bg-secondary-container/40 text-primary' : item.req ? 'bg-tertiary-fixed text-tertiary' : 'text-on-surface-variant'}">${a.live || !item.req ? esc(a.text) : 'Unavailable'}</span>
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
    const p = CATALOG.conditions[draft.priority];
    const depts = draft.departments.map(id => DEPTS[id]);
    const equip = draft.equipment.map(id => EQUIP[id]);
    const criteria = depts.length + equip.length;
    const preview = cartPreview();
    const unavailable = [...depts, ...equip].filter(x => x.req && !availabilityText(x).live);
    const conflicts = preview.capable === 0 ? 'No hospital meets all criteria'
      : preview.inRadius === 0 ? 'No capable hospital within 15 km'
      : unavailable.length ? `${unavailable.length} item${unavailable.length > 1 ? 's' : ''} unavailable` : 'Zero Protocol Conflicts';

    $('cart-content').innerHTML = `
<div class="grid grid-cols-1 lg:grid-cols-3 gap-space-xl items-start">
  <!-- Requisition -->
  <div class="lg:col-span-2 bg-surface-container-lowest rounded-xl shadow-sm overflow-hidden">
    <div class="h-1.5 bg-tertiary"></div>
    <div class="p-space-xl flex flex-col gap-space-xl">
      <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-space-md">
        <div class="flex items-center gap-space-md min-w-0">
          <div class="w-11 h-11 rounded-lg bg-tertiary-fixed flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-tertiary">e911_emergency</span></div>
          <h2 class="font-headline-md text-headline-md text-on-surface whitespace-nowrap">Emergency #${esc(draft.ref)}</h2>
          <span class="px-space-sm py-0.5 rounded bg-tertiary-fixed text-tertiary font-telemetry-sm text-telemetry-sm font-semibold uppercase whitespace-nowrap">Pending Hospital Dispatch</span>
        </div>
        <div class="flex items-center gap-space-xs shrink-0">
          <span class="inline-flex items-center gap-1 px-space-sm py-1 rounded bg-surface-container-low font-label-lg text-label-lg text-on-surface"><span class="material-symbols-outlined text-[16px] text-tertiary">warning</span>${esc(TYPE_NOUN[draft.type] || draft.type)}</span>
          <span class="inline-flex items-center gap-1.5 px-space-sm py-1 rounded font-label-lg text-label-lg" style="background:${p.bg};color:${p.color}"><span class="w-2 h-2 rounded-full" style="background:${p.color}"></span>${esc(draft.priority)} · ${p.code}</span>
        </div>
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

      <details class="rounded-lg border border-surface-container-high px-space-lg py-space-md" ${draft.report && (draft.report.bp || draft.report.hr || draft.report.spo2 || draft.report.notes) ? 'open' : ''}>
        <summary class="cursor-pointer list-none flex items-center justify-between font-headline-sm text-headline-sm text-on-surface"><span class="flex items-center gap-space-xs"><span class="material-symbols-outlined text-primary">ecg</span>Field Report <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">(optional · sent to the hospital)</span></span><span class="material-symbols-outlined">expand_more</span></summary>
        <div class="grid grid-cols-3 gap-space-md mt-space-md">
          <label class="flex flex-col gap-space-xs"><span class="font-label-md text-label-md text-on-surface-variant uppercase">BP (mmHg)</span><input class="bg-surface-container-low rounded-lg px-space-md py-space-sm font-telemetry-md text-telemetry-md border-0 focus:outline-none focus:ring-2 focus:ring-[#18B9B5]" data-report="bp" placeholder="120/80" value="${esc(draft.report?.bp || '')}"></label>
          <label class="flex flex-col gap-space-xs"><span class="font-label-md text-label-md text-on-surface-variant uppercase">Heart rate</span><input class="bg-surface-container-low rounded-lg px-space-md py-space-sm font-telemetry-md text-telemetry-md border-0 focus:outline-none focus:ring-2 focus:ring-[#18B9B5]" data-report="hr" inputmode="numeric" placeholder="bpm" value="${esc(draft.report?.hr || '')}"></label>
          <label class="flex flex-col gap-space-xs"><span class="font-label-md text-label-md text-on-surface-variant uppercase">SpO₂ %</span><input class="bg-surface-container-low rounded-lg px-space-md py-space-sm font-telemetry-md text-telemetry-md border-0 focus:outline-none focus:ring-2 focus:ring-[#18B9B5]" data-report="spo2" inputmode="numeric" placeholder="98" value="${esc(draft.report?.spo2 || '')}"></label>
        </div>
        <label class="flex flex-col gap-space-xs mt-space-md"><span class="font-label-md text-label-md text-on-surface-variant uppercase">Paramedic notes</span><textarea class="bg-surface-container-low rounded-lg px-space-md py-space-sm font-body-md text-body-md border-0 focus:outline-none focus:ring-2 focus:ring-[#18B9B5]" data-report="notes" maxlength="600" rows="2" placeholder="Mechanism, interventions on scene, anything the ED team must prepare for…">${esc(draft.report?.notes || '')}</textarea></label>
      </details>

      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-space-sm rounded-lg bg-surface-container-low px-space-lg py-space-md">
        <span class="flex items-center gap-space-sm font-label-lg text-label-lg text-on-surface"><span class="material-symbols-outlined text-primary">verified</span>Clinical Validation: ${criteria} Criteria Locked</span>
        <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant" title="Pickup: ${esc(areaLabel())}">Geo-Boundary: 15km Radius <span class="mx-1">•</span>
          <span class="${conflicts === 'Zero Protocol Conflicts' ? 'text-primary' : 'text-tertiary'} font-semibold">${conflicts}</span></span>
      </div>
    </div>
  </div>

  <!-- Requisition Summary -->
  <aside class="bg-surface-container-lowest rounded-xl shadow-sm p-space-xl flex flex-col gap-space-lg lg:sticky lg:top-24">
    <div class="flex items-center justify-between"><h2 class="font-headline-md text-headline-md text-on-surface">Requisition Summary</h2>
      <span class="px-space-sm py-0.5 rounded bg-surface-container text-primary font-telemetry-sm text-telemetry-sm font-semibold">VERIFIED</span></div>
    <div class="flex flex-col gap-space-md font-body-md text-body-md">
      <div class="flex justify-between"><span class="text-on-surface-variant">Selected Departments</span><span class="font-telemetry-md text-telemetry-md text-on-surface">${depts.length} items</span></div>
      <div class="flex justify-between"><span class="text-on-surface-variant">Major Medical Equipment</span><span class="font-telemetry-md text-telemetry-md text-on-surface">${equip.length} units</span></div>
      <div class="flex justify-between"><span class="text-on-surface-variant">Incident Severity Coeff.</span><span class="font-telemetry-md text-telemetry-md" style="color:${p.color}">${p.level}</span></div>
      <div class="flex justify-between"><span class="text-on-surface-variant">Expected Response Radius</span><span class="font-telemetry-md text-telemetry-md text-on-surface">${preview.eta ? `&lt; ${preview.eta} min ETA` : '—'}</span></div>
    </div>
    <div class="h-px bg-surface-container-high"></div>
    <div class="flex items-end justify-between">
      <div class="flex flex-col"><span class="font-headline-md text-headline-md text-on-surface">Total Criteria</span><span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">Mandatory allocation</span></div>
      <span class="font-telemetry-lg text-[28px] text-primary">${criteria} Locked</span>
    </div>
    <button class="w-full py-space-lg rounded-lg bg-tertiary hover:bg-tertiary-container text-on-tertiary font-headline-sm text-headline-sm shadow-sm disabled:opacity-60" id="start-search" type="button">Start Searching....</button>
    <p class="-mt-space-sm text-center font-body-sm text-body-sm text-on-surface-variant flex items-center justify-center gap-space-xs"><span class="material-symbols-outlined text-[16px] text-primary">campaign</span>Alerts every suitable hospital at once. The first to accept gets the patient.</p>
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

  document.addEventListener('input', (e) => {
    const f = e.target.closest('[data-report]'); if (!f) return;
    draft.report = draft.report || {};
    draft.report[f.dataset.report] = f.value;
    saveDraft();
  });

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
          severity: CATALOG.conditions[draft.priority].severity,
          patient_condition: draft.priority,
          patient_age: Number(draft.age),
          location: { lat: Number(draft.lat), lng: Number(draft.lng) },
          requirements,
          required_specialist: draftSpecialist(),
          beds_required: Number(draft.beds) || 1,
          additional_needs: draftInfoOnly(),
          field_report: (() => {
            const rp = draft.report || {};
            const out = {};
            if (rp.bp) out.bp = rp.bp.trim();
            if (rp.hr) out.hr = Number(rp.hr);
            if (rp.spo2) out.spo2 = Number(rp.spo2);
            if (rp.notes && rp.notes.trim()) out.notes = rp.notes.trim();
            return Object.keys(out).length ? out : null;
          })(),
        },
      });
      if (warnings.length) toast(`#${request.request_id} logged`, warnings.map(esc).join(' '), 'warn');
      draft = newDraft(); saveDraft(); syncCreate();
      btn.textContent = 'Alerting suitable hospitals…';
      rememberHold(request.request_id);
      try {
        const bc = await api(`/api/requests/${encodeURIComponent(request.request_id)}/broadcast`, { method: 'POST' });
        waveToasted[request.request_id] = bc.wave;
        toast(`🚨 Alert sent to ${bc.sent_to.length} hospital${bc.sent_to.length > 1 ? 's' : ''}`, `First to accept gets #${esc(request.request_id)}. They have ${bc.hold_minutes} min.`, 'success');
      } catch (err) {
        toast('No hospital could be alerted', esc(err.message), 'critical');
      }
      location.hash = `#live/${encodeURIComponent(request.request_id)}`;    // real map + live hospital responses
    } catch (err) {
      toast('Could not log emergency', esc((err.details?.length ? err.details : [err.message]).join(' ')), 'critical');
      btn.disabled = false;
      btn.textContent = 'Start Searching....';
    }
  }

  // ───────────── View: Hospital Match (ranking results) ─────────────
  state.match = { id: null, data: null, changed: new Set() };

  async function openMatch(id, { rerun = false, keepHold = false } = {}) {
    state.match = { id, data: null, changed: new Set() };
    if (!keepHold) { state.bc = null; renderBroadcast(); }
    $('match-back').href = `#live/${encodeURIComponent(id)}`;
    $('match-content').innerHTML = emptyHTML('Ranking hospitals…');
    try {
      const request = await api(`/api/requests/${encodeURIComponent(id)}`);
      state.bc = request;
      let result;
      if (request.status === 'ASSIGNED' || request.status === 'IN_TRANSIT' || request.status === 'COMPLETED') rerun = false;
      if (rerun || request.status === 'CREATED') {
        result = await api(`/api/requests/${encodeURIComponent(id)}/match`, { method: 'POST' });
      } else {
        const saved = await api(`/api/requests/${encodeURIComponent(id)}/rankings`);
        if (!saved.rankings.length && ['MATCHING', 'NO_MATCH'].includes(request.status)) {
          result = await api(`/api/requests/${encodeURIComponent(id)}/match`, { method: 'POST' });
        } else {
          result = { request, rankings: saved.rankings, summary: summarize(saved.rankings), saved: true };
        }
      }
      state.match.data = result;
      renderMatch();
      renderBroadcast();
    } catch (err) {
      $('match-content').innerHTML = emptyHTML(`Could not rank hospitals: ${esc(err.message)}`);
    }
  }

  function summarize(rankings) {
    const eligible = rankings.filter(r => r.eligible);
    return {
      evaluated: rankings.length,
      eligible: eligible.length,
      best: eligible[0] ? { hospital_name: eligible[0].hospital_name, eta_min: eligible[0].eta_min } : null,
      stale_in_results: rankings.filter(r => r.freshness?.status === 'stale').length,
    };
  }

  // Saved rows don't store the travel part: recover it from the final score
  function parts(r) {
    const raw = r.eligible ? r.scores.final : r.scores.final / 0.3;
    const travel = r.scores.travel ?? Math.max(0, (raw - 0.5 * r.scores.resource - 0.2 * r.scores.freshness) / 0.3);
    return { resource: 0.5 * r.scores.resource, travel: 0.3 * travel, freshness: 0.2 * r.scores.freshness, raw };
  }

  const FRESH_CHIP = {
    fresh: ['bg-secondary-container/40 text-primary', 'Fresh'],
    aging: ['bg-[#FFFBEB] text-[#92400E]', 'Aging'],
    stale: ['bg-tertiary-fixed text-tertiary', 'STALE'],
  };

  function matchCardHTML(r, isBest) {
    const f = r.freshness || { status: 'fresh', age_minutes: 0 };
    const [fc, fl] = FRESH_CHIP[f.status] || FRESH_CHIP.fresh;
    const p = parts(r);
    const pct = (x) => `${Math.max(0, Math.min(100, x * 100)).toFixed(1)}%`;
    const reasons = r.missing?.length ? r.missing : (!r.eligible ? [r.explanation.replace(/^INELIGIBLE: /, '').split('. ')[0]] : []);
    return `
<div class="bg-surface-container-lowest rounded-xl shadow-sm p-space-lg flex flex-col gap-space-md border-2 ${isBest ? 'border-[#006765]' : 'border-transparent'} ${r.eligible ? '' : 'opacity-80'}" data-match-hospital="${r.hospital_id}">
  <div class="flex items-start justify-between gap-space-md">
    <div class="flex items-start gap-space-md min-w-0">
      <div class="w-11 h-11 rounded-lg ${isBest ? 'bg-primary text-on-primary' : 'bg-surface-container-low text-on-surface'} flex items-center justify-center shrink-0 font-telemetry-lg text-telemetry-lg">${r.rank}</div>
      <div class="flex flex-col min-w-0 gap-space-xs">
        <div class="flex items-center gap-space-sm flex-wrap">
          <span class="font-headline-sm text-headline-sm text-on-surface">${esc(r.hospital_name)}</span>
          ${isBest ? '<span class="px-space-sm py-0.5 rounded bg-primary text-on-primary font-telemetry-sm text-telemetry-sm font-semibold">BEST MATCH</span>' : ''}
          <span class="px-space-sm py-0.5 rounded font-telemetry-sm text-telemetry-sm font-semibold ${r.eligible ? 'bg-surface-container text-primary' : 'bg-tertiary-fixed text-tertiary'}">${r.eligible ? 'ELIGIBLE' : 'NOT SUITABLE'}</span>
          <span class="px-space-sm py-0.5 rounded font-telemetry-sm text-telemetry-sm ${fc}" title="Availability data is ${Math.round(f.age_minutes)} min old">${fl} · ${Math.round(f.age_minutes)} min</span>
          ${r.is_nearest ? '<span class="px-space-sm py-0.5 rounded bg-surface-container-low font-telemetry-sm text-telemetry-sm text-on-surface-variant">NEAREST</span>' : ''}
        </div>
        <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">${esc(r.hospital_type || '')} · ${r.distance_km} km · ~${Math.round(r.eta_min)} min ETA${r.primary_bed ? ` · ${esc(r.primary_bed.label)} free: ${r.primary_bed.available}` : ''}</span>
      </div>
    </div>
    <div class="flex flex-col items-end shrink-0">
      <span class="font-telemetry-lg text-telemetry-lg ${r.eligible ? 'text-primary' : 'text-on-surface-variant'}">${r.scores.final.toFixed(3)}</span>
      <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">suitability</span>
    </div>
  </div>
  <div class="flex flex-col gap-space-xs">
    <div class="h-2.5 w-full rounded-full bg-surface-container-low overflow-hidden flex" title="Resource ${p.resource.toFixed(2)} + Travel ${p.travel.toFixed(2)} + Freshness ${p.freshness.toFixed(2)}">
      <span class="h-full bg-primary" style="width:${pct(p.resource)}"></span>
      <span class="h-full bg-[#18B9B5]" style="width:${pct(p.travel)}"></span>
      <span class="h-full ${f.status === 'stale' ? 'bg-tertiary' : 'bg-[#6fd7d3]'}" style="width:${pct(p.freshness)}"></span>
    </div>
    <div class="flex flex-wrap gap-x-space-lg gap-y-1 font-telemetry-sm text-telemetry-sm text-on-surface-variant">
      <span><span class="inline-block w-2 h-2 rounded-full bg-primary mr-1"></span>Resource ${r.scores.resource.toFixed(2)}</span>
      <span><span class="inline-block w-2 h-2 rounded-full bg-[#18B9B5] mr-1"></span>Travel ${(p.travel / 0.3).toFixed(2)}</span>
      <span><span class="inline-block w-2 h-2 rounded-full ${f.status === 'stale' ? 'bg-tertiary' : 'bg-[#6fd7d3]'} mr-1"></span>Freshness ${r.scores.freshness.toFixed(2)}</span>
      ${r.eligible ? '' : '<span class="text-tertiary">× 0.3 ineligibility penalty</span>'}
    </div>
  </div>
  ${reasons.length ? `<div class="flex flex-wrap gap-space-xs">${reasons.map(x => `<span class="px-space-sm py-0.5 rounded bg-tertiary-fixed text-tertiary font-label-md text-label-md">${esc(x)}</span>`).join('')}</div>` : ''}
  ${r.eligible && f.status === 'stale' ? '<div class="font-body-sm text-body-sm text-tertiary flex items-center gap-space-xs"><span class="material-symbols-outlined text-[16px]">warning</span>Availability data is stale. Confirm with the hospital before dispatch.</div>' : ''}
  <details class="group"><summary class="cursor-pointer font-label-md text-label-md text-primary list-none flex items-center gap-1"><span class="material-symbols-outlined text-[16px] group-open:rotate-90 transition-transform">chevron_right</span>Why this rank?</summary>
    <p class="mt-space-xs font-telemetry-sm text-telemetry-sm text-on-surface-variant leading-5">${esc(r.explanation)}</p></details>
  ${r.eligible ? `<div class="flex justify-end" data-bc-status="${r.hospital_id}"></div>` : ''}
</div>`;
  }

  function renderMatch() {
    const { data } = state.match;
    if (!data) return;
    const req = data.request;
    const s = data.summary;
    const eligible = data.rankings.filter(r => r.eligible);
    const others = data.rankings.filter(r => !r.eligible);
    const pr = condOf(req);
    if (!data.rankings.length) {
      $('match-sub').textContent = `#${req.request_id} · ${clinicalLabel(req)}`;
      $('match-content').innerHTML = emptyHTML('No ranking is stored for this request.');
      return;
    }
    $('match-sub').innerHTML = `#${esc(req.request_id)} · <span style="color:${pr.color}" class="font-semibold">${esc(clinicalLabel(req))}</span> · patient age ${req.patient_age}`;

    const stat = (label, value, tone = 'text-on-surface') =>
      `<div class="flex flex-col"><span class="font-label-md text-label-md text-on-surface-variant uppercase">${label}</span><span class="font-telemetry-lg text-telemetry-lg ${tone}">${value}</span></div>`;

    $('match-content').innerHTML = `
<div class="flex flex-col gap-space-xl">
  <div class="bg-surface-container-lowest rounded-xl shadow-sm px-space-xl py-space-lg grid grid-cols-2 md:grid-cols-4 gap-space-lg">
    ${stat('Evaluated', s.evaluated)}
    ${stat('Eligible', s.eligible, s.eligible ? 'text-primary' : 'text-tertiary')}
    ${stat('Best ETA', s.best ? `${Math.round(s.best.eta_min)} min` : '—')}
    ${stat('Stale in results', s.stale_in_results, s.stale_in_results ? 'text-tertiary' : 'text-on-surface')}
  </div>
  ${eligible.length ? '' : `<div class="rounded-lg border border-[#F87171] bg-[#FEF2F2] px-space-lg py-space-md text-[#991B1B] font-body-md text-body-md">
     <b>No hospital can meet every requirement right now.</b> Remove a non-critical requirement in the cart, or re-run the match when availability changes.</div>`}
  <div class="flex flex-col gap-space-md">${eligible.map((r, i) => matchCardHTML(r, i === 0)).join('')}</div>
  ${others.length ? `<details class="flex flex-col gap-space-md" ${eligible.length ? '' : 'open'}>
    <summary class="cursor-pointer font-headline-sm text-headline-sm text-on-surface-variant list-none flex items-center gap-space-xs"><span class="material-symbols-outlined">expand_more</span>Not suitable (${others.length}), shown for transparency</summary>
    <div class="flex flex-col gap-space-md mt-space-md">${others.map(r => matchCardHTML(r, false)).join('')}</div></details>` : ''}
  <p class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">Score = 0.5 × resource match + 0.3 × travel + 0.2 × data freshness. Ineligible hospitals × 0.3. ${data.saved ? 'Showing the saved ranking.' : `Ranked ${fmt.timeIST(s.ranked_at || new Date().toISOString())}.`}</p>
</div>`;
  }


  function onHospitalChangeForMatch() { /* broadcast re-ranks by itself; no manual refresh needed */ }

  // ───────────── Broadcast: every suitable hospital is alerted at once ─────────────
  // state.bc = GET /api/requests/:id (request + reservations + workflow). First hospital to accept wins;
  // the server withdraws the rest and alerts the next wave automatically if everyone declines.
  state.bc = null;
  // Emergencies THIS dispatcher sent (only these raise accept/decline toasts)
  const MINE_KEY = 'jeevanroute.myHolds';
  const myHolds = new Set((() => { try { return JSON.parse(sessionStorage.getItem(MINE_KEY)) || []; } catch { return []; } })());
  const rememberHold = (id) => { myHolds.add(id); try { sessionStorage.setItem(MINE_KEY, JSON.stringify([...myHolds])); } catch {} };
  const waveToasted = {};
  let bcTimer = null;

  function mmss(sec) { const s = Math.max(0, Math.round(sec)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }

  async function loadBroadcast(id) {
    try { state.bc = await api(`/api/requests/${encodeURIComponent(id)}`); } catch { return; }
    if (state.match.data) state.match.data.request = { ...state.match.data.request, status: state.bc.status };
    renderBroadcast();
  }

  // One entry per contacted hospital with its current answer
  function bcModel(d, rankings = state.match.data?.rankings || []) {
    const byH = new Map();
    for (const w of d.workflow || []) byH.set(w.hospital_id, { w });          // ordered by assignment_time → latest contact wins
    const rank = Object.fromEntries(rankings.map(r => [r.hospital_id, r]));
    const list = [...byH.entries()].map(([hid, o]) => {
      let res = (d.reservations || []).filter(x => x.hospital_id === hid && x.requested_at >= o.w.assignment_time);
      if (!res.length) res = (d.reservations || []).filter(x => x.hospital_id === hid);
      const st = res.map(x => x.reservation_status);
      const resp = o.w.hospital_response;
      const state_ = resp === 'ACCEPTED' ? 'accepted' : resp === 'PENDING' ? (st.includes('PENDING') ? 'waiting' : 'closed')
        : resp === 'WITHDRAWN' ? 'withdrawn' : st.includes('EXPIRED') ? 'expired' : st.includes('FAILED') ? 'nobed' : 'declined';
      return { hid, name: o.w.hospital_name, w: o.w, res, state: state_, rank: rank[hid],
               expires: res.find(x => x.reservation_status === 'PENDING')?.expires_at,
               confirmed: res.find(x => x.reservation_status === 'CONFIRMED'),
               at: res.map(x => x.confirmed_at || x.requested_at).filter(Boolean).sort().pop() || o.w.assignment_time };
    });
    const order = { accepted: 0, waiting: 1, declined: 2, nobed: 2, expired: 3, withdrawn: 4, closed: 5 };
    list.sort((a, b) => order[a.state] - order[b.state] || (a.rank?.rank ?? 99) - (b.rank?.rank ?? 99));
    return { list, acc: list.find(o => o.state === 'accepted'), waiting: list.filter(o => o.state === 'waiting'), wave: d.broadcast_round || 0 };
  }

  const BC_CHIP = {
    accepted: ['bg-[#10B981] text-white', '✓ ACCEPTED'],
    waiting: ['bg-tertiary-fixed text-tertiary', '● Waiting for response'],
    declined: ['bg-surface-container text-on-surface-variant', '✕ Declined'],
    nobed: ['bg-surface-container text-on-surface-variant', '✕ Bed gone'],
    expired: ['bg-[#FFFBEB] text-[#92400E]', '⏱ No answer'],
    withdrawn: ['bg-surface-container-low text-on-surface-variant', 'Withdrawn'],
    closed: ['bg-surface-container-low text-on-surface-variant', 'Closed'],
  };
  const bcChip = (o) => { const [c, t] = BC_CHIP[o.state]; return `<span class="px-space-sm py-0.5 rounded font-telemetry-sm text-telemetry-sm font-semibold ${c}">${t}</span>`; };
  function bcLine(o, m) {
    if (o.state === 'waiting') return `<span class="text-tertiary">Deciding · <b data-bc-cd="${esc(o.expires)}">--:--</b> left</span>`;
    if (o.state === 'accepted') return `<span class="text-[#047857]">Accepted ${fmt.timeIST(o.at)} · resources locked</span>`;
    if (o.state === 'declined') return `Declined${o.w.rejection_reason ? ` · ${esc(o.w.rejection_reason)}` : ''}`;
    if (o.state === 'nobed') return 'Last bed was taken before they could accept';
    if (o.state === 'expired') return 'Did not answer in time';
    if (o.state === 'withdrawn') return m.acc ? `Filled by ${esc(m.acc.name)}` : 'Cancelled by dispatcher';
    return '—';
  }

  function renderBroadcast() {
    clearInterval(bcTimer);
    const panel = $('hold-panel');
    const d = state.bc;
    document.querySelectorAll('[data-bc-status]').forEach(el => { el.innerHTML = ''; });
    if (!d) { panel.innerHTML = ''; return; }
    const m = bcModel(d);
    const st = d.status;
    const open = ['CREATED', 'MATCHING', 'NO_MATCH'].includes(st);

    // status chip on each ranking card
    const byId = Object.fromEntries(m.list.map(o => [o.hid, o]));
    document.querySelectorAll('[data-bc-status]').forEach(el => {
      const o = byId[el.dataset.bcStatus];
      el.innerHTML = o ? `<span class="inline-flex items-center gap-space-sm">${bcChip(o)}${o.state === 'waiting' ? `<span class="font-telemetry-sm text-telemetry-sm text-tertiary" data-bc-cd="${esc(o.expires)}">--:--</span>` : ''}</span>`
        : m.list.length ? '<span class="px-space-sm py-0.5 rounded bg-surface-container-low text-on-surface-variant font-telemetry-sm text-telemetry-sm">Not alerted</span>' : '';
    });

    if (!m.list.length) {
      panel.innerHTML = open ? `
<div class="rounded-xl border-2 border-tertiary bg-surface-container-lowest px-space-xl py-space-lg flex flex-col md:flex-row md:items-center justify-between gap-space-md">
  <div class="flex items-center gap-space-md"><span class="material-symbols-outlined text-[28px] text-tertiary">campaign</span>
    <div class="flex flex-col"><span class="font-headline-sm text-headline-sm text-on-surface">No hospital has been alerted yet</span>
    <span class="font-body-md text-body-md text-on-surface-variant">Sends this emergency to every eligible hospital below at once. The first to accept gets the patient; the rest are withdrawn automatically.</span></div></div>
  <button class="inline-flex items-center gap-space-sm px-space-lg py-space-md rounded-lg bg-tertiary hover:bg-tertiary-container text-on-tertiary font-label-lg text-label-lg shrink-0" data-broadcast type="button"><span class="material-symbols-outlined text-[18px]">campaign</span>Alert all suitable hospitals</button>
</div>` : '';
      return;
    }

    const n = { contacted: m.list.length, waiting: m.waiting.length, accepted: m.acc ? 1 : 0, declined: m.list.filter(o => ['declined', 'nobed', 'expired'].includes(o.state)).length };
    let banner;
    if (m.acc) {
      const w = m.acc.w;
      const stage = w.handover_status === 'COMPLETED' ? 'done' : w.arrival_time ? 'arrived' : w.departure_time ? 'enroute' : 'assigned';
      const [title, sub] = {
        assigned: [`Hospital confirmed: ${esc(m.acc.name)}`, `Bed locked. ${m.list.filter(o => o.state === 'withdrawn').length} other hospital(s) withdrawn automatically. Start transport when the patient is loaded.`],
        enroute: [`Ambulance en route to ${esc(m.acc.name)}`, 'The hospital sees your live ETA and is preparing the bay.'],
        arrived: [`Arrived at ${esc(m.acc.name)}`, 'Waiting for the hospital team to complete the clinical handover.'],
        done: [`Handed over at ${esc(m.acc.name)}`, 'Patient admitted. This emergency is COMPLETED.'],
      }[stage];
      const actions = {
        assigned: `${m.acc.confirmed ? `<button class="px-space-lg py-space-sm rounded-lg border border-outline-variant font-label-lg text-label-lg text-on-surface hover:bg-surface-container-low" data-cancel-hold="${esc(m.acc.confirmed.reservation_id)}" type="button">Release bed</button>` : ''}
          <button class="inline-flex items-center gap-space-sm px-space-lg py-space-sm rounded-lg bg-primary text-on-primary font-label-lg text-label-lg" data-handoff="depart" type="button"><span class="material-symbols-outlined text-[18px]">local_shipping</span>Depart · En route</button>`,
        enroute: `<button class="inline-flex items-center gap-space-sm px-space-lg py-space-sm rounded-lg bg-primary text-on-primary font-label-lg text-label-lg" data-handoff="arrive" type="button"><span class="material-symbols-outlined text-[18px]">where_to_vote</span>Arrived at hospital</button>`,
        arrived: '<span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">Handover in progress…</span>',
        done: '<a class="inline-flex items-center gap-space-sm px-space-lg py-space-sm rounded-lg bg-primary text-on-primary font-label-lg text-label-lg" href="#dispatch">Back to dashboard</a>',
      }[stage];
      banner = `<div class="rounded-lg border border-[#6EE7B7] bg-[#ECFDF5] px-space-lg py-space-md flex flex-col md:flex-row md:items-center justify-between gap-space-md">
        <div class="flex items-center gap-space-md"><span class="material-symbols-outlined text-[28px] text-[#047857]">${stage === 'done' ? 'task_alt' : stage === 'assigned' ? 'verified' : 'local_shipping'}</span>
          <div class="flex flex-col"><span class="font-headline-sm text-headline-sm text-[#065F46] uppercase">${title}</span><span class="font-body-md text-body-md text-on-surface-variant">${sub}</span></div></div>
        <div class="flex items-center gap-space-md shrink-0">${actions}</div></div>`;
    } else if (m.waiting.length) {
      const soonest = m.waiting.map(o => o.expires).filter(Boolean).sort()[0];
      banner = `<div class="rounded-lg border border-[#FCD34D] bg-[#FFFBEB] px-space-lg py-space-md flex flex-col md:flex-row md:items-center justify-between gap-space-md">
        <div class="flex items-center gap-space-md"><span class="w-10 h-10 rounded-full bg-tertiary text-on-tertiary flex items-center justify-center shrink-0 animate-pulse"><span class="material-symbols-outlined">campaign</span></span>
          <div class="flex flex-col"><span class="font-headline-sm text-headline-sm text-[#92400E]">Alert sent to ${m.waiting.length} hospital${m.waiting.length > 1 ? 's' : ''}${m.wave > 1 ? ` · wave ${m.wave}` : ''}. Waiting for the first to accept</span>
          <span class="font-body-md text-body-md text-on-surface-variant">No bed is locked until a hospital accepts, so nothing is blocked for other patients. If everyone declines, the next suitable hospitals are alerted automatically.</span></div></div>
        <div class="flex items-center gap-space-md shrink-0"><span class="font-telemetry-lg text-telemetry-lg text-[#92400E]" data-bc-cd="${esc(soonest || '')}">--:--</span>
          <button class="px-space-lg py-space-sm rounded-lg border border-outline-variant font-label-lg text-label-lg text-on-surface hover:bg-surface-container-low" data-withdraw type="button">Cancel all</button></div></div>`;
    } else {
      const noMore = st === 'NO_MATCH';
      banner = `<div class="rounded-lg border border-[#F87171] bg-[#FEF2F2] px-space-lg py-space-md flex flex-col md:flex-row md:items-center justify-between gap-space-md">
        <div class="flex items-center gap-space-md"><span class="material-symbols-outlined text-[28px] text-tertiary">${noMore ? 'error' : 'block'}</span>
          <div class="flex flex-col"><span class="font-headline-sm text-headline-sm text-[#991B1B]">${noMore ? 'No suitable hospital accepted and none are left to alert' : 'No hospital is currently deciding'}</span>
          <span class="font-body-md text-body-md text-on-surface-variant">${noMore ? 'Relax a non-critical requirement in the cart, or alert again when availability changes.' : 'Alert the remaining suitable hospitals.'}</span></div></div>
        ${open ? '<button class="inline-flex items-center gap-space-sm px-space-lg py-space-sm rounded-lg bg-tertiary text-on-tertiary font-label-lg text-label-lg shrink-0" data-broadcast type="button"><span class="material-symbols-outlined text-[18px]">campaign</span>Re-rank &amp; alert again</button>' : ''}</div>`;
    }

    const rows = m.list.map(o => `
      <div class="rounded-lg border ${o.state === 'accepted' ? 'border-[#6EE7B7] bg-[#F0FDF9]' : o.state === 'waiting' ? 'border-[#F87171]/40' : 'border-surface-container-high opacity-80'} px-space-md py-space-sm flex flex-col gap-space-xs">
        <div class="flex items-start justify-between gap-space-sm"><span class="font-label-lg text-label-lg text-on-surface">${o.rank ? `<span class="text-on-surface-variant font-telemetry-sm">#${o.rank.rank}</span> ` : ''}${esc(o.name)}</span>${bcChip(o)}</div>
        <div class="flex flex-wrap gap-space-xs">${[...new Set(o.res.map(x => `${x.quantity}× ${x.resource_type}`))].map(t => `<span class="px-space-sm py-0.5 rounded font-telemetry-sm text-telemetry-sm ${o.state === 'accepted' ? 'bg-secondary-container/40 text-primary' : 'bg-surface-container-low text-on-surface-variant'}">${esc(t)}${o.state === 'accepted' ? ' reserved ✓' : ''}</span>`).join('')}
          ${o.rank ? `<span class="px-space-sm py-0.5 rounded bg-surface-container-low font-telemetry-sm text-telemetry-sm text-on-surface-variant">${o.rank.distance_km} km · ~${Math.round(o.rank.eta_min)} min</span>` : ''}</div>
        <div class="flex items-center justify-between font-telemetry-sm text-telemetry-sm text-on-surface-variant"><span>${bcLine(o, m)}</span><span>Updated ${fmt.timeIST(o.at)}</span></div>
      </div>`).join('');

    panel.innerHTML = `
<a class="bg-surface-container-lowest rounded-xl shadow-sm px-space-lg py-space-md flex items-center justify-between gap-space-md flex-wrap hover:bg-surface-container-low" href="#live/${encodeURIComponent(d.request_id)}">
  <span class="font-label-lg text-label-lg flex items-center gap-space-sm">${m.acc ? `<span class="material-symbols-outlined text-[#047857]">check_circle</span>${esc(m.acc.name)} accepted` : m.waiting.length ? `<span class="material-symbols-outlined text-tertiary">campaign</span>Waiting for ${m.waiting.length} hospital${m.waiting.length > 1 ? 's' : ''} · <b data-bc-cd="${esc(m.waiting.map(o => o.expires).filter(Boolean).sort()[0] || '')}">--:--</b>` : '<span class="material-symbols-outlined text-on-surface-variant">info</span>No hospital is deciding right now'}</span>
  <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">${n.contacted} contacted · ${n.waiting} waiting · ${n.accepted} accepted</span>
  <span class="inline-flex items-center gap-space-xs font-label-lg text-label-lg text-primary">Open live map<span class="material-symbols-outlined text-[18px]">arrow_forward</span></span>
</a>`;

    const tick = () => document.querySelectorAll('[data-bc-cd]').forEach(el => { if (el.dataset.bcCd) el.textContent = mmss((new Date(el.dataset.bcCd) - Date.now()) / 1000); });
    tick(); bcTimer = setInterval(tick, 1000);
  }

  async function sendBroadcast(btn) {
    const id = state.match.id; if (!id) return;
    if (btn) { btn.disabled = true; btn.lastChild.textContent = 'Alerting…'; }
    rememberHold(id);
    try {
      const bc = await api(`/api/requests/${encodeURIComponent(id)}/broadcast`, { method: 'POST' });
      waveToasted[id] = bc.wave;
      toast(`🚨 Alert sent to ${bc.sent_to.length} hospital${bc.sent_to.length > 1 ? 's' : ''}`, `First to accept gets #${esc(id)}.`, 'success');
      await openMatch(id);
    } catch (err) {
      toast('Could not alert hospitals', esc(err.message), 'critical');
      await openMatch(id);
    }
  }

  async function withdrawAll() {
    try {
      await api(`/api/requests/${encodeURIComponent(state.match.id)}/withdraw`, { method: 'POST' });
      toast('Request withdrawn', 'Every hospital that was deciding has been told to stand down.', 'info');
    } catch (err) { toast('Could not cancel', esc(err.message), 'critical'); }
    loadBroadcast(state.match.id);
  }

  async function cancelHold(reservationId) {
    try {
      await api(`/api/reservations/${encodeURIComponent(reservationId)}/cancel`, { method: 'POST' });
      toast('Bed released', 'The bed is available to other patients again.', 'info');
    } catch (err) { toast('Could not release', esc(err.message), 'critical'); }
    loadBroadcast(state.match.id);
  }

  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-cancel-hold]'); if (c) cancelHold(c.dataset.cancelHold);
    const hf = e.target.closest('[data-handoff]'); if (hf) doHandoff(hf.dataset.handoff, hf);
    const bb = e.target.closest('[data-broadcast]'); if (bb && !bb.disabled) sendBroadcast(bb);
    if (e.target.closest('[data-withdraw]')) withdrawAll();
  });

  async function doHandoff(step, btn) {
    btn.disabled = true;
    try {
      const res = await api(`/api/requests/${encodeURIComponent(state.match.id)}/handoff`, { method: 'POST', body: { step } });
      toast(step === 'depart' ? 'En route' : 'Arrived', step === 'depart' ? `${esc(res.hospital_name)} is tracking your ETA.` : 'The hospital team has been notified to take over.', 'success');
    } catch (err) { toast('Could not update', esc(err.message), 'critical'); btn.disabled = false; }
    loadBroadcast(state.match.id);
  }

  function onHandoffUpdate(p) {
    if (state.view === 'live' && state.dl.id === p.request.request_id) loadLive();
    if (state.view === 'match' && state.match.id === p.request.request_id) loadBroadcast(p.request.request_id);
    if (!myHolds.has(p.request.request_id)) return;
    if (p.step === 'complete') toast('✅ Handover complete', `${esc(p.hospital_name)} admitted #${esc(p.request.request_id)}.`, 'success');
    if (p.step === 'arrive' && p.workflow) toast('Arrival logged by hospital', `#${esc(p.request.request_id)} at ${esc(p.hospital_name)}.`, 'info');
  }

  // Live: a hospital answered / timed out / was withdrawn / next wave sent
  function onReservationUpdate(p) {
    const id = p.request?.request_id; if (!id) return;
    if (state.view === 'live' && state.dl.id === id) {
      loadLive();
    }
    if (state.view === 'match' && state.match.id === id) {
      if (p.action === 'held' && p.auto && waveToasted[id] !== p.wave) openMatch(id);    // new wave → fresh ranking + panel
      else loadBroadcast(id);
    }
    if (!myHolds.has(id)) return;
    if (p.action === 'accepted') toast(`✅ ${p.hospital_name} accepted`, `#${esc(id)} is ASSIGNED.${p.withdrawn?.length ? ` ${p.withdrawn.length} other hospital(s) withdrawn.` : ''}`, 'success');
    if (p.action === 'rejected') toast(`${p.hospital_name} declined`, `#${esc(id)}${p.reason ? ` · ${esc(p.reason)}` : ''}${p.still_waiting ? `. ${p.still_waiting > 1 ? 'Others are' : 'One other is'} still deciding.` : '.'}`, p.still_waiting ? 'warn' : 'critical');
    if (p.action === 'expired') toast('No answer', `${esc(p.hospital_name)} did not answer #${esc(id)} in time.`, 'warn');
    if (p.action === 'held' && p.auto && waveToasted[id] !== p.wave) { waveToasted[id] = p.wave; toast(`🚨 Wave ${p.wave}: alerting more hospitals`, `Everyone contacted for #${esc(id)} declined, so the next suitable hospitals were alerted automatically.`, 'warn'); }
    if (p.action === 'exhausted') toast('No hospital left to alert', `#${esc(id)}: relax a requirement or alert again later.`, 'critical');
  }

  // ───────────── View: Live Route (real map + hospital requests + live updates) ─────────────
  // Before a hospital accepts: the pickup point and every alerted hospital on a real street map.
  // As soon as one accepts: the ONE road route to that hospital (OSRM), turn-by-turn guidance and the
  // ambulance position: from the device GPS when enabled, otherwise a simulated drive after "Depart".
  // The position is streamed to the server so the hospital's Live Route map moves in real time.
  state.dl = { id: null, detail: null, rankings: [], map: null, route: null, routeFor: null, routing: false,
               gps: false, watchId: null, fix: null, lastEmit: 0, events: {}, fitted: false };

  const MAP_TONE = { accepted: 'accepted', waiting: 'waiting', declined: 'declined', nobed: 'declined', expired: 'declined', withdrawn: 'declined', closed: 'declined' };
  const hospLoc = (hid) => {
    const r = state.dl.rankings.find(x => x.hospital_id === hid)?.location || hospitals.find(h => h.hospital_id === hid)?.location;
    return r ? [r.lat, r.lng] : null;
  };
  const shortHosp = (n = '') => n.replace(/\s+(Multispeciality|Multi-speciality)?\s*(Hospital|Medical Centre|Centre|Center)$/i, '');
  const unitName = (id) => id ? `A-${String(parseInt(id.replace(/\D/g, ''), 10)).padStart(2, '0')}` : 'A-12';
  const liveEvent = (id, text, tone = '') => { (state.dl.events[id] ||= []).push([new Date().toISOString(), text, tone]); };

  function resetLive() {
    stopGps(false);
    if (state.dl.map) { state.dl.map.destroy(); }
    Object.assign(state.dl, { id: null, detail: null, rankings: [], map: null, route: null, routeFor: null, routing: false, fix: null, fitted: false });
  }

  async function openLive(id) {
    if (state.dl.id !== id) { resetLive(); state.dl.id = id; }
    $('dlive-rank-link').href = `#match/${encodeURIComponent(id)}`;
    await loadLive();
  }

  async function loadLive() {
    const id = state.dl.id; if (!id) return;
    try {
      const [detail, rk] = await Promise.all([
        api(`/api/requests/${encodeURIComponent(id)}`),
        api(`/api/requests/${encodeURIComponent(id)}/rankings`).catch(() => ({ rankings: [] })),
      ]);
      if (state.dl.id !== id) return;
      state.dl.detail = detail; state.dl.rankings = rk.rankings || [];
    } catch (err) {
      $('dlive-panel').innerHTML = emptyHTML(`Could not load #${esc(id)}: ${esc(err.message)}`); return;
    }
    renderLive();
  }

  // Where things stand for this emergency
  function liveModel() {
    const d = state.dl.detail; if (!d) return null;
    const m = bcModel(d, state.dl.rankings);
    const acc = m.acc;
    const w = acc?.w || {};
    const phase = !acc ? (m.waiting.length ? 'waiting' : 'none') : w.handover_status === 'COMPLETED' ? 'done' : w.arrival_time ? 'arrived' : w.departure_time ? 'enroute' : 'preparing';
    const rank = acc && state.dl.rankings.find(x => x.hospital_id === acc.hid);
    const rt = state.dl.routeFor === acc?.hid ? state.dl.route : null;
    const driveMin = rank ? Math.max(1, Math.round(rank.eta_min)) : rt?.duration_min || (rt ? Math.round(rt.distance_km / 28 * 60 + 2) : null);
    return { d, m, acc, w, phase, rank, rt, driveMin, pickup: [d.location.lat, d.location.lng], dest: acc ? hospLoc(acc.hid) : null };
  }

  // Ambulance position right now + remaining distance/time
  function ambulanceNow(L_) {
    const { phase, rt, w, driveMin, pickup, dest } = L_;
    if (!rt || phase === 'waiting' || phase === 'none' || phase === 'preparing') {
      const at = state.dl.gps && state.dl.fix ? state.dl.fix.latlng : pickup;
      return { latlng: at, frac: 0, left_km: rt?.distance_km ?? null, left_min: driveMin, source: state.dl.gps && state.dl.fix ? 'gps' : 'standby' };
    }
    if (phase === 'arrived' || phase === 'done') return { latlng: dest || rt.coords[rt.coords.length - 1], frac: 1, left_km: 0, left_min: 0, source: 'arrived' };
    if (state.dl.gps && state.dl.fix) {
      const s = LiveMap.snap(rt, state.dl.fix.latlng);
      const left_min = Math.max(0, Math.round(driveMin * (1 - s.frac)));
      return { latlng: state.dl.fix.latlng, frac: s.frac, left_km: Math.round(rt.distance_km * (1 - s.frac) * 10) / 10, left_min, off_km: s.off_route_km, done_km: rt.distance_km * s.frac, source: 'gps' };
    }
    const frac = Math.min(0.98, Math.max(0, (Date.now() - new Date(w.departure_time)) / (driveMin * 60000)));
    const p = LiveMap.pointAt(rt, frac);
    return { latlng: p.latlng, frac, left_km: Math.round(rt.distance_km * (1 - frac) * 10) / 10, left_min: Math.max(1, Math.ceil(driveMin * (1 - frac))), done_km: rt.distance_km * frac, source: 'simulated' };
  }

  function ambLabel(L_, pos) {
    const to = esc(shortHosp(L_.acc?.name || '').toUpperCase());
    const st = { none: 'AWAITING HOSPITAL', waiting: `AWAITING CONFIRMATION (${L_.m.waiting.length} ALERTED)`, preparing: `READY · ROUTE TO ${to}`,
                 enroute: `EN ROUTE TO ${to} (ETA ${pos.left_min} MIN)`, arrived: `ARRIVED AT ${to}`, done: `HANDED OVER AT ${to}` }[L_.phase];
    return `Ambulance ${esc(unitName(L_.d.ambulance_id))} · <span class="lm-state">● ${st}</span>`;
  }

  function renderLive() {
    const L_ = liveModel(); if (!L_) return;
    const { d, m } = L_;
    const pr = condOf(d);
    $('dlive-title').innerHTML = `<span class="text-tertiary font-semibold">✱ EMERGENCY #${esc(d.request_id)}</span><span class="text-on-surface">· ${esc(clinicalLabel(d))}</span>`;
    $('dlive-sub').innerHTML = `Logged ${fmt.timeIST(d.created_at)} · age ${d.patient_age} · <span style="color:${pr.color}">${esc(pr.key)} · ${pr.code}</span>`;
    const mine = [...myHolds].filter(x => x !== d.request_id).slice(-4);
    $('dlive-switch').innerHTML = mine.length ? `<span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant self-center">Your other emergencies:</span>${mine.map(x => `<a class="px-space-md py-space-xs rounded-full bg-surface-container-low hover:bg-surface-container font-label-md text-label-md" href="#live/${encodeURIComponent(x)}">#${esc(x)}</a>`).join('')}` : '';
    $('dlive-panel').innerHTML = livePanelHTML(L_);
    $('dlive-log').innerHTML = liveLogHTML(L_);
    $('dlive-log').scrollTop = $('dlive-log').scrollHeight;
    drawLiveMap(L_);
  }

  function livePanelHTML(L_) {
    const { d, m, acc, phase } = L_;
    const n = { contacted: m.list.length, waiting: m.waiting.length, accepted: acc ? 1 : 0, declined: m.list.filter(o => ['declined', 'nobed', 'expired'].includes(o.state)).length };
    const pos = ambulanceNow(L_);
    let banner = '';
    if (acc) {
      const actions = {
        preparing: `<button class="py-space-sm rounded-lg bg-primary text-on-primary font-label-lg text-label-lg flex items-center justify-center gap-space-xs" data-live-handoff="depart" type="button"><span class="material-symbols-outlined text-[18px]">local_shipping</span>Depart · Start navigation</button>`,
        enroute: `<button class="py-space-sm rounded-lg bg-primary text-on-primary font-label-lg text-label-lg flex items-center justify-center gap-space-xs" data-live-handoff="arrive" type="button"><span class="material-symbols-outlined text-[18px]">where_to_vote</span>Arrived at hospital</button>`,
        arrived: '<span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant text-center">Hospital team is completing the handover…</span>',
        done: '<a class="py-space-sm rounded-lg bg-surface-container-low font-label-lg text-label-lg text-center" href="#dispatch">Back to dashboard</a>',
      }[phase];
      banner = `
<div class="rounded-lg border border-[#6EE7B7] bg-[#ECFDF5] p-space-md flex flex-col gap-space-sm">
  <span class="font-label-lg text-label-lg text-[#065F46] flex items-center gap-space-xs uppercase"><span class="material-symbols-outlined text-[20px]">check_circle</span>Hospital confirmed: ${esc(acc.name)}</span>
  <span class="font-label-lg text-label-lg text-on-surface flex items-center gap-space-xs uppercase"><span class="w-2 h-2 rounded-full ${phase === 'enroute' ? 'bg-primary animate-pulse' : 'bg-[#10B981]'}"></span>${{ preparing: 'Route ready · depart when loaded', enroute: 'Ambulance en route', arrived: 'Ambulance arrived', done: 'Patient handed over' }[phase]}</span>
  ${d.admission?.room ? `<div class="rounded bg-surface-container-lowest px-space-md py-space-sm flex items-center gap-space-sm font-body-sm text-body-sm"><span class="material-symbols-outlined text-primary text-[18px]">bed</span><span><b>${esc(d.admission.ward)}</b> · Block ${esc(d.admission.block)} · ${esc(d.admission.floor)} · Room <b>${esc(d.admission.room)}</b> · Bed <b>${esc(d.admission.bed)}</b></span></div>` : ''}
  <div class="rounded bg-surface-container-lowest px-space-md py-space-sm flex items-center justify-between gap-space-sm">
    <span class="font-body-md text-body-md">Destination: <b>${esc(acc.name)}</b></span>
    <span class="px-space-sm py-0.5 rounded bg-secondary-container/40 text-primary font-telemetry-sm text-telemetry-sm shrink-0" id="dlive-eta">${phase === 'enroute' ? `ETA: ${pos.left_min} min` : phase === 'preparing' ? `${L_.rt ? `${L_.rt.distance_km} km · ` : ''}~${L_.driveMin} min` : phase === 'done' ? 'Closed' : 'Docked'}</span>
  </div>
  ${actions}
</div>`;
    } else if (m.waiting.length) {
      const soonest = m.waiting.map(o => o.expires).filter(Boolean).sort()[0];
      banner = `<div class="rounded-lg border border-[#FCD34D] bg-[#FFFBEB] p-space-md flex flex-col gap-space-xs">
        <span class="font-label-lg text-label-lg text-[#92400E] flex items-center gap-space-xs uppercase"><span class="material-symbols-outlined text-[20px]">campaign</span>Alert sent to ${m.waiting.length} hospital${m.waiting.length > 1 ? 's' : ''}</span>
        <span class="font-body-sm text-body-sm text-on-surface-variant">Waiting for the first to accept · <b data-bc-cd="${esc(soonest || '')}">--:--</b>. The route appears on the map the moment one accepts.</span>
        <button class="self-start mt-space-xs px-space-md py-space-xs rounded-lg border border-outline-variant font-label-md text-label-md bg-surface-container-lowest" data-live-withdraw type="button">Cancel all</button></div>`;
    } else if (['CREATED', 'MATCHING', 'NO_MATCH'].includes(d.status)) {
      banner = `<div class="rounded-lg border border-[#F87171] bg-[#FEF2F2] p-space-md flex flex-col gap-space-sm">
        <span class="font-label-lg text-label-lg text-[#991B1B]">${m.list.length ? 'No hospital is deciding right now' : 'No hospital alerted yet'}</span>
        <button class="py-space-sm rounded-lg bg-tertiary text-on-tertiary font-label-lg text-label-lg flex items-center justify-center gap-space-xs" data-live-broadcast type="button"><span class="material-symbols-outlined text-[18px]">campaign</span>${m.list.length ? 'Re-rank & alert again' : 'Alert all suitable hospitals'}</button></div>`;
    }
    const cards = m.list.map(o => `
      <div class="rounded-lg border ${o.state === 'accepted' ? 'border-[#6EE7B7] bg-[#F0FDF9]' : 'border-surface-container-high'} p-space-md flex flex-col gap-space-sm ${['withdrawn', 'closed'].includes(o.state) ? 'opacity-75' : ''}">
        <div class="flex items-start justify-between gap-space-sm"><span class="font-label-lg text-label-lg">${esc(o.name)}</span>${bcChip(o)}</div>
        <div class="flex flex-wrap gap-space-xs">${[...new Set(o.res.map(x => x.resource_type))].map(t => `<span class="px-space-sm py-0.5 rounded font-telemetry-sm text-telemetry-sm ${o.state === 'accepted' ? 'bg-secondary-container/40 text-primary' : 'bg-surface-container-low text-on-surface-variant'}">${esc(t)} ${o.state === 'accepted' ? 'Reserved ✓' : '✓'}</span>`).join('')}
          ${o.rank ? `<span class="px-space-sm py-0.5 rounded bg-surface-container-low font-telemetry-sm text-telemetry-sm text-on-surface-variant">${o.rank.distance_km} km</span>` : ''}</div>
        <div class="flex items-center justify-between font-telemetry-sm text-telemetry-sm text-on-surface-variant gap-space-sm"><span>${bcLine(o, m)}</span><span class="shrink-0">Updated ${fmt.timeIST(o.at).replace(' IST', '')}</span></div>
      </div>`).join('');
    return `
<h2 class="font-headline-md text-headline-md">Hospital Requests</h2>
<div class="rounded-lg bg-surface-container-low px-space-md py-space-sm flex items-center justify-between gap-space-sm font-telemetry-sm text-telemetry-sm">
  <span><b>${n.contacted}</b> Contacted</span><span class="text-tertiary"><b>${n.waiting}</b> Waiting</span>${n.declined ? `<span><b>${n.declined}</b> Declined</span>` : ''}<span class="text-[#047857]"><b>${n.accepted}</b> Accepted</span>
</div>
${banner}
<div class="flex flex-col gap-space-sm">${cards || '<span class="font-body-sm text-body-sm text-on-surface-variant">No hospital contacted yet.</span>'}</div>`;
  }

  function liveLogHTML(L_) {
    const { d, m, acc, w } = L_;
    const rows = [[d.created_at, `Emergency logged · ${d.emergency_type} · ${condOf(d).key} (${condOf(d).code}) · Ambulance ${unitName(d.ambulance_id)}`, '']];
    const waves = {};
    for (const o of m.list) (waves[o.w.assignment_time] ||= []).push(o);
    Object.entries(waves).forEach(([at, list]) => {
      rows.push([at, list.length > 1 ? `Request sent to ${list.length} hospitals: ${list.map(o => shortHosp(o.name)).join(', ')}` : `Request sent to ${list[0].name}`, '']);
      for (const o of list) {
        if (o.state === 'declined' || o.state === 'nobed') rows.push([null, `${o.name} declined${o.w.rejection_reason ? ` (${o.w.rejection_reason})` : ''}`, 'bad', at]);
        if (o.state === 'expired') rows.push([null, `${o.name} did not answer in time`, 'bad', o.expires || at]);
      }
    });
    if (acc) {
      rows.push([acc.confirmed?.confirmed_at || acc.at, `${acc.name} accepted & locked resources`, 'ok']);
      const stood = m.list.filter(o => o.state === 'withdrawn').length;
      if (stood) rows.push([acc.confirmed?.confirmed_at || acc.at, `${stood} other hospital${stood > 1 ? 's' : ''} stood down automatically`, '']);
      if (L_.rt) rows.push([acc.confirmed?.confirmed_at || acc.at, `Route generated automatically · ${L_.rt.distance_km} km${L_.rt.source === 'osrm' ? ' by road' : ' (estimate)'} to ${shortHosp(acc.name)}`, 'ok']);
    }
    if (w.departure_time) rows.push([w.departure_time, `Ambulance ${unitName(d.ambulance_id)} departed · navigation active`, 'ok']);
    if (w.arrival_time) rows.push([w.arrival_time, `Arrived at ${acc.name}`, 'ok']);
    const adm = d.admission;
    if (adm?.room) rows.push([adm.admitted_at || adm.updated_at, `Bed allocated: ${adm.ward} · Block ${adm.block} · ${adm.floor} · Room ${adm.room} · Bed ${adm.bed}${adm.attending ? ` · ${adm.attending}` : ''}`, 'ok']);
    if (w.handover_time) rows.push([w.handover_time, 'Handover completed · patient admitted', 'ok']);
    for (const e of state.dl.events[d.request_id] || []) rows.push(e);
    rows.sort((a, b) => new Date(a[0] || a[3]) - new Date(b[0] || b[3]));
    const tone = { ok: 'text-[#047857]', bad: 'text-tertiary', '': 'text-on-surface' };
    return rows.map(([t, text, k]) => `<div class="flex gap-space-md"><span class="text-on-surface-variant shrink-0 w-10">${t ? fmt.timeIST(t).replace(' IST', '') : '··:··'}</span><span class="${tone[k] || ''}">${esc(text)}</span></div>`).join('');
  }

  function drawLiveMap(L_) {
    if (!LiveMap.available()) { $('dlive-nomap').classList.remove('hidden'); $('dlive-nomap').classList.add('flex'); $('dlive-caption').textContent = 'Map unavailable'; return; }
    if (!state.dl.map) {
      state.dl.map = LiveMap.create($('dlive-map'), { center: L_.pickup, zoom: 13 });
      setTimeout(() => state.dl.map?.invalidate(), 50);
    }
    const map = state.dl.map;
    const near = AREAS.map(a => [a[0], LiveMap.km(L_.pickup, [a[1], a[2]])]).sort((a, b) => a[1] - b[1])[0];
    map.setPickup(L_.pickup, `Pickup${near && near[1] < 3 ? ` · ${near[0]}` : ''}`);
    const shown = L_.m.list.length ? L_.m.list.map(o => ({ id: o.hid, name: shortHosp(o.name), latlng: hospLoc(o.hid), tone: MAP_TONE[o.state] }))
      : state.dl.rankings.filter(r => r.eligible).slice(0, 6).map(r => ({ id: r.hospital_id, name: shortHosp(r.hospital_name), latlng: hospLoc(r.hospital_id), tone: 'standby' }));
    // once accepted, only the chosen hospital stays prominent
    map.setHospitals(L_.acc ? shown.filter(h => h.id === L_.acc.hid) : shown);

    if (L_.acc && L_.dest && state.dl.routeFor !== L_.acc.hid && !state.dl.routing) {
      state.dl.routing = true;
      const hid = L_.acc.hid;
      LiveMap.route(L_.pickup, L_.dest).then(rt => {
        state.dl.routing = false;
        if (state.dl.id !== L_.d.request_id) return;
        state.dl.route = rt; state.dl.routeFor = hid; state.dl.fitted = false;
        renderLive();
      });
    }
    if (L_.rt) map.setRoute(L_.rt, { active: L_.phase !== 'done' }); else map.setRoute(null);
    if (!state.dl.fitted) {
      state.dl.fitted = true;
      map.fit(L_.rt ? L_.rt.coords : [L_.pickup, ...shown.map(h => h.latlng)], 70);
    }
    liveTick(true);
  }

  // every second: move the ambulance, update ETA / next turn, stream the position to the hospital
  function liveTick(force = false) {
    if (state.view !== 'live' || !state.dl.detail) return;
    const L_ = liveModel(); if (!L_) return;
    const pos = ambulanceNow(L_);
    const map = state.dl.map;
    if (map) {
      map.setAmbulance(pos.latlng, ambLabel(L_, pos));
      if (L_.rt) map.setProgress(L_.rt, pos.frac);
      if (L_.phase === 'enroute' && !force) map.follow(pos.latlng);
    }
    const acc = L_.acc;
    $('dlive-caption').textContent = acc
      ? (L_.rt ? `Automated route active: ${acc.name} (${L_.rt.distance_km} km · ${L_.phase === 'enroute' ? 'High-priority navigation active' : L_.phase === 'preparing' ? 'depart to start navigation' : 'route complete'})` : `Calculating road route to ${acc.name}…`)
      : L_.m.waiting.length ? `Pickup point shown · ${L_.m.waiting.length} alerted hospital(s) on the map · route appears when one accepts` : 'Pickup point and suitable hospitals';
    const eta = $('dlive-eta'); if (eta && L_.phase === 'enroute') eta.textContent = `ETA: ${pos.left_min} min`;

    // turn-by-turn card
    const nav = $('dlive-nav');
    if (L_.rt && ['preparing', 'enroute'].includes(L_.phase)) {
      const step = LiveMap.nextStep(L_.rt, pos.done_km || 0);
      const src = pos.source === 'gps' ? `GPS live${state.dl.fix?.acc ? ` · ±${Math.round(state.dl.fix.acc)} m` : ''}` : pos.source === 'simulated' ? 'Simulated drive (turn on GPS for real position)' : 'Waiting to depart';
      nav.innerHTML = `
        <div class="flex items-center justify-between gap-space-sm"><span class="font-telemetry-sm text-telemetry-sm opacity-80 uppercase">Next</span><span class="font-telemetry-sm text-telemetry-sm text-[#6fd7d3]">${step && step.in_km > 0.05 ? (step.in_km < 1 ? `in ${Math.round(step.in_km * 1000 / 10) * 10} m` : `in ${step.in_km.toFixed(1)} km`) : 'now'}</span></div>
        <div class="font-headline-sm text-headline-sm flex items-center gap-space-xs"><span class="material-symbols-outlined text-[22px] text-[#6fd7d3]">${/left/.test(step?.text) ? 'turn_left' : /right/.test(step?.text) ? 'turn_right' : /Arrive/.test(step?.text) ? 'flag' : /roundabout/.test(step?.text) ? 'roundabout_right' : 'straight'}</span><span>${esc(step?.text || 'Follow the route')}</span></div>
        <div class="flex items-center justify-between font-telemetry-sm text-telemetry-sm"><span>${pos.left_km ?? '—'} km left · ~${pos.left_min ?? '—'} min</span><span class="opacity-80">${esc(src)}</span></div>
        ${pos.off_km > 0.3 ? `<div class="font-telemetry-sm text-telemetry-sm text-[#ffb3b4]">You are ${pos.off_km.toFixed(1)} km off the route</div>` : ''}`;
      nav.classList.remove('hidden'); nav.classList.add('flex');
    } else { nav.classList.add('hidden'); nav.classList.remove('flex'); }

    // stream to the hospital (every 3 s while driving)
    if (L_.phase === 'enroute' && state.socket && Date.now() - state.dl.lastEmit > 3000) {
      state.dl.lastEmit = Date.now();
      state.socket.emit('ambulance:position', { request_id: L_.d.request_id, hospital_id: acc.hid, lat: pos.latlng[0], lng: pos.latlng[1],
        source: pos.source === 'gps' ? 'gps' : 'simulated', accuracy_m: state.dl.fix?.acc, left_km: pos.left_km, eta_min: pos.left_min });
    }
  }
  setInterval(() => liveTick(), 1000);

  // Device GPS (navigator.geolocation). Needs https or localhost + the browser's permission.
  function startGps() {
    if (!('geolocation' in navigator)) { toast('GPS not available', 'This browser has no location support.', 'warn'); return; }
    state.dl.gps = true; renderGpsBtn();
    state.dl.watchId = navigator.geolocation.watchPosition(
      (p) => {
        const first = !state.dl.fix;
        state.dl.fix = { latlng: [p.coords.latitude, p.coords.longitude], acc: p.coords.accuracy, at: Date.now() };
        if (first && state.dl.id) { liveEvent(state.dl.id, `Device GPS locked (±${Math.round(p.coords.accuracy)} m)`, 'ok'); renderLive(); state.dl.map?.follow(state.dl.fix.latlng); }
        renderGpsBtn();
      },
      (err) => { toast('GPS unavailable', esc(err.message || 'Permission denied'), 'warn'); stopGps(); },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
  }
  function stopGps(render = true) {
    if (state.dl.watchId != null) navigator.geolocation.clearWatch(state.dl.watchId);
    state.dl.watchId = null; state.dl.gps = false; state.dl.fix = null;
    if (render) renderGpsBtn();
  }
  function renderGpsBtn() {
    const b = $('gps-btn'); const on = state.dl.gps;
    b.className = `inline-flex items-center gap-space-xs px-space-md py-space-xs rounded-lg border font-label-md text-label-md ${on ? 'border-[#6EE7B7] bg-[#ECFDF5] text-[#065F46]' : 'border-outline-variant bg-surface-container-lowest'}`;
    b.innerHTML = `<span class="material-symbols-outlined text-[16px]">${on ? 'gps_fixed' : 'my_location'}</span><span>${on ? (state.dl.fix ? `GPS live ±${Math.round(state.dl.fix.acc)} m · Stop` : 'Finding GPS… · Stop') : 'Use device GPS'}</span>`;
  }
  $('gps-btn').addEventListener('click', () => state.dl.gps ? stopGps() : startGps());
  $('dlive-fit').addEventListener('click', () => { state.dl.fitted = false; const L_ = liveModel(); if (L_) drawLiveMap(L_); });

  document.addEventListener('click', async (e) => {
    const hf = e.target.closest('[data-live-handoff]');
    if (hf) {
      hf.disabled = true;
      try {
        const res = await api(`/api/requests/${encodeURIComponent(state.dl.id)}/handoff`, { method: 'POST', body: { step: hf.dataset.liveHandoff } });
        toast(hf.dataset.liveHandoff === 'depart' ? 'Navigation started' : 'Arrived', hf.dataset.liveHandoff === 'depart' ? `${esc(res.hospital_name)} is tracking you live.` : 'The hospital team has been notified.', 'success');
      } catch (err) { toast('Could not update', esc(err.message), 'critical'); }
      loadLive();
    }
    if (e.target.closest('[data-live-withdraw]')) {
      try { await api(`/api/requests/${encodeURIComponent(state.dl.id)}/withdraw`, { method: 'POST' }); toast('Request withdrawn', 'Every hospital that was deciding has been told to stand down.', 'info'); }
      catch (err) { toast('Could not cancel', esc(err.message), 'critical'); }
      loadLive();
    }
    const lb = e.target.closest('[data-live-broadcast]');
    if (lb) {
      lb.disabled = true; rememberHold(state.dl.id);
      try { const bc = await api(`/api/requests/${encodeURIComponent(state.dl.id)}/broadcast`, { method: 'POST' }); waveToasted[state.dl.id] = bc.wave; toast(`🚨 Alert sent to ${bc.sent_to.length} hospital(s)`, 'First to accept gets the patient.', 'success'); }
      catch (err) { toast('Could not alert hospitals', esc(err.message), 'critical'); }
      state.dl.fitted = false; loadLive();
    }
  });

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
        <span class="font-label-lg text-label-lg ${isUrgent(r) ? 'text-tertiary' : 'text-primary'}">${esc(clinicalLabel(r))}</span>
        ${statusChip(r)}
      </div>
      ${section('Patient', kv('Patient ID', esc(r.patient_id)) + kv('Age', r.patient_age) + kv('Beds required', r.beds_required) + kv('Logged', fmt.dateTimeIST(r.created_at)) + kv('Waiting', waitText(r.waiting_minutes)))}
      ${section('Pickup location', kv('Coordinates', `${r.location.lat.toFixed(4)}, ${r.location.lng.toFixed(4)}`) +
        `<a class="font-label-md text-label-md text-primary inline-flex items-center gap-space-xs" href="https://www.google.com/maps?q=${r.location.lat},${r.location.lng}" target="_blank" rel="noopener"><span class="material-symbols-outlined text-[16px]">map</span>Open in Google Maps</a>`)}
      ${section('Needs', `<div class="flex flex-wrap gap-space-xs">${needs}</div>` + (r.required_specialist ? kv('Specialist', esc(r.required_specialist)) : ''))}
      ${r.additional_needs?.length ? section('Also requested (notes for hospital)', `<div class="flex flex-wrap gap-space-xs">${r.additional_needs.map(x =>
        `<span class="px-space-sm py-0.5 rounded bg-surface-container-low border border-outline-variant font-label-md text-label-md text-on-surface-variant">${esc(x)}</span>`).join('')}</div>`) : ''}
      ${section('Assigned facility', facility)}
      <a class="inline-flex items-center justify-center gap-space-sm px-space-lg py-space-sm rounded-lg bg-primary text-on-primary font-label-lg text-label-lg" href="#live/${encodeURIComponent(r.request_id)}"><span class="material-symbols-outlined text-[18px]">map</span>Open live map</a>
      ${section('Handover timeline', `<div class="flex flex-col gap-space-sm">${timeline}</div>`)}
      ${section('Bed reservations', reservations)}`;
  }

  // ───────────── Routing between the three views ─────────────
  const VIEWS = { dispatch: 'view-dispatch', create: 'view-create', cart: 'view-cart', match: 'view-match', live: 'view-live' };
  const ACTIVE_NAV = 'nav-link px-space-md py-space-xs transition-colors rounded bg-primary-container text-on-primary-container font-semibold';
  const IDLE_NAV = 'nav-link px-space-md py-space-xs transition-colors rounded text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low font-label-md text-label-md';

  function route() {
    const [view, param] = (location.hash.replace('#', '') || 'dispatch').split('/');
    state.view = VIEWS[view] ? view : 'dispatch';
    Object.entries(VIEWS).forEach(([k, id]) => {
      $(id).classList.toggle('hidden', k !== state.view);
      $(id).classList.toggle('flex', k === state.view);
    });
    document.querySelectorAll('#main-nav .nav-link').forEach(a => {
      const on = a.getAttribute('href') === `#${({ match: 'live', create: 'dispatch', cart: 'dispatch' })[state.view] || state.view}`;
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
    if (state.view === 'match') param ? openMatch(decodeURIComponent(param)) : (location.hash = '#dispatch');
    if (state.view === 'live') {
      const last = [...myHolds].pop();
      if (param) openLive(decodeURIComponent(param));
      else if (last) location.replace(`#live/${encodeURIComponent(last)}`);
      else { $('dlive-panel').innerHTML = emptyHTML('No emergency to track yet. Create one and click Start Searching.'); $('dlive-title').textContent = 'Live Route'; $('dlive-log').innerHTML = ''; }
    }
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
    if (e.key === 'Enter' && document.activeElement?.dataset?.summary) { openSummary(document.activeElement.dataset.summary); return; }
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
    $('conn-dot').className = `w-2 h-2 rounded-full ${online ? 'bg-primary animate-pulse' : 'bg-tertiary'}`;
    $('conn-pill').title = online ? 'Live link online' : 'Reconnecting…';
  }

  if (window.io) {
    const socket = io();
    state.socket = socket;
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
      if (isUrgent(r)) toast(`🚨 ${clinicalLabel(r)}`, `#${esc(r.request_id)} · patient age ${r.patient_age}`, 'critical');
    });

    socket.on('request:update', (r) => {
      document.querySelectorAll(`.req-row[data-id="${r.request_id}"]`).forEach(el => { el.outerHTML = rowHTML(r); });
    });

    socket.on('hospital:update', (p) => { onHospitalUpdate(p); if (p.source !== 'Reservation') onHospitalChangeForMatch(p); });
    socket.on('reservation:update', onReservationUpdate);
    socket.on('handoff:update', onHandoffUpdate);
    socket.on('admission:update', (p) => { if (state.view === 'live' && state.dl.id === p.request_id) loadLive(); });
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
