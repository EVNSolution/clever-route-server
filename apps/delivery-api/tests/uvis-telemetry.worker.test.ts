import { describe, expect, test, vi } from 'vitest';

import { UvisClientError, type UvisLocationReading } from '../src/modules/uvis/uvis-contract.js';
import { UvisTelemetryWorker } from '../src/modules/uvis/uvis-telemetry.worker.js';

const now = new Date('2026-08-04T04:00:00.000Z');

describe('UvisTelemetryWorker', () => {
  test('maps company-wide readings by unique configured serial first and uses plate as validation', async () => {
    const harness = createHarness();
    harness.client.getLatestLocations.mockResolvedValue([
      locationReading({ deviceId: '01252738978', plateNumber: '다른번호' }),
      locationReading({ deviceId: 'unregistered', plateNumber: '경기88바9580' }),
      locationReading({ deviceId: 'unregistered', plateNumber: '없는차량' }),
    ]);
    harness.client.getLatestTemperatures.mockResolvedValue([]);

    await harness.worker.runOnce();

    expect(harness.telemetryStore.recordSample).toHaveBeenCalledTimes(2);
    expect(harness.telemetryStore.recordSample).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'device-a',
      sourceDeviceIdentifier: '01252738978',
      sourceKind: 'VEHICLE_GPS',
      sourcePlate: '다른번호',
    }));
    expect(harness.telemetryStore.recordSample).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'device-b',
      sourceKind: 'VEHICLE_GPS',
    }));
    expect(harness.pollStore.markSucceeded).toHaveBeenCalledTimes(2);
    expect(harness.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'location', matched: 2, received: 3, unmatched: 1 }),
      'UVIS telemetry poll completed',
    );
  });

  test('falls back to a unique configured vehicle plate when provider serials do not match registered installations', async () => {
    const harness = createHarness();
    harness.client.getLatestLocations.mockResolvedValue([
      locationReading({ deviceId: '240835581', plateNumber: '경기88바9580' }),
    ]);

    await harness.worker.runOnce();

    expect(harness.telemetryStore.recordSample).toHaveBeenCalledTimes(1);
    expect(harness.telemetryStore.recordSample).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'device-b',
      sourceKind: 'VEHICLE_GPS',
    }));
  });

  test('rejects a mapped reading when unique serial and unique plate point to different configured devices', async () => {
    const harness = createHarness();
    harness.client.getLatestLocations.mockResolvedValue([
      locationReading({ deviceId: '01252738978', plateNumber: '경기88바9580' }),
    ]);

    await harness.worker.runOnce();

    expect(harness.telemetryStore.recordSample).not.toHaveBeenCalled();
    expect(harness.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'location', matched: 0, received: 1, unmatched: 1 }),
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

  test('does not skip a poll when the runtime timer reaches the interval boundary a few milliseconds early', async () => {
    const harness = createHarness({
      lastLocationStartedAt: new Date(now.getTime() - 59_999),
      lastTemperatureStartedAt: now,
    });

    await harness.worker.runOnce();

    expect(harness.client.getLatestLocations).toHaveBeenCalledOnce();
    expect(harness.client.getLatestTemperatures).not.toHaveBeenCalled();
  });

  test('backs dormant location polling off to the heartbeat while temperature cadence stays active', async () => {
    const harness = createHarness({
      activeProtectionEndedAt: new Date('2026-08-03T22:30:00.000Z'),
      activity: 'DORMANT',
      lastLocationStartedAt: new Date(now.getTime() - 120_000),
      lastTemperatureStartedAt: new Date(now.getTime() - 400_000),
    });
    await harness.worker.runOnce();
    expect(harness.client.getLatestLocations).not.toHaveBeenCalled();
    expect(harness.client.getLatestTemperatures).toHaveBeenCalledOnce();
  });

  test('forces active location cadence during the one-hour preparation window after restart', async () => {
    const preparationNow = new Date('2026-08-03T22:30:00.000Z'); // 07:30 Asia/Seoul, exactly one hour before 08:30 loading.
    const harness = createHarness({
      activity: 'DORMANT',
      lastLocationStartedAt: new Date(preparationNow.getTime() - 120_000),
      lastTemperatureStartedAt: new Date(preparationNow.getTime() - 120_000),
    }, {
      loadingStartTime: '08:30',
      now: preparationNow,
    });

    await harness.worker.runOnce();

    expect(harness.pollStore.forceActiveForPreparationWindow).toHaveBeenCalledWith({
      leaseToken: 'lease-token',
      shopId: 'shop-id',
    });
    expect(harness.client.getLatestLocations).toHaveBeenCalledOnce();
    expect(harness.client.getLatestTemperatures).not.toHaveBeenCalled();
  });

  test('continues ACTIVE after loading time until the latest final ETA', async () => {
    const afterLoadingBeforeEta = new Date('2026-08-03T23:00:00.000Z'); // 08:00 Asia/Seoul.
    const harness = createHarness({
      activity: 'DORMANT',
      lastLocationStartedAt: new Date(afterLoadingBeforeEta.getTime() - 120_000),
      lastTemperatureStartedAt: new Date(afterLoadingBeforeEta.getTime() - 120_000),
    }, {
      latestFinalEstimatedArrivalAt: new Date('2026-08-04T00:30:00.000Z'), // 09:30 Asia/Seoul.
      loadingStartTime: '07:30',
      now: afterLoadingBeforeEta,
    });

    await harness.worker.runOnce();

    expect(harness.pollStore.forceActiveForPreparationWindow).toHaveBeenCalledOnce();
    expect(harness.client.getLatestLocations).toHaveBeenCalledOnce();
    expect(harness.client.getLatestTemperatures).not.toHaveBeenCalled();
  });

  test('starts stopped grace fresh at the latest final ETA without using ETA as stopped proof', async () => {
    const eta = new Date('2026-08-04T00:30:00.000Z');
    const harness = createHarness({
      activeProtectionEndedAt: null,
      activity: 'DORMANT',
      lastLocationStartedAt: null,
      lastTemperatureStartedAt: eta,
    }, {
      latestFinalEstimatedArrivalAt: eta,
      loadingStartTime: '07:30',
      now: eta,
    });
    harness.client.getLatestLocations.mockResolvedValue([
      locationReading({ deviceId: '01252738978', gpsSpeedKph: 1, ignitionOn: false }),
      locationReading({ deviceId: '01240835581', gpsSpeedKph: 0, ignitionOn: false, plateNumber: '경기88바9580' }),
    ]);

    await harness.worker.runOnce();

    expect(harness.pollStore.markActiveProtectionEnded).toHaveBeenCalledWith({
      leaseToken: 'lease-token',
      protectionEndedAt: eta,
      shopId: 'shop-id',
    });
    expect(harness.pollStore.recordLocationActivitySignal).toHaveBeenCalledWith(expect.objectContaining({
      allConfiguredVehiclesStopped: true,
      now: eta,
    }));
  });

  test('handles midnight-wrapping preparation windows and resets stale dormancy at loading time', async () => {
    const midnightWindow = createHarness({
      activity: 'DORMANT',
      lastLocationStartedAt: new Date('2026-08-03T14:58:00.000Z'),
      lastTemperatureStartedAt: new Date('2026-08-03T14:58:00.000Z'),
    }, {
      loadingStartTime: '00:30',
      now: new Date('2026-08-03T15:00:00.000Z'), // 00:00 Asia/Seoul.
    });

    await midnightWindow.worker.runOnce();

    expect(midnightWindow.pollStore.forceActiveForPreparationWindow).toHaveBeenCalledOnce();
    expect(midnightWindow.client.getLatestLocations).toHaveBeenCalledOnce();

    const exactLoadingTime = createHarness({
      activity: 'DORMANT',
      lastLocationStartedAt: new Date('2026-08-03T15:28:00.000Z'),
      lastTemperatureStartedAt: new Date('2026-08-03T15:28:00.000Z'),
    }, {
      loadingStartTime: '00:30',
      now: new Date('2026-08-03T15:30:00.000Z'), // 00:30 Asia/Seoul.
    });

    await exactLoadingTime.worker.runOnce();

    expect(exactLoadingTime.pollStore.forceActiveForPreparationWindow).not.toHaveBeenCalled();
    expect(exactLoadingTime.pollStore.markActiveProtectionEnded).toHaveBeenCalledWith({
      leaseToken: 'lease-token',
      protectionEndedAt: new Date('2026-08-03T15:30:00.000Z'),
      shopId: 'shop-id',
    });
    expect(exactLoadingTime.client.getLatestLocations).toHaveBeenCalledOnce();
    expect(exactLoadingTime.client.getLatestTemperatures).not.toHaveBeenCalled();
  });

  test('starts a fresh stopped grace window at loading time after preparation forcing', async () => {
    const loadingNow = new Date('2026-08-03T22:30:00.000Z'); // 07:30 Asia/Seoul.
    const harness = createHarness({
      activity: 'ACTIVE',
      lastLocationStartedAt: null,
      lastTemperatureStartedAt: loadingNow,
    }, {
      loadingStartTime: '07:30',
      now: loadingNow,
    });
    harness.client.getLatestLocations.mockResolvedValue([
      locationReading({ deviceId: '01252738978', gpsSpeedKph: 1, ignitionOn: false }),
      locationReading({ deviceId: '01240835581', gpsSpeedKph: 0, ignitionOn: false, plateNumber: '경기88바9580' }),
    ]);

    await harness.worker.runOnce();

    expect(harness.pollStore.forceActiveForPreparationWindow).not.toHaveBeenCalled();
    expect(harness.pollStore.recordLocationActivitySignal).toHaveBeenCalledWith(expect.objectContaining({
      allConfiguredVehiclesStopped: true,
      now: loadingNow,
    }));
  });

  test('records location activity transitions only from explicit mapped stopped signals', async () => {
    const harness = createHarness({
      activity: 'ACTIVE',
      lastLocationStartedAt: null,
      lastTemperatureStartedAt: now,
    });
    harness.client.getLatestLocations.mockResolvedValue([
      locationReading({ deviceId: '01252738978', gpsSpeedKph: 1, ignitionOn: false }),
      locationReading({ deviceId: '01240835581', gpsSpeedKph: 0, ignitionOn: false, plateNumber: '경기88바9580' }),
    ]);

    await harness.worker.runOnce();

    expect(harness.pollStore.recordLocationActivitySignal).toHaveBeenCalledWith({
      allConfiguredVehiclesStopped: true,
      gracePeriodMs: 600_000,
      hasMappedSignal: true,
      leaseToken: 'lease-token',
      now,
      shopId: 'shop-id',
    });

    harness.pollStore.recordLocationActivitySignal.mockClear();
    harness.client.getLatestLocations.mockResolvedValue([
      locationReading({ deviceId: '01252738978', gpsSpeedKph: null, ignitionOn: false }),
    ]);
    await harness.worker.runOnce();
    expect(harness.pollStore.recordLocationActivitySignal).toHaveBeenCalledWith(expect.objectContaining({
      allConfiguredVehiclesStopped: false,
      hasMappedSignal: true,
    }));
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
  activeProtectionEndedAt?: Date | null;
  activity?: 'ACTIVE' | 'DORMANT';
  lastLocationStartedAt: Date | null;
  lastTemperatureStartedAt: Date | null;
} = { lastLocationStartedAt: null, lastTemperatureStartedAt: null }, options: {
  latestFinalEstimatedArrivalAt?: Date | null;
  loadingStartTime?: string;
  now?: Date;
} = {}) {
  const clock = options.now ?? now;
  const loadingStartTime = options.loadingStartTime ?? '07:30';
  const loadingStartsAt = loadingStartUtcForTest(clock, loadingStartTime);
  const client = {
    getLatestLocations: vi.fn().mockResolvedValue([]),
    getLatestTemperatures: vi.fn().mockResolvedValue([]),
  };
  const pollStore = {
    claimLease: vi.fn().mockResolvedValue({ activeProtectionEndedAt: null, activity: 'ACTIVE', ...lease, shopId: 'shop-id' }),
    forceActiveForPreparationWindow: vi.fn().mockResolvedValue(true),
    findShopAndDevices: vi.fn().mockResolvedValue({
      devices: [
        { deviceId: 'device-a', serialNumber: '012-5273-8978', vehicleId: 'vehicle-a', vehiclePlate: '서울86바3800' },
        { deviceId: 'device-b', serialNumber: '012-4083-5581', vehicleId: 'vehicle-b', vehiclePlate: '경기88바9580' },
      ],
      activeProtectionStartsAt: new Date(loadingStartsAt.getTime() - 60 * 60 * 1000),
      latestFinalEstimatedArrivalAt: options.latestFinalEstimatedArrivalAt ?? null,
      loadingStartsAt,
      loadingStartTime,
      shopId: 'shop-id',
    }),
    markFailed: vi.fn().mockResolvedValue(true),
    markActiveProtectionEnded: vi.fn().mockResolvedValue(true),
    markStarted: vi.fn().mockResolvedValue(true),
    markSucceeded: vi.fn().mockResolvedValue(true),
    recordLocationActivitySignal: vi.fn().mockResolvedValue(true),
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
    locationDormantGracePeriodMs: 600_000,
    locationDormantHeartbeatIntervalMs: 300_000,
    locationPollIntervalMs: 60_000,
    logger,
    now: () => clock,
    pollStore,
    shopDomain: 'dsv-demo.local',
    telemetryStore,
    temperaturePollIntervalMs: 300_000,
    tokenFactory: () => 'lease-token',
  });
  return { client, logger, pollStore, telemetryStore, worker };
}

function loadingStartUtcForTest(now: Date, loadingStartTime: string): Date {
  const [hour, minute] = loadingStartTime.split(':').map((part) => Number.parseInt(part, 10));
  const serviceDate = serviceDateForLoadingCycleTest(now, loadingStartTime);
  return new Date(Date.UTC(
    Number.parseInt(serviceDate.slice(0, 4), 10),
    Number.parseInt(serviceDate.slice(5, 7), 10) - 1,
    Number.parseInt(serviceDate.slice(8, 10), 10),
    (hour ?? 0) - 9,
    minute ?? 0,
  ));
}

function serviceDateForLoadingCycleTest(now: Date, loadingStartTime: string): string {
  const loadingMinute = timeOfDayToMinuteForTest(loadingStartTime);
  const windowStartMinute = (loadingMinute + 24 * 60 - 60) % (24 * 60);
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Seoul',
    year: 'numeric',
  }).formatToParts(now);
  const read = (type: string): number => Number.parseInt(parts.find((part) => part.type === type)?.value ?? '0', 10);
  const date = new Date(Date.UTC(read('year'), read('month') - 1, read('day')));
  const currentMinute = (read('hour') * 60) + read('minute');
  if (windowStartMinute > loadingMinute && currentMinute >= windowStartMinute) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return date.toISOString().slice(0, 10);
}

function timeOfDayToMinuteForTest(value: string): number {
  const [hour, minute] = value.split(':').map((part) => Number.parseInt(part, 10));
  return ((hour ?? 0) * 60) + (minute ?? 0);
}

function locationReading(overrides: Partial<UvisLocationReading> = {}): UvisLocationReading {
  return { ...locationReadingBase(), ...overrides };
}

function locationReadingBase(): UvisLocationReading {
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
