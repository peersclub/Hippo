# gateway service — build from REPO ROOT context:
#   docker build -f deploy/docker/gateway.Dockerfile .
# Railway: set "Dockerfile Path" to deploy/docker/gateway.Dockerfile (root context).
FROM node:24-alpine
WORKDIR /app
RUN npm install -g pnpm@10.18.0
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @hippo/gateway... build
ENV NODE_ENV=production
EXPOSE 8788
CMD ["pnpm", "--filter", "@hippo/gateway", "start"]
