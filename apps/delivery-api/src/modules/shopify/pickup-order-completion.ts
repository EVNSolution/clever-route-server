const PICKUP_COMPLETION_TIMEZONE = 'America/Toronto';

export type PickupCompletionInput = {
  cancelledAt: Date | string | null;
  deliveryDate: Date | string | null;
  serviceType: string | null;
  timeWindowEnd: Date | string | null;
};

export function pickupCompleteAfter(input: PickupCompletionInput): Date | null {
  if (input.cancelledAt !== null || input.serviceType !== 'PICKUP') return null;

  const explicitEnd = validDate(input.timeWindowEnd);
  if (explicitEnd !== null) return explicitEnd;

  const deliveryDate = dateOnly(input.deliveryDate);
  if (deliveryDate === null) return null;
  return localMidnightAfter(deliveryDate, PICKUP_COMPLETION_TIMEZONE);
}

export function isPickupComplete(input: PickupCompletionInput, now: Date = new Date()): boolean {
  const completeAfter = pickupCompleteAfter(input);
  return completeAfter !== null && now.getTime() >= completeAfter.getTime();
}

export function torontoDateOnly(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: PICKUP_COMPLETION_TIMEZONE,
    year: 'numeric'
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function validDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function dateOnly(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  return validDate(value)?.toISOString().slice(0, 10) ?? null;
}

function localMidnightAfter(date: string, timeZone: string): Date | null {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  return zonedTimeToUtc(nextDate, '00:00', timeZone);
}

function zonedTimeToUtc(date: string, time: string, timeZone: string): Date | null {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (
    year === undefined || month === undefined || day === undefined ||
    hour === undefined || minute === undefined ||
    [year, month, day, hour, minute].some((part) => !Number.isFinite(part))
  ) return null;

  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let utc = new Date(targetAsUtc);
  for (let index = 0; index < 2; index += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      minute: '2-digit',
      month: '2-digit',
      timeZone,
      year: 'numeric'
    }).formatToParts(utc);
    const part = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((item) => item.type === type)?.value);
    const localAsUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), 0);
    utc = new Date(utc.getTime() + targetAsUtc - localAsUtc);
  }
  return utc;
}
