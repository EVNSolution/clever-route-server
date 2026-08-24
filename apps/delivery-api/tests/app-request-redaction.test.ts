import { describe, expect, test } from 'vitest';

import { buildApp, redactSensitiveUrl } from '../src/app.js';

describe('safe request logging', () => {
  test('redacts route map preview capability path and signed query values from request logs', () => {
    expect(redactSensitiveUrl('/driver/route-map-preview/static?previewId=opaque-id&expires=1781140000000&signature=secret-signature')).toBe(
      '/driver/route-map-preview/[redacted]?previewId=%5Bredacted%5D&expires=%5Bredacted%5D&signature=%5Bredacted%5D'
    );
  });

  test('redacts encoded route map preview capability paths without preserving tokens', () => {
    expect(redactSensitiveUrl('/driver/route-map-preview/%E0%A4%A?expires=1781140000000&signature=secret-signature')).toBe(
      '/driver/route-map-preview/[redacted]?expires=%5Bredacted%5D&signature=%5Bredacted%5D'
    );
  });

  test('allowlists generic driver event request logs without request or network data', async () => {
    const logLines: string[] = [];
    const app = await buildApp({
      logger: {
        level: 'info',
        stream: { write: (line: string) => logLines.push(line) }
      }
    });
    const secrets = {
      address: '742 Private Evidence Street',
      note: 'leave proof behind the private gate',
      payload: 'private-event-payload',
      proof: 'proof-media-private-token',
      token: 'driver-private-bearer-token'
    };
    app.post('/driver/events', () => ({ data: null, error: null }));

    try {
      const response = await app.inject({
        headers: {
          authorization: `Bearer ${secrets.token}`,
          cookie: 'driver_session=private-cookie',
          host: 'route-api.internal.test',
          'x-forwarded-for': '198.51.100.42',
          'x-private-address': secrets.address
        },
        method: 'POST',
        payload: {
          address: secrets.address,
          note: secrets.note,
          payload: secrets.payload,
          proof: secrets.proof
        },
        url: '/driver/events'
      });

      expect(response.statusCode).toBe(200);
      const incoming = logLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((record) => record.msg === 'incoming request');
      expect(incoming).toBeDefined();
      expect(incoming?.req).toEqual({
        host: 'route-api.internal.test',
        method: 'POST',
        url: '/driver/events'
      });
      const serialized = JSON.stringify(incoming);
      for (const secret of Object.values(secrets)) expect(serialized).not.toContain(secret);
      for (const forbidden of [
        'authorization',
        'address',
        'body',
        'cookie',
        'headers',
        'note',
        'payload',
        'proof',
        'remoteAddress',
        'remotePort',
        'socket',
        'token',
        'x-forwarded-for'
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      await app.close();
    }
  });
});
