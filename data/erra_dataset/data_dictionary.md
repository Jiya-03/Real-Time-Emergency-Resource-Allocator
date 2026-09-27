# Data Dictionary: Real-Time Emergency Resource Allocator (HLTH-02)

All data is **synthetic**. There are no real patients, phone numbers, Aadhaar numbers or MRNs. The hospital names are invented.

- **Demo region:** Pune Metropolitan Region, Maharashtra. Latitude runs from about 18.43 to 18.78 and longitude from about 73.65 to 74.01.
- **Snapshot time ("now"):** `2026-09-28 12:00:00`.
- **History window:** 2026-09-01 to 2026-09-28. A denser "live shift" runs from 06:00 to 12:00 on the 28th.
- **Formats:** Booleans are `TRUE`/`FALSE` and timestamps are `YYYY-MM-DD HH:MM:SS`. An empty CSV field means `NULL`.
- **Import:** run `psql -d <db> -f schema_postgres.sql` from the CSV folder. This creates the tables, PKs, FKs and CHECKs, loads the data, and adds indexes.
- **Regenerate:** `python generate_dataset.py` is seeded, so the output is reproducible. `python validate.py` runs 60+ integrity checks, and all of them pass.

| File | Rows |
|---|---|
| emergency_requests.csv | 5,000 |
| hospitals.csv | 25 |
| hospital_resources.csv | 25 |
| hospital_services.csv | 25 |
| ambulances.csv | 100 |
| resource_update_history.csv | 10,000 |
| reservations.csv | 2,115 |
| emergency_workflow_handover.csv | 1,639 |
| match_ranking_results.csv | 10,300 |

---

## 1. emergency_requests

| Column | Type | Meaning |
|---|---|---|
| request_id | PK, `REQ-000001` | Unique emergency request. IDs are ordered by time. |
| patient_id | `PT-xxxxxx` | Synthetic patient reference. It is not linked to any real record. |
| emergency_type | text | Road Accident ~30%, Cardiac ~22%, Respiratory ~17%, Stroke ~12%, Other ~12%, Burn ~7%. |
| severity | text | Critical ~22%, High ~30%, Moderate ~30%, Low ~18%. The mix varies by type; Stroke skews Critical/High. |
| patient_age | int 0–104 | The distribution depends on type. Cardiac and Stroke skew older, Respiratory is bimodal (children and elderly), and Road Accident skews toward young adults. |
| patient_latitude / patient_longitude | decimal | Scene location. It is clustered around Pune neighbourhoods, and accidents also appear on highway stretches such as Talegaon, Chakan and Katraj. |
| required_icu … required_dialysis | bool | Resources the patient needs. They are correlated with type and severity: Road Accident implies trauma, blood bank and OT; Cardiac implies cardiology; Stroke implies neurology; Respiratory implies oxygen and ventilator. Critical cases average about 4 requirements and Low cases about 1. The link is probabilistic, not deterministic. |
| required_specialist | text / NULL | A single specialist the case needs, such as Neurologist. NULL means none is needed. |
| beds_required | int ≥1 | Almost always 1. It is 2–4 for occasional multi-victim accidents or burns. |
| ambulance_id | FK → ambulances / NULL | The ambulance dispatched for this request. It is NULL until dispatch, so it is NULL for CREATED, most MATCHING and most NO_MATCH requests. |
| request_timestamp | timestamp | When the call was logged. It follows a diurnal pattern with evening peaks. |
| request_status | text | CREATED (in intake queue), MATCHING (ranking done or awaiting a hospital response), NO_MATCH (no eligible hospital, or all eligible hospitals rejected), ASSIGNED (hospital accepted, ambulance not yet departed from scene), IN_TRANSIT, or COMPLETED. About 70% of requests are CREATED or MATCHING. Only requests that have workflow history carry later states. |

## 2. hospitals

| Column | Meaning |
|---|---|
| hospital_id | PK, `HSP-001`…`HSP-025` |
| hospital_name | Synthetic name |
| hospital_type | Government (5), Private (8), Multispecialty (4), Trauma Center (4), Specialty (4) |
| latitude / longitude | Spread across the city, PCMC, the eastern corridor and the Mulshi/Chakan fringe |
| address | Synthetic plot number with a real area and PIN code |
| emergency_department | FALSE for HSP-016 (a dialysis centre). A hospital without an ED is never eligible. |
| active_status | FALSE for HSP-021. An inactive hospital is never eligible. |

## 3. hospital_resources (one current snapshot per hospital)

The table has totals and availability for ICU beds, ventilators, oxygen beds and general beds. Every value satisfies `0 ≤ available ≤ total`.

| Column | Meaning |
|---|---|
| resource_record_id | PK, `RR-001` |
| hospital_id | FK → hospitals (one row per hospital) |
| total_* / available_* | Capacity and current availability |
| last_updated_timestamp | When availability was last reported. There are 11 **fresh** hospitals (≤5 min old), 8 **aging** (5–30 min) and 6 **stale** (>30 min, up to about 8 hours). |
| update_source | Hospital Staff / Admin / Simulation |

These hospital profiles are built in deliberately:

- **Excellent capacity but stale data:** HSP-007 and HSP-020.
- **Fresh data but limited capacity:** HSP-006, HSP-017 and HSP-025.
- **ICU completely full:** HSP-011 and HSP-014 (the latter is also stale).
- **No ventilators at all:** HSP-009 and HSP-017.
- **Almost full:** HSP-003, HSP-014 and HSP-023.

## 4. hospital_services

| Column | Meaning |
|---|---|
| service_record_id | PK, `SRV-001` |
| hospital_id | FK → hospitals (one row each) |
| trauma_care, cardiology, neurology, blood_bank, operation_theatre, dialysis, burn_unit | Whether the hospital offers the service. Probabilities depend on hospital type, and specialty hospitals are strong in their focus area: HSP-004 cardiac, HSP-005 neuro, HSP-016 renal, HSP-018 pulmonary, HSP-013 burns. |
| specialists | Semicolon-separated list of Cardiologist, Neurologist, Trauma Surgeon, General Surgeon, Pulmonologist and Nephrologist. It is derived from the services offered. |

## 5. ambulances (current snapshot)

| Column | Meaning |
|---|---|
| ambulance_id | PK, `AMB-001`…`AMB-100` |
| ambulance_type | Basic Life Support ~48%, Advanced Life Support ~42%, Other ~10%. ALS units are preferred for Critical and High cases. |
| current_latitude / current_longitude | For BUSY units, a point between the base and the scene, or between the scene and the hospital. Other units are near their base. |
| availability_status | AVAILABLE 67, BUSY 24, OFFLINE 9 |
| current_request_id | FK → emergency_requests. It is populated **only** when BUSY, and that request's `ambulance_id` points back to this unit. |
| last_location_update | Seconds old for active units and hours old for OFFLINE units |

## 6. resource_update_history

| Column | Meaning |
|---|---|
| update_id | PK, `UPD-000001` |
| hospital_id | FK → hospitals |
| resource_type | ICU / Ventilator / Oxygen Bed / General Bed. There are no rows for resources a hospital doesn't have. |
| old_available_count → new_available_count | Each row is a real change (old ≠ new). Every value stays within `[0, total]`. The records form a **continuous chain** per hospital and resource, so each row's `old` equals the previous row's `new`, and the last value equals the current snapshot. |
| updated_at | Timestamp. The latest ICU update equals the snapshot's `last_updated_timestamp`. |
| update_source | Hospital Staff / Admin / Simulation |

## 7. reservations

| Column | Meaning |
|---|---|
| reservation_id | PK, `RSV-000001` |
| request_id / hospital_id | FKs |
| resource_type | The primary bed type the request needs: ICU, else Oxygen Bed, else General Bed. A separate Ventilator hold is added when a ventilator is required. Holds are only ever placed on resources the hospital actually has. |
| quantity | beds_required for beds, 1 for a ventilator |
| reservation_status | CONFIRMED 1,729 (hold confirmed and patient accepted). FAILED 136 (resource already taken, mostly lost to a competing request). EXPIRED 123 (hospital never confirmed within 10 min). RELEASED 62 (hold confirmed, then released when the hospital declined). CANCELLED 54 (dispatcher cancelled the hold). PENDING 11 (live, awaiting confirmation). |
| requested_at | When the hold was requested |
| confirmed_at | NULL for PENDING, FAILED and EXPIRED. Otherwise it is always ≥ requested_at. |
| expires_at | requested_at + 10 min for unconfirmed holds, or + 15 min for confirmed holds |

## 8. emergency_workflow_handover

Each row is one hospital contacted for a request. A request can have several rejection rows followed by an accept row.

| Column | Meaning |
|---|---|
| workflow_id | PK, `WF-000001` |
| request_id / hospital_id / ambulance_id | FKs. The same ambulance serves every row of a request, and no ambulance handles two overlapping requests. |
| hospital_response | ACCEPTED / REJECTED / PENDING |
| rejection_reason | No Bed / No Equipment / Specialist Unavailable / Stale Data / Other. It is **NULL when the response is not REJECTED** rather than the string "None", which keeps it clean for SQL. Stale-data rejections are far more common at stale hospitals. |
| assignment_time | When the hospital was contacted or assigned |
| departure_time | When the ambulance left the scene with the patient |
| arrival_time | Arrival at the hospital |
| handover_time | Patient handed over to ED staff. The four timestamps always satisfy `assignment ≤ departure ≤ arrival ≤ handover`. For rejected or pending rows, the later times are NULL. For in-progress rows, times after the snapshot are NULL. |
| handover_status | COMPLETED / IN_PROGRESS / PENDING. It is NULL for REJECTED rows, because no handover applies. |

## 9. match_ranking_results (matching-engine output)

Each ranked request (1,920 of them) gets its **5 nearest hospitals**. A 6th, farther hospital is added when the nearby set has at most one eligible option, provided it is within about 55 min.

| Column | Meaning |
|---|---|
| match_id | PK, `MR-000001` |
| request_id / hospital_id | FKs. Each (request, hospital) pair and each (request, rank) pair is unique. |
| resource_match_score | 0.7 × (share of requirements met) + 0.3 × headroom, where headroom = min(1, available primary beds ÷ (5 × beds_required)) |
| distance_km | Straight-line distance × 1.35 road factor + 0.3 km |
| estimated_travel_time_min | distance ÷ speed + 2 min. Speed is 20 km/h at peak, 28 km/h off-peak and 40 km/h at night. |
| freshness_score | exp(−age_minutes / 45), from the hospital's `last_updated_timestamp`: about 0.9 when fresh and about 0 when many hours stale |
| final_suitability_score | 0.5 × resource + 0.3 × travel + 0.2 × freshness, where travel = max(0, 1 − time/60). **Ineligible hospitals are multiplied by 0.3**, so they can never score above an eligible one. |
| rank | Eligible hospitals come first, sorted by score, followed by ineligible ones. |
| eligibility | TRUE only if every mandatory requirement is met: required beds available, ventilator, services, specialist, active status and an ED. |
| explanation | A readable reason: what is missing, distance and time, data age with a fresh/aging/STALE label, and the score breakdown |

Note: eligibility is computed against the **current resource snapshot**. That is why a historical workflow can still show a "No Bed" rejection at a hospital marked eligible; it represents a race or an out-of-date view.

---

## Edge-case index (concrete IDs to demo)

| # | Scenario | Where to look |
|---|---|---|
| 1 | Normal successful allocation | REQ-000049 → HSP-012, WF-000011 (single accept, handover COMPLETED) |
| 2 | Stale availability data | HSP-007 (data about 5 h old, excellent capacity) is ranked high for REQ-000002 with a STALE warning in MR-000007. Stale-data rejection: WF-000024 (REQ-000074 at HSP-019) |
| 3 | Hospital rejects request | WF-000069: REQ-000190 rejected by HSP-012 (Specialist Unavailable), then accepted elsewhere |
| 4 | Insufficient ICU | MR-000016: HSP-014 for REQ-000003 ("ICU needs 1, 0 available") |
| 5 | No ventilator | MR-000010: HSP-009 for REQ-000002 ("no ventilators at facility") |
| 6 | Capable but much farther | REQ-000011: nearest is HSP-025 at 3.7 km (ineligible); rank 1 is HSP-002 at 16.6 km |
| 7 | Two requests competing for the last resource | Twin requests REQ-000052 and REQ-000054, 27 s apart, both Stroke and both needing ICU at HSP-013 |
| 8 | Reservation fails because another request reserved first | RSV-000021 (REQ-000052) CONFIRMED, then RSV-000022 (REQ-000054) FAILED 8 s later. REQ-000054 is re-routed to HSP-012. There are 50 such pairs, including REQ-000224 and REQ-000225 at HSP-007. |
| 9 | Reservation expires | RSV-000011 (REQ-000025 at HSP-004) EXPIRED with no confirmation |
| 10 | Resource becomes available after being unavailable | UPD-009995: HSP-006 ICU goes 0 → 1. There are 108 such ICU 0 → n transitions in total. |
| 11 | No suitable hospital initially | REQ-000029, REQ-000034 and REQ-000050: every candidate is INELIGIBLE (36 requests in total) |
| 12 | Similar suitability scores | REQ-000025: HSP-004 scores 0.839 and HSP-013 scores 0.838 |
| + | Closest hospital not eligible | 1,000+ requests, for example REQ-000011 |
| + | Multiple hospitals eligible | 1,640 requests |
| + | Live / simultaneous testing | 520 requests in the 06:00–12:00 live window; pending hospital responses on REQ-004968 and REQ-004970; 24 BUSY ambulances with active requests |
