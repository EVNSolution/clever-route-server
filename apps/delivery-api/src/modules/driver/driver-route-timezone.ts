export function coerceIanaTimezone(value: string | null): string {
  if (value !== null && isIanaTimezone(value)) {
    return value;
  }

  return 'UTC';
}

export function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date('2026-01-01T00:00:00.000Z'));
    return true;
  } catch {
    return false;
  }
}

export function localDateTimeInTimeZoneToUtc(
  isoDate: string,
  timeOfDay: string,
  timezone: string
): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  const [hour, minute] = timeOfDay.split(':').map(Number);
  if (
    year === undefined
    || month === undefined
    || day === undefined
    || hour === undefined
    || minute === undefined
    || !/^\d{4}-\d{2}-\d{2}$/u.test(isoDate)
    || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(timeOfDay)
    || !isIanaTimezone(timezone)
  ) {
    throw new Error('Invalid local route start time');
  }
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const first = new Date(utcGuess.getTime() - timeZoneOffsetMs(utcGuess, timezone));
  return new Date(utcGuess.getTime() - timeZoneOffsetMs(first, timezone));
}

function timeZoneOffsetMs(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone: timezone,
    year: 'numeric'
  }).formatToParts(date);
  const part = (type: string): number => Number(parts.find((item) => item.type === type)?.value ?? '0');
  return Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second')
  ) - date.getTime();
}

export function driverServiceDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Seoul',
    year: 'numeric'
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function driverServiceDateAsDbDate(now: Date): Date {
  return new Date(`${driverServiceDate(now)}T00:00:00.000Z`);
}
