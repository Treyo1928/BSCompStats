# syntax=docker/dockerfile:1

# ---- deps -------------------------------------------------------------------
FROM node:24-alpine AS deps
WORKDIR /app

# Prisma's engines need this on Alpine.
RUN apk add --no-cache libc6-compat openssl

# Copy only manifests first so the dependency layer caches across code changes.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/

# `allowScripts` in the root package.json is what permits Prisma and esbuild to
# run their install scripts under npm 12, which blocks them by default.
RUN npm ci

# ---- build ------------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The client is generated into node_modules, so it must exist before the build.
RUN npx prisma generate --schema packages/db/prisma/schema.prisma

# Workspace packages are consumed from their compiled `dist`, and .dockerignore
# deliberately keeps host build output out of the context - so they are built
# here rather than copied in.
RUN npm run build --workspace @bscs/core
RUN npx tsc -b packages/db/tsconfig.json

# Next validates env at import time; supply a throwaway value so the build does
# not need real secrets baked into the image.
ENV AUTH_SECRET=build-time-placeholder
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN npm run build --workspace @bscs/web

# ---- runtime ----------------------------------------------------------------
FROM node:24-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
ENV NODE_ENV=production
ENV PORT=3000

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# Next's standalone output carries its own minimal node_modules.
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

# The generated Prisma client is required at runtime; the CLI is not, because
# migrations run in their own container.
COPY --from=build --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --chown=nextjs:nodejs docker/entrypoint-web.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

USER nextjs
EXPOSE 3000
ENTRYPOINT ["./entrypoint.sh"]
