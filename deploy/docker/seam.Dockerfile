# seam service — build from REPO ROOT context:
#   docker build -f deploy/docker/seam.Dockerfile .
# Railway: set "Dockerfile Path" to deploy/docker/seam.Dockerfile (root context).
FROM node:24-alpine
WORKDIR /app
RUN npm install -g pnpm@10.18.0
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @hippo/seam... build
ENV NODE_ENV=production
EXPOSE 8793
CMD ["pnpm", "--filter", "@hippo/seam", "start"]
