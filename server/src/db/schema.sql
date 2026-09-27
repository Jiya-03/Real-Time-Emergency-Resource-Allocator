-- Real-Time Emergency Resource Allocator: database schema

-- Hospitals (static info)
CREATE TABLE IF NOT EXISTS hospitals (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  specialties   TEXT NOT NULL DEFAULT '[]',   -- JSON array, e.g. ["trauma","cardiac"]
  last_updated  TEXT NOT NULL                 -- ISO time of last capacity update (freshness)
);

-- Live capacity per resource type. "version" is bumped on every change
-- so two dispatchers can never book the same last bed (optimistic locking).
CREATE TABLE IF NOT EXISTS resources (
  hospital_id   TEXT NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,                -- icu_beds | general_beds | ventilators | er_slots
  total         INTEGER NOT NULL CHECK (total >= 0),
  available     INTEGER NOT NULL CHECK (available >= 0 AND available <= total),
  version       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (hospital_id, type)
);

-- Incoming emergency created by a dispatcher
CREATE TABLE IF NOT EXISTS emergency_requests (
  id                  TEXT PRIMARY KEY,
  severity            TEXT NOT NULL CHECK (severity IN ('critical','serious','stable')),
  required_resource   TEXT NOT NULL,          -- which resource type the patient needs
  required_specialty  TEXT,                   -- optional, e.g. "cardiac"
  pickup_lat          REAL NOT NULL,
  pickup_lng          REAL NOT NULL,
  notes               TEXT,
  status              TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','assigned','completed','cancelled')),
  created_at          TEXT NOT NULL
);

-- A hold on one unit of a resource at one hospital for one request
CREATE TABLE IF NOT EXISTS reservations (
  id               TEXT PRIMARY KEY,
  request_id       TEXT NOT NULL REFERENCES emergency_requests(id),
  hospital_id      TEXT NOT NULL REFERENCES hospitals(id),
  resource_type    TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','accepted','rejected','expired',
                                     'en_route','arrived','handed_over','cancelled')),
  hold_expires_at  TEXT NOT NULL,             -- bed auto-releases after this if not accepted
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- Audit trail: every status change, used for the handoff timeline
CREATE TABLE IF NOT EXISTS reservation_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id  TEXT NOT NULL REFERENCES reservations(id),
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  note            TEXT,
  at              TEXT NOT NULL
);

-- Only ONE active reservation per request (stops a request double-booking two hospitals)
CREATE UNIQUE INDEX IF NOT EXISTS one_active_reservation_per_request
  ON reservations(request_id)
  WHERE status IN ('pending','accepted','en_route','arrived');

CREATE INDEX IF NOT EXISTS idx_reservations_hospital ON reservations(hospital_id, status);
