import { describe, expect, test } from 'vitest';

import { createBulkGeocodeJob, toBulkGeocodeOrderResponse } from '../src/routes/admin-ui-bulk-geocoding.js';

describe('Route Ops bulk geocode summary', () => {
  test('does not double-count no-address rows as skipped', () => {
    const job = createBulkGeocodeJob({ filters: {}, shopDomain: 'tenant-a.example.test' });
    job.counts.noAddress = 2;
    job.counts.skippedByPolicy = 1;

    expect(toBulkGeocodeOrderResponse(job).summary).toEqual(expect.objectContaining({
      noAddress: 2,
      skipped: 1,
      skippedByPolicy: 1,
    }));
  });
});
