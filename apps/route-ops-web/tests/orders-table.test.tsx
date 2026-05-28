import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import {
  formatDeliveryDayLabel,
  formatMethodLabel,
  formatOperationalStatus,
  getRouteRepairPrompt,
  ORDERS_TABLE_COLUMN_COUNT,
  OrderTable
} from '../src/pages/OrdersPage';
import type { CanonicalOrderDto, DeliveryMetadataDiagnosticsDto } from '../src/types';

describe('Orders compact operations table', () => {
  test('renders the approved Phase A semantic columns without fake Phase B data', () => {
    const html = renderOrderTable([orderFixture()]);

    expect(html).toContain('class="orders-compact-table"');
    expect(html).toContain(`data-column-count="${ORDERS_TABLE_COLUMN_COUNT}"`);
    for (const header of [
      'Select',
      'Order',
      'Customer',
      'Method',
      'Day',
      'Area',
      'Route',
      'Status',
      'Actions'
    ]) {
      expect(html).toContain(`>${header}</th>`);
    }
    expect(html).not.toContain('Items');
    expect(html).not.toContain('Total');
    expect(html).not.toContain('EasyRoutes');
    expect(html).not.toContain('Sync');
  });

  test('renders operational order data from current CanonicalOrderDto fields', () => {
    const html = renderOrderTable([orderFixture()]);

    expect(html).toContain('#11453');
    expect(html).toContain('WOO · 11453');
    expect(html).toContain('Tomato Buyer');
    expect(html).toContain('416-555-0100');
    expect(html).toContain('Evening Delivery');
    expect(html).toContain('FRI5PM');
    expect(html).toContain('2026-05-29 · 5PM–9PM');
    expect(html).toContain('Toronto West');
    expect(html).toContain('Ready');
    expect(html).toContain('Route eligible');
  });

  test('keeps selection accessibility and disabled eligibility semantics', () => {
    const blocked = orderFixture({
      blockerReasons: ['missing_delivery_date'],
      deliveryDate: null,
      metadataResolved: false,
      orderId: 'blocked-order',
      orderName: '#1002',
      routeEligible: false
    });
    const html = renderOrderTable([blocked]);

    expect(html).toContain('aria-label="Select order #1002 11453"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('Review');
    expect(html).toContain('Metadata review');
  });

  test('allows already-selected non-eligible orders to be removed and spans diagnostics across all columns', () => {
    const blocked = orderFixture({
      blockerReasons: ['missing_coordinates'],
      orderId: 'selected-blocked',
      routeEligible: false
    });
    const html = renderOrderTable([blocked], {
      diagnosticsByOrder: { 'selected-blocked': null },
      selected: new Set(['selected-blocked'])
    });

    expect(html).toContain('checked=""');
    expect(html).not.toContain('disabled=""');
    expect(html).toContain(`colSpan="${ORDERS_TABLE_COLUMN_COUNT}"`);
    expect(html).toContain('No delivery metadata diagnostics saved');
    expect(html).toContain('aria-label="Remove order #11453 11453 from route plan"');
  });

  test('shows metadata-ok coordinate blockers with an inline geocode action', () => {
    const missingCoordinates = orderFixture({
      coordinates: { latitude: null, longitude: null },
      geocodeStatus: 'PENDING',
      metadataResolved: true,
      routeEligible: false
    });
    const html = renderOrderTable([missingCoordinates]);

    expect(html).toContain('Need coordinates');
    expect(html).toContain('Geocode shipping address');
    expect(html).toContain('Geocode &amp; add');
    expect(html).toContain('aria-label="Geocode and add order #11453 11453 to route plan"');
    expect(getRouteRepairPrompt(missingCoordinates)).toEqual({
      canGeocode: true,
      routeDetail: 'Need coordinates',
      statusDetail: 'Geocode shipping address',
      statusLabel: 'Need coordinates'
    });
    expect(formatOperationalStatus(missingCoordinates).label).toBe(
      'Need coordinates'
    );
  });

  test('empty state remains inside the compact table vocabulary', () => {
    const html = renderOrderTable([]);

    expect(html).toContain('No imported orders match the current filters.');
    expect(html).toContain(`colSpan="${ORDERS_TABLE_COLUMN_COUNT}"`);
  });

  test('formatter precedence uses service type for Method and delivery date for Day', () => {
    const order = orderFixture({
      deliverySession: 'MORNING_DELIVERY',
      serviceType: 'EVENING_DELIVERY',
      timeWindowStart: '08:30',
      timeWindowEnd: '11:00'
    });

    expect(formatMethodLabel(order)).toBe('Evening Delivery');
    expect(formatDeliveryDayLabel(order)).toEqual({
      detail: '2026-05-29 · 8:30AM–11AM',
      label: 'FRI8:30AM',
      toneClass: 'order-pill--day'
    });
    expect(formatOperationalStatus(order).label).toBe('Ready');
    expect(
      formatDeliveryDayLabel(orderFixture({ deliveryDate: null })).label
    ).toBe('Review');
  });

  test('method formatter never guesses from address/date fields', () => {
    expect(
      formatMethodLabel(
        orderFixture({
          deliverySession: 'MORNING_DELIVERY',
          serviceType: null
        })
      )
    ).toBe('Morning Delivery');
    expect(
      formatMethodLabel(
        orderFixture({
          deliveryArea: 'Toronto West',
          deliveryDate: '2026-05-29',
          deliverySession: null,
          serviceType: null,
          shippingAddress: {
            address1: '4475 Chesswood Dr',
            address2: null,
            city: 'Toronto',
            countryCode: 'CA',
            postalCode: 'M3J 2C3',
            province: 'ON'
          }
        })
      )
    ).toBe('—');
  });
});

function renderOrderTable(
  orders: CanonicalOrderDto[],
  options: {
    diagnosticsByOrder?: Record<string, DeliveryMetadataDiagnosticsDto | null>;
    selected?: Set<string>;
  } = {}
): string {
  return renderToStaticMarkup(
    <OrderTable
      diagnosticsByOrder={options.diagnosticsByOrder ?? {}}
      loading={false}
      onLoadDiagnostics={() => undefined}
      onTogglePlanOrder={() => undefined}
      orders={orders}
      selected={options.selected ?? new Set()}
      setSelected={() => undefined}
    />
  );
}

function orderFixture(
  overrides: Partial<CanonicalOrderDto> = {}
): CanonicalOrderDto {
  return {
    blockerReasons: [],
    coordinates: { latitude: 43.6532, longitude: -79.3832 },
    deliveryArea: 'Toronto West',
    deliveryDate: '2026-05-29',
    deliverySession: 'EVENING_DELIVERY',
    deliveryStatus: 'ready',
    geocodeStatus: 'RESOLVED',
    health: 'normal',
    metadataResolved: true,
    orderId: 'order-11453',
    orderName: '#11453',
    phone: '416-555-0100',
    planningStatus: 'UNPLANNED',
    recipientName: 'Tomato Buyer',
    routeEligible: true,
    routePlanId: null,
    routePlanName: null,
    serviceType: 'EVENING_DELIVERY',
    shippingAddress: {
      address1: '4475 Chesswood Dr',
      address2: null,
      city: 'Toronto',
      countryCode: 'CA',
      postalCode: 'M3J 2C3',
      province: 'ON'
    },
    sourceOrderId: 'gid://woo/11453',
    sourceOrderNumber: '11453',
    sourcePlatform: 'WOO',
    status: 'open',
    stopId: null,
    timeWindowEnd: '21:00',
    timeWindowStart: '17:00',
    ...overrides
  };
}
