@echo off
cd /d "%~dp0"
rem DJRepo runs in its own Python environment (.venv). The first run creates it and installs graphify.
if not exist ".venv\Scripts\python.exe" (
  echo Creating DJRepo's Python environment in .venv ...
  python -m venv .venv 2>nul || py -3 -m venv .venv
  if not exist ".venv\Scripts\python.exe" goto nopython
)
if not exist ".venv\Scripts\graphify.exe" (
  echo Installing graphify into .venv ...
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r requirements.txt
  if errorlevel 1 goto noinstall
)
".venv\Scripts\python.exe" src\server.py %*
if errorlevel 1 pause
goto :eof

:nopython
echo Couldn't create the environment. Install Python 3.11 or newer from https://www.python.org and try again.
pause
goto :eof

:noinstall
echo Couldn't install graphify. Check your internet connection and try again.
pause
