// How trustworthy is a hospital's availability data, based on how old it is?
// Same formula as the dataset's ranking engine: score = exp(-age_minutes / 45)
export const FRESH_MAX_MIN = 5;    // ≤ 5 min  → fresh
export const AGING_MAX_MIN = 30;   // ≤ 30 min → aging, beyond → stale

export function getFreshness(lastUpdatedISO, now = Date.now()) {
  const ageMin = Math.max(0, (now - new Date(lastUpdatedISO).getTime()) / 60000);
  const status = ageMin <= FRESH_MAX_MIN ? 'fresh' : ageMin <= AGING_MAX_MIN ? 'aging' : 'stale';
  return {
    last_updated: lastUpdatedISO,
    age_minutes: Math.round(ageMin * 10) / 10,
    status,
    score: Math.round(Math.exp(-ageMin / 45) * 1000) / 1000,
    needs_reconfirmation: status === 'stale',
  };
}
