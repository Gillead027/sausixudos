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
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/music-bot/package.json apps/music-bot/package.json
RUN npm ci --omit=dev --workspace @sausixudos/shared --workspace @sausixudos/music-bot --include-workspace-root && npm cache clean --force
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/music-bot/dist apps/music-bot/dist
USER node
EXPOSE 4100
CMD ["node", "apps/music-bot/dist/index.js"]
