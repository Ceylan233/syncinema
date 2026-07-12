# iStoreOS 一键部署

该部署方案适用于运行 iStoreOS/OpenWrt 的 ARM64 N1 盒子。Syncinema 使用 N1 的 `3100` 端口，不会修改 iStoreOS 的管理端口。

## 安装

先在 iStoreOS 应用商店安装 Docker，然后通过 SSH 执行：

```sh
wget -qO /tmp/install-syncinema.sh \
  https://raw.githubusercontent.com/Ceylan233/syncinema/v1.6.0/deploy/istoreos/install.sh
sh /tmp/install-syncinema.sh
```

安装完成后访问 `http://N1局域网IP:3100/`。需要临时公网访问时，将一个外部 TCP 端口映射到 `N1局域网IP:3100`。

## 公网 IP 邮件提醒

编辑 `/mnt/data/syncinema/ip-monitor.env`。`MAIL_PASS` 必须填写邮箱的 SMTP 授权码，不是邮箱登录密码。

```sh
vi /mnt/data/syncinema/ip-monitor.env
sh /mnt/data/syncinema/source/deploy/istoreos/start-ip-monitor.sh
docker logs -f syncinema-ip-monitor
```

监控程序每五分钟检查一次公网 IP，并将上一次地址保存在 `/mnt/data/syncinema/runtime/ip-monitor/public-ip.txt`。

## 常用管理命令

```sh
docker logs -f syncinema
docker restart syncinema
docker stop syncinema
```
