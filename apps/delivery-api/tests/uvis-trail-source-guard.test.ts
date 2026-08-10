import { readdir, readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

const shopifyModuleDir = new URL('../src/modules/shopify/', import.meta.url);
const routeTrackingServicePath = new URL('../src/modules/route-tracking/route-tracking.service.ts', import.meta.url);

describe('UVIS trail source guard', () => {
  test('keeps UVIS trail materialization out of Shopify modules and driver-tracking writes', async () => {
    const shopifyFiles = await listTypeScriptFiles(shopifyModuleDir);
    const shopifySource = (await Promise.all(shopifyFiles.map((file) => readFile(file, 'utf8')))).join('\n');
    const routeTrackingService = await readFile(routeTrackingServicePath, 'utf8');

    expect(shopifySource).not.toMatch(/UvisVehicleTrail|uvis_vehicle_trail|roadMatchedGeometry|trailMarker/u);
    expect(routeTrackingService).not.toMatch(/UvisVehicleTrail|uvis_vehicle_trail/u);
  });
});

async function listTypeScriptFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => new URL(entry.name, directory));
}
