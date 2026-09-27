# API Contract (base URL: http://localhost:5000)

Resource keys used everywhere: `icu`, `ventilator`, `oxygen_bed`, `general_bed`
Freshness: `fresh` (≤5 min), `aging` (5–30 min), `stale` (>30 min)

## ✅ Built

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

### Errors
All errors return `{ "error": "message" }` with status 400 (bad input), 404 (not found) or 409 (conflict).

## 🔜 Coming next

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | /api/requests | Dispatcher creates emergency |
| GET | /api/requests/:id/rankings | Ranked hospital list |
| POST | /api/reservations | Reserve a hospital |
| PATCH | /api/reservations/:id | Hospital accepts / rejects |
| PATCH | /api/reservations/:id/status | en_route → arrived → handed_over |

Socket events: `hospital:update`, `reservation:update`
