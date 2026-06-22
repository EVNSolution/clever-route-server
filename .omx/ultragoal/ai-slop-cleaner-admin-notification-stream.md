AI SLOP CLEANUP REPORT
======================

Scope: Admin notification SSE changed files only (delivery-api notification dependency/service/repository/stream/event mapper, server/composition-root wiring, order-sync ingress dependency loaders, admin UI SSE route/tests, route-ops-web EventSource refresh/tests).
Behavior Lock: Full post-change verification run before cleanup: delivery-api prisma:generate, lint, typecheck, test (91 files / 803 tests), build; route-ops-web lint, typecheck, test (7 files / 170 tests), build; git diff --check.
Cleanup Plan: Bounded review for fallback-like code, dead wrapper code, duplicate notification entrypoints, incomplete dependency wiring, and excluded transport regressions. Preserve DB notification persistence/read-unread and SSE invalidation-only design.
Fallback Findings: New fallback-like findings are grounded fail-safe boundaries: SSE listener exception isolation keeps one subscriber from breaking fanout; advisory notification write failure after committed Woo sync is logged with event/shop/order/error context and covered by regression test. Existing broad route catch patterns predate this change and are outside this cleanup scope.
UI/Design Findings: N/A; no visual design changes.

Passes Completed:
- Fallback-like code resolution gate - repaired silent advisory notification failure by adding warning observability and a regression assertion; preserved intentional SSE subscriber isolation.
1. Pass 1: Dead code deletion - confirmed removed stale wrappers/defaults (`createNotificationOnce`, `defaultAdminNotificationStreamHub`, direct `adminNotification.createMany`) from src scan.
2. Pass 2: Duplicate removal - confirmed single admin notification entrypoint is `createAdminNotification(event)` via injected service.
3. Pass 3: Naming/error handling cleanup - advisory failure warning message and structured bindings added.
4. Pass 4: Test reinforcement - added dependency wiring regression for admin Shopify, WooCommerce webhook, and WordPress plugin order-sync loaders; frontend EventSource test now proves `open`/`message` do not refetch and only `notifications_changed` does; SSE setup-race test proves invalidations observed before headers are flushed after stream open.

Quality Gates:
- Regression tests: PASS (`npm --prefix apps/delivery-api run test -- admin-notification.dependencies.test.ts`, 3 tests; `npm --prefix apps/delivery-api run test -- order-sync.repository.test.ts`, 29 tests; `npm --prefix apps/route-ops-web run test -- drivers-routes.test.tsx layout.test.tsx`, 63 tests)
- Lint: PASS (`npm --prefix apps/delivery-api run lint`; `npm --prefix apps/route-ops-web run lint`)
- Typecheck: PASS (`npm --prefix apps/delivery-api run typecheck`; `npm --prefix apps/route-ops-web run typecheck`)
- Tests: PASS (`npm --prefix apps/delivery-api run test`, 91 files / 803 tests; `npm --prefix apps/route-ops-web run test`, 7 files / 170 tests)
- Static/security scan: PASS with expected/allowed hits only: backend SSE heartbeat `setInterval`, frontend `EventSource`, existing unrelated driver `firebase-admin`, existing unrelated timers.

Changed Files:
- apps/delivery-api/src/modules/notifications/admin-notification.dependencies.ts - single factory for shared notification service/hub.
- apps/delivery-api/src/server.ts - creates one shared notification service and passes it to admin UI, admin Shopify order sync, Woo webhook, and WordPress plugin loaders.
- apps/delivery-api/src/modules/shopify/order-sync.dependencies.ts - accepts/injects notification service.
- apps/delivery-api/src/modules/woocommerce/woocommerce.dependencies.ts - accepts/injects notification service.
- apps/delivery-api/src/modules/wordpress-plugin/wordpress-plugin.dependencies.ts - accepts/injects notification service.
- apps/delivery-api/tests/admin-notification.dependencies.test.ts - locks shared service threading for all order-sync ingress loaders.
- apps/delivery-api/tests/admin-commerce-connections-ui.routes.test.ts - adds setup-race regression for buffered pre-open invalidation flushing.
- apps/route-ops-web/src/api.ts and tests - removed `open` refetch; only `notifications_changed` triggers refetch.
- apps/delivery-api/src/modules/shopify/order-sync.repository.ts - added warning logger hook/default for post-commit advisory notification failures.

Fallback Review:
- Findings: SSE listener catch; post-commit notification catch; existing route/API catches.
- Classification: grounded fail-safe for SSE subscriber isolation and non-rollback notification advisory boundary; existing route/API catches outside this feature cleanup scope.
- Escalation Status: none; actionable silent notification failure and incomplete producer wiring fixed.

Remaining Risks:
- SSE fanout is intentionally process-local for phase 1; deployment must add pub/sub before horizontally scaling delivery-api notification stream instances.
