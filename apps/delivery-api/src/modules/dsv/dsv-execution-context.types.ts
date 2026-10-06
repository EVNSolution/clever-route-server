import type { Prisma } from '@prisma/client';

export const DSV_EXECUTION_TRIP_INTENTS = [
  'INITIAL_EXECUTION',
  'NEW_EXECUTION',
  'SAME_EXECUTION',
] as const;

export type DsvExecutionTripIntent = typeof DSV_EXECUTION_TRIP_INTENTS[number];
export type DsvExecutionCloseReason = 'CANCELLED' | 'COMPLETED';

export type DsvExecutionContentStop = {
  address: {
    address1: string | null;
    address2: string | null;
    countryCode: string | null;
    postalCode: string | null;
  };
  destinationId: string | null;
  id: string;
  latitude: number | null;
  longitude: number | null;
  orderId: string;
  quantity: number | null;
  sequence: number;
  status: string;
};

export type DsvExecutionContentSnapshot = {
  depot: { latitude: number; longitude: number } | null;
  stops: DsvExecutionContentStop[];
};

export type DsvExecutionSyncInput = {
  commandId: string;
  executionContextId?: string | undefined;
  firstPublication?: boolean | undefined;
  now?: Date | undefined;
  previousPublishedAt?: Date | null | undefined;
  routePlanId: string;
  shopId: string;
  tripIntent?: DsvExecutionTripIntent | undefined;
};

export type DsvExecutionSyncResult = {
  assignmentEpoch: string | null;
  executionContextId: string | null;
  notificationKinds: string[];
  outcome: 'ACCEPT' | 'MAPPING_REQUIRED' | 'REPLAY' | 'SKIPPED_NON_DSV' | 'SKIPPED_UNAVAILABLE';
  routePlanId: string;
  routeVersion: number | null;
};

export type DsvExecutionCloseInput = {
  commandId?: string | undefined;
  now?: Date | undefined;
  reason: DsvExecutionCloseReason;
  routePlanId: string;
  shopId: string;
};

export type DsvExecutionCloseResult = {
  executionContextId: string | null;
  outcome: 'ACCEPT' | 'ALREADY_CLOSED' | 'NOT_FOUND' | 'REPLAY' | 'SKIPPED_UNAVAILABLE';
  status: DsvExecutionCloseReason | null;
};

export type DsvExecutionSelectionInput = {
  commandId: string;
  executionContextId: string;
  shopId: string;
  validFrom: Date;
  validUntil: Date;
  vehicleId: string;
};

export type DsvExecutionSelectionResult = {
  executionContextId: string;
  outcome: 'ACCEPT' | 'REPLAY';
  vehicleId: string;
};

export type DsvExecutionCommandInput = {
  commandId: string;
  commandName: string;
  payload: Prisma.InputJsonValue;
  shopId: string;
};

export class DsvExecutionContextError extends Error {
  constructor(
    readonly code:
      | 'CLOSED_EXECUTION_CONTEXT'
      | 'COMMAND_PAYLOAD_MISMATCH'
      | 'DRIVER_ACCOUNT_SCOPE_INVALID'
      | 'DRIVER_SCOPE_INVALID'
      | 'EXECUTION_CONTEXT_SCOPE_INVALID'
      | 'MAPPING_EFFECTIVE_TIME_INVALID'
      | 'NEW_EXECUTION_REQUIRES_UNMAPPED_ROUTE'
      | 'ROUTE_CURRENT_SNAPSHOT_INVALID'
      | 'ROUTE_SCOPE_INVALID'
      | 'SAME_EXECUTION_CONTEXT_REQUIRED'
      | 'SELECTION_INTERVAL_INVALID'
      | 'SELECTION_INTERVAL_OVERLAP'
      | 'VEHICLE_SCOPE_INVALID',
    message: string = code,
  ) {
    super(message);
    this.name = 'DsvExecutionContextError';
  }
}
