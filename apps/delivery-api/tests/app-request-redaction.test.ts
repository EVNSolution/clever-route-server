import { describe, expect, test } from 'vitest';

import { redactSensitiveUrl } from '../src/app.js';

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
});
