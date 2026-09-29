@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title Noctra Client - Git Push

echo ========================================================
echo               Noctra Client - Quick Push
echo ========================================================
echo.

cd /d "%~dp0"

if not exist ".git" (
    echo [ERROR] No .git repository found in %~dp0
    echo.
    pause
    exit /b 1
)

echo [1/4] Checking repository status...
git status --short
echo.

for /f "delims=" %%i in ('git status --porcelain') do set HAS_CHANGES=1

if not defined HAS_CHANGES (
    echo [INFO] No unstaged/uncommitted changes detected.
    for /f "delims=" %%i in ('git cherry -v') do set HAS_COMMITS=1
    if not defined HAS_COMMITS (
        echo [INFO] Working tree clean and already up to date with remote. Nothing to push!
        echo.
        pause
        exit /b 0
    )
)

if defined HAS_CHANGES (
    set /p "commit_msg=Enter commit message (Press Enter for 'update: sync changes'): "
    if "!commit_msg!"=="" set "commit_msg=update: sync changes"

    echo.
    echo [2/4] Staging changes (git add .)...
    git add .
    if errorlevel 1 (
        echo [ERROR] Failed to stage changes.
        pause
        exit /b 1
    )

    echo [3/4] Committing changes...
    git commit -m "!commit_msg!"
    if errorlevel 1 (
        echo [ERROR] Commit failed.
        pause
        exit /b 1
    )
) else (
    echo [2/4] No uncommitted changes to stage.
    echo [3/4] Skipping commit step...
)

echo.
echo [4/4] Pushing to GitHub (git push origin main)...
git push origin main
if errorlevel 1 (
    echo.
    echo [ERROR] Git push failed! Please check your internet connection or git permissions.
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================================
echo      SUCCESS: All changes pushed to GitHub!
echo ========================================================
echo.
pause
