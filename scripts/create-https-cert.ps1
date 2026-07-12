param(
  [string]$Ip = "192.168.2.132",
  [string]$Password = "privatecinema-local",
  [string]$OutDir = "certs"
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$certDir = Join-Path $root $OutDir
New-Item -ItemType Directory -Force -Path $certDir | Out-Null

$pfxPath = Join-Path $certDir "privatecinema-local.pfx"
$cerPath = Join-Path $certDir "privatecinema-local.cer"
$securePassword = ConvertTo-SecureString -String $Password -Force -AsPlainText

$san = "2.5.29.17={text}DNS=localhost&IPAddress=127.0.0.1&IPAddress=$Ip"

$cert = New-SelfSignedCertificate `
  -Type Custom `
  -Subject "CN=Syncinema Local HTTPS" `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -NotAfter (Get-Date).AddYears(3) `
  -TextExtension @($san)

Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $securePassword | Out-Null
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null

Write-Host "Created HTTPS certificate:"
Write-Host "  PFX: $pfxPath"
Write-Host "  CER: $cerPath"
Write-Host ""
Write-Host "Start server:"
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\start-https.ps1"
Write-Host ""
Write-Host "Open on this PC:"
Write-Host "  https://localhost:3100/"
Write-Host ""
Write-Host "Open on phone:"
Write-Host "  https://$Ip`:3100/"
Write-Host ""
Write-Host "Install/trust the CER file on the phone if the browser reports the certificate is not trusted."
