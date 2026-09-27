"""
Synthetic dataset generator - Real-Time Emergency Resource Allocator (HLTH-02)
Demo region: Pune Metropolitan Region, Maharashtra (all data SYNTHETIC).
Snapshot "now" = 2026-09-28 12:00:00. Deterministic (seeded).
"""
import math, random, os
from datetime import datetime, timedelta
import numpy as np
import pandas as pd

SEED = 42
random.seed(SEED); np.random.seed(SEED)
rng = np.random.default_rng(SEED)
OUT = os.environ.get("OUT_DIR", "out")
os.makedirs(OUT, exist_ok=True)

NOW = datetime(2026, 9, 28, 12, 0, 0)
HIST_START = datetime(2026, 9, 1, 0, 0, 0)
LIVE_START = datetime(2026, 9, 28, 6, 0, 0)
FMT = "%Y-%m-%d %H:%M:%S"

def ts(d): return None if (d is None or pd.isna(d)) else d.strftime(FMT)

def hav(lat1, lon1, lat2, lon2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*R*math.asin(math.sqrt(a))

def road_km(lat1, lon1, lat2, lon2):
    return hav(lat1, lon1, lat2, lon2) * 1.35 + 0.3

def speed_kmh(t):
    h = t.hour
    if 8 <= h < 11 or 17 <= h < 21: return 20.0
    if 23 <= h or h < 6: return 40.0
    return 28.0

def travel_min(km, t):
    return km / speed_kmh(t) * 60 + 2.0

# ---------------------------------------------------------------- AREAS
AREAS = {
    "Baner": (18.5590, 73.7868, "411045"), "Hinjewadi": (18.5913, 73.7389, "411057"),
    "Wakad": (18.5987, 73.7650, "411057"), "Aundh": (18.5580, 73.8075, "411007"),
    "Shivajinagar": (18.5308, 73.8475, "411005"), "Deccan": (18.5167, 73.8410, "411004"),
    "Kothrud": (18.5074, 73.8077, "411038"), "Swargate": (18.5018, 73.8636, "411042"),
    "Hadapsar": (18.5089, 73.9260, "411028"), "Kharadi": (18.5515, 73.9350, "411014"),
    "Viman Nagar": (18.5679, 73.9143, "411014"), "Yerawada": (18.5530, 73.8770, "411006"),
    "Pimpri": (18.6279, 73.8009, "411018"), "Chinchwad": (18.6451, 73.7926, "411033"),
    "Nigdi": (18.6517, 73.7707, "411044"), "Bhosari": (18.6286, 73.8480, "411026"),
    "Katraj": (18.4575, 73.8660, "411046"), "Kondhwa": (18.4750, 73.8910, "411048"),
    "Wagholi": (18.5800, 73.9800, "412207"), "Warje": (18.4820, 73.8000, "411058"),
    "Sinhagad Road": (18.4700, 73.8200, "411041"), "Camp": (18.5150, 73.8780, "411001"),
    "Magarpatta": (18.5150, 73.9280, "411013"), "Pirangut": (18.5110, 73.6810, "412115"),
    "Chakan": (18.7600, 73.8600, "410501"), "Talegaon": (18.7350, 73.6750, "410506"),
    "Undri": (18.4530, 73.9150, "411060"), "Lavale": (18.5330, 73.7330, "412115"),
}

# ---------------------------------------------------------------- HOSPITALS
# (name, type, area, road, profile flags)
H_SPEC = [
    ("Mula Riverside Multispeciality Hospital", "Multispecialty", "Aundh", "ITI Road", {"fresh"}),
    ("Sahyagiri Trauma & Critical Care Centre", "Trauma Center", "Hinjewadi", "Phase 1 Road", {"fresh"}),
    ("Pune Municipal General Hospital", "Government", "Swargate", "Shankarseth Road", {"almost_full", "aging"}),
    ("Deccan Heart Institute", "Specialty", "Deccan", "Fergusson College Road", {"focus_cardiac", "fresh"}),
    ("Shivneri Neuro & Stroke Centre", "Specialty", "Kothrud", "Paud Road", {"focus_neuro", "aging"}),
    ("Kharadi Lifeline Hospital", "Private", "Kharadi", "EON IT Park Road", {"fresh_limited"}),
    ("Viman Care Multispeciality Hospital", "Multispecialty", "Viman Nagar", "Airport Road", {"stale_excellent"}),
    ("PCMC District Civil Hospital", "Government", "Pimpri", "Old Mumbai-Pune Highway", {"aging"}),
    ("Chinchwad Metro Hospital", "Private", "Chinchwad", "Link Road", {"no_vent", "fresh"}),
    ("Nigdi Expressway Trauma Centre", "Trauma Center", "Nigdi", "Mumbai-Pune Service Road", {"stale"}),
    ("Hadapsar Sunrise Hospital", "Private", "Hadapsar", "Solapur Road", {"icu_full", "fresh"}),
    ("Magarpatta Multispeciality Hospital", "Multispecialty", "Magarpatta", "Magarpatta City Road", {"fresh"}),
    ("Katraj Ghat Trauma & Burns Centre", "Trauma Center", "Katraj", "Pune-Satara Road", {"focus_burn", "aging"}),
    ("Kondhwa Community Hospital", "Government", "Kondhwa", "NIBM Road", {"stale", "almost_full"}),
    ("Baner Crest Hospital", "Private", "Baner", "Baner-Pashan Link Road", {"aging"}),
    ("Yerawada Kidney & Dialysis Centre", "Specialty", "Yerawada", "Nagar Road", {"focus_renal", "no_ed", "aging"}),
    ("Wakad Greenfield Hospital", "Private", "Wakad", "Datta Mandir Road", {"no_vent", "fresh_limited"}),
    ("Shivajinagar Sassoon-Road Chest Hospital", "Specialty", "Shivajinagar", "JM Road", {"focus_pulmo", "fresh"}),
    ("Bhosari Industrial Area Hospital", "Government", "Bhosari", "Nashik Highway", {"stale"}),
    ("Camp Cantonment Multispeciality Hospital", "Multispecialty", "Camp", "MG Road", {"stale_excellent"}),
    ("Warje Riverside Hospital", "Private", "Warje", "Warje Malwadi Road", {"aging", "inactive"}),
    ("Sinhagad Road Medical Centre", "Private", "Sinhagad Road", "Dhayari Phata Road", {"stale"}),
    ("Wagholi Highway Hospital", "Private", "Wagholi", "Pune-Ahmednagar Highway", {"fresh", "almost_full"}),
    ("Chakan MIDC Trauma Hospital", "Trauma Center", "Chakan", "Talegaon-Chakan Road", {"aging"}),
    ("Mulshi Valley Rural Hospital", "Government", "Pirangut", "Paud Road", {"fresh_limited", "stale_late"}),
]

hospitals, services, resources = [], [], []
H = {}  # hospital_id -> dict of all info

for i, (name, htype, area, road, flags) in enumerate(H_SPEC, start=1):
    hid = f"HSP-{i:03d}"
    alat, alon, pin = AREAS[area]
    lat = round(alat + rng.normal(0, 0.004), 6); lon = round(alon + rng.normal(0, 0.004), 6)
    address = f"Plot {rng.integers(3, 220)}, {road}, {area}, Pune, Maharashtra {pin}"
    ed = "no_ed" not in flags
    active = "inactive" not in flags
    hospitals.append(dict(hospital_id=hid, hospital_name=name, hospital_type=htype, latitude=lat,
                          longitude=lon, address=address, emergency_department=ed, active_status=active))

    # ---- services
    P = {
        "Trauma Center":  dict(trauma_care=.98, cardiology=.45, neurology=.55, blood_bank=.97, operation_theatre=1, dialysis=.4, burn_unit=.55),
        "Multispecialty": dict(trauma_care=.8, cardiology=.95, neurology=.9, blood_bank=.95, operation_theatre=1, dialysis=.9, burn_unit=.45),
        "Government":     dict(trauma_care=.8, cardiology=.6, neurology=.45, blood_bank=.9, operation_theatre=.95, dialysis=.7, burn_unit=.6),
        "Private":        dict(trauma_care=.3, cardiology=.5, neurology=.3, blood_bank=.5, operation_theatre=.85, dialysis=.4, burn_unit=.1),
        "Specialty":      dict(trauma_care=.05, cardiology=.2, neurology=.15, blood_bank=.4, operation_theatre=.6, dialysis=.2, burn_unit=.05),
    }[htype]
    s = {k: bool(rng.random() < p) for k, p in P.items()}
    if "focus_cardiac" in flags: s.update(cardiology=True, operation_theatre=True, blood_bank=True, neurology=False, trauma_care=False)
    if "focus_neuro" in flags:   s.update(neurology=True, operation_theatre=True, cardiology=False, trauma_care=False)
    if "focus_renal" in flags:   s.update(dialysis=True, cardiology=False, neurology=False, trauma_care=False, operation_theatre=False)
    if "focus_pulmo" in flags:   s.update(trauma_care=False, neurology=False, dialysis=False)
    if "focus_burn" in flags:    s.update(burn_unit=True, trauma_care=True, blood_bank=True, operation_theatre=True)
    if hid == "HSP-025": s.update(trauma_care=False, cardiology=False, neurology=False, dialysis=False, burn_unit=False, blood_bank=False)
    if hid == "HSP-006": s.update(neurology=False, trauma_care=False)
    if hid == "HSP-017": s.update(cardiology=False, neurology=False, trauma_care=False)
    specs = []
    if s["cardiology"]: specs.append("Cardiologist")
    if s["neurology"]: specs.append("Neurologist")
    if s["trauma_care"]: specs.append("Trauma Surgeon")
    if s["operation_theatre"] and rng.random() < .9: specs.append("General Surgeon")
    if "focus_pulmo" in flags or (htype in ("Multispecialty", "Government") and rng.random() < .75) or (htype == "Private" and rng.random() < .35):
        specs.append("Pulmonologist")
    if s["dialysis"] and rng.random() < .85: specs.append("Nephrologist")
    services.append(dict(service_record_id=f"SRV-{i:03d}", hospital_id=hid, **s,
                         specialists=";".join(specs) if specs else "None"))

    # ---- resources (totals)
    R = {
        "Trauma Center":  ((20, 40), (12, 25), (30, 60), (80, 160)),
        "Multispecialty": ((30, 60), (18, 35), (50, 100), (200, 400)),
        "Government":     ((15, 45), (8, 28), (40, 120), (250, 600)),
        "Private":        ((6, 20), (3, 10), (15, 40), (50, 150)),
        "Specialty":      ((8, 25), (3, 12), (10, 30), (40, 100)),
    }[htype]
    tot = [int(rng.integers(lo, hi + 1)) for lo, hi in R]
    if "fresh_limited" in flags: tot = [int(rng.integers(3, 6)), int(rng.integers(1, 3)), int(rng.integers(6, 12)), int(rng.integers(30, 60))]
    if "no_vent" in flags: tot[1] = 0
    if "stale_excellent" in flags: tot = [int(rng.integers(55, 70)), int(rng.integers(35, 45)), int(rng.integers(90, 120)), int(rng.integers(350, 450))]
    occ = rng.uniform(.55, .85, 4)
    if "almost_full" in flags: occ = rng.uniform(.93, 1.0, 4)
    if "stale_excellent" in flags: occ = rng.uniform(.35, .55, 4)
    av = [max(0, min(t, int(round(t * (1 - o))))) for t, o in zip(tot, occ)]
    if "icu_full" in flags: av[0] = 0
    if "fresh_limited" in flags: av[0] = min(av[0], 1); av[1] = min(av[1], 1)
    # freshness (minutes old at NOW)
    if "fresh" in flags or "fresh_limited" in flags: age = rng.uniform(0.3, 4.5)
    elif "aging" in flags: age = rng.uniform(6, 28)
    else: age = rng.uniform(45, 600)
    if "stale_excellent" in flags: age = rng.uniform(150, 420)
    if "stale_late" in flags: age = rng.uniform(2, 4)
    last_upd = NOW - timedelta(minutes=float(age))
    last_upd = last_upd.replace(microsecond=0)
    src = rng.choice(["Hospital Staff", "Admin", "Simulation"], p=[.62, .23, .15])
    resources.append(dict(resource_record_id=f"RR-{i:03d}", hospital_id=hid,
                          total_icu_beds=tot[0], available_icu_beds=av[0],
                          total_ventilators=tot[1], available_ventilators=av[1],
                          total_oxygen_beds=tot[2], available_oxygen_beds=av[2],
                          total_general_beds=tot[3], available_general_beds=av[3],
                          last_updated_timestamp=last_upd, update_source=src))
    H[hid] = dict(lat=lat, lon=lon, type=htype, flags=flags, svc=s, specs=set(specs), ed=ed, active=active,
                  tot=dict(ICU=tot[0], Ventilator=tot[1], **{"Oxygen Bed": tot[2], "General Bed": tot[3]}),
                  av=dict(ICU=av[0], Ventilator=av[1], **{"Oxygen Bed": av[2], "General Bed": av[3]}),
                  age=age, last_upd=last_upd, name=name)
HIDS = list(H)

# ---------------------------------------------------------------- EMERGENCY REQUESTS
TYPES = ["Road Accident", "Cardiac", "Respiratory", "Stroke", "Other", "Burn"]
TYPE_P = [.29, .22, .19, .12, .12, .06]
SEV = ["Critical", "High", "Moderate", "Low"]
SEV_P = {"Road Accident": [.18, .32, .32, .18], "Cardiac": [.22, .36, .28, .14], "Respiratory": [.12, .28, .38, .22],
         "Stroke": [.28, .40, .22, .10], "Other": [.06, .18, .40, .36], "Burn": [.20, .30, .30, .20]}
SEV_MULT = {"Critical": 1.0, "High": .7, "Moderate": .33, "Low": .1}
BASE = {  # probability of requiring each resource at Critical severity
    "Road Accident": dict(icu=.85, ventilator=.35, oxygen=.55, trauma=.95, cardio=.05, neuro=.25, blood=.8, ot=.8, dialysis=.02),
    "Cardiac":       dict(icu=.9, ventilator=.3, oxygen=.6, trauma=.02, cardio=.97, neuro=.05, blood=.2, ot=.35, dialysis=.06),
    "Stroke":        dict(icu=.88, ventilator=.3, oxygen=.5, trauma=.02, cardio=.1, neuro=.97, blood=.1, ot=.25, dialysis=.03),
    "Respiratory":   dict(icu=.75, ventilator=.8, oxygen=.98, trauma=.01, cardio=.1, neuro=.02, blood=.03, ot=.03, dialysis=.05),
    "Burn":          dict(icu=.85, ventilator=.4, oxygen=.7, trauma=.6, cardio=.02, neuro=.02, blood=.5, ot=.55, dialysis=.1),
    "Other":         dict(icu=.6, ventilator=.2, oxygen=.4, trauma=.1, cardio=.1, neuro=.1, blood=.25, ot=.35, dialysis=.3),
}
FLOOR = dict(icu=.02, ventilator=0, oxygen=.75, trauma=.7, cardio=.85, neuro=.85, blood=.05, ot=.05, dialysis=.02)  # low-severity floor for "defining" resource
DEFINING = {"Road Accident": "trauma", "Cardiac": "cardio", "Stroke": "neuro", "Respiratory": "oxygen", "Burn": "trauma", "Other": None}

def age_for(t):
    if t == "Road Accident": a = rng.gamma(5, 6.5) + 3
    elif t == "Cardiac": a = rng.normal(62, 13)
    elif t == "Stroke": a = rng.normal(67, 12)
    elif t == "Respiratory": a = rng.normal(6, 4) if rng.random() < .3 else rng.normal(63, 16)
    elif t == "Burn": a = rng.gamma(3, 11)
    else: a = rng.gamma(4, 11)
    return int(min(104, max(0, round(a))))

HOT = [(a, w) for a, w in [("Hinjewadi", 7), ("Wakad", 6), ("Baner", 5), ("Aundh", 4), ("Shivajinagar", 6), ("Deccan", 4), ("Kothrud", 7),
       ("Swargate", 6), ("Hadapsar", 7), ("Kharadi", 5), ("Viman Nagar", 4), ("Yerawada", 5), ("Pimpri", 7), ("Chinchwad", 6),
       ("Nigdi", 4), ("Bhosari", 5), ("Katraj", 5), ("Kondhwa", 5), ("Wagholi", 4), ("Warje", 4), ("Sinhagad Road", 4),
       ("Camp", 3), ("Magarpatta", 3), ("Pirangut", 3), ("Chakan", 3), ("Talegaon", 3), ("Undri", 3), ("Lavale", 2)]]
HOT_N = [a for a, _ in HOT]; HOT_W = np.array([w for _, w in HOT], float); HOT_W /= HOT_W.sum()

def patient_loc(etype):
    a = HOT_N[rng.choice(len(HOT_N), p=HOT_W)]
    if etype == "Road Accident" and rng.random() < .25:
        a = rng.choice(["Talegaon", "Chakan", "Katraj", "Wagholi", "Pirangut", "Nigdi"])  # highway stretches
    lat, lon, _ = AREAS[a]
    return round(lat + rng.normal(0, .012), 6), round(lon + rng.normal(0, .012), 6)

HOUR_W = np.array([2, 1.5, 1.2, 1, 1, 1.3, 2.2, 3.5, 4.5, 4.8, 4.5, 4.3, 4.2, 4, 4, 4.2, 4.6, 5, 5.3, 5, 4.4, 3.8, 3.2, 2.6]); HOUR_W /= HOUR_W.sum()

def rand_ts(start, end):
    while True:
        day = start.date() + timedelta(days=int(rng.integers(0, (end.date() - start.date()).days + 1)))
        h = int(rng.choice(24, p=HOUR_W))
        t = datetime(day.year, day.month, day.day, h) + timedelta(seconds=int(rng.integers(0, 3600)))
        if start <= t < end: return t

N_REQ, N_LIVE, N_TWIN_PAIRS = 5000, 520, 70
req_rows = []
def make_req(etype=None, sev=None, t=None, loc=None, force=None):
    etype = etype or TYPES[rng.choice(6, p=TYPE_P)]
    sev = sev or SEV[rng.choice(4, p=SEV_P[etype])]
    m = SEV_MULT[sev]
    b = BASE[etype]
    need = {k: bool(rng.random() < min(.99, max(FLOOR[k] if DEFINING[etype] == k else 0, p * m + rng.normal(0, .03)))) for k, p in b.items()}
    if need["ventilator"]: need["icu"] = need["icu"] or rng.random() < .85
    if force: need.update(force)
    spec = None
    if rng.random() < {"Critical": .8, "High": .6, "Moderate": .35, "Low": .15}[sev]:
        spec = {"Road Accident": "Trauma Surgeon" if rng.random() < .75 else "General Surgeon", "Cardiac": "Cardiologist",
                "Stroke": "Neurologist", "Respiratory": "Pulmonologist", "Burn": "General Surgeon",
                "Other": rng.choice(["General Surgeon", "Nephrologist", "Pulmonologist", "Cardiologist"])}[etype]
        if spec == "Nephrologist": need["dialysis"] = True
    beds = 1
    if etype == "Road Accident" and sev in ("Critical", "High") and rng.random() < .05: beds = int(rng.choice([2, 2, 3, 4]))
    if etype == "Burn" and rng.random() < .06: beds = 2
    lat, lon = loc or patient_loc(etype)
    return dict(emergency_type=etype, severity=sev, patient_age=age_for(etype), patient_latitude=lat, patient_longitude=lon,
                required_icu=need["icu"], required_ventilator=need["ventilator"], required_oxygen=need["oxygen"],
                required_trauma_care=need["trauma"], required_cardiology=need["cardio"], required_neurology=need["neuro"],
                required_blood_bank=need["blood"], required_operation_theatre=need["ot"], required_dialysis=need["dialysis"],
                required_specialist=spec, beds_required=beds, request_timestamp=t)

for _ in range(N_REQ - N_LIVE - 2 * N_TWIN_PAIRS - 110):
    req_rows.append(make_req(t=rand_ts(HIST_START, LIVE_START)))
for _ in range(N_LIVE):
    req_rows.append(make_req(t=LIVE_START + timedelta(seconds=int(rng.integers(0, int((NOW - LIVE_START).total_seconds()) - 120)))))
# complex multi-system cases on the city fringe (tests 'no suitable hospital initially')
for _ in range(110):
    et = rng.choice(["Road Accident", "Road Accident", "Burn", "Other"])
    a_ = rng.choice(["Talegaon", "Chakan", "Pirangut", "Lavale", "Wagholi", "Undri"])
    la, lo, _ = AREAS[a_]
    t_ = rand_ts(HIST_START, LIVE_START) if rng.random() < .85 else LIVE_START + timedelta(seconds=int(rng.integers(0, 20000)))
    q = make_req(et, "Critical", t_, (round(la + rng.normal(0, .01), 6), round(lo + rng.normal(0, .01), 6)),
                 force=dict(icu=True, ventilator=True, trauma=True, neuro=True, blood=True, ot=True))
    q["required_specialist"] = "Neurologist"; q["_hard"] = True
    req_rows.append(q)
# simultaneous "twin" requests: same neighbourhood, seconds apart, both needing ICU -> contention
twin_pairs = []
for k in range(N_TWIN_PAIRS):
    t0 = rand_ts(HIST_START, NOW - timedelta(hours=3))
    et = rng.choice(["Road Accident", "Cardiac", "Stroke"])
    loc = patient_loc(et)
    a = make_req(et, "Critical", t0, loc, force=dict(icu=True))
    b = make_req(et, rng.choice(["Critical", "High"]), t0 + timedelta(seconds=int(rng.integers(4, 45))),
                 (round(loc[0] + rng.normal(0, .004), 6), round(loc[1] + rng.normal(0, .004), 6)), force=dict(icu=True))
    a["_twin"] = k; b["_twin"] = k
    req_rows += [a, b]

req = pd.DataFrame(req_rows).sort_values("request_timestamp").reset_index(drop=True)
req.insert(0, "request_id", [f"REQ-{i:06d}" for i in range(1, len(req) + 1)])
pids = rng.choice(np.arange(100000, 999999), size=len(req), replace=False)
req.insert(1, "patient_id", [f"PT-{p}" for p in pids])
req["ambulance_id"] = None
req["request_status"] = None
twin_map = {}
for idx, tw in req["_twin"].dropna().items(): twin_map.setdefault(int(tw), []).append(idx)
twin_idx = set(i for v in twin_map.values() for i in v)
hard_idx = set(req.index[req["_hard"].fillna(False).astype(bool)])

# ---------------------------------------------------------------- MATCHING ENGINE
REQ_LABEL = [("required_icu", "ICU"), ("required_ventilator", "Ventilator"), ("required_oxygen", "Oxygen Bed"),
             ("required_trauma_care", "Trauma Care"), ("required_cardiology", "Cardiology"), ("required_neurology", "Neurology"),
             ("required_blood_bank", "Blood Bank"), ("required_operation_theatre", "Operation Theatre"), ("required_dialysis", "Dialysis")]
SVC_KEY = {"Trauma Care": "trauma_care", "Cardiology": "cardiology", "Neurology": "neurology", "Blood Bank": "blood_bank",
           "Operation Theatre": "operation_theatre", "Dialysis": "dialysis"}

def primary_bed(r):
    return "ICU" if r["required_icu"] else ("Oxygen Bed" if r["required_oxygen"] else "General Bed")

def evaluate(r, hid):
    h = H[hid]; beds = int(r["beds_required"])
    needs = [lab for col, lab in REQ_LABEL if r[col]]
    if not r["required_icu"] and not r["required_oxygen"]: needs.append("General Bed")
    if isinstance(r["required_specialist"], str): needs.append(r["required_specialist"])
    met, missing = [], []
    for n in needs:
        if n == "ICU": ok = h["av"]["ICU"] >= beds; why = f"ICU needs {beds}, {h['av']['ICU']} available"
        elif n == "Ventilator": ok = h["av"]["Ventilator"] >= 1; why = "no ventilators at facility" if h["tot"]["Ventilator"] == 0 else "0 ventilators available"
        elif n == "Oxygen Bed": ok = h["av"]["Oxygen Bed"] >= beds; why = f"oxygen beds {h['av']['Oxygen Bed']} available"
        elif n == "General Bed": ok = h["av"]["General Bed"] >= beds; why = "no general beds"
        elif n in SVC_KEY: ok = h["svc"][SVC_KEY[n]]; why = f"no {n.lower()} service"
        else: ok = n in h["specs"]; why = f"{n} not on staff"
        (met if ok else missing).append(n if ok else why)
    cov = len(met) / len(needs)
    pb = primary_bed(r)
    head = min(1.0, h["av"][pb] / (5.0 * beds))
    rm = round(0.7 * cov + 0.3 * head, 3)
    blockers = []
    if not h["active"]: blockers.append("hospital inactive")
    if not h["ed"]: blockers.append("no emergency department")
    elig = (not missing) and not blockers
    return rm, elig, needs, missing, blockers

def fresh_score(age): return round(math.exp(-age / 45.0), 3)

def fresh_label(age):
    return "fresh" if age <= 5 else ("aging" if age <= 30 else "STALE")

def rank_request(r):
    t = r["request_timestamp"]
    dists = sorted(((road_km(r["patient_latitude"], r["patient_longitude"], H[h]["lat"], H[h]["lon"]), h) for h in HIDS))
    cands = [h for _, h in dists[:5]]
    evals = {h: evaluate(r, h) for h in HIDS}
    # add the nearest eligible hospital beyond top-5 (farther-but-capable case) when top-5 has <=1 eligible
    if sum(evals[h][1] for h in cands) <= 1 or rng.random() < .1:
        for km_, h in dists[5:]:
            if evals[h][1] and travel_min(km_, t) <= 55: cands.append(h); break  # service-radius cut-off
    rows = []
    for h in cands:
        km = road_km(r["patient_latitude"], r["patient_longitude"], H[h]["lat"], H[h]["lon"])
        tm = travel_min(km, t)
        rm, elig, needs, missing, blockers = evals[h]
        fs = fresh_score(H[h]["age"]); ts_ = max(0.0, 1 - tm / 60.0)
        raw = 0.5 * rm + 0.3 * ts_ + 0.2 * fs
        final = round(raw if elig else raw * 0.3, 3)
        rows.append(dict(hospital_id=h, resource_match_score=rm, distance_km=round(km, 2), estimated_travel_time_min=round(tm, 1),
                         freshness_score=fs, final_suitability_score=final, eligibility=elig, _needs=needs, _missing=missing,
                         _blockers=blockers, _ts=round(ts_, 3)))
    rows.sort(key=lambda x: (not x["eligibility"], -x["final_suitability_score"]))
    nearest = min(rows, key=lambda x: x["distance_km"])["hospital_id"]
    for k, x in enumerate(rows, 1):
        x["rank"] = k
        age = H[x["hospital_id"]]["age"]
        fl = fresh_label(age)
        base = (f"{x['distance_km']} km (~{x['estimated_travel_time_min']:.0f} min); data {age:.0f} min old ({fl}). "
                f"Score {x['final_suitability_score']:.3f} = 0.5x{x['resource_match_score']:.2f} resource + 0.3x{x['_ts']:.2f} travel + 0.2x{x['freshness_score']:.2f} freshness")
        if x["eligibility"]:
            e = f"ELIGIBLE: meets all requirements ({', '.join(x['_needs'])}). " + base + "."
            if fl == "STALE": e += " Availability data is stale - confirm with hospital before dispatch."
            if x["hospital_id"] != nearest and x["rank"] == 1: e += " Ranked first although not the nearest candidate."
        else:
            reasons = x["_blockers"] + x["_missing"]
            e = f"INELIGIBLE: {'; '.join(reasons)}. " + base + " x 0.3 ineligibility penalty."
            if x["hospital_id"] == nearest: e += " Nearest hospital but cannot satisfy mandatory requirements."
        x["explanation"] = e
    return rows

# choose which requests go through the matching engine
hist_mask = req["request_timestamp"] < LIVE_START
ranked_idx = set(twin_idx) | hard_idx
hist_pool = [i for i in req.index[hist_mask] if i not in twin_idx and i not in hard_idx]
live_pool = [i for i in req.index[~hist_mask] if i not in twin_idx and i not in hard_idx]
ranked_idx |= set(rng.choice(hist_pool, size=1330, replace=False).tolist())
ranked_idx |= set(rng.choice(live_pool, size=340, replace=False).tolist())
ranked_idx = sorted(ranked_idx, key=lambda i: req.at[i, "request_timestamp"])

match_rows, RANK = [], {}
for i in ranked_idx:
    rows = rank_request(req.loc[i])
    RANK[i] = rows
    for x in rows:
        match_rows.append(dict(request_id=req.at[i, "request_id"], **{k: v for k, v in x.items() if not k.startswith("_")}))

# ---------------------------------------------------------------- AMBULANCES (fleet)
BASES = rng.choice(HOT_N, size=100, p=HOT_W)
AMB = {}
for k in range(1, 101):
    a = f"AMB-{k:03d}"
    lat, lon, _ = AREAS[BASES[k - 1]]
    AMB[a] = dict(type=rng.choice(["Advanced Life Support", "Basic Life Support", "Other"], p=[.38, .52, .10]),
                  blat=round(lat + rng.normal(0, .006), 6), blon=round(lon + rng.normal(0, .006), 6), free_at=HIST_START, offline=False)
for a in rng.choice(list(AMB), size=9, replace=False): AMB[a]["offline"] = True

def pick_amb(r, t):
    als = r["severity"] in ("Critical", "High")
    best = None
    for a, d in AMB.items():
        if d["free_at"] > t: continue
        if d["offline"] and t >= LIVE_START - timedelta(hours=3): continue
        km = road_km(d["blat"], d["blon"], r["patient_latitude"], r["patient_longitude"])
        pen = 0 if (not als or d["type"] == "Advanced Life Support") else 4
        s = km + pen
        if best is None or s < best[0]: best = (s, a, km)
    return best

# ---------------------------------------------------------------- WORKFLOW + RESERVATIONS
wf_rows, res_rows = [], []
last_icu_win = {}  # hospital -> (request_id, reserve_time) of most recent ICU confirmation (for contention)
contention_log, expired_log = [], []
wf_candidates = set()
for i in ranked_idx:
    live = req.at[i, "request_timestamp"] >= LIVE_START
    if i in twin_idx or rng.random() < (.62 if live else .80): wf_candidates.add(i)

twin_first = {min(v, key=lambda j: req.at[j, "request_timestamp"]): max(v, key=lambda j: req.at[j, "request_timestamp"]) for v in twin_map.values()}
twin_second = {v: k for k, v in twin_first.items()}

def add_res(r, hid, rtype, qty, status, req_at, conf_at, exp_at):
    res_rows.append(dict(request_id=r["request_id"], hospital_id=hid, resource_type=rtype, quantity=int(qty),
                         reservation_status=status, requested_at=req_at, confirmed_at=conf_at, expires_at=exp_at))

twin_first_time = {}
REJ_R = ["No Bed", "No Equipment", "Specialist Unavailable", "Stale Data", "Other"]

for i in ranked_idx:
    r = req.loc[i]
    rows = RANK[i]
    elig = [x for x in rows if x["eligibility"]]
    t_req = r["request_timestamp"]
    if not elig:
        req.at[i, "request_status"] = "NO_MATCH"; continue
    if i not in wf_candidates:
        req.at[i, "request_status"] = "MATCHING"
        top = elig[0]
        if rng.random() < .30 and t_req < NOW - timedelta(minutes=30):  # hold placed, hospital never confirmed
            ra = t_req + timedelta(seconds=int(rng.integers(40, 180)))
            add_res(r, top["hospital_id"], primary_bed(r), r["beds_required"], "EXPIRED", ra, None, ra + timedelta(minutes=10))
            expired_log.append((r["request_id"], top["hospital_id"]))
        continue
    t = t_req + timedelta(seconds=int(rng.integers(45, 240)))  # ranking + dispatcher decision time
    pick = pick_amb(r, t)
    if pick is None:
        req.at[i, "request_status"] = "MATCHING"; continue
    _, amb, amb_km = pick
    req.at[i, "ambulance_id"] = amb
    first_t = t
    accepted = None; pending = False
    for att, x in enumerate(elig):
        hid = x["hospital_id"]; h = H[hid]
        pb = primary_bed(r)
        ra = t - timedelta(seconds=int(rng.integers(20, 90)))
        # forced contention for twin pairs: second request loses the last unit at the first's hospital
        forced_fail = i in twin_second and att == 0 and twin_first_time.get(twin_second[i], (None,))[0] == hid
        if forced_fail:
            win_ra = twin_first_time[twin_second[i]][1]
            ra = win_ra + timedelta(seconds=int(rng.integers(2, 30)))
            t = max(t, ra + timedelta(seconds=20))
        natural_fail = (not forced_fail and pb == "ICU" and hid in last_icu_win and h["av"]["ICU"] <= 3
                        and 0 <= (ra - last_icu_win[hid][1]).total_seconds() <= 600 and rng.random() < .5)
        age_h = h["age"]
        p_rej = .10 + (.25 if age_h > 30 else 0) + (.10 if h["av"][pb] <= 1 else 0)
        if (t >= NOW - timedelta(minutes=4) or (t >= NOW - timedelta(minutes=25) and rng.random() < .45)) and not forced_fail:
            wf_rows.append(dict(request_id=r["request_id"], hospital_id=hid, ambulance_id=amb, hospital_response="PENDING",
                                rejection_reason=None, assignment_time=t, departure_time=None, arrival_time=None,
                                handover_time=None, handover_status="PENDING"))
            add_res(r, hid, pb, r["beds_required"], "PENDING", ra, None, ra + timedelta(minutes=10))
            pending = True; break
        if forced_fail or natural_fail or (att < len(elig) - 1 and rng.random() < p_rej) or (att == len(elig) - 1 and rng.random() < .15):
            if forced_fail or natural_fail:
                reason = "No Bed"  # lost the last ICU bed to a competing request
                add_res(r, hid, pb, r["beds_required"], "FAILED", ra, None, ra + timedelta(minutes=10))
                contention_log.append((r["request_id"], hid, twin_first_time.get(twin_second.get(i), (None, None, None))[2] if forced_fail else last_icu_win[hid][0]))
            else:
                reason = rng.choice(REJ_R, p=[.28, .18, .24, .12, .18]) if age_h <= 30 else rng.choice(REJ_R, p=[.25, .1, .1, .45, .1])
                if reason == "No Equipment" and not r["required_ventilator"]: reason = "No Bed"
                if reason in ("No Bed", "No Equipment"):
                    add_res(r, hid, "Ventilator" if reason == "No Equipment" and r["required_ventilator"] else pb,
                            r["beds_required"] if reason == "No Bed" else 1, "FAILED", ra, None, ra + timedelta(minutes=10))
                else:
                    ca = ra + timedelta(seconds=int(rng.integers(5, 40)))
                    add_res(r, hid, pb, r["beds_required"], "RELEASED" if rng.random() < .6 else "CANCELLED", ra, ca, ra + timedelta(minutes=10))
            wf_rows.append(dict(request_id=r["request_id"], hospital_id=hid, ambulance_id=amb, hospital_response="REJECTED",
                                rejection_reason=reason, assignment_time=t, departure_time=None, arrival_time=None,
                                handover_time=None, handover_status=None))
            t = t + timedelta(seconds=int(rng.integers(90, 420)))
            continue
        # accepted
        ca = ra + timedelta(seconds=int(rng.integers(8, 75)))
        add_res(r, hid, pb, r["beds_required"], "CONFIRMED", ra, ca, ra + timedelta(minutes=15))
        if r["required_ventilator"]:
            add_res(r, hid, "Ventilator", 1, "CONFIRMED", ra + timedelta(seconds=2), ca + timedelta(seconds=int(rng.integers(0, 10))), ra + timedelta(minutes=15))
        if pb == "ICU": last_icu_win[hid] = (r["request_id"], ra)
        if i in twin_first: twin_first_time[i] = (hid, ra, r["request_id"])
        to_scene = travel_min(amb_km, first_t)
        dep = max(first_t + timedelta(minutes=to_scene + float(rng.uniform(6, 15))), t + timedelta(minutes=float(rng.uniform(1, 3))))
        arr = dep + timedelta(minutes=x["estimated_travel_time_min"] * float(rng.uniform(.85, 1.3)))
        hov = arr + timedelta(minutes=float(rng.uniform(4, 22)))
        dep, arr, hov = [d.replace(microsecond=0) for d in (dep, arr, hov)]
        accepted = (hid, dep, arr, hov)
        if hov <= NOW: status = "COMPLETED"; d_, a_, h_ = dep, arr, hov
        else:
            status = "IN_PROGRESS"
            d_ = dep if dep <= NOW else None; a_ = arr if arr <= NOW else None; h_ = None
        wf_rows.append(dict(request_id=r["request_id"], hospital_id=hid, ambulance_id=amb, hospital_response="ACCEPTED",
                            rejection_reason=None, assignment_time=t, departure_time=d_, arrival_time=a_,
                            handover_time=h_, handover_status=status))
        break
    if pending:
        req.at[i, "request_status"] = "MATCHING"
        AMB[amb]["free_at"] = NOW + timedelta(hours=2); AMB[amb]["cur"] = (i, None)
    elif accepted:
        hid, dep, arr, hov = accepted
        if hov <= NOW: req.at[i, "request_status"] = "COMPLETED"
        else:
            req.at[i, "request_status"] = "IN_TRANSIT" if dep <= NOW else "ASSIGNED"
            AMB[amb]["cur"] = (i, hid)
        AMB[amb]["free_at"] = hov + timedelta(minutes=float(rng.uniform(10, 25)))
    else:
        req.at[i, "request_status"] = "NO_MATCH"
        AMB[amb]["free_at"] = t + timedelta(minutes=5)

# unranked requests: still in intake queue
for i in req.index:
    if req.at[i, "request_status"] is None:
        req.at[i, "request_status"] = "CREATED" if rng.random() < .58 else "MATCHING"

# ---------------------------------------------------------------- AMBULANCE SNAPSHOT
amb_rows = []
for a, d in AMB.items():
    cur = d.get("cur")
    if cur is not None and d["free_at"] > NOW:
        i, hid = cur; r = req.loc[i]
        if hid and r["request_status"] == "IN_TRANSIT":
            f = float(rng.uniform(.2, .9))
            lat = r["patient_latitude"] + f * (H[hid]["lat"] - r["patient_latitude"]); lon = r["patient_longitude"] + f * (H[hid]["lon"] - r["patient_longitude"])
        else:
            f = float(rng.uniform(.5, 1.0))
            lat = d["blat"] + f * (r["patient_latitude"] - d["blat"]); lon = d["blon"] + f * (r["patient_longitude"] - d["blon"])
        amb_rows.append(dict(ambulance_id=a, ambulance_type=d["type"], current_latitude=round(lat, 6), current_longitude=round(lon, 6),
                             availability_status="BUSY", current_request_id=r["request_id"],
                             last_location_update=NOW - timedelta(seconds=int(rng.integers(3, 60)))))
    elif d["offline"]:
        amb_rows.append(dict(ambulance_id=a, ambulance_type=d["type"], current_latitude=d["blat"], current_longitude=d["blon"],
                             availability_status="OFFLINE", current_request_id=None,
                             last_location_update=NOW - timedelta(minutes=int(rng.integers(180, 1800)))))
    else:
        amb_rows.append(dict(ambulance_id=a, ambulance_type=d["type"], current_latitude=round(d["blat"] + rng.normal(0, .003), 6),
                             current_longitude=round(d["blon"] + rng.normal(0, .003), 6), availability_status="AVAILABLE",
                             current_request_id=None, last_location_update=NOW - timedelta(seconds=int(rng.integers(5, 240)))))
amb_df = pd.DataFrame(amb_rows)

# ---------------------------------------------------------------- RESOURCE UPDATE HISTORY
hist_rows = []
RTYPES = ["ICU", "Ventilator", "Oxygen Bed", "General Bed"]
chains = [(h, rt) for h in HIDS for rt in RTYPES if H[h]["tot"][rt] > 0]
per_chain = 10000 // len(chains)
extra = 10000 - per_chain * len(chains)
for ci, (hid, rt) in enumerate(chains):
    n = per_chain + (1 if ci < extra else 0)
    tot = H[hid]["tot"][rt]; cur = H[hid]["av"][rt]
    end = H[hid]["last_upd"] if rt == "ICU" else H[hid]["last_upd"] - timedelta(seconds=int(rng.integers(30, 5400)))
    times = sorted(HIST_START + timedelta(seconds=int(s)) for s in rng.integers(0, int((end - HIST_START).total_seconds()), n - 1))
    times.append(end)
    step_max = {"ICU": 2, "Ventilator": 1, "Oxygen Bed": 3, "General Bed": 6}[rt]
    vals = [cur]
    for _ in range(n):  # walk backward
        v = vals[-1]
        delta = int(rng.integers(1, step_max + 1)) * (1 if rng.random() < .5 else -1)
        if v + delta < 0 or v + delta > tot: delta = -delta
        vals.append(max(0, min(tot, v + delta)))
    vals = vals[::-1]  # oldest first; vals[k] -> vals[k+1] is update k
    for k in range(n):
        hist_rows.append(dict(hospital_id=hid, resource_type=rt, old_available_count=vals[k], new_available_count=vals[k + 1],
                              updated_at=times[k], update_source=rng.choice(["Hospital Staff", "Admin", "Simulation"], p=[.6, .22, .18])))
hist = pd.DataFrame(hist_rows).sort_values(["updated_at", "hospital_id"]).reset_index(drop=True)
hist.insert(0, "update_id", [f"UPD-{i:06d}" for i in range(1, len(hist) + 1)])
# last update of each chain inherits the resource snapshot's source
for rr in resources:
    m = (hist.hospital_id == rr["hospital_id"]) & (hist.updated_at == rr["last_updated_timestamp"])
    hist.loc[m, "update_source"] = rr["update_source"]

# ---------------------------------------------------------------- FINALISE & WRITE
req_out = req.drop(columns=["_twin", "_hard"])
for c in ["request_timestamp"]: req_out[c] = req_out[c].map(ts)
req_out = req_out[["request_id", "patient_id", "emergency_type", "severity", "patient_age", "patient_latitude", "patient_longitude",
                   "required_icu", "required_ventilator", "required_oxygen", "required_trauma_care", "required_cardiology",
                   "required_neurology", "required_blood_bank", "required_operation_theatre", "required_dialysis",
                   "required_specialist", "beds_required", "ambulance_id", "request_timestamp", "request_status"]]

hosp_df = pd.DataFrame(hospitals)
res_df = pd.DataFrame(resources); res_df["last_updated_timestamp"] = res_df["last_updated_timestamp"].map(ts)
svc_df = pd.DataFrame(services)
amb_df["last_location_update"] = amb_df["last_location_update"].map(ts)
hist["updated_at"] = hist["updated_at"].map(ts)

rs = pd.DataFrame(res_rows).sort_values("requested_at").reset_index(drop=True)
rs.insert(0, "reservation_id", [f"RSV-{i:06d}" for i in range(1, len(rs) + 1)])
for c in ["requested_at", "confirmed_at", "expires_at"]: rs[c] = rs[c].map(ts)

wf = pd.DataFrame(wf_rows).sort_values("assignment_time").reset_index(drop=True)
wf.insert(0, "workflow_id", [f"WF-{i:06d}" for i in range(1, len(wf) + 1)])
for c in ["assignment_time", "departure_time", "arrival_time", "handover_time"]:
    wf[c] = wf[c].map(ts)

mr = pd.DataFrame(match_rows)
mr.insert(0, "match_id", [f"MR-{i:06d}" for i in range(1, len(mr) + 1)])
mr = mr[["match_id", "request_id", "hospital_id", "resource_match_score", "distance_km", "estimated_travel_time_min",
         "freshness_score", "final_suitability_score", "rank", "eligibility", "explanation"]]

def write(df, name):
    df = df.copy()
    for c in df.columns:
        if df[c].dtype == bool or set(df[c].dropna().unique()) <= {True, False}:
            if df[c].dropna().map(type).eq(bool).all() and len(df[c].dropna()):
                df[c] = df[c].map(lambda v: None if v is None else ("TRUE" if v else "FALSE"))
    df.to_csv(os.path.join(OUT, name), index=False, na_rep="")
    return df

write(req_out, "emergency_requests.csv"); write(hosp_df, "hospitals.csv"); write(res_df, "hospital_resources.csv")
write(svc_df, "hospital_services.csv"); write(amb_df, "ambulances.csv"); write(hist, "resource_update_history.csv")
write(rs, "reservations.csv"); write(wf, "emergency_workflow_handover.csv"); write(mr, "match_ranking_results.csv")

# edge-case index for the data dictionary
import json
json.dump(dict(contention=contention_log[:15], expired=expired_log[:10]), open(os.path.join(OUT, "_edge_index.json"), "w"), default=str)
print("done")
