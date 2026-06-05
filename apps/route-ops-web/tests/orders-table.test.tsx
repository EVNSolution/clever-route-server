import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import {
  buildEditableMetadataFields,
  buildRouteDraftSelection,
  getRouteDraftCreateBlocker,
  normalizeOrderMetadataPatchForFields,
  OrderDetailChoiceDropdown,
  formatDeliveryDayLabel,
  formatDiagnosticPathLabel,
  formatBlockerReason,
  formatMethodLabel,
  formatMethodStatusLabel,
  formatOrderReceivedLabel,
  formatOperationalStatus,
  formatPaymentStatusLabel,
  getRouteRepairPrompt,
  ORDERS_TABLE_COLUMN_COUNT,
  OrderTable,
  type OrderMetadataPatch,
} from "../src/pages/OrdersPage";
import {
  getOrderBlockerLabels,
  getOrderFieldLabels,
  orderBlockerLabels,
  orderFieldLabels,
} from "../src/i18n";
import { defaultRouteScopeConfig } from "../src/routeScopeConfig";
import type {
  CanonicalOrderDto,
  DeliveryMetadataDiagnosticsDto,
  StoreSettingsDto,
} from "../src/types";

describe("Orders compact operations table", () => {
  test("renders the approved semantic columns with Route Ops list actions", () => {
    const html = renderOrderTable([orderFixture()]);

    expect(html).toContain('class="orders-compact-table"');
    expect(html).toContain(`data-column-count="${ORDERS_TABLE_COLUMN_COUNT}"`);
    expect(html).toContain(
      'aria-label="Select all eligible orders in current workset"',
    );
    expect(html).toContain("<span>Select</span>");
    for (const header of [
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
    expect(html).toContain("Sync Woo");
    expect(html).toContain("Bulk geocode");
  });

  test("renders operational order data from current CanonicalOrderDto fields", () => {
    const html = renderOrderTable([orderFixture()]);

    expect(html).toContain("#11453");
    expect(html).toContain("order-received-label");
    expect(html).toContain("<span>2026-06-04 THU</span>");
    expect(html).toContain("<span>updated 2026-06-05 FRI</span>");
    expect(html).not.toContain("2026-06-04 THU · updated 2026-06-05 FRI");
    expect(html).toContain("Tomato Buyer");
    expect(html).toContain("416-555-0100");
    expect(html).toContain("Evening Delivery");
    expect(html).toContain("order-pill-stack");
    expect(html).toContain('aria-label="Method Evening Delivery; Payment Transfer pending"');
    expect(html).toContain("order-pill--neutral");
    expect(html).not.toContain("Payment:");
    expect(html).toContain("Transfer pending");
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

  test("formats source-created order labels with localized update markers", () => {
    expect(formatOrderReceivedLabel(orderFixture(), "en-CA")).toBe(
      "2026-06-04 THU\nupdated 2026-06-05 FRI",
    );
    expect(formatOrderReceivedLabel(orderFixture(), "ko-KR")).toBe(
      "2026-06-04 목요일\n수정 2026-06-05 금요일",
    );
    expect(
      formatOrderReceivedLabel(
        orderFixture({ sourceUpdatedDate: "2026-06-04" }),
        "en-CA",
      ),
    ).toBe("2026-06-04 THU");
    expect(
      formatOrderReceivedLabel(
        orderFixture({ sourceCreatedDate: null, sourceUpdatedDate: null }),
        "en-CA",
      ),
    ).toBe("—");
  });

  test("keeps the order table mounted during filter refreshes to avoid scroll jumps", () => {
    const html = renderOrderTable([orderFixture()], {
      loading: true,
      refreshing: true,
    });

    expect(html).toContain('class="orders-compact-table"');
    expect(html).toContain("Updating…");
    expect(html).not.toContain("Loading imported WooCommerce orders…");
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
    const customerCell =
      html.match(/<td class="orders-customer-cell">([\s\S]*?)<\/td>/)?.[1] ??
      "";

    expect(html).toContain('aria-label="Select order #1002 11453"');
    expect(html).toContain('disabled=""');
    expect(customerCell).not.toContain("Review");
    expect(customerCell).not.toContain("order-pill");
    expect(html).toContain("Missing delivery date");
    expect(html).toContain("0 selectable");
    expect(html).toContain("1 unavailable");
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
    expect(html).toMatch(
      /<button aria-label="Remove order #11453 11453 from route plan" class="active" type="button">Remove<\/button>/,
    );
    expect(html).toContain(`colSpan="${ORDERS_TABLE_COLUMN_COUNT}"`);
    expect(html).toContain("Order details for #11453");
    expect(html).toContain("No saved detail diagnostics yet.");
    expect(html).toContain(
      'aria-label="Remove order #11453 11453 from route plan"',
    );
  });

  test("does not make history scope read-only by itself", () => {
    const html = renderOrderTable([orderFixture()], {
      worksetContext: { scope: "history" },
    });

    expect(html).not.toContain("Clear selection");
    expect(html).not.toMatch(/>Clear<\/button>/u);
    expect(html).not.toContain("History scope is read-only");
    expect(html).toContain('aria-label="Add order #11453 11453 to route plan"');
    expect(html).not.toMatch(
      /aria-label="Add order #11453 11453 to route plan"[^>]*disabled/u,
    );
  });

  test("renders normalized payment evidence in the expanded order detail", () => {
    const html = renderOrderTable(
      [
        orderFixture({
          normalizedPaymentReason: "unknown_payment_method_or_status",
          normalizedPaymentStatus: "UNKNOWN_REVIEW",
          paymentMethodFamily: null,
          paymentMethodId: "custom_cash_gateway",
          paymentMethodTitle: "Cash",
          paymentReviewReason: "Payment method/status mapping is not configured",
          wooOrderStatus: "processing",
        }),
      ],
      { expandedOrderIds: new Set(["order-11453"]) },
    );

    expect(html).toContain("Payment");
    expect(html).toContain("Review payment");
    expect(html).toContain("Cash · custom_cash_gateway");
    expect(html).toContain("processing");
    expect(html).toContain("Payment method/status mapping is not configured");
    expect(formatPaymentStatusLabel(orderFixture()).label).toBe("Transfer pending");
  });

  test("renders expanded history-scope order detail as editable when blockers need repair", () => {
    const html = renderOrderTable(
      [
        orderFixture({
          blockerReasons: ["missing_delivery_date", "missing_route_scope"],
          deliveryDate: null,
          deliverySession: null,
          metadataResolved: false,
          routeEligible: false,
          serviceType: null,
        }),
      ],
      {
        expandedOrderIds: new Set(["order-11453"]),
        worksetContext: { scope: "history" },
      },
    );

    expect(html).toContain("Order details for #11453");
    expect(html).toContain(
      "Update the highlighted field, then save this order.",
    );
    expect(html).toContain("Save fixes");
    expect(html).not.toContain("History scope is read-only");
    expect(html).toContain('name="deliveryDate"');
    expect(html).toContain('name="serviceType"');
    expect(html).toContain('name="deliverySession"');
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
    expect(html).toContain("use bulk geocode");
    expect(html).not.toContain("Geocode &amp; add");
    expect(html).not.toContain("Geocode and add order");
    expect(html).not.toContain("Use bulk geocode");
    expect(getRouteRepairPrompt(missingCoordinates)).toEqual({
      canGeocode: true,
      routeDetail: "Need coordinates",
      statusDetail: "use bulk geocode",
      statusLabel: "Need coordinates",
    });
    expect(formatOperationalStatus(missingCoordinates).label).toBe(
      "Need coordinates",
    );
  });

  test("shows exhausted bulk failures as address review instead of bulk geocode guidance", () => {
    const addressReview = orderFixture({
      blockerReasons: ["missing_coordinates"],
      coordinates: { latitude: null, longitude: null },
      geocodeDiagnostics: exhaustedBulkNoResultDiagnostic(),
      geocodeStatus: "FAILED",
      metadataResolved: false,
      orderId: "address-review",
      routeEligible: false,
      shippingAddress: {
        address1: "23 Apple Orchard Path",
        address2: null,
        city: "Thornhill",
        countryCode: "CA",
        postalCode: "L3T 3B5",
        province: "ON",
      },
    });
    const html = renderOrderTable([addressReview], {
      expandedOrderIds: new Set(["address-review"]),
    });

    expect(html).toContain("Address Review");
    expect(html).toContain("Verify address");
    expect(html).toContain("Verify destination address");
    expect(html).toContain('name="address1"');
    expect(html).not.toContain("use bulk geocode");
    expect(html).not.toContain("Use Bulk geocode from the order list.");
    expect(getRouteRepairPrompt(addressReview)).toEqual({
      canGeocode: false,
      routeDetail: "Address Review",
      statusDetail: "Verify address",
      statusLabel: "Address Review",
    });
    expect(formatOperationalStatus(addressReview)).toEqual(
      expect.objectContaining({
        detail: "Verify address",
        label: "Address Review",
        toneClass: "order-pill--review",
      }),
    );
    expect(formatOperationalStatus(addressReview).meaning).toContain(
      "Warning meaning: Bulk geocode already tried",
    );
    expect(html).toContain('role="tooltip"');
  });

  test("separates missing delivery date from delivery date review and explains both on hover", () => {
    const missingDate = orderFixture({
      blockerReasons: ["missing_delivery_date"],
      deliveryDate: null,
      metadataResolved: false,
      orderId: "missing-date",
      routeEligible: false,
    });
    const dateReview = orderFixture({
      blockerReasons: ["delivery_day_unparsed", "missing_delivery_date"],
      deliveryDate: null,
      metadataResolved: false,
      orderId: "date-review",
      routeEligible: false,
    });
    const html = renderOrderTable([missingDate, dateReview], {
      expandedOrderIds: new Set(["date-review"]),
    });

    expect(formatOperationalStatus(missingDate)).toEqual(
      expect.objectContaining({
        detail: null,
        label: "Missing delivery date",
      }),
    );
    expect(formatOperationalStatus(missingDate).meaning).toContain(
      "No delivery date value was found",
    );
    expect(formatOperationalStatus(dateReview)).toEqual(
      expect.objectContaining({
        detail: "Verify delivery date",
        label: "Delivery date review",
      }),
    );
    expect(formatOperationalStatus(dateReview).meaning).toContain(
      "A delivery date hint exists",
    );
    expect(getRouteRepairPrompt(dateReview)).toEqual({
      canGeocode: false,
      routeDetail: "Delivery date review",
      statusDetail: "Verify delivery date",
      statusLabel: "Delivery date review",
    });
    expect(html).toContain("Delivery date review");
    expect(html).toContain("Verify delivery date");
    expect(html).toContain("Warning meaning: A delivery date hint exists");
    expect(html).toContain("Warning meaning: No delivery date value was found");
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
    ).toBe("Delivery date review");
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
    expect(html).toContain("43.653200, -79.383200");
    expect(html).toContain("Ready for the map");
    expect(html).toContain("Edit");
    expect(html).not.toContain('name="address1"');
    expect(html).not.toContain("meta_data._tomatono_delivery_day");
    expect(html).toContain("Delivery day");
  });

  test("renders single-field delivery date repair without unrelated fields", () => {
    const html = renderOrderTable(
      [
        orderFixture({
          blockerReasons: ["missing_delivery_date"],
          deliveryDate: null,
          metadataResolved: false,
          routeEligible: false,
        }),
      ],
      {
        expandedOrderIds: new Set(["order-11453"]),
      },
    );

    expect(html).toContain("Delivery date required");
    expect(html).toContain('name="deliveryDate"');
    expect(html).not.toContain('name="serviceType"');
    expect(html).not.toContain('name="deliverySession"');
    expect(html).toContain("Save fixes");
  });

  test("renders aggregate repair card when multiple field groups are missing", () => {
    const html = renderOrderTable(
      [
        orderFixture({
          blockerReasons: ["missing_delivery_date", "missing_route_scope"],
          deliveryDate: null,
          deliverySession: null,
          metadataResolved: false,
          routeEligible: false,
          serviceType: null,
        }),
      ],
      {
        expandedOrderIds: new Set(["order-11453"]),
      },
    );

    expect(html).toContain("Fix required order details");
    expect(html).toContain(
      "Update the highlighted field, then save this order.",
    );
    expect(html).toContain("Missing delivery date");
    expect(html).toContain("Missing route scope");
    expect(html).toContain('name="deliveryDate"');
    expect(html).toMatch(
      /<select(?=[^>]*name="serviceType")(?=[^>]*data-choice-field="serviceType")[^>]*>/,
    );
    expect(html).not.toMatch(/<input[^>]*name="serviceType"[^>]*type="text"/);
    expect(html).not.toMatch(/<button[^>]*data-choice-field="serviceType"/);
    expect(html).toContain('data-choice-value="EVENING_DELIVERY"');
    expect(html).toContain("Select service type");
    expect(html).toContain(
      "Allowed values: DELIVERY, EVENING_DELIVERY, PICKUP",
    );
    expect(html).toMatch(
      /<select(?=[^>]*name="deliverySession")(?=[^>]*data-choice-field="deliverySession")[^>]*>/,
    );
    expect(html).not.toMatch(
      /<input[^>]*name="deliverySession"[^>]*type="text"/,
    );
    expect(html).not.toMatch(/<button[^>]*data-choice-field="deliverySession"/);
    expect(html).toContain('data-choice-value="EVENING"');
    expect(html).toContain("Select delivery session");
    expect(html).toContain("Allowed values: DAY, EVENING, PICKUP");
    expect(html).toContain('aria-label="Service type help"');
    expect(html).toContain('class="order-detail-field-tooltip"');
    expect(html).not.toContain("order-detail-field-hint");
    expect(html).toContain("Save fixes");
    expect(html).not.toContain("Required attention");
    expect(html).not.toContain("Coordinates available: 43.653200, -79.383200");
  });

  test("renders configured custom route-scope help in detail tooltips", () => {
    const routeScopeConfig = defaultRouteScopeConfig();
    const html = renderOrderTable(
      [
        orderFixture({
          blockerReasons: ["missing_route_scope"],
          deliverySession: null,
          metadataResolved: false,
          routeEligible: false,
          serviceType: null,
        }),
      ],
      {
        expandedOrderIds: new Set(["order-11453"]),
        settings: {
          defaultDepotAddress: null,
          defaultDepotLatitude: null,
          defaultDepotLongitude: null,
          locale: "en-CA",
          routeScopeConfig: {
            ...routeScopeConfig,
            deliverySessions: [
              ...routeScopeConfig.deliverySessions,
              {
                builtIn: false,
                description: "Morning",
                enabled: true,
                example: "MORNING",
                label: "Morning",
                value: "MORNING",
              },
              {
                builtIn: false,
                description: "Disabled late session",
                enabled: false,
                example: "LATE",
                label: "Late",
                value: "LATE",
              },
            ],
            serviceTypes: [
              ...routeScopeConfig.serviceTypes,
              {
                builtIn: false,
                description: "Morning delivery",
                enabled: true,
                example: "MORNING_DELIVERY",
                label: "Morning delivery",
                value: "MORNING_DELIVERY",
              },
              {
                builtIn: false,
                description: "Disabled late delivery",
                enabled: false,
                example: "LATE_DELIVERY",
                label: "Late delivery",
                value: "LATE_DELIVERY",
              },
            ],
          },
          shopDomain: "tenant.example.test",
        },
      },
    );

    expect(html).toContain('data-choice-value="MORNING_DELIVERY"');
    expect(html).toContain('data-choice-value="MORNING"');
    expect(html).not.toContain('data-choice-value="LATE_DELIVERY"');
    expect(html).not.toContain('data-choice-value="LATE"');
    expect(html).toContain('role="tooltip"');
    expect(html).not.toContain("order-detail-field-hint");
  });

  test("does not resubmit unsupported route-scope values without an active choice", () => {
    const html = renderOrderTable(
      [
        orderFixture({
          blockerReasons: ["missing_route_scope"],
          deliverySession: "LEGACY_SESSION",
          metadataResolved: false,
          routeEligible: false,
          serviceType: "LEGACY_SERVICE",
        }),
      ],
      {
        expandedOrderIds: new Set(["order-11453"]),
      },
    );

    expect(html).toMatch(
      /<select(?=[^>]*name="serviceType")(?=[^>]*data-choice-field="serviceType")[^>]*>/,
    );
    expect(html).not.toContain('value="LEGACY_SERVICE"');
    expect(html).toMatch(
      /<select(?=[^>]*name="deliverySession")(?=[^>]*data-choice-field="deliverySession")[^>]*>/,
    );
    expect(html).not.toContain('value="LEGACY_SESSION"');
    expect(html).toMatch(
      /<button disabled="" type="submit">Save fixes<\/button>/,
    );

    const fields = buildEditableMetadataFields(undefined);
    const normalized = normalizeOrderMetadataPatchForFields(
      {
        address1: null,
        address2: null,
        city: null,
        countryCode: null,
        deliveryArea: null,
        deliveryDate: null,
        deliverySession: "LEGACY_SESSION",
        postalCode: null,
        province: null,
        serviceType: "LEGACY_SERVICE",
        timeWindowEnd: null,
        timeWindowStart: null,
      },
      fields,
    );
    expect(normalized.serviceType).toBeNull();
    expect(normalized.deliverySession).toBeNull();
  });

  test("choice dropdown change path emits existing route-scope patch keys", () => {
    const fields = buildEditableMetadataFields(undefined);
    const serviceField = fields.find((field) => field.key === "serviceType");
    const sessionField = fields.find(
      (field) => field.key === "deliverySession",
    );
    expect(serviceField).toBeDefined();
    expect(sessionField).toBeDefined();

    const changes: Partial<OrderMetadataPatch> = {};
    const onChange = (key: keyof OrderMetadataPatch, value: string): void => {
      changes[key] = value;
    };

    changeDropdown(
      OrderDetailChoiceDropdown({
        field: serviceField!,
        inputId: "service-type",
        labelId: "service-type-label",
        onChange,
        value: null,
      }),
      "EVENING_DELIVERY",
    );
    changeDropdown(
      OrderDetailChoiceDropdown({
        field: sessionField!,
        inputId: "delivery-session",
        labelId: "delivery-session-label",
        onChange,
        value: null,
      }),
      "EVENING",
    );

    expect(changes).toMatchObject({
      deliverySession: "EVENING",
      serviceType: "EVENING_DELIVERY",
    });
  });

  test("uses unique help ids for repair and edit field tooltips", () => {
    const html = renderOrderTable(
      [
        orderFixture({
          blockerReasons: ["missing_route_scope"],
          deliverySession: null,
          metadataResolved: false,
          routeEligible: false,
          serviceType: null,
        }),
      ],
      {
        detailModes: { "order-11453": "edit" },
        expandedOrderIds: new Set(["order-11453"]),
      },
    );

    expect(html).toContain(
      'id="order-detail-order-11453-repair-serviceType-help"',
    );
    expect(html).toContain(
      'id="order-detail-order-11453-edit-serviceType-help"',
    );
    expect(html).toContain(
      'aria-describedby="order-detail-order-11453-repair-serviceType-help"',
    );
    expect(html).toContain(
      'aria-describedby="order-detail-order-11453-edit-serviceType-help"',
    );
    expect(html).toContain('aria-expanded="false"');
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
    expect(html).toContain('aria-label="Service type help"');
    expect(html).toContain('aria-label="Delivery session help"');
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
    expect(getOrderFieldLabels("ko-KR").address1).toBe("도로명 주소");
    expect(getOrderBlockerLabels("ko-KR").missing_coordinates).toBe("좌표 필요");
    expect(formatDiagnosticPathLabel("unknown.path")).toBe("Order metadata");
    expect(formatDiagnosticPathLabel("unknown.path", "ko-KR")).toBe("주문 메타데이터");
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
    expect(html).toContain("Bulk geocode");
    expect(html).toContain("Bulk geocode Completed");
    expect(html).not.toContain("Geocode &amp; add");
  });

  test("renders current-filter group selection controls for route-ready orders only", () => {
    const html = renderOrderTable(
      [
        orderFixture(),
        orderFixture({
          blockerReasons: ["missing_delivery_date"],
          deliveryDate: null,
          metadataResolved: false,
          orderId: "blocked-order",
          orderName: "#1002",
          routeEligible: false,
        }),
        orderFixture({
          orderId: "planned-order",
          orderName: "#1003",
          planningStatus: "PLANNED",
          routePlanId: "route-1",
          routePlanName: "Route 1",
        }),
      ],
      {
        selected: new Set(["order-11453"]),
      },
    );

    expect(html).toContain("1 selected · 1 selectable · 2 unavailable");
    expect(html).not.toContain("Select filtered");
    expect(html).not.toContain("Clear filtered");
    expect(html).not.toContain("Clear selection");
    expect(html).not.toMatch(/>Clear<\/button>/u);
    expect(html).toContain(
      'aria-label="Select all eligible orders in current workset"',
    );
    expect(html).toContain('aria-label="Select order #1002 11453"');
    expect(html).toContain('aria-label="Select order #1003 11453"');
  });

  test("renders Korean order table and detail labels when locale is ko-KR", () => {
    const html = renderOrderTable(
      [
        orderFixture({
          blockerReasons: ["missing_delivery_date", "missing_route_scope"],
          deliveryDate: null,
          deliverySession: null,
          metadataResolved: false,
          routeEligible: false,
          serviceType: null,
        }),
      ],
      {
        expandedOrderIds: new Set(["order-11453"]),
        locale: "ko-KR",
      },
    );

    expect(html).toContain("<span>선택</span>");
    for (const header of ["주문", "고객", "방식", "요일", "지역", "경로", "상태", "작업"]) {
      expect(html).toContain(`>${header}</th>`);
    }
    expect(html).toContain("가져온 주문 목록");
    expect(html).toContain("1 주문");
    expect(html).toContain("0개 선택 · 0개 선택 가능 · 1개 불가");
    expect(html).toContain("리뷰");
    expect(html).toContain("배송 날짜 누락");
    expect(html).toContain("경로 범위 누락");
    expect(html).toContain("필수 주문 정보 수정");
    expect(html).toContain("강조된 필드를 수정한 뒤 이 주문을 저장하세요.");
    expect(html).toContain("수정 저장");
    expect(html).toContain("상세");
    expect(html).toContain("배송지");
    expect(html).toContain("좌표");
    expect(html).toContain("기술 진단");
    expect(html).not.toContain("Order details for");
    expect(html).not.toContain("Missing delivery date");
  });

  test("route draft selection locks to one delivery date and session", () => {
    const first = orderFixture({ orderId: "first" });
    const sameScope = orderFixture({
      orderId: "same-scope",
      orderName: "#11454",
    });
    const otherDate = orderFixture({
      deliveryDate: "2026-05-30",
      orderId: "other-date",
      orderName: "#11455",
    });
    const otherSession = orderFixture({
      deliverySession: "DAY",
      orderId: "other-session",
      orderName: "#11456",
      serviceType: "DELIVERY",
      timeWindowEnd: null,
      timeWindowStart: null,
    });

    const draft = buildRouteDraftSelection(
      [first, sameScope, otherDate, otherSession],
      new Set(["first", "same-scope", "other-date", "other-session"]),
    );

    expect(draft.deliveryDate).toBe("2026-05-29");
    expect(draft.orderIds).toEqual(["first", "same-scope"]);
    expect(draft.warning).toContain("same delivery date and delivery session");
    expect(
      getRouteDraftCreateBlocker([first, sameScope], "2026-05-29"),
    ).toBeNull();
    expect(getRouteDraftCreateBlocker([first], "2026-05-30")).toContain(
      "Route date must match",
    );
    expect(
      getRouteDraftCreateBlocker([first, otherSession], "2026-05-29"),
    ).toContain("same delivery date");
  });

  test("formatter precedence uses service type for Method and delivery date for Day", () => {
    const order = orderFixture({
      deliverySession: "MORNING_DELIVERY",
      serviceType: "EVENING_DELIVERY",
      timeWindowStart: "08:30",
      timeWindowEnd: "11:00",
    });

    expect(formatMethodLabel(order)).toBe("Evening Delivery");
    expect(formatMethodStatusLabel(order)).toEqual({
      label: "Evening Delivery",
      toneClass: "order-pill--neutral",
    });
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
    expect(
      formatMethodStatusLabel(
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
    ).toEqual({
      label: "—",
      toneClass: "order-pill--review",
    });
  });
});

function renderOrderTable(
  orders: CanonicalOrderDto[],
  options: {
    bulkGeocodeStatus?: string;
    detailModes?: Record<string, "review" | "edit">;
    diagnosticsByOrder?: Record<string, DeliveryMetadataDiagnosticsDto | null>;
    expandedOrderIds?: Set<string>;
    loading?: boolean;
    refreshing?: boolean;
    selected?: Set<string>;
    settings?: StoreSettingsDto;
    locale?: string;
    worksetContext?: { scope: "history" | "planning" };
  } = {},
): string {
  return renderToStaticMarkup(
    <OrderTable
      bulkGeocodeStatus={options.bulkGeocodeStatus}
      detailModes={options.detailModes}
      diagnosticsByOrder={options.diagnosticsByOrder ?? {}}
      expandedOrderIds={options.expandedOrderIds}
      loading={options.loading ?? false}
      locale={options.locale}
      onBulkGeocode={() => undefined}
      onToggleDetail={() => undefined}
      onTogglePlanOrder={() => undefined}
      orders={orders}
      refreshing={options.refreshing}
      selected={options.selected ?? new Set()}
      setSelected={() => undefined}
      settings={options.settings}
      worksetContext={options.worksetContext}
    />,
  );
}

function changeDropdown(
  element: ReturnType<typeof OrderDetailChoiceDropdown>,
  value: string,
): void {
  const select = element as unknown as {
    props: {
      onChange(event: { target: { value: string } }): void;
    };
  };
  select.props.onChange({ target: { value } });
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
    normalizedPaymentReason: "transfer_method_waiting_for_woo_confirmation",
    normalizedPaymentStatus: "TRANSFER_CHECK_PENDING",
    orderId: "order-11453",
    orderName: "#11453",
    paidAt: null,
    paymentMethodFamily: "transfer",
    paymentMethodId: "bacs",
    paymentMethodTitle: "E-mail transfer",
    paymentReviewReason: null,
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
    sourceCreatedAt: "2026-06-04T16:00:00.000Z",
    sourceCreatedDate: "2026-06-04",
    sourcePlatform: "WOO",
    sourceUpdatedAt: "2026-06-05T14:00:00.000Z",
    sourceUpdatedDate: "2026-06-05",
    status: "open",
    stopId: null,
    timeWindowEnd: "21:00",
    timeWindowStart: "17:00",
    transactionId: null,
    wooOrderStatus: "on-hold",
    ...overrides,
  };
}

function exhaustedBulkNoResultDiagnostic(): NonNullable<CanonicalOrderDto["geocodeDiagnostics"]> {
  return {
    attemptCount: 8,
    code: "GEOCODER_NO_RESULT",
    messageKey: "GEOCODER_NO_RESULT",
    ok: false,
    provider: null,
    queryShapes: [
      "structured_without_unit",
      "freeform",
      "structured_without_unit_no_city",
      "freeform_no_city",
      "structured_without_unit_no_postal",
      "freeform_no_postal",
      "structured_without_unit_no_city_no_postal",
      "freeform_no_city_no_postal",
    ],
    source: "bulk_geocode",
    transient: false,
    updatedAt: "2026-06-03T11:17:01.859Z",
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
