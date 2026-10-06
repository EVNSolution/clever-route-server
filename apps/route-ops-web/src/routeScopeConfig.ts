import type { RouteScopeConfigDto } from './types';

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
