# Syncinema HTTPS 部署

配置证书后，Syncinema 可以直接通过 HTTPS 运行。

## Windows 本地 HTTPS

为当前电脑和局域网 IP 生成本地证书：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\create-https-cert.ps1 -Ip 192.168.2.132
```

启动 HTTPS 服务：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-https.ps1
```

访问地址：

```text
https://localhost:3100/
https://192.168.2.132:3100/
```

如果证书警告导致手机浏览器无法使用麦克风，需要在手机上安装并信任 `certs\privatecinema-local.cer`。

## 使用已有证书

使用 PEM 证书：

```powershell
$env:HTTPS_KEY_PATH="C:\path\privkey.pem"
$env:HTTPS_CERT_PATH="C:\path\fullchain.pem"
npm start
```

使用 PFX 证书：

```powershell
$env:HTTPS_PFX_PATH="C:\path\certificate.pfx"
$env:HTTPS_PFX_PASSPHRASE="password"
npm start
```
