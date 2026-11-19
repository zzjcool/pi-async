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

pi-async is **POSIX-only**: every task runs through `/bin/sh -c` in its own process group, and liveness
checks read `/proc` where the kernel provides it. Linux and macOS are the supported platforms — Linux is
what CI exercises; macOS uses the same POSIX paths, with the `/proc` probe degrading to `kill(-pid, 0)`.
**Windows is not supported or tested.**

## Tools and commands

The extension registers five tools by default (plus one opt-in tool):

| Tool | Purpose |
|---|---|
| `async_run` | Start a background or delayed shell command. |
| `async_logs` | Read bounded, ANSI-stripped captured output (`merged` / `stdout` / `stderr`). |
| `async_status` | List tasks and their current state. |
| `async_extend` | Renew a running task: move its reminder and/or hard-timeout deadline. Never kills. |
| `async_kill` | Terminate a task and its process group. |
| `async_wait` *(opt-in)* | Wait for task completion or return a `notReady` result on timeout. Registered only when the host sets `PI_ASYNC_EXPOSE_WAIT=1`. |

`async_logs`, `async_extend`, `async_kill` (and `async_wait` where it is exposed) accept a task **name** as
well as a task id. Ambiguous names are rejected with the candidate ids listed; unknown ids/names are an
error instead of a silent success. `async_status` is the read-only exception: its `name` argument is a
case-insensitive substring filter over the list (see [Notifications](#notifications)).

`async_wait` is not registered by default: a completion notification wakes the session, so the blocking
collect step is opt-in. If a stale registration is still called while the switch is off, it answers
`available: false` with the reason and the enabling variable instead of throwing.

A wait belongs to the **current extension generation**. `/reload` retires it: the registry drops its
waiters, so an in-flight `async_wait` finishes at its own `timeoutMs` with `notReady` — not a failure,
and it never kills the task. Waiters are not shared across processes; a task's result still lives in
`<taskId>.json` and its output file, so `async_status` / `async_logs` can read it after the reload.
(Contract: [`docs/CONTRACT.md` §5](docs/CONTRACT.md#5-async_wait唤醒原语冻结).)

### How the model finds these tools

Every registered tool carries a one-line `promptSnippet`, so the host lists all of them in the system
prompt's tools section — `async_run` is not the only entry point the model can see.

`async_run` additionally ships four `promptGuidelines` in the system prompt: when to reach for it instead
of `bash`, that ending a turn with running tasks is expected (the completion notification wakes the
session), that `name` + `async_logs` beat re-running a command, and that independent long commands should
be launched together in one batch and collected in a single pass. While `async_wait` is not exposed, a
fifth guideline says so and points at `async_logs` instead.

The procedural detail — when **not** to use async at all, how to plan a batch of independent long
commands up front, check-writing discipline, watch semantics, legion collection —
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

- `async_run`: `mode` is `background` (default) or `delayed` (requires `delayMs`; `delayMs` is rejected on any other mode). There is no blocking run: the call returns a receipt (`taskId` / `name` / `status` / `mode` / `outputHint`), the command keeps running, and the result is read later with `async_logs` or delivered by the completion notification.
- `async_status`: defaults to active (running/pending) tasks. `includeHistory: true` lists up to `limit` (1–50, default 50) tasks sorted newest first; an explicit `status` also sorts newest first. `status` and `name` (case-insensitive substring) filter the list. `delayedEnv` values are masked as `"***"`. Snapshots expose `notified`, `outputConsumed`, `notifyAttempts`, `cwd`, `timeoutAt`, and `watchDeadline`. A delayed task that fails to start (missing `cwd`, rejected `env` key, spawn error) is finalized as `failed` (exit 1) and records the cause in `metadata.startError`.
- `async_logs`: `stream` selects the merged capture or a single stream; `maxBytes` is capped at 50 KiB. A missing output file returns `missing: true` instead of throwing; paths outside the data directory are refused.
- `async_kill`: returns `killKind`, `alreadyTerminal`, `processAlive` and, when the kill could not be confirmed, `warning`.

| Command / key | Action |
|---|---|
| `/async` | Open the task panel. The panel is a singleton: running it again while open only shows an `Async panel is already open` notice and does not stack another overlay — the open panel refreshes itself from registry events plus a 1 Hz ticker, so a running task's output is live while you watch it. |
| `/async-clear` | Clear completed-task history badges. |
| `↑` / `↓` / `j` / `k` | Select tasks in the list. In task details the same keys scroll the body one line and leave the selected task alone (new output does not move a view you scrolled up). |
| `PageUp` / `PageDown` | Task details only: scroll one viewport (one page = one window). |
| `[` / `]` | Task details only: previous / next task without going back to the list. |
| `Enter` | Open selected task details: the name/status lines and the key hints stay fixed, and everything between them scrolls — command, metadata and the whole output tail. When the height cannot hold the command/metadata block *and* 8 output rows, the block collapses into a `… (+K lines)` marker that scrolling reads back. The output section is labelled `output (live):` while the task still runs. |
| `h` | Toggle history in the task list. |
| `x` (or `K`) | Kill a running task (press again to confirm). |
| `R` | Rerun the selected task command in that task's original `cwd`. It does **not** reproduce the original environment, `watch`, or timeout: only `command` / `name` / `mode` / `cwd` carry over, and the child gets the current `PI_ASYNC_ENV_INHERIT` environment. |
| `c` | **Show** the captured output file path as a toast. Nothing is copied: pi exposes no clipboard API, so there is no copy action. |
| `Esc` | Close rail-clicked details; return from list-opened details to the list. |
| `q` | Close the panel. |

The rail's first row summarizes running, pending, elapsed, completed, and failed/killed task counts; pending and failed/killed counts are shown only when nonzero. The rail is not filtered by mode: background and delayed runs both appear there and count as running until they end. **Mouse support (wheel, click) exists only in fullscreen / alt-screen TUI mode** — pi only enables mouse reporting there; in regular mode use `/async` and the keyboard. The panel and rail are only enabled in the main Pi TUI session; RPC, print, and child contexts retain the tool surface without TUI entrypoints.

## Configuration

| Environment variable | Default | Description |
|---|---:|---|
| `PI_ASYNC_MAX_OUTPUT_BYTES` | `20971520` (20 MiB) | Maximum captured output per task; exceeding it terminates the task with `output_cap`. |
| `PI_ASYNC_MAX_TASKS` | `32` | Maximum concurrent running and pending tasks. |
| `PI_ASYNC_EXPOSE_WAIT` | `off` | Set `1` to also register `async_wait` (the blocking collect tool). Unset, the tool surface is the default five and completion notifications do the waking. |
| `PI_ASYNC_ENV_INHERIT` | `safe` | Child env policy: `safe` strips credential-like variables and rejects dangerous explicit keys; `all` restores full inheritance (explicit dangerous-key overrides are still rejected in every policy); `none` passes only a minimal allowlist (`PATH`, `HOME`, `SHELL`, `TERM`, `LANG`, `LC_*`, `TMPDIR`, `USER`). |
| `PI_ASYNC_SETTLE_GUARD` | `on` | Set `0` to disable the settle guard entirely (no `agent_before_settle` reminder, no `agent_settled` backstop). |
| `PI_ASYNC_NUDGE` | `on` | Set `0` to disable the runtime context nudges (the long-command hint and the `<async-state>` line). |
| `PI_ASYNC_HOLD` | `on` | Set `0` to disable the settle hold entirely (no `agent_before_settle` handler is registered). |
| `PI_ASYNC_HOLD_MS` | `600000` (10 min) | Upper bound for one settle hold; `≤ 0` disables the feature (a negative value is not replaced by the default, and non-integer values fall back to the default). |
| `PI_ASYNC_HOLD_POLL_MS` | `1000` | How often the task list is re-read while the run is being held. |
| `PI_ASYNC_PRINT_WAIT` | `on` | Set `0` to disable the headless (`pi -p`) backstop entirely (the process may exit while tasks still run — the 0.4.x behaviour). |
| `PI_ASYNC_PRINT_WAIT_MS` | `600000` (10 min) | Overall budget for the headless wait: wall clock from the first real wait, accumulated across turns and continuation requests (time spent in provider requests counts). |
| `PI_ASYNC_PRINT_POLL_MS` | `500` | How often the task list is re-read while a print run waits; a value below 50 falls back to the default (it is not clamped). |
| `PI_ASYNC_PRINT_MAX_CONTINUATIONS` | `5` | Forced provider requests the headless backstop may spend before it reports the still-running tasks and exits non-zero. `0` means "never wait-and-continue": first boundary with a running task already throttles. |
| `PI_ASYNC_FOOTER` | `off` | Set `1` to also render a one-line task summary through the host's `setStatus` footer (only when the host exposes `setStatus`). The rail's first row is the default status surface. |
| `PI_ASYNC_RETENTION_MS` | `604800000` (7 days) | How long terminal-task artifacts are retained; union with `RETENTION_COUNT`. |
| `PI_ASYNC_RETENTION_COUNT` | `100` | Max newest terminal tasks kept per dataDir; union with `RETENTION_MS`. |
| `PI_ASYNC_SWEEP_SIBLINGS` | `off` | Set `1` to reclaim idle sibling session directories under the parent of the data directory (three gates; see [Data directory](#data-directory)). |
| `PI_ASYNC_SWEEP_SIBLING_AGE_MS` | `1209600000` (14 days) | Idle time a sibling directory needs before it may be reclaimed; clamped to stay strictly above `PI_ASYNC_RETENTION_MS`. |
| `PI_ASYNC_SWEEP_INTERVAL_MS` | `60000` | Throttle for the `configure()`-driven storage pass; `0` runs it on every configure. |
| `PI_ASYNC_TOTAL_BYTES` | `0` (off) | Global quota in **bytes** for `.json`/`.output`/`.stdout`/`.stderr` across all data directories under the parent; `0` means unlimited. |
| `PI_ASYNC_QUOTA_HARD` | `off` | Set `1` to also evict results the retention window still keeps when the quota cannot be met otherwise (each eviction is logged first). |
| `PI_ASYNC_RAIL_LINGER_MS` | `30000` | How long completed/failed/killed tasks stay on the rail before disappearing. |

Under the default `safe` policy, inherited variables matching `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIAL*`, plus `AWS_SECRET_ACCESS_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SESSION_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, and `NPM_TOKEN` are removed. `npm_config_*` keys whose name contains `auth`, `token`, or `password` (for example `npm_config__authToken`, which npm reads as a credential) are removed as well, so npm credentials exported by the parent shell do not leak into tasks; ordinary npm settings such as `npm_config_registry` still pass through. Passing a dangerous key explicitly through `env` (`PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `NODE_OPTIONS`, `BASH_ENV`, `ENV`, `SHELLOPTS`, `PYTHONPATH`, `GIT_SSH_COMMAND`) throws instead of being silently ignored — **under every policy, including `all`**; the safety rule cannot be switched off. Ordinary keys may still be overridden.

For delayed tasks the submitted `env` is persisted to `<taskId>.json` (mode `0600`) so the task can still start after `/reload`; the tool surface and the panel render its **values masked as `"***"`** (keys survive).

## Notifications

Completion notifications are **best-effort**. `pi.sendMessage` returns `void` — the host is fire-and-forget and gives no acknowledgement, so pi-async sends once, never retries, and never rolls back. A "queued" notification means it was handed to the host, not that the model read it.

- `notified` becomes true only after `sendMessage` returns; a failure or a missing host API leaves `notified: false` and increments `notifyAttempts`.
- On `session_start`, pi-async **resends** terminal tasks that are still unnotified and unconsumed (within 24 h and under 2 attempts), so a missed wake-up is retried once per session start.
- `async_wait` results (where the tool is exposed) are marked consumed (`outputConsumed`), which **suppresses** the completion notification for those tasks to avoid chatter. On a hybrid timeout only the completed side is consumed; not-ready tasks are left alone.
- **One terminal event is told once, to exactly one consumer** (CONTRACT §7.2). `async_wait` (terminal rows), `async_status` (terminal rows it returns) and `async_logs` (a task that already finished) latch `consumedAt` on the task; a consumed task never produces a completion notification — `claimNotification` and `resendUnnotified` both skip it. Only **terminal** rows latch: reading the partial output of a running task, or listing it as `running`, leaves its notification armed.
- While a run is live, the notification is **not queued at `finalize()`**: the send is decided at the run's next **turn boundary**, after every consumer had its chance. That is what stops the "late receipt" — in 0.4.2 a task collected with `async_wait` mid-run still produced a `async-task-notification` 85–138 s later, because pi only enqueues a streaming followUp and delivers it once the model stops. If nobody consumed the result, the notification is still delivered exactly once at that boundary; when the session is idle it is sent immediately and wakes the session as before.
- **The delivery channel follows the run state** (0.4.4). A live run gets `deliverAs: "steer"`, which the host drains at *every* turn boundary; `followUp` is drained only when the model stops asking for tool calls, so a busy parent used to push the notification to the end of the whole run (measured: `finishedAt` 04:15:24.745 → injected 04:18:23.383, **+178.6 s**). An idle session keeps `followUp` + `triggerTurn: true`, which starts the wake-up run immediately. One terminal event is still enqueued at most once, no matter how many boundaries pass.
- `async_status` exposes `notified` / `outputConsumed` / `consumedAt` / `notifyAttempts`, so an agent can check whether it already received (or suppressed) a result.
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
  clock) and one hold per run (`agent_start` re-arms it). It never probes the host's message queue for
  *notifications* (those land on `agent.followUpQueue`, invisible to `ctx.hasPendingMessages()`), but
  it does yield to the **user**: a lone Esc or a message you queued ends the hold immediately, and the
  run settles exactly as it would have without it — nothing is consumed, killed, or suppressed.
- **The user can always get out.** pi awaits `agent_before_settle` with no timeout and cannot preempt
  it, and the run's `AbortSignal` is already gone at this boundary — so Esc is observed through the
  raw terminal listener (`onTerminalInput`, lone `\x1b` only; arrow/Alt sequences are left alone)
  and releases the hold in milliseconds instead of waiting for the budget. A message submitted while
  the hold waits (Enter queues it as steering) releases it on the next poll (~1 s), so the host can
  deliver your message on the next turn. Programmatic aborts that do not type Esc (an extension
  calling `ctx.abort()`, `/tree` navigation) still cannot preempt the handler; see Known limitations.
- **It visibly moves.** pi clears its own working row at `agent_end`, i.e. before this boundary, so a
  hold would otherwise look like a frozen screen. While it waits, the **rail's first row** becomes the
  wait — a spinning `⠋⠙⠹…` frame every 250 ms, how long **this turn has been held**, and
  `Esc stops waiting` — and it hands row 0 back to the summary row in a `finally`. 0.4.8 removed the
  separate line the plugin used to paint above the editor: the two said the same thing in one terminal
  (0.4.4–0.4.7). The per-task detail (`name · status · elapsed`) is the rail's own task rows: repeating
  it in the waiting row made one terminal say the same thing three times (0.4.5). "The detail is on
  screen" is decided from what the rail **paints right now**, not from "a rail was registered
  earlier": the names are dropped only while the mounted rail lists every task the hold waits for. A
  host without `setWidget`, a rail the host dropped, and a rail whose window does not cover those
  tasks all fall back to a hold-owned line that names them itself (`name (status, elapsed)`,
  `+N more`) — the rail is re-installed on the next frame, so the two surfaces never go dark
  together, and exactly one waiting line is on screen either way (0.4.7/0.4.8). The footer line
  `waiting for N tasks <elapsed>` (15 s cadence) is still written when the host exposes `setStatus`,
  but it is no longer the only sign of life.
- When every task in the snapshot finished, the boundary returns one
  `async-task-settle-results` draft (name, status, exit code — **never** the output tail, use
  `async_logs`) plus `continue: true`, so the outcome reaches the transcript even if the wake-up was
  dropped. That cannot loop: the next boundary sees only terminal tasks and returns nothing.
- **One terminal event, one announcement.** While the hold waits, it owns the completion of the
  tasks in its snapshot: their `async-task-notification` is not sent, the results draft is the
  single announcement, and those ids are latched `notified` so `resendUnnotified` cannot repeat it
  on the next `session_start`. This matters because pi only *queues* a `followUp` while the run is
  streaming and delivers it once the model stops — so in 0.4.2 the draft arrived first and the
  notification a whole turn later, repeating an outcome the model had already acted on. Every hold
  exit that does **not** produce a draft (timeout, dispose, a throwing registry) releases the
  notifications instead, so nothing is ever swallowed.
- The draft names each finished task by `name` (falling back to the task id), which is exactly what
  `async_logs` accepts, and still points at `async_logs` rather than inlining a tail.
- Only an interactive TUI session holds. A `print` session is served by a different mechanism — the
  headless backstop below deliberately keeps the process alive until running tasks finish — and `rpc`
  aborts under a client-side timeout, so neither of them may also hold. Legion child sessions keep
  their own bounded reminder channel. None of the three is affected by the hold.
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

Pressing Esc during a hold releases it within milliseconds: the raw terminal listener sees the lone
`\x1b`, the hold returns immediately, and pi then settles the aborted run (it suppresses the
continuation itself, so no extra provider request runs). Because the hold owns the terminal event, it
queues no notification for a task that finishes inside the wait, so an aborted run has nothing for
the host's `clearAllQueues()` to drop. A task that finishes after the Esc is not affected: its
notification is delivered normally and still wakes the session. If you had already queued text when
you pressed Esc, the host moves it back into the editor (`restoreQueuedMessagesToEditor`), so nothing
you typed is lost.

## Headless (`pi -p`) — the process waits for the work

A print run is one prompt in, one answer out, then `process.exit`. Nothing in the host keeps that
process alive while a background task still runs, so pi-async does it structurally (0.5.0):

- When the run reaches the settle boundary in a **print** session with `running` tasks, the extension
  keeps the boundary open until they all finish (polled, no TUI). It then commits one
  `async-task-print-results` entry (name/status/exit only — never an output tail) and returns
  `continue: true`, so the host issues one more provider request. The model gets a real turn to read
  the result and **its answer is what `pi -p` prints** — not an empty stdout after an early exit.
- The wait reuses the completion-notification ownership relay, so a task finishing inside it is
  announced exactly once (the results entry) and `notified` is latched; nothing is lost or doubled.
- It is bounded twice: `PI_ASYNC_PRINT_MAX_CONTINUATIONS` forced turns (default 5) and one overall
  `PI_ASYNC_PRINT_WAIT_MS` wall-clock budget (default 10 min, accumulated from the first real wait —
  provider time between turns counts, so a long run may report a *newly* started task immediately
  instead of waiting for it; that is the intentional whole-process bound). Over budget the run is allowed to end, but not
  silently: stderr gets `pi-async: still running N async task(s) after C continuation(s) and Ts: <id>
  (<name>), …` naming every taskId, and the process exits with code 1.
- Only `running` tasks block the exit. A `mode: delayed` task sits in `pending` by definition (its
  `dueAt` may be an hour away), so it is scheduled work, not in-flight work — it survives on disk for
  the next session instead of burning the budget.
- `agent_before_settle` in print mode has no host timeout and Esc does not reach it; the two bounds
  above are what make that safe. `PI_ASYNC_PRINT_WAIT=0` disables the whole backstop (0.4.x behaviour).

The real-process proof lives in the repository: `scripts/headless-smoke.sh wait` starts a task that
outlives the model's turn and asserts the conclusion is what stdout carries; `cap` asserts the
non-zero exit plus the taskId line; `off` reproduces the pre-0.5.0 early exit.

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

Each task writes `<taskId>.json` (atomically replaced metadata) plus `<taskId>.output` and its `.stdout` / `.stderr` sidecars. Files are created with mode `0600`. The data directory also carries a `.pi-async-owner` marker (`{pid, at}`, mode `0600`): it is how the opt-in cleanup below tells an abandoned session directory from one whose process is alive but idle. The marker is not a task artifact — it is never counted against the byte quota, never parsed as a snapshot, and not migrated.

Do **not** point the data directory at a git-tracked path: captured output can contain credentials, tokens, or other secrets a command printed. Terminal-task artifacts are pruned by `PI_ASYNC_RETENTION_MS` ∪ `PI_ASYNC_RETENTION_COUNT`; non-terminal tasks are never pruned **directly** — orphan detection (`configure()` → `reapOrphans()`) first marks `running` tasks whose pid is gone as `failed` (`failureKind: "lost"`) at startup, and marks pending delayed tasks as `lost` when their due time is older than **`PI_ASYNC_RETENTION_MS`** (the count setting does not apply to them). Pending delayed tasks still inside that window are restored with their remaining delay.

If the resolved data directory changes inside a live process, artifacts are copied to the new location; if migration fails, pi-async logs the error and keeps the old directory so no task is lost.

### Reclaiming old session directories and capping disk use (#102)

Both switches below are **off by default**; with them unset nothing new runs (no `stat`, no `readdir`). They are irreversible when they fire: deleted artifacts are gone, and turning the switch off only stops *further* cleanup.

- `PI_ASYNC_SWEEP_SIBLINGS=1` — on `configure()` (throttled by `PI_ASYNC_SWEEP_INTERVAL_MS`, default 60 s) pi-async also looks at the **sibling** session directories under the parent of the data directory (`<session dir>/pi-async/`). A sibling is removed only when all three gates hold: it is not the live data directory (identity, not spelling — a symlink or a case-insensitive alias still counts as "current"), nobody is using it (no `running`/`pending` snapshot pointing at a live process, and no live owner marker), and it has been idle for `PI_ASYNC_SWEEP_SIBLING_AGE_MS` (default 14 days, never less than the retention window). Anything doubtful is kept: a directory holding files a data dir never writes, a snapshot that does not parse, an owner marker that cannot be read, or a symlink, is skipped with a reason in the report. The parent itself is never a target.
- `PI_ASYNC_TOTAL_BYTES=<bytes>` — a **global** byte quota over every data directory under that same parent, counting `.json`, `.output`, `.stdout` and `.stderr` (transient `*.tmp` residue is not counted). Exactly at the quota is fine; only `used > quota` triggers eviction, and the order is deterministic: unreferenced artifacts first, then terminal tasks the retention window would drop anyway (oldest `finishedAt ?? createdAt` first, task id as tie-break). `running`/`pending` artifacts are never evicted, and neither is anything inside a directory that currently owns a live task.

If the quota still cannot be met after those evictions the pass **stops and keeps your data**: it logs the shortfall and the report says `overQuota: true`. Set `PI_ASYNC_QUOTA_HARD=1` to also drop results the retention window still keeps (each deletion is logged before it happens). `registry.lastStorageCleanup()` returns the report of the last pass, and every removal is logged as one `pi-async: storage: …` line naming the target, the reason and the bytes.

## Legion child sessions

In a legion child session, collect task results before returning a verdict (`async_status` plus `async_logs`; `async_wait` too when `PI_ASYNC_EXPOSE_WAIT=1` exposes it). The settle guard pushes a reminder into the model context before settling (up to 3 times, `custom_message` draft, `continue: true`), and an aborted run with active tasks gets a follow-up reminder on `agent_settled`. In the main session the same boundary produces one **advisory** draft (no forced re-run) saying that stopping with background work is fine, because its completion notification will wake the session. Notifications themselves remain best-effort (see above); see [CONTRACT.md §6](docs/CONTRACT.md#6-唤醒链路与-legion-兼容冻结) for the frozen notification and collection requirements.

## Known limitations

- **POSIX only.** The runner hard-codes `/bin/sh -c`, detached process groups (negative-pid signals) and,
  where available, `/proc` for liveness. Linux and macOS are supported; **Windows is not supported or
  tested** (the Linux side of WSL is a Linux environment). CI has no Windows or macOS runner.
- Crash-durability is not guaranteed: metadata is atomically replaced, but captured output is not fsynced. After a crash, orphaned running tasks are marked `failed`/`lost` on the next start, and pending delayed tasks are restored with their remaining delay by whichever session next loads the same data directory (process identity does not matter). Recovery inside the same process is complete for `/reload` (`cwd`, `taskTimeoutMs` deadline, and watch deadline are rebuilt from disk).
- Cross-turn wake-up in legion children depends on the host delivering follow-up messages (upstream pi-legion issue [#156](https://github.com/zzjcool/pi-legion/issues/156)); the extension does not patch Pi or legion.
- The settle hold keeps the OSC 7501 status in `working` and renders its live wait as the rail's first
  row (spinner + elapsed + `Esc stops waiting`) because pi cleared the built-in working row at `agent_end`.
  Esc releases the hold through the raw terminal listener; a **programmatic** abort that produces no
  Esc keystroke (an extension calling `ctx.abort()`, `/tree` navigation → `await session.abort()`) still
  cannot preempt an awaiting `agent_before_settle` handler — pi's `AgentBeforeSettleEvent` carries no
  AbortSignal and `emitBoundary` does not race the handler (`runner.js:767-814`). Such a call waits up to
  `PI_ASYNC_HOLD_MS`; the hold still yields as soon as the user queues a message or the tasks finish.
  Input itself is never frozen — text submitted during a hold is queued as steering.
- Because a hold keeps the run busy, `waitForIdle()` waits for it too: a command that
  `await session.abort()` **without** an Esc keystroke waits up to `PI_ASYNC_HOLD_MS` while a hold is in
  progress (e.g. `/tree` navigation — `interactive-mode.js:4758` → `agent-session.js:1999`). Esc itself
  is a keystroke, so it reaches the hold first and releases it; `void abort()` stays non-blocking.
- TUI rail and panel are available only in the main TUI session, not in RPC/print/child contexts.
- In a print run a task that never finishes ends the process with a non-zero exit code and one stderr
  line naming the still-running taskIds (see [Headless](#headless-pi--p--the-process-waits-for-the-work)).
  The host still kills those process groups at shutdown, exactly as before.
- A `delayed` task is not waited for in print mode: it is pending, not in flight.

## Development checks

```sh
npm run typecheck
npm test
npm run verify           # typecheck + test (same gate as prepublishOnly)
npm run adoption         # adoption report from real session JSONL (last 15 sessions)
npm pack --dry-run
scripts/headless-smoke.sh wait   # real `pi -p` + scripted mock endpoint (also: cap, off)
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
turn-internal waits are unaffected.** It is still present on pi 1.5.2 for runs woken by a `followUp`
(visible on stderr with `PI_ASYNC_PRINT_WAIT=0`); the 0.5.0 headless backstop avoids that path because
it owns the terminal event and continues in-run.
