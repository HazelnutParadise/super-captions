# Pinned to the latest stable Bun release at the time of writing.
# Bump deliberately — never use `:latest` so deploys remain reproducible.
ARG BUN_IMAGE=oven/bun:1.4.2-alpine

FROM ${BUN_IMAGE} AS ffmpeg
WORKDIR /build
RUN apk add --no-cache build-base curl xz pkgconf openssl-dev nasm
# Official release archive, verified against the FFmpeg release signing key.
RUN curl -fL --retry 2 https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz -o ffmpeg.tar.xz \
    && echo '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e  ffmpeg.tar.xz' | sha256sum -c - \
    && tar -xf ffmpeg.tar.xz
WORKDIR /build/ffmpeg-9.0.2
# The server only copies H.264/AAC MP4 tracks. Keep native HTTP range/recovery
# support without compiling unused encoders or external codec libraries.
RUN ./configure --prefix=/opt/ffmpeg --disable-doc --disable-debug \
      --disable-autodetect --disable-everything --disable-avdevice \
      --enable-ffmpeg --enable-ffprobe --enable-network --enable-openssl \
      --enable-protocol=file,pipe,http,https,tcp,tls,crypto \
      --enable-demuxer=mov --enable-muxer=mp4 --enable-parser=aac,h264 \
      --enable-decoder=aac,h264 --enable-bsf=aac_adtstoasc \
    && make -j "$(getconf _NPROCESSORS_ONLN)" \
    && make install

FROM ${BUN_IMAGE} AS youtube-test
RUN apk add --no-cache libssl3 libcrypto3 ffmpeg nodejs openssl
COPY --from=ffmpeg /opt/ffmpeg/bin /opt/ffmpeg/bin
ENV TEST_FFMPEG_PATH=/opt/ffmpeg/bin/ffmpeg
ENV TEST_FFPROBE_PATH=/opt/ffmpeg/bin/ffprobe
ENV TEST_FIXTURE_FFMPEG_PATH=/usr/bin/ffmpeg
ENV REQUIRE_YOUTUBE_TRANSPORT_TESTS=1
WORKDIR /source

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
ENV PATH="/opt/ffmpeg/bin:${PATH}"
COPY --from=ffmpeg /opt/ffmpeg/bin /opt/ffmpeg/bin
RUN apk add --no-cache libssl3 libcrypto3

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
