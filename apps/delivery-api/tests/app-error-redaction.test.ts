import { describe, expect, test } from 'vitest';

import { buildApp } from '../src/app.js';

describe('application error boundary', () => {
  test('does not allow a caller serializer to expose the error log field', async () => {
    const privateMessage = 'token=error-key-secret error-key@example.invalid 45 Error Lane';
    const logs: string[] = [];
    const app = await buildApp({
      logger: {
        level: 'error',
        serializers: {
          error: () => ({ message: privateMessage, stack: privateMessage })
        },
        stream: { write: (line: string) => logs.push(line) }
      }
    });
    app.get('/caught-error-key', (request, reply) => {
      try {
        throw Object.assign(new Error(privateMessage), { correlationId: 'request-correlation-1' });
      } catch (error) {
        request.log.error({ error }, 'Caught fixture failure');
        return reply.code(500).send({ data: null, error: { code: 'FIXTURE_FAILURE' } });
      }
    });

    try {
      const response = await app.inject({ method: 'GET', url: '/caught-error-key' });
      const serialized = logs.join('\n');

      expect(response.statusCode).toBe(500);
      expect(serialized).toContain('"correlationId":"request-correlation-1"');
      expect(serialized).toContain('errorCode');
      expect(serialized).not.toContain(privateMessage);
      expect(serialized).not.toContain('error-key-secret');
      expect(serialized).not.toContain('error-key@example.invalid');
      expect(serialized).not.toContain('stack');
    } finally {
      await app.close();
    }
  });

  test.each([
    ['/generic-error'],
    ['/admin/orders/error-boundary'],
    ['/driver/error-boundary'],
    ['/api/dsv/error-boundary']
  ])('redacts unexpected errors for %s', async (url) => {
    const privateMessage = 'token=top-secret customer@example.invalid +1 519 555 0199 19 Private Street';
    const logs: string[] = [];
    const app = await buildApp({
      logger: { level: 'error', stream: { write: (line: string) => logs.push(line) } }
    });
    app.get(url, () => {
      throw new Error(privateMessage);
    });

    try {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'INTERNAL_SERVER_ERROR', message: 'An internal server error occurred.' }
      });
      const serialized = `${response.body}\n${logs.join('\n')}`;
      expect(serialized).not.toContain('top-secret');
      expect(serialized).not.toContain('customer@example.invalid');
      expect(serialized).not.toContain('+1 519 555 0199');
      expect(serialized).not.toContain('19 Private Street');
      expect(serialized).not.toContain('stack');
      expect(logs.join('\n')).toContain('unexpected_request_error');
    } finally {
      await app.close();
    }
  });
});
