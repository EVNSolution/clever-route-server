import type { DeliveryServiceType, DeliveryWeekday, ShopifyOrderLineItem } from './order-sync.mapper.js';

export type DeliverySession = 'DAY' | 'EVENING' | 'PICKUP';
export type DeliveryDateSource = 'EXPLICIT_ATTRIBUTE' | 'LINE_ITEM_DATE_RANGE' | 'ORDER_DATE_CYCLE_RULE' | 'MISSING';

export type DeliveryScopeInput = {
  createdAt: string | null;
  deliveryArea?: string | null;
  deliveryDateRaw?: string | null;
  deliveryDayRaw: string | null;
  lineItems: ShopifyOrderLineItem[];
  pickupDayRaw: string | null;
  processedAt: string | null;
  shopTimezone?: string;
};

export type DeliveryScope = {
  deliveryBatchEndDate: string | null;
  deliveryBatchStartDate: string | null;
  deliveryDate: string | null;
  deliveryDateSource: DeliveryDateSource;
  deliverySession: DeliverySession | null;
  deliveryWeekday: DeliveryWeekday | null;
  orderCreatedAt: string | null;
  orderDateLocal: string | null;
  planningGroupKey: string | null;
  routeScopeKey: string | null;
  serviceType: DeliveryServiceType | null;
  timeWindowEnd: string | null;
  timeWindowStart: string | null;
};

type ParsedService = {
  deliverySession: DeliverySession | null;
  deliveryWeekday: DeliveryWeekday | null;
  serviceType: DeliveryServiceType | null;
  timeWindowEnd: string | null;
  timeWindowStart: string | null;
};

type DateRange = {
  endDate: string;
  startDate: string;
};

const DEFAULT_TIMEZONE = 'America/Toronto';

export function calculateDeliveryScope(input: DeliveryScopeInput): DeliveryScope {
  const service = parseService(input.pickupDayRaw ?? input.deliveryDayRaw, input.pickupDayRaw !== null);
  const orderCreatedAt = input.createdAt ?? input.processedAt;
  const timezone = input.shopTimezone ?? DEFAULT_TIMEZONE;
  const orderDateLocal = orderCreatedAt === null ? null : toLocalDate(orderCreatedAt, timezone);
  const explicitDeliveryDate = parseExplicitDeliveryDate(input.deliveryDateRaw ?? null, orderDateLocal);
  const lineItemRange = findLineItemDateRange(input.lineItems, orderDateLocal);
  const fallbackRange = lineItemRange ?? (orderDateLocal === null ? null : calculateCycleRange(orderDateLocal));
  const deliveryWeekday = service.deliveryWeekday ?? weekdayFromDate(explicitDeliveryDate);
  const serviceType = service.serviceType ?? (explicitDeliveryDate === null ? null : 'DELIVERY');
  const deliverySession = service.deliverySession ?? (explicitDeliveryDate === null ? null : 'DAY');
  const deliveryDate =
    explicitDeliveryDate ??
    (fallbackRange === null || deliveryWeekday === null
      ? null
      : findDateForWeekday(fallbackRange, deliveryWeekday));
  const deliveryDateSource: DeliveryDateSource =
    explicitDeliveryDate !== null
      ? 'EXPLICIT_ATTRIBUTE'
      : deliveryDate === null ? 'MISSING' : lineItemRange === null ? 'ORDER_DATE_CYCLE_RULE' : 'LINE_ITEM_DATE_RANGE';
  const routeScopeKey =
    deliveryDate === null || serviceType === null
      ? null
      : [deliveryDate, serviceType, service.timeWindowStart ?? '', service.timeWindowEnd ?? ''].join('|');
  const deliveryArea = normalizeOptional(input.deliveryArea);

  return {
    deliveryBatchEndDate: fallbackRange?.endDate ?? null,
    deliveryBatchStartDate: fallbackRange?.startDate ?? null,
    deliveryDate,
    deliveryDateSource,
    deliverySession,
    deliveryWeekday,
    orderCreatedAt,
    orderDateLocal,
    planningGroupKey: routeScopeKey === null ? null : deliveryArea === null ? routeScopeKey : `${routeScopeKey}|${deliveryArea}`,
    routeScopeKey,
    serviceType,
    timeWindowEnd: service.timeWindowEnd,
    timeWindowStart: service.timeWindowStart
  };
}

function parseService(value: string | null, pickup: boolean): ParsedService {
  const normalized = normalizeDeliveryDayText(value);
  const weekday = parseWeekday(normalized);
  if (pickup) {
    return {
      deliverySession: weekday === null ? null : 'PICKUP',
      deliveryWeekday: weekday,
      serviceType: weekday === null ? null : 'PICKUP',
      timeWindowEnd: null,
      timeWindowStart: null
    };
  }
  if (/^friday\s+5\s*pm\s+to\s+9\s*pm/iu.test(value ?? '')) {
    return {
      deliverySession: 'EVENING',
      deliveryWeekday: 'FRIDAY',
      serviceType: 'EVENING_DELIVERY',
      timeWindowEnd: '21:00',
      timeWindowStart: '17:00'
    };
  }
  return {
    deliverySession: weekday === null ? null : 'DAY',
    deliveryWeekday: weekday,
    serviceType: weekday === null ? null : 'DELIVERY',
    timeWindowEnd: null,
    timeWindowStart: null
  };
}

function parseWeekday(value: string | null): DeliveryWeekday | null {
  if (value === 'sunday') return 'SUNDAY';
  if (value === 'monday') return 'MONDAY';
  if (value === 'tuesday') return 'TUESDAY';
  if (value === 'wednesday') return 'WEDNESDAY';
  if (value === 'thursday') return 'THURSDAY';
  if (value === 'friday') return 'FRIDAY';
  if (value === 'saturday') return 'SATURDAY';
  return null;
}

function normalizeDeliveryDayText(value: string | null): string | null {
  if (value === null) return null;
  return value
    .trim()
    .toLowerCase()
    .replace(/\s*-\s*pickup$/iu, '')
    .replace(/\s+pickup$/iu, '');
}

function findLineItemDateRange(items: ShopifyOrderLineItem[], orderDateLocal: string | null): DateRange | null {
  for (const item of items) {
    const candidates = [item.title, item.name, item.variantTitle].flatMap((value) =>
      value === null || value === undefined ? [] : [value]
    );
    for (const candidate of candidates) {
      const range = parseDateRange(candidate, orderDateLocal);
      if (range !== null) return range;
    }
  }
  return null;
}

function parseDateRange(value: string, orderDateLocal: string | null): DateRange | null {
  const dotted = /(20\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})\s*-\s*(?:(20\d{2})[.\-/])?(\d{1,2})[.\-/](\d{1,2})/u.exec(value);
  if (dotted !== null) {
    const [, startYear, startMonth, startDay, endYear, endMonth, endDay] = dotted;
    if (startYear && startMonth && startDay && endMonth && endDay) {
      return {
        endDate: formatYmd(Number(endYear ?? startYear), Number(endMonth), Number(endDay)),
        startDate: formatYmd(Number(startYear), Number(startMonth), Number(startDay))
      };
    }
  }

  const short = /(?<!\d)(\d{1,2})\/(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})(?!\d)/u.exec(value);
  if (short !== null) {
    const [, startMonth, startDay, endMonth, endDay] = short;
    if (startMonth && startDay && endMonth && endDay) {
      const year = orderDateLocal === null ? new Date().getUTCFullYear() : Number(orderDateLocal.slice(0, 4));
      return {
        endDate: formatYmd(year, Number(endMonth), Number(endDay)),
        startDate: formatYmd(year, Number(startMonth), Number(startDay))
      };
    }
  }

  return null;
}

function parseExplicitDeliveryDate(value: string | null, orderDateLocal: string | null): string | null {
  const normalizedValue = normalizeOptional(value);
  if (normalizedValue === null) return null;

  const iso = /\b(20\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})\b/u.exec(normalizedValue);
  if (iso !== null) {
    const [, year, month, day] = iso;
    if (year && month && day) return formatValidYmd(Number(year), Number(month), Number(day));
  }

  const short = /\b(\d{1,2})[.\-/](\d{1,2})\b/u.exec(normalizedValue);
  if (short === null || orderDateLocal === null) return null;

  const [, month, day] = short;
  return month && day ? formatValidYmd(Number(orderDateLocal.slice(0, 4)), Number(month), Number(day)) : null;
}

function calculateCycleRange(orderDateLocal: string): DateRange {
  const orderDate = parseYmd(orderDateLocal);
  const day = orderDate.getUTCDay();
  const daysSinceTuesday = (day - 2 + 7) % 7;
  const openTuesday = addDays(orderDate, -daysSinceTuesday);
  const cutoffMonday = addDays(openTuesday, 6);
  return {
    endDate: formatDate(addDays(cutoffMonday, 5)),
    startDate: formatDate(addDays(cutoffMonday, 3))
  };
}

function findDateForWeekday(range: DateRange, weekday: DeliveryWeekday): string | null {
  const target = weekdayIndex(weekday);
  let cursor = parseYmd(range.startDate);
  const end = parseYmd(range.endDate);
  while (cursor.getTime() <= end.getTime()) {
    if (cursor.getUTCDay() === target) return formatDate(cursor);
    cursor = addDays(cursor, 1);
  }
  return null;
}

function weekdayFromDate(value: string | null): DeliveryWeekday | null {
  if (value === null) return null;
  const date = parseYmd(value);
  if (Number.isNaN(date.getTime())) return null;

  return weekdayFromIndex(date.getUTCDay());
}

function weekdayIndex(weekday: DeliveryWeekday): number {
  if (weekday === 'SUNDAY') return 0;
  if (weekday === 'MONDAY') return 1;
  if (weekday === 'TUESDAY') return 2;
  if (weekday === 'WEDNESDAY') return 3;
  if (weekday === 'THURSDAY') return 4;
  if (weekday === 'FRIDAY') return 5;
  return 6;
}

function weekdayFromIndex(index: number): DeliveryWeekday | null {
  if (index === 0) return 'SUNDAY';
  if (index === 1) return 'MONDAY';
  if (index === 2) return 'TUESDAY';
  if (index === 3) return 'WEDNESDAY';
  if (index === 4) return 'THURSDAY';
  if (index === 5) return 'FRIDAY';
  if (index === 6) return 'SATURDAY';
  return null;
}

function toLocalDate(value: string, timezone: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: timezone,
    year: 'numeric'
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return year === undefined || month === undefined || day === undefined ? null : `${year}-${month}-${day}`;
}

function normalizeOptional(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseYmd(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function formatYmd(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

function formatValidYmd(year: number, month: number, day: number): string | null {
  if (![year, month, day].every(Number.isInteger)) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return formatDate(date);
}
