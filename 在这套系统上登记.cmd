@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\register-this-system.ps1"
if "%~1"=="" pause
