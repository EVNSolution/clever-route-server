import type { FastifyInstance, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export class InvalidJsonBodyError extends Error {
  readonly code = 'CLEVER_INVALID_JSON_BODY';

  constructor() {
    super('Invalid JSON request body');
    this.name = 'InvalidJsonBodyError';
  }
}

export function isInvalidJsonBodyError(error: unknown): error is InvalidJsonBodyError {
  return error instanceof InvalidJsonBodyError;
}

export function registerJsonBodyParser(app: FastifyInstance): void {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const rawBody = Buffer.isBuffer(body) ? body.toString('utf8') : body;
    request.rawBody = rawBody;

    if (rawBody.trim() === '') {
      done(null, undefined);
      return;
    }

    try {
      done(null, JSON.parse(rawBody) as unknown);
    } catch {
      done(new InvalidJsonBodyError());
    }
  });

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (request, body, done) => {
    const rawBody = Buffer.isBuffer(body) ? body.toString('utf8') : body;
    request.rawBody = rawBody;
    done(null, Object.fromEntries(new URLSearchParams(rawBody)));
  });
}

export function getRawBody(request: FastifyRequest): string | null {
  return request.rawBody ?? null;
}
