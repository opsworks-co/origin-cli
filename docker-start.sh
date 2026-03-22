#!/bin/sh
set -e

cd /app/apps/api
npx prisma db push --skip-generate --accept-data-loss
node dist/index.js
