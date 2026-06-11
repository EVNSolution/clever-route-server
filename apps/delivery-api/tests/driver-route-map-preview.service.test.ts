import { describe, expect, test, vi } from 'vitest';

import type {
  DriverAssignedRoute,
  DriverAssignedRouteServiceContract
} from '../src/modules/driver/driver-assigned-route.types.js';
import {
  createRouteSequenceChecksum,
  DriverRouteMapPreviewService
} from '../src/modules/driver/driver-route-map-preview.service.js';
import { renderDriverRouteMapPreviewPng } from '../src/modules/driver/driver-route-map-preview.renderer.js';

const now = new Date('2026-05-12T06:40:00.000Z');
const route: DriverAssignedRoute = {
  deliveryDate: '2026-05-12',
  id: 'route-plan-id',
  name: 'Tuesday AM Route',
  routeGeometry: {
    coordinates: [
      [-79.3832, 43.6532],
      [-79.3817, 43.6487],
      [-79.3909, 43.6509]
    ],
    type: 'LineString'
  },
  routeMapPreview: null,
  routeMetrics: { distanceMeters: 3250, durationSeconds: 840 },
  routeStopPoints: [
    {
      deliveryStopId: 'stop-id-1',
      inputCoordinates: [-79.3817, 43.6487],
      name: 'King Street West',
      sequence: 1,
      snapDistanceMeters: 3.5,
      snappedCoordinates: [-79.3818, 43.6488]
    },
    {
      deliveryStopId: 'stop-id-2',
      inputCoordinates: [-79.3909, 43.6509],
      name: 'Queen Street West',
      sequence: 2,
      snapDistanceMeters: 8.2,
      snappedCoordinates: [-79.391, 43.651]
    }
  ],
  shopDomain: 'example.myshopify.com',
  stops: [
    {
      address: {
        address1: '100 King St W',
        address2: null,
        city: 'Toronto',
        countryCode: 'CA',
        postalCode: 'M5X 1A9',
        province: 'ON'
      },
      coordinates: { latitude: 43.6487, longitude: -79.3817 },
      deliveryStopId: 'stop-id-1',
      normalizedPaymentStatus: 'CASH_COLLECT_REQUIRED',
      orderName: '#1001',
      phone: '+14165550123',
      recipientName: 'Recipient One',
      sequence: 1,
      status: 'ASSIGNED'
    },
    {
      address: {
        address1: '200 Queen St W',
        address2: null,
        city: 'Toronto',
        countryCode: 'CA',
        postalCode: 'M5V 1Z2',
        province: 'ON'
      },
      coordinates: { latitude: 43.6509, longitude: -79.3909 },
      deliveryStopId: 'stop-id-2',
      normalizedPaymentStatus: 'PAID_CONFIRMED',
      orderName: '#1002',
      phone: '+14165550124',
      recipientName: 'Recipient Two',
      sequence: 2,
      status: 'ASSIGNED'
    }
  ],
  timezone: 'America/Toronto'
};

describe('Driver route map preview service', () => {
  test('creates a short-lived signed preview URL without leaking route/customer data in the URL', () => {
    const service = createService();

    const preview = service.createRouteMapPreview({
      baseUrl: 'https://delivery.example.com/',
      driverId: 'driver-id',
      route,
      shopDomain: 'example.myshopify.com'
    });

    expect(preview).not.toBeNull();
    expect(preview?.contentType).toBe('image/png');
    expect(preview?.width).toBe(720);
    expect(preview?.height).toBe(430);
    expect(preview?.generatedAt).toBe('2026-05-12T06:40:00.000Z');
    expect(preview?.expiresAt).toBe('2026-05-12T06:50:00.000Z');
    expect(preview?.routeSequenceChecksum).toBe(createRouteSequenceChecksum(route));
    expect(preview?.altText).toBe('Static route preview for 2 stops.');
    expect(preview?.imageUrl).toMatch(/^https:\/\/delivery\.example\.com\/driver\/route-map-preview\/static\?previewId=[A-Za-z0-9_-]+&expires=\d+&signature=[A-Za-z0-9_-]+$/u);
    expect(preview?.imageUrl).not.toContain('route-plan-id');
    expect(preview?.imageUrl).not.toContain('Recipient');
    expect(preview?.imageUrl).not.toContain('King');
    expect(preview?.imageUrl).not.toContain('+1416');
  });

  test('renders a signed preview image only while the URL is valid and route checksum still matches', async () => {
    const getAssignedRoute = vi.fn(() => Promise.resolve({ status: 'ASSIGNED_ROUTE' as const, route }));
    const service = createService({ getAssignedRoute });
    const preview = service.createRouteMapPreview({
      baseUrl: 'https://delivery.example.com',
      driverId: 'driver-id',
      route,
      shopDomain: 'example.myshopify.com'
    });
    expect(preview).not.toBeNull();
    const url = new URL(preview?.imageUrl ?? '');

    const image = await service.readRouteMapPreviewImage({
      expires: url.searchParams.get('expires') ?? '',
      previewId: url.searchParams.get('previewId') ?? '',
      signature: url.searchParams.get('signature') ?? ''
    });

    expect(image?.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(getAssignedRoute).toHaveBeenCalledWith({
      driverId: 'driver-id',
      routeContext: 'route-plan-id',
      shopDomain: 'example.myshopify.com'
    });

    const expired = await service.readRouteMapPreviewImage({
      expires: String(now.getTime() - 1),
      previewId: url.searchParams.get('previewId') ?? '',
      signature: url.searchParams.get('signature') ?? ''
    });
    expect(expired).toBeNull();

    const tampered = await service.readRouteMapPreviewImage({
      expires: url.searchParams.get('expires') ?? '',
      previewId: url.searchParams.get('previewId') ?? '',
      signature: 'tampered-signature'
    });
    expect(tampered).toBeNull();
  });

  test('propagates assigned-route read failures instead of masking them as unavailable previews', async () => {
    const backendFailure = new Error('assigned route repository unavailable');
    const service = createService({
      getAssignedRoute: vi.fn(() => Promise.reject(backendFailure))
    });
    const preview = service.createRouteMapPreview({
      baseUrl: 'https://delivery.example.com',
      driverId: 'driver-id',
      route,
      shopDomain: 'example.myshopify.com'
    });
    const url = new URL(preview?.imageUrl ?? '');

    await expect(service.readRouteMapPreviewImage({
      expires: url.searchParams.get('expires') ?? '',
      previewId: url.searchParams.get('previewId') ?? '',
      signature: url.searchParams.get('signature') ?? ''
    })).rejects.toThrow(backendFailure);
  });

  test('returns null instead of fake previews when geometry is missing or degenerate', () => {
    const service = createService();
    expect(service.createRouteMapPreview({
      baseUrl: 'https://delivery.example.com',
      driverId: 'driver-id',
      route: { ...route, routeGeometry: null },
      shopDomain: 'example.myshopify.com'
    })).toBeNull();

    expect(renderDriverRouteMapPreviewPng({
      ...route,
      routeGeometry: {
        coordinates: [
          [-79.3832, 43.6532],
          [-79.3832, 43.6532]
        ],
        type: 'LineString'
      },
      routeStopPoints: [],
      stops: route.stops.map((stop) => ({ ...stop, coordinates: { latitude: null, longitude: null } }))
    })).toBeNull();
  });

  test('keeps preview URLs valid when route geometry is recalculated for the same stop sequence', async () => {
    const recalculatedRoute: DriverAssignedRoute = {
      ...route,
      routeGeometry: {
        coordinates: [
          [-79.3832, 43.6532],
          [-79.382, 43.649],
          [-79.3909, 43.6509]
        ],
        type: 'LineString'
      },
      routeStopPoints: route.routeStopPoints.map((stopPoint) => ({
        ...stopPoint,
        snapDistanceMeters: (stopPoint.snapDistanceMeters ?? 0) + 0.25,
        snappedCoordinates: stopPoint.snappedCoordinates === null
          ? null
          : [stopPoint.snappedCoordinates[0] + 0.00001, stopPoint.snappedCoordinates[1] + 0.00001]
      }))
    };
    const getAssignedRoute = vi.fn(() => Promise.resolve({ status: 'ASSIGNED_ROUTE' as const, route: recalculatedRoute }));
    const service = createService({ getAssignedRoute });
    const preview = service.createRouteMapPreview({
      baseUrl: 'https://delivery.example.com',
      driverId: 'driver-id',
      route,
      shopDomain: 'example.myshopify.com'
    });
    const url = new URL(preview?.imageUrl ?? '');

    expect(createRouteSequenceChecksum(recalculatedRoute)).toBe(createRouteSequenceChecksum(route));
    await expect(service.readRouteMapPreviewImage({
      expires: url.searchParams.get('expires') ?? '',
      previewId: url.searchParams.get('previewId') ?? '',
      signature: url.searchParams.get('signature') ?? ''
    })).resolves.not.toBeNull();
  });

  test('changes the checksum when stop order changes', () => {
    const changedRoute: DriverAssignedRoute = {
      ...route,
      stops: route.stops.map((stop) => ({
        ...stop,
        sequence: stop.sequence === 1 ? 2 : 1
      }))
    };

    expect(createRouteSequenceChecksum(changedRoute)).not.toBe(createRouteSequenceChecksum(route));
  });
});

function createService(input: {
  getAssignedRoute?: DriverAssignedRouteServiceContract['getAssignedRoute'];
} = {}): DriverRouteMapPreviewService {
  return new DriverRouteMapPreviewService({
    assignedRouteService: {
      getAssignedRoute: input.getAssignedRoute ?? (() => Promise.resolve({ status: 'ASSIGNED_ROUTE', route }))
    },
    jwtSecret: 'driver-secret',
    now: () => now,
    ttlSeconds: 600
  });
}
