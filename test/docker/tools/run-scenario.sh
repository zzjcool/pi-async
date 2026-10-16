#!/bin/bash
# Run one TUI scenario by id, resolving its json/keys pair by glob.
#
#   run-scenario.sh <id> [root] [container] [cols] [rows]
#
# Scenario files are NOT uniformly named: s1-single-task.json, s2-concurrent.json,
# s105-rail-overflow.json ... so the json must be discovered, not derived from the
# id. (An earlier Makefile hardcoded "$(SCENARIO)-single-task.json", which made
# every id except s1 fail with "no such file".)
#
# 28 of the 102 ids have keys but no json of their own. By default those are
# rejected: mock-llm.py falls back to {"text":"mock response"} without --script,
# so they would produce clean-looking artifacts that tested nothing. Pass
# REUSE_JSON=<id> to borrow another scenario's json explicitly.
set -uo pipefail

ID="${1:?usage: run-scenario.sh <id> [root] [container] [cols] [rows]}"
ROOT="${2:-$(cd "$(dirname "$0")/../../.." && pwd)}"
CONTAINER="${3:-pi-async-qa}"
COLS="${4:-120}"
ROWS="${5:-36}"

SCEN_DIR="$ROOT/test/scenarios"
[ -d "$SCEN_DIR" ] || { echo "FAIL: no $SCEN_DIR" >&2; exit 1; }

KEYS="$SCEN_DIR/$ID-keys.txt"
[ -f "$KEYS" ] || { echo "FAIL: $KEYS not found" >&2; exit 1; }

# Discover the json: <id>-*.json (exactly one expected).
shopt -s nullglob
JSONS=("$SCEN_DIR/$ID"-*.json)
shopt -u nullglob

if [ "${#JSONS[@]}" -eq 1 ]; then
  JSON="${JSONS[0]}"
elif [ "${#JSONS[@]}" -eq 0 ]; then
  if [ -n "${REUSE_JSON:-}" ]; then
    shopt -s nullglob
    BORROW=("$SCEN_DIR/$REUSE_JSON"-*.json)
    shopt -u nullglob
    [ "${#BORROW[@]}" -eq 1 ] || { echo "FAIL: REUSE_JSON=$REUSE_JSON resolves to ${#BORROW[@]} files" >&2; exit 1; }
    JSON="${BORROW[0]}"
    echo "NOTE: $ID has no json of its own; borrowing $(basename "$JSON")" >&2
  else
    echo "FAIL: $ID has no json (only keys)." >&2
    echo "      Without a script mock-llm.py replies 'mock response' and creates no" >&2
    echo "      tasks — the run would look clean while testing nothing." >&2
    echo "      If it really reuses another scenario's json: REUSE_JSON=<id> $0 $ID" >&2
    exit 1
  fi
else
  echo "FAIL: $ID matches ${#JSONS[@]} json files: ${JSONS[*]##*/}" >&2
  exit 1
fi

NAME="$ID-$(date +%H%M%S)"
echo "scenario: $ID  json=$(basename "$JSON")  keys=$(basename "$KEYS")"

exec docker exec "$CONTAINER" /qa/tools/harness.sh \
  "$NAME" "/qa/scenarios/$(basename "$JSON")" "/qa/scenarios/$(basename "$KEYS")" \
  "$COLS" "$ROWS"
