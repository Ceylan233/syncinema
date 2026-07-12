# Syncinema HTTPS

Syncinema can run over HTTPS when a certificate is configured.

## Local HTTPS on Windows

Generate a local certificate for this PC and LAN IP:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\create-https-cert.ps1 -Ip 192.168.2.132
```

Start the HTTPS server:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-https.ps1
```

Open:

```text
https://localhost:3100/
https://192.168.2.132:3100/
```

For mobile browsers, install and trust `certs\privatecinema-local.cer` on the phone if the certificate warning blocks microphone access.

## Custom Certificate

You can also start with PEM files:

```powershell
$env:HTTPS_KEY_PATH="C:\path\privkey.pem"
$env:HTTPS_CERT_PATH="C:\path\fullchain.pem"
npm start
```

Or with a PFX file:

```powershell
$env:HTTPS_PFX_PATH="C:\path\certificate.pfx"
$env:HTTPS_PFX_PASSPHRASE="password"
npm start
```
