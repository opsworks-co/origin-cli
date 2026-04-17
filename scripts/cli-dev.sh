#!/usr/bin/env bash
# Switch the Origin CLI to point at the fly.io dev deployment.
# Unlike cli-local, this doesn't seed — you must create an account via the
# dev web UI first (https://origin-platform-dev.fly.dev) and paste the key.
set -e

CONFIG="$HOME/.origin/config.json"
BACKUP="$HOME/.origin/config.prod.json"
DEV_URL="https://origin-platform-dev.fly.dev"

# Check dev URL is reachable
if ! curl -sf --max-time 5 "$DEV_URL/" > /dev/null 2>&1; then
  echo "✗ Dev deployment not reachable at $DEV_URL"
  echo "  Deploy it first: npm run deploy:dev"
  exit 1
fi

# Backup prod config if not already backed up
if [ -f "$CONFIG" ] && ! grep -q "$DEV_URL" "$CONFIG" 2>/dev/null && ! grep -q '"apiUrl": "http://localhost' "$CONFIG" 2>/dev/null; then
  cp "$CONFIG" "$BACKUP"
  echo "Backed up prod config → $BACKUP"
fi

if [ -z "$ORIGIN_DEV_API_KEY" ]; then
  echo "Set ORIGIN_DEV_API_KEY to an API key generated from $DEV_URL/settings"
  echo "  export ORIGIN_DEV_API_KEY=<your-key>"
  echo "  npm run cli:dev"
  exit 1
fi

mkdir -p "$HOME/.origin"

cat > "$CONFIG" <<EOF
{
  "apiUrl": "$DEV_URL",
  "apiKey": "$ORIGIN_DEV_API_KEY",
  "orgId": "",
  "userId": "",
  "keyType": "team",
  "accountType": "developer",
  "orgName": "Dev (Fly)"
}
EOF

echo "✓ CLI now points at $DEV_URL"
echo "  Restore prod: npm run cli:prod"
