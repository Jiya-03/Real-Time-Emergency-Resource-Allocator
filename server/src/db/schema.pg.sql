-- Postgres tables for DATABASE_URL mode (the server runs this on start; safe to run again).
-- Same columns as the SQLite schema (timestamps are ISO text in both), so the same SQL works on both.
-- For Supabase, also run supabase/schema.sql once in the SQL editor (row-level security, realtime, live views).

create table if not exists hospitals (
  hospital_id           text PRIMARY KEY,
  hospital_name         text NOT NULL,
  hospital_type         text NOT NULL CHECK (hospital_type IN ('Government','Private','Multispecialty','Trauma Center','Specialty')),
  latitude              double precision NOT NULL,
  longitude             double precision NOT NULL,
  address               text NOT NULL,
  emergency_department  integer NOT NULL CHECK (emergency_department IN (0,1)),
  active_status         integer NOT NULL CHECK (active_status IN (0,1))
);

create table if not exists hospital_resources (
  resource_record_id      text PRIMARY KEY,
  hospital_id             text NOT NULL UNIQUE,
  total_icu_beds          integer NOT NULL CHECK (total_icu_beds >= 0),
  available_icu_beds      integer NOT NULL CHECK (available_icu_beds BETWEEN 0 AND total_icu_beds),
  total_ventilators       integer NOT NULL CHECK (total_ventilators >= 0),
  available_ventilators   integer NOT NULL CHECK (available_ventilators BETWEEN 0 AND total_ventilators),
  total_oxygen_beds       integer NOT NULL CHECK (total_oxygen_beds >= 0),
  available_oxygen_beds   integer NOT NULL CHECK (available_oxygen_beds BETWEEN 0 AND total_oxygen_beds),
  total_general_beds      integer NOT NULL CHECK (total_general_beds >= 0),
  available_general_beds  integer NOT NULL CHECK (available_general_beds BETWEEN 0 AND total_general_beds),
  last_updated_timestamp  text NOT NULL,
  update_source           text NOT NULL CHECK (update_source IN ('Hospital Staff','Admin','Simulation')),
  version                 integer NOT NULL DEFAULT 1
);

create table if not exists hospital_services (
  service_record_id  text PRIMARY KEY,
  hospital_id        text NOT NULL UNIQUE,
  trauma_care        integer NOT NULL,
  cardiology         integer NOT NULL,
  neurology          integer NOT NULL,
  blood_bank         integer NOT NULL,
  operation_theatre  integer NOT NULL,
  dialysis           integer NOT NULL,
  burn_unit          integer NOT NULL,
  specialists        text NOT NULL             -- "Cardiologist;Trauma Surgeon" or "None"
);

create table if not exists ambulances (
  ambulance_id          text PRIMARY KEY,
  ambulance_type        text NOT NULL CHECK (ambulance_type IN ('Basic Life Support','Advanced Life Support','Other')),
  current_latitude      double precision NOT NULL,
  current_longitude     double precision NOT NULL,
  availability_status   text NOT NULL CHECK (availability_status IN ('AVAILABLE','BUSY','OFFLINE')),
  current_request_id    text,
  last_location_update  text NOT NULL
);

create table if not exists emergency_requests (
  request_id                  text PRIMARY KEY,
  patient_id                  text NOT NULL,
  emergency_type              text NOT NULL CHECK (emergency_type IN ('Road Accident','Cardiac','Stroke','Burn','Respiratory','Other')),
  severity                    text NOT NULL CHECK (severity IN ('Critical','High','Moderate','Low')),
  patient_age                 integer NOT NULL CHECK (patient_age BETWEEN 0 AND 120),
  patient_latitude            double precision NOT NULL,
  patient_longitude           double precision NOT NULL,
  required_icu                integer NOT NULL,
  required_ventilator         integer NOT NULL,
  required_oxygen             integer NOT NULL,
  required_trauma_care        integer NOT NULL,
  required_cardiology         integer NOT NULL,
  required_neurology          integer NOT NULL,
  required_blood_bank         integer NOT NULL,
  required_operation_theatre  integer NOT NULL,
  required_dialysis           integer NOT NULL,
  required_specialist         text,
  beds_required               integer NOT NULL CHECK (beds_required >= 1),
  ambulance_id                text,
  request_timestamp           text NOT NULL,
  request_status              text NOT NULL CHECK (request_status IN ('CREATED','MATCHING','NO_MATCH','ASSIGNED','IN_TRANSIT','COMPLETED')),
  additional_needs            text,         -- OUR addition: JSON array of extra items (e.g. ["CT Scanner"]) not tracked in capacity data
  field_report                text,         -- OUR addition: JSON { bp, hr, spo2, notes } from the paramedic crew (optional)
  broadcast_round             integer NOT NULL DEFAULT 0,  -- OUR addition: how many "alert all suitable hospitals" waves were sent
  patient_condition           text CHECK (patient_condition IS NULL OR patient_condition IN ('Critical','Serious','Need Assistance','Stable','Minor'))  -- OUR addition: dispatcher's label (maps to severity)
);

create table if not exists resource_update_history (
  update_id            text PRIMARY KEY,
  hospital_id          text NOT NULL,
  resource_type        text NOT NULL CHECK (resource_type IN ('ICU','Ventilator','Oxygen Bed','General Bed')),
  old_available_count  integer NOT NULL CHECK (old_available_count >= 0),
  new_available_count  integer NOT NULL CHECK (new_available_count >= 0),
  updated_at           text NOT NULL,
  update_source        text NOT NULL
);

create table if not exists reservations (
  reservation_id      text PRIMARY KEY,
  request_id          text NOT NULL,
  hospital_id         text NOT NULL,
  resource_type       text NOT NULL CHECK (resource_type IN ('ICU','Ventilator','Oxygen Bed','General Bed')),
  quantity            integer NOT NULL CHECK (quantity > 0),
  reservation_status  text NOT NULL CHECK (reservation_status IN ('PENDING','CONFIRMED','FAILED','RELEASED','EXPIRED','CANCELLED')),
  requested_at        text NOT NULL,
  confirmed_at        text CHECK (confirmed_at IS NULL OR confirmed_at >= requested_at),
  expires_at          text NOT NULL CHECK (expires_at > requested_at),
  holds_capacity      integer NOT NULL DEFAULT 0   -- OUR addition: 1 = this hold subtracted beds (so releasing it returns them). Dataset rows = 0.
);

create table if not exists emergency_workflow_handover (
  workflow_id        text PRIMARY KEY,
  request_id         text NOT NULL,
  hospital_id        text NOT NULL,
  ambulance_id       text NOT NULL,
  hospital_response  text NOT NULL CHECK (hospital_response IN ('PENDING','ACCEPTED','REJECTED','WITHDRAWN')),  -- OUR addition: WITHDRAWN = filled by another hospital / cancelled by dispatcher
  rejection_reason   text CHECK (rejection_reason IS NULL OR rejection_reason IN ('No Bed','No Equipment','Specialist Unavailable','Stale Data','Other')),
  assignment_time    text NOT NULL,
  departure_time     text,
  arrival_time       text,
  handover_time      text,
  handover_status    text CHECK (handover_status IS NULL OR handover_status IN ('PENDING','IN_PROGRESS','COMPLETED'))
);

create table if not exists admissions (
  request_id   text PRIMARY KEY,
  hospital_id  text NOT NULL,
  ward         text,
  block        text,
  floor        text,
  room         text,
  bed          text,
  attending    text,
  nurse        text,
  resources    text NOT NULL DEFAULT '{}',   -- JSON { "icu": 1, "ventilator": 1 }: units this patient occupies right now
  services     text NOT NULL DEFAULT '[]',   -- JSON ["operation_theatre", "blood_bank"]: departments involved
  created_at   text NOT NULL,
  updated_at   text NOT NULL,
  admitted_at  text                          -- set when the handover is completed
);

create table if not exists match_ranking_results (
  match_id                   text PRIMARY KEY,
  request_id                 text NOT NULL,
  hospital_id                text NOT NULL,
  resource_match_score       double precision NOT NULL CHECK (resource_match_score BETWEEN 0 AND 1),
  distance_km                double precision NOT NULL CHECK (distance_km >= 0),
  estimated_travel_time_min  double precision NOT NULL CHECK (estimated_travel_time_min > 0),
  freshness_score            double precision NOT NULL CHECK (freshness_score BETWEEN 0 AND 1),
  final_suitability_score    double precision NOT NULL CHECK (final_suitability_score BETWEEN 0 AND 1),
  rank                       integer NOT NULL CHECK (rank >= 1),
  eligibility                integer NOT NULL,
  explanation                text NOT NULL
);

-- Live ambulance position (one row per emergency, updated every few seconds while driving)
create table if not exists ambulance_positions (
  request_id   text PRIMARY KEY,
  hospital_id  text,
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  source       text NOT NULL,            -- gps | simulated
  accuracy_m   integer,
  left_km      double precision,
  eta_min      integer,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Helpful indexes for the dashboards
create index if not exists idx_req_status   on emergency_requests(request_status);
create index if not exists idx_res_request  on reservations(request_id);
create index if not exists idx_wf_request   on emergency_workflow_handover(request_id);
create index if not exists idx_mr_request   on match_ranking_results(request_id);

