@echo off
chcp 65001 >nul
pwsh -NoProfile -File "%~dp0装补丁.ps1"
pause
