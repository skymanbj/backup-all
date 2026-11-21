@echo off
chcp 65001 >nul
echo 正在启动 Backup-All 桌面软件备份（Magpie / Lamp Guide / FreeLLMAPI）...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\Backup-All\desktop-backup.ps1"
echo.
pause
