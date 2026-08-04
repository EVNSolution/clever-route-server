import { describe, expect, test, vi } from 'vitest';

import { UvisClientError } from '../src/modules/uvis/uvis-contract.js';
import { UvisTelemetryWorker } from '../src/modules/uvis/uvis-telemetry.worker.js';

const now = new Date('2026-08-04T04:00:00.000Z');

describe('UvisTelemetryWorker', () => {
  test('maps company-wide readings only by exact registered provider device IDs and uses plate as validation', async () => {
    const harness = createHarness();
    harness.client.getLatestLocations.mockResolvedValue([
      locationReading({ deviceId: '01252738978', plateNumber: '다른번호' }),
      locationReading({ deviceId: 'unregistered', plateNumber: '경기88바9580' }),
      locationReading({ deviceId: 'unregistered', plateNumber: '없는차량' }),
    ]);
    harness.client.getLatestTemperatures.mockResolvedValue([
      temperatureReading({ deviceId: 'unregistered', plateNumber: '서울86바3800' }),
    ]);

    await harness.worker.runOnce();

    expect(harness.telemetryStore.recordSample).toHaveBeenCalledTimes(1);
    expect(harness.telemetryStore.recordSample).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'device-a',
      sourceDeviceIdentifier: '01252738978',
      sourceKind: 'VEHICLE_GPS',
      sourcePlate: '다른번호',
    }));
    expect(harness.pollStore.markSucceeded).toHaveBeenCalledTimes(2);
    expect(harness.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'location', matched: 1, received: 3, unmatched: 2 }),
      'UVIS telemetry poll completed',
    );
  });

  test('honors persisted poll cadence and releases a shared lease', async () => {
    const harness = createHarness({
      lastLocationStartedAt: new Date(now.getTime() - 10_000),
      lastTemperatureStartedAt: new Date(now.getTime() - 400_000),
    });
    await harness.worker.runOnce();
    expect(harness.client.getLatestLocations).not.toHaveBeenCalled();
    expect(harness.client.getLatestTemperatures).toHaveBeenCalledOnce();
    expect(harness.pollStore.releaseLease).toHaveBeenCalledWith({ leaseToken: 'lease-token', shopId: 'shop-id' });
  });

  test('records safe provider error codes without logging vendor requests or payloads', async () => {
    const harness = createHarness();
    harness.client.getLatestLocations.mockRejectedValue(new UvisClientError({
      code: 'AUTH_FAILED',
      message: 'safe failure',
      operation: 'location',
      transient: false,
    }));
    await harness.worker.runOnce();
    expect(harness.pollStore.markFailed).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'AUTH_FAILED',
      kind: 'location',
      shopId: 'shop-id',
    }));
    expect(harness.logger.error).toHaveBeenCalledWith(
      { errorCode: 'AUTH_FAILED', kind: 'location' },
      'UVIS telemetry poll failed',
    );
  });

  test('stops status writes after a lost lease', async () => {
    const harness = createHarness({ lastLocationStartedAt: null, lastTemperatureStartedAt: now });
    harness.pollStore.markStarted.mockResolvedValueOnce(false);

    await harness.worker.runOnce();

    expect(harness.client.getLatestLocations).not.toHaveBeenCalled();
    expect(harness.pollStore.markSucceeded).not.toHaveBeenCalled();
    expect(harness.pollStore.markFailed).not.toHaveBeenCalled();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      { kind: 'location' },
      'UVIS telemetry poll lost its lease',
    );
  });
});

function createHarness(lease: {
  lastLocationStartedAt: Date | null;
  lastTemperatureStartedAt: Date | null;
} = { lastLocationStartedAt: null, lastTemperatureStartedAt: null }) {
  const client = {
    getLatestLocations: vi.fn().mockResolvedValue([]),
    getLatestTemperatures: vi.fn().mockResolvedValue([]),
  };
  const pollStore = {
    claimLease: vi.fn().mockResolvedValue({ ...lease, shopId: 'shop-id' }),
    findShopAndDevices: vi.fn().mockResolvedValue({
      devices: [
        { deviceId: 'device-a', serialNumber: '012-5273-8978', vehicleId: 'vehicle-a', vehiclePlate: '서울86바3800' },
        { deviceId: 'device-b', serialNumber: '012-4083-5581', vehicleId: 'vehicle-b', vehiclePlate: '경기88바9580' },
      ],
      shopId: 'shop-id',
    }),
    markFailed: vi.fn().mockResolvedValue(true),
    markStarted: vi.fn().mockResolvedValue(true),
    markSucceeded: vi.fn().mockResolvedValue(true),
    releaseLease: vi.fn().mockResolvedValue(undefined),
  };
  const telemetryStore = {
    recordSample: vi.fn().mockResolvedValue({
      currentStatus: 'UPDATED',
      plateStatus: 'MATCHED',
      sampleId: 'sample-id',
      sampleStatus: 'RECORDED',
      shopId: 'shop-id',
      vehicleId: 'vehicle-id',
    }),
  };
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const worker = new UvisTelemetryWorker({
    appId: 'clever',
    client,
    leaseDurationMs: 120_000,
    locationPollIntervalMs: 60_000,
    logger,
    now: () => now,
    pollStore,
    shopDomain: 'dsv-demo.local',
    telemetryStore,
    temperaturePollIntervalMs: 300_000,
    tokenFactory: () => 'lease-token',
  });
  return { client, logger, pollStore, telemetryStore, worker };
}

function locationReading(overrides: Partial<ReturnType<typeof locationReadingBase>> = {}) {
  return { ...locationReadingBase(), ...overrides };
}

function locationReadingBase() {
  return {
    dayDistanceKm: 10,
    deviceId: 'external-device',
    gpsSpeedKph: 20,
    ignitionOn: true,
    latitude: 37.5,
    longitude: 127,
    plateNumber: '서울86바3800',
    recordedAt: now,
  };
}

function temperatureReading(overrides: Partial<ReturnType<typeof temperatureReadingBase>> = {}) {
  return { ...temperatureReadingBase(), ...overrides };
}

function temperatureReadingBase() {
  return {
    deviceId: 'external-device',
    latitude: 37.5,
    longitude: 127,
    plateNumber: '서울86바3800',
    recordedAt: now,
    temperatureA: 2.5,
    temperatureB: 4.7,
  };
}
