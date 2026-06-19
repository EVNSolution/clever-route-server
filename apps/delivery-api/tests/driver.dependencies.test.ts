import type { PrismaClient } from '@prisma/client';
import { describe, expect, test } from 'vitest';

import {
  DEFAULT_DRIVER_PROOF_MEDIA_READ_ACCESS_TTL_SECONDS,
  DEFAULT_DRIVER_PROOF_MEDIA_RETENTION_DAYS,
  DEFAULT_DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND,
  DEFAULT_DRIVER_PROOF_MEDIA_SCANNER_BACKEND,
  DEFAULT_DRIVER_PROOF_MEDIA_STORAGE_BACKEND,
  loadDriverApiDependencies,
  loadDriverProofMediaReadAccessPolicy,
  loadDriverProofMediaRetentionPolicy
} from '../src/modules/driver/driver.dependencies.js';

describe('loadDriverApiDependencies', () => {
  test('leaves driver API disabled until JWT secret is configured', () => {
    const dependencies = loadDriverApiDependencies({ env: {}, prisma: {} as PrismaClient });

    expect(dependencies).toBeUndefined();
  });

  test('keeps local proof media storage as the default runtime backend', () => {
    const dependencies = loadDriverApiDependencies({
      env: {
        DRIVER_PROOF_MEDIA_STORAGE_DIR: '/tmp/clever-proof-media',
        JWT_SECRET: 'driver-secret'
      },
      prisma: {} as PrismaClient
    });

    expect(dependencies?.proofMediaService).toBeDefined();
    expect(dependencies?.driverTokenAccessRepository).toBeDefined();
  });

  test('keeps assigned route reads independent from driver OSRM runtime config', () => {
    const dependencies = loadDriverApiDependencies({
      env: {
        JWT_SECRET: 'driver-secret'
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
        JWT_SECRET: 'driver-secret'
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
          JWT_SECRET: 'driver-secret'
        },
        prisma: {} as PrismaClient
      })
    ).toThrow('DELIVERY_API_PUBLIC_URL is required when DRIVER_ROUTE_MAP_PREVIEW_ENABLED=true');

    expect(() =>
      loadDriverApiDependencies({
        env: {
          DELIVERY_API_PUBLIC_URL: 'https://delivery.example.com/api',
          DRIVER_ROUTE_MAP_PREVIEW_ENABLED: 'true',
          JWT_SECRET: 'driver-secret'
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
        JWT_SECRET: 'driver-secret'
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
        JWT_SECRET: 'driver-secret'
      },
      prisma: {} as PrismaClient
    });

    expect(dependencies?.proofMediaService).toBeDefined();
  });

  test('rejects incomplete S3 proof media storage configuration', () => {
    expect(() => loadDriverApiDependencies({
      env: {
        DRIVER_PROOF_MEDIA_STORAGE_BACKEND: 's3',
        JWT_SECRET: 'driver-secret'
      },
      prisma: {} as PrismaClient
    })).toThrow('DRIVER_PROOF_MEDIA_S3_BUCKET is required when DRIVER_PROOF_MEDIA_STORAGE_BACKEND=s3');
  });

  test('rejects unknown proof media storage backends', () => {
    expect(() => loadDriverApiDependencies({
      env: {
        DRIVER_PROOF_MEDIA_STORAGE_BACKEND: 'ftp',
        JWT_SECRET: 'driver-secret'
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
        JWT_SECRET: 'driver-secret'
      },
      prisma: {} as PrismaClient
    });

    expect(dependencies?.proofMediaService).toBeDefined();
  });

  test('rejects incomplete HTTP scanner configuration', () => {
    expect(() => loadDriverApiDependencies({
      env: {
        DRIVER_PROOF_MEDIA_SCANNER_BACKEND: 'http',
        JWT_SECRET: 'driver-secret'
      },
      prisma: {} as PrismaClient
    })).toThrow('DRIVER_PROOF_MEDIA_SCANNER_URL is required when DRIVER_PROOF_MEDIA_SCANNER_BACKEND=http');
  });

  test('rejects unknown proof media scanner backends', () => {
    expect(() => loadDriverApiDependencies({
      env: {
        DRIVER_PROOF_MEDIA_SCANNER_BACKEND: 'clamd',
        JWT_SECRET: 'driver-secret'
      },
      prisma: {} as PrismaClient
    })).toThrow('DRIVER_PROOF_MEDIA_SCANNER_BACKEND must be none or http');
  });

  test('rejects incomplete HTTP scan monitor configuration', () => {
    expect(() => loadDriverApiDependencies({
      env: {
        DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND: 'http',
        JWT_SECRET: 'driver-secret'
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
});
