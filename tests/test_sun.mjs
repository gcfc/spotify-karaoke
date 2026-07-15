/**
 * CLI test for the sunrise/sunset math behind the automatic light/dark theme.
 * Calls the same sun.js the browser uses — no re-implementation.
 *
 * Requires Node.js 18+.
 *
 * Usage:
 *   node tests/test_sun.mjs
 */

import {
  DEFAULT_LOCATION,
  getSunTimes,
  isDaylight,
  lastSolarTransition,
  nextSolarTransition,
} from '../sun.js';

const SAN_MATEO = DEFAULT_LOCATION;

// Almanac sources disagree with each other by a couple of minutes (they assume different
// atmospheric refraction), so pinning the times tighter than this would be asserting noise.
// Minutes of slop are invisible in a theme switch either way.
const TOLERANCE_MIN = 5;

let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const inZone = (date, timeZone) =>
  date.toLocaleString('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });

const minutesApart = (date, timeZone, expected) => {
  const [h, m] = inZone(date, timeZone).split(':').map(Number);
  const [eh, em] = expected.split(':').map(Number);
  return Math.abs(h * 60 + m - (eh * 60 + em));
};

// Reference times from api.sunrise-sunset.org, which uses the same 0.833° horizon.
// Southern hemisphere and a high-latitude equinox are included because that is where the
// sunrise/sunset asymmetry around solar noon is largest.
const cases = [
  { label: 'San Mateo, midsummer', date: '2026-07-13T12:00:00-07:00', loc: SAN_MATEO,
    tz: 'America/Los_Angeles', sunrise: '05:57', sunset: '20:32' },
  { label: 'San Mateo, midwinter', date: '2025-12-21T12:00:00-08:00', loc: SAN_MATEO,
    tz: 'America/Los_Angeles', sunrise: '07:19', sunset: '16:56' },
  { label: 'Sydney, southern summer', date: '2026-01-15T12:00:00+11:00',
    loc: { lat: -33.8688, lon: 151.2093 }, tz: 'Australia/Sydney', sunrise: '05:58', sunset: '20:10' },
  { label: 'London, equinox', date: '2026-03-20T12:00:00+00:00',
    loc: { lat: 51.5072, lon: -0.1276 }, tz: 'Europe/London', sunrise: '06:01', sunset: '18:14' },
];

console.log('Sunrise / sunset vs. almanac reference times\n');

for (const { label, date, loc, tz, sunrise, sunset } of cases) {
  const times = getSunTimes(new Date(date), loc.lat, loc.lon);
  const riseOff = minutesApart(times.sunrise, tz, sunrise);
  const setOff = minutesApart(times.sunset, tz, sunset);

  check(`${label}: sunrise ~${sunrise}`, riseOff <= TOLERANCE_MIN,
    `got ${inZone(times.sunrise, tz)} (${riseOff} min off)`);
  check(`${label}: sunset ~${sunset}`, setOff <= TOLERANCE_MIN,
    `got ${inZone(times.sunset, tz)} (${setOff} min off)`);
}

console.log('\nDaylight around the San Mateo horizon');

const { sunrise, sunset } = getSunTimes(new Date('2026-07-13T12:00:00-07:00'), SAN_MATEO.lat, SAN_MATEO.lon);
const MIN = 60000;
const daylightCases = [
  ['a minute before sunrise is night', new Date(sunrise.valueOf() - MIN), false],
  ['a minute after sunrise is day', new Date(sunrise.valueOf() + MIN), true],
  ['a minute before sunset is day', new Date(sunset.valueOf() - MIN), true],
  ['a minute after sunset is night', new Date(sunset.valueOf() + MIN), false],
  ['local midnight is night', new Date('2026-07-13T00:00:00-07:00'), false],
  ['local noon is day', new Date('2026-07-13T12:00:00-07:00'), true],
];

for (const [label, at, expected] of daylightCases) {
  const got = isDaylight(at, SAN_MATEO.lat, SAN_MATEO.lon);
  check(label, got === expected, `isDaylight = ${got}`);
}

console.log('\nTransitions bracket the current moment');

const noon = new Date('2026-07-13T12:00:00-07:00');
const next = nextSolarTransition(noon, SAN_MATEO.lat, SAN_MATEO.lon);
const last = lastSolarTransition(noon, SAN_MATEO.lat, SAN_MATEO.lon);
check('next transition at noon is today\'s sunset', next.valueOf() === sunset.valueOf(),
  next.toISOString());
check('last transition at noon is today\'s sunrise', last.valueOf() === sunrise.valueOf(),
  last.toISOString());
check('next transition is in the future', next > noon);
check('last transition is in the past', last < noon);

console.log('\nPolar edge cases');

const TROMSO = { lat: 69.6492, lon: 18.9553 };
const polarDay = new Date('2026-06-21T12:00:00+02:00');
const polarNight = new Date('2025-12-21T12:00:00+01:00');

const summer = getSunTimes(polarDay, TROMSO.lat, TROMSO.lon);
check('Tromsø midsummer has no sunset', summer.sunset === null && summer.sunUpAllDay === true);
check('Tromsø midsummer is daylight', isDaylight(polarDay, TROMSO.lat, TROMSO.lon) === true);

const winter = getSunTimes(polarNight, TROMSO.lat, TROMSO.lon);
check('Tromsø midwinter has no sunrise', winter.sunrise === null && winter.sunUpAllDay === false);
check('Tromsø midwinter is night', isDaylight(polarNight, TROMSO.lat, TROMSO.lon) === false);
check('Tromsø polar night still finds a later sunrise',
  nextSolarTransition(polarNight, TROMSO.lat, TROMSO.lon) > polarNight);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
