# memory service — build from REPO ROOT context:
#   docker build -f deploy/docker/memory.Dockerfile .
# Railway: set "Dockerfile Path" to deploy/docker/memory.Dockerfile (root context).
FROM node:24-alpine
WORKDIR /app
RUN npm install -g pnpm@10.18.0
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @hippo/memory... build
ENV NODE_ENV=production
EXPOSE 8792
CMD ["pnpm", "--filter", "@hippo/memory", "start"]
