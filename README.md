# Syncinema 同映

同映是一个可自行部署的多人同步观影应用，支持房间隔离、视频同步、房间聊天、消息弹幕、本地视频共享、语音通话、在线片源、哔哩哔哩点播与直播、内容管理以及移动端全屏控制。

## 主要功能

- 多房间独立的视频、用户、聊天和语音状态
- 播放、暂停、进度、倍速和画面比例同步
- 本地视频共享与断线恢复
- 自定义 Kazumi 片源搜索和点播
- 哔哩哔哩视频、分 P 视频和直播解析
- 房间聊天、消息弹幕和操作记录
- WebRTC 语音、降噪及 TURN 中继配置
- 敏感词分类管理
- 桌面端与移动端响应式控制栏

## 环境要求

- Node.js 20 或更高版本，推荐 Node.js 22
- 现代浏览器
- 在 `localhost` 之外使用麦克风时需要 HTTPS

## 本地运行

```bash
npm ci
npm run build:client
npm start
```

浏览器访问 `http://localhost:3100/`。

公网开放前建议设置独立的内容管理密码。未设置该变量时，敏感词管理入口将停用：

```bash
SENSITIVE_ADMIN_PASSWORD='请替换为你的密码' npm start
```

## Docker 部署

```bash
docker build -t syncinema:1.6.0 .
docker run -d --name syncinema -p 3100:3100 \
  -e SENSITIVE_ADMIN_PASSWORD='请替换为你的密码' \
  syncinema:1.6.0
```

## iStoreOS / OpenWrt 部署

安装脚本会从 GitHub 下载 v1.6.0 源码，在 ARM64 设备上构建 Docker 镜像，并使用 `3100` 端口提供服务，不占用路由器管理端口 `80/443`。

先在 iStoreOS 应用商店安装 Docker，然后通过 SSH 执行：

```sh
wget -qO /tmp/install-syncinema.sh \
  https://raw.githubusercontent.com/Ceylan233/syncinema/v1.6.0/deploy/istoreos/install.sh
sh /tmp/install-syncinema.sh
```

端口映射和公网 IP 邮件提醒请查看 [iStoreOS 部署说明](deploy/istoreos/README.md)。

## 配置项

| 环境变量 | 说明 |
| --- | --- |
| `PORT` | HTTP 端口，默认 `3100` |
| `CORS_ORIGIN` | 允许的跨域来源，默认 `*` |
| `SENSITIVE_ADMIN_PASSWORD` | 敏感词管理密码 |
| `CHAT_HISTORY_FILE` | 房间聊天记录 JSON 文件路径 |
| `PLAYBACK_ACTIVITY_FILE` | 播放操作记录 JSON 文件路径 |
| `SENSITIVE_WORDS_FILE` | 敏感词数据 JSON 文件路径 |
| `ICE_SERVERS_JSON` | WebRTC ICE 服务器配置数组 |
| `TURN_URLS` | TURN 服务地址，多个地址使用逗号分隔 |
| `TURN_USERNAME` | TURN 用户名 |
| `TURN_CREDENTIAL` | TURN 密码 |

HTTPS 配置请查看 [HTTPS 部署说明](HTTPS.md)。

## 合规说明

请只共享你有权访问和传播的媒体内容。部署者需要自行遵守当地法律法规，并负责内容管理、用户隐私及第三方服务条款。

本项目采用 GNU Affero General Public License v3.0 许可证。项目包含源自 SyncTV 或受其设计启发的代码，因此继续采用相同的 AGPL-3.0 许可证。详情见 [第三方声明](THIRD_PARTY_NOTICES.md)。
