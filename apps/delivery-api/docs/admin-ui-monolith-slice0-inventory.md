# Admin UI Monolith Slice 0 Inventory

This inventory locks the current public route/action surface before refactoring `src/routes/admin-commerce-connections-ui.routes.ts` into a facade plus cohesive domain modules. It intentionally rejects the old 131-file micro-module split shape.

## Baseline

- Source file: `apps/delivery-api/src/routes/admin-commerce-connections-ui.routes.ts`
- Baseline line count: 7028
- Baseline route registrations: 87
- Current main support modules: `admin-ui-form.ts`, `admin-ui-session.ts`
- Refactor target: facade route registration/orchestration only, <=2500 lines after full integration
- Domain module target: 6-10 cohesive modules, no standalone tiny module proliferation

## Route inventory

| Line | Method | Path expression | Planned domain |
| ---: | --- | --- | --- |
| 413 | GET | `"/"` | shell/rendering |
| 415 | GET | `ADMIN_ROOT_PATH` | shell/rendering |
| 419 | GET | `ADMIN_UI_WOOCOMMERCE_TEST_SCRIPT_PATH` | commerce/settings |
| 427 | GET | `ADMIN_UI_ROUTE_APP_SCRIPT_PATH` | shell/static |
| 437 | GET | `ADMIN_UI_PLUGIN_LAUNCH_PATH` | session/security |
| 481 | GET | `ADMIN_UI_ROOT_PATH` | shell/rendering |
| 501 | GET | `ADMIN_UI_STORE_SESSIONS_PATH` | shell/rendering |
| 514 | GET | `ADMIN_UI_COMMERCE_CONNECTIONS_PATH` | commerce/settings |
| 534 | GET | `ADMIN_UI_APP_PATH` | shell/rendering |
| 540 | GET | `ADMIN_UI_APP_DASHBOARD_PATH` | shell/rendering |
| 546 | GET | `ADMIN_UI_APP_ORDERS_PATH` | shell/rendering |
| 552 | GET | `ADMIN_UI_APP_ROUTE_PLANS_PATH` | route-planning/drivers |
| 558 | GET | ``${ADMIN_UI_APP_ROUTE_PLANS_PATH}/new`` | route-planning/drivers |
| 564 | GET | ``${ADMIN_UI_APP_ROUTE_PLANS_PATH}/:routePlanId`` | route-planning/drivers |
| 573 | POST | ``${ADMIN_UI_APP_ROUTE_PLANS_PATH}/create`` | route-planning/drivers |
| 582 | POST | ``${ADMIN_UI_APP_ROUTE_PLANS_PATH}/:routePlanId/stops`` | route-planning/drivers |
| 597 | POST | ``${ADMIN_UI_APP_ROUTE_PLANS_PATH}/:routePlanId/driver`` | route-planning/drivers |
| 612 | POST | ``${ADMIN_UI_APP_ROUTE_PLANS_PATH}/:routePlanId/optimize`` | route-planning/drivers |
| 627 | GET | `ADMIN_UI_APP_DRIVERS_PATH` | shell/rendering |
| 633 | POST | `ADMIN_UI_APP_DRIVERS_PATH` | shell/rendering |
| 639 | GET | `ADMIN_UI_APP_SETTINGS_PATH` | shell/rendering |
| 645 | POST | `ADMIN_UI_APP_SETTINGS_PATH` | shell/rendering |
| 651 | GET | `ADMIN_UI_ROUTE_PLANS_PATH` | route-planning/drivers |
| 661 | POST | ``${ADMIN_UI_ROUTE_PLANS_PATH}/create`` | route-planning/drivers |
| 667 | POST | ``${ADMIN_UI_ROUTE_PLANS_PATH}/:routePlanId/stops`` | route-planning/drivers |
| 682 | POST | ``${ADMIN_UI_ROUTE_PLANS_PATH}/:routePlanId/driver`` | route-planning/drivers |
| 697 | GET | `ADMIN_UI_ORDERS_PATH` | shell/rendering |
| 707 | GET | `ADMIN_UI_DRIVERS_PATH` | shell/rendering |
| 717 | POST | `ADMIN_UI_DRIVERS_PATH` | shell/rendering |
| 723 | GET | `ADMIN_UI_SETTINGS_PATH` | shell/rendering |
| 733 | POST | `ADMIN_UI_SETTINGS_PATH` | shell/rendering |
| 739 | GET | `LEGACY_ADMIN_UI_WOOCOMMERCE_LOGIN_PATH` | session/security |
| 742 | POST | `LEGACY_ADMIN_UI_WOOCOMMERCE_LOGIN_PATH` | session/security |
| 746 | GET | `ADMIN_UI_LOGIN_PATH` | session/security |
| 755 | POST | `ADMIN_UI_LOGIN_PATH` | session/security |
| 828 | GET | `ADMIN_UI_WOOCOMMERCE_PATH` | commerce/settings |
| 850 | GET | `ADMIN_UI_LOGOUT_PATH` | session/security |
| 853 | POST | `ADMIN_UI_LOGOUT_PATH` | session/security |
| 856 | GET | `LEGACY_ADMIN_UI_WOOCOMMERCE_LOGOUT_PATH` | session/security |
| 859 | POST | `LEGACY_ADMIN_UI_WOOCOMMERCE_LOGOUT_PATH` | session/security |
| 863 | POST | ``${ADMIN_UI_WOOCOMMERCE_PATH}/test`` | commerce/settings |
| 915 | POST | `ADMIN_UI_WOOCOMMERCE_PATH` | commerce/settings |
| 956 | POST | ``${ADMIN_UI_WOOCOMMERCE_PATH}/:connectionId/credentials`` | commerce/settings |
| 1021 | POST | ``${ADMIN_UI_WOOCOMMERCE_PATH}/:connectionId/webhook-secret`` | commerce/settings |
| 1074 | POST | ``${ADMIN_UI_WOOCOMMERCE_PATH}/:connectionId/pairing-code`` | commerce/settings |
| 1127 | POST | ``${ADMIN_UI_WOOCOMMERCE_PATH}/:connectionId/status`` | commerce/settings |
| 1177 | GET | ``${ADMIN_UI_APP_PATH}/*`` | shell/rendering |
| 1182 | GET | ``${ADMIN_UI_ROOT_PATH}/*`` | shell/rendering |
| 1192 | GET | ``${ADMIN_UI_APP_ASSETS_PATH}/*`` | shell/static |
| 1198 | GET | ``${ADMIN_UI_APP_VENDOR_PATH}/*`` | shell/static |
| 1204 | GET | ``${ADMIN_UI_APP_API_PATH}/bootstrap`` | api-response/fallback |
| 1229 | GET | ``${ADMIN_UI_APP_API_PATH}/notifications`` | orders/sync |
| 1251 | PATCH | ``${ADMIN_UI_APP_API_PATH}/notifications/:notificationId/read`` | orders/sync |
| 1280 | GET | ``${ADMIN_UI_APP_API_PATH}/orders`` | orders/sync |
| 1333 | POST | ``${ADMIN_UI_APP_API_PATH}/orders/sync`` | orders/sync |
| 1358 | GET | ``${ADMIN_UI_APP_API_PATH}/orders/sync/latest`` | orders/sync |
| 1375 | GET | ``${ADMIN_UI_APP_API_PATH}/orders/sync/:syncRunId`` | orders/sync |
| 1409 | POST | ``${ADMIN_UI_APP_API_PATH}/orders/woo/:sourceOrderId/sync`` | orders/sync |
| 1436 | POST | ``${ADMIN_UI_APP_API_PATH}/orders/bulk-geocode`` | orders/sync |
| 1459 | GET | ``${ADMIN_UI_APP_API_PATH}/orders/bulk-geocode/:jobId`` | orders/sync |
| 1471 | POST | ``${ADMIN_UI_APP_API_PATH}/orders/geocode`` | orders/sync |
| 1497 | GET | ``${ADMIN_UI_APP_API_PATH}/orders/geocode/:jobId`` | orders/sync |
| 1509 | GET | ``${ADMIN_UI_APP_API_PATH}/orders/:orderId`` | orders/sync |
| 1538 | GET | ``${ADMIN_UI_APP_API_PATH}/orders/:orderId/metadata-diagnostics`` | orders/sync |
| 1570 | PATCH | ``${ADMIN_UI_APP_API_PATH}/orders/:orderId/metadata`` | orders/sync |
| 1604 | PATCH | ``${ADMIN_UI_APP_API_PATH}/orders/:orderId/coordinates`` | orders/sync |
| 1640 | POST | ``${ADMIN_UI_APP_API_PATH}/orders/:orderId/geocode`` | orders/sync |
| 1754 | GET | ``${ADMIN_UI_APP_API_PATH}/order-batches`` | orders/sync |
| 1776 | GET | ``${ADMIN_UI_APP_API_PATH}/routes`` | route-planning/drivers |
| 1795 | POST | ``${ADMIN_UI_APP_API_PATH}/routes`` | route-planning/drivers |
| 1828 | GET | ``${ADMIN_UI_APP_API_PATH}/routes/:routePlanId`` | route-planning/drivers |
| 1849 | DELETE | ``${ADMIN_UI_APP_API_PATH}/routes/:routePlanId`` | route-planning/drivers |
| 1871 | PATCH | ``${ADMIN_UI_APP_API_PATH}/routes/:routePlanId`` | route-planning/drivers |
| 1964 | PATCH | ``${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/stops`` | route-planning/drivers |
| 1999 | POST | ``${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/optimize`` | route-planning/drivers |
| 2038 | PATCH | ``${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/driver`` | route-planning/drivers |
| 2062 | PATCH | ``${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/options`` | route-planning/drivers |
| 2104 | POST | ``${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/publish`` | route-planning/drivers |
| 2144 | GET | ``${ADMIN_UI_APP_API_PATH}/drivers`` | route-planning/drivers |
| 2157 | POST | ``${ADMIN_UI_APP_API_PATH}/drivers`` | route-planning/drivers |
| 2184 | POST | ``${ADMIN_UI_APP_API_PATH}/drivers/:driverId/regenerate-invite-code`` | route-planning/drivers |
| 2222 | DELETE | ``${ADMIN_UI_APP_API_PATH}/drivers/:driverId`` | route-planning/drivers |
| 2260 | GET | ``${ADMIN_UI_APP_API_PATH}/settings`` | api-response/fallback |
| 2276 | PATCH | ``${ADMIN_UI_APP_API_PATH}/settings`` | api-response/fallback |
| 2308 | POST | ``${ADMIN_UI_APP_API_PATH}/settings/geocode`` | geocoding |
| 2381 | GET | `ADMIN_UI_APP_API_PATH` | api-response/fallback |
| 2385 | GET | ``${ADMIN_UI_APP_API_PATH}/*`` | api-response/fallback |

## Action/form inventory

- Login/logout: `POST ADMIN_UI_LOGIN_PATH`, `POST ADMIN_UI_LOGOUT_PATH`, legacy WooCommerce login/logout redirects.
- Woo connection setup: Woo test, credential save, webhook secret save, pairing-code generation, status checks.
- Route Ops SPA/API: bootstrap, notifications, order list/sync/single sync, bulk geocode, single geocode, metadata/coordinate patches, order batch candidates.
- Route planning: route list/create/detail/delete/update/stops/optimize/driver/options/publish.
- Drivers/settings: driver list/create/invite/delete, settings read/update, depot/geocode settings.

## Security and response boundaries

- Session/security must preserve web login secret checks, plugin launch sessions, cookie path/same-site semantics, CSRF validation, same-origin mutation checks, and `returnTo` sanitization.
- Store workspace routes must preserve `shopDomain` gates and plugin session behavior.
- API responses must preserve JSON envelope shape `{ data, error }`, status codes, and sanitized error messages.
- Browser routes must preserve redirect vs HTML vs JSON behavior, including 404 JSON behavior for API/fallback paths.

## Service dependency map for extraction

- `session-security`: admin web session, login secret, launch tokens, CSRF, origin/same-origin, redirects.
- `shell-rendering`: document shell, login/dashboard/store-session pages, Route Ops SPA/static shell, navigation, HTML escaping.
- `commerce-settings`: Woo connection service, credentials, pairing-code, webhook setup, settings save/read.
- `orders-sync`: order sync service, notification service, order DTO/filter/read/sync actions.
- `geocoding` and `bulk-geocoding`: geocoding service, coordinate/address parsing, job lifecycle, diagnostics/patch payloads.
- `route-planning`: route plan service, route optimizer, driver service, stop ordering, publish/driver assignment/options.
- `api-response`: API envelope and error response utilities.

## Old split branch oracle classification

Allowed uses:

- Compare old-branch tests against current behavior.
- Harvest logic only when it fits one of the cohesive domain modules above.
- Keep tiny reusable routines as private functions inside domain modules if extraction is still useful.

Rejected by default:

- 131 `admin-ui-*.ts` micro-file shape.
- One-file-per-function modules such as message/html-escape/alert/nav-link/text/module-card.
- `.github`, env, infra, deploy, or config changes.
- Blind cherry-pick of old micro-split commits.

## Characterization test lock

`apps/delivery-api/tests/admin-ui-route-inventory.test.ts` snapshots the exact route registration surface and high-risk mutation paths. Any extraction that changes route registration shape must update the inventory intentionally and pass route/UI behavior tests.
