import type { RouteScopeConfigDto, RouteScopeValueDto } from './types';

export function defaultRouteScopeConfig(): RouteScopeConfigDto {
  return {
    deliverySessions: [
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
    ],
    serviceTypes: [
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
    ],
    timeWindow: {
      endExample: '21:00',
      helpText: 'Use 24-hour HH:mm format.',
      startExample: '17:00'
    },
    version: 1
  };
}

export function normalizeRouteScopeConfig(config: RouteScopeConfigDto | null | undefined): RouteScopeConfigDto {
  if (config === null || config === undefined) return defaultRouteScopeConfig();
  return {
    deliverySessions: normalizeValues(config.deliverySessions, defaultRouteScopeConfig().deliverySessions),
    serviceTypes: normalizeValues(config.serviceTypes, defaultRouteScopeConfig().serviceTypes),
    timeWindow: {
      endExample: config.timeWindow?.endExample ?? '21:00',
      helpText: config.timeWindow?.helpText ?? 'Use 24-hour HH:mm format.',
      startExample: config.timeWindow?.startExample ?? '17:00'
    },
    version: 1
  };
}

export function activeRouteScopeValues(values: RouteScopeValueDto[]): RouteScopeValueDto[] {
  return values.filter((value) => value.enabled);
}

export function routeScopeValueSummary(values: RouteScopeValueDto[]): string {
  return activeRouteScopeValues(values)
    .map((item) => item.value)
    .join(', ');
}

function normalizeValues(values: RouteScopeValueDto[] | undefined, defaults: RouteScopeValueDto[]): RouteScopeValueDto[] {
  const byValue = new Map((values ?? []).map((item) => [item.value, item]));
  const output = defaults.map((fallback) => ({ ...fallback, ...byValue.get(fallback.value), builtIn: true, enabled: true }));
  for (const item of values ?? []) {
    if (output.some((existing) => existing.value === item.value)) continue;
    output.push({ ...item, builtIn: false });
  }
  return output;
}
