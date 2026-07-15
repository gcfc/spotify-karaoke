/**
 * Sunrise / sunset for a given date and location.
 *
 * Implements the NOAA solar position equations (same math as the SunCalc library),
 * so it needs no network call and works offline.
 */

// Fallback when the browser won't tell us where we are.
export const DEFAULT_LOCATION = { lat: 37.563, lon: -122.3255, label: 'San Mateo, CA' };

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397; // Earth's axial tilt
const PERIHELION = RAD * 102.9372;
const J0 = 0.0009;

// Sun's center sits 0.833° below the horizon at sunrise/sunset: half the solar disc
// (0.267°) plus atmospheric refraction (0.566°).
const HORIZON = RAD * -0.833;

// Polar night and polar day can each run for months, so a scan for the next
// sunrise/sunset has to be allowed to walk most of a year.
const MAX_SCAN_DAYS = 400;

const toDays = (date) => date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;
const fromJulian = (j) => new Date((j + 0.5 - J1970) * DAY_MS);

const solarMeanAnomaly = (d) => RAD * (357.5291 + 0.98560028 * d);

function eclipticLongitude(M) {
  const center = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  return M + center + PERIHELION + Math.PI;
}

const declination = (L) => Math.asin(Math.sin(OBLIQUITY) * Math.sin(L));

const approxTransit = (Ht, lw, n) => J0 + (Ht + lw) / (2 * Math.PI) + n;
const solarTransitJ = (ds, M, L) => J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);

/**
 * Sunrise and sunset for the solar day containing `date`.
 *
 * Accurate to within a few minutes of published almanac times — published sources
 * disagree with each other by about that much anyway, since the exact moment depends on
 * assumptions about atmospheric refraction. That is far finer than a theme switch needs.
 *
 * Above the polar circles the sun can stay up or down all day; in that case both times
 * are null and `sunUpAllDay` says which side of the horizon it is on.
 */
export function getSunTimes(date, lat, lon) {
  const lw = RAD * -lon;
  const phi = RAD * lat;

  const n = Math.round(toDays(date) - J0 - lw / (2 * Math.PI));
  const ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L);
  const noon = solarTransitJ(ds, M, L);

  // Cosine of the hour angle between the horizon and solar noon. Outside [-1, 1] the sun
  // never reaches the horizon, so this day has no sunrise or sunset at all.
  const cosH = (Math.sin(HORIZON) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (cosH > 1) return { sunrise: null, sunset: null, sunUpAllDay: false };
  if (cosH < -1) return { sunrise: null, sunset: null, sunUpAllDay: true };

  const sunset = solarTransitJ(approxTransit(Math.acos(cosH), lw, n), M, L);
  const sunrise = noon - (sunset - noon);

  return { sunrise: fromJulian(sunrise), sunset: fromJulian(sunset), sunUpAllDay: false };
}

/** Is the sun above the horizon at `date`? */
export function isDaylight(date, lat, lon) {
  const { sunrise, sunset, sunUpAllDay } = getSunTimes(date, lat, lon);
  if (!sunrise || !sunset) return sunUpAllDay;
  return date >= sunrise && date < sunset;
}

function scanForTransition(from, lat, lon, step) {
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    const day = new Date(from.valueOf() + i * step * DAY_MS);
    const { sunrise, sunset } = getSunTimes(day, lat, lon);
    const candidates = [sunrise, sunset]
      .filter((t) => t && (step > 0 ? t > from : t < from))
      .sort((a, b) => (step > 0 ? a - b : b - a));
    if (candidates.length) return candidates[0];
  }
  return null;
}

/** The first sunrise or sunset strictly after `date`, or null if there is none nearby. */
export const nextSolarTransition = (date, lat, lon) => scanForTransition(date, lat, lon, 1);

/** The most recent sunrise or sunset strictly before `date`, or null if there is none nearby. */
export const lastSolarTransition = (date, lat, lon) => scanForTransition(date, lat, lon, -1);
