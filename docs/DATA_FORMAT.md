# Hospital Data Format
Each hospital is one object. The file is `data/hospitals.json` (an array).

```json
{
  "id": "H001",
  "name": "Ruby Hall Clinic",
  "lat": 18.5314,
  "lng": 73.8770,
  "specialties": ["trauma", "cardiac", "neuro"],
  "resources": {
    "icu_beds":     { "total": 20,  "available": 4 },
    "general_beds": { "total": 150, "available": 32 },
    "ventilators":  { "total": 15,  "available": 3 },
    "er_slots":     { "total": 10,  "available": 5 }
  },
  "last_updated": "2026-09-28T10:30:00Z"
}
```

Rules:
- 6–10 hospitals, real Pune locations (lat/lng from Google Maps)
- specialties allowed: trauma, cardiac, neuro, burn, pediatric, maternity
- available must be ≤ total
- last_updated in ISO format (UTC); make 1–2 hospitals deliberately old (stale test)
