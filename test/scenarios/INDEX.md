# 场景索引

72 个可独立运行的场景（json + keys 配对）。`make qa-tui SCENARIO=sN` 运行，
由 `tools/run-scenario.sh` 按 id 通配发现 json —— 文件名不统一，不要拼名字。

归档在 `.attic/` 的 30 个不配对场景不在此表（见 `.attic/README.md`）。

| id | json | turns | 任务数 | 用到的工具 | 按键首行 | 快照标签 |
| --- | --- | --- | --- | --- | --- | --- |
| s1 | `s1-single-task.json` | 2 | 1 | `async_run` | start a background task for me | running,settled |
| s10 | `s10-cjk-width.json` | 3 | 1 | `async_run` | start a task with a very long chinese name | cjk-name |
| s100 | `s100-multi-nav.json` | 3 | 5 | `async_run` | start five long tasks, visit each detail, sc | list-five,detail-1,detail-2,after-copy |
| s104 | `s104-status-default.json` | 5 | 1 | `async_run,async_status` | run a task then check status with no argument | status-default |
| s105 | `s105-rail-overflow.json` | 3 | 14 | `async_run` | start 14 long tasks | rail-10-of-14,expanded |
| s106 | `s106-batch-overflow.json` | 3 | 40 | `async_run` | try to start 40 tasks at once | batch-overflow |
| s11 | `s11-cjk-narrow.json` | 3 | 1 | `async_run` | start it | narrow-rail |
| s12 | `s12-panel.json` | 3 | 3 | `async_run` | start three tasks | rail,panel-open,panel-ctrl-o |
| s14 | `s14-delayed.json` | 3 | 1 | `async_run` | schedule a delayed task | pending-state,still-pending,after-fire |
| s15 | `s15-pending-vs-running.json` | 3 | 2 | `async_run` | start one running and one delayed task | mixed-state,expanded |
| s2 | `s2-concurrent.json` | 3 | 3 | `async_run` | start three long background tasks | three-running,still-running,stability,tools-expanded |
| s24 | `s24-sync-promote.json` | 3 | 1 | `async_run` | run a slow command synchronously with prompt | after-sync-promote,rail-check |
| s25 | `s25-sync-abort.json` | 3 | 1 | `async_run` | run a slow command with abort on timeout | after-abort,rail-after-abort |
| s27 | `s27-output-cap.json` | 3 | 1 | `async_run` | run a task that floods stdout | during-flood,after-cap |
| s28 | `s28-output-inject.json` | 3 | 1 | `async_run` | run the output injection test | panel-detail-inject |
| s29 | `s29-delayed-cancel.json` | 3 | 1 | `async_run` | schedule a delayed task | list-with-pending,pending-detail,after-cancel |
| s3 | `s3-completed-elapsed.json` | 3 | 1 | `async_run` | start a quick background task | running,just-completed,25s-after-completion |
| s30 | `s30-long-name.json` | 3 | 2 | `async_run` | start two tasks with long names | long-names |
| s31 | `s31-jsonpath.json` | 3 | 1 | `async_run` | run a command that emits json later, watch f | json-watch-result |
| s32 | `s32-failwatch.json` | 3 | 1 | `async_run` | run a task and watch for a failure string | failure-watch-result |
| s33 | `s33-blind.json` | 3 | 1 | `async_run` | run a blind watch test | blind-result |
| s34 | `s34-fast.json` | 3 | 1 | `async_run` | run a quick task | task-visible,linger-period,after-linger-default-30s |
| s36 | `s36-chatter.json` | 3 | 1 | `async_run` | run a task that prints many lines slowly | detail-following,after-up-scroll,scrolled-more |
| s37 | `s37-tasktimeout.json` | 3 | 1 | `async_run` | run a task with a short task timeout | after-task-timeout |
| s38 | `s38-maxtasks.json` | 3 | 4 | `async_run` | try to start four tasks | maxtasks-error |
| s4 | `s4-kill.json` | 5 | 1 | `async_kill,async_run` | start a very long task | started-running,still-running,after-kill,kill-settled |
| s43 | `s43-runonly.json` | 3 | 1 | `async_run` | start a long task | before,after-reload |
| s47 | `s47-cjk-output.json` | 3 | 1 | `async_run` | run a task printing chinese output | cjk-output-detail |
| s48 | `s48-watch-timeout.json` | 3 | 1 | `async_run` | run a watch that will time out | watch-running,watch-timeout-fired |
| s5 | `s5-ctrl-inject.json` | 3 | 1 | `async_run` | start a long task with a control-character n | rail-after-inject |
| s50 | `s50-nonotify.json` | 3 | 1 | `async_run` | run a task without completion notification | no-notification-expected |
| s52 | `s52-dupename.json` | 3 | 4 | `async_run` | start three tasks with the same name and one | dupe-names,panel-dupes |
| s54 | `s54-emptyout.json` | 3 | 2 | `async_run` | run a silent task and a multiline one | detail-nooutput,detail-multiline |
| s55 | `s55-simultaneous.json` | 5 | 3 | `async_run` | start three tasks that finish together | after-all-complete |
| s57 | `s57-wait.json` | 4 | 1 | `async_run,async_wait` | start a task and then wait for it | during-wait,after-wait |
| s58 | `s58-status.json` | 5 | 2 | `async_run,async_status` | run two quick tasks | after-tasks,after-status |
| s6 | `s6-stderr-stdout.json` | 3 | 1 | `async_run` | run a task that writes to stdout but watch s | watch-result |
| s61 | `s61-logs.json` | 9 | 1 | `async_logs,async_run` | run a task with big output, then read logs w | logs-read |
| s63 | `s63-logs.json` | 10 | 1 | `async_logs,async_run` | run a task with medium output then read logs | logs-done |
| s64 | `s64-big1.json` | 8 | 1 | `async_run` | run a task with 1.3MB output | twenty-seconds-later,forty-seconds-later |
| s65 | `s65-exactcap.json` | 6 | 1 | `async_run` | run a task emitting exactly 20MiB | exact-cap-result |
| s67 | `s67-two-watches.json` | 5 | 2 | `async_run` | run two tasks each with its own watch | both-watches-fired |
| s68 | `s68-rawc0-out.json` | 4 | 1 | `async_run` | run a task whose output contains raw control | panel-raw-c0 |
| s69 | `s69-rail-rawc0.json` | 3 | 1 | `async_run` | start a task with a raw BEL in its name | rail-raw-c0-name |
| s7 | `s7-stdout-stderr.json` | 3 | 1 | `async_run` | run a task that writes to stderr but watch s | watch-result |
| s70 | `s70-osc-name.json` | 3 | 1 | `async_run` | start a task whose name contains an OSC 8 hy | panel-osc-name,rail-osc-name |
| s71 | `s71-sync-cjk.json` | 3 | 1 | `async_run` | run a sync command with lots of chinese outp | sync-cjk-result |
| s72 | `s72-derivename.json` | 3 | 1 | `async_run` | run a task without a name, whose command sta | derived-name-in-rail |
| s73 | `s73-refresh.json` | 4 | 1 | `async_run` | start a task that finishes in a few seconds | panel-open-task-running,panel-open-task-completed |
| s74 | `s74-inline-cjk.json` | 3 | 1 | `async_run` | run a task that prints a long chinese line t | rail-inline-cjk |
| s75 | `s75-list-output.json` | 3 | 1 | `async_run` | run a task with a long output line then wait | list-with-output |
| s76 | `s76-reload-delayed.json` | 5 | 1 | `async_run` | schedule a delayed task 30 seconds out | pending-before-reload,after-reload,after-delay-elapsed |
| s79 | `s79-oneline.json` | 3 | 1 | `async_run` | run a task with one very long output line | detail-oneline |
| s8 | `s8-mixed-outcomes.json` | 5 | 3 | `async_kill,async_run` | run three tasks: one ok, one failing, one lo | three-started,outcomes-settling,after-kill,final-state |
| s80 | `s80-detail-live.json` | 4 | 1 | `async_run` | start a quick task | detail-while-running,detail-after-complete |
| s81 | `s81-resize.json` | 3 | 3 | `async_run` | start three long tasks | before-resize |
| s83 | `s83-manylist.json` | 3 | 14 | `async_run` | start 14 long tasks | list-top,after-10-downs |
| s86 | `s86-wait-notify.json` | 3 | 1 | `async_run,async_wait` | start a task and immediately wait for it | after-wait |
| s87 | `s87-badtool.json` | 3 | 0 | `async_nonexistent` | call a tool that does not exist | after-badtool |
| s88 | `s88-devicecode.json` | 3 | 1 | `async_run` | run a task that prints a device code then wa | device-code-in-list |
| s89 | `s89-sync-watch.json` | 3 | 1 | `async_run` | try sync mode with a watch | sync-watch-rejected |
| s9 | `s9-twelve.json` | 3 | 12 | `async_run` | start twelve long background tasks | twelve-running,expanded |
| s90 | `s90-missing-required.json` | 3 | 2 | `async_run` | try sync without timeoutMs and delayed with | missing-required |
| s91 | `s91-receipt-modes.json` | 3 | 3 | `async_run` | start three tasks in three modes | receipt-modes |
| s92 | `s92-status-real.json` | 3 | 1 | `async_run,async_status` | run a task then check status | status-real |
| s93 | `s93-wait-real.json` | 5 | 1 | `async_run,async_wait` | run a task then wait for it | wait-real |
| s94 | `s94-logs-kill-real.json` | 7 | 1 | `async_kill,async_logs,async_run` | run, log, then kill a task | logs-kill-real |
| s95 | `s95-fail-notify.json` | 4 | 1 | `async_run` | run a failing task | fail-notify |
| s96 | `s96-c0-notify.json` | 4 | 1 | `async_run` | run a task whose output contains control byte | c0-notify |
| s97 | `s97-sync-blocking.json` | 3 | 1 | `async_run` | run a 5 second sync command | during-sync,still-during,after-sync |
| s98 | `s98-notify-combo.json` | 4 | 2 | `async_run` | run tasks with notification options off | notify-combo |
| s99 | `s99-simultaneous-notify.json` | 5 | 3 | `async_run` | run three tasks that finish at the same time | simultaneous-notify |

合计 72 个场景。
