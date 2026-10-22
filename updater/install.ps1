# Quick Image Saver - turns on automatic updates (run once).
# Registers the updater helper with Chrome, Edge and Brave for this Windows user.
# No admin rights needed; nothing runs in the background. The extension starts
# the helper only when GitHub has a newer version.

$ErrorActionPreference = 'Stop'
$Name   = 'com.aduseii.quick_image_saver'
$ExtId  = 'hpkjlcbchbddcdoampfalndkcdbgcfai'
$ExtDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$HostBat = Join-Path $PSScriptRoot 'host.bat'

try {
    $m = Get-Content -Raw -Encoding UTF8 -Path (Join-Path $ExtDir 'manifest.json') | ConvertFrom-Json
    if ($m.name -ne 'Quick Image Saver') { throw 'This file must stay inside the Quick Image Saver folder.' }

    # Files from a downloaded zip are marked "from the internet"; clear that so the helper can run quietly.
    Get-ChildItem -LiteralPath $ExtDir -Recurse -File | Unblock-File -ErrorAction SilentlyContinue

    $dataDir = Join-Path $env:LOCALAPPDATA 'QuickImageSaver'
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    $hostJson = Join-Path $dataDir "$Name.json"
    $json = [ordered]@{
        name            = $Name
        description     = 'Quick Image Saver updater'
        path            = $HostBat
        type            = 'stdio'
        allowed_origins = @("chrome-extension://$ExtId/")
    } | ConvertTo-Json
    [IO.File]::WriteAllText($hostJson, $json, (New-Object Text.UTF8Encoding $false))

    $keys = @('HKCU\Software\Google\Chrome\NativeMessagingHosts', 'HKCU\Software\Microsoft\Edge\NativeMessagingHosts')
    if (Test-Path 'HKCU:\Software\BraveSoftware') { $keys += 'HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts' }
    foreach ($k in $keys) {
        & reg.exe add "$k\$Name" /ve /t REG_SZ /d "$hostJson" /f | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not write $k" }
    }

    Write-Host ''
    Write-Host '  Auto-update is ON.' -ForegroundColor Green
    Write-Host ''
    Write-Host '  Quick Image Saver will now keep itself up to date from'
    Write-Host '  github.com/aduseii/quick-image-saver (checks when your browser'
    Write-Host '  starts and every few hours).'
    Write-Host ''
    Write-Host '  Keep the extension folder where it is:'
    Write-Host "  $ExtDir"
    Write-Host '  (If you move it, run this file again from the new place.)'
    Write-Host ''
}
catch {
    Write-Host ''
    Write-Host ('  Could not turn on auto-update: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host ''
    exit 1
}
