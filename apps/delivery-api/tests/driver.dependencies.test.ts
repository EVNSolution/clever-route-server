import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { DsvAssignmentCommandService } from '../src/modules/dsv/dsv-assignment-command.service.js';
import {
  DEFAULT_DRIVER_PROOF_MEDIA_READ_ACCESS_TTL_SECONDS,
  DEFAULT_DRIVER_EVENT_ATTEMPT_RETENTION_DAYS,
  DEFAULT_DRIVER_PROOF_MEDIA_RETENTION_DAYS,
  DEFAULT_DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND,
  DEFAULT_DRIVER_PROOF_MEDIA_SCANNER_BACKEND,
  DEFAULT_DRIVER_PROOF_MEDIA_STORAGE_BACKEND,
  loadDriverApiDependencies,
  loadDriverEventAttemptRetentionPolicy,
  loadDriverProofMediaReadAccessPolicy,
  loadDriverProofMediaRepositoryStorageOptions,
  loadDriverProofMediaRetentionPolicy
} from '../src/modules/driver/driver.dependencies.js';
import type { RouteGroupingService } from '../src/modules/route-grouping/route-grouping.types.js';

describe('loadDriverApiDependencies', () => {
  test('fails startup on an invalid route completion invariant mode even when driver auth is disabled', () => {
    expect(() => loadDriverApiDependencies({
      env: { DRIVER_ROUTE_COMPLETION_INVARIANT_MODE: 'unsafe' },
      prisma: {} as PrismaClient
    })).toThrow('DRIVER_ROUTE_COMPLETION_INVARIANT_MODE must be OBSERVE, GUARDED, or FULL');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('leaves driver API disabled until JWT secret is configured', () => {
    const dependencies = loadDriverApiDependencies({ env: {}, prisma: {} as PrismaClient });

    expect(dependencies).toBeUndefined();
  });

  test('rejects a configured JWT secret shorter than 32 characters', () => {
    expect(() => loadDriverApiDependencies({
      env: { JWT_SECRET: 'short-secret' },
      prisma: {} as PrismaClient
    })).toThrow('JWT_SECRET must contain at least 32 characters');
  });

  test('keeps local proof media storage as the default runtime backend', () => {
    const dependencies = loadDriverApiDependencies({
      env: {
        DRIVER_PROOF_MEDIA_STORAGE_DIR: '/tmp/clever-proof-media',
        JWT_SECRET: 'test-driver-jwt-secret-32-characters'
      },
      prisma: {} as PrismaClient
    });

    expect(dependencies?.proofMediaService).toBeDefined();
    expect(dependencies?.driverTokenAccessRepository).toBeDefined();
    expect(dependencies?.proofMediaService).toMatchObject({ reservationWritesEnabled: false });
  });

  test('enables proof reservation writes only after an explicit rollout gate', () => {
    const dependencies = loadDriverApiDependencies({
      env: {
        DRIVER_PROOF_MEDIA_RESERVATIONS_ENABLED: 'true',
        JWT_SECRET: 'test-driver-jwt-secret-32-characters'
      },
      prisma: {} as PrismaClient
    });

    expect(dependencies?.proofMediaService).toMatchObject({ reservationWritesEnabled: true });
  });

  test('keeps assigned route reads independent from driver OSRM runtime config', () => {
    const dependencies = loadDriverApiDependencies({
      env: {
        JWT_SECRET: 'test-driver-jwt-secret-32-characters'
      },
      prisma: {} as PrismaClient
    });

    const assignedRouteRepository = dependencies?.driverAssignedRouteService as
      | { routeGeometryProvider?: unknown }
      | undefined;
    expect(assignedRouteRepository?.routeGeometryProvider).toBeUndefined();
  });

  test('wires route map preview only with an explicit public delivery API origin', () => {
    const dependencies = loadDriverApiDependencies({
      env: {
        DELIVERY_API_PUBLIC_URL: 'https://delivery.example.com/',
        DRIVER_ROUTE_MAP_PREVIEW_ENABLED: 'true',
        DRIVER_ROUTE_MAP_PREVIEW_SECRET: 'preview-secret',
        DRIVER_ROUTE_MAP_PREVIEW_TTL_SECONDS: '120',
        JWT_SECRET: 'test-driver-jwt-secret-32-characters'
      },
      prisma: {} as PrismaClient
    });

    expect(dependencies?.driverRouteMapPreviewService).toBeDefined();
    expect(dependencies?.driverRouteMapPreviewBaseUrl).toBe('https://delivery.example.com');
  });

  test('rejects route map preview when public origin config is missing or not an origin', () => {
    expect(() =>
      loadDriverApiDependencies({
        env: {
          DRIVER_ROUTE_MAP_PREVIEW_ENABLED: 'true',
          JWT_SECRET: 'test-driver-jwt-secret-32-characters'
        },
        prisma: {} as PrismaClient
      })
    ).toThrow('DELIVERY_API_PUBLIC_URL is required when DRIVER_ROUTE_MAP_PREVIEW_ENABLED=true');

    expect(() =>
      loadDriverApiDependencies({
        env: {
          DELIVERY_API_PUBLIC_URL: 'https://delivery.example.com/api',
          DRIVER_ROUTE_MAP_PREVIEW_ENABLED: 'true',
          JWT_SECRET: 'test-driver-jwt-secret-32-characters'
        },
        prisma: {} as PrismaClient
      })
    ).toThrow('DELIVERY_API_PUBLIC_URL must be an http(s) origin when DRIVER_ROUTE_MAP_PREVIEW_ENABLED=true');
  });

  test('keeps proof media storage/scanner defaults explicit and scanner hooks disabled', () => {
    expect(DEFAULT_DRIVER_PROOF_MEDIA_STORAGE_BACKEND).toBe('local');
    expect(DEFAULT_DRIVER_PROOF_MEDIA_SCANNER_BACKEND).toBe('none');
    expect(DEFAULT_DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND).toBe('none');

    const dependencies = loadDriverApiDependencies({
      env: {
        DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND: ' ',
        DRIVER_PROOF_MEDIA_SCANNER_BACKEND: ' ',
        JWT_SECRET: 'test-driver-jwt-secret-32-characters'
      },
      prisma: {} as PrismaClient
    });
    const proofMediaService = dependencies?.proofMediaService as
      | { scanMonitor?: unknown; scanner?: unknown }
      | undefined;

    expect(proofMediaService?.scanner).toBeUndefined();
    expect(proofMediaService?.scanMonitor).toBeUndefined();
  });

  test('wires S3 proof media storage when explicitly configured', () => {
    const dependencies = loadDriverApiDependencies({
      env: {
        DRIVER_PROOF_MEDIA_S3_ACCESS_KEY_ID: 'AKIA_TEST',
        DRIVER_PROOF_MEDIA_S3_BUCKET: 'clever-proof-media',
        DRIVER_PROOF_MEDIA_S3_REGION: 'ap-northeast-2',
        DRIVER_PROOF_MEDIA_S3_SECRET_ACCESS_KEY: 'secret-test-key',
        DRIVER_PROOF_MEDIA_STORAGE_BACKEND: 's3',
        JWT_SECRET: 'test-driver-jwt-secret-32-characters'
      },
      prisma: {} as PrismaClient
    });

    expect(dependencies?.proofMediaService).toBeDefined();
  });

  test('exposes the same S3 DELETE backend to HTTP runtime and retention cleanup', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetchMock);
    const options = loadDriverProofMediaRepositoryStorageOptions({
      DRIVER_PROOF_MEDIA_S3_ACCESS_KEY_ID: 'AKIA_TEST',
      DRIVER_PROOF_MEDIA_S3_BUCKET: 'clever-proof-media',
      DRIVER_PROOF_MEDIA_S3_ENDPOINT: 'https://objects.example.test',
      DRIVER_PROOF_MEDIA_S3_FORCE_PATH_STYLE: 'true',
      DRIVER_PROOF_MEDIA_S3_REGION: 'ap-northeast-2',
      DRIVER_PROOF_MEDIA_S3_SECRET_ACCESS_KEY: 'secret-test-key',
      DRIVER_PROOF_MEDIA_STORAGE_BACKEND: 's3'
    });
    if (options.storage === undefined) throw new Error('expected S3 storage');
    await expect(options.storage.remove('driver-proof/safe/proof.jpg', new AbortController().signal))
      .resolves.toBe('removed');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://objects.example.test/clever-proof-media/driver-proof/safe/proof.jpg',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  test('rejects incomplete S3 proof media storage configuration', () => {
    expect(() => loadDriverApiDependencies({
      env: {
        DRIVER_PROOF_MEDIA_STORAGE_BACKEND: 's3',
        JWT_SECRET: 'test-driver-jwt-secret-32-characters'
      },
      prisma: {} as PrismaClient
    })).toThrow('DRIVER_PROOF_MEDIA_S3_BUCKET is required when DRIVER_PROOF_MEDIA_STORAGE_BACKEND=s3');
  });

  test('rejects unknown proof media storage backends', () => {
    expect(() => loadDriverApiDependencies({
      env: {
        DRIVER_PROOF_MEDIA_STORAGE_BACKEND: 'ftp',
        JWT_SECRET: 'test-driver-jwt-secret-32-characters'
      },
      prisma: {} as PrismaClient
    })).toThrow('DRIVER_PROOF_MEDIA_STORAGE_BACKEND must be local or s3');
  });

  test('wires HTTP scanner and scan monitor when explicitly configured', () => {
    const dependencies = loadDriverApiDependencies({
      env: {
        DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND: 'http',
        DRIVER_PROOF_MEDIA_SCAN_MONITOR_URL: 'https://alerts.internal.example/proof-media-scan',
        DRIVER_PROOF_MEDIA_SCANNER_BACKEND: 'http',
        DRIVER_PROOF_MEDIA_SCANNER_URL: 'https://scanner.internal.example/scan',
        JWT_SECRET: 'test-driver-jwt-secret-32-characters'
      },
      prisma: {} as PrismaClient
    });

    expect(dependencies?.proofMediaService).toBeDefined();
  });

  test('rejects incomplete HTTP scanner configuration', () => {
    expect(() => loadDriverApiDependencies({
      env: {
        DRIVER_PROOF_MEDIA_SCANNER_BACKEND: 'http',
        JWT_SECRET: 'test-driver-jwt-secret-32-characters'
      },
      prisma: {} as PrismaClient
    })).toThrow('DRIVER_PROOF_MEDIA_SCANNER_URL is required when DRIVER_PROOF_MEDIA_SCANNER_BACKEND=http');
  });

  test('rejects unknown proof media scanner backends', () => {
    expect(() => loadDriverApiDependencies({
      env: {
        DRIVER_PROOF_MEDIA_SCANNER_BACKEND: 'clamd',
        JWT_SECRET: 'test-driver-jwt-secret-32-characters'
      },
      prisma: {} as PrismaClient
    })).toThrow('DRIVER_PROOF_MEDIA_SCANNER_BACKEND must be none or http');
  });

  test('rejects incomplete HTTP scan monitor configuration', () => {
    expect(() => loadDriverApiDependencies({
      env: {
        DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND: 'http',
        JWT_SECRET: 'test-driver-jwt-secret-32-characters'
      },
      prisma: {} as PrismaClient
    })).toThrow('DRIVER_PROOF_MEDIA_SCAN_MONITOR_URL is required when DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND=http');
  });

  test('loads proof media retention policy from runtime env with a default', () => {
    expect(loadDriverProofMediaRetentionPolicy({})).toEqual({
      retentionDays: DEFAULT_DRIVER_PROOF_MEDIA_RETENTION_DAYS
    });
    expect(loadDriverProofMediaRetentionPolicy({ DRIVER_PROOF_MEDIA_RETENTION_DAYS: '30' })).toEqual({
      retentionDays: 30
    });
  });

  test('keeps durable driver event attempt evidence for 90 days by default', () => {
    expect(DEFAULT_DRIVER_EVENT_ATTEMPT_RETENTION_DAYS).toBe(90);
    expect(loadDriverEventAttemptRetentionPolicy({})).toEqual({ retentionDays: 90 });
    expect(loadDriverEventAttemptRetentionPolicy({ DRIVER_EVENT_ATTEMPT_RETENTION_DAYS: '120' }))
      .toEqual({ retentionDays: 120 });
    expect(() => loadDriverEventAttemptRetentionPolicy({ DRIVER_EVENT_ATTEMPT_RETENTION_DAYS: '89' }))
      .toThrow('DRIVER_EVENT_ATTEMPT_RETENTION_DAYS must be at least 90');
  });

  test('rejects invalid proof media retention days', () => {
    expect(() => loadDriverProofMediaRetentionPolicy({ DRIVER_PROOF_MEDIA_RETENTION_DAYS: '0' })).toThrow(
      'DRIVER_PROOF_MEDIA_RETENTION_DAYS must be a positive integer'
    );
  });

  test('loads proof media read access TTL from runtime env with a short-lived default', () => {
    expect(loadDriverProofMediaReadAccessPolicy({})).toEqual({
      readAccessTtlSeconds: DEFAULT_DRIVER_PROOF_MEDIA_READ_ACCESS_TTL_SECONDS
    });
    expect(loadDriverProofMediaReadAccessPolicy({ DRIVER_PROOF_MEDIA_READ_ACCESS_TTL_SECONDS: '120' })).toEqual({
      readAccessTtlSeconds: 120
    });
  });

  test('rejects invalid proof media read access TTL seconds', () => {
    expect(() => loadDriverProofMediaReadAccessPolicy({ DRIVER_PROOF_MEDIA_READ_ACCESS_TTL_SECONDS: '0' })).toThrow(
      'DRIVER_PROOF_MEDIA_READ_ACCESS_TTL_SECONDS must be a positive integer'
    );
  });

  test('wires driver seller order assignment commands through the DSV kernel', async () => {
    const routeOptimizationScheduler = { schedule: vi.fn() };
    const saveDraft = vi.fn(() => {
      throw new Error('legacy direct assignment path should not be used');
    });
    const routeGroupingService = {
      getGrouping: vi.fn(() => Promise.resolve({
        assignments: [
          {
            addressLabel: '100 Test Rd',
            assignedDriverId: 'driver-1',
            assignedPolygonId: null,
            assignmentStatus: 'ASSIGNED',
            coordinates: { latitude: null, longitude: null },
            deliveryStopId: 'stop-1',
            email: null,
            itemCount: 1,
            orderId: 'order-1',
            orderName: '#1001',
            phone: null,
            recipientName: 'Recipient',
            sourceOrderId: 'seller-order-1',
            sourceSequence: 1
          }
        ],
        children: [],
        id: 'grouping-1',
        updatedAt: '2026-07-22T00:00:00.000Z'
      })),
      saveDraft
    } as unknown as RouteGroupingService;
    const prisma = {
      routeGroupingChildVersion: {
        findFirst: vi.fn(() => Promise.resolve({
          groupingId: 'grouping-1',
          routePlan: { vehicleId: 'vehicle-1' }
        }))
      }
    } as unknown as PrismaClient;
    const acquire = vi.spyOn(DsvAssignmentCommandService.prototype, 'acquire').mockResolvedValue({
      assignmentStatus: 'ASSIGNED',
      auditEventId: 'audit-1',
      commandId: 'command-1',
      etaStatus: 'PENDING',
      newRouteVersionId: 'route-version-2',
      previousRouteVersionId: 'route-version-1',
      receiptId: 'receipt-1',
      routePlanId: 'route-1',
      sellerOrderId: 'order-1'
    });
    const dependencies = loadDriverApiDependencies({
      env: { JWT_SECRET: 'test-driver-jwt-secret-32-characters' },
      prisma,
      routeGroupingService,
      routeOptimizationScheduler
    });

    await expect(dependencies?.driverSellerOrderAssignmentService?.acquire({
      accountId: 'account-1',
      commandId: 'command-1',
      driverId: 'driver-1',
      expectedVersion: 'route-version-1',
      orderId: 'order-1',
      routePlanId: 'route-1',
      shopDomain: 'example.myshopify.com',
      shopId: 'shop-1'
    })).resolves.toMatchObject({
      newRouteVersionId: 'route-version-2',
      order: { orderId: 'order-1', sellerOrderKey: 'seller-order-1' },
      receiptId: 'receipt-1'
    });

    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 'command-1',
      driverId: 'driver-1',
      sellerOrderId: 'order-1',
      shopDomain: 'example.myshopify.com'
    }));
    const assignmentCommands = (dependencies?.driverDeliverySpaceService as unknown as {
      assignmentCommands: { routeOptimizationScheduler?: unknown };
    } | undefined)?.assignmentCommands;
    expect(assignmentCommands?.routeOptimizationScheduler).toBe(routeOptimizationScheduler);
    expect(saveDraft).not.toHaveBeenCalled();
  });
});
