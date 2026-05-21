# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY prisma ./prisma
COPY tsconfig.json tsconfig.build.json vitest.config.ts eslint.config.mjs ./
COPY src ./src
COPY tests ./tests
RUN npm run prisma:generate && npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && addgroup --system clever && adduser --system --ingroup clever clever
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/dist ./dist
COPY docs/api ./docs/api
USER clever
EXPOSE 3000
CMD ["node", "dist/server.js"]
