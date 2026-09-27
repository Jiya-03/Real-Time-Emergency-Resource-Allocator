# API Contract (base URL: http://localhost:5000)

Resource keys used everywhere: `icu`, `ventilator`, `oxygen_bed`, `general_bed`
Freshness: `fresh` (≤5 min), `aging` (5–30 min), `stale` (>30 min)

## 🖥️ UI (served by the same server)

| URL | Page |
|-----|------|
| http://localhost:5000/ | Login (Dispatcher / Hospital) |
| http://localhost:5000/dispatcher.html | Dispatcher portal: Dashboard · Create Emergency · Emergency Cart |
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
  "severity": "Critical",                    // Critical | High | Moderate | Low
  "patient_age": 28,
  "location": { "lat": 18.5204, "lng": 73.8567 },
  "requirements": { "icu": true, "trauma_care": true, "blood_bank": true, "operation_theatre": true },
  "required_specialist": "Trauma Surgeon",   // optional
  "beds_required": 1,                        // optional, default 1
  "additional_needs": ["CT Scanner"]         // optional: extra items not tracked in capacity data (notes for the hospital)
}
```
Requirement keys: `icu`, `ventilator`, `oxygen`, `trauma_care`, `cardiology`, `neurology`, `blood_bank`, `operation_theatre`, `dialysis` (any missing = false).

Response `201`: `{ "request": { request_id, patient_id, status: "CREATED", ... }, "warnings": [] }`

Every request object also has `assignment`: `null` until a hospital is assigned, then
`{ hospital_id, hospital_name, distance_km, transit_minutes, transit_source: "actual" | "estimated" }`.
Warnings (not errors): location outside Pune, or no requirements selected.
Invalid input → `400` with `{ "error": "...", "details": ["every problem listed"] }`.

**Form tip:** `GET /api/requests/meta` returns `type_defaults` (e.g. Cardiac → cardiology + Cardiologist) and `severity_defaults` (Critical/High → icu). Pre-tick those checkboxes so the dispatcher logs a call in seconds.

Request status flow: `CREATED → MATCHING → ASSIGNED → IN_TRANSIT → COMPLETED` (or `NO_MATCH`)

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
| `request:update` | request object | Request status changes (coming with ranking/reservations) |

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

## 🔜 Coming next

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /api/requests/:id/rankings | Ranked hospital list |
| POST | /api/reservations | Reserve a hospital |
| PATCH | /api/reservations/:id | Hospital accepts / rejects |
| PATCH | /api/reservations/:id/status | en_route → arrived → handed_over |

Socket event coming: `reservation:update`
