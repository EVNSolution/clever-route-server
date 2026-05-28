import { describe, expect, test } from "vitest";

import {
  calculateDeliveryScope,
  parseDeliveryTimeWindow,
} from "../src/modules/shopify/order-delivery-scope.js";

describe("calculateDeliveryScope", () => {
  test.each([
    [
      "Monday",
      "MONDAY",
      "2026-05-18",
      "2026-05-18",
      "2026-05-31",
      "DAY",
      "DELIVERY",
    ],
    [
      "Tuesday",
      "TUESDAY",
      "2026-05-19",
      "2026-05-18",
      "2026-05-31",
      "DAY",
      "DELIVERY",
    ],
    [
      "Wednesday",
      "WEDNESDAY",
      "2026-05-20",
      "2026-05-18",
      "2026-05-31",
      "DAY",
      "DELIVERY",
    ],
    [
      "Thursday",
      "THURSDAY",
      "2026-05-07",
      "2026-05-07",
      "2026-05-09",
      "DAY",
      "DELIVERY",
    ],
    [
      "Friday",
      "FRIDAY",
      "2026-05-08",
      "2026-05-07",
      "2026-05-09",
      "DAY",
      "DELIVERY",
    ],
    [
      "Saturday",
      "SATURDAY",
      "2026-05-09",
      "2026-05-07",
      "2026-05-09",
      "DAY",
      "DELIVERY",
    ],
    [
      "Sunday",
      "SUNDAY",
      "2026-05-24",
      "2026-05-18",
      "2026-05-31",
      "DAY",
      "DELIVERY",
    ],
  ] as const)(
    "uses line item range for %s delivery scope",
    (
      deliveryDayRaw,
      weekday,
      deliveryDate,
      batchStartDate,
      batchEndDate,
      session,
      serviceType,
    ) => {
      const lineItemTitle =
        deliveryDayRaw === "Thursday" ||
        deliveryDayRaw === "Friday" ||
        deliveryDayRaw === "Saturday"
          ? "Tomatono menu 5/7-5/9"
          : "Tomatono daily menu 2026.05.18-05.31";
      const scope = calculateDeliveryScope({
        createdAt: "2026-05-05T14:00:00Z",
        deliveryArea: "Thornhill",
        deliveryDayRaw,
        lineItems: [{ title: lineItemTitle }],
        pickupDayRaw: null,
        processedAt: null,
      });

      expect(scope).toEqual(
        expect.objectContaining({
          deliveryBatchEndDate: batchEndDate,
          deliveryBatchStartDate: batchStartDate,
          deliveryDate,
          deliveryDateSource: "LINE_ITEM_DATE_RANGE",
          deliverySession: session,
          deliveryWeekday: weekday,
          planningGroupKey: `${deliveryDate}|${serviceType}|||Thornhill`,
          routeScopeKey: `${deliveryDate}|${serviceType}||`,
          serviceType,
        }),
      );
    },
  );

  test.each([
    ["Thursday Delivery", "THURSDAY", "2026-05-07"],
    ["Delivery - Thursday", "THURSDAY", "2026-05-07"],
    ["Thu", "THURSDAY", "2026-05-07"],
    ["Fri", "FRIDAY", "2026-05-08"],
    ["Sat", "SATURDAY", "2026-05-09"],
    ["목요일", "THURSDAY", "2026-05-07"],
    ["목", "THURSDAY", "2026-05-07"],
    ["금요일", "FRIDAY", "2026-05-08"],
    ["토요일", "SATURDAY", "2026-05-09"],
  ] as const)(
    "parses tolerant Woo weekday label %s",
    (deliveryDayRaw, weekday, deliveryDate) => {
      const scope = calculateDeliveryScope({
        createdAt: "2026-05-05T14:00:00Z",
        deliveryArea: "Thornhill",
        deliveryDayRaw,
        lineItems: [{ title: "Bundle 05/07-05/09" }],
        pickupDayRaw: null,
        processedAt: null,
      });

      expect(scope).toEqual(
        expect.objectContaining({
          deliveryDate,
          deliveryWeekday: weekday,
          routeScopeKey: `${deliveryDate}|DELIVERY||`,
        }),
      );
    },
  );

  test("does not infer a date from generic local delivery text", () => {
    const scope = calculateDeliveryScope({
      createdAt: "2026-05-05T14:00:00Z",
      deliveryArea: "Thornhill",
      deliveryDayRaw: "Local delivery",
      lineItems: [{ title: "Bundle 05/07-05/09" }],
      pickupDayRaw: null,
      processedAt: null,
    });

    expect(scope).toEqual(
      expect.objectContaining({
        deliveryDate: null,
        routeScopeKey: null,
        serviceType: null,
      }),
    );
  });

  test("keeps Friday evening as a distinct route scope from Friday day delivery", () => {
    const scope = calculateDeliveryScope({
      createdAt: "2026-05-05T14:00:00Z",
      deliveryArea: "Thornhill",
      deliveryDayRaw: "Friday 5pm to 9pm *Check delivery map",
      lineItems: [{ title: "Bundle 05/07-05/09" }],
      pickupDayRaw: null,
      processedAt: null,
    });

    expect(scope).toEqual(
      expect.objectContaining({
        deliveryDate: "2026-05-08",
        deliverySession: "EVENING",
        deliveryWeekday: "FRIDAY",
        routeScopeKey: "2026-05-08|EVENING_DELIVERY|17:00|21:00",
        planningGroupKey: "2026-05-08|EVENING_DELIVERY|17:00|21:00|Thornhill",
        serviceType: "EVENING_DELIVERY",
        timeWindowEnd: "21:00",
        timeWindowStart: "17:00",
      }),
    );
  });

  test.each([
    [
      "Thursday 17:00-21:00",
      "THURSDAY",
      "2026-05-07",
      "EVENING",
      "EVENING_DELIVERY",
      "17:00",
      "21:00",
    ],
    [
      "Delivery Friday 5-9pm",
      "FRIDAY",
      "2026-05-08",
      "EVENING",
      "EVENING_DELIVERY",
      "17:00",
      "21:00",
    ],
    [
      "금요일 오후 5시~9시",
      "FRIDAY",
      "2026-05-08",
      "EVENING",
      "EVENING_DELIVERY",
      "17:00",
      "21:00",
    ],
    [
      "Thursday 11am-3pm",
      "THURSDAY",
      "2026-05-07",
      "DAY",
      "DELIVERY",
      "11:00",
      "15:00",
    ],
  ] as const)(
    "normalizes delivery time window from %s",
    (
      deliveryDayRaw,
      weekday,
      deliveryDate,
      deliverySession,
      serviceType,
      timeWindowStart,
      timeWindowEnd,
    ) => {
      const scope = calculateDeliveryScope({
        createdAt: "2026-05-05T14:00:00Z",
        deliveryArea: "Thornhill",
        deliveryDayRaw,
        lineItems: [{ title: "Bundle 05/07-05/09" }],
        pickupDayRaw: null,
        processedAt: null,
      });

      expect(scope).toEqual(
        expect.objectContaining({
          deliveryDate,
          deliverySession,
          deliveryWeekday: weekday,
          routeScopeKey: `${deliveryDate}|${serviceType}|${timeWindowStart}|${timeWindowEnd}`,
          serviceType,
          timeWindowEnd,
          timeWindowStart,
        }),
      );
    },
  );

  test("parses a time window without treating it as a delivery day", () => {
    const timeWindow = parseDeliveryTimeWindow("Delivery Time = 5pm-9pm");
    const scope = calculateDeliveryScope({
      createdAt: "2026-05-05T14:00:00Z",
      deliveryArea: "Thornhill",
      deliveryDayRaw: "5pm-9pm",
      deliveryTimeWindow: timeWindow,
      lineItems: [{ title: "Bundle 05/07-05/09" }],
      pickupDayRaw: null,
      processedAt: null,
    });

    expect(timeWindow).toEqual(
      expect.objectContaining({
        deliverySession: "EVENING",
        serviceType: "EVENING_DELIVERY",
        timeWindowEnd: "21:00",
        timeWindowStart: "17:00",
      }),
    );
    expect(scope).toEqual(
      expect.objectContaining({
        deliveryDate: null,
        deliveryWeekday: null,
        routeScopeKey: null,
        timeWindowEnd: "21:00",
        timeWindowStart: "17:00",
      }),
    );
  });

  test.each([
    "416-555-0101",
    "Order #11388",
    "$5-9",
    "4475 Chesswood Dr, M3J 2C3",
    "22:00-06:00",
  ])("does not parse non-delivery or invalid time text %s", (value) => {
    expect(parseDeliveryTimeWindow(value)).toEqual(
      expect.objectContaining({
        ambiguous: false,
        timeWindowEnd: null,
        timeWindowStart: null,
      }),
    );
  });

  test("flags explicit delivery dates whose weekday disagrees with the Woo day value", () => {
    const scope = calculateDeliveryScope({
      createdAt: "2026-05-05T14:00:00Z",
      deliveryArea: "Thornhill",
      deliveryDateRaw: "2026-05-21",
      deliveryDayRaw: "Friday",
      lineItems: [{ title: "Bundle 05/18-05/31" }],
      pickupDayRaw: null,
      processedAt: null,
    });

    expect(scope).toEqual(
      expect.objectContaining({
        deliveryDate: "2026-05-21",
        deliveryDateSource: "EXPLICIT_ATTRIBUTE",
        deliveryDateWeekday: "THURSDAY",
        deliveryDateWeekdayMismatch: true,
        deliveryWeekday: "FRIDAY",
        routeScopeKey: "2026-05-21|DELIVERY||",
      }),
    );
  });

  test("falls back to order-date cycle when no line item date range exists", () => {
    const scope = calculateDeliveryScope({
      createdAt: "2026-05-05T14:00:00Z",
      deliveryArea: "North York",
      deliveryDayRaw: "Friday",
      lineItems: [],
      pickupDayRaw: null,
      processedAt: null,
    });

    expect(scope).toEqual(
      expect.objectContaining({
        orderDateLocal: "2026-05-05",
        deliveryBatchStartDate: "2026-05-14",
        deliveryBatchEndDate: "2026-05-16",
        deliveryDate: "2026-05-15",
        deliveryDateSource: "ORDER_DATE_CYCLE_RULE",
        routeScopeKey: "2026-05-15|DELIVERY||",
      }),
    );
  });

  test("returns missing source when delivery date cannot be derived", () => {
    const scope = calculateDeliveryScope({
      createdAt: null,
      deliveryArea: "Thornhill",
      deliveryDayRaw: "Friday",
      lineItems: [],
      pickupDayRaw: null,
      processedAt: null,
    });

    expect(scope).toEqual(
      expect.objectContaining({
        deliveryDate: null,
        deliveryDateSource: "MISSING",
        routeScopeKey: null,
      }),
    );
  });
});
