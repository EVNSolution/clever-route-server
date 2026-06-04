import { describe, expect, test } from 'vitest';

import { withWorkspaceQuery } from '../src/api';
import { defaultRouteScopeConfig } from '../src/routeScopeConfig';
import {
  applyClientOrderFilters,
  buildOrderFetchQuery,
  buildOrderQuery,
  createDefaultOrderFilters,
  deriveRouteStats,
  geometryLabel,
  getOrderWorksetUnavailableReasons,
  hasStopSequenceChanged,
  hideSetupActions,
  isAddressReviewRequired,
  isDeliveryDateReviewRequired,
  mapReadiness,
  matchesOrderTab,
  matchesPlanningScope,
  moveStop,
  moveStopBefore,
  storeSettingsToDepotPoint,
  summarizeOrderWorkset,
  summarizeSelection
} from '../src/state';
import type { BootstrapPayload, CanonicalOrderDto, RoutePlanDetailDto, RouteStopDto } from '../src/types';

describe('route ops web state helpers', () => {
  test('serializes order filters without empty/all values', () => {
    expect(buildOrderQuery({ deliveryArea: 'Toronto', deliveryDate: '2026-05-27', deliveryStatus: 'all', health: '', scope: 'planning', search: '#1001', serviceType: 'EVENING_DELIVERY', tab: 'planned' })).toBe('deliveryDate=2026-05-27&deliveryArea=Toronto&scope=planning&tab=planned&serviceType=EVENING_DELIVERY&search=%231001');
  });

  test('keeps delivery date as a client-side filter to avoid refetching on date changes', () => {
    const filters = { ...createDefaultOrderFilters(), deliveryArea: 'Toronto', deliveryDate: '2026-05-27', search: '#1001', tab: 'planned' as const };

    expect(buildOrderQuery(filters)).toBe('deliveryDate=2026-05-27&deliveryArea=Toronto&scope=planning&tab=planned&search=%231001');
    expect(buildOrderFetchQuery(filters)).toBe('deliveryArea=Toronto&scope=planning&tab=planned&search=%231001');
  });

  test('applies the delivery date filter locally against prefetched orders', () => {
    const orders = [
      order({ deliveryDate: '2026-05-27', orderId: 'may-27' }),
      order({ deliveryDate: '2026-05-28', orderId: 'may-28' }),
      order({ deliveryDate: null, orderId: 'missing-date' }),
    ];

    expect(applyClientOrderFilters(orders, { deliveryDate: '2026-05-27' }).map((item) => item.orderId)).toEqual(['may-27']);
    expect(applyClientOrderFilters(orders, { deliveryDate: '' })).toBe(orders);
  });

  test('defaults to the planning unplanned workset and serializes All/History explicitly', () => {
    expect(createDefaultOrderFilters()).toEqual(expect.objectContaining({ scope: 'planning', tab: 'unplanned' }));
    expect(buildOrderQuery(createDefaultOrderFilters())).toBe('scope=planning&tab=unplanned');
    expect(buildOrderQuery({ ...createDefaultOrderFilters(), tab: 'all' })).toBe('scope=planning&tab=all');
    expect(buildOrderQuery({ ...createDefaultOrderFilters(), scope: 'history', tab: 'all' })).toBe('scope=history&tab=all');
    expect(buildOrderQuery({ ...createDefaultOrderFilters(), tab: 'needs_review' })).toBe('scope=planning&tab=needs_review');
  });

  test('serializes service type and delivery session filters while preserving enum values', () => {
    expect(buildOrderQuery({ ...createDefaultOrderFilters(), deliverySession: 'EVENING', serviceType: 'EVENING_DELIVERY' })).toBe(
      'scope=planning&tab=unplanned&serviceType=EVENING_DELIVERY&deliverySession=EVENING'
    );
  });

  test('classifies planning scope tabs and workset availability reasons', () => {
    const ready = order({ deliveryDate: '2026-05-29', orderId: 'ready' });
    const planned = order({ deliveryDate: '2026-05-29', orderId: 'planned', planningStatus: 'PLANNED', routePlanId: 'route-1' });
    const missingDate = order({ blockerReasons: ['missing_delivery_date'], deliveryDate: null, metadataResolved: false, orderId: 'missing-date', routeEligible: false });
    const metadataReview = order({ blockerReasons: ['missing_delivery_area'], metadataResolved: false, orderId: 'metadata-review', routeEligible: false });
    const completed = order({ deliveryDate: '2026-05-29', deliveryStatus: 'completed', orderId: 'completed' });

    expect(matchesPlanningScope(ready, '2026-05-29')).toBe(true);
    expect(matchesPlanningScope(completed, '2026-05-29')).toBe(false);
    expect(matchesOrderTab(ready, 'unplanned', '2026-05-29')).toBe(true);
    expect(matchesOrderTab(planned, 'planned', '2026-05-29')).toBe(true);
    expect(matchesOrderTab(missingDate, 'needs_review', '2026-05-29')).toBe(true);

    expect(getOrderWorksetUnavailableReasons(planned, { scope: 'planning' }).map((reason) => reason.code)).toContain('already_planned');
    expect(getOrderWorksetUnavailableReasons(ready, { scope: 'history' })).toEqual([]);
    expect(getOrderWorksetUnavailableReasons(missingDate, { scope: 'history' }).map((reason) => reason.code)).toEqual(['missing_delivery_date']);
    expect(getOrderWorksetUnavailableReasons(metadataReview, { scope: 'history' }).map((reason) => reason.code)).toContain('needs_review');
    const summary = summarizeOrderWorkset([ready, planned, missingDate, metadataReview], new Set(['ready']), { scope: 'planning' });
    expect(summary).toEqual(expect.objectContaining({ selectableCount: 1, selectedCount: 1, unavailableCount: 3 }));
    expect(summary.reasonLabels.join(' ')).toContain('Already planned');
    expect(summary.reasonLabels.join(' ')).toContain('Missing delivery date');
    expect(summary.reasonLabels.join(' ')).toContain('Other metadata review');
    const koreanSummary = summarizeOrderWorkset([ready, planned, missingDate, metadataReview], new Set(['ready']), { scope: 'planning' }, 'ko-KR');
    expect(koreanSummary.reasonLabels.join(' ')).toContain('이미 배정됨');
    expect(koreanSummary.reasonLabels.join(' ')).toContain('배송 날짜 누락');
    expect(koreanSummary.reasonLabels.join(' ')).toContain('기타 메타데이터 검토');
  });

  test('separates exhausted bulk geocode failures as address review', () => {
    const addressReview = order({
      blockerReasons: ['missing_coordinates'],
      coordinates: { latitude: null, longitude: null },
      geocodeDiagnostics: exhaustedBulkNoResultDiagnostic(),
      geocodeStatus: 'FAILED',
      metadataResolved: false,
      orderId: 'address-review',
      routeEligible: false,
      shippingAddress: {
        address1: '23 Apple Orchard Path',
        address2: null,
        city: 'Thornhill',
        countryCode: 'CA',
        postalCode: 'L3T 3B5',
        province: 'ON'
      }
    });

    expect(isAddressReviewRequired(addressReview)).toBe(true);
    expect(
      getOrderWorksetUnavailableReasons(addressReview).map((reason) => reason.code)
    ).toEqual(['address_review']);
    const summary = summarizeOrderWorkset([addressReview], new Set());
    expect(summary.reasonLabels).toEqual(['Address Review 1']);
    expect(summary.reasonsByCode.address_review).toBe(1);

    const pendingCoordinates = order({
      blockerReasons: ['missing_coordinates'],
      coordinates: { latitude: null, longitude: null },
      geocodeStatus: 'PENDING',
      metadataResolved: false,
      orderId: 'pending-coordinates',
      routeEligible: false,
      shippingAddress: {
        address1: '298 Buttonbush St',
        address2: null,
        city: 'Waterloo',
        countryCode: 'CA',
        postalCode: 'N2V 0B2',
        province: 'ON'
      }
    });
    expect(isAddressReviewRequired(pendingCoordinates)).toBe(false);
    expect(
      getOrderWorksetUnavailableReasons(pendingCoordinates).map((reason) => reason.code)
    ).toEqual(['missing_coordinates']);
  });

  test('separates missing delivery dates from delivery date review blockers', () => {
    const actuallyMissing = order({
      blockerReasons: ['missing_delivery_date'],
      deliveryDate: null,
      metadataResolved: false,
      orderId: 'missing-date',
      routeEligible: false
    });
    const reviewNeeded = order({
      blockerReasons: ['ambiguous_delivery_day', 'missing_delivery_date'],
      deliveryDate: null,
      metadataResolved: false,
      orderId: 'date-review',
      routeEligible: false
    });

    expect(isDeliveryDateReviewRequired(actuallyMissing)).toBe(false);
    expect(isDeliveryDateReviewRequired(reviewNeeded)).toBe(true);
    expect(
      getOrderWorksetUnavailableReasons(actuallyMissing).map((reason) => reason.code)
    ).toEqual(['missing_delivery_date']);
    expect(
      getOrderWorksetUnavailableReasons(reviewNeeded).map((reason) => reason.code)
    ).toEqual(['delivery_date_review']);

    const summary = summarizeOrderWorkset([actuallyMissing, reviewNeeded], new Set());
    expect(summary.reasonLabels).toEqual([
      'Delivery date review 1',
      'Missing delivery date 1'
    ]);
    expect(summary.reasonsByCode.delivery_date_review).toBe(1);
    expect(summary.reasonsByCode.missing_delivery_date).toBe(1);
  });



  test('carries the current shop domain into Route Ops API calls for internal admin sessions', () => {
    expect(withWorkspaceQuery('/admin/ui/app/api/orders?deliveryDate=2026-05-27', '?shopDomain=tenant.example.test')).toBe(
      '/admin/ui/app/api/orders?deliveryDate=2026-05-27&shopDomain=tenant.example.test'
    );
    expect(withWorkspaceQuery('/admin/ui/app/api/routes?shopDomain=explicit.example.test', '?shopDomain=tenant.example.test')).toBe(
      '/admin/ui/app/api/routes?shopDomain=explicit.example.test'
    );
    expect(withWorkspaceQuery('/admin/ui/app/api/bootstrap', '')).toBe('/admin/ui/app/api/bootstrap');
  });

  test('summarizes selected ready orders and blockers', () => {
    const orders = [order({ orderId: 'ready' }), order({ blockerReasons: ['missing_coordinates'], orderId: 'blocked', planningStatus: 'UNPLANNED' })];
    const result = summarizeSelection(orders, new Set(['ready', 'blocked']));
    expect(result.readySelected.map((item) => item.orderId)).toEqual(['ready']);
    expect(result.blockers).toEqual(['#1001: missing_coordinates']);
  });

  test('moves stops using keyboard-compatible reorder helper', () => {
    const stops = [stop('a', 1), stop('b', 2), stop('c', 3)];
    expect(moveStop(stops, 'b', -1).map((item) => `${item.deliveryStopId}:${item.sequence}`)).toEqual(['b:1', 'a:2', 'c:3']);
    expect(moveStop(stops, 'c', 1)).toBe(stops);
  });

  test('detects unsaved route sequence changes by stable stop identity', () => {
    const savedStops = [stop('a', 1), stop('b', 2), stop('c', 3)];
    expect(hasStopSequenceChanged(savedStops, [stop('a', 1), stop('b', 2), stop('c', 3)])).toBe(false);
    expect(hasStopSequenceChanged(savedStops, [stop('b', 1), stop('a', 2), stop('c', 3)])).toBe(true);
    expect(hasStopSequenceChanged(savedStops, [stop('a', 1), stop('b', 2)])).toBe(true);
    expect(hasStopSequenceChanged(null, savedStops)).toBe(false);
  });



  test('supports drag/drop stop insertion before a target stop', () => {
    const stops = [stop('a', 1), stop('b', 2), stop('c', 3), stop('d', 4)];
    expect(moveStopBefore(stops, 'd', 'b').map((item) => `${item.deliveryStopId}:${item.sequence}`)).toEqual(['a:1', 'd:2', 'b:3', 'c:4']);
    expect(moveStopBefore(stops, 'b', 'd').map((item) => `${item.deliveryStopId}:${item.sequence}`)).toEqual(['a:1', 'c:2', 'b:3', 'd:4']);
    expect(moveStopBefore(stops, 'x', 'd')).toBe(stops);
  });

  test('derives route stats and geometry labels honestly', () => {
    const detail: RoutePlanDetailDto = {
      routeGeometry: null,
      routePlan: {
        createdAt: '',
        deliveryAreas: [],
        deliveryDate: '2026-05-27',
        depot: { latitude: 43.7, longitude: -79.4 },
        driverId: null,
        id: 'route-1',
        missingCoordinates: 1,
        name: 'Route 1',
        planDate: '2026-05-27',
        routeEndMode: 'END_AT_LAST_STOP',
        status: 'DRAFT',
        stopsCount: 2,
        updatedAt: ''
      },
      routeStopPoints: [],
      stops: [stop('a', 1, 'COMPLETED'), stop('b', 2, 'ATTEMPTED', null, null)]
    };
    expect(deriveRouteStats(detail)).toEqual({ attempted: 1, completed: 1, missingCoordinates: 1, stops: 2 });
    expect(geometryLabel(null, 'configured')).toBe('No route selected');
    expect(geometryLabel(detail, 'not_configured')).toBe('Stops ready · router not configured');
    expect(geometryLabel(detail, 'not_configured', 'ko-KR')).toBe('정류장 표시됨 · 라우터 미설정');
    expect(geometryLabel({ ...detail, routeGeometry: { coordinates: [[-79, 43], [-79.1, 43.1]], type: 'LineString' } }, 'configured')).toBe('Road path ready');
    expect(geometryLabel({ ...detail, routeGeometry: { coordinates: [[-79, 43], [-79.1, 43.1]], type: 'LineString' } }, 'configured', 'ko-KR')).toBe('도로 경로');
    expect(geometryLabel(detail, 'configured')).toBe('Stops ready · road path not generated');
    expect(geometryLabel({ ...detail, routePlan: { ...detail.routePlan, depot: { latitude: null, longitude: null } }, stops: [stop('a', 1, 'PENDING', null, null)] }, 'configured')).toBe('Need coordinates for road path');
    expect(geometryLabel({ ...detail, routePlan: { ...detail.routePlan, depot: { latitude: null, longitude: null } }, stops: [stop('a', 1, 'PENDING', null, null)] }, 'configured', 'ko-KR')).toBe('경로 선에 필요한 좌표 부족');
  });

  test('keeps map/provider states explicit and plugin mode hides setup actions', () => {
    expect(mapReadiness({ coordinatesCount: 0, mapStatus: 'configured' })).toBe('interactive_map');
    expect(mapReadiness({ coordinatesCount: 3, mapStatus: 'not_configured' })).toBe('provider_not_configured');
    expect(mapReadiness({ coordinatesCount: 3, mapStatus: 'configured' })).toBe('interactive_map');
    expect(hideSetupActions(bootstrap('plugin'))).toBe(true);
    expect(hideSetupActions(bootstrap('internal-admin'))).toBe(false);
  });

  test('turns saved store settings into an orders-map depot point', () => {
    expect(storeSettingsToDepotPoint({
      defaultDepotAddress: '123 Depot St, Toronto, ON',
      defaultDepotLatitude: 43.6532,
      defaultDepotLongitude: -79.3832,
      locale: 'en-CA',
      routeScopeConfig: defaultRouteScopeConfig(),
      shopDomain: 'tenant.example.test'
    })).toEqual({
      addressLabel: '123 Depot St, Toronto, ON',
      id: 'settings-store-depot',
      kind: 'depot',
      label: 'Store',
      latitude: 43.6532,
      longitude: -79.3832
    });
    expect(storeSettingsToDepotPoint({
      defaultDepotAddress: 'No coordinates',
      defaultDepotLatitude: null,
      defaultDepotLongitude: null,
      locale: 'en-CA',
      routeScopeConfig: defaultRouteScopeConfig(),
      shopDomain: 'tenant.example.test'
    })).toBeNull();
    expect(storeSettingsToDepotPoint({
      defaultDepotAddress: null,
      defaultDepotLatitude: 43.6532,
      defaultDepotLongitude: -79.3832,
      locale: 'ko-KR',
      routeScopeConfig: defaultRouteScopeConfig(),
      shopDomain: 'tenant.example.test'
    })?.label).toBe('매장');
  });
});

function order(overrides: Partial<CanonicalOrderDto> = {}): CanonicalOrderDto {
  return {
    blockerReasons: [],
    coordinates: { latitude: 43.6, longitude: -79.3 },
    deliveryArea: 'Toronto',
    deliveryDate: '2026-05-27',
    deliverySession: 'DAY',
    deliveryStatus: 'ready',
    geocodeStatus: 'RESOLVED',
    health: 'normal',
    orderId: 'order-1',
    orderName: '#1001',
    phone: null,
    planningStatus: 'UNPLANNED',
    recipientName: 'Customer',
    routePlanId: null,
    routePlanName: null,
    serviceType: 'DELIVERY',
    shippingAddress: { address1: null, address2: null, city: null, countryCode: null, postalCode: null, province: null },
    sourceOrderId: '1001',
    sourceOrderNumber: '1001',
    sourcePlatform: 'WOOCOMMERCE',
    status: 'unfulfilled',
    stopId: 'stop-1',
    timeWindowEnd: null,
    timeWindowStart: null,
    ...overrides
  };
}

function exhaustedBulkNoResultDiagnostic(): NonNullable<CanonicalOrderDto['geocodeDiagnostics']> {
  return {
    attemptCount: 8,
    code: 'GEOCODER_NO_RESULT',
    messageKey: 'GEOCODER_NO_RESULT',
    ok: false,
    provider: null,
    queryShapes: [
      'structured_without_unit',
      'freeform',
      'structured_without_unit_no_city',
      'freeform_no_city',
      'structured_without_unit_no_postal',
      'freeform_no_postal',
      'structured_without_unit_no_city_no_postal',
      'freeform_no_city_no_postal'
    ],
    source: 'bulk_geocode',
    transient: false,
    updatedAt: '2026-06-03T11:17:01.859Z'
  };
}

function stop(deliveryStopId: string, sequence: number, status = 'PENDING', latitude: number | null = 43.6, longitude: number | null = -79.3): RouteStopDto {
  return {
    addressLabel: '100 King St W, Toronto, ON',
    coordinates: { latitude, longitude },
    deliveryArea: 'Toronto',
    deliveryStopId,
    orderId: `order-${deliveryStopId}`,
    orderName: `#100${sequence}`,
    recipientName: 'Customer',
    sequence,
    sourceOrderId: `source-${deliveryStopId}`,
    status
  };
}

function bootstrap(mode: BootstrapPayload['mode']): BootstrapPayload {
  return {
    appUrls: { dashboard: '', drivers: '', orders: '', routes: '', settings: '' },
    csrfToken: 'csrf',
    mapConfig: { allowedHosts: [], attribution: null, providerMode: null, status: 'not_configured', styleAudit: null, styleUrl: null },
    mode,
    routerConfig: { status: 'not_configured' },
    shopDomain: 'tenant.example.test'
  };
}
