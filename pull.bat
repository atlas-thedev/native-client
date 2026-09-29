@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title Noctra Client - Git Pull

echo ========================================================
echo               Noctra Client - Quick Pull
echo ========================================================
echo.

cd /d "%~dp0"

if not exist ".git" (
    echo [ERROR] No .git repository found in %~dp0
    echo.
    pause
    exit /b 1
)

echo [1/3] Checking for local uncommitted changes...
set HAS_LOCAL_CHANGES=
for /f "delims=" %%i in ('git status --porcelain') do set HAS_LOCAL_CHANGES=1

if not defined HAS_LOCAL_CHANGES goto :CLEAN_TREE

echo.
echo [WARNING] You have local uncommitted changes:
git status --short
echo.
echo Choose an option:
echo   [1] Stash local changes, pull latest, and restore changes [Recommended]
echo   [2] Try pulling directly [may fail if there are merge conflicts]
echo   [3] Cancel
echo.
set /p "choice=Select option [1/2/3, default 1]: "
if "!choice!"=="" set "choice=1"
if "!choice!"=="3" goto :CANCEL_PULL
if "!choice!"=="1" goto :DO_STASH
goto :START_PULL

:DO_STASH
echo.
echo Stashing local changes...
git stash push -m "Auto-stash before pull %date% %time%"
set STASHED=1
goto :START_PULL

:CLEAN_TREE
echo [OK] Working tree clean. Ready to pull.

:START_PULL
echo.
echo [2/3] Fetching and pulling latest changes from GitHub (git pull origin main)...
git pull origin main
set PULL_EXIT=!errorlevel!

if defined STASHED (
    echo.
    echo Restoring stashed local changes...
    git stash pop
)

if not !PULL_EXIT!==0 (
    echo.
    echo [ERROR] Git pull failed! Please check your network or resolve any conflicts.
    echo.
    pause
    exit /b 1
)

echo.
echo [3/3] Current branch status:
git log -1 --oneline
echo.
echo ========================================================
echo      SUCCESS: Repository updated from GitHub!
echo ========================================================
echo.
pause
exit /b 0

:CANCEL_PULL
echo.
echo [CANCELLED] Pull operation cancelled.
echo.
pause
exit /b 0
