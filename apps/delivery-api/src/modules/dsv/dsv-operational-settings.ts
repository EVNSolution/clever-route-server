export type DsvOperationalSettings = {
  dwellMinutes: number;
  etaDelayMinutes: number;
  forwardDelayAlerts: boolean;
  gpsSilenceSeconds: number;
  recordMissingProof: boolean;
  showTemperatureAlerts: boolean;
  temperatureLimit: number;
};

export function defaultDsvOperationalSettings(): DsvOperationalSettings {
  return {
    dwellMinutes: 5,
    etaDelayMinutes: 10,
    forwardDelayAlerts: true,
    gpsSilenceSeconds: 30,
    recordMissingProof: true,
    showTemperatureAlerts: true,
    temperatureLimit: 8,
  };
}

export function normalizeDsvOperationalSettings(value: unknown): DsvOperationalSettings {
  if (value === null || value === undefined) return defaultDsvOperationalSettings();
  return validateDsvOperationalSettings(value);
}

export function validateDsvOperationalSettings(value: unknown): DsvOperationalSettings {
  if (!isRecord(value)) throw new Error('DSV operational settings must be an object.');
  return {
    dwellMinutes: integerInRange(value.dwellMinutes, 0, 240, 'dwellMinutes'),
    etaDelayMinutes: integerInRange(value.etaDelayMinutes, 1, 240, 'etaDelayMinutes'),
    forwardDelayAlerts: booleanValue(value.forwardDelayAlerts, 'forwardDelayAlerts'),
    gpsSilenceSeconds: integerInRange(value.gpsSilenceSeconds, 5, 3_600, 'gpsSilenceSeconds'),
    recordMissingProof: booleanValue(value.recordMissingProof, 'recordMissingProof'),
    showTemperatureAlerts: booleanValue(value.showTemperatureAlerts, 'showTemperatureAlerts'),
    temperatureLimit: numberInRange(value.temperatureLimit, -50, 50, 'temperatureLimit'),
  };
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be boolean.`);
  return value;
}

function integerInRange(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer from ${min} through ${max}.`);
  }
  return value;
}

function numberInRange(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be a number from ${min} through ${max}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
