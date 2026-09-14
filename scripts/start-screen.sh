#!/usr/bin/env bash
# Keep service output in both the screen terminal and an append-only log.
set -euo pipefail
NAME="${1:?screen name required}"
DIRECTORY="${2:?working directory required}"
LOG="${3:?log path required}"
shift 3
for tool in screen flock; do
    command -v "$tool" >/dev/null || { echo "Missing command: $tool" >&2; exit 1; }
done
command -v "$1" >/dev/null || { echo "Missing command: $1" >&2; exit 1; }
[[ "$NAME" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Invalid screen name.' >&2; exit 1; }
mkdir -p "$(dirname "$LOG")"
exec 9>"${TMPDIR:-/tmp}/live-vlm-screen-$UID-$NAME.lock"
flock -n 9 || { echo "Another launch for $NAME is in progress." >&2; exit 1; }
running() {
    screen -ls | grep -Eq "[0-9]+\.$NAME[[:space:]]"
}
if running; then
    echo "Screen $NAME already exists; keeping the current process and settings."
else
    cd "$DIRECTORY"
    screen -L -Logfile "$LOG" -dmS "$NAME" "$@" 9>&-
    # Flush logs promptly, including failures from commands that exit during startup.
    screen -S "$NAME" -X logfile flush 1 || true
    sleep 2
    if ! running; then
        echo "Screen $NAME exited during startup. Output: $LOG" >&2
        tail -n 30 "$LOG" >&2
        exit 1
    fi
fi
printf '\nScreen: %s\nAttach: screen -r %s\nDelete / stop service: screen -S %s -X quit\nLog: %s\nDetach: Ctrl+A, then D\n' "$NAME" "$NAME" "$NAME" "$LOG"
