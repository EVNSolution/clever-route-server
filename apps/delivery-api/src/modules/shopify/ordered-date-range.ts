// Dates are inclusive calendar days in the requested IANA zone. SQL uses [start, next-day).
// Omitted zones retain the legacy UTC contract for existing API clients.
export function orderedDateBoundary(date: string, timeZone = 'UTC', nextDay = false): Date {
  const calendar = new Date(`${date}T00:00:00.000Z`);
  if (nextDay) calendar.setUTCDate(calendar.getUTCDate() + 1);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const target = calendar.getTime();
  let instant = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    if (represented === target) return new Date(instant);
    instant += target - represented;
  }
  throw new Error('Ordered date midnight cannot be resolved in the requested timezone');
}
