# host-venue (Assetworks Exchange test host) — build from REPO ROOT context:
#   docker build -f deploy/docker/host-venue.Dockerfile .
# Railway: set "Dockerfile Path" to deploy/docker/host-venue.Dockerfile (root context).
FROM node:24-alpine
WORKDIR /app
RUN npm install -g pnpm@10.18.0
COPY . .
RUN pnpm install --frozen-lockfile --filter @hippo/host-venue...
RUN pnpm --filter @hippo/host-venue... build
ENV NODE_ENV=production
# Build provenance for /health (--build-arg GIT_SHA=<commit>, BUILT_AT=<ISO ts>;
# Railway passes these as build args). Defaults stay an honest "unknown".
ARG GIT_SHA=unknown
ARG BUILT_AT=unknown
ENV GIT_SHA=$GIT_SHA BUILT_AT=$BUILT_AT
EXPOSE 8796
CMD ["pnpm", "--filter", "@hippo/host-venue", "start"]
