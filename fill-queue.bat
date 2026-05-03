@echo off
rem Riempie playback_queue per un utente con la lista di youtube_id passati
rem come argomenti, simulando quello che fa l'app sul caso 7.
rem
rem Uso:
rem   fill-queue.bat <yt_id_1> <yt_id_2> ...
rem   set USER_ID=altro@email.com ^& fill-queue.bat AAA BBB CCC
rem   set KEEP=1 ^& set BASE_POSITION=4 ^& fill-queue.bat DDD EEE
rem                                                     (append da position=4)
rem
rem Default: cancella la coda esistente dell'utente prima di inserire le
rem nuove righe partendo da position=1. Con KEEP=1 non cancella; settare
rem BASE_POSITION per scegliere la position iniziale (le successive +=1).

setlocal enabledelayedexpansion

set "BACKEND_DIR=%~dp0"
set "ENV_FILE=%BACKEND_DIR%.env"

if not exist "%ENV_FILE%" (
  echo [ERRORE] .env non trovato in "%ENV_FILE%"
  pause
  exit /b 1
)

rem Legge SUPABASE_SERVICE_KEY + SUPABASE_URL dal .env (toglie virgolette).
for /f "usebackq tokens=1,* delims==" %%a in ("%ENV_FILE%") do (
  set "k=%%a"
  set "v=%%b"
  set "v=!v:"=!"
  if /i "!k!"=="SUPABASE_SERVICE_KEY" set "SUPABASE_SERVICE_KEY=!v!"
  if /i "!k!"=="SUPABASE_URL"         set "SUPABASE_URL=!v!"
)

if "%SUPABASE_SERVICE_KEY%"=="" (
  echo [ERRORE] SUPABASE_SERVICE_KEY non presente in .env
  pause
  exit /b 1
)
if "%SUPABASE_URL%"=="" (
  echo [ERRORE] SUPABASE_URL non presente in .env
  pause
  exit /b 1
)

if "%USER_ID%"=="" set "USER_ID=rafthefurtiv@gmail.com"

if "%~1"=="" (
  echo Uso: fill-queue.bat ^<youtube_id_1^> ^<youtube_id_2^> ...
  echo Variabili d'ambiente opzionali:
  echo   USER_ID=^<email^>     cambia utente target ^(default rafthefurtiv@gmail.com^)
  echo   KEEP=1               non cancellare la coda esistente prima dell'insert
  echo   BASE_POSITION=^<n^>   con KEEP=1, position iniziale ^(default 1^)
  pause
  exit /b 1
)

set "REST_URL=%SUPABASE_URL%/rest/v1/playback_queue"
set "AUTH=Authorization: Bearer %SUPABASE_SERVICE_KEY%"
set "APIK=apikey: %SUPABASE_SERVICE_KEY%"

echo === fill-queue ^=^> %USER_ID% ===

if "%KEEP%"=="" (
  echo --- DELETE coda esistente ---
  curl -sS -X DELETE "%REST_URL%?user_id=eq.%USER_ID%" -H "%AUTH%" -H "%APIK%" -w "HTTP %%{http_code}\n"
)

rem position di partenza: BASE_POSITION (se settato) o 1.
if "%BASE_POSITION%"=="" set "BASE_POSITION=1"
set /a position=%BASE_POSITION%-1

:loop
if "%~1"=="" goto end
set /a position+=1
set "YOUTUBE_ID=%~1"
echo --- INSERT position=!position! youtube_id=%YOUTUBE_ID% ---
curl -sS -X POST "%REST_URL%" -H "%AUTH%" -H "%APIK%" -H "Content-Type: application/json" -H "Prefer: return=minimal" -d "{\"user_id\":\"%USER_ID%\",\"position\":!position!,\"youtube_id\":\"%YOUTUBE_ID%\"}" -w "HTTP %%{http_code}\n"
shift
goto loop

:end
echo.
echo --- Coda risultante per %USER_ID% ---
curl -sS -X GET "%REST_URL%?user_id=eq.%USER_ID%&order=position.asc&select=position,youtube_id,track_title,track_artist,track_duration" -H "%AUTH%" -H "%APIK%"
echo.
echo.
pause

endlocal
