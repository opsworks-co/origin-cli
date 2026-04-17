#!/usr/bin/env bash
# Reset local dev database — schema push + optional seed.
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR/apps/api"

DB="prisma/dev.db"

echo "Resetting $DB ..."
rm -f "$DB" "$DB-journal" "$DB-wal" "$DB-shm"

echo "Pushing schema..."
DATABASE_URL="file:./$DB" npx prisma db push --accept-data-loss --skip-generate

echo "✓ Dev database reset at $DIR/apps/api/$DB"
echo "  Restart dev server: npm run dev"
