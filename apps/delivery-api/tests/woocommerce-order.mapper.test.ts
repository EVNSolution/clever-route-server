import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

import { mapWooCommerceOrderToDeliveryInputs } from "../src/modules/woocommerce/woocommerce-order.mapper.js";
import type { WooCommerceOrder } from "../src/modules/woocommerce/woocommerce-order.types.js";

const fixtureBase = new URL("./fixtures/woocommerce/", import.meta.url);

async function readFixture(name: string): Promise<WooCommerceOrder> {
  return JSON.parse(
    await readFile(new URL(name, fixtureBase), "utf8"),
  ) as WooCommerceOrder;
}

describe("mapWooCommerceOrderToDeliveryInputs", () => {
  test("maps WooCommerce orders to canonical delivery inputs using standard fields and date metadata", async () => {
    const order = await readFixture("order-delivery-date-meta.json");

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, {
      siteUrl: "https://woo.example.test",
    });

    expect(mapped.order).toEqual(
      expect.objectContaining({
        currencyCode: "CAD",
        deliveryArea: "Markham",
        deliveryDate: "2026-05-21",
        deliveryDateSource: "EXPLICIT_ATTRIBUTE",
        email: "hana@example.test",
        fulfillmentStatus: "PROCESSING",
        name: "#11388",
        phone: "+14165550101",
        readiness: "READY_TO_PLAN",
        reviewReasons: [],
        shopifyOrderGid: "woocommerce://woo.example.test/orders/11388",
        shopifyOrderLegacyId: null,
        sourceOrderId: "11388",
        sourceOrderNumber: "11388",
        sourcePlatform: "WOOCOMMERCE",
        sourceSiteUrl: "https://woo.example.test",
        sourceUpdatedAt: new Date("2026-05-19T20:06:34.000Z"),
        totalPriceAmount: "54.25",
        updatedAtShopify: new Date("2026-05-19T20:06:34.000Z"),
      }),
    );
    expect(mapped.deliveryStop).toEqual(
      expect.objectContaining({
        address1: "100 Synthetic Ave",
        city: "Markham",
        countryCode: "CA",
        deliveryDate: "2026-05-21",
        geocodeStatus: "PENDING",
        phone: "+14165550101",
        postalCode: "L3R 0A1",
        province: "ON",
        recipientName: "Hana Kim",
      }),
    );
    expect(mapped.order.rawPayload.sourcePlatform).toBe("WOOCOMMERCE");
    expect(mapped.order.rawPayload.metadataKeys).toEqual(
      expect.arrayContaining(["delivery_date", "delivery_area"]),
    );
  });

  test("keeps missing delivery date explicit instead of silently treating an order as ready", async () => {
    const order = await readFixture("order-date-pending.json");

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, {
      siteUrl: "woo.example.test",
    });

    expect(mapped.order.deliveryDate).toBeNull();
    expect(mapped.order.deliveryDateSource).toBe("MISSING");
    expect(mapped.order.readiness).toBe("NEEDS_REVIEW");
    expect(mapped.order.reviewReasons).toContain("missing_delivery_date");
    expect(mapped.order.reviewReasons).toContain("missing_route_scope");
    expect(mapped.deliveryStop?.deliveryDate).toBeNull();
  });

  test("marks cancelled-like WooCommerce statuses as not route-ready", async () => {
    const order = await readFixture("order-cancelled.json");

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, {
      siteUrl: "https://woo.example.test/",
    });

    expect(mapped.order.cancelledAt).toEqual(
      new Date("2026-05-19T20:06:35.000Z"),
    );
    expect(mapped.order.readiness).toBe("NEEDS_REVIEW");
    expect(mapped.order.reviewReasons).toContain(
      "non_deliverable_status:cancelled",
    );
  });

  test("flags Woo delivery date and delivery day mismatches for metadata review", async () => {
    const order = await readFixture("order-delivery-date-meta.json");
    order.meta_data = [
      { key: "delivery_date", value: "2026-05-21" },
      { key: "delivery_day", value: "Friday" },
      { key: "delivery_area", value: "Markham" },
    ];

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, {
      siteUrl: "https://woo.example.test",
    });

    expect(mapped.order.deliveryDate).toBe("2026-05-21");
    expect(mapped.order.deliveryWeekday).toBe("FRIDAY");
    expect(mapped.order.readiness).toBe("NEEDS_REVIEW");
    expect(mapped.order.reviewReasons).toContain(
      "delivery_date_weekday_mismatch",
    );
    expect(mapped.order.rawPayload).toEqual(
      expect.objectContaining({
        deliveryDateWeekday: "THURSDAY",
        deliveryDateWeekdayMismatch: true,
      }),
    );
  });

  test("blocks raw Woo day/time values that are present but cannot be parsed", async () => {
    const order = await readFixture("order-delivery-date-meta.json");
    order.meta_data = [
      { key: "delivery_date", value: "2026-05-21" },
      { key: "delivery_day", value: "rush window unknown" },
      { key: "delivery_area", value: "Markham" },
    ];

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, {
      connectionId: "8b57ab89-3fe7-4a62-b1f4-b6dbb26ef3ea",
      siteUrl: "https://woo.example.test",
    });

    expect(mapped.order.readiness).toBe("NEEDS_REVIEW");
    expect(mapped.order.reviewReasons).toContain("delivery_day_unparsed");
    expect(mapped.order.rawPayload).toEqual(
      expect.objectContaining({
        deliveryDayParseStatus: "UNPARSED",
        deliveryDayUnparsedReason: "unrecognized_woo_delivery_day_or_time",
      }),
    );
    expect(mapped.deliveryFact).toEqual(
      expect.objectContaining({
        commerceConnectionId: "8b57ab89-3fe7-4a62-b1f4-b6dbb26ef3ea",
        deliveryDateWeekdayVerified: false,
        deliveryDayParseStatus: "UNPARSED",
        readiness: "NEEDS_REVIEW",
        reviewReasons: expect.arrayContaining([
          "delivery_day_unparsed",
        ]) as unknown,
      }),
    );
  });

  test("reads configured line-item and shipping-line metadata with mapping diagnostics", async () => {
    const order = await readFixture("order-date-pending.json");
    order.line_items = [
      {
        name: "Delivery product",
        quantity: 1,
        meta_data: [
          { key: "jckwds_date", value: "2026-05-21" },
          { key: "nested_debug", value: { unexpected: true } },
        ],
      },
    ];
    order.shipping_lines = [
      {
        method_title: "Thursday Delivery",
        meta_data: [{ key: "delivery_area", value: "Scarborough" }],
      },
    ];

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, {
      mappingConfig: {
        areaPaths: ["shipping_lines.meta_data.delivery_area"],
        datePaths: ["line_items.meta_data.jckwds_date"],
        dayPaths: ["shipping_lines.method_title"],
      },
      siteUrl: "https://woo.example.test",
    });

    expect(mapped.order.deliveryArea).toBe("Scarborough");
    expect(mapped.order.deliveryDate).toBe("2026-05-21");
    expect(mapped.order.deliveryDayRaw).toBe("Thursday Delivery");
    expect(mapped.order.rawPayload.matchedMappingPaths).toEqual(
      expect.objectContaining({
        deliveryArea: "shipping_lines[0].meta_data.delivery_area",
        deliveryDate: "line_items[0].meta_data.jckwds_date",
        deliveryDay: "shipping_lines[0].method_title",
      }),
    );
    expect(mapped.order.rawPayload.mappingDiagnostics).toEqual(
      expect.objectContaining({
        unsupportedValues: expect.arrayContaining([
          expect.objectContaining({
            path: "line_items[0].meta_data.nested_debug",
            type: "object",
          }),
        ]) as unknown,
      }),
    );
  });

  test("uses all-candidate Woo metadata to resolve shipping title weekdays safely", async () => {
    const order = await readFixture("order-date-pending.json");
    order.meta_data = [{ key: "delivery_area", value: "Scarborough" }];
    order.shipping_lines = [
      { method_title: "Delivery - Thursday", meta_data: [] },
    ];

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, {
      siteUrl: "https://woo.example.test",
    });

    expect(mapped.order).toEqual(
      expect.objectContaining({
        deliveryDate: "2026-05-28",
        deliveryDayRaw: "Delivery - Thursday",
        readiness: "READY_TO_PLAN",
        reviewReasons: [],
      }),
    );
    expect(mapped.deliveryFact?.mappingDiagnostics?.deliveryMetadata).toEqual(
      expect.objectContaining({
        candidateCount: 1,
        status: "RESOLVED",
      }),
    );
  });

  test("keeps conflicting Woo weekday candidates in review with redacted diagnostics", async () => {
    const order = await readFixture("order-date-pending.json");
    order.meta_data = [
      { key: "delivery_area", value: "Scarborough" },
      { key: "delivery_day", value: "Thursday" },
    ];
    order.shipping_lines = [{ method_title: "Friday Delivery", meta_data: [] }];

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, {
      siteUrl: "https://woo.example.test",
    });

    expect(mapped.order.readiness).toBe("NEEDS_REVIEW");
    expect(mapped.order.deliveryDate).toBeNull();
    expect(mapped.order.reviewReasons).toEqual(
      expect.arrayContaining([
        "ambiguous_delivery_day",
        "missing_delivery_date",
        "missing_route_scope",
      ]),
    );
    expect(mapped.deliveryFact).toEqual(
      expect.objectContaining({
        deliveryDayParseStatus: "UNVERIFIED",
        rawDeliveryDay: "Thursday",
        readiness: "NEEDS_REVIEW",
      }),
    );
    expect(mapped.deliveryFact?.mappingDiagnostics?.deliveryMetadata).toEqual(
      expect.objectContaining({
        conflictWeekdays: expect.arrayContaining([
          "THURSDAY",
          "FRIDAY",
        ]) as unknown,
        status: "NEEDS_REVIEW",
      }),
    );
    expect(
      JSON.stringify(mapped.deliveryFact?.mappingDiagnostics),
    ).not.toContain("rawPayload");
  });

  test("records generic Local delivery as unparsed without fabricating a date", async () => {
    const order = await readFixture("order-date-pending.json");
    order.meta_data = [{ key: "delivery_area", value: "Scarborough" }];
    order.shipping_lines = [{ method_title: "Local delivery", meta_data: [] }];

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, {
      siteUrl: "https://woo.example.test",
    });

    expect(mapped.order.deliveryDate).toBeNull();
    expect(mapped.order.readiness).toBe("NEEDS_REVIEW");
    expect(mapped.order.reviewReasons).toEqual(
      expect.arrayContaining([
        "delivery_day_unparsed",
        "missing_delivery_date",
      ]),
    );
    expect(mapped.deliveryFact?.mappingDiagnostics?.deliveryMetadata).toEqual(
      expect.objectContaining({
        candidates: expect.arrayContaining([
          expect.objectContaining({
            parseStatus: "UNPARSED",
            valuePreview: "Local delivery",
          }),
        ]) as unknown,
        status: "NEEDS_REVIEW",
      }),
    );
  });

  test("parses Korean Woo weekday metadata", async () => {
    const order = await readFixture("order-date-pending.json");
    order.meta_data = [
      { key: "delivery_area", value: "Scarborough" },
      { key: "delivery_day", value: "목요일" },
    ];

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, {
      siteUrl: "https://woo.example.test",
    });

    expect(mapped.order).toEqual(
      expect.objectContaining({
        deliveryDate: "2026-05-28",
        deliveryWeekday: "THURSDAY",
        readiness: "READY_TO_PLAN",
      }),
    );
  });

  test("combines separate Woo delivery day and delivery time fields into one typed route scope", async () => {
    const order = await readFixture("order-date-pending.json");
    order.meta_data = [
      { key: "delivery_area", value: "Scarborough" },
      { key: "Delivery Day", value: "Friday" },
      { key: "Delivery Time", value: "5pm-9pm" },
    ];

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, {
      siteUrl: "https://woo.example.test",
    });

    expect(mapped.order).toEqual(
      expect.objectContaining({
        deliveryDate: "2026-05-29",
        deliveryDayRaw: "Friday",
        deliverySession: "EVENING",
        deliveryWeekday: "FRIDAY",
        readiness: "READY_TO_PLAN",
        routeScopeKey: "2026-05-29|EVENING_DELIVERY|17:00|21:00",
        serviceType: "EVENING_DELIVERY",
        timeWindowEnd: "21:00",
        timeWindowStart: "17:00",
      }),
    );
    expect(mapped.deliveryFact).toEqual(
      expect.objectContaining({
        rawDeliveryDay: "Friday",
        rawDeliveryTimeWindow: "5pm-9pm",
        timeWindowEnd: "21:00",
        timeWindowStart: "17:00",
      }),
    );
    expect(mapped.deliveryFact?.matchedMappingPaths).toEqual(
      expect.objectContaining({
        deliveryDay: "meta_data.delivery_day",
        deliveryTimeWindow: "meta_data.delivery_time",
      }),
    );
    expect(mapped.deliveryFact?.mappingDiagnostics?.deliveryMetadata).toEqual(
      expect.objectContaining({
        conflictTimeWindows: ["17:00|21:00"],
        status: "RESOLVED",
      }),
    );
  });

  test("blocks explicit Woo delivery time fields that are present but cannot be parsed", async () => {
    const order = await readFixture("order-date-pending.json");
    order.meta_data = [
      { key: "delivery_area", value: "Scarborough" },
      { key: "Delivery Day", value: "Friday" },
      { key: "Delivery Time", value: "rush window unknown" },
    ];

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, {
      siteUrl: "https://woo.example.test",
    });

    expect(mapped.order).toEqual(
      expect.objectContaining({
        deliveryDate: "2026-05-29",
        deliveryDayRaw: "Friday",
        readiness: "NEEDS_REVIEW",
        routeScopeKey: "2026-05-29|DELIVERY||",
      }),
    );
    expect(mapped.order.reviewReasons).toEqual(
      expect.arrayContaining(["delivery_time_window_unparsed"]),
    );
    expect(mapped.deliveryFact).toEqual(
      expect.objectContaining({
        deliveryDayParseStatus: "PARSED",
        rawDeliveryTimeWindow: "rush window unknown",
        readiness: "NEEDS_REVIEW",
      }),
    );
    expect(mapped.deliveryFact?.mappingDiagnostics?.deliveryMetadata).toEqual(
      expect.objectContaining({
        candidates: expect.arrayContaining([
          expect.objectContaining({
            parseStatus: "UNPARSED",
            path: "meta_data.delivery_time",
            valuePreview: "rush window unknown",
          }),
        ]) as unknown,
        status: "NEEDS_REVIEW",
      }),
    );
  });

  test("redacts configured sensitive Woo metadata paths from diagnostics", async () => {
    const order = await readFixture("order-date-pending.json");
    order.meta_data = [
      { key: "delivery_area", value: "Scarborough" },
      { key: "delivery_day", value: "Friday" },
      { key: "consumer_secret", value: "bare-secret-value" },
    ];

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, {
      mappingConfig: { timeWindowPaths: ["consumer_secret"] },
      siteUrl: "https://woo.example.test",
    });

    expect(JSON.stringify(mapped.deliveryFact?.mappingDiagnostics)).toContain(
      "[redacted-secret]",
    );
    expect(JSON.stringify(mapped.deliveryFact?.mappingDiagnostics)).not.toContain(
      "bare-secret-value",
    );
    expect(mapped.order.reviewReasons).toEqual(
      expect.arrayContaining(["delivery_time_window_unparsed"]),
    );
  });

  test("normalizes Korean weekday and time-window metadata", async () => {
    const order = await readFixture("order-date-pending.json");
    order.meta_data = [
      { key: "delivery_area", value: "Scarborough" },
      { key: "delivery_day", value: "금요일 오후 5시~9시" },
    ];

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, {
      siteUrl: "https://woo.example.test",
    });

    expect(mapped.order).toEqual(
      expect.objectContaining({
        deliveryDate: "2026-05-29",
        deliverySession: "EVENING",
        routeScopeKey: "2026-05-29|EVENING_DELIVERY|17:00|21:00",
        serviceType: "EVENING_DELIVERY",
        timeWindowEnd: "21:00",
        timeWindowStart: "17:00",
      }),
    );
  });

  test("accepts duplicate Woo time windows and records both diagnostic paths", async () => {
    const order = await readFixture("order-date-pending.json");
    order.meta_data = [
      { key: "delivery_area", value: "Scarborough" },
      { key: "delivery_day", value: "Thursday" },
      { key: "delivery_time", value: "5pm-9pm" },
    ];
    order.shipping_lines = [
      { method_title: "Thursday 17:00-21:00 delivery", meta_data: [] },
    ];

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, {
      siteUrl: "https://woo.example.test",
    });

    expect(mapped.order).toEqual(
      expect.objectContaining({
        deliveryDate: "2026-05-28",
        readiness: "READY_TO_PLAN",
        routeScopeKey: "2026-05-28|EVENING_DELIVERY|17:00|21:00",
      }),
    );
    const diagnostics = mapped.deliveryFact?.mappingDiagnostics
      ?.deliveryMetadata as {
      candidates: Array<{ path: string; timeWindowStart: string | null }>;
      conflictTimeWindows: string[];
    };
    expect(diagnostics.conflictTimeWindows).toEqual(["17:00|21:00"]);
    expect(
      diagnostics.candidates.filter(
        (candidate) => candidate.timeWindowStart === "17:00",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "meta_data.delivery_time" }),
        expect.objectContaining({ path: "shipping_lines[0].method_title" }),
      ]),
    );
  });

  test("keeps conflicting Woo time windows in review", async () => {
    const order = await readFixture("order-date-pending.json");
    order.meta_data = [
      { key: "delivery_area", value: "Scarborough" },
      { key: "delivery_day", value: "Thursday" },
      { key: "delivery_time", value: "5pm-9pm" },
    ];
    order.shipping_lines = [
      { method_title: "Thursday 11am-3pm delivery", meta_data: [] },
    ];

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, {
      siteUrl: "https://woo.example.test",
    });

    expect(mapped.order).toEqual(
      expect.objectContaining({
        deliveryDate: null,
        readiness: "NEEDS_REVIEW",
        routeScopeKey: null,
      }),
    );
    expect(mapped.order.reviewReasons).toEqual(
      expect.arrayContaining([
        "ambiguous_delivery_time_window",
        "missing_delivery_date",
        "missing_route_scope",
      ]),
    );
    expect(mapped.deliveryFact).toEqual(
      expect.objectContaining({
        deliveryDayParseStatus: "UNVERIFIED",
        rawDeliveryTimeWindow: "5pm-9pm",
        timeWindowEnd: null,
        timeWindowStart: null,
      }),
    );
    expect(mapped.deliveryFact?.mappingDiagnostics?.deliveryMetadata).toEqual(
      expect.objectContaining({
        conflictTimeWindows: expect.arrayContaining([
          "17:00|21:00",
          "11:00|15:00",
        ]) as unknown,
        status: "NEEDS_REVIEW",
      }),
    );
  });

  test("parses time-only Woo metadata without marking delivery metadata resolved", async () => {
    const order = await readFixture("order-date-pending.json");
    order.meta_data = [
      { key: "delivery_area", value: "Scarborough" },
      { key: "delivery_time", value: "11am-3pm" },
    ];

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, {
      siteUrl: "https://woo.example.test",
    });

    expect(mapped.order).toEqual(
      expect.objectContaining({
        deliveryDate: null,
        deliveryDayRaw: null,
        readiness: "NEEDS_REVIEW",
        routeScopeKey: null,
        timeWindowEnd: "15:00",
        timeWindowStart: "11:00",
      }),
    );
    expect(mapped.order.reviewReasons).toEqual(
      expect.arrayContaining(["missing_delivery_date", "missing_route_scope"]),
    );
  });

  test("falls back to billing address when shipping is empty", async () => {
    const order = await readFixture("order-delivery-date-meta.json");
    order.shipping = {
      first_name: "",
      last_name: "",
      address_1: "",
      city: "",
      postcode: "",
      country: "",
    };

    const mapped = mapWooCommerceOrderToDeliveryInputs(order, {
      siteUrl: "https://woo.example.test",
    });

    expect(mapped.deliveryStop).toEqual(
      expect.objectContaining({
        address1: "10 Billing Rd",
        city: "Markham",
        phone: "+14165550101",
        recipientName: "Hana Kim",
      }),
    );
  });
});
