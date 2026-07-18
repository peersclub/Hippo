# portal service — build from REPO ROOT context:
#   docker build -f deploy/docker/portal.Dockerfile .
# Railway: set "Dockerfile Path" to deploy/docker/portal.Dockerfile (root context).
FROM node:24-alpine
WORKDIR /app
RUN npm install -g pnpm@10.18.0
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @hippo/portal... build
ENV NODE_ENV=production
EXPOSE 8795
CMD ["pnpm", "--filter", "@hippo/portal", "start"]
