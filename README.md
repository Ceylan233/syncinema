# Syncinema 同映

同映是一个可自行部署的多人同步观影应用，支持视频同步、房间聊天、消息弹幕、本地视频共享、语音通话、在线片源、哔哩哔哩点播与直播，以及移动端全屏控制。

## 功能

- 多房间独立的视频、用户、聊天和语音
- 播放、暂停、进度、倍速和画面比例同步
- 本地视频共享与在线片源点播
- 哔哩哔哩视频、分 P 视频和直播解析
- 房间聊天、消息弹幕和操作记录
- WebRTC 语音和敏感词管理
- 桌面端与移动端响应式控制栏

## 本地运行

需要提前安装 Node.js 20 或更高版本，推荐 Node.js 22。

```bash
git clone https://github.com/Ceylan233/syncinema.git
cd syncinema
npm run deploy
```

`npm run deploy` 会自动安装依赖、编译前端并启动服务。浏览器访问：

```text
http://localhost:3100/
```

## 服务器部署

服务器安装 Git 和 Docker 后执行：

```bash
git clone https://github.com/Ceylan233/syncinema.git
cd syncinema
docker compose up -d --build
```

部署完成后访问：

```text
http://服务器IP:3100/
```

查看日志或更新：

```bash
docker compose logs -f
git pull
docker compose up -d --build
```

## 环境变量

所有环境变量均为可选项。直接使用 Node.js 部署时，在启动命令前设置；使用 Docker 部署时，在 `compose.yaml` 的 `environment` 中设置。

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | 服务监听端口 | `3100` |
| `CORS_ORIGIN` | 允许访问服务的来源 | `*` |
| `SENSITIVE_ADMIN_PASSWORD` | 敏感词管理密码；未设置时关闭管理入口 | 未设置 |
| `CHAT_HISTORY_FILE` | 房间聊天记录文件路径 | `server/chat-history.json` |
| `PLAYBACK_ACTIVITY_FILE` | 播放操作记录文件路径 | `server/playback-activity.json` |
| `SENSITIVE_WORDS_FILE` | 敏感词数据文件路径 | `server/sensitive-words.json` |
| `ICE_SERVERS_JSON` | WebRTC ICE 服务器配置，使用 JSON 数组格式 | 内置 STUN |
| `TURN_URLS` | TURN 服务地址，多个地址使用逗号分隔 | 未设置 |
| `TURN_USERNAME` | TURN 用户名 | 未设置 |
| `TURN_CREDENTIAL` | TURN 密码 | 未设置 |

公网正式使用时，请为域名配置 HTTPS；具体方法见 [HTTPS 部署说明](HTTPS.md)。

## iStoreOS / OpenWrt

先在 iStoreOS 应用商店安装 Docker，然后通过 SSH 执行：

```sh
wget -qO /tmp/install-syncinema.sh \
  https://raw.githubusercontent.com/Ceylan233/syncinema/v1.6.0/deploy/istoreos/install.sh
sh /tmp/install-syncinema.sh
```

详细说明见 [iStoreOS 一键部署](deploy/istoreos/README.md)。

## 许可证

本项目采用 GNU Affero General Public License v3.0 许可证。部分播放、房间、代理和同步设计源自或参考了 [SyncTV](https://github.com/synctv-org/synctv)。请只共享你有权访问和传播的媒体内容，并自行遵守当地法律法规及第三方服务条款。
