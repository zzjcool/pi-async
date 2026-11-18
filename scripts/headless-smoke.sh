#!/bin/bash
# Real `pi -p` smoke test for the headless guarantee (0.5.0, D5).
#
# Unlike `npm test` (in-process, fake host), this runs a REAL pi process in print mode
# against a scripted mock endpoint, so it can prove the two things unit tests cannot:
#
#   wait    pi -p starts a background task, the task outlives the model's turn, and the
#           process neither exits nor prints an empty answer: after the task finishes the
#           model is re-invoked and its conclusion is what stdout carries.
#   cap     a task that never finishes cannot hold the process forever: the continuation
#           budget runs out, every still-running taskId is printed, and the exit code is
#           non-zero.
#   off     PI_ASYNC_PRINT_WAIT=0 reproduces the pre-0.5.0 behaviour (early exit, no
#           conclusion) — the mutation evidence for the `wait` case.
#
# Usage:  scripts/headless-smoke.sh [wait|cap|off]     (default: wait)
# Env:    PI_ASYNC_SMOKE_TIMEOUT  overall pi timeout in seconds (default 120)
#         PI_ASYNC_SMOKE_HOME     a pi HOME to reuse for offline package resolution
#                                 (default: the current $HOME, so npm-installed providers
#                                  resolve without network)
#
# Requires: pi on PATH, python3, node. No network, no model credentials — the mock
# endpoint speaks OpenAI-compatible SSE and is driven by test/docker/tools/mock-llm.py.
set -u

CASE="${1:-wait}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
MOCK="$ROOT/test/docker/tools/mock-llm.py"
EXT="$ROOT/extensions/index.ts"
PY="${PYTHON:-python3}"
SMOKE_TIMEOUT="${PI_ASYNC_SMOKE_TIMEOUT:-120}"

WORK=$(mktemp -d /tmp/pi-async-headless.XXXXXX)
MOCK_PID=""
cleanup() {
  if [ -n "$MOCK_PID" ]; then kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- 1. free port + scripted scenario ------------------------------------
PORT=$(node -e '
const net = require("node:net");
const s = net.createServer();
s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });
')
[ -n "$PORT" ] || { echo "FATAL: could not find a free port" >&2; exit 1; }

case "$CASE" in
  wait)
    # turn 1: start a background task that outlives the model's turn
    # turn 2: the model's first (immediate) answer — it must NOT be the final output
    # turn 3: served only when the guarantee re-invokes the model after the task finished
    cat > "$WORK/scenario.json" <<'EOF'
{"turns": [
  {"text": "Starting work.", "tools": [{"name": "async_run", "arguments": {"command": "sleep 3; echo READY", "mode": "background", "name": "smoke-wait"}}]},
  {"text": "Waiting for the task to finish."},
  {"text": "CONCLUSION-AFTER-TASK"}
]}
EOF
    ;;
  cap)
    # turn 1 finishes inside the budget (one continuation is spent), turn 3 starts a task that
    # cannot finish — so the next boundary hits the continuation cap, not the clock.
    cat > "$WORK/scenario.json" <<'EOF'
{"turns": [
  {"text": "Starting the first task.", "tools": [{"name": "async_run", "arguments": {"command": "sleep 1; echo FIRST", "mode": "background", "name": "smoke-cap-first"}}]},
  {"text": "Waiting for the first task."},
  {"text": "Starting a task that never finishes.", "tools": [{"name": "async_run", "arguments": {"command": "sleep 60; echo NEVER", "mode": "background", "name": "smoke-cap"}}]},
  {"text": "Agent kept talking."}
]}
EOF
    ;;
  off)
    cat > "$WORK/scenario.json" <<'EOF'
{"turns": [
  {"text": "Starting work.", "tools": [{"name": "async_run", "arguments": {"command": "sleep 3; echo READY", "mode": "background", "name": "smoke-off"}}]},
  {"text": "Waiting for the task to finish."},
  {"text": "CONCLUSION-AFTER-TASK"}
]}
EOF
    ;;
  *) echo "usage: $0 [wait|cap|off]" >&2; exit 2 ;;
esac

setsid nohup "$PY" "$MOCK" --port "$PORT" --script "$WORK/scenario.json" --log "$WORK/requests.log" \
  >"$WORK/mock.out" 2>&1 </dev/null &
MOCK_PID=$!
for _ in $(seq 1 40); do
  if curl -sf -m 2 "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
curl -sf -m 2 "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1 || {
  echo "FATAL: mock endpoint never came up" >&2; cat "$WORK/mock.out" >&2; exit 1;
}

# --- 2. throwaway pi HOME pointing at the mock ---------------------------
H="$WORK/home"
mkdir -p "$H/.pi/agent"
# Reuse the host's installed packages so `npm:pi-any-endpoint` resolves with no network.
SRC_HOME="${PI_ASYNC_SMOKE_HOME:-$HOME}"
if [ -d "$SRC_HOME/.pi/agent/npm" ]; then
  ln -s "$SRC_HOME/.pi/agent/npm" "$H/.pi/agent/npm"
fi
cat > "$H/.pi/agent/auth.json" <<EOF
{"any-endpoint":{"access":"sk-mock","refresh":"none","expires":4102444800000,"baseUrl":"http://127.0.0.1:$PORT/v1","api":"openai-completions","type":"oauth"}}
EOF
cat > "$H/.pi/agent/models-store.json" <<EOF
{"any-endpoint":{"checkedAt":1792090000000,"models":[{"id":"mock-model","name":"Mock Model","api":"openai-completions","baseUrl":"http://127.0.0.1:$PORT/v1","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":128000,"maxTokens":8192}]}}
EOF
echo '{"packages":["npm:pi-any-endpoint@0.1.3"]}' > "$H/.pi/agent/settings.json"

# --- 3. run pi -p --------------------------------------------------------
EXTRA_ENV=()
case "$CASE" in
  off) EXTRA_ENV+=("PI_ASYNC_PRINT_WAIT=0") ;;
  cap) EXTRA_ENV+=("PI_ASYNC_PRINT_MAX_CONTINUATIONS=1" "PI_ASYNC_PRINT_WAIT_MS=30000" "PI_ASYNC_PRINT_POLL_MS=100") ;;
esac

START=$(node -e 'console.log(Date.now())')
HOME="$H" env "${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"}" timeout "$SMOKE_TIMEOUT" \
  pi -p --model any-endpoint/mock-model -e "$EXT" "Start the smoke task" \
  >"$WORK/stdout.txt" 2>"$WORK/stderr.txt"
CODE=$?
END=$(node -e 'console.log(Date.now())')
WALL=$((END - START))
REQUESTS=$(node -e '
const fs = require("node:fs");
try { console.log(fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).length); }
catch { console.log(0); }
' "$WORK/requests.log")
# The taskId the throttle notice names: the row this run is complaining about (for the `wait`
# case there is no notice, so fall back to the id in the request log's tool result).
TASK_ID=$(node -e '
const fs = require("node:fs");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const stderr = (() => { try { return fs.readFileSync(process.argv[2], "utf8"); } catch { return ""; } })();
const notice = stderr.split("\n").find((line) => line.includes("still running")) ?? "";
const fromNotice = notice.match(UUID);
if (fromNotice) { console.log(fromNotice[0]); process.exit(0); }
const log = (() => { try { return fs.readFileSync(process.argv[1], "utf8"); } catch { return ""; } })();
const any = log.match(new RegExp(UUID.source, "g")) ?? [];
console.log(any[0] ?? "");
' "$WORK/requests.log" "$WORK/stderr.txt")

echo "### case: $CASE"
echo "### exit: $CODE   wall: ${WALL}ms   requests: $REQUESTS   taskId: ${TASK_ID:-<none>}"
echo "### stdout"
cat "$WORK/stdout.txt"
echo "### stderr"
cat "$WORK/stderr.txt"

fail() { echo "RESULT: FAIL ($1)"; exit 1; }

case "$CASE" in
  wait)
    grep -q "CONCLUSION-AFTER-TASK" "$WORK/stdout.txt" || fail "stdout does not carry the post-task conclusion"
    [ "$CODE" -eq 0 ] || fail "exit code $CODE"
    [ "$WALL" -ge 3000 ] || fail "process exited before the 3s task finished (${WALL}ms)"
    # The continuation request is the one that carries OUR results entry. A bare "requests >= 3"
    # is vacuous: even with the guarantee disabled the shutdown notification buys a third request.
    grep -q "Waited for 1 async task(s)" "$WORK/requests.log" || fail "no provider request carried the print-results entry (the model was not re-invoked by the wait)"
    ! grep -q "Extension error" "$WORK/stderr.txt" || fail "the normal path must not emit extension errors"
    ;;
  cap)
    [ "$CODE" -ne 0 ] || fail "over-budget run exited 0"
    grep -q "still running" "$WORK/stderr.txt" || fail "stderr does not report still-running tasks"
    grep -q "after 1 continuation(s)" "$WORK/stderr.txt" || fail "the continuation cap, not the clock, must end this run"
    # Cap, not clock: the budget is 30 s and the first task takes 1 s, so a run that waited on the
    # clock would be an order of magnitude longer. `and Ns` is printed from the same monotonic clock.
    [ "$WALL" -lt 10000 ] || fail "the run took ${WALL}ms — it waited on the clock, not the cap"
    [ -n "$TASK_ID" ] || fail "stderr does not name the still-running taskId"
    grep -q "$TASK_ID" "$WORK/stderr.txt" || fail "stderr does not contain the taskId $TASK_ID"
    ;;
  off)
    ! grep -q "CONCLUSION-AFTER-TASK" "$WORK/stdout.txt" || fail "conclusion appeared even with the guarantee disabled"
    [ "$WALL" -lt 3000 ] || fail "process still waited with PI_ASYNC_PRINT_WAIT=0 (${WALL}ms)"
    ;;
esac
echo "RESULT: PASS"
