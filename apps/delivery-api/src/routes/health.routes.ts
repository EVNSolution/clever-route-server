import type { FastifyInstance } from 'fastify';

const SERVICE_NAME = 'clever-route-server';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/healthz', () => ({
    service: SERVICE_NAME,
    status: 'ok'
  }));

  app.get('/readyz', () => ({
    checks: {
      http: true
    },
    service: SERVICE_NAME,
    status: 'ready'
  }));
}
