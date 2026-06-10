import type { FastifyReply, FastifyRequest } from "fastify";

import { WooCommerceOnboardingError } from "../modules/commerce/woocommerce-connection-onboarding.service.js";
import { RouteScopeConfigValidationError } from "../modules/route-ops/route-scope-config.js";
import { RoutePlanBatchInvalidError } from "../modules/route-plans/route-plan.types.js";
import type { AdminWebSession } from "./admin-ui-session.js";

export type RouteOpsApiResponse<T> = {
  data: T;
  statusCode: number;
};

export class RouteOpsHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "RouteOpsHttpError";
  }
}

export function createRouteOpsApiResponder(input: {
  buildCsp: () => string;
  countRoutePlanBatchBlockers: (
    blockers: readonly string[],
  ) => Record<string, number>;
  sanitizeError: (error: unknown) => string;
}): {
  routeOpsData: <T>(data: T, statusCode?: number) => RouteOpsApiResponse<T>;
  sendRouteOpsApiError: (
    reply: FastifyReply,
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) => unknown;
  withRouteOpsApi: <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    session: AdminWebSession | null,
    handler: (
      session: AdminWebSession,
    ) => Promise<RouteOpsApiResponse<T>> | RouteOpsApiResponse<T>,
  ) => Promise<unknown>;
} {
  function routeOpsData<T>(data: T, statusCode = 200): RouteOpsApiResponse<T> {
    return { data, statusCode };
  }

  function sendRouteOpsApiError(
    reply: FastifyReply,
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): unknown {
    return reply
      .code(statusCode)
      .type("application/json; charset=utf-8")
      .header("Cache-Control", "no-store")
      .header("Content-Security-Policy", input.buildCsp())
      .send({
        data: null,
        error: { code, ...(details === undefined ? {} : { details }), message },
      });
  }

  async function withRouteOpsApi<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    session: AdminWebSession | null,
    handler: (
      session: AdminWebSession,
    ) => Promise<RouteOpsApiResponse<T>> | RouteOpsApiResponse<T>,
  ): Promise<unknown> {
    if (session === null) {
      return sendRouteOpsApiError(
        reply,
        401,
        "UNAUTHORIZED",
        "Admin UI login required",
      );
    }
    try {
      const response = await handler(session);
      return reply
        .code(response.statusCode)
        .type("application/json; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("Content-Security-Policy", input.buildCsp())
        .send({ data: response.data, error: null });
    } catch (error) {
      if (error instanceof RoutePlanBatchInvalidError) {
        request.log.warn(
          {
            blockerCounts: input.countRoutePlanBatchBlockers(error.blockers),
            blockersCount: error.blockers.length,
          },
          "route plan batch creation hard-failed",
        );
        return sendRouteOpsApiError(
          reply,
          400,
          error.code,
          input.sanitizeError(error),
          {
            blockerCounts: input.countRoutePlanBatchBlockers(error.blockers),
            blockers: error.blockers,
          },
        );
      }
      if (error instanceof RouteScopeConfigValidationError) {
        return sendRouteOpsApiError(reply, 400, error.code, error.message);
      }
      if (error instanceof RouteOpsHttpError) {
        return sendRouteOpsApiError(
          reply,
          error.httpStatus,
          error.code,
          error.message,
        );
      }
      const statusCode =
        error instanceof WooCommerceOnboardingError ? error.httpStatus : 500;
      const code =
        error instanceof WooCommerceOnboardingError
          ? error.code
          : "ADMIN_UI_REQUEST_FAILED";
      return sendRouteOpsApiError(
        reply,
        statusCode,
        code,
        input.sanitizeError(error),
      );
    }
  }

  return { routeOpsData, sendRouteOpsApiError, withRouteOpsApi };
}
