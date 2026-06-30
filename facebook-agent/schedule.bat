@echo off
title Facebook Agent - Scheduler
cd /d "%~dp0"
echo.
echo  Facebook Agent - Scheduler Mode
echo ==========================================
echo প্রতিদিন .env এর CRON_SCHEDULE অনুযায়ী চলবে
echo Ctrl+C দিয়ে বন্ধ করো
echo.
call npx ts-node src/index.ts --schedule
