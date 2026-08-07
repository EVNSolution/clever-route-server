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
