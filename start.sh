#!/bin/sh
# DJRepo runs in its own Python environment (.venv). The first run creates it and installs graphify.
cd "$(dirname "$0")" || exit 1
if [ ! -x .venv/bin/python ]; then
  echo "Creating DJRepo's Python environment in .venv ..."
  python3 -m venv .venv || { echo "Couldn't create it. Install Python 3.11 or newer and try again."; exit 1; }
fi
if [ ! -x .venv/bin/graphify ]; then
  echo "Installing graphify into .venv ..."
  .venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt \
    || { echo "Couldn't install graphify. Check your internet connection and try again."; exit 1; }
fi
exec .venv/bin/python server.py "$@"
