FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/music-bot/package.json apps/music-bot/package.json
RUN npm ci --workspace @sausixudos/shared --workspace @sausixudos/music-bot --include-workspace-root
COPY packages/shared packages/shared
COPY apps/music-bot apps/music-bot
RUN npm run build -w @sausixudos/shared && npm run build -w @sausixudos/music-bot

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl && rm -rf /var/lib/apt/lists/*
ARG YTDLP_VERSION=2026.07.04
ARG BGUTIL_PLUGIN_VERSION=2.0.0
RUN curl -L --fail --retry 3 https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux -o /usr/local/bin/yt-dlp \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && mkdir -p /app/.tools/yt-dlp-plugins \
    && curl -L --fail --retry 3 https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/${BGUTIL_PLUGIN_VERSION}/bgutil-ytdlp-pot-provider.zip -o /app/.tools/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/music-bot/package.json apps/music-bot/package.json
RUN npm ci --omit=dev --workspace @sausixudos/shared --workspace @sausixudos/music-bot --include-workspace-root && npm cache clean --force
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/music-bot/dist apps/music-bot/dist
USER node
EXPOSE 4100
CMD ["node", "apps/music-bot/dist/index.js"]
