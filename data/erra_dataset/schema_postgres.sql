-- Real-Time Emergency Resource Allocator - PostgreSQL schema + CSV load
-- Run from the folder containing the CSVs:   psql -d <db> -f schema_postgres.sql
-- Empty CSV fields load as NULL. Booleans are TRUE/FALSE. Timestamps are 'YYYY-MM-DD HH:MM:SS'.

BEGIN;

CREATE TABLE hospitals (
    hospital_id           VARCHAR(10) PRIMARY KEY,
    hospital_name         VARCHAR(120) NOT NULL,
    hospital_type         VARCHAR(20)  NOT NULL CHECK (hospital_type IN ('Government','Private','Multispecialty','Trauma Center','Specialty')),
    latitude              NUMERIC(9,6) NOT NULL,
    longitude             NUMERIC(9,6) NOT NULL,
    address               VARCHAR(200) NOT NULL,
    emergency_department  BOOLEAN NOT NULL,
    active_status         BOOLEAN NOT NULL
);

CREATE TABLE hospital_resources (
    resource_record_id     VARCHAR(10) PRIMARY KEY,
    hospital_id            VARCHAR(10) NOT NULL UNIQUE REFERENCES hospitals(hospital_id),
    total_icu_beds         INTEGER NOT NULL CHECK (total_icu_beds >= 0),
    available_icu_beds     INTEGER NOT NULL CHECK (available_icu_beds BETWEEN 0 AND total_icu_beds),
    total_ventilators      INTEGER NOT NULL CHECK (total_ventilators >= 0),
    available_ventilators  INTEGER NOT NULL CHECK (available_ventilators BETWEEN 0 AND total_ventilators),
    total_oxygen_beds      INTEGER NOT NULL CHECK (total_oxygen_beds >= 0),
    available_oxygen_beds  INTEGER NOT NULL CHECK (available_oxygen_beds BETWEEN 0 AND total_oxygen_beds),
    total_general_beds     INTEGER NOT NULL CHECK (total_general_beds >= 0),
    available_general_beds INTEGER NOT NULL CHECK (available_general_beds BETWEEN 0 AND total_general_beds),
    last_updated_timestamp TIMESTAMP NOT NULL,
    update_source          VARCHAR(20) NOT NULL CHECK (update_source IN ('Hospital Staff','Admin','Simulation'))
);

CREATE TABLE hospital_services (
    service_record_id  VARCHAR(10) PRIMARY KEY,
    hospital_id        VARCHAR(10) NOT NULL UNIQUE REFERENCES hospitals(hospital_id),
    trauma_care        BOOLEAN NOT NULL,
    cardiology         BOOLEAN NOT NULL,
    neurology          BOOLEAN NOT NULL,
    blood_bank         BOOLEAN NOT NULL,
    operation_theatre  BOOLEAN NOT NULL,
    dialysis           BOOLEAN NOT NULL,
    burn_unit          BOOLEAN NOT NULL,
    specialists        VARCHAR(200) NOT NULL   -- semicolon-separated list, or 'None'
);

-- ambulances <-> emergency_requests reference each other, so the cross FKs are added after loading
CREATE TABLE ambulances (
    ambulance_id          VARCHAR(10) PRIMARY KEY,
    ambulance_type        VARCHAR(30) NOT NULL CHECK (ambulance_type IN ('Basic Life Support','Advanced Life Support','Other')),
    current_latitude      NUMERIC(9,6) NOT NULL,
    current_longitude     NUMERIC(9,6) NOT NULL,
    availability_status   VARCHAR(10) NOT NULL CHECK (availability_status IN ('AVAILABLE','BUSY','OFFLINE')),
    current_request_id    VARCHAR(12),
    last_location_update  TIMESTAMP NOT NULL,
    CHECK ((availability_status = 'BUSY') = (current_request_id IS NOT NULL))
);

CREATE TABLE emergency_requests (
    request_id                  VARCHAR(12) PRIMARY KEY,
    patient_id                  VARCHAR(12) NOT NULL,
    emergency_type              VARCHAR(20) NOT NULL CHECK (emergency_type IN ('Road Accident','Cardiac','Stroke','Burn','Respiratory','Other')),
    severity                    VARCHAR(10) NOT NULL CHECK (severity IN ('Critical','High','Moderate','Low')),
    patient_age                 INTEGER NOT NULL CHECK (patient_age BETWEEN 0 AND 120),
    patient_latitude            NUMERIC(9,6) NOT NULL,
    patient_longitude           NUMERIC(9,6) NOT NULL,
    required_icu                BOOLEAN NOT NULL,
    required_ventilator         BOOLEAN NOT NULL,
    required_oxygen             BOOLEAN NOT NULL,
    required_trauma_care        BOOLEAN NOT NULL,
    required_cardiology         BOOLEAN NOT NULL,
    required_neurology          BOOLEAN NOT NULL,
    required_blood_bank         BOOLEAN NOT NULL,
    required_operation_theatre  BOOLEAN NOT NULL,
    required_dialysis           BOOLEAN NOT NULL,
    required_specialist         VARCHAR(30),
    beds_required               INTEGER NOT NULL CHECK (beds_required >= 1),
    ambulance_id                VARCHAR(10),
    request_timestamp           TIMESTAMP NOT NULL,
    request_status              VARCHAR(12) NOT NULL CHECK (request_status IN ('CREATED','MATCHING','NO_MATCH','ASSIGNED','IN_TRANSIT','COMPLETED'))
);

CREATE TABLE resource_update_history (
    update_id            VARCHAR(12) PRIMARY KEY,
    hospital_id          VARCHAR(10) NOT NULL REFERENCES hospitals(hospital_id),
    resource_type        VARCHAR(12) NOT NULL CHECK (resource_type IN ('ICU','Ventilator','Oxygen Bed','General Bed')),
    old_available_count  INTEGER NOT NULL CHECK (old_available_count >= 0),
    new_available_count  INTEGER NOT NULL CHECK (new_available_count >= 0),
    updated_at           TIMESTAMP NOT NULL,
    update_source        VARCHAR(20) NOT NULL
);

CREATE TABLE reservations (
    reservation_id      VARCHAR(12) PRIMARY KEY,
    request_id          VARCHAR(12) NOT NULL REFERENCES emergency_requests(request_id),
    hospital_id         VARCHAR(10) NOT NULL REFERENCES hospitals(hospital_id),
    resource_type       VARCHAR(12) NOT NULL CHECK (resource_type IN ('ICU','Ventilator','Oxygen Bed','General Bed')),
    quantity            INTEGER NOT NULL CHECK (quantity > 0),
    reservation_status  VARCHAR(10) NOT NULL CHECK (reservation_status IN ('PENDING','CONFIRMED','FAILED','RELEASED','EXPIRED','CANCELLED')),
    requested_at        TIMESTAMP NOT NULL,
    confirmed_at        TIMESTAMP CHECK (confirmed_at >= requested_at),
    expires_at          TIMESTAMP NOT NULL CHECK (expires_at > requested_at)
);

CREATE TABLE emergency_workflow_handover (
    workflow_id        VARCHAR(12) PRIMARY KEY,
    request_id         VARCHAR(12) NOT NULL REFERENCES emergency_requests(request_id),
    hospital_id        VARCHAR(10) NOT NULL REFERENCES hospitals(hospital_id),
    ambulance_id       VARCHAR(10) NOT NULL REFERENCES ambulances(ambulance_id),
    hospital_response  VARCHAR(10) NOT NULL CHECK (hospital_response IN ('PENDING','ACCEPTED','REJECTED')),
    rejection_reason   VARCHAR(30) CHECK (rejection_reason IN ('No Bed','No Equipment','Specialist Unavailable','Stale Data','Other')),
    assignment_time    TIMESTAMP NOT NULL,
    departure_time     TIMESTAMP CHECK (departure_time >= assignment_time),
    arrival_time       TIMESTAMP CHECK (arrival_time >= departure_time),
    handover_time      TIMESTAMP CHECK (handover_time >= arrival_time),
    handover_status    VARCHAR(12) CHECK (handover_status IN ('PENDING','IN_PROGRESS','COMPLETED'))
);

CREATE TABLE match_ranking_results (
    match_id                   VARCHAR(12) PRIMARY KEY,
    request_id                 VARCHAR(12) NOT NULL REFERENCES emergency_requests(request_id),
    hospital_id                VARCHAR(10) NOT NULL REFERENCES hospitals(hospital_id),
    resource_match_score       NUMERIC(4,3) NOT NULL CHECK (resource_match_score BETWEEN 0 AND 1),
    distance_km                NUMERIC(7,2) NOT NULL CHECK (distance_km >= 0),
    estimated_travel_time_min  NUMERIC(6,1) NOT NULL CHECK (estimated_travel_time_min > 0),
    freshness_score            NUMERIC(4,3) NOT NULL CHECK (freshness_score BETWEEN 0 AND 1),
    final_suitability_score    NUMERIC(4,3) NOT NULL CHECK (final_suitability_score BETWEEN 0 AND 1),
    rank                       INTEGER NOT NULL CHECK (rank >= 1),
    eligibility                BOOLEAN NOT NULL,
    explanation                TEXT NOT NULL,
    UNIQUE (request_id, hospital_id),
    UNIQUE (request_id, rank)
);

\copy hospitals FROM 'hospitals.csv' WITH (FORMAT csv, HEADER true)
\copy hospital_resources FROM 'hospital_resources.csv' WITH (FORMAT csv, HEADER true)
\copy hospital_services FROM 'hospital_services.csv' WITH (FORMAT csv, HEADER true)
\copy ambulances FROM 'ambulances.csv' WITH (FORMAT csv, HEADER true)
\copy emergency_requests FROM 'emergency_requests.csv' WITH (FORMAT csv, HEADER true)
\copy resource_update_history FROM 'resource_update_history.csv' WITH (FORMAT csv, HEADER true)
\copy reservations FROM 'reservations.csv' WITH (FORMAT csv, HEADER true)
\copy emergency_workflow_handover FROM 'emergency_workflow_handover.csv' WITH (FORMAT csv, HEADER true)
\copy match_ranking_results FROM 'match_ranking_results.csv' WITH (FORMAT csv, HEADER true)

ALTER TABLE emergency_requests ADD CONSTRAINT fk_req_ambulance FOREIGN KEY (ambulance_id) REFERENCES ambulances(ambulance_id);
ALTER TABLE ambulances ADD CONSTRAINT fk_amb_request FOREIGN KEY (current_request_id) REFERENCES emergency_requests(request_id);

CREATE INDEX idx_req_status ON emergency_requests(request_status);
CREATE INDEX idx_req_ts ON emergency_requests(request_timestamp);
CREATE INDEX idx_res_hosp_status ON reservations(hospital_id, reservation_status);
CREATE INDEX idx_hist_hosp_type_time ON resource_update_history(hospital_id, resource_type, updated_at);
CREATE INDEX idx_match_req_rank ON match_ranking_results(request_id, rank);

COMMIT;
