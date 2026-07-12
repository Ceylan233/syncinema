#!/bin/sh
set -eu

REPOSITORY="${SYNCINEMA_REPOSITORY:-Ceylan233/syncinema}"
VERSION="${SYNCINEMA_VERSION:-main}"
APP_DIR="${APP_DIR:-/mnt/data/syncinema}"
SOURCE_URL="https://github.com/$REPOSITORY/archive/$VERSION.tar.gz"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install and start Docker from the iStoreOS app store first." >&2
  exit 1
fi

case "$APP_DIR" in
  /mnt/data/*|/opt/*) ;;
  *) echo "APP_DIR must be under /mnt/data or /opt." >&2; exit 1 ;;
esac

mkdir -p "$APP_DIR/runtime/app" "$APP_DIR/source"
archive="/tmp/syncinema-$VERSION.tar.gz"
echo "Downloading $SOURCE_URL"
wget -O "$archive" "$SOURCE_URL"

rm -rf "$APP_DIR/source.new"
mkdir -p "$APP_DIR/source.new"
tar -xzf "$archive" --strip-components=1 -C "$APP_DIR/source.new"
rm -rf "$APP_DIR/source.old"
if [ -d "$APP_DIR/source" ]; then mv "$APP_DIR/source" "$APP_DIR/source.old"; fi
mv "$APP_DIR/source.new" "$APP_DIR/source"
rm -rf "$APP_DIR/source.old" "$archive"

if [ ! -f "$APP_DIR/app.env" ]; then
  cp "$APP_DIR/source/deploy/istoreos/app.env.example" "$APP_DIR/app.env"
  password="$(head -c 64 /dev/urandom | sha256sum | cut -c 1-24)"
  sed -i "s/replace-with-a-long-random-password/$password/" "$APP_DIR/app.env"
  echo "Generated moderation password: $password"
fi
if [ ! -f "$APP_DIR/runtime/app/chat-history.json" ]; then
  printf '{"rooms":{}}\n' >"$APP_DIR/runtime/app/chat-history.json"
fi
if [ ! -f "$APP_DIR/runtime/app/playback-activity.json" ]; then
  printf '{"rooms":{}}\n' >"$APP_DIR/runtime/app/playback-activity.json"
fi
if [ ! -f "$APP_DIR/runtime/app/sensitive-words.json" ]; then
  cp "$APP_DIR/source/server/data/default-sensitive-categories.json" "$APP_DIR/runtime/app/sensitive-words.json"
fi

echo "Building the ARM64 Syncinema image..."
docker build -t "syncinema:1.6.0" "$APP_DIR/source"
docker rm -f syncinema >/dev/null 2>&1 || true
docker run -d \
  --name syncinema \
  --restart unless-stopped \
  -p 3100:3100 \
  --env-file "$APP_DIR/app.env" \
  -e NODE_ENV=production \
  -e PORT=3100 \
  -e CHAT_HISTORY_FILE=/data/chat-history.json \
  -e PLAYBACK_ACTIVITY_FILE=/data/playback-activity.json \
  -e SENSITIVE_WORDS_FILE=/data/sensitive-words.json \
  -v "$APP_DIR/runtime/app:/data" \
  "syncinema:1.6.0"

lan_ip="$(ip -4 addr show br-lan 2>/dev/null | awk '/inet / { sub(/\/.*/, "", $2); print $2; exit }')"
echo "Syncinema is running at http://${lan_ip:-N1-LAN-IP}:3100/"
