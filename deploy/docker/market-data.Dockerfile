# market-data service — build from REPO ROOT context:
#   docker build -f deploy/docker/market-data.Dockerfile .
# Railway: set "Dockerfile Path" to deploy/docker/market-data.Dockerfile (root context).
FROM node:24-alpine
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @hippo/market-data... build
ENV NODE_ENV=production
EXPOSE 8790
CMD ["pnpm", "--filter", "@hippo/market-data", "start"]
