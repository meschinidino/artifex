#!/usr/bin/env bash
# Agent helper (not user docs): start/stop the artifex floor server cleanly.
#
#   scripts/floor.sh start [port]    start, wait for HTTP 200 (default port 4517)
#   scripts/floor.sh stop [port]     stop, verify port closed + no orphans
#   scripts/floor.sh restart [port]  stop then start
#   scripts/floor.sh status [port]   report PID-file / process / port state
#
# No-orphan design: the server starts backgrounded under `set -m`, so it
# leads its own process group (pgid == pid) and stop signals the GROUP —
# server plus its parser children — never just the PID. The PID file is
# validated (PID must still be OUR server, by command line) before any
# signal, so a stale or recycled PID is never killed.
set -u
# No `set -e`: every failure path reports explicitly.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${2:-4517}"
PIDFILE="/tmp/artifex-floor.${PORT}.pid"
LOGFILE="/tmp/artifex-floor.${PORT}.log"

case "$PORT" in ''|*[!0-9]*) echo "error: port must be numeric, got '${PORT}'" >&2; exit 2;; esac

# Server PIDs for THIS repo+port (empty when none).
find_server() {
  pgrep -f "server/index.ts --repo ${ROOT} --port ${PORT}" 2>/dev/null || true
}

# True when the PID file names a live process that is our server.
pidfile_alive() {
  [ -f "$PIDFILE" ] || return 1
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null)" || return 1
  case "$pid" in ''|*[!0-9]*) return 1;; esac
  [ "$pid" -gt 1 ] 2>/dev/null || return 1
  ps -p "$pid" -o args= 2>/dev/null | grep -q "server/index.ts --repo ${ROOT} --port ${PORT}" || return 1
  return 0
}

http_code() {
  # curl prints 000 itself on connection failure; default only if empty.
  local out
  out="$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://127.0.0.1:${PORT}/" 2>/dev/null || true)"
  echo "${out:-000}"
}

cmd_start() {
  if pidfile_alive; then
    echo "floor already running (pid $(cat "$PIDFILE")) at http://127.0.0.1:${PORT}/ (HTTP $(http_code))"
    return 0
  fi
  rm -f "$PIDFILE"
  # A live server started by hand (or a dead PID file): adopt it rather
  # than double-binding the port.
  local lingering
  lingering="$(find_server | head -1)"
  if [ -n "$lingering" ]; then
    echo "$lingering" > "$PIDFILE"
    echo "floor already running (pid $lingering, adopted) at http://127.0.0.1:${PORT}/ (HTTP $(http_code))"
    return 0
  fi
  ( set -m
    cd "$ROOT" || exit 1
    # shellcheck disable=SC2086
    nohup bun run server/index.ts --repo "$ROOT" --port "$PORT" >>"$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
  )
  local pid
  pid="$(cat "$PIDFILE")"
  # Wait for HTTP 200 (boot parses the repo); bail if the child dies.
  local deadline=$((SECONDS + 45))
  while [ $SECONDS -lt $deadline ]; do
    if ! ps -p "$pid" >/dev/null 2>&1; then
      echo "error: server (pid $pid) died during boot; log tail:" >&2
      tail -20 "$LOGFILE" >&2
      rm -f "$PIDFILE"
      return 1
    fi
    if [ "$(http_code)" = "200" ]; then
      echo "floor up (pid $pid) at http://127.0.0.1:${PORT}/ — log $LOGFILE"
      return 0
    fi
    sleep 1
  done
  echo "error: timed out waiting for HTTP 200 on $PORT (pid $pid alive); log tail:" >&2
  tail -20 "$LOGFILE" >&2
  return 1
}

# The no-orphan gate: port closed AND no server processes for this repo.
verify_clean() {
  local dirty=0
  local code
  code="$(http_code)"
  if [ "$code" != "000" ]; then
    echo "NOT CLEAN: port $PORT still answers HTTP $code" >&2
    dirty=1
  fi
  local left
  left="$(find_server)"
  if [ -n "$left" ]; then
    echo "NOT CLEAN: server processes remain: $(echo "$left" | tr '\n' ' ')" >&2
    dirty=1
  fi
  if [ $dirty -eq 0 ]; then
    echo "stopped: no orphans (port $PORT closed, no server processes)"
    return 0
  fi
  return 1
}

cmd_stop() {
  local pid=""
  if [ -f "$PIDFILE" ]; then
    pid="$(cat "$PIDFILE" 2>/dev/null)" || pid=""
    case "$pid" in ''|*[!0-9]*|0|1) pid="";; esac
  fi
  if [ -n "$pid" ] && ! pidfile_alive; then
    echo "stale PID file (pid $pid is not our server); dropping it"
    rm -f "$PIDFILE"
    pid=""
  fi
  if [ -z "$pid" ]; then
    pid="$(find_server | head -1)"
    [ -n "$pid" ] && echo "no PID file; found server pid $pid by scan"
  fi
  if [ -z "$pid" ]; then
    echo "floor not running (port $PORT)"
    rm -f "$PIDFILE"
    verify_clean
    return $?
  fi
  # Signal the GROUP (pgid == pid by construction): server + parser kids.
  kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  local i
  for i in $(seq 1 100); do
    ps -p "$pid" >/dev/null 2>&1 || break
    sleep 0.1
  done
  if ps -p "$pid" >/dev/null 2>&1; then
    echo "SIGTERM ignored after 10s; SIGKILLing group $pid"
    kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PIDFILE"
  verify_clean
}

cmd_status() {
  local pid="(none)"
  [ -f "$PIDFILE" ] && pid="$(cat "$PIDFILE" 2>/dev/null)"
  echo "pidfile: $PIDFILE -> $pid"
  local procs
  procs="$(find_server | tr '\n' ' ')"
  echo "server processes: ${procs:-(none)}"
  echo "port $PORT: HTTP $(http_code)"
  [ -n "$procs" ]
}

case "${1:-}" in
  start) cmd_start;;
  stop) cmd_stop;;
  restart) cmd_stop && cmd_start;;
  status) cmd_status;;
  *) echo "usage: $0 {start|stop|restart|status} [port]" >&2; exit 2;;
esac
