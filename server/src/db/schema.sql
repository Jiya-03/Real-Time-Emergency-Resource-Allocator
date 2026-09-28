-- Real-Time Emergency Resource Allocator: SQLite schema
-- Mirrors the ERRA dataset (data/erra_dataset/schema_postgres.sql) so the CSVs load 1:1.
-- Booleans are stored as 0/1. Timestamps are ISO-8601 UTC strings.

-- ───────────────────────── Hospitals ─────────────────────────
CREATE TABLE IF NOT EXISTS hospitals (
  hospital_id           TEXT PRIMARY KEY,
  hospital_name         TEXT NOT NULL,
  hospital_type         TEXT NOT NULL CHECK (hospital_type IN ('Government','Private','Multispecialty','Trauma Center','Specialty')),
  latitude              REAL NOT NULL,
  longitude             REAL NOT NULL,
  address               TEXT NOT NULL,
  emergency_department  INTEGER NOT NULL CHECK (emergency_department IN (0,1)),
  active_status         INTEGER NOT NULL CHECK (active_status IN (0,1))
);

-- Live capacity snapshot (one row per hospital).
-- "version" is OUR addition: bumped on every change so two dispatchers
-- can never grab the same last bed (optimistic locking, used in Step 8).
CREATE TABLE IF NOT EXISTS hospital_resources (
  resource_record_id      TEXT PRIMARY KEY,
  hospital_id             TEXT NOT NULL UNIQUE REFERENCES hospitals(hospital_id),
  total_icu_beds          INTEGER NOT NULL CHECK (total_icu_beds >= 0),
  available_icu_beds      INTEGER NOT NULL CHECK (available_icu_beds BETWEEN 0 AND total_icu_beds),
  total_ventilators       INTEGER NOT NULL CHECK (total_ventilators >= 0),
  available_ventilators   INTEGER NOT NULL CHECK (available_ventilators BETWEEN 0 AND total_ventilators),
  total_oxygen_beds       INTEGER NOT NULL CHECK (total_oxygen_beds >= 0),
  available_oxygen_beds   INTEGER NOT NULL CHECK (available_oxygen_beds BETWEEN 0 AND total_oxygen_beds),
  total_general_beds      INTEGER NOT NULL CHECK (total_general_beds >= 0),
  available_general_beds  INTEGER NOT NULL CHECK (available_general_beds BETWEEN 0 AND total_general_beds),
  last_updated_timestamp  TEXT NOT NULL,
  update_source           TEXT NOT NULL CHECK (update_source IN ('Hospital Staff','Admin','Simulation')),
  version                 INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS hospital_services (
  service_record_id  TEXT PRIMARY KEY,
  hospital_id        TEXT NOT NULL UNIQUE REFERENCES hospitals(hospital_id),
  trauma_care        INTEGER NOT NULL,
  cardiology         INTEGER NOT NULL,
  neurology          INTEGER NOT NULL,
  blood_bank         INTEGER NOT NULL,
  operation_theatre  INTEGER NOT NULL,
  dialysis           INTEGER NOT NULL,
  burn_unit          INTEGER NOT NULL,
  specialists        TEXT NOT NULL             -- "Cardiologist;Trauma Surgeon" or "None"
);

-- ───────────────────────── Ambulances & requests ─────────────────────────
CREATE TABLE IF NOT EXISTS ambulances (
  ambulance_id          TEXT PRIMARY KEY,
  ambulance_type        TEXT NOT NULL CHECK (ambulance_type IN ('Basic Life Support','Advanced Life Support','Other')),
  current_latitude      REAL NOT NULL,
  current_longitude     REAL NOT NULL,
  availability_status   TEXT NOT NULL CHECK (availability_status IN ('AVAILABLE','BUSY','OFFLINE')),
  current_request_id    TEXT REFERENCES emergency_requests(request_id),
  last_location_update  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emergency_requests (
  request_id                  TEXT PRIMARY KEY,
  patient_id                  TEXT NOT NULL,
  emergency_type              TEXT NOT NULL CHECK (emergency_type IN ('Road Accident','Cardiac','Stroke','Burn','Respiratory','Other')),
  severity                    TEXT NOT NULL CHECK (severity IN ('Critical','High','Moderate','Low')),
  patient_age                 INTEGER NOT NULL CHECK (patient_age BETWEEN 0 AND 120),
  patient_latitude            REAL NOT NULL,
  patient_longitude           REAL NOT NULL,
  required_icu                INTEGER NOT NULL,
  required_ventilator         INTEGER NOT NULL,
  required_oxygen             INTEGER NOT NULL,
  required_trauma_care        INTEGER NOT NULL,
  required_cardiology         INTEGER NOT NULL,
  required_neurology          INTEGER NOT NULL,
  required_blood_bank         INTEGER NOT NULL,
  required_operation_theatre  INTEGER NOT NULL,
  required_dialysis           INTEGER NOT NULL,
  required_specialist         TEXT,
  beds_required               INTEGER NOT NULL CHECK (beds_required >= 1),
  ambulance_id                TEXT REFERENCES ambulances(ambulance_id),
  request_timestamp           TEXT NOT NULL,
  request_status              TEXT NOT NULL CHECK (request_status IN ('CREATED','MATCHING','NO_MATCH','ASSIGNED','IN_TRANSIT','COMPLETED')),
  additional_needs            TEXT,         -- OUR addition: JSON array of extra items (e.g. ["CT Scanner"]) not tracked in capacity data
  field_report                TEXT,         -- OUR addition: JSON { bp, hr, spo2, notes } from the paramedic crew (optional)
  broadcast_round             INTEGER NOT NULL DEFAULT 0,  -- OUR addition: how many "alert all suitable hospitals" waves were sent
  patient_condition           TEXT CHECK (patient_condition IS NULL OR patient_condition IN ('Critical','Serious','Need Assistance','Stable','Minor'))  -- OUR addition: dispatcher's label (maps to severity)
);

-- ───────────────────────── History, reservations, handover ─────────────────────────
CREATE TABLE IF NOT EXISTS resource_update_history (
  update_id            TEXT PRIMARY KEY,
  hospital_id          TEXT NOT NULL REFERENCES hospitals(hospital_id),
  resource_type        TEXT NOT NULL CHECK (resource_type IN ('ICU','Ventilator','Oxygen Bed','General Bed')),
  old_available_count  INTEGER NOT NULL CHECK (old_available_count >= 0),
  new_available_count  INTEGER NOT NULL CHECK (new_available_count >= 0),
  updated_at           TEXT NOT NULL,
  update_source        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reservations (
  reservation_id      TEXT PRIMARY KEY,
  request_id          TEXT NOT NULL REFERENCES emergency_requests(request_id),
  hospital_id         TEXT NOT NULL REFERENCES hospitals(hospital_id),
  resource_type       TEXT NOT NULL CHECK (resource_type IN ('ICU','Ventilator','Oxygen Bed','General Bed')),
  quantity            INTEGER NOT NULL CHECK (quantity > 0),
  reservation_status  TEXT NOT NULL CHECK (reservation_status IN ('PENDING','CONFIRMED','FAILED','RELEASED','EXPIRED','CANCELLED')),
  requested_at        TEXT NOT NULL,
  confirmed_at        TEXT CHECK (confirmed_at IS NULL OR confirmed_at >= requested_at),
  expires_at          TEXT NOT NULL CHECK (expires_at > requested_at),
  holds_capacity      INTEGER NOT NULL DEFAULT 0   -- OUR addition: 1 = this hold subtracted beds (so releasing it returns them). Dataset rows = 0.
);

CREATE TABLE IF NOT EXISTS emergency_workflow_handover (
  workflow_id        TEXT PRIMARY KEY,
  request_id         TEXT NOT NULL REFERENCES emergency_requests(request_id),
  hospital_id        TEXT NOT NULL REFERENCES hospitals(hospital_id),
  ambulance_id       TEXT NOT NULL REFERENCES ambulances(ambulance_id),
  hospital_response  TEXT NOT NULL CHECK (hospital_response IN ('PENDING','ACCEPTED','REJECTED','WITHDRAWN')),  -- OUR addition: WITHDRAWN = filled by another hospital / cancelled by dispatcher
  rejection_reason   TEXT CHECK (rejection_reason IS NULL OR rejection_reason IN ('No Bed','No Equipment','Specialist Unavailable','Stale Data','Other')),
  assignment_time    TEXT NOT NULL,
  departure_time     TEXT,
  arrival_time       TEXT,
  handover_time      TEXT,
  handover_status    TEXT CHECK (handover_status IS NULL OR handover_status IN ('PENDING','IN_PROGRESS','COMPLETED'))
);

-- OUR addition: where the patient was admitted at handover + which tracked resources they occupy
CREATE TABLE IF NOT EXISTS admissions (
  request_id   TEXT PRIMARY KEY REFERENCES emergency_requests(request_id),
  hospital_id  TEXT NOT NULL REFERENCES hospitals(hospital_id),
  ward         TEXT,
  block        TEXT,
  floor        TEXT,
  room         TEXT,
  bed          TEXT,
  attending    TEXT,
  nurse        TEXT,
  resources    TEXT NOT NULL DEFAULT '{}',   -- JSON { "icu": 1, "ventilator": 1 }: units this patient occupies right now
  services     TEXT NOT NULL DEFAULT '[]',   -- JSON ["operation_theatre", "blood_bank"]: departments involved
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  admitted_at  TEXT                          -- set when the handover is completed
);

CREATE TABLE IF NOT EXISTS match_ranking_results (
  match_id                   TEXT PRIMARY KEY,
  request_id                 TEXT NOT NULL REFERENCES emergency_requests(request_id),
  hospital_id                TEXT NOT NULL REFERENCES hospitals(hospital_id),
  resource_match_score       REAL NOT NULL CHECK (resource_match_score BETWEEN 0 AND 1),
  distance_km                REAL NOT NULL CHECK (distance_km >= 0),
  estimated_travel_time_min  REAL NOT NULL CHECK (estimated_travel_time_min > 0),
  freshness_score            REAL NOT NULL CHECK (freshness_score BETWEEN 0 AND 1),
  final_suitability_score    REAL NOT NULL CHECK (final_suitability_score BETWEEN 0 AND 1),
  rank                       INTEGER NOT NULL CHECK (rank >= 1),
  eligibility                INTEGER NOT NULL,
  explanation                TEXT NOT NULL,
  UNIQUE (request_id, hospital_id),
  UNIQUE (request_id, rank)
);

-- ───────────────────────── Indexes ─────────────────────────
CREATE INDEX IF NOT EXISTS idx_req_status        ON emergency_requests(request_status);
CREATE INDEX IF NOT EXISTS idx_req_ts            ON emergency_requests(request_timestamp);
CREATE INDEX IF NOT EXISTS idx_res_hosp_status   ON reservations(hospital_id, reservation_status);
CREATE INDEX IF NOT EXISTS idx_res_request       ON reservations(request_id);
CREATE INDEX IF NOT EXISTS idx_hist_hosp_type_ts ON resource_update_history(hospital_id, resource_type, updated_at);
CREATE INDEX IF NOT EXISTS idx_wf_request        ON emergency_workflow_handover(request_id);
CREATE INDEX IF NOT EXISTS idx_mr_request        ON match_ranking_results(request_id);
