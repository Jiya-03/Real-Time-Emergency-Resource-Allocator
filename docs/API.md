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
| POST | /api/requests | Dispatcher logs a new emergency (**signed-in dispatcher only**; the crew that logs it owns its live GPS) |
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
- `travel = max(0, 1 − ETA/60)`; ETA first **estimated** = road km ÷ traffic speed (20 km/h peak, 28 off-peak, 40 night) + 2 min
- **Live traffic for the top 5:** with `MAPBOX_TOKEN` set, one Mapbox Matrix call (`driving-traffic`) gets the real driving time
  + road distance from the pickup to the 5 best hospitals, and the ranking is recomputed with them (row field `eta_source: "mapbox"`,
  explanation says "with live traffic", summary `travel_times`). Cached 3 min per pickup point. No token / Mapbox down or slower
  than 2.5 s (`ROAD_ETA_TIMEOUT_MS`) → the estimate is used (`eta_source: "estimate"`), dispatch is never blocked. Proven by `npm run test:road`.
- `freshness = exp(−data age in minutes / 45)`
- `final = 0.5 × resource + 0.3 × travel + 0.2 × freshness`; ineligible (missing a mandatory need, inactive, no ED) → `× 0.3`
- Primary bed: ICU if required, else Oxygen Bed, else General Bed
- Candidates: 5 nearest hospitals + every other eligible hospital within 55 min

Each ranking row: `{ rank, hospital_id, hospital_name, eligible, scores: { resource, travel, freshness, final }, distance_km, eta_min, freshness: { status, age_minutes, needs_reconfirmation }, primary_bed, missing: [...], is_nearest, explanation }`

**Verified:** `npm run test:ranking` replays all 1,920 reference rankings: 99.97% of hospital scores match exactly, and in the 273 cases where our #1 differs, ours is an eligible hospital with a strictly higher score (found beyond the 5 nearest).

### Dispatch (default): ranked cascade, best "yes" wins
| Method | Path | Who | What |
|---|---|---|---|
| POST | /api/requests/:id/broadcast `{ max? }` | Dispatcher | Re-ranks, then alerts the **next wave**: the best hospitals not yet contacted that have the beds free. Returns `{ wave, sent_to[], response_seconds, better_wait_seconds, expires_at }`. Calling again = next wave now |
| POST | /api/requests/:id/broadcast `{ hospital_id }` | Dispatcher | **Send to this hospital** (override). Alerts one chosen eligible hospital; if it accepts it is confirmed at once. 409 `NOT_ELIGIBLE` / `ALREADY_ALERTED` / `BED_TAKEN` |
| POST | /api/requests/:id/withdraw | Dispatcher | Cancel the request at every hospital still deciding |

How it works:
- **Small waves, best first.** A wave is the top 3 hospitals (`BROADCAST_MAX`) that are still close to the best one left: ETA at most 10 min slower (`ETA_BAND_MIN`) and a score of at least 85% of its score (`SCORE_BAND`). A far, low-ranked hospital is never alerted alongside a much better one.
- **Best "yes" wins.** If the best-ranked hospital still deciding accepts, it is confirmed at once. If a lower-ranked one accepts first, its beds are held and it becomes an **offer** (socket action `offered`, response `{ offered: true, decide_at, waiting_on[] }`). The system waits up to 30 s (`BETTER_WAIT_SECONDS`) for the better-ranked hospitals; then the best offer is confirmed. A better hospital declining ends the wait at once.
- **Fast answers.** Each hospital has 60 s (`RESPONSE_SECONDS`) to answer. A decline or no answer moves on; when nobody in the wave is left, the next wave is alerted automatically (`broadcast_round` + 1). None left → request `NO_MATCH` + socket action `exhausted`.
- **Never two winners.** Confirming claims the request (`UPDATE … SET request_status='ASSIGNED' WHERE request_status='MATCHING'`), takes the beds with the conditional UPDATE and withdraws everyone else in one transaction (others: reservations `CANCELLED`, workflow `WITHDRAWN`, socket action `filled`; held offer beds go back). A late accept gets **409 `ALREADY_FILLED`**; a hospital whose last bed disappeared gets **409 `BED_TAKEN`** (recorded as a `No Bed` decline).
- Hospital inbox items carry `offer: { manual, offered_at, decide_at }`; request detail carries `marks[]` (same fields per hospital).
- Proven by `npm run test:cascade` (waves, offers, wait-over, declines, time-outs, override) and `npm run test:broadcast` (simultaneous accepts → exactly one winner).

### Test scenarios page (problem statement: stale data, simultaneous requests, double-booking)
`/scenarios.html` (also "Test Scenarios" in the dispatcher menu) runs 6 scenarios live: stale data, double-booking (20 requests → 1 bed),
two hospitals accepting at once, two patients / one bed, decline + no answer, and the full workflow.
They run on a **sandbox copy** (a second server process on a fresh SQLite copy of the dataset, short timers), so real data is never touched.
| Method | Path | What |
|---|---|---|
| GET | /api/scenarios | List of scenarios |
| GET | /api/scenarios/run?id=all\|stale\|double\|accepts\|onebed\|nobody\|e2e | Server-Sent Events: `status`, `start`, `step {text, status: ok\|fail\|info\|wait}`, `done {pass, ms}`, `end {pass, results}` |
Proven by `npm run test:scenarios`.

### Two patients, one bed (hospital queue)
When several emergencies wait on the same hospital and it has beds for only some of them, `GET /api/reservations` returns them **in priority order**, each with a `queue` object: `{ position, gets_bed, contended, reason, behind, other_options }`.

Order used, top rule first:
1. More serious condition (Critical → Serious → Need Assistance → Stable / Minor)
2. The patient with **no other hospital** still able to take them
3. Whoever called in first (waited longer)
4. Whoever is closer (arrives sooner)
5. Request number (a perfect tie is never random)

- Accepting a patient who is not next in line → **409 `PRIORITY_CONFLICT`** (`ahead` = the request in front). Send `{ action: "accept", override: true }` to accept anyway (the UI button says **Accept anyway**).
- After an accept, patients still waiting at that hospital who no longer fit are released at once (`No Bed`) and search elsewhere / the next wave, instead of waiting for the hold to expire.
- Proven by `npm run test:verify`, which also checks the three ranking parameters (distance, free beds, data freshness) with controlled experiments.

### Departments on / off (hospital staff)
`PATCH /api/hospitals/:id/services` `{ "services": { "cardiology": false }, "specialists": ["Trauma Surgeon"] }`. Hospital role, own hospital only.
Departments: `trauma_care, cardiology, neurology, blood_bank, operation_theatre, dialysis, burn_unit`. Changes affect ranking eligibility immediately and are broadcast as `hospital:update`.

### Admission at handover (ward / room / bed + resources used)
| Method | Path | Who | What |
|---|---|---|---|
| GET | /api/requests/:id/admission?ward= | Receiving hospital | Saved admission, or a draft: suggested ward (from the needs), first free room/bed, the resources the reservation holds |
| PUT | /api/requests/:id/admission `{ ward, room, bed, attending, nurse, resources: { icu: 1, ventilator: 1 }, services: ["operation_theatre"] }` | Receiving hospital, after arrival | Saves the allocation. **Resource changes hit the live inventory immediately** (conditional UPDATE; 409 `NO_CAPACITY` if none free). The reserved beds are taken over on the first save (never counted twice) |

Completing the handover now requires a ward, room and bed (409 `NO_BED_ALLOCATED` otherwise); it stamps `admitted_at`. `GET /api/requests/:id` includes `admission`. Socket event `admission:update` → `{ request_id, hospital_id, admission }`.
Wards: ICU, Trauma Resus Bay, Cardiac Care Unit (CCU), Stroke Unit, Respiratory Ward (O₂), Burns Unit, Emergency Observation, General Ward.

### Database: SQLite (default) or Postgres / Supabase (several servers)
- No `DATABASE_URL` → local SQLite file (`server/emergency.db`), zero setup, works offline.
- `DATABASE_URL=postgres://…` (e.g. Supabase → Connect → **Session pooler**) → the server uses Postgres directly. Tables are created on start
  (`server/src/db/schema.pg.sql`); `npm run seed` loads the dataset there. Same API, same SQL.
- **Several servers** can run on the same Postgres: Socket.io uses the Postgres adapter so live events reach screens on every server;
  race-safety uses row locks (`SELECT … FOR UPDATE` per emergency / hospital) + the same conditional UPDATEs; only one server
  (advisory-lock leader) runs the background jobs, and another takes over if it stops. Proven by `npm run test:multi`
  (two servers: events across servers, simultaneous accepts on different servers → one winner, leader failover).
- Tests: `TEST_DATABASE_URL=postgres://…/throwaway_db npm test` runs every suite on Postgres (the DB is wiped!).

### Supabase live sync (SQLite mode)
Two-way live mirror of the database to Supabase (setup: `SUPABASE.md`). `GET /api/config/sync` →
`{ enabled, realtime: "SUBSCRIBED", initialized, last_push, pushed, pulled, pending, errors }`.
App → Supabase: SQLite triggers queue every change in `sync_outbox`, pushed ~every second.
Supabase → App: Realtime on `hospitals`, `hospital_resources`, `hospital_services` (validated; invalid edits are reverted).
Extra Supabase objects: `ambulance_positions` (live), views `live_emergencies`, `live_hospital_capacity`.

### Map configuration (Mapbox)
`GET /api/config` → `{ "mapbox": { "token": "pk.…", "style": "mapbox/navigation-day-v1" } }` or `{ "mapbox": null }`.
Set `MAPBOX_TOKEN=pk.…` in `server/.env` (copy `server/.env.example`; `.env` is git-ignored). Only public `pk.` tokens are served.
With a token both Live Route maps use Mapbox styles (Live traffic / Streets / Satellite switcher) and **Mapbox Directions `driving-traffic`**:
the route and ETA use live traffic, the line is coloured by congestion (teal = clear, orange = moderate, red = heavy) and the
turn-by-turn text comes from Mapbox. Without a token the maps fall back to CARTO tiles + OSRM (no key).

### Live ambulance tracking (Live Route map)
| Method / event | Who | What |
|---|---|---|
| socket emit `ambulance:position` `{ request_id, lat, lng, source: "gps"\|"simulated", accuracy_m?, left_km?, eta_min?, hospital_id? }` | **Only the signed-in crew (dispatcher) who logged that emergency** (socket connected with `io({ auth: { token } })`) | Validated (request must be ASSIGNED / IN_TRANSIT, max 1 per second), stored in `ambulance_positions`, relayed to every screen. Anyone else gets `ambulance:position:rejected { request_id, reason }` |
| socket `ambulance:position` | Hospital screen | Moves the ambulance on the hospital's Live Route map in real time |
| GET /api/requests/:id/position | Any | Last position (≤ 10 min old) or `null` |

Maps: Leaflet (vendored in `client/vendor/leaflet`) + CARTO Voyager street tiles; road route + turn-by-turn from the public OSRM server. Both are free and need no API key; if OSRM can't be reached the map falls back to a straight-line estimate.

### Bed reservations (single hospital: hold → accept / reject / expire)
| Method | Endpoint | Who | Purpose |
|--------|----------|-----|---------|
| POST | /api/reservations `{ request_id, hospital_id }` | Dispatcher | Hold the bed(s) at a hospital. Beds leave availability immediately |
| PATCH | /api/reservations/:id `{ action: "accept" \| "reject", reason, override? }` | That hospital only | Answer a pending hold. Accept may return `{ offered: true }` (see Dispatch). `override: true` = accept even if another patient is ahead for the last bed |
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

