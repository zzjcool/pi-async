# pi-async

Pi extension for running shell commands asynchronously with bounded output capture, completion notifications, and a task panel.

## Install

Install the package from a local path with Pi's package manager:

```text
pi install /path/to/pi-async
```

For development, load the extension directly (for example from this checkout):

```sh
pi -e ./extensions/index.ts
```

The extension uses the Pi host's project working directory to store task metadata and captured output in `.pi/async/<session-id>-<pid>/`.

## Tools and commands

The extension registers five tools:

| Tool | Purpose |
|---|---|
| `async_run` | Start a background, delayed, or synchronous shell command. |
| `async_wait` | Wait for task completion or return a `notReady` result on timeout. |
| `async_logs` | Read bounded, ANSI-stripped captured output. |
| `async_status` | List tasks and their current state. |
| `async_kill` | Terminate a task and its process group. |

| Command / key | Action |
|---|---|
| `/async` | Open the task panel. |
| `/async-clear` | Clear completed-task history badges. |
| `Ctrl+Alt+A` | Open the task panel (when the host allows the shortcut; `/async` remains available as fallback). |
| `↑` / `↓` / `j` / `k` | Select tasks; in task details, scroll output. |
| `Enter` | Open selected task details. |
| `h` | Toggle history in the task list. |
| `k` | Kill a running task (press again to confirm). |
| `R` | Rerun the selected task command. |
| `c` | Copy the captured output file path. |
| `Esc` / `q` | Return from details / close the panel. |

The panel and rail are only enabled in the main Pi TUI session; RPC, print, and child contexts retain the tool surface without TUI entrypoints.

## Configuration

| Environment variable | Default | Description |
|---|---:|---|
| `PI_ASYNC_MAX_OUTPUT_BYTES` | `20971520` (20 MiB) | Maximum captured output per task; exceeding it terminates the task with `output_cap`. |
| `PI_ASYNC_MAX_TASKS` | `32` | Maximum concurrent running and pending tasks. |
| `PI_ASYNC_HEARTBEAT_MS` | `60000` | Settle-guard heartbeat interval in milliseconds. |
| `PI_ASYNC_DOCK_SHORTCUT` | `ctrl+alt+a` | Configured panel shortcut; the command remains available as fallback. |

## Legion child sessions

In a legion child session, collect task results with `async_wait` before returning a verdict. The settle guard reminds the agent about uncollected tasks, but the completion notification may not be delivered across turns until the upstream busy-hold contract lands. See [CONTRACT.md §6](docs/CONTRACT.md#6-唤醒链路与-legion-兼容冻结) for the frozen notification and collection requirements.

## Known limitations

- Crash-durability is not guaranteed: metadata is atomically replaced, but captured output is not fsynced. After a crash, orphaned tasks and delayed tasks are not automatically restored; recovery is limited to `/reload` in the same running process.
- Busy-hold behavior depends on upstream pi-legion issue [#156](https://github.com/zzjcool/pi-legion/issues/156); the extension does not patch Pi or legion.
- TUI rail and panel are available only in the main TUI session, not in RPC/print/child contexts.
- `pi --print` notification delivery requires an available configured provider. If no provider is available, end-to-end print-mode verification remains pending a user run.

## Development checks

```sh
npm run typecheck
npm test
```
