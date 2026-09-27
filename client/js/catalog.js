// Departments + major equipment shown on the Create Emergency screen.
//
// `req`  → requirement key(s) the backend can MATCH against live hospital data
//          (icu, ventilator, oxygen, trauma_care, cardiology, neurology,
//           blood_bank, operation_theatre, dialysis)
// no `req` → "info only": not tracked in the capacity dataset, but saved with the
//          emergency (additional_needs) so the receiving hospital still sees it.
// `specialist` → specialist this item implies (used when the emergency type has none)
// Oxygen beds have no card: Respiratory and Burn emergencies request them automatically.

const CATALOG = {
  departments: [
    { id: 'trauma',      name: 'Trauma & Emergency',     desc: 'Level-1 emergency resuscitation',      icon: 'emergency',              code: 'TIER-1 RESUS', req: ['trauma_care'],       specialist: 'Trauma Surgeon' },
    { id: 'icu',         name: 'ICU (Intensive Care)',   desc: 'Critical care beds & monitoring',      icon: 'monitor_heart',          code: 'CRIT CARE',    req: ['icu'] },
    { id: 'ot',          name: 'Operation Theatre (OT)', desc: 'Emergency surgical suites',            icon: 'medical_services',       code: 'OT STANDBY',   req: ['operation_theatre'], specialist: 'General Surgeon' },
    { id: 'cardiology',  name: 'Cardiology',             desc: 'Cardiac care & catheterization',       icon: 'cardiology',             code: 'CODE C-1',     req: ['cardiology'],        specialist: 'Cardiologist' },
    { id: 'neurology',   name: 'Neurology',              desc: 'Acute neurological care',              icon: 'neurology',              code: 'STROKE',       req: ['neurology'],         specialist: 'Neurologist' },
    { id: 'ortho',       name: 'Orthopedics',            desc: 'Trauma & bone fracture stabilization', icon: 'orthopedics',            code: 'ORTHO' },
    { id: 'neurosurg',   name: 'Neurosurgery',           desc: 'Emergency brain & spine surgery',      icon: 'psychology',             code: 'NEURO-OT',     req: ['neurology', 'operation_theatre'], specialist: 'Neurologist' },
    { id: 'burns',       name: 'Burns Unit',             desc: 'Specialized burn resuscitation',       icon: 'local_fire_department',  code: 'BURNS' },
    { id: 'pediatrics',  name: 'Pediatrics',             desc: 'Emergency neonatal & child care',      icon: 'child_care',             code: 'PEDS' },
    { id: 'obgyn',       name: 'Obstetrics & Gynecology', desc: 'Emergency maternity & delivery',      icon: 'pregnant_woman',         code: 'OB/GYN' },
  ],
  equipment: [
    { id: 'ventilator',  name: 'Mechanical Ventilator',  tag: 'Class IV',   code: 'Invasive ICU', desc: 'Advanced respiratory support',        icon: 'air',            req: ['ventilator'], specialist: 'Pulmonologist' },
    { id: 'ct',          name: 'CT Scanner',             tag: '128-Slice',  desc: 'Rapid trauma imaging (128-slice)',        icon: 'radiology' },
    { id: 'ecmo',        name: 'ECMO',                   tag: 'Tier-1',     desc: 'Extracorporeal membrane oxygenation',     icon: 'blood_pressure' },
    { id: 'defib',       name: 'Defibrillator',                             desc: 'Advanced cardiac life support',           icon: 'bolt' },
    { id: 'mri',         name: 'MRI',                                       desc: 'Emergency diagnostic neuro-imaging',      icon: 'view_in_ar' },
    { id: 'dialysis',    name: 'Dialysis Machine',                          desc: 'Acute renal replacement therapy',         icon: 'nephrology',     req: ['dialysis'],   specialist: 'Nephrologist' },
    { id: 'anesthesia',  name: 'Anesthesia Machine',                        desc: 'Rapid sequence induction & surgery',      icon: 'masks' },
    { id: 'cathlab',     name: 'Cardiac Cath Lab',                          desc: 'Percutaneous coronary intervention',      icon: 'ecg_heart',      req: ['cardiology'], specialist: 'Cardiologist' },
    { id: 'blood',       name: 'Blood Bank',                                desc: 'Type-O negative & plasma on standby',     icon: 'bloodtype',      req: ['blood_bank'] },
  ],
  presets: {
    'Level-1 Trauma': { departments: ['trauma', 'icu', 'ot'], equipment: ['ventilator', 'blood', 'ct'] },
    'Cardiac Cath':   { departments: ['cardiology', 'icu'],   equipment: ['cathlab', 'defib'] },
  },
  // What a type pre-selects when the dispatcher changes it
  typeDefaults: {
    'Road Accident': { departments: ['trauma', 'ot'], equipment: ['blood'] },
    'Cardiac':       { departments: ['cardiology'],   equipment: [] },
    'Stroke':        { departments: ['neurology'],    equipment: [] },
    'Respiratory':   { departments: ['icu'],          equipment: ['ventilator'] },
    'Burn':          { departments: ['trauma', 'burns'], equipment: [] },
    'Other':         { departments: [],               equipment: [] },
  },
  priorities: {
    Critical: { label: 'Critical (Code Red)',     level: 'Level 1 (Red)',    color: '#b51735', bg: '#ffdada' },
    High:     { label: 'High (Code Orange)',      level: 'Level 2 (Orange)', color: '#b45309', bg: '#ffedd5' },
    Moderate: { label: 'Moderate (Code Yellow)',  level: 'Level 3 (Yellow)', color: '#92400e', bg: '#fef3c7' },
    Low:      { label: 'Low (Code Green)',        level: 'Level 4 (Green)',  color: '#065f46', bg: '#d1fae5' },
  },
};

const BED_KEYS = { icu: 'icu', ventilator: 'ventilator', oxygen: 'oxygen_bed' };
const SERVICE_KEYS = ['trauma_care', 'cardiology', 'neurology', 'blood_bank', 'operation_theatre', 'dialysis'];

// Same distance/ETA model as the backend (services/geo.js)
const Geo = {
  roadKm(a, b) {
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h)) * 1.35 + 0.3;
  },
  speed() {
    const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(new Date()));
    if (h >= 22 || h < 6) return 40;
    if ((h >= 8 && h < 11) || (h >= 17 && h < 21)) return 20;
    return 28;
  },
  eta(km) { return Math.round((km / this.speed()) * 60 + 2); },
};

// Can this hospital take a patient with these requirement keys? (preview only; the real
// ranking engine on the server decides.)
function hospitalMeets(h, reqKeys, beds = 1) {
  if (!h.accepting_patients) return false;
  for (const k of reqKeys) {
    if (BED_KEYS[k] && h.resources[BED_KEYS[k]].available < (k === 'ventilator' ? 1 : beds)) return false;
    if (SERVICE_KEYS.includes(k) && !h.services[k]) return false;
  }
  if (!reqKeys.some(k => k === 'icu' || k === 'oxygen') && h.resources.general_bed.available < beds) return false;
  return true;
}
