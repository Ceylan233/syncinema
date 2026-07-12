#!/bin/sh
set -eu

APP_DIR="${APP_DIR:-/mnt/data/syncinema}"
if [ ! -f "$APP_DIR/ip-monitor.env" ]; then
  echo "Missing $APP_DIR/ip-monitor.env" >&2
  exit 1
fi

docker rm -f syncinema-ip-monitor >/dev/null 2>&1 || true
docker run -d \
  --name syncinema-ip-monitor \
  --restart unless-stopped \
  --env-file "$APP_DIR/ip-monitor.env" \
  -e IP_STATE_FILE=/data/public-ip.txt \
  -v "$APP_DIR/runtime/ip-monitor:/data" \
  -v "$APP_DIR/source/deploy/istoreos/public-ip-monitor.py:/app/public-ip-monitor.py:ro" \
  python:3.12-alpine \
  sh -c 'while true; do python3 /app/public-ip-monitor.py; sleep 300; done'

echo "Public-IP monitor started."
