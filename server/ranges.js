/**
 * Calendar maths for the dashboard's three reporting windows.
 *
 * Every window is resolved to absolute `YYYY-MM-DD` bounds in a single
 * configured timezone (GA_TIMEZONE) rather than with GA's relative
 * `NdaysAgo` tokens. Absolute bounds are what let us anchor the yearly
 * window to the start of a calendar month, and they keep the mock and live
 * backends producing identical shapes.
 */

/** Civil date arithmetic on {y, m, d}, done through UTC epochs so it never drifts. */
const dayMs = 24 * 60 * 60 * 1000;

function toEpoch({ y, m, d }) {
  return Date.UTC(y, m - 1, d);
}

function fromEpoch(ms) {
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function addDays(date, n) {
  return fromEpoch(toEpoch(date) + n * dayMs);
}

export function addMonths({ y, m, d }, n) {
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  // Clamp the day so e.g. Jan 31 minus one month lands on the last day of Feb.
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return { y: ny, m: nm, d: Math.min(d, lastDay) };
}

export function formatDate({ y, m, d }) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return { y, m, d };
}

export function daysBetween(a, b) {
  return Math.round((toEpoch(b) - toEpoch(a)) / dayMs);
}

/** "Today" as a civil date in the given IANA timezone. */
export function today(timeZone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parseDate(parts);
}

export const RANGES = ['weekly', 'monthly', 'yearly'];

/**
 * Resolve a named range into current + previous bounds and the bucket
 * granularity its trend should be drawn at.
 *
 * The previous window is always the same length as the current one and sits
 * immediately before it, so the deltas compare like with like.
 */
export function resolveRange(range, timeZone = 'UTC') {
  const end = today(timeZone);

  if (range === 'yearly') {
    // Anchor to the first of the month 11 months back, giving 12 month buckets
    // (the current month included, partial as it is).
    const start = { ...addMonths(end, -11), d: 1 };
    // Shift the whole window back a year rather than butting it up against the
    // start of the current one. The current window ends mid-month, so a
    // previous window ending on a month boundary would compare eight days of
    // traffic against a full month and draw a cliff that isn't there.
    return {
      range,
      granularity: 'month',
      current: { start, end },
      previous: { start: addMonths(start, -12), end: addMonths(end, -12) },
    };
  }

  const span = range === 'weekly' ? 7 : 30;
  const start = addDays(end, -(span - 1));
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -(span - 1));
  return {
    range,
    granularity: 'day',
    current: { start, end },
    previous: { start: prevStart, end: prevEnd },
  };
}

/**
 * Every bucket key a range covers, in order — including buckets GA reports no
 * rows for. Charting only the keys GA returned would silently close the gaps
 * where traffic was zero and misstate the trend.
 */
export function bucketKeys({ granularity, current }) {
  const keys = [];
  if (granularity === 'month') {
    let cursor = { ...current.start, d: 1 };
    const last = { ...current.end, d: 1 };
    while (toEpoch(cursor) <= toEpoch(last)) {
      keys.push(`${String(cursor.y).padStart(4, '0')}${String(cursor.m).padStart(2, '0')}`);
      cursor = addMonths(cursor, 1);
    }
    return keys;
  }
  const total = daysBetween(current.start, current.end);
  for (let i = 0; i <= total; i += 1) {
    keys.push(formatDate(addDays(current.start, i)));
  }
  return keys;
}
