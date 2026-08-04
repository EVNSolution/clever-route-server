import { randomUUID } from 'node:crypto';

import type { UvisClient } from './uvis-client.js';
import { UvisClientError, type UvisLocationReading, type UvisTemperatureReading } from './uvis-contract.js';
import type { UvisDeviceMapping, UvisPollKind, UvisPollLease, UvisPollTarget } from './uvis-poll.repository.js';
import type { UvisTelemetrySampleInput, UvisTelemetryStoreResult } from './uvis-telemetry.repository.js';

export type UvisWorkerLogger = {
  error: (context: Record<string, unknown>, message: string) => void;
  info: (context: Record<string, unknown>, message: string) => void;
  warn: (context: Record<string, unknown>, message: string) => void;
};

export type UvisPollStore = {
  claimLease: (input: { leaseDurationMs: number; leaseToken: string; now: Date; shopId: string }) => Promise<UvisPollLease | null>;
  findShopAndDevices: (input: { appId: string; now: Date; shopDomain: string }) => Promise<UvisPollTarget | null>;
  forceActiveForPreparationWindow: (input: { leaseToken: string; shopId: string }) => Promise<boolean>;
  markActiveProtectionEnded: (input: { leaseToken: string; protectionEndedAt: Date; shopId: string }) => Promise<boolean>;
  markFailed: (input: { errorCode: string; kind: UvisPollKind; leaseToken: string; now: Date; shopId: string }) => Promise<boolean>;
  markStarted: (input: { kind: UvisPollKind; leaseToken: string; now: Date; shopId: string }) => Promise<boolean>;
  markSucceeded: (input: { kind: UvisPollKind; leaseToken: string; now: Date; shopId: string }) => Promise<boolean>;
  recordLocationActivitySignal: (input: {
    allConfiguredVehiclesStopped: boolean;
    gracePeriodMs: number;
    hasMappedSignal: boolean;
    leaseToken: string;
    now: Date;
    shopId: string;
  }) => Promise<boolean>;
  releaseLease: (input: { leaseToken: string; shopId: string }) => Promise<void>;
};

export type UvisTelemetryStore = {
  recordSample: (input: UvisTelemetrySampleInput) => Promise<UvisTelemetryStoreResult>;
};

export type UvisTelemetryWorkerOptions = {
  appId: string;
  client: Pick<UvisClient, 'getLatestLocations' | 'getLatestTemperatures'>;
  leaseDurationMs: number;
  locationDormantHeartbeatIntervalMs: number;
  locationDormantGracePeriodMs: number;
  locationPollIntervalMs: number;
  logger: UvisWorkerLogger;
  now?: () => Date;
  pollStore: UvisPollStore;
  shopDomain: string;
  telemetryStore: UvisTelemetryStore;
  temperaturePollIntervalMs: number;
  tokenFactory?: () => string;
};

type Reading = UvisLocationReading | UvisTemperatureReading;

export class UvisTelemetryWorker {
  private readonly now: () => Date;
  private readonly tokenFactory: () => string;

  constructor(private readonly options: UvisTelemetryWorkerOptions) {
    this.now = options.now ?? (() => new Date());
    this.tokenFactory = options.tokenFactory ?? randomUUID;
  }

  async runOnce(): Promise<void> {
    const now = this.now();
    const target = await this.options.pollStore.findShopAndDevices({
      appId: this.options.appId,
      now,
      shopDomain: this.options.shopDomain,
    });
    if (target === null) {
      this.options.logger.warn({}, 'UVIS polling skipped because the configured shop was not found');
      return;
    }

    const leaseToken = this.tokenFactory();
    const lease = await this.options.pollStore.claimLease({
      leaseDurationMs: this.options.leaseDurationMs,
      leaseToken,
      now,
      shopId: target.shopId,
    });
    if (lease === null) return;

    try {
      const jobs: Array<Promise<void>> = [];
      const protection = activeProtection(now, target, lease);
      if (protection === 'FORCE_ACTIVE') {
        const forced = await this.options.pollStore.forceActiveForPreparationWindow({
          leaseToken,
          shopId: target.shopId,
        });
        if (!forced) {
          this.options.logger.warn({ kind: 'location' }, 'UVIS telemetry poll lost its lease');
          return;
        }
      }
      const protectionEnded = protection === 'ENDED'
        ? await this.options.pollStore.markActiveProtectionEnded({
            leaseToken,
            protectionEndedAt: target.latestFinalEstimatedArrivalAt ?? target.loadingStartsAt,
            shopId: target.shopId,
          })
        : true;
      if (!protectionEnded) {
        this.options.logger.warn({ kind: 'location' }, 'UVIS telemetry poll lost its lease');
        return;
      }
      const effectiveActivity = protection === 'NORMAL' ? lease.activity : 'ACTIVE';
      const locationIntervalMs = effectiveActivity === 'DORMANT'
        ? this.options.locationDormantHeartbeatIntervalMs
        : this.options.locationPollIntervalMs;
      if (isDue(lease.lastLocationStartedAt, now, locationIntervalMs)) {
        jobs.push(this.pollLocation(target, leaseToken));
      }
      if (isDue(lease.lastTemperatureStartedAt, now, this.options.temperaturePollIntervalMs)) {
        jobs.push(this.pollTemperature(target, leaseToken));
      }
      await Promise.all(jobs);
    } finally {
      await this.options.pollStore.releaseLease({ leaseToken, shopId: target.shopId });
    }
  }

  private async pollLocation(target: UvisPollTarget, leaseToken: string): Promise<void> {
    await this.pollKind({
      fetch: () => this.options.client.getLatestLocations(),
      intervalMs: this.options.locationPollIntervalMs,
      kind: 'location',
      leaseToken,
      sourceKind: 'VEHICLE_GPS',
      target,
      toSample: (reading, deviceId, receivedAt, staleAfter) => ({
        deviceId,
        distanceTodayKm: nullableNumber(reading.dayDistanceKm),
        ignitionOn: reading.ignitionOn,
        latitude: String(reading.latitude),
        longitude: String(reading.longitude),
        observedAt: reading.recordedAt,
        receivedAt,
        sourceDeviceIdentifier: reading.deviceId,
        sourceKind: 'VEHICLE_GPS',
        sourcePlate: reading.plateNumber,
        speedKph: nullableNumber(reading.gpsSpeedKph),
        staleAfter,
      }),
    });
  }

  private async pollTemperature(target: UvisPollTarget, leaseToken: string): Promise<void> {
    await this.pollKind({
      fetch: () => this.options.client.getLatestTemperatures(),
      intervalMs: this.options.temperaturePollIntervalMs,
      kind: 'temperature',
      leaseToken,
      sourceKind: 'TEMPERATURE_RECORDER',
      target,
      toSample: (reading, deviceId, receivedAt, staleAfter) => ({
        deviceId,
        latitude: String(reading.latitude),
        longitude: String(reading.longitude),
        observedAt: reading.recordedAt,
        receivedAt,
        sourceDeviceIdentifier: reading.deviceId,
        sourceKind: 'TEMPERATURE_RECORDER',
        sourcePlate: reading.plateNumber,
        staleAfter,
        temperatureA: nullableNumber(reading.temperatureA),
        temperatureB: nullableNumber(reading.temperatureB),
      }),
    });
  }

  private async pollKind<TReading extends Reading>(input: {
    fetch: () => Promise<TReading[]>;
    intervalMs: number;
    kind: UvisPollKind;
    leaseToken: string;
    sourceKind: UvisTelemetrySampleInput['sourceKind'];
    target: UvisPollTarget;
    toSample: (reading: TReading, deviceId: string, receivedAt: Date, staleAfter: Date) => UvisTelemetrySampleInput;
  }): Promise<void> {
    const startedAt = this.now();
    const started = await this.options.pollStore.markStarted({
      kind: input.kind,
      leaseToken: input.leaseToken,
      now: startedAt,
      shopId: input.target.shopId,
    });
    if (!started) {
      this.options.logger.warn({ kind: input.kind }, 'UVIS telemetry poll lost its lease');
      return;
    }
    try {
      const readings = await input.fetch();
      const receivedAt = this.now();
      const indexes = deviceIndexes(input.target.devices);
      const locationSignals = input.kind === 'location'
        ? new Map<string, 'ACTIVE' | 'STOPPED' | 'UNKNOWN'>()
        : null;
      let matched = 0;
      let unmatched = 0;
      let failed = 0;

      for (const reading of readings) {
        const mapping = resolveDevice(indexes, reading.deviceId, reading.plateNumber);
        if (mapping === null) {
          unmatched += 1;
          continue;
        }
        if (locationSignals !== null && isLocationReading(reading)) {
          locationSignals.set(mapping.deviceId, mergeLocationSignal(
            locationSignals.get(mapping.deviceId),
            classifyLocationSignal(reading),
          ));
        }
        try {
          await this.options.telemetryStore.recordSample(input.toSample(
            reading,
            mapping.deviceId,
            receivedAt,
            new Date(reading.recordedAt.getTime() + (input.intervalMs * 2)),
          ));
          matched += 1;
        } catch {
          failed += 1;
        }
      }

      if (failed > 0) throw new UvisPersistenceError();
      if (locationSignals !== null) {
        const activityUpdated = await this.options.pollStore.recordLocationActivitySignal({
          allConfiguredVehiclesStopped: areAllConfiguredVehiclesStopped(input.target.devices, locationSignals),
          gracePeriodMs: this.options.locationDormantGracePeriodMs,
          hasMappedSignal: locationSignals.size > 0,
          leaseToken: input.leaseToken,
          now: this.now(),
          shopId: input.target.shopId,
        });
        if (!activityUpdated) {
          this.options.logger.warn({ kind: input.kind }, 'UVIS telemetry poll lost its lease');
          return;
        }
      }
      const succeeded = await this.options.pollStore.markSucceeded({
        kind: input.kind,
        leaseToken: input.leaseToken,
        now: this.now(),
        shopId: input.target.shopId,
      });
      if (!succeeded) {
        this.options.logger.warn({ kind: input.kind }, 'UVIS telemetry poll lost its lease');
        return;
      }
      this.options.logger.info({ kind: input.kind, matched, received: readings.length, unmatched }, 'UVIS telemetry poll completed');
    } catch (error) {
      const errorCode = safeErrorCode(error);
      const failed = await this.options.pollStore.markFailed({
        errorCode,
        kind: input.kind,
        leaseToken: input.leaseToken,
        now: this.now(),
        shopId: input.target.shopId,
      });
      if (!failed) {
        this.options.logger.warn({ kind: input.kind }, 'UVIS telemetry poll lost its lease');
        return;
      }
      this.options.logger.error({ errorCode, kind: input.kind }, 'UVIS telemetry poll failed');
    }
  }
}

class UvisPersistenceError extends Error {}

function deviceIndexes(devices: UvisDeviceMapping[]): {
  byPlate: Map<string, UvisDeviceMapping[]>;
  bySerial: Map<string, UvisDeviceMapping[]>;
} {
  const byPlate = new Map<string, UvisDeviceMapping[]>();
  const bySerial = new Map<string, UvisDeviceMapping[]>();
  for (const device of devices) {
    appendIndex(byPlate, normalizeIdentifier(device.vehiclePlate), device);
    appendIndex(bySerial, normalizeIdentifier(device.serialNumber), device);
  }
  return { byPlate, bySerial };
}

function resolveDevice(
  indexes: ReturnType<typeof deviceIndexes>,
  sourceDeviceIdentifier: string,
  sourcePlate?: string | null,
): UvisDeviceMapping | null {
  const serialMatches = indexes.bySerial.get(normalizeIdentifier(sourceDeviceIdentifier)) ?? [];
  const plateMatches = indexes.byPlate.get(normalizeIdentifier(sourcePlate ?? null)) ?? [];
  const serialMatch = serialMatches.length === 1 ? serialMatches[0] ?? null : null;
  const plateMatch = plateMatches.length === 1 ? plateMatches[0] ?? null : null;
  if (serialMatch !== null && plateMatch !== null && serialMatch.deviceId !== plateMatch.deviceId) return null;
  return serialMatch ?? plateMatch;
}

function appendIndex(index: Map<string, UvisDeviceMapping[]>, key: string, value: UvisDeviceMapping): void {
  if (key === '') return;
  const values = index.get(key) ?? [];
  values.push(value);
  index.set(key, values);
}

function normalizeIdentifier(value: string | null): string {
  return value?.replace(/[^0-9A-Z가-힣]/gu, '').toUpperCase() ?? '';
}

function isLocationReading(reading: Reading): reading is UvisLocationReading {
  return 'ignitionOn' in reading && 'gpsSpeedKph' in reading;
}

function classifyLocationSignal(reading: UvisLocationReading): 'ACTIVE' | 'STOPPED' | 'UNKNOWN' {
  if (reading.ignitionOn === true || (reading.gpsSpeedKph !== null && reading.gpsSpeedKph > 1)) return 'ACTIVE';
  if (reading.ignitionOn === false && reading.gpsSpeedKph !== null && reading.gpsSpeedKph <= 1) return 'STOPPED';
  return 'UNKNOWN';
}

function mergeLocationSignal(
  previous: 'ACTIVE' | 'STOPPED' | 'UNKNOWN' | undefined,
  next: 'ACTIVE' | 'STOPPED' | 'UNKNOWN',
): 'ACTIVE' | 'STOPPED' | 'UNKNOWN' {
  if (previous === 'ACTIVE' || next === 'ACTIVE') return 'ACTIVE';
  if (previous === 'UNKNOWN' || next === 'UNKNOWN') return 'UNKNOWN';
  return 'STOPPED';
}

function areAllConfiguredVehiclesStopped(
  devices: UvisDeviceMapping[],
  signals: Map<string, 'ACTIVE' | 'STOPPED' | 'UNKNOWN'>,
): boolean {
  return devices.length > 0 && devices.every((device) => signals.get(device.deviceId) === 'STOPPED');
}

function activeProtection(now: Date, target: UvisPollTarget, lease: UvisPollLease): 'FORCE_ACTIVE' | 'ENDED' | 'NORMAL' {
  const protectionEndsAt = target.latestFinalEstimatedArrivalAt ?? target.loadingStartsAt;
  if (now.getTime() < target.activeProtectionStartsAt.getTime()) return 'NORMAL';
  if (now.getTime() < protectionEndsAt.getTime()) return 'FORCE_ACTIVE';
  if (lease.activeProtectionEndedAt?.getTime() !== protectionEndsAt.getTime()) {
    return 'ENDED';
  }
  return 'NORMAL';
}

function nullableNumber(value: number | null): string | null {
  return value === null ? null : String(value);
}

function safeErrorCode(error: unknown): string {
  if (error instanceof UvisClientError) return error.code;
  if (error instanceof UvisPersistenceError) return 'PERSISTENCE_ERROR';
  return 'UNKNOWN_ERROR';
}

function isDue(lastStartedAt: Date | null, now: Date, intervalMs: number): boolean {
  return lastStartedAt === null || now.getTime() - lastStartedAt.getTime() >= intervalMs;
}
