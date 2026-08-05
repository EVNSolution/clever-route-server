export type DsvOperationalSettings = {
  dwellMinutes: number;
  etaDelayMinutes: number;
  forwardDelayAlerts: boolean;
  gpsSilenceSeconds: number;
  manualEmailBody: string;
  manualEmailSenderEmail: string | null;
  manualEmailSubject: string;
  recordMissingProof: boolean;
  // Legacy compatibility/display fields only. Per-condition DsvTransportCondition temperature policy is the source of truth for new alert decisions.
  showTemperatureAlerts: boolean;
  temperatureLimit: number;
};

export function defaultDsvOperationalSettings(): DsvOperationalSettings {
  return {
    dwellMinutes: 5,
    etaDelayMinutes: 10,
    forwardDelayAlerts: true,
    gpsSilenceSeconds: 180,
    manualEmailBody: '안녕하세요.\n\nCLEVER DSV 고객사 배송조회 페이지와 임시 계정 정보를 안내드립니다.\n\n배송조회 페이지:\n임시 아이디:\n임시 비밀번호:\n\n최초 로그인 후 아이디와 비밀번호를 변경해 주세요.',
    manualEmailSenderEmail: null,
    manualEmailSubject: '[CLEVER DSV] 고객사 배송조회 계정 안내',
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
    manualEmailBody: optionalTemplate(value.manualEmailBody, 10_000, 'manualEmailBody', defaultDsvOperationalSettings().manualEmailBody),
    manualEmailSenderEmail: optionalEmail(value.manualEmailSenderEmail, 'manualEmailSenderEmail'),
    manualEmailSubject: optionalTemplate(value.manualEmailSubject, 200, 'manualEmailSubject', defaultDsvOperationalSettings().manualEmailSubject),
    recordMissingProof: booleanValue(value.recordMissingProof, 'recordMissingProof'),
    showTemperatureAlerts: booleanValue(value.showTemperatureAlerts, 'showTemperatureAlerts'),
    temperatureLimit: numberInRange(value.temperatureLimit, -50, 50, 'temperatureLimit'),
  };
}

function optionalTemplate(value: unknown, maxLength: number, field: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new Error(`${field} must be a non-empty string up to ${maxLength} characters.`);
  }
  return value.trim();
}

function optionalEmail(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
    throw new Error(`${field} must be a valid email address or null.`);
  }
  return value.trim().toLowerCase();
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
