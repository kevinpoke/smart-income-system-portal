# Smart Income System — production Docker image
# Phase 5: build + run privately (localhost-only) on the production VPS.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Non-root runtime user.
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# /app/data is where the bind-mounted host volume
# (/opt/smart-income-system/data) lands, giving DB_PATH =
# /app/data/auth.db exactly as lib/db.js resolves
# path.join(process.cwd(), "data", "auth.db"). Created here only so the
# mountpoint exists with the right ownership before the bind-mount is
# applied at `docker compose up` time; the auth.db file itself is NEVER
# baked into the image (see .dockerignore).
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["npm", "run", "start"]
