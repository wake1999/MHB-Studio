@echo off
setlocal
rem Open an SSH tunnel to the studio server and start the Ekko Studio desktop app
rem in remote mode (the desktop shell just wraps the running web UI).
rem Server address comes from the first line of .deploy.local (gitignored).

set "SRV="
if exist "%~dp0.deploy.local" (
  for /f "usebackq delims=" %%a in ("%~dp0.deploy.local") do if not defined SRV set "SRV=%%a"
)
if not defined SRV (
  echo No server configured: put a line like user@host into .deploy.local
  exit /b 1
)

set "APP=%~dp0studio\packages\desktop"
set "ELECTRON=%APP%\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo Electron is not installed. Run:
  echo   cd /d "%APP%" ^&^& npm ci ^&^& node node_modules\electron\install.js
  exit /b 1
)

echo Starting SSH tunnel to %SRV% (local 8648 -> remote 8648) ...
start "" /min ssh -N -L 8648:127.0.0.1:8648 %SRV%

echo Waiting for the tunnel ...
powershell -NoProfile -Command "for ($i=0; $i -lt 30; $i++) { try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8648/health/ready' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; Start-Sleep -Milliseconds 700 }; exit 1"
if errorlevel 1 (
  echo The tunnel did not come up - check that the studio server is running on 8648.
  exit /b 1
)

set "EKKO_STUDIO_DESKTOP_SERVER_URL=http://127.0.0.1:8648"
echo Launching Ekko Studio desktop (remote mode) ...
start "" "%ELECTRON%" "%APP%"
endlocal
