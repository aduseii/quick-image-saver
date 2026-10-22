@echo off
title Quick Image Saver - auto-update
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0updater\install.ps1"
pause
