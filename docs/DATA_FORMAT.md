# Data Format

The project uses the **ERRA synthetic dataset** in `data/erra_dataset/`, built by Jiya-03.
Full column-by-column details are in [`data/erra_dataset/data_dictionary.md`](../data/erra_dataset/data_dictionary.md).

## Tables (CSV → SQLite, same names)

| Table | Rows | Used for |
|---|---|---|
| hospitals | 25 | Map, hospital cards, eligibility (ED, active) |
| hospital_resources | 25 | **Live** ICU / ventilator / oxygen / general bed availability + freshness |
| hospital_services | 25 | Trauma, cardiology, neurology, burn unit… + specialists |
| ambulances | 100 | Ambulance positions and status |
| emergency_requests | 5,000 | Incoming emergencies and what the patient needs |
| reservations | 2,115 | Bed holds (PENDING → CONFIRMED / FAILED / EXPIRED…) |
| emergency_workflow_handover | 1,639 | Assignment → departure → arrival → handover timeline |
| resource_update_history | 10,000 | Every change in bed counts |
| match_ranking_results | 10,300 | Reference output of the ranking engine (to verify ours) |

## Rules
- Resource types: `ICU`, `Ventilator`, `Oxygen Bed`, `General Bed`
- Booleans: `TRUE`/`FALSE` in CSV → `1`/`0` in SQLite
- Timestamps: `YYYY-MM-DD HH:MM:SS` (IST) in CSV → ISO-8601 UTC in SQLite
- Freshness: ≤5 min = fresh, 5–30 min = aging, >30 min = stale

## Loading
```bash
cd server
npm run seed              # loads all CSVs, time-shifted so the data looks live now
npm run seed -- --no-shift  # keeps the original 2026-09-28 12:00 IST timestamps
```
