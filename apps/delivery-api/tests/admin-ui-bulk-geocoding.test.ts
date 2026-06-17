import { describe, expect, test } from 'vitest';

import { createBulkGeocodeJob, toBulkGeocodeOrderResponse } from '../src/routes/admin-ui-bulk-geocoding.js';

describe('Route Ops bulk geocode summary', () => {
  test('reports no-address rows without skipped state', () => {
    const job = createBulkGeocodeJob({ filters: {}, shopDomain: 'tenant-a.example.test' });
    job.counts.noAddress = 2;

    const response = toBulkGeocodeOrderResponse(job);
    expect(response.summary).toEqual(expect.objectContaining({
      noAddress: 2,
    }));
    expect(response.summary).not.toHaveProperty('skipped');
    expect(response.summary).not.toHaveProperty('skippedByPolicy');
    expect(response).not.toHaveProperty('policyLimit');
  });
});
