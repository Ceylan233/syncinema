# iStoreOS 一键部署

该部署方案适用于运行 iStoreOS/OpenWrt 的 ARM64 N1 盒子。Syncinema 使用 N1 的 `3100` 端口，不会修改 iStoreOS 的管理端口。

## 安装

先在 iStoreOS 应用商店安装 Docker，然后通过 SSH 执行：

```sh
wget -qO /tmp/install-syncinema.sh \
  https://raw.githubusercontent.com/Ceylan233/syncinema/main/deploy/istoreos/install.sh
sh /tmp/install-syncinema.sh
```

安装完成后访问 `http://N1局域网IP:3100/`。需要临时公网访问时，将一个外部 TCP 端口映射到 `N1局域网IP:3100`。

## 常用管理命令

```sh
docker logs -f syncinema
docker restart syncinema
docker stop syncinema
```
