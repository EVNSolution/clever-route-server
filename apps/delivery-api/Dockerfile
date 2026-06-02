# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY apps/delivery-api/package.json apps/delivery-api/package-lock.json ./apps/delivery-api/
RUN npm --prefix apps/delivery-api ci

FROM deps AS build
COPY apps/delivery-api/prisma ./apps/delivery-api/prisma
COPY apps/delivery-api/tsconfig.json apps/delivery-api/tsconfig.build.json apps/delivery-api/vitest.config.ts apps/delivery-api/eslint.config.mjs ./apps/delivery-api/
COPY apps/delivery-api/src ./apps/delivery-api/src
COPY apps/delivery-api/tests ./apps/delivery-api/tests
RUN npm --prefix apps/delivery-api run prisma:generate \
  && npm --prefix apps/delivery-api run build

FROM build AS migrate
WORKDIR /app
CMD ["npm", "--prefix", "apps/delivery-api", "exec", "--", "prisma", "db", "push", "--schema", "apps/delivery-api/prisma/schema.prisma", "--skip-generate"]

FROM build AS pruned
RUN npm --prefix apps/delivery-api prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV ROUTE_OPS_WEB_DIST_PATH=/app/external/route-ops-web/dist
ENV ROUTE_OPS_WEB_PUBLIC_PATH=/app/external/route-ops-web/public
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && addgroup --system clever && adduser --system --ingroup clever clever
COPY --from=build /app/apps/delivery-api/package.json ./package.json
COPY --from=pruned /app/apps/delivery-api/node_modules ./node_modules
COPY --from=build /app/apps/delivery-api/prisma ./prisma
COPY --from=build /app/apps/delivery-api/dist ./dist
COPY apps/delivery-api/docs/api ./docs/api
USER clever
EXPOSE 3000
CMD ["node", "dist/server.js"]
