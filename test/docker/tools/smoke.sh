#!/bin/bash
# Three-layer smoke test of the locally mounted pi-async plugin.
#
#   smoke.sh [model] [container]
#
# L1 model reachable -> L2 tools advertised -> L3 a tool ACTUALLY executes.
# L2 alone proves nothing: the tool may be in the prompt while its module
# failed to resolve, or the handler threw and got swallowed.
set -uo pipefail

NAME="${2:-pi-async-test}"
MODEL="${1:-workbuddy/gpt-6-luna}"

run() { timeout 200 docker exec "$NAME" pi --model "$MODEL" --print "$1" 2>&1; }

echo "### L1 model reachable"
L1=$(run "Reply with the single word PONG and nothing else.")
echo "$L1"
if echo "$L1" | grep -qi pong; then echo "L1 OK"; else echo "L1 FAIL"; exit 1; fi

echo
echo "### L2 tools advertised"
L2=$(run "List the exact names of every tool you have whose name starts with async_. One per line, nothing else.")
echo "$L2"
for t in async_run async_wait async_logs async_status async_kill; do
  echo "$L2" | grep -q "$t" || { echo "L2 FAIL: missing $t"; exit 1; }
done
echo "L2 OK"

echo
echo "### L3 tool actually executes"
L3=$(run "Use the async_run tool to run the shell command 'echo SMOKE-OK-\$(date +%s)' in sync mode, then call async_logs on the returned task id and report the raw output verbatim.")
echo "$L3"
if echo "$L3" | grep -q 'SMOKE-OK-'; then echo "L3 OK"; else echo "L3 FAIL"; exit 1; fi

echo
echo "ALL THREE LAYERS PASSED"
