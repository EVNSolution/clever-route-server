# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY apps/route-ops-web/package.json apps/route-ops-web/package-lock.json ./apps/route-ops-web/
RUN npm --prefix apps/route-ops-web ci
COPY apps/route-ops-web ./apps/route-ops-web
RUN npm --prefix apps/route-ops-web run build \
  && test -f apps/route-ops-web/dist/.vite/manifest.json \
  && test -d apps/route-ops-web/dist/assets \
  && test -d apps/route-ops-web/public/vendor

FROM busybox:1.37.0 AS static
WORKDIR /opt/route-ops-web
LABEL org.clever-route.image-role=route-ops-web-static
COPY --from=build /app/apps/route-ops-web/dist ./dist
COPY --from=build /app/apps/route-ops-web/public ./public
CMD ["sh", "-c", "set -eu; staging=/route-ops-web/.next; rm -rf \"$staging\"; mkdir -p \"$staging\"; cp -a /opt/route-ops-web/dist \"$staging/dist\"; cp -a /opt/route-ops-web/public \"$staging/public\"; find \"$staging\" -type d -exec chmod 0555 {} +; find \"$staging\" -type f -exec chmod 0444 {} +; rm -rf /route-ops-web/dist /route-ops-web/public; mv \"$staging/dist\" /route-ops-web/dist; mv \"$staging/public\" /route-ops-web/public; rmdir \"$staging\""]
