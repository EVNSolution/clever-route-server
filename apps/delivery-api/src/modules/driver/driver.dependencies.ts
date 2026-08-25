import type { PrismaClient } from '@prisma/client';

import { PrismaDriverAssignedRouteRepository } from './driver-assigned-route.repository.js';
import { PrismaDriverDestinationNotesRepository } from './driver-destination-notes.repository.js';
import { PrismaDriverConsentRepository } from './driver-consent.repository.js';
import { PrismaDriverEventRepository } from './driver-event.repository.js';
import { loadDriverRouteCompletionInvariantMode, loadDriverRouteCompletionReviewRetentionDays } from './driver-route-completion-invariant.js';
import { PrismaDriverEventReceiptRepository } from './driver-event-receipt.repository.js';
import { PrismaDriverProofMediaRepository } from './driver-proof-media.repository.js';
import { PrismaDriverRouteAccessRepository } from './driver-route-access.repository.js';
import { PrismaDriverRouteSessionRepository } from './driver-route-session.repository.js';
import { PrismaDriverSelfServiceRepository } from './driver-self-service.repository.js';
import { PrismaDriverTokenAccessRepository } from './driver-token-access.repository.js';
import { createS3DriverProofMediaStorage } from './driver-proof-media-s3-storage.js';
import {
  createHttpDriverProofMediaScanMonitor,
  createHttpDriverProofMediaScanner
} from './driver-proof-media-http-scanner.js';
import type { DriverProofMediaStorageBackend } from './driver-proof-media.repository.js';
import type { DriverProofMediaScanMonitor, DriverProofMediaScanner } from './driver-proof-media.types.js';
import type { DriverApiDependencies } from '../../routes/driver-events.routes.js';
import type { RouteTrackingStreamHub } from '../route-tracking/route-tracking.stream.js';
import type { AdminNotificationServiceApi } from '../notifications/admin-notification.service.js';
import { DriverDeliverySpaceService, PrismaDriverDeliverySpaceRepository } from './driver-delivery-space.service.js';
import {
  DEFAULT_DRIVER_ROUTE_MAP_PREVIEW_TTL_SECONDS,
  DriverRouteMapPreviewService
} from './driver-route-map-preview.service.js';
import {
  DriverSellerOrderAssignmentService,
  DriverSellerOrderAlreadyAcquiredError,
  DriverSellerOrderAssignmentConflictError,
  type DriverSellerOrderAssignmentCommandKernel,
  type DriverSellerOrderAssignmentCommandKernelInput,
  type DriverSellerOrderAssignmentResult,
  DriverSellerOrderNotFoundError,
  DriverSellerOrderScopeError,
  DriverSellerOrderTransferClosedError,
  DriverSellerOrderVehicleRequiredError,
  PrismaDriverSellerOrderContextRepository
} from './driver-seller-order-assignment.service.js';
import type { RouteGroupingService } from '../route-grouping/route-grouping.types.js';
import type { RouteGroupingAssignmentDto } from '../route-grouping/route-grouping.types.js';
import type { DsvRouteOptimizationSchedulerPort } from '../dsv/dsv-route-optimization.scheduler.js';
import type { DsvOrderMessageService } from '../dsv/dsv-order-message.service.js';
import type { PrismaDsvDriverNotificationDispatcher } from '../dsv/dsv-driver-notification.dispatcher.js';
import { PrismaDriverSyncHealthService } from './driver-sync-health.service.js';
import type { PrismaOperationalAlertRepository } from '../notifications/operational-alert.repository.js';
import {
  DsvAssignmentCommandError,
  DsvAssignmentCommandService,
  assignmentMap
} from '../dsv/dsv-assignment-command.service.js';

export const DEFAULT_DRIVER_PROOF_MEDIA_RETENTION_DAYS = 180;
export const DEFAULT_DRIVER_EVENT_ATTEMPT_RETENTION_DAYS = 90;
export const DEFAULT_DRIVER_PROOF_MEDIA_READ_ACCESS_TTL_SECONDS = 5 * 60;
export const DEFAULT_DRIVER_PROOF_MEDIA_STORAGE_BACKEND = 'local';
export const DEFAULT_DRIVER_PROOF_MEDIA_STORAGE_DIR = 'var/driver-proof-media';
export const DEFAULT_DRIVER_PROOF_MEDIA_SCANNER_BACKEND = 'none';
export const DEFAULT_DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND = 'none';

export type DriverApiRuntimeEnv = Partial<Record<
  | 'DRIVER_PROOF_MEDIA_READ_ACCESS_TTL_SECONDS'
  | 'DRIVER_ROUTE_COMPLETION_INVARIANT_MODE'
  | 'DRIVER_ROUTE_COMPLETION_REVIEW_RETENTION_DAYS'
  | 'DRIVER_PROOF_MEDIA_RESERVATIONS_ENABLED'
  | 'DRIVER_EVENT_ATTEMPT_RETENTION_DAYS'
  | 'DRIVER_PROOF_MEDIA_RETENTION_DAYS'
  | 'DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND'
  | 'DRIVER_PROOF_MEDIA_SCAN_MONITOR_BEARER_TOKEN'
  | 'DRIVER_PROOF_MEDIA_SCAN_MONITOR_URL'
  | 'DRIVER_PROOF_MEDIA_S3_ACCESS_KEY_ID'
  | 'DRIVER_PROOF_MEDIA_S3_BUCKET'
  | 'DRIVER_PROOF_MEDIA_S3_ENDPOINT'
  | 'DRIVER_PROOF_MEDIA_S3_FORCE_PATH_STYLE'
  | 'DRIVER_PROOF_MEDIA_S3_REGION'
  | 'DRIVER_PROOF_MEDIA_S3_SECRET_ACCESS_KEY'
  | 'DRIVER_PROOF_MEDIA_S3_SESSION_TOKEN'
  | 'DRIVER_PROOF_MEDIA_SCANNER_BACKEND'
  | 'DRIVER_PROOF_MEDIA_SCANNER_BEARER_TOKEN'
  | 'DRIVER_PROOF_MEDIA_SCANNER_URL'
  | 'DRIVER_PROOF_MEDIA_STORAGE_BACKEND'
  | 'DRIVER_PROOF_MEDIA_STORAGE_DIR'
  | 'DRIVER_ROUTE_MAP_PREVIEW_ENABLED'
  | 'DRIVER_ROUTE_MAP_PREVIEW_SECRET'
  | 'DRIVER_ROUTE_MAP_PREVIEW_TTL_SECONDS'
  | 'DELIVERY_API_PUBLIC_URL'
  | 'JWT_SECRET',
  string
>>;

export type DriverProofMediaRetentionPolicy = {
  retentionDays: number;
};

export type DriverProofMediaReadAccessPolicy = {
  readAccessTtlSeconds: number;
};

type DriverProofMediaRepositoryStorageOptions =
  | { storage: DriverProofMediaStorageBackend; storageRoot?: never }
  | { storage?: never; storageRoot: string };

type DriverProofMediaRepositorySafetyOptions = {
  scanMonitor?: DriverProofMediaScanMonitor;
  scanner?: DriverProofMediaScanner;
};

type LoadDriverApiDependenciesInput = {
  adminNotificationService?: Pick<AdminNotificationServiceApi, 'createAdminNotification'>;
  driverNotificationDispatcher?: Pick<PrismaDsvDriverNotificationDispatcher, 'dispatchByIdempotencyKey'>;
  env: DriverApiRuntimeEnv;
  prisma: PrismaClient;
  orderMessageService?: Pick<DsvOrderMessageService, 'markDriverMessageRead'>;
  operationalAlertRepository?: PrismaOperationalAlertRepository;
  routeGroupingService?: RouteGroupingService;
  routeOptimizationScheduler?: DsvRouteOptimizationSchedulerPort;
  routeTrackingStreamHub?: RouteTrackingStreamHub;
};

export function loadDriverApiDependencies(
  input: LoadDriverApiDependenciesInput
): DriverApiDependencies | undefined {
  const completionInvariantMode = loadDriverRouteCompletionInvariantMode(input.env);
  const jwtSecret = readOptional(input.env.JWT_SECRET);
  if (jwtSecret === undefined) {
    return undefined;
  }

  const proofMediaStorageOptions = loadDriverProofMediaRepositoryStorageOptions(input.env);
  const proofMediaSafetyOptions = loadDriverProofMediaRepositorySafetyOptions(input.env);

  const driverAssignedRouteService = new PrismaDriverAssignedRouteRepository(input.prisma);
  const driverSellerOrderContextRepository = new PrismaDriverSellerOrderContextRepository(input.prisma);
  const dsvAssignmentCommandService = input.routeGroupingService === undefined
    ? undefined
    : new DsvAssignmentCommandService(
        input.prisma,
        input.routeGroupingService,
        input.routeOptimizationScheduler,
      );
  const driverRouteMapPreview = loadDriverRouteMapPreviewService({
    assignedRouteService: driverAssignedRouteService,
    env: input.env,
    jwtSecret
  });

  const driverSyncHealthService = new PrismaDriverSyncHealthService(input.prisma, input.operationalAlertRepository);
  return {
    ...(input.adminNotificationService === undefined
      ? {}
      : { adminNotificationService: input.adminNotificationService }),
    driverAssignedRouteService,
    driverDestinationNotesService: new PrismaDriverDestinationNotesRepository(input.prisma),
    driverConsentService: new PrismaDriverConsentRepository(input.prisma),
    driverEventService: new PrismaDriverEventRepository(input.prisma, {
      attemptRetentionDays: loadDriverEventAttemptRetentionPolicy(input.env).retentionDays,
      completionReviewRetentionDays: loadDriverRouteCompletionReviewRetentionDays(input.env),
      completionInvariantMode
    }),
    driverEventReceiptService: new PrismaDriverEventReceiptRepository(input.prisma),
    driverOperationalHealthService: driverSyncHealthService,
    driverSyncHealthService,
    ...(input.routeGroupingService === undefined
      ? {}
      : {
          driverDeliverySpaceService: new DriverDeliverySpaceService(
            new PrismaDriverDeliverySpaceRepository(input.prisma),
            input.routeGroupingService,
            dsvAssignmentCommandService as DsvAssignmentCommandService,
            undefined,
            input.driverNotificationDispatcher
          ),
          driverSellerOrderAssignmentService: new DriverSellerOrderAssignmentService(
            driverSellerOrderContextRepository,
            input.routeGroupingService,
            createDsvDriverSellerOrderAssignmentCommandKernel({
              commandService: dsvAssignmentCommandService as DsvAssignmentCommandService,
              contextRepository: driverSellerOrderContextRepository,
              routeGroupingService: input.routeGroupingService
            })
          )
        }),
    ...(driverRouteMapPreview === undefined
      ? {}
      : {
          driverRouteMapPreviewBaseUrl: driverRouteMapPreview.publicBaseUrl,
          driverRouteMapPreviewService: driverRouteMapPreview.service
        }),
    driverSelfService: new PrismaDriverSelfServiceRepository(input.prisma),
    driverRouteSessionRestoreService: new PrismaDriverRouteSessionRepository(input.prisma, driverAssignedRouteService),
    driverTokenAccessRepository: new PrismaDriverTokenAccessRepository(input.prisma),
    jwtSecret,
    ...(input.orderMessageService === undefined ? {} : { orderMessageService: input.orderMessageService }),
    proofMediaService: new PrismaDriverProofMediaRepository(input.prisma, {
      readAccessTtlSeconds: loadDriverProofMediaReadAccessPolicy(input.env).readAccessTtlSeconds,
      reservationWritesEnabled: readOptionalBoolean(
        input.env.DRIVER_PROOF_MEDIA_RESERVATIONS_ENABLED,
        'DRIVER_PROOF_MEDIA_RESERVATIONS_ENABLED'
      ) === true,
      ...proofMediaStorageOptions,
      ...proofMediaSafetyOptions
    }),
    ...(input.routeTrackingStreamHub === undefined ? {} : { routeTrackingStreamHub: input.routeTrackingStreamHub }),
    ...(input.routeOptimizationScheduler === undefined ? {} : { routeOptimizationScheduler: input.routeOptimizationScheduler }),
    routeAccessService: new PrismaDriverRouteAccessRepository(input.prisma, input.routeGroupingService)
  };
}

export function loadDriverEventAttemptRetentionPolicy(env: DriverApiRuntimeEnv): { retentionDays: number } {
  const retentionDays = readOptionalPositiveInteger(
    env.DRIVER_EVENT_ATTEMPT_RETENTION_DAYS,
    'DRIVER_EVENT_ATTEMPT_RETENTION_DAYS'
  ) ?? DEFAULT_DRIVER_EVENT_ATTEMPT_RETENTION_DAYS;
  if (retentionDays < DEFAULT_DRIVER_EVENT_ATTEMPT_RETENTION_DAYS) {
    throw new Error(`DRIVER_EVENT_ATTEMPT_RETENTION_DAYS must be at least ${DEFAULT_DRIVER_EVENT_ATTEMPT_RETENTION_DAYS}`);
  }
  return { retentionDays };
}

function createDsvDriverSellerOrderAssignmentCommandKernel(input: {
  commandService: Pick<DsvAssignmentCommandService, 'acquire' | 'release'>;
  contextRepository: PrismaDriverSellerOrderContextRepository;
  routeGroupingService: RouteGroupingService;
}): DriverSellerOrderAssignmentCommandKernel {
  return {
    acquireDriverSellerOrder: async (command) => {
      const result = await runDsvDriverCommand(() => input.commandService.acquire({
        ...command,
        sellerOrderId: command.orderId
      }));
      return loadDriverSellerOrderAssignmentResult(input, command, result.routePlanId ?? command.routePlanId, result);
    },
    releaseDriverSellerOrder: async (command) => {
      const result = await runDsvDriverCommand(() => input.commandService.release({
        ...command,
        sellerOrderId: command.orderId
      }));
      return loadDriverSellerOrderAssignmentResult(input, command, result.routePlanId ?? command.routePlanId, result);
    }
  };
}

async function runDsvDriverCommand<T>(command: () => Promise<T>): Promise<T> {
  try {
    return await command();
  } catch (error) {
    if (error instanceof DsvAssignmentCommandError) throw toDriverSellerOrderAssignmentError(error);
    throw error;
  }
}

function toDriverSellerOrderAssignmentError(error: DsvAssignmentCommandError): Error {
  switch (error.code) {
    case 'SELLER_ORDER_ALREADY_ACQUIRED':
      return new DriverSellerOrderAlreadyAcquiredError(error.message);
    case 'SELLER_ORDER_NOT_FOUND':
      return new DriverSellerOrderNotFoundError(error.message);
    case 'SELLER_ORDER_ROUTE_SCOPE_REJECTED':
      return new DriverSellerOrderScopeError(error.message);
    case 'SELLER_ORDER_TARGET_VEHICLE_REQUIRED':
      return new DriverSellerOrderVehicleRequiredError(error.message);
    case 'SELLER_ORDER_TRANSFER_CLOSED':
      return new DriverSellerOrderTransferClosedError(error.message);
    case 'COMMAND_IN_PROGRESS':
    case 'DUPLICATE_ACTIVE_DELIVERY':
    case 'IDEMPOTENCY_PAYLOAD_MISMATCH':
    case 'SELLER_ORDER_ASSIGNMENT_CHANGED':
      return new DriverSellerOrderAssignmentConflictError(error.message);
  }
}

async function loadDriverSellerOrderAssignmentResult(
  dependencies: {
    contextRepository: PrismaDriverSellerOrderContextRepository;
    routeGroupingService: RouteGroupingService;
  },
  command: DriverSellerOrderAssignmentCommandKernelInput,
  routePlanId: string,
  result: Awaited<ReturnType<DsvAssignmentCommandService['acquire']>>
): Promise<DriverSellerOrderAssignmentResult> {
  const context = await dependencies.contextRepository.findRouteContext(command);
  if (context === null) throw new DriverSellerOrderNotFoundError('Current route group was not found.');
  const grouping = await dependencies.routeGroupingService.getGrouping({
    groupingId: context.groupingId,
    shopDomain: command.shopDomain
  });
  if (grouping === null) throw new DriverSellerOrderNotFoundError('Current route group was not found.');
  const assignment = assignmentMap(grouping).get(command.orderId);
  if (assignment === undefined) throw new DriverSellerOrderNotFoundError();
  return {
    auditEventId: result.auditEventId,
    groupingId: grouping.id,
    groupingUpdatedAt: grouping.updatedAt,
    newRouteVersionId: result.newRouteVersionId,
    order: toDriverSellerOrder(assignment),
    previousRouteVersionId: result.previousRouteVersionId,
    receiptId: result.receiptId,
    routePlanId
  };
}

function toDriverSellerOrder(assignment: RouteGroupingAssignmentDto) {
  return {
    addressLabel: assignment.addressLabel,
    itemCount: assignment.itemCount,
    orderId: assignment.orderId,
    orderName: assignment.orderName,
    recipientName: assignment.recipientName,
    sellerOrderKey: assignment.sourceOrderId,
    sourceSequence: assignment.sourceSequence
  };
}

function loadDriverRouteMapPreviewService(input: {
  assignedRouteService: PrismaDriverAssignedRouteRepository;
  env: DriverApiRuntimeEnv;
  jwtSecret: string;
}): { publicBaseUrl: string; service: DriverRouteMapPreviewService } | undefined {
  if (readOptionalBoolean(input.env.DRIVER_ROUTE_MAP_PREVIEW_ENABLED, 'DRIVER_ROUTE_MAP_PREVIEW_ENABLED') !== true) {
    return undefined;
  }
  const publicBaseUrl = readRequiredDriverRouteMapPreviewPublicBaseUrl(input.env);
  const ttlSeconds = readOptionalPositiveInteger(
    input.env.DRIVER_ROUTE_MAP_PREVIEW_TTL_SECONDS,
    'DRIVER_ROUTE_MAP_PREVIEW_TTL_SECONDS'
  ) ?? DEFAULT_DRIVER_ROUTE_MAP_PREVIEW_TTL_SECONDS;
  return {
    publicBaseUrl,
    service: new DriverRouteMapPreviewService({
      assignedRouteService: input.assignedRouteService,
      jwtSecret: readOptional(input.env.DRIVER_ROUTE_MAP_PREVIEW_SECRET) ?? input.jwtSecret,
      ttlSeconds
    })
  };
}

function readRequiredDriverRouteMapPreviewPublicBaseUrl(env: DriverApiRuntimeEnv): string {
  const rawPublicUrl = readOptional(env.DELIVERY_API_PUBLIC_URL);
  if (rawPublicUrl === undefined) {
    throw new Error('DELIVERY_API_PUBLIC_URL is required when DRIVER_ROUTE_MAP_PREVIEW_ENABLED=true');
  }

  try {
    const publicUrl = new URL(rawPublicUrl);
    if (publicUrl.protocol !== 'https:' && publicUrl.protocol !== 'http:') {
      throw new Error('invalid protocol');
    }
    if (
      publicUrl.username !== '' ||
      publicUrl.password !== '' ||
      publicUrl.pathname !== '/' ||
      publicUrl.search !== '' ||
      publicUrl.hash !== ''
    ) {
      throw new Error('not an origin');
    }
    return publicUrl.origin;
  } catch {
    throw new Error('DELIVERY_API_PUBLIC_URL must be an http(s) origin when DRIVER_ROUTE_MAP_PREVIEW_ENABLED=true');
  }
}

export function loadDriverProofMediaRepositoryStorageOptions(env: DriverApiRuntimeEnv): DriverProofMediaRepositoryStorageOptions {
  const backend = readOptional(env.DRIVER_PROOF_MEDIA_STORAGE_BACKEND)?.toLowerCase() ?? DEFAULT_DRIVER_PROOF_MEDIA_STORAGE_BACKEND;
  if (backend === 'local') {
    return { storageRoot: loadDriverProofMediaStorageRoot(env) };
  }
  if (backend === 's3') {
    return {
      storage: createS3DriverProofMediaStorage({
        bucket: readRequiredForS3(env.DRIVER_PROOF_MEDIA_S3_BUCKET, 'DRIVER_PROOF_MEDIA_S3_BUCKET'),
        accessKeyId: readRequiredForS3(env.DRIVER_PROOF_MEDIA_S3_ACCESS_KEY_ID, 'DRIVER_PROOF_MEDIA_S3_ACCESS_KEY_ID'),
        endpoint: readOptional(env.DRIVER_PROOF_MEDIA_S3_ENDPOINT),
        forcePathStyle: readOptionalBoolean(env.DRIVER_PROOF_MEDIA_S3_FORCE_PATH_STYLE, 'DRIVER_PROOF_MEDIA_S3_FORCE_PATH_STYLE'),
        region: readRequiredForS3(env.DRIVER_PROOF_MEDIA_S3_REGION, 'DRIVER_PROOF_MEDIA_S3_REGION'),
        secretAccessKey: readRequiredForS3(env.DRIVER_PROOF_MEDIA_S3_SECRET_ACCESS_KEY, 'DRIVER_PROOF_MEDIA_S3_SECRET_ACCESS_KEY'),
        sessionToken: readOptional(env.DRIVER_PROOF_MEDIA_S3_SESSION_TOKEN)
      })
    };
  }

  throw new Error('DRIVER_PROOF_MEDIA_STORAGE_BACKEND must be local or s3');
}

function loadDriverProofMediaRepositorySafetyOptions(env: DriverApiRuntimeEnv): DriverProofMediaRepositorySafetyOptions {
  return {
    ...loadDriverProofMediaScannerOption(env),
    ...loadDriverProofMediaScanMonitorOption(env)
  };
}

function loadDriverProofMediaScannerOption(env: DriverApiRuntimeEnv): Pick<DriverProofMediaRepositorySafetyOptions, 'scanner'> {
  const backend = readOptional(env.DRIVER_PROOF_MEDIA_SCANNER_BACKEND)?.toLowerCase() ?? DEFAULT_DRIVER_PROOF_MEDIA_SCANNER_BACKEND;
  if (backend === 'none') {
    return {};
  }
  if (backend === 'http') {
    return {
      scanner: createHttpDriverProofMediaScanner({
        bearerToken: readOptional(env.DRIVER_PROOF_MEDIA_SCANNER_BEARER_TOKEN),
        url: readRequiredForHttpScanner(env.DRIVER_PROOF_MEDIA_SCANNER_URL, 'DRIVER_PROOF_MEDIA_SCANNER_URL')
      })
    };
  }

  throw new Error('DRIVER_PROOF_MEDIA_SCANNER_BACKEND must be none or http');
}

function loadDriverProofMediaScanMonitorOption(env: DriverApiRuntimeEnv): Pick<DriverProofMediaRepositorySafetyOptions, 'scanMonitor'> {
  const backend = readOptional(env.DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND)?.toLowerCase() ?? DEFAULT_DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND;
  if (backend === 'none') {
    return {};
  }
  if (backend === 'http') {
    return {
      scanMonitor: createHttpDriverProofMediaScanMonitor({
        bearerToken: readOptional(env.DRIVER_PROOF_MEDIA_SCAN_MONITOR_BEARER_TOKEN),
        url: readRequiredForHttpScanner(env.DRIVER_PROOF_MEDIA_SCAN_MONITOR_URL, 'DRIVER_PROOF_MEDIA_SCAN_MONITOR_URL')
      })
    };
  }

  throw new Error('DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND must be none or http');
}

export function loadDriverProofMediaStorageRoot(env: DriverApiRuntimeEnv): string {
  return readOptional(env.DRIVER_PROOF_MEDIA_STORAGE_DIR) ?? DEFAULT_DRIVER_PROOF_MEDIA_STORAGE_DIR;
}

export function loadDriverProofMediaReadAccessPolicy(
  env: DriverApiRuntimeEnv
): DriverProofMediaReadAccessPolicy {
  const rawTtlSeconds = readOptional(env.DRIVER_PROOF_MEDIA_READ_ACCESS_TTL_SECONDS);
  if (rawTtlSeconds === undefined) {
    return { readAccessTtlSeconds: DEFAULT_DRIVER_PROOF_MEDIA_READ_ACCESS_TTL_SECONDS };
  }

  const readAccessTtlSeconds = Number(rawTtlSeconds);
  if (!Number.isInteger(readAccessTtlSeconds) || readAccessTtlSeconds <= 0) {
    throw new Error('DRIVER_PROOF_MEDIA_READ_ACCESS_TTL_SECONDS must be a positive integer');
  }

  return { readAccessTtlSeconds };
}

export function loadDriverProofMediaRetentionPolicy(env: DriverApiRuntimeEnv): DriverProofMediaRetentionPolicy {
  const rawRetentionDays = readOptional(env.DRIVER_PROOF_MEDIA_RETENTION_DAYS);
  if (rawRetentionDays === undefined) {
    return { retentionDays: DEFAULT_DRIVER_PROOF_MEDIA_RETENTION_DAYS };
  }

  const retentionDays = Number(rawRetentionDays);
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new Error('DRIVER_PROOF_MEDIA_RETENTION_DAYS must be a positive integer');
  }

  return { retentionDays };
}

function readRequiredForHttpScanner(value: string | undefined, name: string): string {
  const normalized = readOptional(value);
  if (normalized === undefined) {
    const backendName = name.includes('SCAN_MONITOR')
      ? 'DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND'
      : 'DRIVER_PROOF_MEDIA_SCANNER_BACKEND';
    throw new Error(`${name} is required when ${backendName}=http`);
  }

  return normalized;
}

function readRequiredForS3(value: string | undefined, name: string): string {
  const normalized = readOptional(value);
  if (normalized === undefined) {
    throw new Error(`${name} is required when DRIVER_PROOF_MEDIA_STORAGE_BACKEND=s3`);
  }

  return normalized;
}

function readOptionalBoolean(value: string | undefined, name: string): boolean | undefined {
  const normalized = readOptional(value);
  if (normalized === undefined) {
    return undefined;
  }
  const lowered = normalized.toLowerCase();
  if (lowered === 'true' || normalized === '1') {
    return true;
  }
  if (lowered === 'false' || normalized === '0') {
    return false;
  }

  throw new Error(`${name} must be true or false`);
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  return value.trim();
}

function readOptionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  const normalized = readOptional(value);
  if (normalized === undefined) {
    return undefined;
  }

  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}
