#!/bin/bash
# Start (or recycle) the pi-async smoke container.
#
#   run-container.sh [--root <repo>] [--image <img>] [--name <name>] [--model <id>]
#
# Mounts (all three required):
#   <repo>                      -> /mnt/pi-async            (ro, live plugin source)
#   ~/.pi/agent/auth.json       -> same path                (ro, local model endpoint)
#   ~/.pi/agent/models-store.json -> same path              (rw, pi rewrites checkedAt)
#
# --network=host is mandatory: the endpoint is a HOST process, so under a bridge
# network localhost:<port> is unreachable.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
IMAGE=pi-async-test:latest
NAME=pi-async-test
MODEL=workbuddy/hy4-preview-ioa

# --reuse: keep an already-running container (used by `make run`) instead of
# tearing it down and losing session state.
REUSE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --root)  ROOT="$2";  shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --name)  NAME="$2";  shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --reuse) REUSE=1;     shift 1 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ "$REUSE" = 1 ] && [ -n "$(docker ps --filter name=^/${NAME}$ --filter status=running --quiet)" ]; then
  echo "reusing running container '$NAME'"
  exit 0
fi

docker rm -f "$NAME" >/dev/null 2>&1 || true

docker run -d --name "$NAME" --network=host \
  -v "$ROOT":/mnt/pi-async:ro \
  -v /root/.pi/agent/auth.json:/root/.pi/agent/auth.json:ro \
  -v /root/.pi/agent/models-store.json:/root/.pi/agent/models-store.json \
  "$IMAGE" >/dev/null

# --- verify bring-up -------------------------------------------------------
echo "==> pi version:  $(docker exec "$NAME" pi --version)"
echo "==> packages:"
docker exec "$NAME" pi list | sed 's/^/    /'
echo "==> models:"
docker exec "$NAME" pi --list-models | sed 's/^/    /'

if ! docker exec "$NAME" pi --list-models | grep -q "$MODEL"; then
  echo "WARN: model '$MODEL' not in catalog - check models-store.json mount" >&2
fi

echo
echo "container '$NAME' is up. Next:"
echo "  docker exec -it $NAME pi --model $MODEL"
echo "  cd $HERE/.. && make smoke"
