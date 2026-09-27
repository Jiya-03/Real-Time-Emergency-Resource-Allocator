// Distance + travel-time estimates. Same formulas as the ERRA dataset's ranking engine,
// so our numbers line up with match_ranking_results.csv.
const R = 6371; // Earth radius, km

export function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Straight line × 1.35 road factor + 0.3 km
export function roadDistanceKm(lat1, lng1, lat2, lng2) {
  return Math.round((haversineKm(lat1, lng1, lat2, lng2) * 1.35 + 0.3) * 100) / 100;
}

// Pune traffic: 20 km/h at peak, 28 off-peak, 40 at night (+2 min to load/unload)
export function speedKmh(date = new Date()) {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(date));
  if (h >= 23 || h < 6) return 40;
  if ((h >= 8 && h < 11) || (h >= 17 && h < 21)) return 20;
  return 28;
}

export function etaMinutes(distanceKm, date = new Date()) {
  return Math.round((distanceKm / speedKmh(date)) * 60 + 2);
}
