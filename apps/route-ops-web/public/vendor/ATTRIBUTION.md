# Route Ops Map Vendor Asset Provenance

- `maplibre-gl.css`: copied from the installed `maplibre-gl` npm package so Route Ops can serve MapLibre control styles from the same host.
- `openfreemap-clever-lite.json`: CLEVER-owned compact style manifest adapted from the existing Shopify app OpenFreeMap posture. It references public `tiles.openfreemap.org` endpoints and is therefore never enabled by default; server bootstrap requires `ROUTE_OPS_MAP_PROVIDER_MODE=public_allowlisted` and matching `ROUTE_OPS_MAP_ALLOWED_HOSTS` before it returns configured map mode.
- `openfreemap-self-hosted-fixture.json`: local audit/test fixture with same-origin endpoint shapes. It is not a full tile bundle.

Default unconfigured mode performs no public map/router requests.
