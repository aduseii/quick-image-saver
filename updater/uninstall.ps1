# Quick Image Saver - turns off automatic updates.
$Name = 'com.aduseii.quick_image_saver'
foreach ($k in 'HKCU\Software\Google\Chrome\NativeMessagingHosts', 'HKCU\Software\Microsoft\Edge\NativeMessagingHosts', 'HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts') {
    & reg.exe delete "$k\$Name" /f 2>$null | Out-Null
}
Remove-Item -LiteralPath (Join-Path $env:LOCALAPPDATA 'QuickImageSaver') -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host '  Auto-update is OFF. Run "Turn on auto-update.bat" to turn it back on.' -ForegroundColor Yellow
Write-Host ''
