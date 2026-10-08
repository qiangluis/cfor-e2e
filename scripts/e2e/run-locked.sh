#!/bin/bash
# Serialize real E2E runner invocations across parallel agents.
# Usage: scripts/e2e/run-locked.sh node scripts/e2e/runner.mjs --suite cost
#
# The single local backend/frontend/DB is shared, so only one browser flow may
# run at a time. This wrapper uses the macOS built-in shlock to guard a global
# lock file and releases it on exit.
set -uo pipefail

LOCK=/tmp/cfor-e2e/runner.lock
mkdir -p /tmp/cfor-e2e

while ! shlock -p $$ -f "$LOCK" >/dev/null 2>&1; do
  sleep 5
done

cleanup() {
  rm -f "$LOCK"
}
trap cleanup EXIT INT TERM

"$@"
code=$?
exit $code
