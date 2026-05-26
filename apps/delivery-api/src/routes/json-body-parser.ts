import type { FastifyInstance, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
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
    } catch (error) {
      done(error as Error);
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
