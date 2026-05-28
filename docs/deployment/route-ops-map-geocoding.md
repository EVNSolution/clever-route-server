# Route Ops map and geocoding deployment notes

Route Ops defaults to fail-closed provider behavior:

- map provider disabled unless `ROUTE_OPS_MAP_*` is explicitly configured;
- geocoding disabled unless `GEOCODING_PROVIDER_MODE` is explicitly changed;
- no browser-side direct geocoding calls;
- no production map/geocoder provider enablement without owner approval and a
  runbook update.

## OpenFreeMap

Public OpenFreeMap tile use requires all of:

```sh
ROUTE_OPS_MAP_STYLE_URL=/admin/ui/app/vendor/openfreemap-clever-lite.json
ROUTE_OPS_MAP_PROVIDER_MODE=public_allowlisted
ROUTE_OPS_MAP_ALLOWED_HOSTS=tiles.openfreemap.org
ROUTE_OPS_MAP_ATTRIBUTION='OpenFreeMap / OpenMapTiles public providers'
```

When these are not set, bootstrap must return `mapConfig.status =
not_configured` and CSP must not allow public tile hosts.

## Geocoding

Geocoding is server-side only. The first implementation must keep public
Nominatim-compatible mode disabled by default and must enforce:

- identifying `GEOCODING_USER_AGENT`;
- provider endpoint switchability via `GEOCODING_SEARCH_URL`;
- rate limiting, defaulting to one request per second;
- persistent cache or durable per-order lookup metadata for public provider
  mode;
- no autocomplete or unbounded bulk geocoding by default.

Operator corrections must persist in CLEVER canonical delivery facts/stops and
must not mutate Woo raw payloads.

When geocoding is configured, Woo order ingest attempts server-side geocoding
before writing canonical delivery stops. Successful lookups are stored with the
order stop coordinates and delivery fact `geocodeStatus=RESOLVED`; failed
lookups do not reject the order ingest and leave the stop pending for operator
repair. Provider approval must explicitly cover this order-ingest volume.

Settings depot geocoding is also server-side only. The Settings tab sends the
typed depot address to `POST /admin/ui/app/api/settings/geocode`; successful
results are saved into the Shop store settings (`defaultDepotAddress`,
`defaultDepotLatitude`, `defaultDepotLongitude`, `locale`). A later request for
the same normalized depot address reuses those saved coordinates from the DB and
does not call the external provider.

## Smoke gates

Run provider-disabled smoke after each deploy with the web login secret supplied out of band:

```sh
ROUTE_OPS_SMOKE_LOGIN_SECRET=... \
ROUTE_OPS_SMOKE_BASE_URL=https://clever-route.cleversystem.ai \
ROUTE_OPS_SMOKE_SHOP_DOMAIN=dev1.tomatonofood.com \
node scripts/smoke-route-ops-production.mjs
```

Disabled-mode expectations:

- `/healthz`, `/admin/ui/app`, `/admin/ui/app/api/bootstrap`, `/admin/ui/app/api/orders`, built assets, and vendor assets return 200.
- `mapConfig.status` remains `not_configured`.
- CSP does not contain `openfreemap.org`/`tiles.openfreemap.org`.
- Orders payload includes `geocodeStatus` and `shippingAddress` for the blocker editor.
- `POST /admin/ui/app/api/orders/:orderId/geocode` fails closed with a user-safe 400 when geocoding is disabled.

Configured provider smoke is an explicit staging/manual run only:

```sh
ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP=true \
ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP_HOSTS=tiles.openfreemap.org \
ROUTE_OPS_EXPECT_GEOCODER_CONFIGURED=true \
ROUTE_OPS_SMOKE_LOGIN_SECRET=... \
node scripts/smoke-route-ops-production.mjs
```

Do not set the `ROUTE_OPS_EXPECT_*` flags in production unless provider enablement has been separately approved and the runtime env has already been reviewed.

## Production enablement policy

Code deployment alone must not enable public map tiles or public geocoding. Enabling either provider requires:

1. explicit owner approval for the provider and address-data disclosure;
2. runtime env update on the server, not a committed secret;
3. smoke evidence for CSP allowlist/mapConfig and geocoder behavior;
4. rollback instructions to unset the provider env and restart `delivery-api`.
