#!/usr/bin/env bash
set -euo pipefail

# Smoke test: portal PID stale detection and clean stop.
# Sandboxed via ROBOREPO_STATE_ROOT and ROBOREPO_PORTAL_PID_PATH so no real state is touched.
# Uses port 14317 to avoid conflicting with a running dashboard on 4317.
#
# Usage: scripts/test/test-telemetry-pid.sh [--quiet|-q]

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cli="${repo_root}/scripts/cli/main.mjs"

quiet=0
for arg in "$@"; do
  case "${arg}" in
    --quiet|-q) quiet=1 ;;
    *) echo "usage: $0 [--quiet|-q]" >&2; exit 2 ;;
  esac
done

work="$(mktemp -d "${TMPDIR:-/tmp}/cli-pid-test.XXXXXX")"
trap 'rm -rf "${work}"' EXIT

pidfile="${work}/portal-server.pid"
export ROBOREPO_STATE_ROOT="${work}/state"
export ROBOREPO_PORTAL_PID_PATH="${pidfile}"

pass=0; fail=0

assert() {
  local label="$1"; shift
  if "$@" 2>/dev/null; then
    [[ "${quiet}" -eq 0 ]] && echo "ok: ${label}"
    pass=$((pass + 1))
  else
    echo "FAIL: ${label}" >&2
    fail=$((fail + 1))
  fi
}

pid_running() { ps -p "$1" > /dev/null 2>&1; }
pid_gone()    { ! ps -p "$1" > /dev/null 2>&1; }
str_contains() { [[ "$1" == *"$2"* ]]; }

# --- stale PID detection ---
# Write a PID that no real process holds (high enough to be safe on macOS + Linux).
echo "9999999" > "${pidfile}"
node "${cli}" web --detach --no-open --port 14317 > /dev/null 2>&1 || true

new_pid=$(cat "${pidfile}" 2>/dev/null || echo "")
assert "stale PID cleared: PID file updated to new value" test "${new_pid}" != "9999999"
assert "stale PID cleared: PID file exists" test -f "${pidfile}"
assert "stale PID cleared: new PID is a live process" pid_running "${new_pid}"

# --- clean stop ---
node "${cli}" web stop > /dev/null 2>&1 || true
# Give the process a moment to exit after SIGTERM.
sleep 0.3

assert "stop: PID file removed" test ! -f "${pidfile}"
assert "stop: server process exited" pid_gone "${new_pid}"

# --- stop with no server is graceful (no crash) ---
output=$(node "${cli}" web stop 2>&1 || true)
assert "stop with no server: exits cleanly" str_contains "${output}" "no server"

# --- detached start refuses an explicit port owned by a FOREIGN (non-roborepo) process ---
# A healthy roborepo portal on the port is adopted (reuse), not a conflict; the real guarantee
# is that a foreign/unhealthy listener on an explicitly requested port is refused without
# clobbering it or leaving a stale PID behind. Occupy the port with a bare 404 server so
# probePortal() classifies it as non-current.
conflict_port=14318
node -e "require('http').createServer((_,res)=>{res.statusCode=404;res.end('nope')}).listen(${conflict_port},'127.0.0.1')" &
foreign_pid=$!
for _ in $(seq 1 25); do
  curl -s "http://127.0.0.1:${conflict_port}/" >/dev/null 2>&1 && break
  sleep 0.2
done
echo "9999999" > "${pidfile}"
conflict_output=$(node "${cli}" web --detach --no-open --port "${conflict_port}" 2>&1 || true)
assert "foreign-occupied explicit port: refused with actionable message" \
  str_contains "${conflict_output}" "stop it or pass --port"
assert "foreign-occupied explicit port: stale PID cleared, port left untouched" test ! -f "${pidfile}"
kill "${foreign_pid}" 2>/dev/null || true
wait "${foreign_pid}" 2>/dev/null || true

# --- two servers on different ports don't kill each other ---
# Regression for the bug where PID tracking was one shared file regardless of port: starting a
# second `serve` on a different port SIGTERM'd whatever the first one had recorded, even though the
# first server wasn't occupying the port the second one was starting on. Runs WITHOUT
# ROBOREPO_PORTAL_PID_PATH so portalPidPathForPort's real per-port scheme is exercised, still
# sandboxed under ROBOREPO_STATE_ROOT from the top of this script; restored afterward so later
# assertions in this file (if any were appended below) keep the single-file sandbox.
saved_pid_path="${ROBOREPO_PORTAL_PID_PATH}"
unset ROBOREPO_PORTAL_PID_PATH

port_a=14319
port_b=14320
node "${cli}" web --detach --no-open --port "${port_a}" > /dev/null 2>&1 || true
pid_a_file="${ROBOREPO_STATE_ROOT}/portal/server-${port_a}.pid"
pid_a="$(cat "${pid_a_file}" 2>/dev/null || echo "")"

node "${cli}" web --detach --no-open --port "${port_b}" > /dev/null 2>&1 || true
pid_b_file="${ROBOREPO_STATE_ROOT}/portal/server-${port_b}.pid"
pid_b="$(cat "${pid_b_file}" 2>/dev/null || echo "")"

assert "two ports: server A still running after server B starts" pid_running "${pid_a}"
assert "two ports: server A's PID file untouched by server B's start" test -f "${pid_a_file}"
assert "two ports: server B started successfully" pid_running "${pid_b}"

node "${cli}" web stop --port "${port_a}" > /dev/null 2>&1 || true
sleep 0.3
assert "two ports: stopping server A leaves server B running" pid_running "${pid_b}"
assert "two ports: server B's PID file untouched by stopping A" test -f "${pid_b_file}"

node "${cli}" web stop --port "${port_b}" > /dev/null 2>&1 || true
sleep 0.3

export ROBOREPO_PORTAL_PID_PATH="${saved_pid_path}"

echo ""
echo "results: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
