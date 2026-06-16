# delivery-api ↔ route_engine optimization contract

## Runtime boundary

`delivery-api` owns Route Ops authentication, route-plan persistence, UI/API
responses, retries, and fallback behavior. `route_engine` owns only the internal
synchronous `/v1/solve` optimization RPC.

No `route_engine` HTTP call is made unless `ROUTE_ENGINE_BASE_URL` is configured.
When it is configured, `ROUTE_ENGINE_INTERNAL_TOKEN` is required and is sent as an
internal bearer token.

## delivery-api env contract

```env
ROUTE_ENGINE_BASE_URL=http://route-engine.internal:8080
ROUTE_ENGINE_INTERNAL_TOKEN=<secret shared with route_engine>
ROUTE_ENGINE_TIMEOUT_MS=180000
ROUTE_ENGINE_MODE=road_graph
ROUTE_ENGINE_OBJECTIVE=minimize_duration
ROUTE_ENGINE_SERVICE_REGION=ontario
```

Leave `ROUTE_ENGINE_BASE_URL` blank to keep the existing CLEVER v1 local
nearest-neighbor sequence heuristic and avoid all route_engine traffic.

## HTTP contract used

`delivery-api` calls `POST {ROUTE_ENGINE_BASE_URL}/v1/solve` with:

- `Authorization: Bearer ${ROUTE_ENGINE_INTERNAL_TOKEN}`
- `X-Request-Id: route-plan:{routePlanId}:optimize`
- `X-Request-Timeout-Ms: {ROUTE_ENGINE_TIMEOUT_MS}`
- JSON body following `EVNSolution/route_engine/docs/api/openapi.yaml`

`delivery-api` sends depot/stop coordinates and internal generated stop ids only.
It does not send recipient names, street addresses, phones, emails, or order raw
payloads as `address_hint`.

## Fallback behavior

The Route Ops optimize API falls back to the current CLEVER v1 heuristic when:

- route_engine env is not configured;
- depot coordinates are unavailable;
- route_engine is unreachable, times out, or returns a non-2xx response;
- route_engine returns a payload outside the committed contract.

The fallback keeps operator route-building available while route_engine rollout is
staged separately from production deployment.

## Verification

Local PR verification should include:

```bash
npm --prefix apps/delivery-api run test -- tests/route-engine-route-optimizer.client.test.ts tests/admin-commerce-connections-ui.routes.test.ts
npm --prefix apps/delivery-api run typecheck
npm --prefix apps/delivery-api run build
```

Production verification is a separate manual step: configure env on the target
runtime, deploy with approved change control, then optimize a non-customer test
route and confirm route_engine logs share the same `X-Request-Id`.
