@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title Native Client - Git Push

echo ========================================================
echo               Native Client - Quick Push
echo ========================================================
echo.

cd /d "%~dp0"

if not exist ".git" (
    echo [ERROR] No .git repository found in %~dp0
    pause
    exit /b 1
)

echo [1/4] Configuring repository safety...
git config --global --add safe.directory "%CD%"
if errorlevel 1 (
    echo [ERROR] Could not configure safe.directory.
    pause
    exit /b 1
)

echo.
echo Checking current branch...
for /f "delims=" %%B in ('git branch --show-current') do set "BRANCH=%%B"

if not defined BRANCH (
    echo [ERROR] Could not detect current branch.
    pause
    exit /b 1
)

echo Current branch: !BRANCH!

if not "!BRANCH!"=="main" (
    echo [WARNING] You are not on main.
    echo This script pushes origin main.
    set /p "CONTINUE=Continue anyway? (y/N): "
    if /i not "!CONTINUE!"=="y" exit /b 1
)

echo.
echo Fetching latest remote information...
git fetch origin
if errorlevel 1 (
    echo [ERROR] Fetch failed. Check your internet or GitHub access.
    pause
    exit /b 1
)

echo.
echo [2/4] Checking repository status...
git status --short
if errorlevel 1 (
    echo [ERROR] Git status failed.
    pause
    exit /b 1
)

set "HAS_CHANGES="
git diff --quiet
if errorlevel 1 set "HAS_CHANGES=1"

git diff --cached --quiet
if errorlevel 1 set "HAS_CHANGES=1"

for /f "delims=" %%i in ('git ls-files --others --exclude-standard') do set "HAS_CHANGES=1"

if defined HAS_CHANGES (
    echo.
    echo Local changes detected.
    set /p "COMMIT_MSG=Enter commit message (Enter for default): "
    if "!COMMIT_MSG!"=="" set "COMMIT_MSG=update: sync changes"

    echo.
    echo Staging changes...
    git add .
    if errorlevel 1 (
        echo [ERROR] Failed to stage changes.
        pause
        exit /b 1
    )

    echo.
    echo Committing changes...
    git commit -m "!COMMIT_MSG!"
    if errorlevel 1 (
        echo [ERROR] Commit failed. Check whether there are changes to commit.
        pause
        exit /b 1
    )
) else (
    echo [INFO] No local changes to commit.
)

echo.
echo [3/4] Checking commits waiting to be pushed...

git rev-parse --verify origin/main >nul 2>&1
if errorlevel 1 (
    echo [ERROR] origin/main not found.
    echo Check that your remote is configured correctly.
    pause
    exit /b 1
)

for /f %%C in ('git rev-list --count origin/main..HEAD') do set "AHEAD=%%C"

echo Commits ahead of origin/main: !AHEAD!

if "!AHEAD!"=="0" (
    echo.
    echo [INFO] Nothing new to push.
    echo.
    pause
    exit /b 0
)

echo.
echo [4/4] Pushing to GitHub...
git push origin HEAD:main
if errorlevel 1 (
    echo.
    echo [ERROR] Git push failed!
    echo Possible causes:
    echo - Remote changes need to be pulled first.
    echo - GitHub authentication failed.
    echo - Branch protection blocked the push.
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
exit /b 0