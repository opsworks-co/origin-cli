#!/usr/bin/env bash
# Switch the Origin CLI to point at local dev API.
# Seeds a dev user + API key if needed, then writes config.
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$HOME/.origin/config.json"
BACKUP="$HOME/.origin/config.prod.json"

# Check local API is running
if ! curl -sf --max-time 2 http://localhost:4002/ > /dev/null 2>&1; then
  echo "✗ Local API not responding at http://localhost:4002"
  echo "  Start it first: npm run dev"
  exit 1
fi

# Backup prod config if not already backed up
if [ -f "$CONFIG" ] && ! grep -q '"apiUrl": "http://localhost' "$CONFIG"; then
  cp "$CONFIG" "$BACKUP"
  echo "Backed up prod config → $BACKUP"
fi

# Ensure ~/.origin exists
mkdir -p "$HOME/.origin"

# Seed dev user + get fresh API key
echo "Seeding dev user..."
cd "$DIR/apps/api"
SEED_JSON=$(DATABASE_URL="file:./dev.db" npx tsx "$DIR/scripts/dev-seed.ts")

API_KEY=$(echo "$SEED_JSON" | node -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf-8')).apiKey)")
ORG_ID=$(echo "$SEED_JSON" | node -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf-8')).orgId)")
USER_ID=$(echo "$SEED_JSON" | node -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf-8')).userId)")

if [ -z "$API_KEY" ]; then
  echo "✗ Failed to seed dev user"
  exit 1
fi

# Write CLI config
cat > "$CONFIG" <<EOF
{
  "apiUrl": "http://localhost:4002",
  "apiKey": "$API_KEY",
  "orgId": "$ORG_ID",
  "userId": "$USER_ID",
  "keyType": "solo",
  "accountType": "developer",
  "orgName": "Dev Local"
}
EOF

echo ""
echo "✓ CLI now points at http://localhost:4002"
echo "  Login on web:   http://localhost:5176"
echo "  Credentials:    see scripts/dev-seed.ts (or set ORIGIN_DEV_EMAIL / ORIGIN_DEV_PASSWORD before running)"
echo "  Restore prod:   npm run cli:prod"
