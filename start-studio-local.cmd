@echo off
setlocal
rem Start the Ekko Studio desktop app in LOCAL mode: it boots its own bundled
rem server on 127.0.0.1:8748 and needs no SSH tunnel or remote deployment.
rem Requires a prior `npm run build` in studio/ (produces dist/client + dist/server).

set "APP=%~dp0studio\packages\desktop"
set "ELECTRON=%APP%\node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" (
  echo Electron is not installed. Run:
  echo   cd /d "%APP%" ^&^& npm ci ^&^& node node_modules\electron\install.js
  exit /b 1
)
if not exist "%~dp0studio\dist\server\index.js" (
  echo studio/dist is missing. Run: cd /d "%~dp0studio" ^&^& npm run build
  exit /b 1
)
if not exist "%APP%\resources\node\win-x64\node.exe" (
  echo Bundled node runtime is missing. Run: cd /d "%APP%" ^&^& npm run fetch:node
)

start "" "%ELECTRON%" "%APP%"
endlocal
