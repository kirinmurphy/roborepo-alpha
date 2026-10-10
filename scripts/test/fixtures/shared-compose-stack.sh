#!/usr/bin/env bash
# Live fixture for the `shared` Compose-ownership verdict.
#
# Why this exists: the classifier's `shared` path cannot be exercised by the repositories on a
# typical dev machine, because they each have exactly one checkout — every real stack classifies
# `owned`. This builds the missing shape: ONE repository, TWO checkouts, and ONE stack that bind
# mounts both, which is the configuration whose misplacement the whole plan exists to fix.
#
# Deliberately NOT built against a real project. An earlier attempt would have started a second
# stack inside the live traefik_vps repo, which serves production on ports 80/443 — a container
# name or port collision there takes down the reverse proxy. A scratch repo exercises the identical
# code path with no blast radius.
#
# Usage:
#   scripts/test/fixtures/shared-compose-stack.sh up     # create repo + worktree, start stack
#   scripts/test/fixtures/shared-compose-stack.sh down   # stop stack, remove everything
#
# The stack is a minimal alpine container writing nothing outside the scratch directory. It DOES
# publish one port, bound to loopback only — see PORT below for why that is required rather than
# incidental.

set -euo pipefail

PROJECT="fixture_shared"
CONTAINER="fixture_sharedb"
STATE_FILE="${TMPDIR:-/tmp}/roborepo-shared-stack-fixture.path"
# Publishing a port is what makes this fixture reach the portal at all, and it must be a REAL
# listener rather than a bare `ports:` entry. Docker Desktop runs containers in a Linux VM, so
# container PIDs never match host lsof PIDs; a published host port is the only correlation discovery
# has (indexDockerContainersByHostPort, discovery.mjs). A container with no published port — or one
# whose port no discovered listener answers on — never becomes an instance, so its Compose project
# never enters the snapshot and the Shared Services rendering it exists to exercise is never drawn.
#
# An earlier version of this fixture ran `sleep` with no ports and could only be verified by driving
# docker inspect output through the snapshot builder by hand, which tested the classifier but never
# the portal.
#
# Bound to 127.0.0.1 explicitly so nothing is reachable off this machine, on a high port unlikely to
# collide. Checked for a conflict before binding, because a collision here would be a confusing
# failure rather than an obvious one.
PORT="${FIXTURE_PORT:-39117}"

write_state_file() {
  local dir="$1"
  if [ -e "$STATE_FILE" ] || [ -L "$STATE_FILE" ]; then
    echo "state file already exists; run '$0 down' before starting a new fixture" >&2
    exit 1
  fi
  if ! (umask 077; set -o noclobber; printf '%s\n' "$dir" > "$STATE_FILE") 2>/dev/null; then
    echo "could not create trusted state file: $STATE_FILE" >&2
    exit 1
  fi
}

read_state_file() {
  if [ -L "$STATE_FILE" ] || [ ! -f "$STATE_FILE" ] || [ ! -O "$STATE_FILE" ]; then
    echo "refusing untrusted state file: $STATE_FILE" >&2
    exit 1
  fi
  cat "$STATE_FILE"
}

up() {
  # Fail loudly and early rather than letting `docker compose up` report a port clash halfway
  # through, having already created the repo, the worktree and the network.
  if lsof -iTCP:"$PORT" -sTCP:LISTEN -P -n >/dev/null 2>&1; then
    echo "port $PORT is already in use; re-run with FIXTURE_PORT=<free port>" >&2
    exit 1
  fi

  local dir
  dir="$(mktemp -d "${TMPDIR:-/tmp}/shared-stack-fixture.XXXXXX")"
  write_state_file "$dir"

  git init -q "$dir"
  git -C "$dir" config user.email fixture@example.invalid
  git -C "$dir" config user.name fixture
  mkdir -p "$dir/data"
  echo "seed" > "$dir/data/seed.sql"
  git -C "$dir" add -A
  git -C "$dir" commit -qm "fixture"
  # A remote makes this resolve to a git: repository id rather than a path-derived local: one, which
  # is what the registry and the classifier are keyed on.
  git -C "$dir" remote add origin git@github.com:example/shared-stack-fixture.git
  git -C "$dir" worktree add -q "${dir}-wt" -b feature
  mkdir -p "${dir}-wt/data"

  # The point of the fixture: bind mounts landing in BOTH checkouts, plus one infrastructure mount
  # that belongs to neither (which must not change the verdict).
  # BusyBox nc serves one connection and exits, so it runs in a loop — discovery polls repeatedly and
  # a listener that died after the first probe would make the fixture flicker in and out of the
  # portal. Answers with a minimal HTTP response so the probe sees a well-formed reply rather than a
  # bare open socket.
  cat > "$dir/docker-compose.yml" <<YAML
services:
  sharedb:
    image: alpine:3.20
    container_name: ${CONTAINER}
    command: ["sh", "-c", "while :; do printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 7\\r\\nConnection: close\\r\\n\\r\\nfixture' | nc -l -p 8080 >/dev/null 2>&1 || sleep 1; done"]
    ports:
      - "127.0.0.1:${PORT}:8080"
    volumes:
      - ${dir}/data:/seed-main:ro
      - ${dir}-wt/data:/seed-feature:ro
      - /etc/localtime:/etc/localtime:ro
YAML

  docker compose -f "$dir/docker-compose.yml" -p "$PROJECT" up -d
  echo "fixture up: $dir (worktree: ${dir}-wt)"
  echo "listening on 127.0.0.1:${PORT}"
  echo "expected verdict: shared / conflict, rootId absent"
}

down() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  # `docker rm` leaves the project network behind, which then lingers as fixture_shared_default and
  # has to be cleaned up by hand. Removing the container first (above) keeps this from failing on an
  # in-use network, and the `|| true` covers the case where compose already took it down.
  docker network rm "${PROJECT}_default" >/dev/null 2>&1 || true
  if [ -e "$STATE_FILE" ] || [ -L "$STATE_FILE" ]; then
    local dir
    dir="$(read_state_file)"
    if [ -n "$dir" ] && [ -d "$dir" ]; then
      git -C "$dir" worktree remove --force "${dir}-wt" >/dev/null 2>&1 || rm -rf "${dir}-wt"
      rm -rf "$dir"
    fi
    rm -f "$STATE_FILE"
  fi
  echo "fixture down"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
