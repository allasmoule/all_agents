@echo off
title YouTube Agent - Scheduler
cd /d "%~dp0"
echo.
echo  YouTube Agent - Scheduler Mode
echo ==========================================
echo প্রতিদিন .env এর CRON_SCHEDULE অনুযায়ী চলবে
echo Ctrl+C দিয়ে বন্ধ করো
echo.
call npx ts-node src/index.ts --schedule
