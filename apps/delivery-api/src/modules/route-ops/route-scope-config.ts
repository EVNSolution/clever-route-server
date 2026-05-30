export type RouteScopeValueDto = {
  builtIn: boolean;
  description: string | null;
  enabled: boolean;
  example: string | null;
  label: string;
  value: string;
};

export type RouteScopeConfigDto = {
  deliverySessions: RouteScopeValueDto[];
  serviceTypes: RouteScopeValueDto[];
  timeWindow: {
    endExample: string;
    helpText: string;
    startExample: string;
  };
  version: 1;
};

export class RouteScopeConfigValidationError extends Error {
  readonly code = 'BAD_REQUEST';

  constructor(message: string) {
    super(message);
    this.name = 'RouteScopeConfigValidationError';
  }
}

const TOKEN_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/u;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/u;
const MAX_ROUTE_SCOPE_VALUES = 20;
const MAX_LABEL_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 180;
const MAX_EXAMPLE_LENGTH = 120;
const MAX_HELP_TEXT_LENGTH = 220;

const DEFAULT_SERVICE_TYPES: RouteScopeValueDto[] = [
  {
    builtIn: true,
    description: 'Default delivery order route scope.',
    enabled: true,
    example: 'DELIVERY for standard delivery routes.',
    label: 'Delivery',
    value: 'DELIVERY'
  },
  {
    builtIn: true,
    description: 'Evening delivery route scope, commonly used for 5PM-9PM delivery routes.',
    enabled: true,
    example: 'EVENING_DELIVERY for a 5PM-9PM delivery route.',
    label: 'Evening delivery',
    value: 'EVENING_DELIVERY'
  },
  {
    builtIn: true,
    description: 'Pickup route scope for pickup orders.',
    enabled: true,
    example: 'PICKUP for pickup orders.',
    label: 'Pickup',
    value: 'PICKUP'
  }
];

const DEFAULT_DELIVERY_SESSIONS: RouteScopeValueDto[] = [
  {
    builtIn: true,
    description: 'Daytime delivery session.',
    enabled: true,
    example: 'DAY for daytime delivery.',
    label: 'Day',
    value: 'DAY'
  },
  {
    builtIn: true,
    description: 'Evening delivery session, commonly used for 5PM-9PM routes.',
    enabled: true,
    example: 'EVENING for a 5PM-9PM route.',
    label: 'Evening',
    value: 'EVENING'
  },
  {
    builtIn: true,
    description: 'Pickup session for pickup orders.',
    enabled: true,
    example: 'PICKUP for pickup orders.',
    label: 'Pickup',
    value: 'PICKUP'
  }
];

const DEFAULT_TIME_WINDOW = {
  endExample: '21:00',
  helpText: 'Use 24-hour HH:mm format.',
  startExample: '17:00'
};

export function defaultRouteScopeConfig(): RouteScopeConfigDto {
  return cloneRouteScopeConfig({
    deliverySessions: DEFAULT_DELIVERY_SESSIONS,
    serviceTypes: DEFAULT_SERVICE_TYPES,
    timeWindow: DEFAULT_TIME_WINDOW,
    version: 1
  });
}

export function normalizeRouteScopeConfig(raw: unknown): RouteScopeConfigDto {
  const object = objectOrNull(raw);
  if (object === null) return defaultRouteScopeConfig();
  return {
    deliverySessions: normalizeRouteScopeValues({
      builtIns: DEFAULT_DELIVERY_SESSIONS,
      raw: object.deliverySessions
    }),
    serviceTypes: normalizeRouteScopeValues({
      builtIns: DEFAULT_SERVICE_TYPES,
      raw: object.serviceTypes
    }),
    timeWindow: normalizeTimeWindow(object.timeWindow),
    version: 1
  };
}

export function validateRouteScopeConfigPayload(raw: unknown): RouteScopeConfigDto {
  const object = objectOrNull(raw);
  if (object === null) {
    throw new RouteScopeConfigValidationError('routeScopeConfig must be an object');
  }
  if (object.version !== 1) {
    throw new RouteScopeConfigValidationError('routeScopeConfig.version must be 1');
  }
  return {
    deliverySessions: validateRouteScopeValues({
      builtIns: DEFAULT_DELIVERY_SESSIONS,
      field: 'deliverySessions',
      raw: object.deliverySessions
    }),
    serviceTypes: validateRouteScopeValues({
      builtIns: DEFAULT_SERVICE_TYPES,
      field: 'serviceTypes',
      raw: object.serviceTypes
    }),
    timeWindow: validateTimeWindow(object.timeWindow),
    version: 1
  };
}

export function assertSafeRouteScopeToken(value: string, field = 'route scope value'): string {
  const text = value.trim();
  if (!isSafeRouteScopeToken(text)) {
    throw new RouteScopeConfigValidationError(`${field} must be an uppercase safe token`);
  }
  return text;
}

export function isSafeRouteScopeToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

export function isActiveServiceType(config: RouteScopeConfigDto, value: unknown): value is string {
  return isActiveRouteScopeValue(config.serviceTypes, value);
}

export function isActiveDeliverySession(config: RouteScopeConfigDto, value: unknown): value is string {
  return isActiveRouteScopeValue(config.deliverySessions, value);
}

export function buildActiveServiceTypes(config: RouteScopeConfigDto): RouteScopeValueDto[] {
  return config.serviceTypes.filter((item) => item.enabled);
}

export function buildActiveDeliverySessions(config: RouteScopeConfigDto): RouteScopeValueDto[] {
  return config.deliverySessions.filter((item) => item.enabled);
}

function normalizeRouteScopeValues(input: {
  builtIns: readonly RouteScopeValueDto[];
  raw: unknown;
}): RouteScopeValueDto[] {
  const rawValues = Array.isArray(input.raw) ? input.raw : [];
  const rawByValue = new Map<string, Record<string, unknown>>();
  for (const item of rawValues) {
    const object = objectOrNull(item);
    const value = typeof object?.value === 'string' ? object.value.trim() : null;
    if (object !== null && value !== null && isSafeRouteScopeToken(value) && !rawByValue.has(value)) {
      rawByValue.set(value, object);
    }
  }

  const output = input.builtIns.map((builtIn) => {
    const raw = rawByValue.get(builtIn.value);
    return {
      ...builtIn,
      description: readOptionalString(raw?.description, builtIn.description, MAX_DESCRIPTION_LENGTH),
      enabled: true,
      example: readOptionalString(raw?.example, builtIn.example, MAX_EXAMPLE_LENGTH),
      label: readRequiredString(raw?.label, builtIn.label, MAX_LABEL_LENGTH)
    };
  });
  const builtInValues = new Set(input.builtIns.map((item) => item.value));

  for (const item of rawValues) {
    const object = objectOrNull(item);
    if (object === null) continue;
    const value = typeof object.value === 'string' ? object.value.trim() : '';
    if (!isSafeRouteScopeToken(value) || builtInValues.has(value)) continue;
    if (output.some((existing) => existing.value === value)) continue;
    const label = readRequiredString(object.label, value, MAX_LABEL_LENGTH);
    output.push({
      builtIn: false,
      description: readOptionalString(object.description, null, MAX_DESCRIPTION_LENGTH),
      enabled: object.enabled === false ? false : true,
      example: readOptionalString(object.example, null, MAX_EXAMPLE_LENGTH),
      label,
      value
    });
    if (output.length >= input.builtIns.length + MAX_ROUTE_SCOPE_VALUES) break;
  }
  return output;
}

function validateRouteScopeValues(input: {
  builtIns: readonly RouteScopeValueDto[];
  field: string;
  raw: unknown;
}): RouteScopeValueDto[] {
  if (!Array.isArray(input.raw)) {
    throw new RouteScopeConfigValidationError(`${input.field} must be an array`);
  }
  if (input.raw.length > MAX_ROUTE_SCOPE_VALUES) {
    throw new RouteScopeConfigValidationError(`${input.field} has too many values`);
  }
  const output: RouteScopeValueDto[] = [];
  const seen = new Set<string>();
  for (const [index, rawItem] of input.raw.entries()) {
    const object = objectOrNull(rawItem);
    if (object === null) {
      throw new RouteScopeConfigValidationError(`${input.field}[${index}] must be an object`);
    }
    const value = readStrictToken(object.value, `${input.field}[${index}].value`);
    if (seen.has(value)) {
      throw new RouteScopeConfigValidationError(`${input.field} contains duplicate value ${value}`);
    }
    seen.add(value);
    const builtIn = input.builtIns.some((item) => item.value === value);
    const enabled = object.enabled !== false;
    if (builtIn && !enabled) {
      throw new RouteScopeConfigValidationError(`${input.field} built-in value ${value} cannot be disabled`);
    }
    output.push({
      builtIn,
      description: readNullableBoundedString(object.description, `${input.field}[${index}].description`, MAX_DESCRIPTION_LENGTH),
      enabled,
      example: readNullableBoundedString(object.example, `${input.field}[${index}].example`, MAX_EXAMPLE_LENGTH),
      label: readNonEmptyBoundedString(object.label, `${input.field}[${index}].label`, MAX_LABEL_LENGTH),
      value
    });
  }
  for (const builtIn of input.builtIns) {
    if (!seen.has(builtIn.value)) {
      throw new RouteScopeConfigValidationError(`${input.field} built-in value ${builtIn.value} is required`);
    }
  }
  return output;
}

function normalizeTimeWindow(raw: unknown): RouteScopeConfigDto['timeWindow'] {
  const object = objectOrNull(raw);
  if (object === null) return { ...DEFAULT_TIME_WINDOW };
  const startExample = typeof object.startExample === 'string' && TIME_PATTERN.test(object.startExample.trim())
    ? object.startExample.trim()
    : DEFAULT_TIME_WINDOW.startExample;
  const endExample = typeof object.endExample === 'string' && TIME_PATTERN.test(object.endExample.trim())
    ? object.endExample.trim()
    : DEFAULT_TIME_WINDOW.endExample;
  return {
    endExample,
    helpText: readRequiredString(object.helpText, DEFAULT_TIME_WINDOW.helpText, MAX_HELP_TEXT_LENGTH),
    startExample
  };
}

function validateTimeWindow(raw: unknown): RouteScopeConfigDto['timeWindow'] {
  const object = objectOrNull(raw);
  if (object === null) {
    throw new RouteScopeConfigValidationError('timeWindow must be an object');
  }
  const startExample = readNonEmptyBoundedString(object.startExample, 'timeWindow.startExample', 5);
  const endExample = readNonEmptyBoundedString(object.endExample, 'timeWindow.endExample', 5);
  if (!TIME_PATTERN.test(startExample)) {
    throw new RouteScopeConfigValidationError('timeWindow.startExample must be HH:mm');
  }
  if (!TIME_PATTERN.test(endExample)) {
    throw new RouteScopeConfigValidationError('timeWindow.endExample must be HH:mm');
  }
  return {
    endExample,
    helpText: readNonEmptyBoundedString(object.helpText, 'timeWindow.helpText', MAX_HELP_TEXT_LENGTH),
    startExample
  };
}

function isActiveRouteScopeValue(values: RouteScopeValueDto[], value: unknown): value is string {
  if (!isSafeRouteScopeToken(value)) return false;
  const match = values.find((item) => item.value === value);
  return match?.enabled === true;
}

function readStrictToken(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new RouteScopeConfigValidationError(`${field} must be a string`);
  }
  return assertSafeRouteScopeToken(value, field);
}

function readNonEmptyBoundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new RouteScopeConfigValidationError(`${field} must be a string`);
  }
  const text = value.trim();
  if (text.length === 0) {
    throw new RouteScopeConfigValidationError(`${field} cannot be blank`);
  }
  if (text.length > maxLength) {
    throw new RouteScopeConfigValidationError(`${field} is too long`);
  }
  return text;
}

function readNullableBoundedString(value: unknown, field: string, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new RouteScopeConfigValidationError(`${field} must be a string or null`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new RouteScopeConfigValidationError(`${field} is too long`);
  }
  return text.length === 0 ? null : text;
}

function readRequiredString(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text.length === 0 || text.length > maxLength ? fallback : text;
}

function readOptionalString(value: unknown, fallback: string | null, maxLength: number): string | null {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text.length === 0 || text.length > maxLength ? fallback : text;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function cloneRouteScopeConfig(config: RouteScopeConfigDto): RouteScopeConfigDto {
  return {
    deliverySessions: config.deliverySessions.map((item) => ({ ...item })),
    serviceTypes: config.serviceTypes.map((item) => ({ ...item })),
    timeWindow: { ...config.timeWindow },
    version: 1
  };
}
