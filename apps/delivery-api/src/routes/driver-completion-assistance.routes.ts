import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  CompletionAssistanceValidationError,
  parseCompletionCommand,
  type CompletionAcknowledgement,
  type CompletionCandidate,
  type CompletionCommand,
  type CompletionRun
} from '../modules/driver/completion-assistance.contract.js';
import { CompletionAssistanceScopeError } from '../modules/driver/completion-assistance.service.js';
import type { DriverTokenAccessRepositoryApi } from '../modules/driver/driver-token-access.repository.js';
import { verifyDriverAccountToken } from '../modules/driver/driver-token-verifier.js';

export type CompletionAssistanceServiceApi = {
  snapshot(accountId: string): Promise<{
    contractVersion: 1;
    serverTime: string;
    runs: CompletionRun[];
    candidates: CompletionCandidate[];
  }>;
  command(accountId: string, command: CompletionCommand): Promise<CompletionAcknowledgement>;
  processDue(): Promise<number>;
};

export type DriverCompletionAssistanceDependencies = {
  completionAssistanceService: CompletionAssistanceServiceApi;
  driverTokenAccessRepository?: DriverTokenAccessRepositoryApi;
  jwtSecret: string;
  now?: () => Date;
};

export function registerDriverCompletionAssistanceRoutes(
  app: FastifyInstance,
  dependencies: DriverCompletionAssistanceDependencies
): void {
  app.get('/driver/completion-assistance', async (request, reply) => {
    setNoStore(reply);
    const accountId = await authenticateAccount(request, dependencies);
    if (accountId === null) return sendError(reply, 401, 'UNAUTHORIZED', 'Invalid driver account bearer token');

    try {
      return reply.code(200).send(await dependencies.completionAssistanceService.snapshot(accountId));
    } catch (error) {
      if (error instanceof CompletionAssistanceScopeError) {
        return sendError(reply, 403, 'COMPLETION_ASSISTANCE_SCOPE_DENIED', 'Completion assistance scope denied');
      }
      throw error;
    }
  });

  app.post<{ Body: unknown }>('/driver/completion-assistance', async (request, reply) => {
    setNoStore(reply);
    const accountId = await authenticateAccount(request, dependencies);
    if (accountId === null) return sendError(reply, 401, 'UNAUTHORIZED', 'Invalid driver account bearer token');

    let command: CompletionCommand;
    try {
      command = parseCompletionCommand(request.body);
    } catch (error) {
      if (error instanceof CompletionAssistanceValidationError) {
        return sendError(reply, 400, error.code, error.message);
      }
      throw error;
    }

    try {
      return reply.code(200).send(await dependencies.completionAssistanceService.command(accountId, command));
    } catch (error) {
      if (error instanceof CompletionAssistanceScopeError) {
        return sendError(reply, 403, 'COMPLETION_ASSISTANCE_SCOPE_DENIED', 'Completion assistance scope denied');
      }
      throw error;
    }
  });
}

async function authenticateAccount(
  request: FastifyRequest,
  dependencies: DriverCompletionAssistanceDependencies
): Promise<string | null> {
  const match = /^Bearer\s+(.+)$/iu.exec(request.headers.authorization?.trim() ?? '');
  if (match?.[1] === undefined || dependencies.driverTokenAccessRepository === undefined) return null;

  try {
    const now = dependencies.now?.();
    const account = verifyDriverAccountToken(
      match[1].trim(),
      now === undefined ? { secret: dependencies.jwtSecret } : { now, secret: dependencies.jwtSecret }
    );
    return await dependencies.driverTokenAccessRepository.isDriverAccountAccessTokenActive({
      accountId: account.accountId,
      tokenVersion: account.tokenVersion
    }) ? account.accountId : null;
  } catch {
    return null;
  }
}

function setNoStore(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
}

function sendError(reply: FastifyReply, statusCode: number, code: string, message: string): FastifyReply {
  return reply.code(statusCode).send({ contractVersion: 1, error: { code, message } });
}
