# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY apps/delivery-api/package.json apps/delivery-api/package-lock.json ./apps/delivery-api/
RUN npm --prefix apps/delivery-api ci

FROM deps AS build
COPY apps/delivery-api/prisma ./apps/delivery-api/prisma
COPY apps/delivery-api/tsconfig.json apps/delivery-api/tsconfig.build.json apps/delivery-api/vitest.config.ts apps/delivery-api/eslint.config.mjs ./apps/delivery-api/
COPY apps/delivery-api/scripts ./apps/delivery-api/scripts
COPY apps/delivery-api/src ./apps/delivery-api/src
COPY apps/delivery-api/tests ./apps/delivery-api/tests
RUN npm --prefix apps/delivery-api run prisma:generate \
  && npm --prefix apps/delivery-api run build \
  && test -f apps/delivery-api/dist/scripts/cleanup-driver-event-attempts.js \
  && test -f apps/delivery-api/dist/scripts/report-driver-route-completion-invariant.js \
  && test -f apps/delivery-api/dist/scripts/backfill-rolling-route-eta.js \
  && test -f apps/delivery-api/dist/scripts/repair-dsv-route-eta.js \
  && test -f apps/delivery-api/dist/scripts/cleanup-shopify-webhook-events.js \
  && test -f apps/delivery-api/dist/scripts/cleanup-driver-proof-media.js \
  && test -f apps/delivery-api/dist/scripts/reconcile-customer-email.js \
  && test -f apps/delivery-api/dist/scripts/process-driver-account-deletion.js

FROM build AS pruned
RUN npm --prefix apps/delivery-api prune --omit=dev --omit=optional

FROM base AS migration
ENV NODE_ENV=production
RUN addgroup --system clever && adduser --system --ingroup clever clever
COPY --from=build /app/apps/delivery-api/package.json ./package.json
COPY --from=build /app/apps/delivery-api/package.json ./apps/delivery-api/package.json
COPY --from=build /app/apps/delivery-api/node_modules ./node_modules
COPY --from=build /app/apps/delivery-api/prisma ./prisma
COPY --from=build /app/apps/delivery-api/prisma ./apps/delivery-api/prisma
COPY --from=build /app/apps/delivery-api/scripts ./scripts
RUN ln -s ../../node_modules ./apps/delivery-api/node_modules \
  && test -x ./apps/delivery-api/node_modules/.bin/prisma \
  && chmod 0755 ./scripts/dsv-g007-migrate-deploy.sh
USER clever

FROM base AS runtime
ARG COMMIT_SHA
RUN case "$COMMIT_SHA" in *[!0-9a-f]*|'') exit 1 ;; esac \
  && test "${#COMMIT_SHA}" -eq 40 \
  && printf '%s\n' "$COMMIT_SHA" > /app/build-revision
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl --fail --silent --show-error --location \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && printf 'Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: bookworm-pgdg\nComponents: main\nSigned-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc\n' \
    > /etc/apt/sources.list.d/pgdg.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-17 \
  && pg_restore --version | grep 'PostgreSQL) 17\.' \
  && rm -rf /var/lib/apt/lists/*
LABEL org.clever-route.proof-media-iam-role-capability="1"
ENV NODE_ENV=production
ENV ROUTE_OPS_WEB_DIST_PATH=/app/external/route-ops-web/dist
ENV ROUTE_OPS_WEB_PUBLIC_PATH=/app/external/route-ops-web/public
RUN addgroup --system clever && adduser --system --ingroup clever clever
COPY --from=build /app/apps/delivery-api/package.json ./package.json
COPY --from=build /app/apps/delivery-api/package.json ./apps/delivery-api/package.json
COPY --from=pruned /app/apps/delivery-api/node_modules ./node_modules
COPY --from=build /app/apps/delivery-api/prisma ./prisma
COPY --from=build /app/apps/delivery-api/prisma ./apps/delivery-api/prisma
COPY --from=build /app/apps/delivery-api/dist ./dist
COPY apps/delivery-api/assets ./assets
COPY apps/delivery-api/scripts/guard-prisma-db-push.sh ./scripts/guard-prisma-db-push.sh
COPY apps/delivery-api/scripts/dsv-g007-migrate-deploy.sh ./scripts/dsv-g007-migrate-deploy.sh
RUN ln -s ../../node_modules ./apps/delivery-api/node_modules \
  && chmod 0755 ./scripts/dsv-g007-migrate-deploy.sh
COPY apps/delivery-api/docs/api ./docs/api
RUN node -e "Promise.all([import('@prisma/client'), import('firebase-admin/app'), import('firebase-admin/messaging')])"
USER clever
EXPOSE 3000
CMD ["node", "dist/server.js"]
