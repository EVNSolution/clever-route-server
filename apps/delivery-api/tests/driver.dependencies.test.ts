import type { PrismaClient } from '@prisma/client';
import { describe, expect, test } from 'vitest';

import {
  DEFAULT_DRIVER_PROOF_MEDIA_READ_ACCESS_TTL_SECONDS,
  DEFAULT_DRIVER_PROOF_MEDIA_RETENTION_DAYS,
  loadDriverApiDependencies,
  loadDriverRouteGeometryProvider,
  loadDriverProofMediaReadAccessPolicy,
  loadDriverProofMediaRetentionPolicy
} from '../src/modules/driver/driver.dependencies.js';
import { OsrmRouteGeometryProvider } from '../src/modules/route-plans/osrm-route-geometry.client.js';

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

  test('keeps assigned route OSRM enrichment disabled until an explicit base URL is configured', () => {
    expect(loadDriverRouteGeometryProvider({})).toBeUndefined();
  });

  test('wires assigned route OSRM enrichment with driver-scoped runtime config', () => {
    const dependencies = loadDriverApiDependencies({
      env: {
        DRIVER_ROUTE_OSRM_BASE_URL: ' https://osrm.internal.example/ ',
        DRIVER_ROUTE_OSRM_TIMEOUT_MS: '2500',
        JWT_SECRET: 'driver-secret',
        OSRM_BASE_URL: 'https://admin-osrm.example'
      },
      prisma: {} as PrismaClient
    });

    const assignedRouteRepository = dependencies?.driverAssignedRouteService as
      | { routeGeometryProvider?: unknown }
      | undefined;
    expect(assignedRouteRepository?.routeGeometryProvider).toBeInstanceOf(OsrmRouteGeometryProvider);
  });

  test('reuses the admin OSRM base URL for assigned route enrichment when no driver override is configured', () => {
    expect(loadDriverRouteGeometryProvider({ OSRM_BASE_URL: 'https://osrm.internal.example' })).toBeInstanceOf(
      OsrmRouteGeometryProvider
    );
  });

  test('rejects invalid assigned route OSRM timeout config', () => {
    expect(() =>
      loadDriverRouteGeometryProvider({
        DRIVER_ROUTE_OSRM_BASE_URL: 'https://osrm.internal.example',
        DRIVER_ROUTE_OSRM_TIMEOUT_MS: '0'
      })
    ).toThrow('DRIVER_ROUTE_OSRM_TIMEOUT_MS must be a positive integer');
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
