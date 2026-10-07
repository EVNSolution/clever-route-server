import {
  createDsvIsolatedHttpHarness,
  DSV_ISOLATED_PORT,
} from './dsv-isolated-http-harness.js';

const harness = await createDsvIsolatedHttpHarness();
const fixture = await harness.createFixture();

await harness.app.listen({ host: '127.0.0.1', port: DSV_ISOLATED_PORT });
process.stdout.write(`${JSON.stringify({
  baseUrl: `http://127.0.0.1:${DSV_ISOLATED_PORT}`,
  contextId: fixture.contextId,
  serviceDate: fixture.serviceDate,
  shopDomain: fixture.shopDomain,
  nextStopId: fixture.nextStopId,
  stopId: fixture.stopId,
})}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void harness.close().finally(() => process.kill(process.pid, signal));
  });
}
