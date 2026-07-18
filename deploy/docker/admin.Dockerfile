# admin service — build from REPO ROOT context:
#   docker build -f deploy/docker/admin.Dockerfile .
# Railway: set "Dockerfile Path" to deploy/docker/admin.Dockerfile (root context).
FROM node:24-alpine
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @hippo/admin... build
ENV NODE_ENV=production
EXPOSE 8794
CMD ["pnpm", "--filter", "@hippo/admin", "start"]
