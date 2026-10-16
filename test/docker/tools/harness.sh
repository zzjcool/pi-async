#!/bin/bash
# Run one deterministic pi-async TUI scenario.
#
# Each run is hermetic: a fresh scripted mock endpoint, a fresh pi HOME
# (mock provider + pi-async), a fresh tmux session. Same scenario + keys =>
# same frames, so any bug found is reproducible by re-running the harness.
#
# Usage: harness.sh <name> <scenario.json> <keys.txt> [cols] [rows]
#
# Environment overrides: EXTRA_ENV="PI_ASYNC_MAX_TASKS=2" harness.sh ...
#   (use this instead of sed-deriving harness variants, which drift from the main one)
#
# Keys file directives (one per line):
#   some text   type it, press Enter, wait, snapshot
#   ~N          sleep N seconds
#   !KEYS       send raw tmux keys (e.g. !C-o)
#   #label      snapshot named label
set -u

NAME="$1"
SCEN="$2"
KEYS="$3"
COLS="${4:-120}"
ROWS="${5:-36}"

QA=/qa
ART=$QA/artifacts/$NAME
rm -rf "$ART"; mkdir -p "$ART"

# --- 1. scripted mock endpoint -------------------------------------------
# A stale mock from an earlier run can silently steal a fixed port, after which
# pi talks to the WRONG script and the artifacts look plausible but are junk.
# Use a fresh random port per run so no earlier process can ever interfere.
#
# Also avoid `pkill -f mock-llm.py`: it matches any wrapper shell whose command
# line contains that string, and it killed the harness itself during bring-up.
PORT=$(python3 - <<'PY'
import socket, random
for _ in range(300):
    p = random.randint(40000, 49999)
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", p)); s.close(); print(p); break
    except OSError:
        s.close()
PY
)
if [ -z "$PORT" ]; then echo "FATAL: could not find a free port" >&2; exit 1; fi

setsid nohup python3 /qa/tools/mock-llm.py --port "$PORT" --script "$SCEN" \
  --log "$ART/mock-requests.log" >"$ART/mock.out" 2>&1 </dev/null &
disown 2>/dev/null

# Wait for the mock to actually accept connections before starting pi.
ready=0
for _ in $(seq 1 40); do
  if curl -sf -m 2 "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
if [ "$ready" != 1 ]; then
  echo "FATAL: mock endpoint never came up; see $ART/mock.out" >&2
  exit 1
fi

# --- 2. fresh pi HOME -----------------------------------------------------
H=/tmp/pihome
rm -rf "$H"; mkdir -p "$H/.pi/agent"
cat > "$H/.pi/agent/auth.json" <<EOF
{"any-endpoint":{"access":"sk-mock","refresh":"none","expires":4102444800000,"baseUrl":"http://127.0.0.1:$PORT/v1","api":"openai-completions","type":"oauth"}}
EOF
# Pre-seed the catalog so pi never depends on a live refresh for model lookup.
cat > "$H/.pi/agent/models-store.json" <<EOF
{"any-endpoint":{"checkedAt":1792090000000,"models":[{"id":"mock-model","name":"Mock Model","api":"openai-completions","baseUrl":"http://127.0.0.1:$PORT/v1","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":128000,"maxTokens":8192}]}}
EOF
echo '{"packages":["npm:pi-any-endpoint@0.1.3","/mnt/pi-async"]}' > "$H/.pi/agent/settings.json"
HOME=$H pi install npm:pi-any-endpoint@0.1.3 >"$ART/install-provider.log" 2>&1
HOME=$H pi install /mnt/pi-async >"$ART/install-plugin.log" 2>&1

# --- 3. boot the TUI ------------------------------------------------------
tmux kill-session -t qa 2>/dev/null
sleep 1
tmux new-session -d -s qa -x "$COLS" -y "$ROWS"
sleep 1
tmux send-keys -t qa "HOME=$H TERM=xterm-256color ${EXTRA_ENV:-} pi --model mock-model" C-m
sleep 14

STEP=0
snap() {
  STEP=$((STEP+1))
  local base; base="$(printf '%02d' "$STEP")-$1"
  tmux capture-pane -p -t qa -e > "$ART/$base.ansi"
  python3 /qa/tools/ansi2png.py "$ART/$base.ansi" "$ART/$base.png" --cols "$COLS" >/dev/null
}
snap boot

# --- 4. drive it like a user ---------------------------------------------
while IFS= read -r line; do
  [ -z "$line" ] && continue
  case "$line" in
    '~'*) sleep "${line#?}";;
    '!'*) tmux send-keys -t qa "${line#?}";;
    '#'*) snap "${line#?}";;
    *) tmux send-keys -t qa "$line" C-m; sleep 8; snap typed;;
  esac
done < "$KEYS"

sleep 5
snap final

# A run where the scripted model was never called proves nothing about the
# extension: the TUI may have bounced the prompt or the provider failed. Fail
# loudly instead of emitting artifacts that look like a clean result.
if [ ! -s "$ART/mock-requests.log" ]; then
  echo "FATAL: mock endpoint received no requests - scenario did not execute" >&2
  echo "ARTIFACTS=$ART"
  exit 1
fi
# Report the request count so a scenario that silently stops early (e.g. a turn
# was consumed but pi did not call back) is visible rather than looking "clean".
echo "mock port: $PORT"
if [ -n "${EXPECTED_REQUESTS:-}" ] && [ "$(wc -l < "$ART/mock-requests.log")" -lt "$EXPECTED_REQUESTS" ]; then
  echo "WARNING: only $(wc -l < "$ART/mock-requests.log") mock requests, expected >= $EXPECTED_REQUESTS" >&2
fi
echo "mock requests: $(wc -l < "$ART/mock-requests.log")"
echo "ARTIFACTS=$ART"
