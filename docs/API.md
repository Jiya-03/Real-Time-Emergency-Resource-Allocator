# API Contract (base URL: http://localhost:5000)

Resource keys used everywhere: `icu`, `ventilator`, `oxygen_bed`, `general_bed`
Freshness: `fresh` (≤5 min), `aging` (5–30 min), `stale` (>30 min)

## 🖥️ UI (served by the same server)

| URL | Page |
|-----|------|
| http://localhost:5000/ | Login (Dispatcher / Hospital) |
| http://localhost:5000/dispatcher.html | Dispatcher portal: Dashboard · Create Emergency · Emergency Cart · Hospital Match |
| http://localhost:5000/hospital.html | Hospital portal: Dashboard · Emergency Requests · Resources · Active Cases · Handover · History (+ full-screen siren alarm on new requests) |
| http://localhost:5000/live.html | Developer live-feed test page |

## ✅ Built

### Auth (demo mode)
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | /api/auth/login | `{ role: "dispatcher" \| "hospital", identifier, password }` → `{ token, user }` |
| GET | /api/auth/me | Check a token (`Authorization: Bearer <token>`) |

Dispatcher IDs start with `DSP-` (e.g. `DSP-7704`); hospital staff use their hospital ID (e.g. `HSP-011`). Any password works in demo mode. Tokens are HMAC-signed and last 12 h.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /api/health | Server + DB check with row counts |
| GET | /api/hospitals | All hospitals with live resources, services, freshness |
| GET | /api/hospitals?freshness=stale&has=icu&service=cardiology&accepting=true | Filtered list (all filters optional) |
| GET | /api/hospitals/summary | Network totals: available beds per type, fresh/aging/stale counts |
| GET | /api/hospitals/:id | One hospital |
| GET | /api/hospitals/:id/history?type=icu&limit=20 | Recent availability changes |
| PATCH | /api/hospitals/:id/resources | Hospital staff update available counts |
| POST | /api/hospitals/:id/confirm | Staff re-confirm numbers (clears stale warning) |

### Hospital object
```json
{
  "hospital_id": "HSP-001",
  "name": "Mula Riverside Multispeciality Hospital",
  "type": "Multispecialty",
  "location": { "lat": 18.559219, "lng": 73.80334 },
  "address": "Plot 96, ITI Road, Aundh, Pune, Maharashtra 411007",
  "emergency_department": true,
  "active": true,
  "accepting_patients": true,
  "resources": {
    "icu":         { "label": "ICU", "total": 56, "available": 21, "occupancy_pct": 63 },
    "ventilator":  { "label": "Ventilator", "total": 25, "available": 7, "occupancy_pct": 72 },
    "oxygen_bed":  { "label": "Oxygen Bed", "total": 91, "available": 39, "occupancy_pct": 57 },
    "general_bed": { "label": "General Bed", "total": 309, "available": 62, "occupancy_pct": 80 }
  },
  "services": { "trauma_care": true, "cardiology": true, "neurology": false, "blood_bank": true,
                "operation_theatre": true, "dialysis": true, "burn_unit": false },
  "specialists": ["Cardiologist", "Trauma Surgeon", "General Surgeon", "Nephrologist"],
  "freshness": { "last_updated": "2026-09-28T06:27:00.000Z", "age_minutes": 3, "status": "fresh",
                 "score": 0.935, "needs_reconfirmation": false },
  "update_source": "Admin",
  "version": 1
}
```

### Update availability (hospital staff)
```http
PATCH /api/hospitals/HSP-011/resources
{ "icu": 2, "ventilator": 1, "version": 1, "source": "Hospital Staff" }
```
- Values are the new **available** counts (0 … total).
- `version` is optional. Send the version you last saw: if someone else updated first you get **409 Conflict** with the current data, so nobody overwrites fresher numbers.
- Every change is logged in the history.

### Emergency requests (dispatcher)
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /api/requests/meta | Dropdown values + smart defaults for the "New emergency" form |
| POST | /api/requests | Dispatcher logs a new emergency |
| GET | /api/requests?active=true&since_minutes=60&severity=Critical&sort=priority | List. `sort=priority` (Critical first) or `sort=recent` (newest first). Filters: `status` (comma list), `severity`, `emergency_type`, `active`, `since_minutes`, `limit` (≤200), `offset` |
| GET | /api/requests/summary | Counts by status + active by severity |
| GET | /api/requests/:id | Request + its reservations + handover timeline |

#### Create an emergency
```http
POST /api/requests
{
  "emergency_type": "Road Accident",          // Road Accident | Cardiac | Stroke | Burn | Respiratory | Other
  "patient_condition": "Need Assistance",   // Critical | Serious | Need Assistance | Stable | Minor (dispatcher dropdown)
  "severity": "Moderate",                    // Critical | High | Moderate | Low (optional if patient_condition is sent)
  "patient_age": 28,
  "location": { "lat": 18.5204, "lng": 73.8567 },
  "requirements": { "icu": true, "trauma_care": true, "blood_bank": true, "operation_theatre": true },
  "required_specialist": "Trauma Surgeon",   // optional
  "beds_required": 1,                        // optional, default 1
  "additional_needs": ["CT Scanner"],        // optional: extra items not tracked in capacity data (notes for the hospital)
  "field_report": { "bp": "84/52", "hr": 128, "spo2": 91, "notes": "MVA, intubated on scene" }   // optional paramedic vitals/notes
}
```
Condition → severity used by the ranking engine: Critical→Critical (Code Red), Serious→High (Code Orange), Need Assistance→Moderate (Code Yellow), Stable→Low (Code Green), Minor→Low (Code Blue). Every request returns `condition` (dataset requests get the label for their severity).

Requirement keys: `icu`, `ventilator`, `oxygen`, `trauma_care`, `cardiology`, `neurology`, `blood_bank`, `operation_theatre`, `dialysis` (any missing = false).

Response `201`: `{ "request": { request_id, patient_id, status: "CREATED", ... }, "warnings": [] }`

Every request object also has `assignment`: `null` until a hospital is assigned, then
`{ hospital_id, hospital_name, distance_km, transit_minutes, transit_source: "actual" | "estimated" }`.
Warnings (not errors): location outside Pune, or no requirements selected.
Invalid input → `400` with `{ "error": "...", "details": ["every problem listed"] }`.

**Form tip:** `GET /api/requests/meta` returns `type_defaults` (e.g. Cardiac → cardiology + Cardiologist) and `severity_defaults` (Critical/High → icu). Pre-tick those checkboxes so the dispatcher logs a call in seconds.

Request status flow: `CREATED → MATCHING → ASSIGNED → IN_TRANSIT → COMPLETED` (or `NO_MATCH`)

### Ranking engine (hospital match)
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | /api/requests/:id/match | Rank hospitals **now**, save the result, status → `MATCHING` (or `NO_MATCH` if none eligible) |
| GET | /api/requests/:id/rankings | Last saved ranking (dataset requests have one too) |

**Scoring** (identical to the ERRA reference engine):
- `resource = 0.7 × (share of needs met) + 0.3 × headroom`, headroom = `min(1, free primary beds ÷ (5 × beds_required))`
- `travel = max(0, 1 − ETA/60)`; ETA = road km ÷ traffic speed (20 km/h peak, 28 off-peak, 40 night) + 2 min
- `freshness = exp(−data age in minutes / 45)`
- `final = 0.5 × resource + 0.3 × travel + 0.2 × freshness`; ineligible (missing a mandatory need, inactive, no ED) → `× 0.3`
- Primary bed: ICU if required, else Oxygen Bed, else General Bed
- Candidates: 5 nearest hospitals + every other eligible hospital within 55 min

Each ranking row: `{ rank, hospital_id, hospital_name, eligible, scores: { resource, travel, freshness, final }, distance_km, eta_min, freshness: { status, age_minutes, needs_reconfirmation }, primary_bed, missing: [...], is_nearest, explanation }`

**Verified:** `npm run test:ranking` replays all 1,920 reference rankings: 99.97% of hospital scores match exactly, and in the 273 cases where our #1 differs, ours is an eligible hospital with a strictly higher score (found beyond the 5 nearest).

### Broadcast dispatch (default): alert ALL suitable hospitals, first to accept wins
| Method | Path | Who | What |
|---|---|---|---|
| POST | /api/requests/:id/broadcast `{ max? }` | Dispatcher | Re-ranks, then alerts every eligible hospital (not yet contacted) that has the beds free. Returns `{ wave, sent_to[], hold_minutes, expires_at }`. Calling again = next wave |
| POST | /api/requests/:id/withdraw | Dispatcher | Cancel the request at every hospital still deciding |

- **No bed is locked while hospitals decide.** Broadcast rows are `PENDING` with `holds_capacity = 0`.
- **First accept wins:** accept runs one transaction: claim the request (`UPDATE … SET request_status='ASSIGNED' WHERE request_status='MATCHING'`), take the beds with the conditional UPDATE, then withdraw everyone else (reservations `CANCELLED`, workflow `WITHDRAWN`, socket action `filled`). A second hospital accepting at the same instant gets **409 `ALREADY_FILLED`**.
- **Bed gone:** if the hospital's last bed disappeared before it accepted → **409 `BED_TAKEN`**; it is recorded as a `No Bed` decline.
- **Auto next wave:** when every alerted hospital declines / times out, the next suitable hospitals are alerted automatically (`broadcast_round` + 1). None left → request `NO_MATCH` + socket action `exhausted`.
- Optional env `BROADCAST_MAX` caps hospitals per wave (default: all suitable).
- Proven by `npm run test:broadcast` (simultaneous accepts → exactly one winner, no bed locked elsewhere).

### Live ambulance tracking (Live Route map)
| Method / event | Who | What |
|---|---|---|
| socket emit `ambulance:position` `{ request_id, lat, lng, source: "gps"\|"simulated", accuracy_m?, left_km?, eta_min?, hospital_id? }` | Dispatcher screen (every 3 s while en route) | Validated (request must be ASSIGNED / IN_TRANSIT), stored in memory, relayed to every screen |
| socket `ambulance:position` | Hospital screen | Moves the ambulance on the hospital's Live Route map in real time |
| GET /api/requests/:id/position | Any | Last position (≤ 10 min old) or `null` |

Maps: Leaflet (vendored in `client/vendor/leaflet`) + CARTO Voyager street tiles; road route + turn-by-turn from the public OSRM server. Both are free and need no API key; if OSRM can't be reached the map falls back to a straight-line estimate.

### Bed reservations (single hospital: hold → accept / reject / expire)
| Method | Endpoint | Who | Purpose |
|--------|----------|-----|---------|
| POST | /api/reservations `{ request_id, hospital_id }` | Dispatcher | Hold the bed(s) at a hospital. Beds leave availability immediately |
| PATCH | /api/reservations/:id `{ action: "accept" \| "reject", reason }` | That hospital only | Answer a pending hold |
| POST | /api/reservations/:id/cancel | Dispatcher | Release a pending/confirmed hold |
| GET | /api/reservations | Hospital | Own inbox: PENDING first, then CONFIRMED patients still on the way |
| GET | /api/reservations/meta | Any | Reject reasons + hold times |

What gets held: the primary bed (ICU → Oxygen Bed → General Bed) × `beds_required`, plus 1 ventilator if needed.

| Event | Result |
|-------|--------|
| Hold | reservations `PENDING` (expires in 10 min), workflow `PENDING`, request `MATCHING` |
| Accept | reservations `CONFIRMED` (kept 15 min+), workflow `ACCEPTED`, request `ASSIGNED` |
| Reject | reservations `RELEASED`, beds returned, workflow `REJECTED` + reason, request back to `MATCHING` |
| No answer in 10 min | reservations `EXPIRED`, beds returned automatically (sweeper every 5 s) |
| Cancel | reservations `CANCELLED`, beds returned |

**Double-booking protection:** taking a bed is one conditional update inside a transaction:
`UPDATE … SET available = available − n WHERE hospital_id = ? AND available >= n`.
If two dispatchers race for the last bed, the second update matches 0 rows, so availability can never go negative. The loser gets
`409 { code: "BED_TAKEN", alternatives: [next best hospitals with free beds] }`. Other 409 codes: `ALREADY_HELD` (one active hold per emergency), `NOT_PENDING`.

Auth: these endpoints need `Authorization: Bearer <token>`; wrong role → 403, no token → 401.

**Verified:** `npm run test:booking`. 20 simultaneous holds for 3 ICU beds → exactly 3 succeed, 17 get BED_TAKEN, availability ends at 0.

### Simulator (demo control)
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /api/simulator | Is it running, which hospitals have a live feed |
| POST | /api/simulator/start | Start random admissions/discharges |
| POST | /api/simulator/stop | Freeze numbers (useful while presenting) |

Only hospitals that were **fresh** at server start get a live feed. Aging/stale hospitals are left alone on purpose, so the stale-data scenario stays visible.
Env vars: `SIM_INTERVAL_MS=5000` (default), `SIMULATOR=off` to disable on start.

## 📡 Real-time (Socket.io)

Connect with the socket.io client to the same URL (`http://localhost:5000`).

| Event | Payload | When |
|-------|---------|------|
| `hospital:update` | `{ hospital, changed: [{label, old, new}], source }` | Any bed count changes (simulator or staff) |
| `hospitals:freshness` | `[{ hospital_id, status, age_minutes, score }]` | On connect + every 30 s |
| `simulator:status` | `{ running, interval_ms, live_feed_hospitals, ticks }` | On connect + start/stop |
| `request:new` | request object | Dispatcher logs a new emergency |
| `request:update` | request object | Request status changes (e.g. CREATED → MATCHING after ranking) |
| `reservation:update` | `{ action, request, hospital_id, hospital_name, reservations, reason? }` | action = held · failed · accepted · rejected · cancelled · expired · filled (another hospital won) · exhausted (no hospital left). Broadcast holds carry `broadcast: true, wave` |

```js
import { io } from 'socket.io-client';
const socket = io('http://localhost:5000');
socket.on('hospital:update', ({ hospital }) => {
  // replace this hospital in your list/map with the new object
});
```
Test page: **http://localhost:5000/live.html**

### Errors
All errors return `{ "error": "message" }` with status 400 (bad input), 404 (not found) or 409 (conflict).

### Handoff workflow
| Method | Endpoint | Who | Purpose |
|--------|----------|-----|---------|
| POST | /api/requests/:id/handoff `{ "step": "depart" }` | Dispatcher (crew) | Ambulance leaves the scene → request `IN_TRANSIT`, hospital sees a live ETA |
| POST | /api/requests/:id/handoff `{ "step": "arrive" }` | Crew or receiving hospital | Ambulance docked at the bay |
| POST | /api/requests/:id/handoff `{ "step": "complete" }` | Receiving hospital only | Patient handed to ED staff → request `COMPLETED` |
| GET | /api/reservations/history | Hospital | Every case the hospital was contacted for in the last 24 h |

Rules: must be accepted first (409 `NOT_ASSIGNED`); cannot complete before arrival (409 `NOT_ARRIVED`); timestamps always satisfy assignment ≤ departure ≤ arrival ≤ handover.
Socket event: `handoff:update` → `{ step, request, hospital_id, hospital_name, workflow }`.

