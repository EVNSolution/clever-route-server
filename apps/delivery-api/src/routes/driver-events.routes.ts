import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { MultipartFile, MultipartValue } from '@fastify/multipart';

import {
  signDriverRouteToken,
  verifyDriverAccountToken,
  verifyDriverRouteToken
} from '../modules/driver/driver-token-verifier.js';
import type {
  DriverRouteAccessScope,
  DriverTokenAccessRepositoryApi
} from '../modules/driver/driver-token-access.repository.js';
import type {
  DriverAssignedRoute,
  DriverAssignedRouteServiceContract,
  DriverRouteMapPreview
} from '../modules/driver/driver-assigned-route.types.js';
import type { DriverRouteMapPreviewServiceApi } from '../modules/driver/driver-route-map-preview.service.js';
import type {
  DriverConsentRecordInput,
  DriverConsentServiceContract,
  RecordDriverConsentsInput
} from '../modules/driver/driver-consent.types.js';
import { DriverRouteAssignmentError } from '../modules/driver/driver-consent.repository.js';
import type {
  DriverRouteAccessInvitedRoute,
  DriverRouteAccessLookupInput,
  DriverRouteAccessLookupResult
} from '../modules/driver/driver-route-access.types.js';
import type { DriverRouteAccessServiceApi } from '../modules/driver/driver-route-access.repository.js';
import {
  DriverProofMediaAccessUnavailableError,
  DriverProofMediaScanRejectedError,
  DriverProofMediaScopeError
} from '../modules/driver/driver-proof-media.types.js';
import type {
  DriverProofMediaServiceContract,
  DriverProofMediaSource,
  StoreDriverProofMediaInput
} from '../modules/driver/driver-proof-media.types.js';
import {
  DriverRouteHistoryCursorError,
  DriverSelfServiceScopeError,
  type DriverRouteHistoryStatus
} from '../modules/driver/driver-self-service.types.js';
import type { DriverSelfServiceApi } from '../modules/driver/driver-self-service.repository.js';
import {
  DriverRouteSessionScopeError
} from '../modules/driver/driver-route-session.types.js';
import type { DriverRouteSessionRestoreServiceApi } from '../modules/driver/driver-route-session.repository.js';
import {
  DriverEventContextError,
  DriverEventRouteNotInProgressError,
  DriverEventScopeError
} from '../modules/driver/driver-event.repository.js';
import {
  createRouteTrackingPositionEvent,
  createRouteTrackingProgressEvent
} from '../modules/route-tracking/route-tracking.service.js';
import type { RouteTrackingStreamHub } from '../modules/route-tracking/route-tracking.stream.js';

export type DriverApiDependencies = {
  driverAssignedRouteService?: DriverAssignedRouteServiceContract;
  driverConsentService?: DriverConsentServiceContract;
  driverEventService: {
    recordDriverEvent(input: {
      clientEventId: string | null;
      deliveryStopId: string | null;
      driverId: string;
      eventType: string;
      latitude: string | null;
      longitude: string | null;
      occurredAt: Date;
      payload: unknown;
      routePlanId: string | null;
      shopDomain: string;
      shopId: string;
    }): Promise<{ duplicate: boolean; eventId: string }>;
  };
  driverSelfService?: DriverSelfServiceApi;
  driverRouteSessionRestoreService?: DriverRouteSessionRestoreServiceApi;
  driverRouteMapPreviewBaseUrl?: string;
  driverRouteMapPreviewService?: DriverRouteMapPreviewServiceApi;
  driverTokenAccessRepository?: DriverTokenAccessRepositoryApi;
  jwtSecret: string;
  proofMediaService?: DriverProofMediaServiceContract;
  routeTrackingStreamHub?: RouteTrackingStreamHub;
  now?: () => Date;
  routeAccessService?: DriverRouteAccessServiceApi;
};

type DriverRouteAccessRequestBody = {
  routeContext?: unknown;
};

type DriverAssignedRouteQuery = {
  routeContext?: unknown;
};

type DriverRouteMapPreviewParams = {
  previewId?: unknown;
};

type DriverRouteMapPreviewQuery = {
  expires?: unknown;
  previewId?: unknown;
  signature?: unknown;
};

type DriverRoutesHistoryQuery = {
  cursor?: unknown;
  from?: unknown;
  status?: unknown;
  to?: unknown;
};

type DriverRouteFeedbackParams = {
  routePlanId?: unknown;
};

type DriverRouteFeedbackBody = {
  reviewNote?: unknown;
  submittedAt?: unknown;
};

type DriverProfileUpdateBody = {
  displayName?: unknown;
};

type DriverAccountDeletionRequestBody = {
  confirmation?: unknown;
  reason?: unknown;
};

type DriverEarningsQuery = {
  period?: unknown;
};

type DriverConsentRequestBody = {
  appContext?: unknown;
  consents?: unknown;
  deviceContext?: unknown;
  recordedAt?: unknown;
  routeContext?: unknown;
};

type DriverEventRequestBody = {
  clientEventId?: unknown;
  deliveryStopId?: unknown;
  eventType?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  occurredAt?: unknown;
  routePlanId?: unknown;
};

type DriverProofMediaAccessParams = {
  mediaId?: unknown;
};

type DriverAuthenticationResult =
  | { status: 'authenticated'; context: DriverRouteAccessScope }
  | { status: 'invalid' | 'missing' };

const DRIVER_EVENT_TYPES = new Set([
  'ROUTE_STARTED',
  'ROUTE_PAUSED',
  'ROUTE_COMPLETED',
  'STOP_ARRIVED',
  'STOP_DELIVERED',
  'STOP_FAILED',
  'LOCATION_UPDATED',
  'NOTE_ADDED'
]);

const REQUIRED_DRIVER_CONSENT_TYPES = [
  'LOCATION_INFORMATION',
  'PERSONAL_INFORMATION'
] as const;
const REQUIRED_DRIVER_CONSENT_TYPE_SET = new Set<string>(REQUIRED_DRIVER_CONSENT_TYPES);
const DRIVER_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export function registerDriverEventRoutes(
  app: FastifyInstance,
  dependencies: DriverApiDependencies
): void {
  const routeAccessService = dependencies.routeAccessService;
  if (routeAccessService !== undefined) {
    app.post<{ Body: DriverRouteAccessRequestBody }>(
      '/driver/route-access/lookup',
      async (request, reply) => {
        const token = extractBearerToken(request.headers.authorization);
        if (token === null) {
          return reply.code(401).send(errorResponse('UNAUTHORIZED', 'Missing driver account bearer token'));
        }

        let accountId: string;
        try {
          const now = dependencies.now?.();
          const accountContext = verifyDriverAccountToken(
            token,
            now === undefined ? { secret: dependencies.jwtSecret } : { now, secret: dependencies.jwtSecret }
          );
          accountId = accountContext.accountId;
          if (
            dependencies.driverTokenAccessRepository !== undefined &&
            !(await dependencies.driverTokenAccessRepository.isDriverAccountAccessTokenActive({
              accountId,
              tokenVersion: accountContext.tokenVersion
            }))
          ) {
            return reply.code(401).send(errorResponse('UNAUTHORIZED', 'Invalid driver account bearer token'));
          }
        } catch {
          return reply.code(401).send(errorResponse('UNAUTHORIZED', 'Invalid driver account bearer token'));
        }

        let lookupInput: DriverRouteAccessLookupInput;
        try {
          lookupInput = readDriverRouteAccessBody(request.body, accountId);
        } catch {
          return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid route access lookup payload'));
        }

        const result = await routeAccessService.lookupRouteAccess(lookupInput);
        return reply.code(200).send({
          data: buildDriverRouteAccessResponse(result, dependencies),
          error: null
        });
      }
    );
  }

  const driverAssignedRouteService = dependencies.driverAssignedRouteService;
  if (driverAssignedRouteService !== undefined) {
    app.get<{ Querystring: DriverAssignedRouteQuery }>('/driver/assigned-route', async (request, reply) => {
      const authentication = await authenticateDriverRequest(request, dependencies);
      if (authentication.status !== 'authenticated') {
        return reply
          .code(401)
          .send(driverAuthenticationErrorResponse(authentication.status));
      }
      reply.header('Cache-Control', 'private, no-store');
      const driverContext = authentication.context;

      let routeContext: string | null;
      try {
        routeContext = readOptionalString(request.query.routeContext);
      } catch {
        return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid driver assigned route query'));
      }
      if (routeContext !== null && routeContext !== driverContext.routePlanId) {
        return reply
          .code(403)
          .send(errorResponse('ROUTE_ASSIGNMENT_ACCOUNT_MISMATCH', 'Driver route assignment rejected'));
      }

      const result = await driverAssignedRouteService.getAssignedRoute({
        driverId: driverContext.driverId,
        routeContext: driverContext.routePlanId,
        shopDomain: driverContext.shopDomain,
        shopId: driverContext.shopId
      });

      if (result.status === 'ASSIGNED_ROUTE') {
        return reply.code(200).send({
          data: {
            ...result,
            route: {
              ...result.route,
              routeMapPreview: createDriverRouteMapPreview(dependencies, {
                driverId: driverContext.driverId,
                route: result.route,
                shopDomain: driverContext.shopDomain,
                shopId: driverContext.shopId
              }) ?? result.route.routeMapPreview
            }
          },
          error: null
        });
      }

      return reply.code(200).send({
        data: result,
        error: null
      });
    });
  }

  const driverRouteSessionRestoreService = dependencies.driverRouteSessionRestoreService;
  if (driverRouteSessionRestoreService !== undefined) {
    app.get('/driver/route-session/active', async (request, reply) => {
      const authentication = await authenticateDriverRequest(request, dependencies);
      if (authentication.status !== 'authenticated') {
        return reply
          .code(401)
          .send(driverAuthenticationErrorResponse(authentication.status));
      }
      reply.header('Cache-Control', 'private, no-store');
      const driverContext = authentication.context;

      try {
        const result = await driverRouteSessionRestoreService.getActiveRouteSession({
          driverId: driverContext.driverId,
          routePlanId: driverContext.routePlanId,
          shopDomain: driverContext.shopDomain,
          shopId: driverContext.shopId
        });
        if (result.status !== 'ACTIVE_SESSION') {
          return reply.code(200).send({ data: result, error: null });
        }

        return reply.code(200).send({
          data: {
            ...result,
            route: {
              ...result.route,
              routeMapPreview: createDriverRouteMapPreview(dependencies, {
                driverId: driverContext.driverId,
                route: result.route,
                shopDomain: driverContext.shopDomain,
                shopId: driverContext.shopId
              }) ?? result.route.routeMapPreview
            }
          },
          error: null
        });
      } catch (error) {
        if (error instanceof DriverRouteSessionScopeError) {
          return reply.code(403).send(errorResponse('FORBIDDEN', 'Driver route session scope rejected'));
        }

        throw error;
      }
    });
  }

  const driverRouteMapPreviewService = dependencies.driverRouteMapPreviewService;
  if (driverRouteMapPreviewService !== undefined) {
    app.get<{ Params: DriverRouteMapPreviewParams; Querystring: DriverRouteMapPreviewQuery }>(
      '/driver/route-map-preview/:previewId',
      async (request, reply) => {
        let previewId: string | null;
        let expires: string | null;
        let signature: string | null;
        try {
          const routePreviewId = readOptionalString(request.params.previewId);
          previewId = routePreviewId === 'static'
            ? readOptionalString(request.query.previewId)
            : routePreviewId;
          expires = readOptionalString(request.query.expires);
          signature = readOptionalString(request.query.signature);
        } catch {
          return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid route map preview request'));
        }

        if (previewId === null || expires === null || signature === null) {
          return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid route map preview request'));
        }

        const image = await driverRouteMapPreviewService.readRouteMapPreviewImage({
          expires,
          previewId,
          signature
        });
        if (image === null) {
          return reply.code(404).send(errorResponse('NOT_FOUND', 'Route map preview unavailable'));
        }

        return reply
          .header('Cache-Control', 'private, no-store')
          .type('image/png')
          .send(image);
      }
    );
  }

  const driverSelfService = dependencies.driverSelfService;
  if (driverSelfService !== undefined) {
    app.get<{ Querystring: DriverRoutesHistoryQuery }>('/driver/routes', async (request, reply) => {
      const authentication = await authenticateDriverRequest(request, dependencies);
      if (authentication.status !== 'authenticated') {
        return reply
          .code(401)
          .send(driverAuthenticationErrorResponse(authentication.status));
      }
      const driverContext = authentication.context;

      let query: ReturnType<typeof readDriverRoutesHistoryQuery>;
      try {
        query = readDriverRoutesHistoryQuery(request.query);
      } catch {
        return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid driver route history query'));
      }

      try {
        const result = await driverSelfService.listDriverRoutes({
          ...query,
          driverId: driverContext.driverId,
          shopDomain: driverContext.shopDomain,
          shopId: driverContext.shopId
        });

        return reply.code(200).send({ data: result, error: null });
      } catch (error) {
        if (error instanceof DriverSelfServiceScopeError) {
          return reply.code(403).send(errorResponse('FORBIDDEN', 'Driver route history scope rejected'));
        }
        if (error instanceof DriverRouteHistoryCursorError) {
          return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid driver route history query'));
        }

        throw error;
      }
    });

    app.post<{ Body: DriverRouteFeedbackBody; Params: DriverRouteFeedbackParams }>(
      '/driver/routes/:routePlanId/feedback',
      async (request, reply) => {
        const authentication = await authenticateDriverRequest(request, dependencies);
        if (authentication.status !== 'authenticated') {
          return reply
            .code(401)
            .send(driverAuthenticationErrorResponse(authentication.status));
        }
        const driverContext = authentication.context;

        let feedbackInput: ReturnType<typeof readDriverRouteFeedbackRequest>;
        try {
          feedbackInput = readDriverRouteFeedbackRequest(
            request.params.routePlanId,
            request.body,
            dependencies.now?.() ?? new Date()
          );
        } catch {
          return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid driver route feedback payload'));
        }
        if (feedbackInput.routePlanId !== driverContext.routePlanId) {
          return reply
            .code(403)
            .send(errorResponse('ROUTE_ASSIGNMENT_ACCOUNT_MISMATCH', 'Driver route assignment rejected'));
        }

        try {
          const result = await driverSelfService.submitRouteFeedback({
            ...feedbackInput,
            driverId: driverContext.driverId,
            shopDomain: driverContext.shopDomain,
            shopId: driverContext.shopId
          });

          return reply.code(201).send({ data: result, error: null });
        } catch (error) {
          if (error instanceof DriverSelfServiceScopeError) {
            return reply.code(403).send(errorResponse('FORBIDDEN', 'Route feedback scope rejected'));
          }

          throw error;
        }
      }
    );

    app.get('/driver/profile', async (request, reply) => {
      const authentication = await authenticateDriverRequest(request, dependencies);
      if (authentication.status !== 'authenticated') {
        return reply
          .code(401)
          .send(driverAuthenticationErrorResponse(authentication.status));
      }
      const driverContext = authentication.context;

      try {
        const result = await driverSelfService.getDriverProfile({
          driverId: driverContext.driverId,
          shopDomain: driverContext.shopDomain,
          shopId: driverContext.shopId
        });

        return reply.code(200).send({ data: result, error: null });
      } catch (error) {
        if (error instanceof DriverSelfServiceScopeError) {
          return reply.code(403).send(errorResponse('FORBIDDEN', 'Driver profile scope rejected'));
        }

        throw error;
      }
    });

    app.patch<{ Body: DriverProfileUpdateBody }>('/driver/profile', async (request, reply) => {
      const authentication = await authenticateDriverRequest(request, dependencies);
      if (authentication.status !== 'authenticated') {
        return reply
          .code(401)
          .send(driverAuthenticationErrorResponse(authentication.status));
      }
      const driverContext = authentication.context;

      let updateInput: ReturnType<typeof readDriverProfileUpdateBody>;
      try {
        updateInput = readDriverProfileUpdateBody(request.body);
      } catch {
        return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid driver profile payload'));
      }

      try {
        const result = await driverSelfService.updateDriverProfile({
          ...updateInput,
          driverId: driverContext.driverId,
          shopDomain: driverContext.shopDomain,
          shopId: driverContext.shopId
        });

        return reply.code(200).send({ data: result, error: null });
      } catch (error) {
        if (error instanceof DriverSelfServiceScopeError) {
          return reply.code(403).send(errorResponse('FORBIDDEN', 'Driver profile scope rejected'));
        }

        throw error;
      }
    });

    app.post<{ Body: DriverAccountDeletionRequestBody }>(
      '/driver/account-deletion-requests',
      async (request, reply) => {
        const authentication = await authenticateDriverRequest(request, dependencies);
        if (authentication.status !== 'authenticated') {
          return reply
            .code(401)
            .send(driverAuthenticationErrorResponse(authentication.status));
        }
        const driverContext = authentication.context;

        let deletionInput: ReturnType<typeof readDriverAccountDeletionRequestBody>;
        try {
          deletionInput = readDriverAccountDeletionRequestBody(request.body, dependencies.now?.() ?? new Date());
        } catch {
          return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid account deletion request payload'));
        }

        try {
          const result = await driverSelfService.requestAccountDeletion({
            ...deletionInput,
            driverId: driverContext.driverId,
            shopDomain: driverContext.shopDomain,
            shopId: driverContext.shopId
          });

          return reply.code(202).send({ data: result, error: null });
        } catch (error) {
          if (error instanceof DriverSelfServiceScopeError) {
            return reply.code(403).send(errorResponse('FORBIDDEN', 'Account deletion request scope rejected'));
          }

          throw error;
        }
      }
    );

    app.get<{ Querystring: DriverEarningsQuery }>('/driver/earnings', async (request, reply) => {
      const authentication = await authenticateDriverRequest(request, dependencies);
      if (authentication.status !== 'authenticated') {
        return reply
          .code(401)
          .send(driverAuthenticationErrorResponse(authentication.status));
      }
      const driverContext = authentication.context;

      let period: string;
      try {
        period = readDriverEarningsPeriod(request.query.period, dependencies.now?.() ?? new Date());
      } catch {
        return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid driver earnings query'));
      }

      try {
        const result = await driverSelfService.getDriverEarnings({
          driverId: driverContext.driverId,
          period,
          shopDomain: driverContext.shopDomain,
          shopId: driverContext.shopId
        });

        return reply.code(200).send({ data: result, error: null });
      } catch (error) {
        if (error instanceof DriverSelfServiceScopeError) {
          return reply.code(403).send(errorResponse('FORBIDDEN', 'Driver earnings scope rejected'));
        }

        throw error;
      }
    });
  }

  const driverConsentService = dependencies.driverConsentService;
  if (driverConsentService !== undefined) {
    app.post<{ Body: DriverConsentRequestBody }>('/driver/consents', async (request, reply) => {
      const authentication = await authenticateDriverRequest(request, dependencies);
      if (authentication.status !== 'authenticated') {
        return reply
          .code(401)
          .send(driverAuthenticationErrorResponse(authentication.status));
      }
      const driverContext = authentication.context;

      let consentInput: Omit<RecordDriverConsentsInput, 'accountId' | 'routePlanId'> & {
        routeContext: string | null;
      };
      try {
        consentInput = readDriverConsentBody(request.body, dependencies.now?.() ?? new Date());
      } catch {
        return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid driver consent payload'));
      }
      if (consentInput.routeContext !== null && consentInput.routeContext !== driverContext.routePlanId) {
        return reply
          .code(403)
          .send(errorResponse('ROUTE_ASSIGNMENT_ACCOUNT_MISMATCH', 'Driver route assignment rejected'));
      }

      let result;
      try {
        result = await driverConsentService.recordDriverConsents({
          accountId: driverContext.accountId,
          appContext: consentInput.appContext,
          consents: consentInput.consents,
          deviceContext: consentInput.deviceContext,
          recordedAt: consentInput.recordedAt,
          routePlanId: driverContext.routePlanId
        });
      } catch (error) {
        if (error instanceof DriverRouteAssignmentError) {
          const statusCode = error.code === 'ROUTE_ASSIGNMENT_NOT_FOUND' ? 404 : 403;
          return reply.code(statusCode).send(errorResponse(error.code, 'Driver route assignment rejected'));
        }

        request.log.error({ err: error }, 'driver consent recording failed');
        return reply.code(500).send(errorResponse('CONSENT_RECORD_FAILED', 'Driver consent could not be recorded'));
      }

      return reply.code(201).send({
        data: result,
        error: null
      });
    });
  }


  const proofMediaService = dependencies.proofMediaService;
  if (proofMediaService !== undefined) {
    app.get<{ Params: DriverProofMediaAccessParams }>('/driver/proof-media/:mediaId/access', async (request, reply) => {
      const authentication = await authenticateDriverRequest(request, dependencies);
      if (authentication.status !== 'authenticated') {
        return reply
          .code(401)
          .send(driverAuthenticationErrorResponse(authentication.status));
      }
      const driverContext = authentication.context;

      let mediaId: string;
      try {
        mediaId = readRequiredString(request.params.mediaId);
      } catch {
        return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid proof media access request'));
      }

      try {
        const result = await proofMediaService.createProofMediaReadAccess({
          driverId: driverContext.driverId,
          mediaId,
          routePlanId: driverContext.routePlanId,
          shopDomain: driverContext.shopDomain,
          shopId: driverContext.shopId
        });

        return reply.code(200).send({
          data: result,
          error: null
        });
      } catch (error) {
        if (isProofMediaScopeError(error)) {
          return reply.code(403).send(errorResponse('FORBIDDEN', 'Proof media route scope rejected'));
        }
        if (isProofMediaAccessUnavailableError(error)) {
          return reply
            .code(503)
            .send(errorResponse('PROOF_MEDIA_ACCESS_UNAVAILABLE', 'Proof media access is not configured'));
        }

        throw error;
      }
    });

    app.post('/driver/proof-media', async (request, reply) => {
      const authentication = await authenticateDriverRequest(request, dependencies);
      if (authentication.status !== 'authenticated') {
        return reply
          .code(401)
          .send(driverAuthenticationErrorResponse(authentication.status));
      }
      const driverContext = authentication.context;

      let uploadInput: Omit<StoreDriverProofMediaInput, 'driverId' | 'shopDomain' | 'shopId'>;
      try {
        uploadInput = await readDriverProofMediaUpload(request);
      } catch {
        return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid proof media upload payload'));
      }
      if (uploadInput.routePlanId !== driverContext.routePlanId) {
        return reply
          .code(403)
          .send(errorResponse('ROUTE_ASSIGNMENT_ACCOUNT_MISMATCH', 'Driver route assignment rejected'));
      }

      try {
        const result = await proofMediaService.storeProofMedia({
          ...uploadInput,
          driverId: driverContext.driverId,
          shopDomain: driverContext.shopDomain,
          shopId: driverContext.shopId
        });

        return reply.code(201).send({
          data: result,
          error: null
        });
      } catch (error) {
        if (isProofMediaScopeError(error)) {
          return reply.code(403).send(errorResponse('FORBIDDEN', 'Proof media route scope rejected'));
        }
        if (isProofMediaScanRejectedError(error)) {
          return reply
            .code(422)
            .send(errorResponse('PROOF_MEDIA_REJECTED', 'Proof media rejected by safety scan'));
        }
        if (isProofMediaStorageUnavailableError(error)) {
          return reply
            .code(503)
            .send(errorResponse('PROOF_MEDIA_STORAGE_UNAVAILABLE', 'Proof media storage is temporarily unavailable'));
        }

        throw error;
      }
    });
  }

  app.post<{ Body: DriverEventRequestBody }>('/driver/events', async (request, reply) => {
    const authentication = await authenticateDriverRequest(request, dependencies, {
      allowCompletedRoute: request.body?.eventType === 'ROUTE_COMPLETED'
    });
    if (authentication.status !== 'authenticated') {
      return reply
        .code(401)
        .send(driverAuthenticationErrorResponse(authentication.status));
    }
    const driverContext = authentication.context;

    let eventInput: ReturnType<typeof readDriverEventBody>;
    try {
      eventInput = readDriverEventBody(request.body);
    } catch {
      return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid driver event payload'));
    }
    if (eventInput.routePlanId !== null && eventInput.routePlanId !== driverContext.routePlanId) {
      return reply
        .code(403)
        .send(errorResponse('ROUTE_ASSIGNMENT_ACCOUNT_MISMATCH', 'Driver route assignment rejected'));
    }

    let result: { duplicate: boolean; eventId: string };
    try {
      result = await dependencies.driverEventService.recordDriverEvent({
        ...eventInput,
        driverId: driverContext.driverId,
        payload: request.body,
        routePlanId: driverContext.routePlanId,
        shopDomain: driverContext.shopDomain,
        shopId: driverContext.shopId
      });
    } catch (error) {
      if (error instanceof DriverEventContextError) {
        return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid driver event route or stop context'));
      }
      if (error instanceof DriverEventRouteNotInProgressError) {
        return reply.code(409).send(errorResponse('ROUTE_NOT_IN_PROGRESS', 'Route is not in progress'));
      }
      if (error instanceof DriverEventScopeError) {
        return reply.code(403).send(errorResponse('FORBIDDEN', 'Driver event route or stop scope rejected'));
      }

      throw error;
    }

    if (!result.duplicate && eventInput.eventType === 'LOCATION_UPDATED') {
      const positionEvent = createRouteTrackingPositionEvent({
        driverId: driverContext.driverId,
        eventId: result.eventId,
        latitude: eventInput.latitude,
        longitude: eventInput.longitude,
        occurredAt: eventInput.occurredAt,
        receivedAt: dependencies.now?.() ?? new Date(),
        routePlanId: driverContext.routePlanId
      });
      if (positionEvent !== null) {
        dependencies.routeTrackingStreamHub?.publishPosition(positionEvent);
      }
    } else if (!result.duplicate) {
      const progressEvent = createRouteTrackingProgressEvent({
        deliveryStopId: eventInput.deliveryStopId,
        driverId: driverContext.driverId,
        eventId: result.eventId,
        eventType: eventInput.eventType,
        occurredAt: eventInput.occurredAt,
        receivedAt: dependencies.now?.() ?? new Date(),
        routePlanId: driverContext.routePlanId
      });
      if (progressEvent !== null) {
        dependencies.routeTrackingStreamHub?.publishProgress(progressEvent);
      }
    }

    return reply.code(result.duplicate ? 200 : 202).send({
      data: {
        duplicate: result.duplicate,
        eventId: result.eventId
      },
      error: null
    });
  });
}

async function authenticateDriverRequest(
  request: FastifyRequest,
  dependencies: DriverApiDependencies,
  options: { allowCompletedRoute?: boolean } = {}
): Promise<DriverAuthenticationResult> {
  const token = extractBearerToken(request.headers.authorization);
  if (token === null) {
    return { status: 'missing' };
  }

  let routeToken;
  try {
    const now = dependencies.now?.();
    routeToken = verifyDriverRouteToken(
      token,
      now === undefined ? { secret: dependencies.jwtSecret } : { now, secret: dependencies.jwtSecret }
    );
  } catch {
    return { status: 'invalid' };
  }

  const tokenAccessRepository = dependencies.driverTokenAccessRepository;
  if (tokenAccessRepository === undefined) {
    return { status: 'invalid' };
  }

  const routeAccessInput = {
    accountId: routeToken.accountId,
    routePlanId: routeToken.routePlanId,
    tokenVersion: routeToken.tokenVersion
  };
  const driverContext = options.allowCompletedRoute === true
    ? await tokenAccessRepository.resolveDriverRouteAccess(routeAccessInput, { allowCompleted: true })
    : await tokenAccessRepository.resolveDriverRouteAccess(routeAccessInput);
  if (driverContext === null) return { status: 'invalid' };

  return { status: 'authenticated', context: driverContext };
}

function driverAuthenticationMessage(status: DriverAuthenticationResult['status']): string {
  return status === 'missing' ? 'Missing driver bearer token' : 'Invalid driver access token';
}

function driverAuthenticationErrorResponse(status: DriverAuthenticationResult['status']): unknown {
  return errorResponse(
    status === 'missing' ? 'UNAUTHORIZED' : 'DRIVER_ACCESS_TOKEN_INVALID',
    driverAuthenticationMessage(status)
  );
}

function createDriverRouteMapPreview(
  dependencies: DriverApiDependencies,
  input: {
    driverId: string;
    route: DriverAssignedRoute;
    shopDomain: string;
    shopId: string;
  }
): DriverRouteMapPreview | null {
  if (dependencies.driverRouteMapPreviewService === undefined || dependencies.driverRouteMapPreviewBaseUrl === undefined) {
    return null;
  }
  return dependencies.driverRouteMapPreviewService.createRouteMapPreview({
    baseUrl: dependencies.driverRouteMapPreviewBaseUrl,
    driverId: input.driverId,
    route: input.route,
    shopDomain: input.shopDomain,
    shopId: input.shopId
  });
}

function buildDriverRouteAccessResponse(
  result: DriverRouteAccessLookupResult,
  dependencies: DriverApiDependencies
): unknown {
  if (result.status === 'ROUTES_FOUND') {
    return {
      status: 'ROUTES_FOUND',
      routes: result.routes.map((route) =>
        buildInvitedDriverRouteAccessResponse(route, dependencies, { includeStatus: false })
      )
    };
  }

  if (result.status !== 'INVITED') {
    return result;
  }

  return buildInvitedDriverRouteAccessResponse(result, dependencies, { includeStatus: true });
}

function buildInvitedDriverRouteAccessResponse(
  result: DriverRouteAccessInvitedRoute,
  dependencies: DriverApiDependencies,
  options: { includeStatus: boolean }
): unknown {
  const now = dependencies.now?.();
  const token = signDriverRouteToken(
    {
      accountId: result.driverContext.accountId,
      expiresInSeconds: DRIVER_ACCESS_TOKEN_TTL_SECONDS,
      routePlanId: result.driverContext.routePlanId,
      subject: `driver-account:${result.driverContext.accountId}`,
      tokenVersion: result.driverContext.tokenVersion
    },
    now === undefined ? { secret: dependencies.jwtSecret } : { now, secret: dependencies.jwtSecret }
  );

  return {
    companyGuidance: result.companyGuidance,
    driverAccess: {
      accessToken: token.token,
      expiresAt: token.expiresAt,
      scopes: [
        'route:assigned:read',
        'route:history:read',
        'route:feedback:write',
        'profile:read',
        'profile:update',
        'account_deletion:request',
        'earnings:read'
      ],
      tokenType: token.tokenType,
      ttlSeconds: DRIVER_ACCESS_TOKEN_TTL_SECONDS,
      use: 'consent_and_assigned_route'
    },
    routeAccess: result.routeAccess,
    ...(options.includeStatus ? { status: result.status } : {})
  };
}

function readDriverRouteAccessBody(body: DriverRouteAccessRequestBody, accountId: string): DriverRouteAccessLookupInput {
  const routeContext = readOptionalString(body.routeContext);
  return { accountId, routeContext };
}

function readDriverRoutesHistoryQuery(query: DriverRoutesHistoryQuery): {
  cursor: string | null;
  from: Date | null;
  status: DriverRouteHistoryStatus | null;
  to: Date | null;
} {
  const from = readOptionalDateOnly(query.from);
  const to = readOptionalDateOnly(query.to);
  if (from !== null && to !== null && from.getTime() > to.getTime()) {
    throw new Error('Route history date range is invalid');
  }

  return {
    cursor: readOptionalString(query.cursor),
    from,
    status: readOptionalDriverRouteHistoryStatus(query.status),
    to
  };
}

function readDriverRouteFeedbackRequest(
  routePlanId: unknown,
  body: DriverRouteFeedbackBody,
  fallbackSubmittedAt: Date
): {
  reviewNote: string;
  routePlanId: string;
  submittedAt: Date;
} {
  const reviewNote = readBoundedText(body.reviewNote, { maxLength: 1_000, minLength: 1 });
  return {
    reviewNote,
    routePlanId: readRequiredString(routePlanId),
    submittedAt: readOptionalDate(body.submittedAt) ?? fallbackSubmittedAt
  };
}

function readDriverProfileUpdateBody(body: DriverProfileUpdateBody): { displayName: string } {
  assertOnlyKeys(body, new Set(['displayName']));
  return {
    displayName: readBoundedText(body.displayName, { maxLength: 80, minLength: 1 })
  };
}

function readDriverAccountDeletionRequestBody(
  body: DriverAccountDeletionRequestBody,
  fallbackRequestedAt: Date
): {
  reason: string | null;
  requestedAt: Date;
} {
  assertOnlyKeys(body, new Set(['confirmation', 'reason']));
  if (body.confirmation !== 'DELETE') {
    throw new Error('Explicit DELETE confirmation is required');
  }

  return {
    reason: readOptionalBoundedText(body.reason, { maxLength: 500 }),
    requestedAt: fallbackRequestedAt
  };
}

function readDriverEarningsPeriod(value: unknown, now: Date): string {
  if (value === undefined || value === null) {
    return now.toISOString().slice(0, 7);
  }

  const period = readRequiredString(value);
  if (!/^\d{4}-\d{2}$/u.test(period)) {
    throw new Error('Invalid earnings period');
  }

  const month = Number(period.slice(5, 7));
  if (month < 1 || month > 12) {
    throw new Error('Invalid earnings period');
  }

  return period;
}

function readDriverConsentBody(
  body: DriverConsentRequestBody,
  fallbackRecordedAt: Date
): Omit<RecordDriverConsentsInput, 'accountId' | 'routePlanId'> & { routeContext: string | null } {
  if (!Array.isArray(body.consents)) {
    throw new Error('Consents are required');
  }

  const consents = body.consents.map(readDriverConsentItem);
  const consentTypes = new Set(consents.map((consent) => consent.type));
  if (consents.length !== REQUIRED_DRIVER_CONSENT_TYPES.length) {
    throw new Error('Required driver consent set mismatch');
  }

  for (const consentType of REQUIRED_DRIVER_CONSENT_TYPES) {
    if (!consentTypes.has(consentType)) {
      throw new Error('Required driver consent missing');
    }
  }

  return {
    appContext: readOptionalObject(body.appContext),
    consents,
    deviceContext: readOptionalObject(body.deviceContext),
    recordedAt: readOptionalDate(body.recordedAt) ?? fallbackRecordedAt,
    routeContext: readOptionalString(body.routeContext)
  };
}

function readDriverConsentItem(value: unknown): DriverConsentRecordInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid driver consent item');
  }

  const record = value as Record<string, unknown>;
  const type = readRequiredString(record.type);
  if (!isDriverConsentType(type)) {
    throw new Error('Invalid driver consent type');
  }

  if (record.accepted !== true) {
    throw new Error('Required driver consent must be accepted');
  }

  return {
    accepted: true,
    type,
    version: readRequiredString(record.version)
  };
}

function isDriverConsentType(value: string): value is DriverConsentRecordInput['type'] {
  return REQUIRED_DRIVER_CONSENT_TYPE_SET.has(value);
}

function readDriverEventBody(body: DriverEventRequestBody): {
  clientEventId: string | null;
  deliveryStopId: string | null;
  eventType: string;
  latitude: string | null;
  longitude: string | null;
  occurredAt: Date;
  routePlanId: string | null;
} {
  const eventType = readRequiredString(body.eventType);
  if (!DRIVER_EVENT_TYPES.has(eventType)) {
    throw new Error('Invalid driver event type');
  }

  return {
    clientEventId: readOptionalString(body.clientEventId),
    deliveryStopId: readOptionalString(body.deliveryStopId),
    eventType,
    latitude: readOptionalCoordinate(body.latitude),
    longitude: readOptionalCoordinate(body.longitude),
    occurredAt: readRequiredDate(body.occurredAt),
    routePlanId: readOptionalString(body.routePlanId)
  };
}


async function readDriverProofMediaUpload(
  request: FastifyRequest
): Promise<Omit<StoreDriverProofMediaInput, 'driverId' | 'shopDomain' | 'shopId'>> {
  if (!request.isMultipart()) {
    throw new Error('Proof media upload must be multipart');
  }

  const file = await request.file({
    limits: {
      fields: 3,
      fileSize: 10 * 1024 * 1024,
      files: 1,
      parts: 4
    }
  });

  if (file === undefined || file.fieldname !== 'file') {
    throw new Error('Proof media file is required');
  }

  const deliveryStopId = readMultipartField(file, 'deliveryStopId');
  const routePlanId = readMultipartField(file, 'routePlanId');
  const source = readProofMediaSource(readMultipartField(file, 'source'));
  const fileBytes = await file.toBuffer();
  if (fileBytes.byteLength === 0) {
    throw new Error('Proof media file is empty');
  }

  const contentType = readProofMediaContentType(file.mimetype);

  return {
    contentType,
    deliveryStopId,
    fileBytes,
    filename: readRequiredString(file.filename),
    routePlanId,
    source
  };
}

function readMultipartField(file: MultipartFile, fieldName: string): string {
  const field = file.fields[fieldName];
  const value = Array.isArray(field) ? field[0] : field;
  if (value === undefined || value.type !== 'field') {
    throw new Error(`Multipart field missing: ${fieldName}`);
  }

  return readMultipartFieldValue(value);
}

function readMultipartFieldValue(field: MultipartValue): string {
  if (typeof field.value !== 'string') {
    throw new Error('Multipart field value must be a string');
  }

  return readRequiredString(field.value);
}


function readProofMediaContentType(value: unknown): string {
  const contentType = readRequiredString(value).toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw new Error('Proof media file must be an image');
  }

  return contentType;
}

function readProofMediaSource(value: string): DriverProofMediaSource {
  if (value === 'camera' || value === 'library') {
    return value;
  }

  throw new Error('Invalid proof media source');
}


function isProofMediaScopeError(error: unknown): boolean {
  return error instanceof DriverProofMediaScopeError;
}

function isProofMediaScanRejectedError(error: unknown): boolean {
  return error instanceof DriverProofMediaScanRejectedError;
}

function isProofMediaAccessUnavailableError(error: unknown): boolean {
  return error instanceof DriverProofMediaAccessUnavailableError;
}

function isProofMediaStorageUnavailableError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  return ['EACCES', 'ENOENT', 'ENOTDIR', 'EROFS'].includes(String((error as { code?: unknown }).code));
}

function extractBearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/iu.exec(authorization.trim());
  if (match?.[1] === undefined || match[1].trim() === '') {
    return null;
  }

  return match[1].trim();
}

function readRequiredString(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Required string missing');
  }

  return value.trim();
}

function readOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return readRequiredString(value);
}

function readOptionalObject(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid object');
  }

  return value as Record<string, unknown>;
}

function readOptionalCoordinate(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Invalid coordinate');
  }

  return String(value);
}

function readRequiredDate(value: unknown): Date {
  const raw = readRequiredString(value);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid date');
  }

  return date;
}

function readOptionalDate(value: unknown): Date | null {
  if (value === undefined || value === null) {
    return null;
  }

  return readRequiredDate(value);
}

function readOptionalDateOnly(value: unknown): Date | null {
  if (value === undefined || value === null) {
    return null;
  }

  const raw = readRequiredString(value);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(raw)) {
    throw new Error('Invalid date-only value');
  }
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    throw new Error('Invalid date-only value');
  }

  return date;
}

function readOptionalDriverRouteHistoryStatus(value: unknown): DriverRouteHistoryStatus | null {
  if (value === undefined || value === null) {
    return null;
  }

  const status = readRequiredString(value);
  if (status === 'pending' || status === 'active' || status === 'completed') {
    return status;
  }

  throw new Error('Invalid route history status');
}

function readBoundedText(
  value: unknown,
  bounds: { maxLength: number; minLength: number }
): string {
  const text = readRequiredString(value);
  if (text.length < bounds.minLength || text.length > bounds.maxLength) {
    throw new Error('Text is outside bounds');
  }

  return text;
}

function readOptionalBoundedText(value: unknown, bounds: { maxLength: number }): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const text = readRequiredString(value);
  if (text.length > bounds.maxLength) {
    throw new Error('Text is outside bounds');
  }

  return text;
}

function assertOnlyKeys(value: unknown, allowedKeys: Set<string>): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Payload must be an object');
  }

  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unexpected key: ${key}`);
    }
  }
}

function errorResponse(code: string, message: string): { data: null; error: { code: string; message: string } } {
  return {
    data: null,
    error: { code, message }
  };
}
