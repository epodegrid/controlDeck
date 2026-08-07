# The build stage is pinned to the *build* platform so npm and tsc run natively
# even when producing an arm64 image. Emulating them under QEUM took ~30 minutes
# per architecture; there is nothing here that needs to run on the target.
#
# This is only safe because every runtime dependency is pure JavaScript
# (fastify, @fastify/cors, jose, pg — pg-native is deliberately not installed),
# so the resolved node_modules can be copied across architectures. Adding a
# dependency with native bindings would break that, and would need the prod
# install moved back into the runtime stage.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build
# Resolve production-only dependencies once, here, rather than again per-arch.
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./dist/db/migrations
EXPOSE 4000
CMD ["node", "dist/index.js"]
