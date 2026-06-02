# WooCommerce raw order processing handoff

Purpose: make WooCommerce ingestion cheap and reliable by separating **raw order intake** from **server-side processing**. This follows the approved Ralplan state for Woo REST/manual sync raw-only/no-geocoding, durable OSRM runtime, and a Phase 2 durable event/job lane.

## Current Phase 1A baseline

- `WooCommerceOrderSyncService.syncUpdatedOrders()` reads Woo REST pages and calls `syncOrders({ reason: "scheduled_incremental" })`.
- Non-webhook reasons (`manual_backfill`, `scheduled_incremental`) must not geocode during sync. They may still map and upsert canonical order rows/delivery facts with `PENDING` coordinates.
- Webhook order ingest remains the one-order path allowed to do immediate geocoding while traffic is naturally low.

## Target split

```text
Woo REST/manual sync          Woo webhook
        |                         |
        v                         v
 raw order event intake       signed raw order event intake
        |                         |
        +----------+--------------+
                   v
        commerce_order_events  (durable raw payload + idempotency)
                   |
                   v
        order_processing_jobs  (retryable bounded processing)
                   |
                   v
 raw -> canonical order / delivery stop / delivery fact
                   |
                   +---- geocode job when policy allows
                   |
                   v
 Route Ops orders/routes UI reads canonical tables only
```

## Durable tables to add

### `commerce_order_events`

Recommended columns:

- `id uuid primary key`
- `shop_id uuid not null`
- `commerce_connection_id uuid not null`
- `platform text not null default 'woocommerce'`
- `source text not null` — `rest_manual`, `rest_scheduled`, `webhook`
- `source_order_id text not null`
- `webhook_delivery_id text null`
- `payload_hash text not null`
- `raw_payload jsonb not null`
- `status text not null` — `ACCEPTED`, `PROCESSING`, `PROCESSED`, `FAILED`, `SUPERSEDED`
- `accepted_at timestamptz not null default now()`
- `processed_at timestamptz null`
- `last_error text null`
- `attempt_count int not null default 0`

Indexes/uniques:

- unique `(commerce_connection_id, webhook_delivery_id)` where `webhook_delivery_id is not null`
- unique `(commerce_connection_id, source_order_id, payload_hash)`
- index `(shop_id, status, accepted_at)`
- index `(commerce_connection_id, source_order_id, accepted_at desc)`

### `order_processing_jobs`

Recommended columns:

- `id uuid primary key`
- `order_event_id uuid not null references commerce_order_events(id)`
- `shop_id uuid not null`
- `kind text not null` — `RAW_TO_CANONICAL`, `GEOCODE_DELIVERY_STOP`
- `status text not null` — `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `DEAD`
- `priority int not null default 100`
- `run_after timestamptz not null default now()`
- `locked_at timestamptz null`
- `locked_by text null`
- `attempt_count int not null default 0`
- `last_error text null`
- `created_at`, `updated_at`, `completed_at`

Indexes:

- index `(status, run_after, priority)`
- unique `(order_event_id, kind)` for idempotent job creation

## Processor behavior

1. **Intake**
   - Validate tenant/connection first.
   - Persist raw Woo payload and headers/delivery id before processing.
   - Return quickly: REST/manual reports accepted counts; webhook returns `202` after durable event+job write.

2. **Raw-to-canonical job**
   - Load latest mapping config for the connection.
   - Call the existing Woo mapper (`mapWooCommerceOrderToDeliveryInputs`) in a pure deterministic step.
   - Upsert canonical order, delivery stop, and order delivery facts in one transaction.
   - Mark event `PROCESSED` only after canonical upsert succeeds.

3. **Geocode job**
   - Do not run from REST/manual sync directly.
   - Do not keep using the current `reason` string as a hidden geocode policy switch once Phase 2 starts. Introduce an explicit `processingMode`/`geocodePolicy` such as `RAW_ONLY`, `CANONICAL_ONLY`, and `CANONICAL_WITH_GEOCODE`.
   - Webhook can enqueue `GEOCODE_DELIVERY_STOP` after `RAW_TO_CANONICAL`, or execute it inline only while the durable job table remains the source of truth.
   - Bound concurrency per process and per shop; failed geocode stores diagnostics in delivery facts without corrupting JSONB shape.

4. **Retries and visibility**
   - Retry transient failures with backoff.
   - Move exhausted jobs to `DEAD`, keep `last_error`, and expose counts on the Woo connection/setup page.
   - `CommerceSyncRun` should report `accepted`, `processed`, `failed`, and `pending` instead of hiding background errors in logs only.

## Implementation touchpoints

- Prisma schema/migration: add `CommerceOrderEvent` and `OrderProcessingJob` models.
- Repository: add event/job create, claim, complete, fail, and idempotent enqueue APIs.
- Woo sync service: split raw event recording from current `syncOrders` processing.
- Woo webhook route: write event+job before returning `202`; keep signature validation unchanged.
- Worker/runner: start with in-process bounded polling; design so it can move to a separate worker later.
- Admin connection UI/API: surface pending/failed event/job counts and latest error.

## Test shape

- REST/manual sync with private geocoder configured does not call geocode and creates raw events/jobs only.
- Webhook duplicate delivery id is idempotent.
- Raw-to-canonical job can be retried without duplicate canonical orders/stops.
- Bad payload records failed event/job with redacted error and does not block later events.
- Job worker honors bounded concurrency and per-shop idempotency.
- Admin status exposes accepted/processed/failed/pending counts.

## Rollout plan

1. Ship Phase 1A/1B first: REST/manual no-geocode and durable OSRM runtime.
2. Add event/job tables with write path disabled behind an env flag.
3. Enable event recording for REST/manual sync while still running current processing path.
4. Move REST/manual processing to jobs.
5. Move webhook processing to durable event+job, preserving `202` behavior.
6. Remove the old fire-and-forget background webhook path after job metrics are visible.
