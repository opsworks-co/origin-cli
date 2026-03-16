FROM node:22-alpine AS base
RUN npm install -g pnpm

# Build API
FROM base AS api-builder
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/cli/package.json ./packages/cli/
COPY packages/mcp-server/package.json ./packages/mcp-server/
RUN pnpm install --frozen-lockfile
COPY apps/api ./apps/api
COPY packages ./packages
RUN cd apps/api && npx prisma generate && pnpm run build
# Build & pack CLI for download (auto-version from date: 0.YYYYMMDD.HHMM)
RUN cd packages/cli && \
    CLI_VERSION="0.$(date -u +%Y%m%d.%H%M)" && \
    sed -i "s/\"version\": \".*\"/\"version\": \"$CLI_VERSION\"/" package.json && \
    pnpm run build && rm -f origin-cli-*.tgz && npm pack && mv origin-cli-*.tgz origin-cli-latest.tgz && \
    echo "{\"version\":\"$CLI_VERSION\",\"url\":\"https://getorigin.io/cli/origin-cli-latest.tgz\"}" > version.json

# Build Web
FROM base AS web-builder
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile
COPY apps/web ./apps/web
ARG VITE_API_URL=https://getorigin.io
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter web build

# Final runtime image
FROM node:22-alpine
WORKDIR /app

# Copy everything from api builder including root node_modules (has prisma binary)
COPY --from=api-builder /app/node_modules ./node_modules
COPY --from=api-builder /app/apps/api/dist ./apps/api/dist
COPY --from=api-builder /app/apps/api/prisma ./apps/api/prisma
COPY --from=api-builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=api-builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=web-builder /app/apps/web/dist ./apps/web/dist
# CLI tarball for download
RUN mkdir -p ./apps/web/dist/cli
COPY --from=api-builder /app/packages/cli/origin-cli-latest.tgz ./apps/web/dist/cli/origin-cli-latest.tgz
COPY --from=api-builder /app/packages/cli/version.json ./apps/web/dist/cli/version.json
COPY docker-start.sh ./docker-start.sh
RUN chmod +x docker-start.sh

RUN mkdir -p /data

ENV DATABASE_URL="file:/data/origin.db"
ENV PORT=8080

EXPOSE 8080

CMD ["./docker-start.sh"]
