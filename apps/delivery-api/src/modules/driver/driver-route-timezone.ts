export function coerceIanaTimezone(value: string | null): string {
  if (value !== null && isIanaTimezone(value)) {
    return value;
  }

  return 'UTC';
}

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date('2026-01-01T00:00:00.000Z'));
    return true;
  } catch {
    return false;
  }
}
