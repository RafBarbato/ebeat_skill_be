@echo off
rem Simula la chiamata che la skill Alexa fa al backend per refresh URL.
rem Equivalente a: MusicPlayIntentHandler -> RefreshService.refresh()
rem
rem Uso:
rem   test-refresh.bat                                  (default Lucio Dalla)
rem   test-refresh.bat dQw4w9WgXcQ
rem   test-refresh.bat dQw4w9WgXcQ utente@email.com
rem   test-refresh.bat dQw4w9WgXcQ utente@email.com http://localhost:3000

setlocal enabledelayedexpansion

set "BACKEND_DIR=%~dp0"
set "ENV_FILE=%BACKEND_DIR%.env"

if not exist "%ENV_FILE%" (
  echo [ERRORE] .env non trovato in "%ENV_FILE%"
  exit /b 1
)

rem Leggo SUPABASE_SERVICE_KEY dal .env (rimuove anche eventuali virgolette).
for /f "usebackq tokens=1,* delims==" %%a in ("%ENV_FILE%") do (
  set "k=%%a"
  set "v=%%b"
  if /i "!k!"=="SUPABASE_SERVICE_KEY" (
    set "v=!v:"=!"
    set "SUPABASE_SERVICE_KEY=!v!"
  )
)

if "%SUPABASE_SERVICE_KEY%"=="" (
  echo [ERRORE] SUPABASE_SERVICE_KEY non presente in .env
  exit /b 1
)

set "YOUTUBE_ID=%~1"
if "%YOUTUBE_ID%"=="" set "YOUTUBE_ID=VkTNnCCKnE4"

set "USER_ID=%~2"
if "%USER_ID%"=="" set "USER_ID=rafthefurtiv@gmail.com"

set "BASE_URL=%~3"
if "%BASE_URL%"=="" set "BASE_URL=http://localhost:3000"

echo === Simulate Alexa skill -^> /refresh-track ===
echo BASE_URL    : %BASE_URL%
echo USER_ID     : %USER_ID%
echo YOUTUBE_ID  : %YOUTUBE_ID%
echo.

curl -sS -X POST "%BASE_URL%/refresh-track" -H "Authorization: Bearer %SUPABASE_SERVICE_KEY%" -H "Content-Type: application/json" -d "{\"user_id\":\"%USER_ID%\",\"youtube_id\":\"%YOUTUBE_ID%\"}" -w "\nHTTP %%{http_code} - %%{time_total}s\n"

endlocal
