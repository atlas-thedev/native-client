@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title Native Client - Git Pull

echo ========================================================
echo               Native Client - Quick Pull
echo ========================================================
echo.

cd /d "%~dp0"

where git >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Git is not installed or not on PATH.
    echo.
    pause
    exit /b 1
)

if not exist ".git" (
    echo [ERROR] No .git repository found in %~dp0
    echo.
    pause
    exit /b 1
)

REM Avoid "detected dubious ownership" errors on copied / other-user folders
git config --global --add safe.directory "%CD%" >nul 2>&1

for /f "delims=" %%B in ('git branch --show-current') do set "BRANCH=%%B"
if not defined BRANCH set "BRANCH=(detached)"
echo Current branch: !BRANCH!
if /i not "!BRANCH!"=="main" (
    echo [WARNING] You are not on main. This script pulls origin main into !BRANCH!.
    set /p "CONT=Switch to main first? (Y/n): "
    if /i not "!CONT!"=="n" (
        git checkout main
        if errorlevel 1 (
            echo [ERROR] Could not switch to main. Commit or stash your changes first.
            echo.
            pause
            exit /b 1
        )
    )
)

echo.
echo [1/4] Checking for local uncommitted changes...
set "HAS_LOCAL_CHANGES="
REM Untracked files (e.g. restored build assets) do not block a pull, so ignore them here
for /f "delims=" %%i in ('git status --porcelain --untracked-files=no') do set "HAS_LOCAL_CHANGES=1"
set "STASHED="

if not defined HAS_LOCAL_CHANGES (
    echo [OK] Working tree clean. Ready to pull.
    goto START_PULL
)

echo.
echo [WARNING] You have local uncommitted changes:
git status --short --untracked-files=no
echo.
echo Choose an option:
echo   [1] Stash local changes, pull latest, and restore changes [Recommended]
echo   [2] Discard local changes and pull latest [your edits are lost]
echo   [3] Cancel
echo.
set "choice="
set /p "choice=Select option [1/2/3, default 1]: "
if "!choice!"=="" set "choice=1"
if "!choice!"=="3" goto CANCEL_PULL
if "!choice!"=="2" goto DO_DISCARD

echo.
echo Stashing local changes...
git stash push -m "Auto-stash before pull"
if errorlevel 1 (
    echo [ERROR] Could not stash local changes.
    echo.
    pause
    exit /b 1
)
set "STASHED=1"
goto START_PULL

:DO_DISCARD
echo.
echo Discarding local changes...
git reset --hard HEAD
goto START_PULL

:START_PULL
echo.
echo [2/4] Fetching latest changes from GitHub...
git -c gc.auto=0 -c maintenance.auto=false fetch origin
if errorlevel 1 (
    echo.
    echo [ERROR] Fetch failed. Check your internet connection or GitHub login.
    goto RESTORE_AND_FAIL
)

echo.
echo [3/4] Updating to origin/main...
REM --no-rebase --no-edit: never stop on "divergent branches" and never open an editor
git -c gc.auto=0 -c maintenance.auto=false -c pull.rebase=false pull --no-rebase --no-edit origin main
if errorlevel 1 (
    echo.
    echo [ERROR] Git pull failed. Resolve the conflicts shown above, or run this
    echo         script again and choose option 2 to discard local edits.
    goto RESTORE_AND_FAIL
)

if defined STASHED (
    echo.
    echo Restoring stashed local changes...
    git stash pop
    if errorlevel 1 (
        echo [WARNING] Your changes conflict with the update. They are kept in "git stash list".
    )
)

echo.
echo [4/4] Current version:
git log -1 --oneline
echo.
echo ========================================================
echo      SUCCESS: Repository updated from GitHub
echo ========================================================
echo.
pause
exit /b 0

:RESTORE_AND_FAIL
if defined STASHED (
    echo.
    echo Restoring stashed local changes...
    git stash pop
)
echo.
pause
exit /b 1

:CANCEL_PULL
echo.
echo [CANCELLED] Pull operation cancelled.
echo.
pause
exit /b 0
