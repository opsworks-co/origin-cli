#!/bin/sh
set -e

cd /app/apps/api
npx prisma db push --skip-generate
node dist/index.js
