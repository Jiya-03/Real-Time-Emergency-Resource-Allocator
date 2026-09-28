// Real map for the Live Route pages (dispatcher + hospital).
//  • Leaflet (vendored in /vendor/leaflet) + CARTO "Voyager" street tiles (free, no API key)
//  • Road route from the public OSRM server (free, no key): the one path the ambulance should drive,
//    with turn-by-turn steps. Falls back to a straight-line estimate if OSRM can't be reached.
//  • Helpers to place the ambulance on the route (simulated drive) or snap a real GPS fix to it.
const LiveMap = (() => {
  const TILES = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
  const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> · Routing &copy; <a href="https://project-osrm.org">OSRM</a>';
  const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
  const available = () => typeof window.L !== 'undefined';

  const toRad = (d) => (d * Math.PI) / 180;
  const km = (a, b) => {
    const dLat = toRad(b[0] - a[0]), dLng = toRad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── Routing ──────────────────────────────────────────────
  const cache = new Map();
  function instruction(s) {
    const m = s.maneuver || {}, road = s.name ? ` onto ${s.name}` : '';
    const mod = m.modifier ? m.modifier.replace('slight ', 'slight ').replace('sharp ', 'sharp ') : '';
    switch (m.type) {
      case 'depart': return `Head ${m.bearing_after != null ? ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(m.bearing_after / 45) % 8] : 'out'}${s.name ? ` on ${s.name}` : ''}`;
      case 'arrive': return 'Arrive at the hospital';
      case 'roundabout': case 'rotary': return `At the roundabout take exit ${m.exit || ''}${road}`.replace('  ', ' ');
      case 'merge': return `Merge${road}`;
      case 'on ramp': return `Take the ramp${road}`;
      case 'off ramp': return `Take the exit${road}`;
      case 'fork': return `Keep ${mod || 'straight'} at the fork${road}`;
      case 'end of road': return `At the end of the road turn ${mod}${road}`;
      case 'continue': case 'new name': return `Continue${mod && mod !== 'straight' ? ` ${mod}` : ''}${road || ' straight'}`;
      default: return mod === 'straight' || !mod ? `Go straight${road}` : `Turn ${mod}${road}`;
    }
  }
  function withCumulative(coords) {
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + km(coords[i - 1], coords[i]));
    return cum;
  }
  function straightRoute(from, to) {
    const coords = [];
    for (let i = 0; i <= 20; i++) coords.push([from[0] + (to[0] - from[0]) * i / 20, from[1] + (to[1] - from[1]) * i / 20]);
    const d = km(from, to) * 1.35 + 0.3;
    return { coords, cum: withCumulative(coords), distance_km: Math.round(d * 10) / 10, duration_min: null, steps: [{ text: 'Head towards the hospital (road route unavailable offline)', at_km: 0, loc: from }, { text: 'Arrive at the hospital', at_km: km(from, to), loc: to }], source: 'estimate' };
  }
  async function route(from, to) {                   // from/to = [lat, lng]
    const key = `${from.map(n => n.toFixed(5))}|${to.map(n => n.toFixed(5))}`;
    if (cache.has(key)) return cache.get(key);
    const job = (async () => {
      try {
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 7000);
        const res = await fetch(`${OSRM}${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson&steps=true`, { signal: ctrl.signal });
        clearTimeout(t);
        const j = await res.json();
        if (j.code !== 'Ok' || !j.routes?.length) throw new Error(j.code || 'no route');
        const r = j.routes[0];
        const coords = r.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
        let acc = 0;
        const steps = r.legs[0].steps.map(s => { const st = { text: instruction(s), at_km: acc / 1000, loc: [s.maneuver.location[1], s.maneuver.location[0]], dist_km: s.distance / 1000 }; acc += s.distance; return st; });
        return { coords, cum: withCumulative(coords), distance_km: Math.round(r.distance / 100) / 10, duration_min: Math.round(r.duration / 60), steps, source: 'osrm' };
      } catch { return straightRoute(from, to); }
    })();
    cache.set(key, job);
    const out = await job;
    if (out.source !== 'osrm') cache.delete(key);    // try the real road route again next time
    return out;
  }

  // Point after travelling `frac` (0..1) of the route
  function pointAt(rt, frac) {
    const total = rt.cum[rt.cum.length - 1] || 0, target = Math.max(0, Math.min(1, frac)) * total;
    let i = 1; while (i < rt.cum.length - 1 && rt.cum[i] < target) i++;
    const seg = (rt.cum[i] - rt.cum[i - 1]) || 1, f = Math.max(0, Math.min(1, (target - rt.cum[i - 1]) / seg));
    const a = rt.coords[i - 1], b = rt.coords[i] || a;
    return { latlng: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], done_km: target, left_km: total - target, heading: Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI };
  }
  // Snap a GPS fix to the nearest route vertex → how far along we are
  function snap(rt, latlng) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < rt.coords.length; i++) { const d = km(rt.coords[i], latlng); if (d < bestD) { bestD = d; best = i; } }
    const total = rt.cum[rt.cum.length - 1] || 0;
    return { frac: total ? rt.cum[best] / total : 0, off_route_km: bestD, done_km: rt.cum[best], left_km: total - rt.cum[best] };
  }
  function nextStep(rt, doneKm) {
    const s = rt.steps.find(x => x.at_km > doneKm + 0.02) || rt.steps[rt.steps.length - 1];
    return s ? { text: s.text, in_km: Math.max(0, s.at_km - doneKm) } : null;
  }

  // ── Map instance ─────────────────────────────────────────
  const pinHTML = {
    pickup: (label) => `<div class="lm-pin"><span class="lm-dot lm-pickup"></span>${label ? `<span class="lm-label lm-label-red">${esc(label)}</span>` : ''}</div>`,
    hospital: (name, tone) => `<div class="lm-pin"><span class="lm-hosp lm-${tone}"><span class="material-symbols-outlined">local_hospital</span></span><span class="lm-label">${esc(name)}</span></div>`,
    amb: (label) => `<div class="lm-amb-wrap"><span class="lm-amb-halo"><span class="lm-amb"><span class="material-symbols-outlined">airport_shuttle</span></span></span>${label ? `<span class="lm-amb-label">${label}</span>` : ''}</div>`,
  };

  function create(el, { center = [18.53, 73.85], zoom = 13 } = {}) {
    if (!available()) return null;
    const map = L.map(el, { zoomControl: false, attributionControl: true }).setView(center, zoom);
    L.tileLayer(TILES, { attribution: ATTRIB, subdomains: 'abcd', maxZoom: 19 }).addTo(map);
    L.control.zoom({ position: 'topleft' }).addTo(map);
    const layers = { hospitals: L.layerGroup().addTo(map) };
    let pickup = null, amb = null, line = null, lineDone = null, halo = null;

    const api = {
      map,
      setPickup(latlng, label) {
        const icon = L.divIcon({ className: '', html: pinHTML.pickup(label), iconSize: [0, 0] });
        pickup ? pickup.setLatLng(latlng).setIcon(icon) : (pickup = L.marker(latlng, { icon, zIndexOffset: 400 }).addTo(map));
      },
      // [{ id, name, latlng, tone: accepted|waiting|declined|standby }]
      setHospitals(list) {
        layers.hospitals.clearLayers();
        for (const h of list) {
          if (!h.latlng) continue;
          L.marker(h.latlng, { icon: L.divIcon({ className: '', html: pinHTML.hospital(h.name, h.tone), iconSize: [0, 0] }), zIndexOffset: h.tone === 'accepted' ? 500 : 100, title: h.name })
            .addTo(layers.hospitals);
        }
      },
      setRoute(rt, { active = true } = {}) {
        [line, lineDone, halo].forEach(l => l && map.removeLayer(l));
        line = lineDone = halo = null;
        if (!rt) return;
        halo = L.polyline(rt.coords, { color: '#6fd7d3', weight: 12, opacity: active ? 0.35 : 0.2 }).addTo(map);
        line = L.polyline(rt.coords, { color: active ? '#006765' : '#6d7978', weight: 5, opacity: 0.95, dashArray: rt.source === 'osrm' ? null : '8 10', className: active ? 'lm-route' : '' }).addTo(map);
        lineDone = L.polyline([], { color: '#9aa8b8', weight: 5, opacity: 0.9 }).addTo(map);
      },
      setProgress(rt, frac) {                        // grey out the part already driven
        if (!lineDone || !rt) return;
        const p = pointAt(rt, frac);
        const idx = rt.cum.findIndex(c => c >= p.done_km);
        lineDone.setLatLngs([...rt.coords.slice(0, Math.max(1, idx)), p.latlng]);
      },
      setAmbulance(latlng, label) {
        const icon = L.divIcon({ className: '', html: pinHTML.amb(label), iconSize: [0, 0] });
        if (amb) { amb.setLatLng(latlng); if (amb._lmLabel !== label) { amb.setIcon(icon); amb._lmLabel = label; } }
        else { amb = L.marker(latlng, { icon, zIndexOffset: 1000 }).addTo(map); amb._lmLabel = label; }
      },
      fit(points, pad = 60) {
        const pts = points.filter(Boolean);
        if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [pad, pad], maxZoom: 15 });
        else if (pts.length === 1) map.setView(pts[0], 14);
      },
      follow(latlng) { if (!map.getBounds().pad(-0.04).contains(latlng)) map.panTo(latlng, { animate: true }); },
      invalidate() { map.invalidateSize(); },
      destroy() { map.remove(); },
    };
    return api;
  }

  return { available, create, route, pointAt, snap, nextStep, km };
})();
