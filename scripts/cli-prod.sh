#!/usr/bin/env bash
# Switch the Origin CLI back to pointing at production.
set -e

CONFIG="$HOME/.origin/config.json"
BACKUP="$HOME/.origin/config.prod.json"

if [ ! -f "$BACKUP" ]; then
  echo "No backup at $BACKUP — nothing to restore"
  echo "Run 'origin login' to reconfigure from scratch"
  exit 1
fi

cp "$BACKUP" "$CONFIG"
echo "✓ CLI restored to production config"
node -e "
  const c = JSON.parse(require('fs').readFileSync('$CONFIG', 'utf-8'));
  console.log('  apiUrl: ' + c.apiUrl);
"
