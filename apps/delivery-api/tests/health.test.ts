import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';

describe('health routes', () => {
  test('GET /healthz reports the service is alive', async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/healthz' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        service: 'clever-route-server',
        status: 'ok'
      });
    } finally {
      await app.close();
    }
  });

  test('GET /readyz reports the scaffold is ready to receive HTTP traffic', async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/readyz' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        checks: {
          http: true
        },
        service: 'clever-route-server',
        status: 'ready'
      });
    } finally {
      await app.close();
    }
  });
});
