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
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl unzip && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    curl -L https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip && \
    unzip -o /tmp/deno.zip -d /usr/local/bin && chmod a+rx /usr/local/bin/deno && rm /tmp/deno.zip && \
    apt-get purge -y curl unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/music-bot/package.json apps/music-bot/package.json
RUN npm ci --omit=dev --workspace @sausixudos/shared --workspace @sausixudos/music-bot --include-workspace-root && npm cache clean --force
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/music-bot/dist apps/music-bot/dist
USER node
CMD ["node", "apps/music-bot/dist/index.js"]
