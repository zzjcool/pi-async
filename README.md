# pi-async

Pi extension for running shell commands asynchronously with bounded output capture, completion notifications, and a task panel.

Tasks run in the **session working directory** — the directory pi is currently in, not the directory the pi process was started from. Every task records its `cwd`, so delayed tasks and `/reload` recovery keep the directory they were submitted from.

## Install

Install the package from npm with Pi's package manager:

```text
pi install npm:pi-async
```

Local path (the other form of the same command, for a checkout):

```text
pi install /path/to/pi-async
```

For development, load the extension directly:

```sh
pi -e ./extensions/index.ts
```

## Tools and commands

The extension registers six tools:

| Tool | Purpose |
|---|---|
| `async_run` | Start a background, delayed, or synchronous shell command. |
| `async_wait` | Wait for task completion or return a `notReady` result on timeout. |
| `async_logs` | Read bounded, ANSI-stripped captured output (`merged` / `stdout` / `stderr`). |
| `async_status` | List tasks and their current state. |
| `async_extend` | Renew a running task: move its reminder and/or hard-timeout deadline. Never kills. |
| `async_kill` | Terminate a task and its process group. |

`async_wait`, `async_logs`, `async_extend`, and `async_kill` accept a task **name** as well as a task id. Ambiguous names are rejected with the candidate ids listed; unknown ids/names are an error instead of a silent success.

### How the model finds these tools

All six tools carry a one-line `promptSnippet`, so the host lists every one of them in the system prompt's
tools section — `async_run` is not the only entry point the model can see.

`async_run` additionally ships four `promptGuidelines` in the system prompt: when to reach for it instead
of `bash`, that ending a turn with running tasks is expected (the completion notification wakes the
session), that `name` + `async_logs` beat re-running a command, and that independent long commands should
be launched together in one batch and collected with a single `async_wait`.

The procedural detail — when **not** to use async at all, how to plan a batch of independent long
commands up front, check-writing discipline, watch semantics, promote vs. abort, legion collection —
ships as an Agent Skill (`skills/async-tasks/SKILL.md`, advertised through `resources_discover`), so it
costs one routing line until the task actually needs it.

Two runtime nudges close the gap that a static prompt cannot:

- after a foreground `bash` call of 60 s or more — or a `tail -f` / `until` / `watch` / `sleep N` shaped
command — the tool result gets one extra line suggesting `async_run`. When the host does not report a wall
time, the extension times the call from `tool_execution_start` instead of guessing;
- while tasks are active, one `<async-state>` line is appended before each request (nothing is injected
when idle, and an unchanged state is not repeated). Its closing sentence follows the **per-task** truth:
a task started with `notifyOnCompletion: false` (or `triggerOnCompletion: false`) is marked `no-notify`,
and when nothing can wake the session the line says so instead of promising a notification.

The general rule lives in the system prompt once; a receipt only adds the **exception** for that call
(`willNotify: false` / `willWake: false` plus a one-line hint). Both nudges are advisory and best-effort;
`PI_ASYNC_NUDGE=0` disables them.

Tool notes:

- `async_run`: `mode` is `background` (default), `delayed` (requires `delayMs`) or `sync` (requires `timeoutMs`). `timeoutMs` is sync-only, `delayMs` is delayed-only, `onTimeout` is sync-only — passing them to the wrong mode is rejected. `onTimeout: "promote"` (default) hands an expired wait to background; `"abort"` stops waiting only, the command keeps running and still notifies. A sync run that **finishes** without exit 0 returns `isError: true` with the full payload (`status` / `exitCode` / `outputTail` / `promoted`) intact. `promoted: true` means the sync wait expired and the task was handed to background (`status: "running"`) — a promoted or aborted wait is **not** a tool error.
- `async_status`: defaults to active (running/pending) tasks. `includeHistory: true` lists up to `limit` (1–50, default 50) tasks sorted newest first; an explicit `status` also sorts newest first. `status` and `name` (case-insensitive substring) filter the list. `delayedEnv` values are masked as `"***"`. Snapshots expose `notified`, `outputConsumed`, `notifyAttempts`, `cwd`, `timeoutAt`, and `watchDeadline`. A delayed task that fails to start (missing `cwd`, rejected `env` key, spawn error) is finalized as `failed` (exit 1) and records the cause in `metadata.startError`.
- `async_logs`: `stream` selects the merged capture or a single stream; `maxBytes` is capped at 50 KiB. A missing output file returns `missing: true` instead of throwing; paths outside the data directory are refused.
- `async_kill`: returns `killKind`, `alreadyTerminal`, `processAlive` and, when the kill could not be confirmed, `warning`.

| Command / key | Action |
|---|---|
| `/async` | Open the task panel. The panel is a singleton: running it again while open only shows an `Async panel is already open` notice and does not stack another overlay — the open panel refreshes itself from registry events plus a 1 Hz ticker, so a running task's output is live while you watch it. |
| `/async-clear` | Clear completed-task history badges. |
| `↑` / `↓` / `j` / `k` | Select tasks; in task details, scroll output (new output does not move a view you scrolled up). |
| `Enter` | Open selected task details: the detail body gives the command's stdout the height that command and metadata do not take, at least 8 rows (on a short terminal the command and metadata collapse into `… (+K lines)` instead), labelled `output (live):` while the task still runs. |
| `h` | Toggle history in the task list. |
| `x` (or `K`) | Kill a running task (press again to confirm). |
| `R` | Rerun the selected task command in that task's original `cwd`. |
| `c` | **Show** the captured output file path as a toast. Nothing is copied: pi exposes no clipboard API, so there is no copy action. |
| `Esc` | Close rail-clicked details; return from list-opened details to the list. |
| `q` | Close the panel. |

The rail's first row summarizes running, pending, elapsed, completed, and failed/killed task counts; pending and failed/killed counts are shown only when nonzero. The rail is not filtered by mode: a `mode=sync` run is a real registered task too, so it appears there and counts as running until it ends. **Mouse support (wheel, click) exists only in fullscreen / alt-screen TUI mode** — pi only enables mouse reporting there; in regular mode use `/async` and the keyboard. The panel and rail are only enabled in the main Pi TUI session; RPC, print, and child contexts retain the tool surface without TUI entrypoints.

## Configuration

| Environment variable | Default | Description |
|---|---:|---|
| `PI_ASYNC_MAX_OUTPUT_BYTES` | `20971520` (20 MiB) | Maximum captured output per task; exceeding it terminates the task with `output_cap`. |
| `PI_ASYNC_MAX_TASKS` | `32` | Maximum concurrent running and pending tasks. |
| `PI_ASYNC_MAX_SYNC_TIMEOUT_MS` | `600000` (10 min) | Upper bound for `sync.timeoutMs` (schema `maximum` and runtime check). |
| `PI_ASYNC_ENV_INHERIT` | `safe` | Child env policy: `safe` strips credential-like variables and rejects dangerous explicit keys; `all` restores full inheritance (explicit dangerous-key overrides are still rejected in every policy); `none` passes only a minimal allowlist (`PATH`, `HOME`, `SHELL`, `TERM`, `LANG`, `LC_*`, `TMPDIR`, `USER`). |
| `PI_ASYNC_SETTLE_GUARD` | `on` | Set `0` to disable the settle guard entirely (no `agent_before_settle` reminder, no `agent_settled` backstop). |
| `PI_ASYNC_NUDGE` | `on` | Set `0` to disable the runtime context nudges (the long-command hint and the `<async-state>` line). |
| `PI_ASYNC_HOLD` | `on` | Set `0` to disable the settle hold entirely (no `agent_before_settle` handler is registered). |
| `PI_ASYNC_HOLD_MS` | `600000` (10 min) | Upper bound for one settle hold; `≤ 0` disables the feature (a negative value is not replaced by the default, and non-integer values fall back to the default). |
| `PI_ASYNC_HOLD_POLL_MS` | `1000` | How often the task list is re-read while the run is being held. |
| `PI_ASYNC_FOOTER` | `off` | Set `1` to also render a one-line task summary through the host's `setStatus` footer (only when the host exposes `setStatus`). The rail's first row is the default status surface. |
| `PI_ASYNC_RETENTION_MS` | `604800000` (7 days) | How long terminal-task artifacts are retained; union with `RETENTION_COUNT`. |
| `PI_ASYNC_RETENTION_COUNT` | `100` | Max newest terminal tasks kept per dataDir; union with `RETENTION_MS`. |
| `PI_ASYNC_RAIL_LINGER_MS` | `30000` | How long completed/failed/killed tasks stay on the rail before disappearing. |

Under the default `safe` policy, inherited variables matching `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIAL*`, plus `AWS_SECRET_ACCESS_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SESSION_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, and `NPM_TOKEN` are removed. `npm_config_*` keys whose name contains `auth`, `token`, or `password` (for example `npm_config__authToken`, which npm reads as a credential) are removed as well, so npm credentials exported by the parent shell do not leak into tasks; ordinary npm settings such as `npm_config_registry` still pass through. Passing a dangerous key explicitly through `env` (`PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `NODE_OPTIONS`, `BASH_ENV`, `ENV`, `SHELLOPTS`, `PYTHONPATH`, `GIT_SSH_COMMAND`) throws instead of being silently ignored — **under every policy, including `all`**; the safety rule cannot be switched off. Ordinary keys may still be overridden.

For delayed tasks the submitted `env` is persisted to `<taskId>.json` (mode `0600`) so the task can still start after `/reload`; the tool surface and the panel render its **values masked as `"***"`** (keys survive).

## Notifications

Completion notifications are **best-effort**. `pi.sendMessage` returns `void` — the host is fire-and-forget and gives no acknowledgement, so pi-async sends once, never retries, and never rolls back. A "queued" notification means it was handed to the host, not that the model read it.

- `notified` becomes true only after `sendMessage` returns; a failure or a missing host API leaves `notified: false` and increments `notifyAttempts`.
- On `session_start`, pi-async **resends** terminal tasks that are still unnotified and unconsumed (within 24 h and under 2 attempts), so a missed wake-up is retried once per session start.
- `async_wait` results are marked consumed (`outputConsumed`), which **suppresses** the completion notification for those tasks to avoid chatter. On a hybrid timeout only the completed side is consumed; not-ready tasks are left alone.
- `async_status` exposes `notified` / `outputConsumed` / `notifyAttempts`, so an agent can check whether it already received (or suppressed) a result.
- `notifyOnCompletion: false` opts a task out entirely.
- A delayed task whose start failed records `metadata.startError`; the failure notification's `guidance` includes it as `Start error: ...`, so the cause (missing `cwd`, rejected `env` key, spawn failure) is visible without an extra `async_logs` call.
- A task killed by `taskTimeoutMs` stays `killed`, but its notification carries `guidance` (grow `taskTimeoutMs` or use `watch`) — it is the one `killed` shape where the next step matters. `completed` notifications stay pure information.

## Settle hold (default on)

Settling is what flips the terminal OSC 7501 status from `working` to `done`. When an interactive TUI
session reaches the end of a turn while async tasks that **will wake it** are still running, pi-async
holds the run at the `agent_before_settle` boundary instead of settling, so the run keeps reporting
`working` for the whole wait.

- Only *wakeable* **`running`** tasks are waited for: `notifyOnCompletion !== false` **and**
  `triggerOnCompletion !== false`. `pending` tasks (a `mode: "delayed"` run) are never held — their
  `dueAt` can be arbitrarily far away, so waiting for one would burn the whole budget at every turn
  end. The set is snapshotted when the boundary opens, so a task started while it waits is not waited
  for.
- Bounded: at most `PI_ASYNC_HOLD_MS` per run (default 600000 ms = 10 min, measured on a monotonic
  clock) and one hold per run (`agent_start` re-arms it). The loop has exactly two exits — every task
  in the snapshot is terminal, or the budget ran out; it never probes the host's message queue, because
  a notification queued during the hold lands on `agent.followUpQueue` while `ctx.hasPendingMessages()`
  only counts the session-level user queues. On timeout the run settles exactly as before — nothing is
  consumed, killed, or suppressed.
- When every task in the snapshot finished, the boundary returns one
  `async-task-settle-results` draft (name, status, exit code — **never** the output tail, use
  `async_logs`) plus `continue: true`, so the outcome reaches the transcript even if the wake-up was
  dropped. That cannot loop: the next boundary sees only terminal tasks and returns nothing.
- Only an interactive TUI session holds. `print` / `json` would delay the process exit, `rpc` aborts
  under a client-side timeout, and legion child sessions keep their own bounded reminder channel —
  none of them are affected.
- While it waits the footer shows `waiting for N tasks <elapsed>`, refreshed every 15 s, whenever the
  host exposes `setStatus`.

| Environment variable | Default | Description |
|---|---:|---|
| `PI_ASYNC_HOLD` | `on` | Set `0` to disable the hold entirely (no handler is registered at all). |
| `PI_ASYNC_HOLD_MS` | `600000` (10 min) | Upper bound for one hold; **≤ 0** disables the feature (a negative value is not replaced by the default; non-integer values fall back to the default). |
| `PI_ASYNC_HOLD_POLL_MS` | `1000` | How often the task list is re-read while holding. |

Start long-lived services (a dev server, a watcher you keep across turns) with
`notifyOnCompletion: false`: such a task is still running at every turn end, so with the default it
would hold **every** turn until `PI_ASYNC_HOLD_MS`.

Pressing Esc during a hold does **not** interrupt it — the host only marks the run aborted and cannot
signal the boundary (`ctx.signal` is gone by then), so the hold keeps waiting and can run up to
`PI_ASYNC_HOLD_MS` before the run settles as aborted. Two different things then happen to the wake-ups:

- a task that **finished during the hold and before the Esc** had its completion notification queued and
then cleared by the host's `clearAllQueues()`; because `notified` is already latched it is never re-sent,
so that task will not wake you — its outcome is still written into the transcript by the
`async-task-settle-results` draft, so the next turn you start can act on it;
- a task that **finishes after the Esc** is not affected: its notification is delivered normally and
still wakes the session.

Fixing the first case means changing the single-delivery semantics of `notify.ts` (or finding a host
signal the boundary can read), which is out of scope for this feature.

## Watches

- Conditions inside a group (`success_when`, `failure_when`) are OR-ed: the **first match wins**. There is no AND mode; use one condition with a richer `stdout_contains` value if you need a conjunction.
- `success_when` records completion without killing the process (task lifetime still belongs to `taskTimeoutMs` / `async_kill`); `failure_when`, blind exhaustion, and watch timeout all kill the process group.
- `blind_checks` (default 3) counts **only infrastructure errors** (e.g. the output file could not be read). "Not yet decidable" states — process still running, JSON not valid yet — stay pending and never accumulate blind checks.
- `output_matches` sees only the trailing **64K characters** of output (UTF-16 code units, not bytes), so a marker far from the tail falls out of the window — anchor accordingly. `stdout_contains` / `stderr_contains` scan the captured stream, but every poll reads only the last 8 MiB, so anything older is invisible to every condition.
- `output_matches` compiles with the `m` flag, so `^` / `$` are line boundaries.

## Data directory

Captured artifacts live per session:

- With a session manager: `<session dir>/pi-async/<sessionId>/`
- Without one: `~/.pi/async/<pid>/`

Each task writes `<taskId>.json` (atomically replaced metadata) plus `<taskId>.output` and its `.stdout` / `.stderr` sidecars. Files are created with mode `0600`.

Do **not** point the data directory at a git-tracked path: captured output can contain credentials, tokens, or other secrets a command printed. Terminal-task artifacts are pruned by `PI_ASYNC_RETENTION_MS` ∪ `PI_ASYNC_RETENTION_COUNT`; non-terminal tasks are never pruned **directly** — orphan detection (`configure()` → `reapOrphans()`) first marks `running` tasks whose pid is gone as `failed` (`failureKind: "lost"`) at startup, and marks pending delayed tasks as `lost` when their due time is older than **`PI_ASYNC_RETENTION_MS`** (the count setting does not apply to them). Pending delayed tasks still inside that window are restored with their remaining delay.

If the resolved data directory changes inside a live process, artifacts are copied to the new location; if migration fails, pi-async logs the error and keeps the old directory so no task is lost.

## Legion child sessions

In a legion child session, collect task results with `async_wait` before returning a verdict. The settle guard pushes a reminder into the model context before settling (up to 3 times, `custom_message` draft, `continue: true`), and an aborted run with active tasks gets a follow-up reminder on `agent_settled`. In the main session the same boundary produces one **advisory** draft (no forced re-run) saying that stopping with background work is fine, because its completion notification will wake the session. Notifications themselves remain best-effort (see above); see [CONTRACT.md §6](docs/CONTRACT.md#6-唤醒链路与-legion-兼容冻结) for the frozen notification and collection requirements.

## Known limitations

- Crash-durability is not guaranteed: metadata is atomically replaced, but captured output is not fsynced. After a crash, orphaned running tasks are marked `failed`/`lost` on the next start, and pending delayed tasks are restored with their remaining delay by whichever session next loads the same data directory (process identity does not matter). Recovery inside the same process is complete for `/reload` (`cwd`, `taskTimeoutMs` deadline, and watch deadline are rebuilt from disk).
- Cross-turn wake-up in legion children depends on the host delivering follow-up messages (upstream pi-legion issue [#156](https://github.com/zzjcool/pi-legion/issues/156)); the extension does not patch Pi or legion.
- The settle hold keeps the OSC 7501 status and the footer line in `working`, but it does **not** relight
  the TUI working spinner: pi's harness already cleared it at `agent_end` and the extension has no API to
  bring it back. Pressing Esc during a hold only marks the run aborted (pi does not interrupt the
  awaiting handler) and the hold cannot observe it, so the hold **waits out its budget** (up to
  `PI_ASYNC_HOLD_MS`) before the run settles as aborted. Wake-ups are lost only for tasks that finished
  **during** the hold and **before** the Esc: their notifications were cleared with the agent queues and
  `notified` is already latched, so they will not wake you — their outcome still reaches the transcript
  through the settle-result draft. Tasks that finish **after** the Esc wake the session normally. Input
  is not frozen.
- Because a hold keeps the run busy, `waitForIdle()` waits for it too: any command that does
  `await session.abort()` waits up to `PI_ASYNC_HOLD_MS` while a hold is in progress (e.g. `/tree`
  navigation — `interactive-mode.js:4758` → `agent-session.js:1999`). Esc itself is `void abort()`, stays
  non-blocking, and does not take that path.
- TUI rail and panel are available only in the main TUI session, not in RPC/print/child contexts.
- `pi --print` notification delivery requires an available configured provider. If no provider is available, end-to-end print-mode verification remains pending a user run.

## Development checks

```sh
npm run typecheck
npm test
npm run verify           # typecheck + test (same gate as prepublishOnly)
npm run adoption         # adoption report from real session JSONL (last 15 sessions)
npm pack --dry-run
```

`npm run adoption` reads `~/.pi/agent/sessions/*/*.jsonl` (`--dir` / `--limit` / `--json` to change scope)
and prints the bash duration distribution, the foreground wall time it cost, the sleep-polling share, and
how many calls the shipped nudge would have flagged. Use it to compare a change instead of trusting the
anecdote in a review doc.

## Container QA

Run the plugin inside a clean container against the local model endpoint:

```sh
cd test/docker
make run     # start container + drop into pi (default: workbuddy/hy4-preview-ioa)
make smoke   # L1 model reachable -> L2 tools advertised -> L3 a tool really runs
make qa-up && make qa-tui SCENARIO=s1   # deterministic TUI scenario
```

`make run` reuses an already-running container, so it never tears down your session.

The container QA setup itself lives in `test/docker/` (not shipped in the npm
package). See its README in the repository for the two containers, the required
mounts, and why L3 must not be skipped.

## Known upstream issue (print mode)

`pi --print` + background task completing **after** the agent settles: the wake happens but the woken
run's `turn_end` boundary fails with `Extension error (<boundary>): turn_end could not resolve the persisted assistant entry ID` (pi 1.2.0 core, reproduced identically with pi-background-tasks —
upstream issue https://github.com/earendil-works/pi/issues/11001). **RPC mode (legion subagents) and
turn-internal waits are unaffected.**
