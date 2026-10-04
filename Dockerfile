# Pinned to the latest stable Bun release at the time of writing.
# Bump deliberately — never use `:latest` so deploys remain reproducible.
ARG BUN_IMAGE=oven/bun:1.4.2-alpine

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

# Temporary workaround for Portainer's fixed 15-minute deployment deadline.
# Set this to true again once portainer/portainer#13314 is addressed.
ARG YOUTUBE_DEPS_AT_BUILD=false
COPY requirements-youtube.txt docker-entrypoint.sh ./
RUN case "$YOUTUBE_DEPS_AT_BUILD" in \
      true) sh /app/docker-entrypoint.sh --install-only ;; \
      false) ;; \
      *) echo 'YOUTUBE_DEPS_AT_BUILD must be true or false' >&2; exit 1 ;; \
    esac
ENV YT_DLP_PATH=/opt/youtube/bin/yt-dlp

# Next.js standalone output: ship only what's needed.
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
# Next's standalone server uses Node-style APIs; Bun runs them in Node-compat mode.
CMD ["bun", "run", "server.js"]
