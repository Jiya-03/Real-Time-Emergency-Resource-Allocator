// JeevanRoute Hospital Portal: accept/reject incoming bed holds, keep live capacity current.
(() => {
  const session = Session.get();
  if (!session?.token || session.user?.role !== 'hospital') { location.replace('index.html'); return; }
  api('/api/auth/me').catch((err) => { if (err.status === 401) { Session.clear(); location.replace('index.html'); } });

  const $ = (id) => document.getElementById(id);
  const esc = fmt.escape;
  const HID = session.user.hospital_id;
  let meta = { reject_reasons: [], hold_minutes: 10 };
  let items = [];
  let hospital = null;
  let draftCaps = null;          // edited-but-unpublished availability

  $('hosp-name').textContent = session.user.name;
  $('user-id').textContent = `ID ${HID}`;
  $('user-btn').addEventListener('click', (e) => { e.stopPropagation(); $('user-menu').classList.toggle('hidden'); });
  document.addEventListener('click', () => $('user-menu').classList.add('hidden'));
  $('logout-btn').addEventListener('click', () => { Session.clear(); location.replace('index.html'); });

  function toast(title, body = '', tone = 'info') {
    const colors = { info: 'border-outline-variant', success: 'border-[#6EE7B7]', critical: 'border-[#F87171]', warn: 'border-[#D97706]' };
    const el = document.createElement('div');
    el.className = `bg-surface-container-lowest border ${colors[tone]} border-l-4 rounded-lg px-space-lg py-space-md shadow-[0_4px_16px_-4px_rgba(11,31,58,0.12)]`;
    el.innerHTML = `<div class="font-label-lg text-label-lg text-on-surface">${esc(title)}</div>${body ? `<div class="font-body-sm text-body-sm text-on-surface-variant mt-0.5">${body}</div>` : ''}`;
    $('toasts').appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 6000);
  }

  const TYPE_NOUN = { 'Road Accident': 'Trauma', Cardiac: 'Cardiac', Stroke: 'Stroke', Burn: 'Burns', Respiratory: 'Respiratory Distress', Other: 'Emergency' };
  const SEV_PREFIX = { Critical: 'Severe', High: 'Acute', Moderate: 'Moderate', Low: 'Minor' };
  const clinicalLabel = (r) => `${SEV_PREFIX[r.severity] || ''} ${TYPE_NOUN[r.emergency_type] || r.emergency_type}`.trim();
  const mmss = (sec) => { const s = Math.max(0, Math.round(sec)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

  // Same distance/ETA model as the server
  function eta(req) {
    if (!hospital) return null;
    const toRad = (d) => (d * Math.PI) / 180;
    const a = req.location, b = hospital.location;
    const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lng - a.lng) / 2) ** 2;
    const km = 2 * 6371 * Math.asin(Math.sqrt(h)) * 1.35 + 0.3;
    const hr = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(new Date()));
    const speed = (hr >= 23 || hr < 6) ? 40 : ((hr >= 8 && hr < 11) || (hr >= 17 && hr < 21)) ? 20 : 28;
    return { km: Math.round(km * 10) / 10, min: Math.round(km / speed * 60 + 2) };
  }

  // ───────────── Inbox ─────────────
  function cardHTML(item) {
    const r = item.request;
    const urgent = r.severity === 'Critical' || r.severity === 'High';
    const needs = Object.entries(r.requirements).filter(([, v]) => v).map(([k]) => fmt.label(k));
    const holds = item.reservations.map(x => `${x.quantity} × ${x.resource_type}`).join(' + ');
    const e = eta(r);
    const pending = item.status === 'PENDING';
    return `
<div class="bg-surface-container-lowest rounded-xl shadow-sm overflow-hidden ${pending && urgent ? 'ring-2 ring-[#F54B5E]' : ''}" data-item="${esc(item.reservation_id)}">
  ${pending ? '<div class="h-1.5 bg-tertiary"></div>' : '<div class="h-1.5 bg-[#36B37E]"></div>'}
  <div class="p-space-lg flex flex-col gap-space-md">
    <div class="flex flex-col md:flex-row md:items-start justify-between gap-space-md">
      <div class="flex flex-col gap-space-xs">
        <div class="flex items-center gap-space-sm flex-wrap">
          <span class="font-telemetry-md text-telemetry-md text-on-surface font-semibold">#${esc(r.request_id)}</span>
          <span class="font-label-lg text-label-lg ${urgent ? 'text-tertiary' : 'text-primary'}">${esc(clinicalLabel(r))}</span>
          <span class="px-space-sm py-0.5 rounded bg-surface-container font-telemetry-sm text-telemetry-sm">Age ${r.patient_age}</span>
        </div>
        <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">Bed held: <b class="text-on-surface">${esc(holds)}</b>${e ? ` · Ambulance ~${e.min} min away (${e.km} km)` : ''}</span>
      </div>
      ${pending
        ? `<div class="flex flex-col items-end"><span class="font-telemetry-lg text-telemetry-lg text-tertiary" data-countdown="${esc(item.reservations[0].expires_at)}">--:--</span><span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">to respond</span></div>`
        : `<span class="px-space-sm py-1 rounded bg-[#ECFDF5] text-[#065F46] font-telemetry-sm text-telemetry-sm font-semibold">CONFIRMED · ${fmt.timeIST(item.reservations[0].confirmed_at)}</span>`}
    </div>
    <div class="flex flex-wrap gap-space-xs">
      ${needs.map(n => `<span class="px-space-sm py-0.5 rounded bg-surface-container-low font-label-md text-label-md text-on-surface">${esc(n)}</span>`).join('')}
      ${r.required_specialist ? `<span class="px-space-sm py-0.5 rounded bg-surface-container font-label-md text-label-md text-primary">${esc(r.required_specialist)}</span>` : ''}
      ${(r.additional_needs || []).map(n => `<span class="px-space-sm py-0.5 rounded border border-outline-variant font-label-md text-label-md text-on-surface-variant" title="Requested by the ambulance crew (not tracked in capacity data)">${esc(n)}</span>`).join('')}
    </div>
    ${pending ? `
    <div class="flex flex-col-reverse sm:flex-row sm:justify-end gap-space-md pt-space-sm border-t border-surface-container-low">
      <button class="px-space-lg py-space-sm rounded-lg border border-outline-variant font-label-lg text-label-lg text-on-surface hover:bg-surface-container-low" data-reject="${esc(item.reservation_id)}" type="button">Reject</button>
      <button class="inline-flex items-center justify-center gap-space-sm px-space-xl py-space-sm rounded-lg bg-primary hover:bg-primary-container text-on-primary font-label-lg text-label-lg" data-accept="${esc(item.reservation_id)}" type="button"><span class="material-symbols-outlined text-[18px]">check_circle</span>Accept patient</button>
    </div>` : ''}
  </div>
</div>`;
  }

  const empty = (text) => `<div class="bg-surface-container-lowest rounded-xl shadow-sm px-space-lg py-space-xl font-telemetry-sm text-telemetry-sm text-on-surface-variant">${text}</div>`;

  async function loadInbox() {
    try {
      items = (await api('/api/reservations')).items;
      renderInbox();
    } catch (err) {
      $('pending-list').innerHTML = empty(`Could not load requests: ${esc(err.message)}`);
    }
  }

  function renderInbox() {
    const pending = items.filter(i => i.status === 'PENDING');
    const confirmed = items.filter(i => i.status === 'CONFIRMED');
    $('pending-count').textContent = pending.length;
    $('confirmed-count').textContent = confirmed.length;
    $('pending-list').innerHTML = pending.map(cardHTML).join('') || empty('No requests waiting. New ambulance requests appear here instantly.');
    $('confirmed-list').innerHTML = confirmed.map(cardHTML).join('') || empty('No confirmed patients on the way.');
    tick();
  }

  function tick() {
    document.querySelectorAll('[data-countdown]').forEach(el => {
      const left = (new Date(el.dataset.countdown) - Date.now()) / 1000;
      el.textContent = mmss(left);
      el.classList.toggle('animate-pulse', left < 60);
    });
  }
  setInterval(tick, 1000);

  async function accept(id) {
    try {
      await api(`/api/reservations/${encodeURIComponent(id)}`, { method: 'PATCH', body: { action: 'accept' } });
      toast('Patient accepted', 'The ambulance has been notified. The bed stays reserved.', 'success');
    } catch (err) { toast('Could not accept', esc(err.message), 'critical'); }
    loadInbox();
  }

  // Reject dialog
  let rejectId = null, rejectReason = null;
  function openReject(id) {
    rejectId = id; rejectReason = null;
    const item = items.find(i => i.reservation_id === id);
    $('reject-sub').textContent = item ? `#${item.request.request_id} · ${clinicalLabel(item.request)}. The held bed goes back to availability and the dispatcher picks another hospital.` : '';
    $('reject-reasons').innerHTML = meta.reject_reasons.map(r => `
      <label class="flex items-center gap-space-sm px-space-md py-space-sm rounded-lg border border-outline-variant cursor-pointer hover:bg-surface-container-low">
        <input type="radio" name="reject-reason" value="${esc(r)}" class="accent-[#b51735]"><span class="font-body-md text-body-md">${esc(r)}</span></label>`).join('');
    $('reject-confirm').disabled = true;
    $('reject-dialog').classList.remove('hidden'); $('reject-dialog').classList.add('flex');
  }
  function closeReject() { $('reject-dialog').classList.add('hidden'); $('reject-dialog').classList.remove('flex'); }
  $('reject-reasons').addEventListener('change', (e) => { rejectReason = e.target.value; $('reject-confirm').disabled = false; });
  $('reject-confirm').addEventListener('click', async () => {
    try {
      await api(`/api/reservations/${encodeURIComponent(rejectId)}`, { method: 'PATCH', body: { action: 'reject', reason: rejectReason } });
      toast('Request rejected', 'The bed was released back to availability.', 'info');
    } catch (err) { toast('Could not reject', esc(err.message), 'critical'); }
    closeReject(); loadInbox();
  });

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-accept]'); if (a) accept(a.dataset.accept);
    const r = e.target.closest('[data-reject]'); if (r) openReject(r.dataset.reject);
    if (e.target.closest('[data-close-reject]')) closeReject();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeReject(); });

  // ───────────── Live capacity ─────────────
  const CAP_KEYS = ['icu', 'ventilator', 'oxygen_bed', 'general_bed'];
  const FRESH = { fresh: ['bg-secondary-container/40 text-primary', 'FRESH'], aging: ['bg-[#FFFBEB] text-[#92400E]', 'AGING'], stale: ['bg-tertiary-fixed text-tertiary', 'STALE'] };

  async function loadHospital() {
    try { hospital = await api(`/api/hospitals/${encodeURIComponent(HID)}`); renderCapacity(); renderInbox(); } catch { /* retry on next event */ }
  }

  function renderCapacity() {
    if (!hospital) return;
    const [fc, fl] = FRESH[hospital.freshness.status];
    $('fresh-chip').className = `px-space-sm py-0.5 rounded font-telemetry-sm text-telemetry-sm font-semibold ${fc}`;
    $('fresh-chip').textContent = `${fl} · ${Math.round(hospital.freshness.age_minutes)} min`;
    $('capacity').innerHTML = CAP_KEYS.map(k => {
      const r = hospital.resources[k];
      const val = draftCaps?.[k] ?? r.available;
      const changed = draftCaps && draftCaps[k] !== undefined && draftCaps[k] !== r.available;
      return `
<div class="flex items-center justify-between gap-space-md py-space-xs border-b border-surface-container-low">
  <div class="flex flex-col"><span class="font-label-lg text-label-lg text-on-surface">${esc(r.label)}</span>
    <span class="font-telemetry-sm text-telemetry-sm text-on-surface-variant">of ${r.total} total</span></div>
  <div class="flex items-center gap-space-xs">
    <button class="w-8 h-8 rounded bg-surface-container-low hover:bg-surface-container flex items-center justify-center disabled:opacity-40" data-step="${k}" data-d="-1" type="button" ${val <= 0 || r.total === 0 ? 'disabled' : ''} aria-label="One fewer ${esc(r.label)}"><span class="material-symbols-outlined text-[18px]">remove</span></button>
    <span class="w-12 text-center font-telemetry-lg text-telemetry-lg ${changed ? 'text-[#D97706]' : val === 0 ? 'text-tertiary' : 'text-on-surface'}">${val}</span>
    <button class="w-8 h-8 rounded bg-surface-container-low hover:bg-surface-container flex items-center justify-center disabled:opacity-40" data-step="${k}" data-d="1" type="button" ${val >= r.total ? 'disabled' : ''} aria-label="One more ${esc(r.label)}"><span class="material-symbols-outlined text-[18px]">add</span></button>
  </div>
</div>`;
    }).join('');
    $('cap-save').disabled = !draftCaps || !CAP_KEYS.some(k => draftCaps[k] !== undefined && draftCaps[k] !== hospital.resources[k].available);
    $('cap-meta').textContent = `Last update ${fmt.timeIST(hospital.freshness.last_updated)} · ${hospital.update_source} · v${hospital.version}`;
  }

  $('capacity').addEventListener('click', (e) => {
    const b = e.target.closest('[data-step]');
    if (!b || !hospital) return;
    const k = b.dataset.step;
    draftCaps = draftCaps || {};
    const cur = draftCaps[k] ?? hospital.resources[k].available;
    draftCaps[k] = Math.max(0, Math.min(hospital.resources[k].total, cur + Number(b.dataset.d)));
    $('cap-error').classList.add('hidden');
    renderCapacity();
  });

  $('cap-save').addEventListener('click', async () => {
    const changes = {};
    CAP_KEYS.forEach(k => { if (draftCaps?.[k] !== undefined && draftCaps[k] !== hospital.resources[k].available) changes[k] = draftCaps[k]; });
    try {
      // send the version we edited: if a bed hold or another staff member changed it first, the server returns 409
      const res = await api(`/api/hospitals/${encodeURIComponent(HID)}/resources`, { method: 'PATCH', body: { ...changes, version: hospital.version, source: 'Hospital Staff' } });
      hospital = res.hospital; draftCaps = null;
      toast('Capacity published', 'Ambulances now see the new numbers.', 'success');
    } catch (err) {
      if (err.status === 409) {
        hospital = err.body.current || hospital; draftCaps = null;
        $('cap-error').textContent = 'Numbers changed while you were editing (a bed hold or another staff member). Showing the latest. Please re-apply your change.';
        $('cap-error').classList.remove('hidden');
      } else toast('Could not publish', esc(err.message), 'critical');
    }
    renderCapacity();
  });

  $('cap-confirm').addEventListener('click', async () => {
    try {
      const res = await api(`/api/hospitals/${encodeURIComponent(HID)}/confirm`, { method: 'POST', body: { source: 'Hospital Staff' } });
      hospital = res.hospital; renderCapacity();
      toast('Availability re-confirmed', 'Your data is marked fresh again.', 'success');
    } catch (err) { toast('Could not confirm', esc(err.message), 'critical'); }
  });

  // Freshness ages every minute even without changes
  setInterval(() => { if (hospital) loadHospital(); }, 60000);

  // ───────────── Live updates ─────────────
  function setConnection(online) {
    $('conn-dot').className = `w-2 h-2 rounded-full ${online ? 'bg-primary animate-pulse' : 'bg-tertiary'}`;
    $('conn-pill').title = online ? 'Live link online' : 'Reconnecting…';
  }
  if (window.io) {
    const socket = io();
    socket.on('connect', () => { setConnection(true); loadInbox(); loadHospital(); });
    socket.on('disconnect', () => setConnection(false));
    socket.on('reservation:update', (p) => {
      if (p.hospital_id !== HID) return;
      if (p.action === 'held') toast(`🚨 New request: ${clinicalLabel(p.request)}`, `#${esc(p.request.request_id)} · respond within ${meta.hold_minutes} min`, 'critical');
      if (p.action === 'cancelled') toast('Request withdrawn', `The ambulance cancelled #${esc(p.request.request_id)}. Bed released.`, 'info');
      if (p.action === 'expired') toast('Hold expired', `#${esc(p.request.request_id)} was not answered in time. Bed released.`, 'warn');
      loadInbox();
    });
    socket.on('hospital:update', (p) => {
      if (p.hospital?.hospital_id !== HID) return;
      hospital = p.hospital;
      renderCapacity();
    });
  } else setConnection(false);

  (async () => {
    try { meta = await api('/api/reservations/meta'); } catch { /* defaults */ }
    await loadHospital();
    loadInbox();
  })();
})();
