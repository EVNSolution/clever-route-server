import { randomUUID } from 'node:crypto';

import type { UvisClient } from './uvis-client.js';
import { UvisClientError, type UvisLocationReading, type UvisTemperatureReading } from './uvis-contract.js';
import type { UvisDeviceMapping, UvisPollKind, UvisPollLease } from './uvis-poll.repository.js';
import type { UvisTelemetrySampleInput, UvisTelemetryStoreResult } from './uvis-telemetry.repository.js';

export type UvisWorkerLogger = {
  error: (context: Record<string, unknown>, message: string) => void;
  info: (context: Record<string, unknown>, message: string) => void;
  warn: (context: Record<string, unknown>, message: string) => void;
};

export type UvisPollStore = {
  claimLease: (input: { leaseDurationMs: number; leaseToken: string; now: Date; shopId: string }) => Promise<UvisPollLease | null>;
  findShopAndDevices: (input: { appId: string; shopDomain: string }) => Promise<{ devices: UvisDeviceMapping[]; shopId: string } | null>;
  markFailed: (input: { errorCode: string; kind: UvisPollKind; leaseToken: string; now: Date; shopId: string }) => Promise<boolean>;
  markStarted: (input: { kind: UvisPollKind; leaseToken: string; now: Date; shopId: string }) => Promise<boolean>;
  markSucceeded: (input: { kind: UvisPollKind; leaseToken: string; now: Date; shopId: string }) => Promise<boolean>;
  releaseLease: (input: { leaseToken: string; shopId: string }) => Promise<void>;
};

export type UvisTelemetryStore = {
  recordSample: (input: UvisTelemetrySampleInput) => Promise<UvisTelemetryStoreResult>;
};

export type UvisTelemetryWorkerOptions = {
  appId: string;
  client: Pick<UvisClient, 'getLatestLocations' | 'getLatestTemperatures'>;
  leaseDurationMs: number;
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
    const target = await this.options.pollStore.findShopAndDevices({
      appId: this.options.appId,
      shopDomain: this.options.shopDomain,
    });
    if (target === null) {
      this.options.logger.warn({}, 'UVIS polling skipped because the configured shop was not found');
      return;
    }

    const now = this.now();
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
      if (isDue(lease.lastLocationStartedAt, now, this.options.locationPollIntervalMs)) {
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

  private async pollLocation(target: { devices: UvisDeviceMapping[]; shopId: string }, leaseToken: string): Promise<void> {
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

  private async pollTemperature(target: { devices: UvisDeviceMapping[]; shopId: string }, leaseToken: string): Promise<void> {
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
    target: { devices: UvisDeviceMapping[]; shopId: string };
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
      let matched = 0;
      let unmatched = 0;
      let failed = 0;

      for (const reading of readings) {
        const mapping = resolveDevice(indexes, reading.deviceId);
        if (mapping === null) {
          unmatched += 1;
          continue;
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
  bySerial: Map<string, UvisDeviceMapping[]>;
} {
  const bySerial = new Map<string, UvisDeviceMapping[]>();
  for (const device of devices) {
    appendIndex(bySerial, normalizeIdentifier(device.serialNumber), device);
  }
  return { bySerial };
}

function resolveDevice(
  indexes: ReturnType<typeof deviceIndexes>,
  sourceDeviceIdentifier: string,
): UvisDeviceMapping | null {
  const serialMatches = indexes.bySerial.get(normalizeIdentifier(sourceDeviceIdentifier)) ?? [];
  return serialMatches.length === 1 ? serialMatches[0] ?? null : null;
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
