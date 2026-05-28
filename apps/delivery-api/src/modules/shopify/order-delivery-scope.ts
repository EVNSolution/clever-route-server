import type {
  DeliveryServiceType,
  DeliveryWeekday,
  ShopifyOrderLineItem,
} from "./order-sync.mapper.js";

export type DeliverySession = "DAY" | "EVENING" | "PICKUP";
export type DeliveryDateSource =
  | "EXPLICIT_ATTRIBUTE"
  | "LINE_ITEM_DATE_RANGE"
  | "ORDER_DATE_CYCLE_RULE"
  | "ORDER_DATE_WEEK_RULE"
  | "MISSING";

export type WeekdayFallbackPolicy = "DELIVERY_CYCLE" | "ORDER_WEEK";

export type DeliveryScopeInput = {
  createdAt: string | null;
  deliveryArea?: string | null;
  deliveryDateRaw?: string | null;
  deliveryDayRaw: string | null;
  deliveryTimeWindow?: DeliveryTimeWindowParseResult | null;
  lineItems: ShopifyOrderLineItem[];
  pickupDayRaw: string | null;
  processedAt: string | null;
  shopTimezone?: string;
  weekdayFallbackPolicy?: WeekdayFallbackPolicy;
};

export type DeliveryScope = {
  deliveryBatchEndDate: string | null;
  deliveryBatchStartDate: string | null;
  deliveryDate: string | null;
  deliveryDateSource: DeliveryDateSource;
  deliveryDateWeekday: DeliveryWeekday | null;
  deliveryDateWeekdayMismatch: boolean;
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

export type DeliveryDayVerification = {
  ambiguous: boolean;
  deliveryWeekday: DeliveryWeekday | null;
  serviceType: DeliveryServiceType | null;
  verified: boolean;
  weekdayAmbiguous: boolean;
};

export type ParsedDeliveryService = {
  ambiguous: boolean;
  deliverySession: DeliverySession | null;
  deliveryWeekday: DeliveryWeekday | null;
  serviceType: DeliveryServiceType | null;
  timeWindowAmbiguous: boolean;
  timeWindowEnd: string | null;
  timeWindowStart: string | null;
  weekdayAmbiguous: boolean;
};

export type DeliveryTimeWindowParseResult = {
  ambiguous: boolean;
  deliverySession: Exclude<DeliverySession, "PICKUP"> | null;
  serviceType: Exclude<DeliveryServiceType, "PICKUP"> | null;
  timeWindowEnd: string | null;
  timeWindowStart: string | null;
};

type DateRange = {
  endDate: string;
  startDate: string;
};

const DEFAULT_TIMEZONE = "America/Toronto";

export function calculateDeliveryScope(
  input: DeliveryScopeInput,
): DeliveryScope {
  const parsedService = parseDeliveryServiceRaw(
    input.pickupDayRaw ?? input.deliveryDayRaw,
    input.pickupDayRaw !== null,
  );
  const service = applyExplicitDeliveryTimeWindow(
    parsedService,
    input.pickupDayRaw === null ? input.deliveryTimeWindow ?? null : null,
  );
  const orderCreatedAt = input.createdAt ?? input.processedAt;
  const timezone = input.shopTimezone ?? DEFAULT_TIMEZONE;
  const orderDateLocal =
    orderCreatedAt === null ? null : toLocalDate(orderCreatedAt, timezone);
  const explicitDeliveryDate = parseExplicitDeliveryDate(
    input.deliveryDateRaw ?? null,
    orderDateLocal,
  );
  const lineItemRange = findLineItemDateRange(input.lineItems, orderDateLocal);
  const weekdayFallbackPolicy =
    input.weekdayFallbackPolicy ?? "DELIVERY_CYCLE";
  const orderDateFallbackRange =
    orderDateLocal === null
      ? null
      : weekdayFallbackPolicy === "ORDER_WEEK"
        ? calculateOrderWeekRange(orderDateLocal)
        : calculateCycleRange(orderDateLocal);
  const fallbackRange =
    lineItemRange ?? orderDateFallbackRange;
  const explicitDeliveryDateWeekday = weekdayFromDate(explicitDeliveryDate);
  const deliveryWeekday =
    service.deliveryWeekday ?? explicitDeliveryDateWeekday;
  const serviceType =
    service.serviceType ?? (explicitDeliveryDate === null ? null : "DELIVERY");
  const deliverySession =
    service.deliverySession ?? (explicitDeliveryDate === null ? null : "DAY");
  const deliveryDate =
    explicitDeliveryDate ??
    (fallbackRange === null || deliveryWeekday === null
      ? null
      : findDateForWeekday(fallbackRange, deliveryWeekday));
  const deliveryDateSource: DeliveryDateSource =
    explicitDeliveryDate !== null
      ? "EXPLICIT_ATTRIBUTE"
      : deliveryDate === null
        ? "MISSING"
        : lineItemRange === null
          ? weekdayFallbackPolicy === "ORDER_WEEK"
            ? "ORDER_DATE_WEEK_RULE"
            : "ORDER_DATE_CYCLE_RULE"
          : "LINE_ITEM_DATE_RANGE";
  const routeScopeKey =
    deliveryDate === null || serviceType === null
      ? null
      : [
          deliveryDate,
          serviceType,
          service.timeWindowStart ?? "",
          service.timeWindowEnd ?? "",
        ].join("|");
  const deliveryArea = normalizeOptional(input.deliveryArea);
  const deliveryDateWeekday = weekdayFromDate(deliveryDate);
  const deliveryDateWeekdayMismatch =
    service.deliveryWeekday !== null &&
    deliveryDateWeekday !== null &&
    service.deliveryWeekday !== deliveryDateWeekday;

  return {
    deliveryBatchEndDate: fallbackRange?.endDate ?? null,
    deliveryBatchStartDate: fallbackRange?.startDate ?? null,
    deliveryDate,
    deliveryDateSource,
    deliveryDateWeekday,
    deliveryDateWeekdayMismatch,
    deliverySession,
    deliveryWeekday,
    orderCreatedAt,
    orderDateLocal,
    planningGroupKey:
      routeScopeKey === null
        ? null
        : deliveryArea === null
          ? routeScopeKey
          : `${routeScopeKey}|${deliveryArea}`,
    routeScopeKey,
    serviceType,
    timeWindowEnd: service.timeWindowEnd,
    timeWindowStart: service.timeWindowStart,
  };
}

export function verifyDeliveryDayRaw(
  value: string | null,
  options: { pickup?: boolean } = {},
): DeliveryDayVerification {
  if (value === null) {
    return {
      ambiguous: false,
      deliveryWeekday: null,
      serviceType: null,
      verified: false,
      weekdayAmbiguous: false,
    };
  }
  const parsed = parseDeliveryServiceRaw(value, options.pickup === true);
  return {
    ambiguous: parsed.ambiguous,
    deliveryWeekday: parsed.deliveryWeekday,
    serviceType: parsed.serviceType,
    verified:
      parsed.deliveryWeekday !== null &&
      parsed.serviceType !== null &&
      !parsed.ambiguous,
    weekdayAmbiguous: parsed.weekdayAmbiguous,
  };
}

export function parseDeliveryServiceRaw(
  value: string | null,
  pickup = false,
): ParsedDeliveryService {
  const normalized = normalizeDeliveryDayText(value);
  const weekdayScan = scanWeekdays(normalized);
  const weekday =
    weekdayScan.weekdays.length === 1
      ? (weekdayScan.weekdays[0] ?? null)
      : null;
  const timeWindow = parseDeliveryTimeWindow(value);
  const weekdayAmbiguous = weekdayScan.weekdays.length > 1;
  const ambiguous = weekdayAmbiguous || timeWindow.ambiguous;
  if (pickup) {
    return {
      ambiguous,
      deliverySession: weekday === null ? null : "PICKUP",
      deliveryWeekday: weekday,
      serviceType: weekday === null ? null : "PICKUP",
      timeWindowAmbiguous: false,
      timeWindowEnd: null,
      timeWindowStart: null,
      weekdayAmbiguous,
    };
  }
  if (timeWindow.timeWindowStart !== null && timeWindow.timeWindowEnd !== null) {
    return {
      ambiguous,
      deliverySession: timeWindow.deliverySession,
      deliveryWeekday: weekday,
      serviceType: timeWindow.serviceType,
      timeWindowAmbiguous: timeWindow.ambiguous,
      timeWindowEnd: timeWindow.timeWindowEnd,
      timeWindowStart: timeWindow.timeWindowStart,
      weekdayAmbiguous,
    };
  }
  return {
    ambiguous,
    deliverySession: weekday === null ? null : "DAY",
    deliveryWeekday: weekday,
    serviceType: weekday === null ? null : "DELIVERY",
    timeWindowAmbiguous: timeWindow.ambiguous,
    timeWindowEnd: null,
    timeWindowStart: null,
    weekdayAmbiguous,
  };
}

export function parseDeliveryTimeWindow(
  value: string | null,
): DeliveryTimeWindowParseResult {
  const normalized = normalizeDeliveryDayText(value);
  if (normalized === null || looksLikeNonDeliveryNumberOnly(normalized)) {
    return emptyTimeWindowParse(false);
  }

  const candidates = extractTimeWindowCandidates(normalized);
  const distinct = [
    ...new Map(
      candidates.map((candidate) => [
        `${candidate.timeWindowStart}|${candidate.timeWindowEnd}`,
        candidate,
      ]),
    ).values(),
  ];
  if (distinct.length === 0) return emptyTimeWindowParse(false);
  if (distinct.length > 1) return emptyTimeWindowParse(true);

  const selected = distinct[0];
  if (selected === undefined) return emptyTimeWindowParse(false);
  return {
    ambiguous: false,
    deliverySession: selected.deliverySession,
    serviceType: selected.serviceType,
    timeWindowEnd: selected.timeWindowEnd,
    timeWindowStart: selected.timeWindowStart,
  };
}

function applyExplicitDeliveryTimeWindow(
  service: ParsedDeliveryService,
  explicitWindow: DeliveryTimeWindowParseResult | null,
): ParsedDeliveryService {
  if (explicitWindow === null) return service;
  if (explicitWindow.ambiguous)
    return { ...service, ambiguous: true, timeWindowAmbiguous: true };
  if (
    explicitWindow.timeWindowStart === null ||
    explicitWindow.timeWindowEnd === null ||
    explicitWindow.deliverySession === null ||
    explicitWindow.serviceType === null
  ) {
    return service;
  }
  if (
    service.timeWindowStart !== null &&
    service.timeWindowEnd !== null &&
    (service.timeWindowStart !== explicitWindow.timeWindowStart ||
      service.timeWindowEnd !== explicitWindow.timeWindowEnd)
  ) {
    return { ...service, ambiguous: true, timeWindowAmbiguous: true };
  }
  return {
    ...service,
    deliverySession: explicitWindow.deliverySession,
    serviceType: explicitWindow.serviceType,
    timeWindowEnd: explicitWindow.timeWindowEnd,
    timeWindowStart: explicitWindow.timeWindowStart,
  };
}

function emptyTimeWindowParse(
  ambiguous: boolean,
): DeliveryTimeWindowParseResult {
  return {
    ambiguous,
    deliverySession: null,
    serviceType: null,
    timeWindowEnd: null,
    timeWindowStart: null,
  };
}

type TimeWindowCandidate = {
  deliverySession: Exclude<DeliverySession, "PICKUP">;
  serviceType: Exclude<DeliveryServiceType, "PICKUP">;
  timeWindowEnd: string;
  timeWindowStart: string;
};

function extractTimeWindowCandidates(value: string): TimeWindowCandidate[] {
  const candidates: TimeWindowCandidate[] = [];
  const pushCandidate = (start: TimeOfDay, end: TimeOfDay): void => {
    if (end.minutes <= start.minutes) return;
    const deliverySession =
      start.minutes >= 16 * 60 || /\b(?:evening|night)\b|저녁|밤/u.test(value)
        ? "EVENING"
        : "DAY";
    candidates.push({
      deliverySession,
      serviceType:
        deliverySession === "EVENING" ? "EVENING_DELIVERY" : "DELIVERY",
      timeWindowEnd: end.formatted,
      timeWindowStart: start.formatted,
    });
  };

  for (const match of value.matchAll(
    /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:to|-|–|—|~)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/giu,
  )) {
    const [
      ,
      startHour,
      startMinute,
      startMeridiem,
      endHour,
      endMinute,
      endMeridiem,
    ] = match;
    const start = parseTimeOfDay({
      hour: startHour,
      meridiem: startMeridiem ?? endMeridiem,
      minute: startMinute,
    });
    const end = parseTimeOfDay({
      hour: endHour,
      meridiem: endMeridiem,
      minute: endMinute,
    });
    if (start !== null && end !== null) pushCandidate(start, end);
  }

  for (const match of value.matchAll(
    /\b(\d{1,2}):(\d{2})\s*(?:to|-|–|—|~)\s*(\d{1,2}):(\d{2})\b/gu,
  )) {
    const [, startHour, startMinute, endHour, endMinute] = match;
    const start = parseTimeOfDay({ hour: startHour, minute: startMinute });
    const end = parseTimeOfDay({ hour: endHour, minute: endMinute });
    if (start !== null && end !== null) pushCandidate(start, end);
  }

  for (const match of value.matchAll(
    /(?:(오전|오후)\s*)?(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?\s*(?:to|-|–|—|~)\s*(?:(오전|오후)\s*)?(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/gu,
  )) {
    const [
      ,
      startKoreanMeridiem,
      startHour,
      startMinute,
      endKoreanMeridiem,
      endHour,
      endMinute,
    ] = match;
    const start = parseTimeOfDay({
      hour: startHour,
      koreanMeridiem: startKoreanMeridiem ?? endKoreanMeridiem,
      minute: startMinute,
    });
    const end = parseTimeOfDay({
      hour: endHour,
      koreanMeridiem: endKoreanMeridiem ?? startKoreanMeridiem,
      minute: endMinute,
    });
    if (start !== null && end !== null) pushCandidate(start, end);
  }

  return candidates;
}

type TimeOfDay = {
  formatted: string;
  minutes: number;
};

function parseTimeOfDay(input: {
  hour: string | undefined;
  koreanMeridiem?: string | undefined;
  meridiem?: string | undefined;
  minute?: string | undefined;
}): TimeOfDay | null {
  if (input.hour === undefined) return null;
  let hour = Number(input.hour);
  const minute = input.minute === undefined ? 0 : Number(input.minute);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (minute < 0 || minute > 59) return null;
  const meridiem = normalizeMeridiem(input.meridiem, input.koreanMeridiem);
  if (meridiem === null) {
    if (hour < 0 || hour > 23) return null;
  } else {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  }
  const minutes = hour * 60 + minute;
  return {
    formatted: `${String(hour).padStart(2, "0")}:${String(minute).padStart(
      2,
      "0",
    )}`,
    minutes,
  };
}

function normalizeMeridiem(
  english: string | undefined,
  korean: string | undefined,
): "am" | "pm" | null {
  if (korean === "오전") return "am";
  if (korean === "오후") return "pm";
  if (english === undefined) return null;
  return english.toLowerCase().startsWith("p") ? "pm" : "am";
}

function looksLikeNonDeliveryNumberOnly(value: string): boolean {
  if (/[a-z가-힣]/iu.test(value)) return false;
  if (/\b\d{1,2}:\d{2}\b/u.test(value)) return false;
  return !/\b(?:a\.?m\.?|p\.?m\.?)\b/iu.test(value);
}

function scanWeekdays(value: string | null): { weekdays: DeliveryWeekday[] } {
  if (value === null) return { weekdays: [] };
  const normalized = normalizeDeliveryDayText(value) ?? "";
  const weekdays = new Set<DeliveryWeekday>();
  const add = (weekday: DeliveryWeekday, pattern: RegExp): void => {
    if (pattern.test(normalized)) weekdays.add(weekday);
  };

  add(
    "SUNDAY",
    /(?:\bsun(?:day)?\b|(?:^|[\s()[\]{}:;,_/\\-])일(?:요일)?(?=$|[\s()[\]{}:;,_/\\-]))/iu,
  );
  add(
    "MONDAY",
    /(?:\bmon(?:day)?\b|(?:^|[\s()[\]{}:;,_/\\-])월(?:요일)?(?=$|[\s()[\]{}:;,_/\\-]))/iu,
  );
  add(
    "TUESDAY",
    /(?:\btue(?:s|sday|day)?\b|(?:^|[\s()[\]{}:;,_/\\-])화(?:요일)?(?=$|[\s()[\]{}:;,_/\\-]))/iu,
  );
  add(
    "WEDNESDAY",
    /(?:\bwed(?:nesday)?\b|(?:^|[\s()[\]{}:;,_/\\-])수(?:요일)?(?=$|[\s()[\]{}:;,_/\\-]))/iu,
  );
  add(
    "THURSDAY",
    /(?:\bthu(?:r|rs|rsday)?\b|\bthursday\b|(?:^|[\s()[\]{}:;,_/\\-])목(?:요일)?(?=$|[\s()[\]{}:;,_/\\-]))/iu,
  );
  add(
    "FRIDAY",
    /(?:\bfri(?:day)?\b|(?:^|[\s()[\]{}:;,_/\\-])금(?:요일)?(?=$|[\s()[\]{}:;,_/\\-]))/iu,
  );
  add(
    "SATURDAY",
    /(?:\bsat(?:urday)?\b|(?:^|[\s()[\]{}:;,_/\\-])토(?:요일)?(?=$|[\s()[\]{}:;,_/\\-]))/iu,
  );
  return { weekdays: [...weekdays] };
}

function normalizeDeliveryDayText(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .trim()
    .toLowerCase()
    .replace(/\*\s*check\s+delivery\s+map\b.*$/iu, "")
    .replace(/\s*-\s*pickup$/iu, "")
    .replace(/\s+pickup$/iu, "")
    .replace(/\s+/gu, " ");
}

function findLineItemDateRange(
  items: ShopifyOrderLineItem[],
  orderDateLocal: string | null,
): DateRange | null {
  for (const item of items) {
    const candidates = [item.title, item.name, item.variantTitle].flatMap(
      (value) => (value === null || value === undefined ? [] : [value]),
    );
    for (const candidate of candidates) {
      const range = parseDateRange(candidate, orderDateLocal);
      if (range !== null) return range;
    }
  }
  return null;
}

function parseDateRange(
  value: string,
  orderDateLocal: string | null,
): DateRange | null {
  const dotted =
    /(20\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})\s*-\s*(?:(20\d{2})[.\-/])?(\d{1,2})[.\-/](\d{1,2})/u.exec(
      value,
    );
  if (dotted !== null) {
    const [, startYear, startMonth, startDay, endYear, endMonth, endDay] =
      dotted;
    if (startYear && startMonth && startDay && endMonth && endDay) {
      return {
        endDate: formatYmd(
          Number(endYear ?? startYear),
          Number(endMonth),
          Number(endDay),
        ),
        startDate: formatYmd(
          Number(startYear),
          Number(startMonth),
          Number(startDay),
        ),
      };
    }
  }

  const short =
    /(?<!\d)(\d{1,2})\/(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})(?!\d)/u.exec(value);
  if (short !== null) {
    const [, startMonth, startDay, endMonth, endDay] = short;
    if (startMonth && startDay && endMonth && endDay) {
      const year =
        orderDateLocal === null
          ? new Date().getUTCFullYear()
          : Number(orderDateLocal.slice(0, 4));
      return {
        endDate: formatYmd(year, Number(endMonth), Number(endDay)),
        startDate: formatYmd(year, Number(startMonth), Number(startDay)),
      };
    }
  }

  return null;
}

function parseExplicitDeliveryDate(
  value: string | null,
  orderDateLocal: string | null,
): string | null {
  const normalizedValue = normalizeOptional(value);
  if (normalizedValue === null) return null;

  const iso = /\b(20\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})\b/u.exec(
    normalizedValue,
  );
  if (iso !== null) {
    const [, year, month, day] = iso;
    if (year && month && day)
      return formatValidYmd(Number(year), Number(month), Number(day));
  }

  const short = /\b(\d{1,2})[.\-/](\d{1,2})\b/u.exec(normalizedValue);
  if (short === null || orderDateLocal === null) return null;

  const [, month, day] = short;
  return month && day
    ? formatValidYmd(
        Number(orderDateLocal.slice(0, 4)),
        Number(month),
        Number(day),
      )
    : null;
}

function calculateCycleRange(orderDateLocal: string): DateRange {
  const orderDate = parseYmd(orderDateLocal);
  const day = orderDate.getUTCDay();
  const daysSinceTuesday = (day - 2 + 7) % 7;
  const openTuesday = addDays(orderDate, -daysSinceTuesday);
  const cutoffMonday = addDays(openTuesday, 6);
  return {
    endDate: formatDate(addDays(cutoffMonday, 5)),
    startDate: formatDate(addDays(cutoffMonday, 3)),
  };
}

function calculateOrderWeekRange(orderDateLocal: string): DateRange {
  const orderDate = parseYmd(orderDateLocal);
  const day = orderDate.getUTCDay();
  const daysSinceMonday = (day - 1 + 7) % 7;
  const monday = addDays(orderDate, -daysSinceMonday);
  return {
    endDate: formatDate(addDays(monday, 6)),
    startDate: formatDate(monday),
  };
}

function findDateForWeekday(
  range: DateRange,
  weekday: DeliveryWeekday,
): string | null {
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
  if (weekday === "SUNDAY") return 0;
  if (weekday === "MONDAY") return 1;
  if (weekday === "TUESDAY") return 2;
  if (weekday === "WEDNESDAY") return 3;
  if (weekday === "THURSDAY") return 4;
  if (weekday === "FRIDAY") return 5;
  return 6;
}

function weekdayFromIndex(index: number): DeliveryWeekday | null {
  if (index === 0) return "SUNDAY";
  if (index === 1) return "MONDAY";
  if (index === 2) return "TUESDAY";
  if (index === 3) return "WEDNESDAY";
  if (index === 4) return "THURSDAY";
  if (index === 5) return "FRIDAY";
  if (index === 6) return "SATURDAY";
  return null;
}

function toLocalDate(value: string, timezone: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year === undefined || month === undefined || day === undefined
    ? null
    : `${year}-${month}-${day}`;
}

function normalizeOptional(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
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
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function formatValidYmd(
  year: number,
  month: number,
  day: number,
): string | null {
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
