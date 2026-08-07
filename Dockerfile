# Build natively even when targeting arm64 — see server/Dockerfile for the full
# reasoning. Next's standalone output is traced JavaScript, so it copies across
# architectures; this would need revisiting if a dependency with native
# bindings (sharp, for instance) were added.
FROM --platform=$BUILDPLATFORM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
