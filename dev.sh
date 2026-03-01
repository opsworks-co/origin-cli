#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Kill any existing processes on our ports
lsof -ti:4002 | xargs kill -9 2>/dev/null || true
lsof -ti:5176 | xargs kill -9 2>/dev/null || true

echo "Starting Origin v2..."

# Start API
cd "$DIR/apps/api"
npx tsx src/index.ts &
API_PID=$!
echo "API started (PID $API_PID) → http://localhost:4002"

# Start Web
cd "$DIR/apps/web"
npx vite --host --port 5176 &
WEB_PID=$!
echo "Web started (PID $WEB_PID) → http://localhost:5176"

echo "$API_PID" > "$DIR/.api.pid"
echo "$WEB_PID" > "$DIR/.web.pid"

wait
