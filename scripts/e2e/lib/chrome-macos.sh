#!/bin/sh
set -eu

# Preserve Chrome arguments while avoiding inherited Rosetta preferences.
exec /usr/bin/arch -arm64 "${CFOR_NATIVE_CHROME_PATH:?Chrome path is required}" "$@"
