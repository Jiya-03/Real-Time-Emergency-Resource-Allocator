// Allowed values for emergency requests (match the ERRA dataset exactly)
export const EMERGENCY_TYPES = ['Road Accident', 'Cardiac', 'Stroke', 'Burn', 'Respiratory', 'Other'];
export const SEVERITIES = ['Critical', 'High', 'Moderate', 'Low'];

// Patient condition picked by the dispatcher (what the crew sees). Each maps onto a dataset severity,
// which the ranking engine and queue ordering use.
export const PATIENT_CONDITIONS = {
  'Critical':        { severity: 'Critical', code: 'Code Red',    hint: 'Life-threatening, immediate intervention' },
  'Serious':         { severity: 'High',     code: 'Code Orange', hint: 'Unstable or worsening, urgent care' },
  'Need Assistance': { severity: 'Moderate', code: 'Code Yellow', hint: 'Needs medical help soon, not deteriorating' },
  'Stable':          { severity: 'Low',      code: 'Code Green',  hint: 'Vitals stable, monitored transfer' },
  'Minor':           { severity: 'Low',      code: 'Code Blue',   hint: 'Minor injury, non-urgent' },
};
// Label shown for requests logged without a condition (e.g. the dataset)
export const CONDITION_FOR_SEVERITY = { Critical: 'Critical', High: 'Serious', Moderate: 'Need Assistance', Low: 'Stable' };
export const SPECIALISTS = ['Cardiologist', 'Neurologist', 'Trauma Surgeon', 'General Surgeon', 'Pulmonologist', 'Nephrologist'];
export const REQUEST_STATUSES = ['CREATED', 'MATCHING', 'NO_MATCH', 'ASSIGNED', 'IN_TRANSIT', 'COMPLETED'];
export const ACTIVE_STATUSES = ['CREATED', 'MATCHING', 'ASSIGNED', 'IN_TRANSIT'];

// API key → dataset column
export const REQUIREMENTS = {
  icu: 'required_icu',
  ventilator: 'required_ventilator',
  oxygen: 'required_oxygen',
  trauma_care: 'required_trauma_care',
  cardiology: 'required_cardiology',
  neurology: 'required_neurology',
  blood_bank: 'required_blood_bank',
  operation_theatre: 'required_operation_theatre',
  dialysis: 'required_dialysis',
};
export const REQUIREMENT_KEYS = Object.keys(REQUIREMENTS);

// Suggested requirements per emergency type, based on patterns in the dataset.
// The UI pre-ticks these so the dispatcher can log a call in seconds, then adjust.
export const TYPE_DEFAULTS = {
  'Road Accident': { requirements: ['trauma_care', 'blood_bank', 'operation_theatre'], specialist: 'Trauma Surgeon' },
  'Cardiac':       { requirements: ['cardiology'], specialist: 'Cardiologist' },
  'Stroke':        { requirements: ['neurology'], specialist: 'Neurologist' },
  'Respiratory':   { requirements: ['oxygen'], specialist: 'Pulmonologist' },
  'Burn':          { requirements: ['trauma_care', 'oxygen'], specialist: null },
  'Other':         { requirements: [], specialist: null },
};
// Critical/High cases usually need intensive care
export const SEVERITY_DEFAULTS = {
  Critical: ['icu'],
  High: ['icu'],
  Moderate: [],
  Low: [],
};

// Rough Pune service area (from the dataset): used to warn about typos in coordinates
export const SERVICE_AREA = { minLat: 18.3, maxLat: 18.9, minLng: 73.5, maxLng: 74.2 };
