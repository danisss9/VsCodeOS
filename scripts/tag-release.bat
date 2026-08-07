@echo off
setlocal

REM Creates and pushes an annotated tag named after the current date, e.g. v2025.08.07.
REM Usage: scripts\tag-release.bat [remote]   (remote defaults to "origin")

set "REMOTE=%~1"
if "%REMOTE%"=="" set "REMOTE=origin"

REM Run from the repository root regardless of where the script was invoked.
cd /d "%~dp0.."

git rev-parse --git-dir >nul 2>&1
if errorlevel 1 (
    echo ERROR: not inside a git repository.
    exit /b 1
)

REM Locale-independent date via PowerShell; "date /t" varies by regional settings.
for /f "usebackq delims=" %%d in (`powershell -NoProfile -Command "(Get-Date).ToString('yyyy.MM.dd')"`) do set "TODAY=%%d"
if "%TODAY%"=="" (
    echo ERROR: could not determine the current date.
    exit /b 1
)

set "TAG=v%TODAY%"

git rev-parse -q --verify "refs/tags/%TAG%" >nul
if not errorlevel 1 (
    echo ERROR: tag %TAG% already exists locally.
    exit /b 1
)

echo Creating tag %TAG%...
git tag -a "%TAG%" -m "Release %TAG%"
if errorlevel 1 (
    echo ERROR: failed to create tag %TAG%.
    exit /b 1
)

echo Pushing %TAG% to %REMOTE%...
git push "%REMOTE%" "%TAG%"
if errorlevel 1 (
    echo ERROR: failed to push %TAG%; removing the local tag.
    git tag -d "%TAG%" >nul
    exit /b 1
)

echo Done: %TAG% pushed to %REMOTE%.
endlocal
