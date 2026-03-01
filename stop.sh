#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"

kill "$(cat "$DIR/.api.pid" 2>/dev/null)" 2>/dev/null || true
kill "$(cat "$DIR/.web.pid" 2>/dev/null)" 2>/dev/null || true
lsof -ti:4002 | xargs kill -9 2>/dev/null || true
lsof -ti:5176 | xargs kill -9 2>/dev/null || true

rm -f "$DIR/.api.pid" "$DIR/.web.pid"
echo "Origin v2 stopped."
