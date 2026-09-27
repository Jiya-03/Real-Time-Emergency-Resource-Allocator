// One place that maps our API resource keys ↔ dataset column names ↔ dataset labels
export const RESOURCES = {
  icu:         { label: 'ICU',         total: 'total_icu_beds',     available: 'available_icu_beds' },
  ventilator:  { label: 'Ventilator',  total: 'total_ventilators',  available: 'available_ventilators' },
  oxygen_bed:  { label: 'Oxygen Bed',  total: 'total_oxygen_beds',  available: 'available_oxygen_beds' },
  general_bed: { label: 'General Bed', total: 'total_general_beds', available: 'available_general_beds' },
};

export const RESOURCE_KEYS = Object.keys(RESOURCES);

export const SERVICES = [
  'trauma_care', 'cardiology', 'neurology', 'blood_bank',
  'operation_theatre', 'dialysis', 'burn_unit',
];

export const UPDATE_SOURCES = ['Hospital Staff', 'Admin', 'Simulation'];
