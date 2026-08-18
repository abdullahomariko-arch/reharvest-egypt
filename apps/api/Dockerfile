# Multi-stage so the runtime image carries no build toolchain.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/payments/package.json packages/payments/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
# --omit=dev keeps the Expo toolchain out of a server image entirely.
RUN npm ci --omit=dev --workspace @reharvest/api --include-workspace-root

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY packages ./packages
COPY apps/api ./apps/api
COPY package.json tsconfig.json ./

# Never run as root. A container escape is worse when the process owns the host.
USER node
EXPOSE 8787

# The orchestrator restarts on /health; /ready decides whether traffic routes.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s \
  CMD node -e "fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "apps/api/src/index.ts"]
