import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import {
  formatDeliveryDayLabel,
  formatDiagnosticPathLabel,
  formatBlockerReason,
  formatMethodLabel,
  formatOperationalStatus,
  getRouteRepairPrompt,
  ORDERS_TABLE_COLUMN_COUNT,
  OrderTable,
} from "../src/pages/OrdersPage";
import { orderBlockerLabels, orderFieldLabels } from "../src/i18n";
import type {
  CanonicalOrderDto,
  DeliveryMetadataDiagnosticsDto,
} from "../src/types";

describe("Orders compact operations table", () => {
  test("renders the approved Phase A semantic columns without fake Phase B data", () => {
    const html = renderOrderTable([orderFixture()]);

    expect(html).toContain('class="orders-compact-table"');
    expect(html).toContain(`data-column-count="${ORDERS_TABLE_COLUMN_COUNT}"`);
    for (const header of [
      "Select",
      "Order",
      "Customer",
      "Method",
      "Day",
      "Area",
      "Route",
      "Status",
      "Actions",
    ]) {
      expect(html).toContain(`>${header}</th>`);
    }
    expect(html).not.toContain("Items");
    expect(html).not.toContain("Total");
    expect(html).not.toContain("EasyRoutes");
    expect(html).not.toContain("Sync");
  });

  test("renders operational order data from current CanonicalOrderDto fields", () => {
    const html = renderOrderTable([orderFixture()]);

    expect(html).toContain("#11453");
    expect(html).toContain("WOO · 11453");
    expect(html).toContain("Tomato Buyer");
    expect(html).toContain("416-555-0100");
    expect(html).toContain("Evening Delivery");
    expect(html).toContain("FRI5PM");
    expect(html).toContain("2026-05-29 · 5PM–9PM");
    expect(html).toContain("Toronto West");
    expect(html).toContain("Ready");
    expect(html).toContain("Detail");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="order-detail-order-11453"');
    expect(html).not.toContain("Diagnostics");
    expect(html).not.toContain("Route eligible");
  });

  test("keeps selection accessibility and disabled eligibility semantics", () => {
    const blocked = orderFixture({
      blockerReasons: ["missing_delivery_date"],
      deliveryDate: null,
      metadataResolved: false,
      orderId: "blocked-order",
      orderName: "#1002",
      routeEligible: false,
    });
    const html = renderOrderTable([blocked]);

    expect(html).toContain('aria-label="Select order #1002 11453"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('Review');
    expect(html).toContain('Missing delivery date');
  });

  test("allows already-selected non-eligible orders to be removed and spans detail across all columns", () => {
    const blocked = orderFixture({
      blockerReasons: ["missing_coordinates"],
      orderId: "selected-blocked",
      routeEligible: false,
    });
    const html = renderOrderTable([blocked], {
      diagnosticsByOrder: { "selected-blocked": null },
      expandedOrderIds: new Set(["selected-blocked"]),
      selected: new Set(["selected-blocked"]),
    });

    expect(html).toContain('checked=""');
    expect(html).not.toContain('disabled=""');
    expect(html).toContain(`colSpan="${ORDERS_TABLE_COLUMN_COUNT}"`);
    expect(html).toContain("Order details for #11453");
    expect(html).toContain("No saved detail diagnostics yet.");
    expect(html).toContain(
      'aria-label="Remove order #11453 11453 from route plan"',
    );
  });

  test("shows metadata-ok coordinate blockers without a row-level geocode action", () => {
    const missingCoordinates = orderFixture({
      coordinates: { latitude: null, longitude: null },
      geocodeStatus: "PENDING",
      metadataResolved: true,
      routeEligible: false,
    });
    const html = renderOrderTable([missingCoordinates]);

    expect(html).toContain("Need coordinates");
    expect(html).toContain("Geocode shipping address");
    expect(html).toContain("Use bulk geocode");
    expect(html).not.toContain("Geocode &amp; add");
    expect(html).not.toContain("Geocode and add order");
    expect(getRouteRepairPrompt(missingCoordinates)).toEqual({
      canGeocode: true,
      routeDetail: "Need coordinates",
      statusDetail: "Geocode shipping address",
      statusLabel: "Need coordinates",
    });
    expect(formatOperationalStatus(missingCoordinates).label).toBe(
      "Need coordinates",
    );
  });

  test("maps operational status blockers with deterministic user-facing labels", () => {
    expect(
      formatOperationalStatus(
        orderFixture({
          blockerReasons: ["missing_delivery_date"],
          deliveryDate: null,
          metadataResolved: false,
          routeEligible: false,
        }),
      ).label,
    ).toBe("Missing delivery date");
    expect(
      formatOperationalStatus(
        orderFixture({
          blockerReasons: ["missing_delivery_area"],
          metadataResolved: false,
          routeEligible: false,
        }),
      ).label,
    ).toBe("Missing delivery area");
    expect(
      formatOperationalStatus(
        orderFixture({
          blockerReasons: ["missing_route_scope"],
          metadataResolved: false,
          routeEligible: false,
        }),
      ).label,
    ).toBe("Missing route scope");
    expect(
      formatOperationalStatus(
        orderFixture({
          blockerReasons: ["delivery_day_unparsed"],
          metadataResolved: false,
          routeEligible: false,
        }),
      ).label,
    ).toBe("Delivery day unclear");
    expect(
      formatOperationalStatus(
        orderFixture({
          blockerReasons: ["ambiguous_delivery_time_window"],
          metadataResolved: false,
          routeEligible: false,
        }),
      ).label,
    ).toBe("Delivery time unclear");
    expect(
      formatOperationalStatus(
        orderFixture({
          routePlanId: "route-1",
          routePlanName: "Friday Route",
          routeEligible: false,
        }),
      ).label,
    ).toBe("Planned");
    expect(
      formatOperationalStatus(
        orderFixture({
          coordinates: { latitude: null, longitude: null },
          metadataResolved: true,
          routeEligible: false,
          shippingAddress: {
            address1: null,
            address2: null,
            city: null,
            countryCode: null,
            postalCode: null,
            province: null,
          },
        }),
      ).label,
    ).toBe("Missing address");
  });

  test("renders operator detail panel with address, review mode, labels, and hidden raw paths by default", () => {
    const diagnostics: DeliveryMetadataDiagnosticsDto = {
      candidates: [
        {
          parseStatus: "matched",
          path: "meta_data._tomatono_delivery_day",
          valuePreview: "Friday",
          weekday: "FRI",
        },
      ],
      conflictTimeWindows: [],
      conflictWeekdays: [],
      current: {
        deliveryDate: "2026-05-29",
        deliveryDateWeekday: "FRI",
        deliveryDayParseStatus: "matched",
        deliveryWeekday: "FRI",
        rawDeliveryDatePreview: null,
        rawDeliveryDayPreview: "Friday",
        rawDeliveryTimeWindowPreview: null,
        reviewReasons: [],
        routeScopeKey: null,
        serviceType: "EVENING_DELIVERY",
        timeWindowEnd: "21:00",
        timeWindowStart: "17:00",
      },
      matchedMappingPaths: { deliveryDay: "meta_data._tomatono_delivery_day" },
      status: "resolved",
      unsupportedValueCounts: {},
    };
    const html = renderOrderTable([orderFixture()], {
      diagnosticsByOrder: { "order-11453": diagnostics },
      expandedOrderIds: new Set(["order-11453"]),
    });

    expect(html).toContain("Order details for #11453");
    expect(html).toContain("4475 Chesswood Dr");
    expect(html).toContain("Toronto");
    expect(html).toContain("ON");
    expect(html).toContain("M3J 2C3");
    expect(html).toContain("Coordinates available: 43.653200, -79.383200");
    expect(html).toContain("Edit");
    expect(html).not.toContain('name="address1"');
    expect(html).not.toContain("meta_data._tomatono_delivery_day");
    expect(html).toContain("Delivery day");
  });

  test("renders edit mode with supported metadata fields only", () => {
    const html = renderOrderTable([orderFixture()], {
      detailModes: { "order-11453": "edit" },
      expandedOrderIds: new Set(["order-11453"]),
    });

    for (const field of [
      "address1",
      "address2",
      "city",
      "province",
      "postalCode",
      "countryCode",
      "deliveryArea",
      "deliveryDate",
      "serviceType",
      "deliverySession",
      "timeWindowStart",
      "timeWindowEnd",
    ]) {
      expect(html).toContain(`name="${field}"`);
    }
    expect(html).toContain("Save");
    expect(html).toContain("Cancel");
  });

  test("centralizes order i18n labels and avoids raw fallback labels", () => {
    expect(orderFieldLabels["meta_data._tomatono_delivery_day"]).toBe(
      "Delivery day",
    );
    expect(orderFieldLabels["shipping_lines[0].method_title"]).toBe(
      "Shipping method",
    );
    expect(orderFieldLabels["line_items[0].name"]).toBe("Ordered items");
    expect(orderBlockerLabels.missing_delivery_date).toBe(
      "Missing delivery date",
    );
    expect(orderBlockerLabels.missing_coordinates).toBe("Need coordinates");
  });

  test("empty state remains inside the compact table vocabulary", () => {
    const html = renderOrderTable([]);

    expect(html).toContain("No imported orders match the current filters.");
    expect(html).toContain(`colSpan="${ORDERS_TABLE_COLUMN_COUNT}"`);
  });

  test("renders one bulk geocode control near the order count badge", () => {
    const html = renderOrderTable([orderFixture()], {
      bulkGeocodeStatus:
        "Bulk geocode Completed: 2 attempted, 1 resolved, 1 failed.",
    });

    expect(html).toContain("1 orders");
    expect(html).toContain("Bulk geocode missing");
    expect(html).toContain("Bulk geocode Completed");
    expect(html).not.toContain("Geocode &amp; add");
  });

  test("formatter precedence uses service type for Method and delivery date for Day", () => {
    const order = orderFixture({
      deliverySession: "MORNING_DELIVERY",
      serviceType: "EVENING_DELIVERY",
      timeWindowStart: "08:30",
      timeWindowEnd: "11:00",
    });

    expect(formatMethodLabel(order)).toBe("Evening Delivery");
    expect(formatDeliveryDayLabel(order)).toEqual({
      detail: "2026-05-29 · 8:30AM–11AM",
      label: "FRI8:30AM",
      toneClass: "order-pill--day",
    });
    expect(formatOperationalStatus(order).label).toBe("Ready");
    expect(
      formatDeliveryDayLabel(orderFixture({ deliveryDate: null })).label,
    ).toBe("Review");
  });

  test("method formatter never guesses from address/date fields", () => {
    expect(
      formatMethodLabel(
        orderFixture({
          deliverySession: "MORNING_DELIVERY",
          serviceType: null,
        }),
      ),
    ).toBe("Morning Delivery");
    expect(
      formatMethodLabel(
        orderFixture({
          deliveryArea: "Toronto West",
          deliveryDate: "2026-05-29",
          deliverySession: null,
          serviceType: null,
          shippingAddress: {
            address1: "4475 Chesswood Dr",
            address2: null,
            city: "Toronto",
            countryCode: "CA",
            postalCode: "M3J 2C3",
            province: "ON",
          },
        }),
      ),
    ).toBe("—");
  });
});

function renderOrderTable(
  orders: CanonicalOrderDto[],
  options: {
    bulkGeocodeStatus?: string;
    detailModes?: Record<string, "review" | "edit">;
    diagnosticsByOrder?: Record<string, DeliveryMetadataDiagnosticsDto | null>;
    expandedOrderIds?: Set<string>;
    selected?: Set<string>;
  } = {},
): string {
  return renderToStaticMarkup(
    <OrderTable
      bulkGeocodeStatus={options.bulkGeocodeStatus}
      detailModes={options.detailModes}
      diagnosticsByOrder={options.diagnosticsByOrder ?? {}}
      expandedOrderIds={options.expandedOrderIds}
      loading={false}
      onBulkGeocode={() => undefined}
      onToggleDetail={() => undefined}
      onTogglePlanOrder={() => undefined}
      orders={orders}
      selected={options.selected ?? new Set()}
      setSelected={() => undefined}
    />,
  );
}

function orderFixture(
  overrides: Partial<CanonicalOrderDto> = {},
): CanonicalOrderDto {
  return {
    blockerReasons: [],
    coordinates: { latitude: 43.6532, longitude: -79.3832 },
    deliveryArea: "Toronto West",
    deliveryDate: "2026-05-29",
    deliverySession: "EVENING_DELIVERY",
    deliveryStatus: "ready",
    geocodeStatus: "RESOLVED",
    health: "normal",
    metadataResolved: true,
    orderId: "order-11453",
    orderName: "#11453",
    phone: "416-555-0100",
    planningStatus: "UNPLANNED",
    recipientName: "Tomato Buyer",
    routeEligible: true,
    routePlanId: null,
    routePlanName: null,
    serviceType: "EVENING_DELIVERY",
    shippingAddress: {
      address1: "4475 Chesswood Dr",
      address2: null,
      city: "Toronto",
      countryCode: "CA",
      postalCode: "M3J 2C3",
      province: "ON",
    },
    sourceOrderId: "gid://woo/11453",
    sourceOrderNumber: "11453",
    sourcePlatform: "WOO",
    status: "open",
    stopId: null,
    timeWindowEnd: "21:00",
    timeWindowStart: "17:00",
    ...overrides,
  };
}

function diagnosticsFixture(): DeliveryMetadataDiagnosticsDto {
  return {
    candidates: [
      {
        parseStatus: "parsed",
        path: "meta_data._tomatono_delivery_day",
        valuePreview: "FRI5PM",
      },
      {
        parseStatus: "parsed",
        path: "shipping_lines[0].method_title",
        valuePreview: "Evening Delivery",
      },
    ],
    conflictTimeWindows: [],
    conflictWeekdays: [],
    current: {
      deliveryDate: "2026-05-29",
      deliveryDateWeekday: "FRI",
      deliveryDayParseStatus: "parsed",
      deliveryWeekday: "FRI",
      rawDeliveryDatePreview: null,
      rawDeliveryDayPreview: "FRI5PM",
      rawDeliveryTimeWindowPreview: "5PM-9PM",
      reviewReasons: [],
      routeScopeKey: "evening",
      serviceType: "EVENING_DELIVERY",
      timeWindowEnd: "21:00",
      timeWindowStart: "17:00",
    },
    matchedMappingPaths: { deliveryDay: "meta_data._tomatono_delivery_day" },
    status: "resolved",
    unsupportedValueCounts: {},
  };
}
