@echo off
title Twitter Agent
cd /d "%~dp0"
echo.
echo  Twitter Agent
echo ==========================================

if not exist ".env" (
    copy ".env.example" ".env"
    echo .env তৈরি হয়েছে - এখন credentials দাও!
    notepad ".env"
    pause & exit /b 0
)

if not exist "node_modules" (
    echo Dependencies install করছি...
    call npm install
    call npx playwright install chromium
)

echo.
echo Agent চলছে...
call npx ts-node src/index.ts

pause
