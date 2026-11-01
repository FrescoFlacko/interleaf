#!/usr/bin/env bash
# Runs a command (normally the Playwright suite) inside a disposable D-Bus
# session whose gnome-keyring is unlocked, so Linux E2E credential workflows
# use a real libsecret backend instead of failing closed on `basic_text`.
#
#   tests/e2e/run-with-linux-keyring.sh npx playwright test
#
# Everything the keyring writes lives in a fresh temporary directory removed on
# exit; the person's own login keyring and session bus are never reached. The
# unlock password is a fixed placeholder because the keyring holds nothing but
# this run's placeholder keys. Requires dbus-run-session and
# gnome-keyring-daemon; DISPLAY is the caller's (for example a private
# `Xvfb :97 -ac -nolisten tcp`). Nothing here weakens main's own check: if the
# secret service is not usable, Electron selects `basic_text` and main refuses.
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "run-with-linux-keyring.sh: Linux only" >&2
  exit 2
fi
if [[ $# -eq 0 ]]; then
  echo "usage: tests/e2e/run-with-linux-keyring.sh COMMAND [ARG...]" >&2
  exit 2
fi
for tool in dbus-run-session gnome-keyring-daemon; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "run-with-linux-keyring.sh: $tool is not installed" >&2
    exit 2
  fi
done

scratch="$(mktemp -d "${TMPDIR:-/tmp}/interleaf-e2e-keyring-XXXXXX")"
trap 'rm -rf -- "$scratch"' EXIT
mkdir -m 0700 "$scratch/runtime" "$scratch/data" "$scratch/config" "$scratch/cache"

export XDG_RUNTIME_DIR="$scratch/runtime"
export XDG_DATA_HOME="$scratch/data"
export XDG_CONFIG_HOME="$scratch/config"
export XDG_CACHE_HOME="$scratch/cache"
export INTERLEAF_E2E_LINUX_SECRET_SERVICE=1

# shellcheck disable=SC2016 # expanded by the inner shell, inside the session.
dbus-run-session -- bash -c '
  set -euo pipefail
  printf "%s" "interleaf-e2e-placeholder" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  exec "$@"
' interleaf-e2e-keyring "$@"
