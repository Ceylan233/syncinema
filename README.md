# Syncinema 同映

Syncinema is a self-hosted watch-together application with synchronized playback, room chat, danmaku, local-file sharing, voice chat, online sources, Bilibili VOD/live playback, moderation, and mobile fullscreen controls.

## Requirements

- Node.js 20 or newer (Node.js 22 recommended)
- A modern browser
- HTTPS for microphone access outside `localhost`

## Run locally

```bash
npm ci
npm run build:client
npm start
```

Open `http://localhost:3100/`.

Set a private moderation password before exposing the service. Moderation administration is disabled when this variable is omitted:

```bash
SENSITIVE_ADMIN_PASSWORD='replace-this-password' npm start
```

## Docker

```bash
docker build -t syncinema:1.6.0 .
docker run -d --name syncinema -p 3100:3100 \
  -e SENSITIVE_ADMIN_PASSWORD='replace-this-password' \
  syncinema:1.6.0
```

## iStoreOS / OpenWrt

The installer downloads the tagged source from GitHub, builds the ARM64 image locally, and exposes Syncinema on port `3100`. It does not use the router administration ports `80/443`.

```bash
wget -qO /tmp/install-syncinema.sh \
  https://raw.githubusercontent.com/Ceylan233/syncinema/v1.6.0/deploy/istoreos/install.sh
sh /tmp/install-syncinema.sh
```

See [`deploy/istoreos/README.md`](deploy/istoreos/README.md) for port forwarding and public-IP email notifications.

## Configuration

| Variable | Description |
| --- | --- |
| `PORT` | HTTP port, default `3100` |
| `CORS_ORIGIN` | Allowed origin, default `*` |
| `SENSITIVE_ADMIN_PASSWORD` | Moderation administrator password |
| `CHAT_HISTORY_FILE` | Persistent chat JSON path |
| `PLAYBACK_ACTIVITY_FILE` | Persistent playback activity JSON path |
| `SENSITIVE_WORDS_FILE` | Persistent sensitive-word JSON path |
| `ICE_SERVERS_JSON` | JSON array of WebRTC ICE server definitions |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | TURN fallback configuration |

## Legal

Only share media that you are authorized to access and distribute. Operators are responsible for local laws, content moderation, privacy, and third-party service terms.

This project is licensed under the GNU Affero General Public License v3.0. It contains work derived from SyncTV and keeps the same AGPL-3.0 license. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
