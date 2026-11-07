---
name: async-tasks
description: Run long shell commands (builds, servers, watchers) as async tasks and collect them correctly. Use when a command may outlive a minute, when a dev server or watcher must keep running, or when a watch condition must gate progress.
---

# Async shell tasks

`pi-async` runs shell commands as managed tasks: start them detached, observe their output, collect the result later. It exists for the commands that would otherwise block you — not for replacing `bash`.

## Choose the mode

| Situation | Call |
|---|---|
| Quick read/grep/ls, or a command that finishes in seconds | `bash` |
| Build, test suite, or anything that may take more than ~60s | `async_run` (default `mode=background`), then `async_wait` when you need it |
| Dev server, watcher, `tail -f`, anything that never exits | `async_run` `mode=background` + `watch` |
| You need the result before the next step, but not forever | `async_run` `mode=sync` with `timeoutMs` (bounded; promotes to background on expiry) |
| Start later (cool-down, retry window) | `async_run` `mode=delayed` with `delayMs` |

Never wrap a long command in a `sleep`/`until` polling loop inside `bash`: that is the pattern `async_run` + `watch` replaces.

## Collect, do not poll

- `async_wait` blocks until the tasks finish or the budget expires. It never kills them.
- Ending a turn with tasks still running is fine: the completion notification wakes the session. Call `async_wait` only when you need a result now.
- `async_logs` reads output while the task is still running (bounded to 50 KiB by default, ANSI stripped).
- `async_status` lists active tasks; `includeHistory: true` shows recent finished ones (newest first).
- `async_kill` terminates the task and its whole process group.

## Timeouts are three different knobs

- `timeoutMs` (sync only): how long *you* wait before the task is promoted to background. The task keeps running.
- `onTimeout: "promote"` (default) returns while the task continues; `onTimeout: "abort"` stops waiting only — the task keeps running and still notifies. Neither one kills the process.
- `taskTimeoutMs` (any mode): kills the task after that many milliseconds. Use it for a hard deadline, not as a way to avoid blocking.

## Watch conditions

`watch: { intervalMs, timeoutMs, success_when, failure_when, blind_checks }`

- Polling interval is at least 1000 ms. The match window is the trailing **64K characters** of output, not bytes — early output scrolls out of it.
- Conditions inside a group are OR-ed: the first match wins. There is no AND mode; when you need a conjunction, use one condition with a richer `stdout_contains` value.
- A `success_when` match does **not** kill the process: the task is marked `completed`, and process lifetime stays with `taskTimeoutMs` / `async_kill`.
- `blind_checks` counts only infrastructure failures (unreadable output, malformed check) and defaults to 3. "Not yet decidable" is a pending state and does not accumulate.
- Available conditions: `exit_code{equals}`, `stdout_contains{value}`, `stderr_contains{value}`, `json_path_exists{path}` (must start with `$`), `output_matches{regex}`.

### Write checks that cannot lie

1. Never swallow errors with `|| true`; let a non-zero exit reach the check.
2. Map unknown states to failure, not success: `case "$s" in ready) exit 0;; failed) exit 1;; *) exit 2;; esac`.
3. Prefer structured output with `jq -e` so a missing field becomes a non-zero exit.
4. Anchor `output_matches` regexes. The regex is compiled with the `m` flag, so `^`/`$` bind to line boundaries and `^READY$` matches any line — anchor to the exact shape you mean. Nested quantifiers such as `(a+)+` are rejected at validation.
5. For plain substrings prefer `stdout_contains` over a regex.

## Legion children

Before returning a verdict, collect every task you started: `async_wait` (or `async_status` to decide what is still in flight). The settle guard reminds you up to three times; an aborted run gets one follow-up reminder. A verdict reported while work is in flight loses that work's output.

## Naming

Pass `name` so later calls use the handle instead of the opaque taskId. Names are capped at 48 characters; ambiguous names are rejected with the candidate ids, and unknown ids/names are an error rather than a silent success.
