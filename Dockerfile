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
RUN cd apps/api && npx prisma generate && pnpm build

# Build Web
FROM base AS web-builder
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile
COPY apps/web ./apps/web
ARG VITE_API_URL=https://origin-platform.fly.dev
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter web build

# Final runtime image
FROM node:22-alpine
WORKDIR /app

COPY --from=api-builder /app/apps/api/dist ./apps/api/dist
COPY --from=api-builder /app/apps/api/prisma ./apps/api/prisma
COPY --from=api-builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=api-builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=web-builder /app/apps/web/dist ./apps/web/dist

RUN mkdir -p /data

ENV DATABASE_URL="file:/data/origin.db"
ENV PORT=8080

EXPOSE 8080

CMD ["sh", "-c", "cd /app/apps/api && npx prisma db push --skip-generate && node dist/index.js"]
