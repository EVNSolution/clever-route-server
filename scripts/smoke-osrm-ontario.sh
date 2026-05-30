#!/usr/bin/env bash
set -euo pipefail

OSRM_BASE_URL="${OSRM_BASE_URL:-http://127.0.0.1:5000}"
# Toronto City Hall -> Mississauga City Centre, lon/lat order for OSRM.
ROUTE_PATH="${OSRM_SMOKE_ROUTE_PATH:--79.3832,43.6532;-79.6441,43.5890}"

url="${OSRM_BASE_URL%/}/route/v1/driving/${ROUTE_PATH}?overview=full&geometries=geojson&steps=false"
payload="$(curl -fsS "$url")"
node -e '
const payload = JSON.parse(process.argv[1]);
if (payload.code !== "Ok" || !Array.isArray(payload.routes) || !payload.routes[0]?.geometry) {
  throw new Error("OSRM smoke did not return route geometry");
}
console.log(JSON.stringify({
  code: payload.code,
  distance: payload.routes[0].distance ?? null,
  duration: payload.routes[0].duration ?? null,
  coordinates: payload.routes[0].geometry?.coordinates?.length ?? 0
}));
' "$payload"
