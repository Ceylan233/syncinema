param(
  [string]$Password = "privatecinema-local",
  [string]$PfxPath = "certs\privatecinema-local.pfx"
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

$resolvedPfx = Join-Path $root $PfxPath
if (!(Test-Path $resolvedPfx)) {
  throw "HTTPS certificate not found: $resolvedPfx. Run scripts\create-https-cert.ps1 first."
}

$env:HTTPS_PFX_PATH = $resolvedPfx
$env:HTTPS_PFX_PASSPHRASE = $Password
npm start
