# syntax=docker/dockerfile:1

FROM node:24-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate --schema packages/db/prisma/schema.prisma
# prisma generate already ran above, so build the TypeScript directly rather
# than going through @bscs/db's build script, which would regenerate it.
RUN npm run build --workspace @bscs/core \
 && npx tsc -b packages/db/tsconfig.json \
 && npm run build --workspace @bscs/worker

FROM node:24-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
ENV NODE_ENV=production
RUN addgroup -g 1001 -S nodejs && adduser -S worker -u 1001

COPY --from=build --chown=worker:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=worker:nodejs /app/packages ./packages
COPY --from=build --chown=worker:nodejs /app/apps/worker ./apps/worker
COPY --from=build --chown=worker:nodejs /app/package.json ./package.json

USER worker
CMD ["node", "apps/worker/dist/index.js"]
