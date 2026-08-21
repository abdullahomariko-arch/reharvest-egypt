# Three stages: install, build, run.
#
# The runtime image contains compiled JavaScript and production dependencies —
# no TypeScript, no compiler, no test tooling. The previous image ran the source
# through Node's strip-only mode, which meant shipping a runtime that has to
# parse types and fails on syntax it does not support. It also could not start
# at all, because it set NODE_ENV=production against a hard-coded development
# OTP provider.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/payments/package.json packages/payments/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/admin ./apps/admin
COPY scripts ./scripts
COPY tsconfig.json tsconfig.build.json ./
# Typecheck, then bundle. A build that emits without typechecking will happily
# ship the error a developer was about to fix.
RUN npx tsc --noEmit -p tsconfig.json && node scripts/build-server.mjs

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only: no compiler, no Expo toolchain, no test runner.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/payments/package.json packages/payments/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Migrations and the maintenance commands ship with the image so a deploy can
# run them without a second artefact that might be a different version.
COPY packages/db/migrations ./packages/db/migrations
COPY scripts ./scripts

USER node
EXPOSE 8787

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
