-- ═══════════════════════════════════════════════════════════════════════════
-- JeevanRoute ↔ Supabase: run this ONCE in Supabase → SQL Editor → New query → Run.
-- Creates the same tables as the app's local database, plus live-tracking tables/views,
-- turns on Realtime for the hospital tables (so edits you make in Supabase flow back into
-- the app), and locks everything with Row Level Security (only the server's service key
-- can read/write; the public anon key sees nothing).
-- Safe to run again.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.hospitals (
  hospital_id           text PRIMARY KEY,
  hospital_name         text NOT NULL,
  hospital_type         text NOT NULL CHECK (hospital_type IN ('Government','Private','Multispecialty','Trauma Center','Specialty')),
  latitude              double precision NOT NULL,
  longitude             double precision NOT NULL,
  address               text NOT NULL,
  emergency_department  integer NOT NULL CHECK (emergency_department IN (0,1)),
  active_status         integer NOT NULL CHECK (active_status IN (0,1))
);

create table if not exists public.hospital_resources (
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

create table if not exists public.hospital_services (
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

create table if not exists public.ambulances (
  ambulance_id          text PRIMARY KEY,
  ambulance_type        text NOT NULL CHECK (ambulance_type IN ('Basic Life Support','Advanced Life Support','Other')),
  current_latitude      double precision NOT NULL,
  current_longitude     double precision NOT NULL,
  availability_status   text NOT NULL CHECK (availability_status IN ('AVAILABLE','BUSY','OFFLINE')),
  current_request_id    text,
  last_location_update  text NOT NULL
);

create table if not exists public.emergency_requests (
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

create table if not exists public.resource_update_history (
  update_id            text PRIMARY KEY,
  hospital_id          text NOT NULL,
  resource_type        text NOT NULL CHECK (resource_type IN ('ICU','Ventilator','Oxygen Bed','General Bed')),
  old_available_count  integer NOT NULL CHECK (old_available_count >= 0),
  new_available_count  integer NOT NULL CHECK (new_available_count >= 0),
  updated_at           text NOT NULL,
  update_source        text NOT NULL
);

create table if not exists public.reservations (
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

create table if not exists public.emergency_workflow_handover (
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

create table if not exists public.admissions (
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

create table if not exists public.match_ranking_results (
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
create table if not exists public.ambulance_positions (
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
create index if not exists idx_req_status   on public.emergency_requests(request_status);
create index if not exists idx_res_request  on public.reservations(request_id);
create index if not exists idx_wf_request   on public.emergency_workflow_handover(request_id);
create index if not exists idx_mr_request   on public.match_ranking_results(request_id);

-- ───────────── Live views (read-only; open them in Table Editor) ─────────────
create or replace view public.live_hospital_capacity as
select h.hospital_id, h.hospital_name, h.hospital_type,
       (h.emergency_department = 1 and h.active_status = 1) as accepting_patients,
       r.available_icu_beds || ' / ' || r.total_icu_beds         as icu,
       r.available_ventilators || ' / ' || r.total_ventilators   as ventilators,
       r.available_oxygen_beds || ' / ' || r.total_oxygen_beds   as oxygen_beds,
       r.available_general_beds || ' / ' || r.total_general_beds as general_beds,
       concat_ws(', ',
         case when s.trauma_care = 1 then 'Trauma' end, case when s.cardiology = 1 then 'Cardiology' end,
         case when s.neurology = 1 then 'Neurology' end, case when s.operation_theatre = 1 then 'OT' end,
         case when s.blood_bank = 1 then 'Blood Bank' end, case when s.dialysis = 1 then 'Dialysis' end,
         case when s.burn_unit = 1 then 'Burns' end)            as departments,
       s.specialists,
       round(extract(epoch from (now() - r.last_updated_timestamp::timestamptz)) / 60) as data_age_min,
       r.update_source, r.version
from public.hospitals h
left join public.hospital_resources r on r.hospital_id = h.hospital_id
left join public.hospital_services  s on s.hospital_id = h.hospital_id;

create or replace view public.live_emergencies as
select e.request_id, e.emergency_type, coalesce(e.patient_condition, e.severity) as condition, e.patient_age,
       e.request_status, e.request_timestamp, e.broadcast_round,
       (select count(*) from public.emergency_workflow_handover w where w.request_id = e.request_id and w.hospital_response = 'PENDING') as hospitals_deciding,
       acc.hospital_id as accepted_hospital, h.hospital_name as accepted_hospital_name,
       acc.departure_time, acc.arrival_time, acc.handover_time,
       p.lat as ambulance_lat, p.lng as ambulance_lng, p.source as position_source, p.eta_min, p.left_km, p.updated_at as position_updated_at,
       a.ward, a.room, a.bed
from public.emergency_requests e
left join lateral (select * from public.emergency_workflow_handover w
                   where w.request_id = e.request_id and w.hospital_response = 'ACCEPTED'
                   order by w.assignment_time desc limit 1) acc on true
left join public.hospitals h on h.hospital_id = acc.hospital_id
left join public.ambulance_positions p on p.request_id = e.request_id
left join public.admissions a on a.request_id = e.request_id
where e.request_status in ('CREATED','MATCHING','NO_MATCH','ASSIGNED','IN_TRANSIT')
   or e.request_timestamp >= to_char(now() - interval '6 hours', 'YYYY-MM-DD"T"HH24:MI:SS');

-- ───────────── Security: RLS on, no public policies (server uses the service_role key) ─────────────
do $$
declare t text;
begin
  foreach t in array array['hospitals','hospital_resources','hospital_services','ambulances','emergency_requests',
    'resource_update_history','reservations','emergency_workflow_handover','admissions','match_ranking_results','ambulance_positions']
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
alter view public.live_hospital_capacity set (security_invoker = true);
alter view public.live_emergencies set (security_invoker = true);

-- ───────────── Realtime: hospital edits flow back into the app; positions/emergencies are watchable ─────────────
do $$
declare t text;
begin
  foreach t in array array['hospitals','hospital_resources','hospital_services','emergency_requests','ambulance_positions']
  loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
