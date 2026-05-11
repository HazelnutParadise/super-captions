# Pinned to the latest stable Bun release at the time of writing.
# Bump deliberately — never use `:latest` so deploys remain reproducible.
ARG BUN_IMAGE=oven/bun:1.3.13-alpine

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM ${BUN_IMAGE} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

FROM ${BUN_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Next.js standalone output: ship only what's needed.
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
# Next's standalone server uses Node-style APIs; Bun runs them in Node-compat mode.
CMD ["bun", "run", "server.js"]
