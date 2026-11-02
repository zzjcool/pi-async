# pi-async 冻结契约 v1

状态：**FROZEN**（2026-10-15；0.3.0 修订 2026-11-02：REV-13…REV-19） | 仓库：/root/code/pi-async | Node ≥ 22.19, pi ≥ 1.2.0（TUI）
修订规则：任何字段/语义变更必须走 REV 条目登记原因，worker 不得自行解释矛盾。

## 0. 定位与范围

pi-async 是 pi 的异步任务运行时扩展：任务注册表 + 三种任务模式（background / delayed / sync）+
完成唤醒 + 主会话 TUI（轨道图 + 百分比尺寸面板）。OSC 7501 busy 对齐（zzjcool/pi-legion#156）只保留
`ui.setActivity` feature-detect shim：官方 pi 1.2–1.5 都没有该 API，因此不构成能力承诺（见 §7）。

**刻意不做**（禁止 worker 越界）：
- 不做 delegate/attested/Fusion 子 agent（pi-background-tasks 已覆盖，我们只管 shell 任务）
- 不改 pi-legion / pi 本体（busy-hold 走上游 issue #156 + 补充评论，我们不 fork）
- 不做 SSH/remote 执行、不做 tmux/PTY attach（后续版本）
- 不做 MCP server 化

## 1. 目录与文件布局

```
pi-async/
├── package.json            # name: pi-async, type: module, keywords 含 pi-package/pi-extension
├── tsconfig.json
├── extensions/index.ts     # 唯一扩展入口（package.json "pi".extensions 指向）
├── src/
│   ├── core/
│   │   ├── registry.ts     # TaskRegistry：任务生命周期、终态、通知
│   │   ├── task.ts         # Task 类型、状态机、snapshot
│   │   ├── spawn.ts        # detached spawn + 进程组 kill 升级链
│   │   ├── output.ts       # 输出捕获、tail 读取、ANSI 剥离
│   │   ├── watch.ts        # 轮询 + 条件匹配引擎
│   │   ├── notify.ts       # 完成通知/唤醒、抑制闩（每任务一条，不合并）
│   │   └── bus.ts          # 预留 eventbus + OSC activity 上报
│   ├── tools/
│   │   └── index.ts        # 5 个工具的注册与 schema
│   ├── tui/
│   │   ├── rail.ts         # 任务轨道图 widget（≤4 行，含汇总行）
│   │   ├── panel.ts        # 百分比尺寸面板（列表+详情）
│   │   └── status.ts       # 汇总格式与共享 clear watermark 谓词；initStatus 仅 reportActivity
│   └── guard/
│       └── settle-guard.ts # agent_before_settle custom_message 提醒 + agent_settled 兜底（无心跳）
├── vendor/reference/       # 已就位（只读参考，不编译）
└── docs/
```

运行时数据（不进仓库）：`<session dir>/pi-async/<sessionId>/<task-id>.output` + `<task-id>.json`
（atomic write）+ `.stdout` / `.stderr` sidecar；无 sessionManager 时退回 `~/.pi/async/<pid>/`
（REV-17）。产物文件创建为 0600。

## 2. 任务状态机（冻结）

```
pending --(delay 到期/spawn 成功)--> running --┬-- exit 0 --> completed
                                             ├-- exit ≠0 --> failed
                                             ├-- timeout/output_cap --> failed (kind 标注)
                                             └-- kill --> killed
```

- 状态词汇：`pending | running | completed | failed | killed`；terminal = 后三者。
- KillKind：`user | timeout | output_cap | shutdown | watch_failure`（进程被主动杀掉的原因）。
- FailureKind：`lost | blind_exhausted | watch_timeout`（非「退出码失败」、需与 KillKind 并列区分的失败原因）。
  - `lost`：reload 发现 pid 已死（§10）。
  - `blind_exhausted`：watch blind_checks 耗尽。
  - `watch_timeout`：watch `timeoutMs` 到期。
- **双字段、不统一 reason（REV-11）**：KillKind 答「谁杀的/为何杀进程」；FailureKind 答「任务为何 failed」。
  禁止发明第三套 `reason` 枚举把两者揉扁——通知与投影字段各自透传已有字段即可。
- delayed 任务在 pending 期可 cancel（→ killed, kind=user）。
- 通知诚实语义（REV-14）：`notified` 持久闩（写进 metadata，reload 不重置）；**单次投递，不重试、
  不回滚**（宿主 `sendMessage` 无 ack）。发送前 `notifyAttempts++`，`sendMessage` 返回后置
  `notified=true`；失败保持 false。`session_start` 对未确认任务补发一次（24h 内、attempts<2、未被消费）。

## 3. 任务模式与启动参数（async_run 工具，冻结）

```ts
async_run({
  command: string,                    // 必填
  name?: string,                      // 展示名；缺省从 command 派生（≤48 chars）
  mode: "background" | "sync" | "delayed",   // 默认 background
  // ── delayed ──
  delayMs?: number,                   // mode=delayed 必填；pending 到期启动
  // ── sync ──
  timeoutMs: number,                  // mode=sync 必填（schema enforce）；
                                      // 上界 PI_ASYNC_MAX_SYNC_TIMEOUT_MS（默认 600000，schema maximum + 运行时校验）
                                      // 到点：onTimeout="promote" → 转 background 继续；
                                      // onTimeout="abort" → Esc 语义，等待中断任务保留
  onTimeout?: "promote" | "abort",    // 默认 promote
  // ── 通用 ──
  taskTimeoutMs?: number,             // 任务自身寿命；缺省 = 无限（watch 必填除外，见 §4）
  notifyOnCompletion?: boolean,       // 默认 true
  triggerOnCompletion?: boolean,      // 默认 true：完成 sendMessage({triggerTurn:true}) 唤醒
  env?: Record<string, string>,       // 追加到 spawn env
  watch?: WatchSpec,                  // 见 §4；模式仅 background/delayed
})
```

- **执行目录（REV-13）**：所有任务在 **session cwd**（`ctx.cwd`，工具 execute 第 5 参）执行，
  `TaskSnapshot.cwd` 持久化；delayed 任务保留提交时 cwd；reload 后按持久化 cwd 恢复。缺省回退
  `process.cwd()`。

**返回（receipt）**：`{ taskId, name, status, mode, outputHint }`；sync 模式返回
`{ ...receipt, exitCode?, outputTail, promoted }`。`promoted: true` = sync 等待超时且任务已转
background 继续跑（`status: "running"`）；`false` = 正常结束或 `abort` 超时。**sync 超时（promote/abort）
不是工具错误**（REV-19）：`isError` 只在任务真的以非 0 状态结束时为 true。所有任务**同步启动**：spawn 成功即返回 `running`；
spawn 失败立即抛错，无重试等待。admission 检查为 closed / `suspend()` 之后（错误文案
`Async task admission is closed (registry suspended)`）/ maxTasks / 空命令，均同步完成。
shutdown 先 drain 再退出。
（**REV-6 裁决**：原「≤30s admission 预检」从未实现且与同步 spawn 设计冲突，改为描述现状；见 #29。）

**工具集（5 个）**：`async_run` / `async_wait` / `async_logs` / `async_status` / `async_kill`。
命令面：`/async`（开面板）、`/async-clear`（清历史徽章）。

## 4. WatchSpec（照抄 better-bg 条件系统，冻结）

```ts
interface WatchSpec {
  intervalMs: number;                 // 默认 30_000，min 1_000
  timeoutMs: number;                  // watch 必填：watch 期限（schema enforce）
  success_when: Condition[];          // 任一命中 → 任务完成语义（不干预进程，见下）
  failure_when: Condition[];          // 任一命中 → kill(kind=watch_failure)
  blind_checks?: number;              // 默认 3：连续 N 次「检查基础设施失败」(readOutput 抛错等)
                                      // → failed；「尚未可判定」为 pending，不累计（见下方 REV-2）
}
type Condition =
  | { type: "exit_code"; equals: number }
  | { type: "stdout_contains"; value: string }
  | { type: "stderr_contains"; value: string }
  | { type: "json_path_exists"; path: string }        // 必须以 $ 开头，如 $.a.b[0]；启动前校验；tool schema 含 pattern/description（#12）
  | { type: "output_matches"; regex: string }         // 合并输出流匹配（设备码等）；编译带 m（^/$ 按行）
```

- `success_when` 命中 → **不杀进程**：任务标 completed，通知带命中详情；进程按 taskTimeoutMs/kill 自然管理。
  （区别于 better-bg 的 check 命令模式：我们 watch 的是**已存在任务**的输出/退出。）
- 条件在 async_run 时**启动前校验**，非法 regex/JSON path 直接拒绝（不产生 pending 任务）。
- **blind_checks 语义（REV-2 澄清）**：仅计「检查基础设施失败」（readOutput 抛错等）；
  「尚未可判定」（exit_code 未退出 / json_path 输出尚非 JSON）为 **pending 态，不累计 blind、照常
  继续轮询**。两者是不同语义，禁止合并。条件持续 pending 时**不**触发 blind 兜底，仅由
  `timeoutMs` 结束 watch（WatchSpec 字段注释已与本条对齐，见 #27）。
- **组内 OR**：`success_when` / `failure_when` 各自是 OR（首个命中即返回），没有 `match:"all"` 模式。
- **匹配窗口**：只匹配输出尾部 **64K 字符**（不是字节，常量 `MAX_MATCH_CHARS`）；更早的输出会滚出窗口。
- promptGuidelines（写进工具 description）：check 不要 `|| true` 自吞错误；未知态映射失败；
  结构化输出优先 jq -e；`output_matches` 的 regex 须加锚定防止过早匹配（编译固定带 `m`，
  `^`/`$` 按行边界，故 `^READY$` 可命中多行输出中的某一行）。
- **watch 失败性终态的进程处置（REV-4 裁决）**：`failure_when` 命中、blind 耗尽、watch timeout
  三条 watch 失败路径在 finalize 任务的同时**必须 kill 进程组**（与 `failure_when → killed(watch_failure)`
  同语义）；仅 `success_when`（D4）不干预进程。杀失败时响亮上报（kill 链已有 catch），
  绝不允许「终态任务 + 活进程」残留导致 async_kill 静默不杀或 shutdown 挂起。
  - **终态标注（REV-11）**：`failure_when` → `killed` + `killKind=watch_failure`；blind 耗尽 /
    watch timeout → `failed` + `killKind=watch_failure` + 对应 `failureKind`
    （`blind_exhausted` / `watch_timeout`）。三条都杀进程，用 status+failureKind 区分语义。
- **REV-10 裁决（#48）**：`output_matches` 以 `new RegExp(regex, "m")` 编译（validate 与求值同）。
  契约原先要求锚定（`^READY$`）防止过早匹配，但无 `m` 时 `^`/`$` 只锚整段输出，多行流上锚定
  永不相交。加 `m` 使锚定与意图一致；整段匹配请用不含 `^`/`$` 的模式或显式 `\A`/`\z` 等价写法。

## 5. async_wait（唤醒原语，冻结）

```ts
async_wait({ taskIds: string[], timeoutMs: number })   // timeoutMs 必填（schema enforce）；
// taskIds 元素可为 taskId 或 name（REV-15）；重名报错并列出候选 id，未知 id/name 报错
// 返回三态（REV-7）：
// → 全终态：{ results: Array<{taskId, status, exitCode?, outputTail}> }
// → 超时且无已完成：{ notReady: Array<{taskId, status: "running"|"pending", elapsedMs}> }（不杀任务）
// → 混合超时：{ results, notReady }（已完成走 waitResult/consume，抑制通知 chatter；未就绪不杀）
```

- 事件驱动：await 内部 waiter（任务 finalize 时 resolve），**禁止 sleep 轮询**（patty 教训）。
- 支持 AbortSignal（Esc）；中断等待不中断任务。
- 消费即抑制：async_wait 取回结果的任务，完成通知被 `outputConsumed` 闩抑制（防 chatter）。
- **REV-7 裁决（#43）**：原契约只写「全终态 → results」与「超时 → notReady」两极，导致混合超时
  路径丢弃已完成结果、且无法对已完成侧置 `outputConsumed`（通知抑制失效）。正式登记超集三态：
  判据仍是「有 notReady ⇒ 超时分支」；`results` 可选并存。实现见 #56，本 REV 只改契约。

## 6. 唤醒链路与 legion 兼容（冻结）

| 环境 | triggerOnCompletion 行为 |
|---|---|
| 主会话（TUI/RPC/print） | `pi.sendMessage({customType:"async-task-notification"}, {deliverAs:"followUp", triggerTurn:true})`；idle → 立即新 turn；busy → followUp 队列 |
| legion child，turn 内 | 同上 |
| legion child，跨 turn | **hold 模式**：settle 前守卫上报 busy（见 §7）；上游 #156 busy-hold 落地前，通知可能无法送达——**契约要求 agent 在 legion 环境用 async_wait 收割后再报 verdict**（守卫强制提醒，最多 3 次） |

- 环境检测：`PI_LEGION_NODE_ID` 存在 → legion child 环境，settle 守卫默认开启。
- 通知 XML：`<async-task-notification>` + task-id/name/status/exit-code/**kill-kind**/**failure-kind**/output-file/summary/**summary-truncated**/guidance
  （guidance 仅 failed 带，completed 纯信息——patty chatter 教训）。
  - `kill-kind` / `failure-kind`：有值才输出（与 snapshot 同名语义）；模型据此区分非零退出 / output_cap / watch 失败 / lost，无需先 round-trip `async_status`（#37）。
  - `summary-truncated`：summary 因 output_cap 或通知 tail 上限被截断时输出 `true`，避免把截断前缀误读为完整输出。
  - **失败原因矩阵（REV-11）**：

    | 原因 | status | killKind | failureKind | 通知要点 |
    |---|---|---|---|---|
    | 非零退出 | failed | — | — | exit-code |
    | output cap | failed | output_cap | — | kill-kind + 常带 summary-truncated |
    | failure_when 命中 | killed | watch_failure | — | kill-kind（status=killed 已区分） |
    | blind 耗尽 | failed | watch_failure | blind_exhausted | kill-kind + failure-kind |
    | watch timeout | failed | watch_failure | watch_timeout | kill-kind + failure-kind |
    | reload lost | failed | — | lost | failure-kind |
- **REV-9 裁决（#47）**：v1 **每任务一条**完成通知（各带己方 summary/output-file）；**不合并**。
  模块图原先写「合并」为假承诺——同时完成会各发一条并各可能 `triggerTurn`。防 chatter 靠
  `outputConsumed` 闩与 failed-only guidance（D5），不靠跨任务 debounce。真合并需改多任务 XML
  schema + 窗宽策略，另开后续 REV（可派 Drift）。
- **通知是 best-effort（REV-14）**：`sendMessage` 返回 void，宿主 fire-and-forget（无 ack）；pi-async 只
  投递一次。`notified=true` 仅表示「已交给宿主」，不表示模型已读。失败（无 `sendMessage` / 同步抛错）
  保持 `notified=false` 并累加 `notifyAttempts`，由 `session_start` 补发一次兜底。
- **心跳已删除**：不再建 60s `setInterval`，不再写 `async-task-heartbeat` entry，不再读
  `PI_ASYNC_HEARTBEAT_MS`。理由：custom entry 不进 LLM 上下文，且 60s 周期命不中 legion
  `collectArtifactGrowing` 的 500ms 增长窗口。提醒改走 `agent_before_settle` 的 `custom_message`（§7）。

## 7. Settle 守卫 + OSC busy（冻结，对齐 #156 插件契约）

- `agent_before_settle`（仅 `PI_LEGION_NODE_ID` 存在时注册）且存在未终态任务：
  - `reminders < maxReminders`（默认 3）→ 返回 `{ entries: [...event.entries, custom_message],
    continue: true }`，提醒内容为「N 个异步任务未收割（taskId 列表），先 async_wait/async_status
    处理再报 verdict」；**每 run 重新武装，累计 ≤3 次**。
  - `custom_message` 形状（D-12，0.3.0）：`{ type: "custom_message",
    customType: "async-task-settle-reminder", content: "...", display: false }`。**不得用
    `appendEntry`**：custom entry 不进 LLM 上下文，模型看不到提醒。
  - 达到上限 → 返回 `{ entries: [...event.entries, unresolvedEntry] }`，不带 `continue`：
    放行但在 entries 里保留未决清单。
- `agent_settled` 兜底（D-13，0.3.0）：对所有会话注册；`event.aborted === true` 且 registry 有活跃
  任务 → `pi.sendMessage({ customType: "async-task-unresolved", content: "<一句话 + 活跃任务 id 列表
  + 用 async_wait/async_status 收尸>" }, { deliverAs: "followUp" })`；**不设 `triggerTurn`**，
  每 generation 最多 1 条（`agent_start` 重置）。理由：pi 1.5 的 aborted run 会跳过
  `agent_before_settle`，Esc 中断场景需要单独覆盖。
- 开关：`PI_ASYNC_SETTLE_GUARD=0` → 整个守卫不注册任何 handler。`dispose()` 幂等，退订所有 handler。
- **无心跳**：不建 `setInterval`、不写 `async-task-heartbeat` entry、不读 `PI_ASYNC_HEARTBEAT_MS`。
- OSC busy 上报 **仅 feature-detect，不构成能力承诺**（官方 pi 1.2/1.4/1.5 均无 `ui.setActivity`，
  三处调用在生产上是 no-op；保留 shim 只为上游将来加 API 时自动生效，README/CHANGELOG 不得把它
  写成已实现能力）：
  - `ui.setActivity("pi-async", { message: "N async tasks" })`，全清时 `undefined`
  - 每任务 `id=plugin/pi-async/<task-id>`，raise/clear 与任务状态同步
  - **REV-8 裁决（#26）**：实现必须带 `plugin/` 前缀（对齐 legion
    `docs/contracts/osc-busy-plugin.md` 的 `plugin/<name>/…`）；聚合源仍为 `pi-async`（§7 冻结）。
    此前实现漏前缀会导致宿主按 `plugin/` 路由时 per-task activity 静默无效。
  - **禁止 printf OSC**；尊重 `PI_PROGRAM_STATUS`
  - 上报时机：任务启动、终态、以及 `agent_before_settle`（闭合 retire 竞态窗口的关键，见 #156 补充评论）
- RPC（legion child）内：setActivity 依赖 legion `extension_activity` 转发（#156 落地后生效），
  未落地时静默降级，不影响工具面。

## 8. TUI（冻结，仅主会话）

- guard：所有 TUI 路径 `ctx.mode === "tui"`（hasUI 陷阱）；rail/面板跳过 rpc/json/print。
- **轨道图 widget**（`setWidget("pi-async-rail", factory, {placement:"aboveEditor"})`）：
  整体最多 4 行（`RAIL_MAX_LINES=4`），含首行汇总；任务槽位为 `RAIL_TASK_SLOTS=3`，溢出时为
  `RAIL_TASK_SLOTS_OVERFLOW=2`。无溢出时为汇总 1 行 + 最多 3 行任务；
  有溢出时为汇总 1 行 + 2 行任务 + 1 行溢出指示。任务行格式 `▶ name · state · elapsed`
  （running=类型色 / completed=settled 色 / failed=error / killed=dim；配色走 legion palette
  延迟解析 + OKLab 撞色检测）；wheel 滚动；press→latch→click 命中任务 → 打开详情。
  鼠标事件仅在 fullscreen / alt-screen（开启鼠标上报）时可用；regular 模式用 `/async` + 键盘。
  `renderRailRows(snapshots, width, now?)` 为纯函数，内部最多渲染 3 个任务行；没有可见任务时
  整个 widget 返回 `[]`，不显示汇总行。
- **汇总行**：由 `summarySegments`/`formatSummary` 生成，段序为 `▶ N running · N pending · <elapsed> · ✓N · ✗N`；
  `pending` 仅在数量大于 0 时显示；`✓N` 与 `✗N` 对称，均仅在各自数量大于 0 时显示
  （全失败场景不再出现绿色的 `✓0`）；无 running 时 elapsed 为 `—`。
  `▶` 在 running/pending 非零时为 accent、否则 dim；running 数为 accent，pending/elapsed 为 dim，
  完成数为 success，失败数为 error。宽度不足时优先移除可选段并 truncate，再上色。汇总行不可点击。
  running/pending 始终计数；完成数与 failed/killed 失败数仅统计通过 `/async-clear` 共享 watermark 的终态任务。
  1Hz 重绘 ticker 归 rail widget 所有，保证 elapsed 持续跳秒。
- **footer 默认关闭（opt-in，REV-12 + PLAN §2.9）**：任务汇总默认在 rail 首行，不调用
  `setStatus("pi-async", …)`；仅当 `PI_ASYNC_FOOTER=1` **且**宿主 `ui.setStatus` 存在时，渲染一行
  汇总（可选、默认关闭）。`initStatus` 保留 `reportActivity`（feature-detect），`setStatus` 调用为
  best-effort（宿主拒绝不得影响会话）。`clearedAtMs`/`survivesClearCutoff`/`clearDoneStatus`
  保留，由 `panel.ts` 与 `/async-clear` 共享。
- **面板**（仅 `/async`）：`ctx.ui.custom({overlay:true, overlayOptions:
  {width:"80%", maxHeight:"70%", anchor:"center"}})`；从 rail 点击直入详情时为
  `{width:"85%", maxHeight:"80%", anchor:"center"}`。固定百分比尺寸，不提供环境变量开关。
  自绘 mask+frame（legion live-overlay 模式）；左列任务列表（含历史，`h` 切换），点击/Enter 进详情：
  identity/status/elapsed/command/metadata + 输出 tail（128KiB UI 缓冲，12 行跟随滚动，上滚暂停）；
  键位 `x`（或 `K`）kill（二次确认）/`R` rerun/`c` **显示** output 路径（不是复制）/`q` 关闭；
  列表内 `k` 是**上移**，不是 kill（REV-18）。Esc 层级：rail 点击直入详情后 Esc 关闭；列表内进入详情后
  Esc 回落列表。面板为单例：已打开时再次 `/async` 只 `ui.notify("Async panel is already open")` 后
  返回（不叠加 overlay、也不主动 re-render）；面板本身由 `registry.subscribe` 事件驱动刷新，
  `dispose()` 退订；详情帧保留 header + footer 键位提示（超预算时保留最后 N 行并插
  `… (+K lines)`）。
- **running 任务在列表直接显示最新输出行**（footer pill 模式，ANSI 剥离）——设备码场景用户无需
  agent 中转即可看到输出。
- **早期输出 peek**：`async_logs` 对 running 任务即时可读；`async_run` 返回的 receipt 带
  `outputHint` 提示 agent 设备码等早期输出可直接 peek。

## 9. 输出与预算（冻结）

- 写盘 cap：默认 20 MiB（`PI_ASYNC_MAX_OUTPUT_BYTES`），超限 → kill(kind=output_cap) → failed。
- 模型读取：`async_logs { taskId, maxBytes≤50KiB, tail=true, stream: "merged"|"stdout"|"stderr" }`
  （`stream` 默认 `merged`），truncated 带全量路径提示（`fullPath` 有效至被 §10 retention prune）。
  `taskId` 可用 name（REV-15）；输出文件缺失 → `{text:"", truncated:false, fullPath, missing:true}`，
  不 throw；读取前校验 `fullPath` 在 dataDir 内，越界 throw。
- ANSI/CSI/OSC 剥离：`async_logs` 返回与 TUI 显示前必须剥离（安全项，防输出注入转义序列）。
- sync 返回 outputTail ≤ 8 KiB / 200 行（whichever first）。

## 10. 杀伤与清理（冻结）

- detached 进程组 spawn（POSIX）；kill：SIGTERM → 3s grace → 组 SIGKILL → 有界探测；
  无法证明死亡 → 响亮报错「Descendant processes may have leaked」。
- `session_shutdown(reason)`（REV-17）：`reload` / `resume` → `registry.suspend()`（停 timer/watch、
  持久化快照，**不 kill 进程**，交给下一代 `configure()` 收养）；`quit` / `new` / `fork` / 未知 →
  `registry.shutdown()`（幂等：admission close + drain + 全任务 kill(kind=shutdown)）；
  **不承诺 crash-durability**（metadata 原子写，output 不 fsync）。
- reload / 重启恢复（REV-17）：同进程 `/reload` 不杀任务；新代 `configure()` 重新载入后按持久化的
  `timeoutAt` / `watchDeadline` / `cwd` 重建剩余预算（不是重置）；running 且 pid 已死/无 pid → 标 failed(lost)；
  pending delayed 在**下一个加载该 dataDir 的会话**（不区分进程）中按剩余 delay 恢复计时。
- dataDir（REV-17）：`<session dir>/pi-async/<sessionId>/`，无 sessionManager 时 `~/.pi/async/<pid>/`；
  dataDir 变更时 copy + rename 迁移 `.json/.output/.stdout/.stderr`，成功则重写快照内的
  `metadata.outputFile` 并重新 persist；失败保留旧目录 + `console.error`（`configure` 不 throw），
  任务不丢。产物文件 0600；README 要求不要把 dataDir 放进被 git 跟踪的路径。
  **REV-5 裁决（F3）的 pid 措辞作废**（dataDir 不再是 `<session-id>-<pid>`）：跨进程不承诺回收
  **活进程**，但不阻止数据恢复 —— `configure()` 首次加载 dataDir 后调用 `reapOrphans()`：
  running 且 pid 已死（或无 pid）→ `failed` + `failureKind: "lost"`；pending delayed 的 `dueAt`
  已超出 retention 窗口 → 同样标 `lost`，未过期的 pending delayed 由 `reloadFromDisk()` 按剩余
  delay 重新挂 timer（同进程 `/reload` 与跨进程新会话一致）。
- **delayed 启动失败**：`cwd` 不存在 / `env` 含被拒危险键 / spawn 抛错 → 任务标 `failed`（exitCode 1），
  原始错误写入 `metadata.startError`；完成通知的 guidance 追加 `Start error: ...`（`async_status`
  也能看到该字段），模型无需再 `async_logs` 才能定位原因。
- **磁盘产物 retention（#25）**：每个 dataDir 内，终态任务的 `.json` / `.output` 按 age+count
  并集策略 prune（启动 `reloadFromDisk` 末尾跑一次；每次 finalize 后再轻量触发）。
  - 保留并集：按 `finishedAt ?? createdAt` 降序的最新 `PI_ASYNC_RETENTION_COUNT` 个终态任务，
    **或** 年龄仍小于 `PI_ASYNC_RETENTION_MS` 的终态任务；其余终态任务删除产物并从内存移除。
  - 非终态（running/pending）不被 prune 直接删除；但 `dueAt` 超出 retention 窗口的 pending delayed
    先由 `reapOrphans()` 标 `failed` + `failureKind: "lost"`，再按终态参与 prune。
  - `async_logs` 返回的 `fullPath` **有效至被 prune**（过期后文件可能已删；缺文件时 `logs()` 返回
    `{text:"", truncated:false, fullPath, missing:true}`，不抛错）。
  - 跨 session 目录的整目录回收不在本条范围（仍只读留档）；孤儿 `running` 同样由 `reapOrphans()` 处理。

## 11. 配置与环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_ASYNC_MAX_OUTPUT_BYTES` | 20 MiB（`20971520`） | 写盘 cap；超限 → kill(kind=output_cap) → failed |
| `PI_ASYNC_MAX_TASKS` | `32` | 注册表上限（running + pending），超了拒绝新任务 |
| `PI_ASYNC_MAX_SYNC_TIMEOUT_MS` | `600000`（10 分钟） | `sync.timeoutMs` 上界（schema `maximum` + 运行时校验） |
| `PI_ASYNC_ENV_INHERIT` | `safe` | 子进程 env 策略：`safe` 剥离敏感键（含 `npm_config_*` 中带 auth/token/password 的键）并拒绝危险显式键；`all` 恢复完整继承（显式危险键覆盖**在任何策略下仍被拒绝**）；`none` 只给 `PATH`/`HOME`/`SHELL`/`TERM`/`LANG`/`LC_*`/`TMPDIR`/`USER`（存在的）。未知值按 `safe` 处理 |
| `PI_ASYNC_SETTLE_GUARD` | 开启（未设） | `0` → 守卫不注册任何 handler |
| `PI_ASYNC_FOOTER` | 关闭（未设） | `1` 且宿主 `ui.setStatus` 存在时额外渲染一行 footer 汇总；rail 首行仍是默认状态面 |
| `PI_ASYNC_RETENTION_MS` | `604_800_000`（7 天） | 终态任务产物保留时长；与 COUNT 取并集 |
| `PI_ASYNC_RETENTION_COUNT` | `100` | 每个 dataDir 最多保留的「最新」终态任务数；与 MS 取并集 |
| `PI_ASYNC_RAIL_LINGER_MS` | `30_000` | 终态任务在 rail 上滞留时长 |

- `PI_ASYNC_HEARTBEAT_MS` **已删除**（心跳已删，见 §7）；设置它不会生效。
- 孤儿 pending delayed 的清理窗口**只由 `PI_ASYNC_RETENTION_MS` 决定**：`dueAt` 早于 `now - retentionMs`
  的 pending delayed 在 `configure()` 时被 `reapOrphans()` 标 `failed` + `failureKind:"lost"`；
  窗口内的 pending delayed 按剩余 delay 恢复（见 §10）。`PI_ASYNC_RETENTION_COUNT` 只作用于终态产物
  保留（单个 `dueAt` 无法定义计数窗口）。
- `safe` 策略剥离：`*_API_KEY` / `*_TOKEN` / `*_SECRET` / `*_PASSWORD` / `*_CREDENTIAL*`、
  `AWS_SECRET_ACCESS_KEY`、`AWS_ACCESS_KEY_ID`、`AWS_SESSION_TOKEN`、`GITHUB_TOKEN`、`GH_TOKEN`、
  `NPM_TOKEN`，以及名称含 `auth`/`token`/`password` 的 `npm_config_*` 键（如 `npm_config__authToken`，
  npm 从环境读的凭据；普通 `npm_config_registry` 等仍透传）。显式 `env` 里的 `PATH`、`LD_PRELOAD`、
  `LD_LIBRARY_PATH`、`NODE_OPTIONS`、`BASH_ENV`、`ENV`、`SHELLOPTS`、`PYTHONPATH`、`GIT_SSH_COMMAND`
  在**任何策略**（包括 `all`）下都直接 **throw**（不静默忽略，安全规则不可关闭）；普通键（`FOO`、
  `CI`、`NODE_ENV` 等）仍可覆盖。
- delayed 任务的 `metadata.delayedEnv` 会明文写入 `<taskId>.json`（0600，为了 `/reload` 后能启动）；
  工具面（`async_status`）与面板展示时值打码为 `"***"`（保留键名）。
- `PI_ASYNC_INTERNAL_MAX_OUTPUT_BYTES` 是测试内部开关（用于压低 cap），不进用户配置面；
  spawn 始终从子进程 env 删除它。

## 12. 工程约束

- peerDependencies：`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`（**不进 dependencies**，
  jiti 虚拟模块映射要求）。
- 语言 TS + node:test；验证命令：`npm run typecheck` && `npm test`；CI/发布门禁统一为
  `npm run verify`（= `typecheck` + `test`，`prepublishOnly` 同一条），另跑 `npm pack --dry-run`。
- 发布（0.3.0）：`version` = `0.3.0` 且 `package-lock.json` 同步；peerDependencies 保持 `^1.2.0`
  （**不抬下限、不进 dependencies**）；CI 是 node 22/24 matrix + 一个 pi 1.5.0 相容 job（`npm install
  --no-save @earendil-works/pi-coding-agent@1.5.0 @earendil-works/pi-tui@1.5.0`）；
  `.github/workflows/release.yml` 只由维护者推送 `v*` tag 触发（**不自动建 tag**），执行
  `npm run verify` → 校验 tag 与 package.json 版本一致 → `npm publish --provenance`（`NPM_TOKEN`）→
  `gh release create --generate-notes`（`GITHUB_TOKEN`）。
- vendor/reference 不编译不 import，只作参考。
- MIT License；legion viz 整块复用处保留 attribution 注释。

## 13. D 编号决策（已定，reviewer 对照用）

| # | 决策 |
|---|---|
| D1 | 不做子 agent 委派（delegate/attested/Fusion），只做 shell 任务运行时 |
| D2 | sync 模式 timeout 必填，默认 promote 而非报错（逃生口，对齐社区惯例） |
| D3 | async_wait timeout 必填；返回 notReady 不杀任务 |
| D4 | success_when 命中不杀进程（completed 是观察结论，进程归 taskTimeout/kill 管理） |
| D5 | 通知 completed 纯信息、failed 才带 guidance；outputConsumed 闩防 chatter |
| D6 | TUI 仅主会话；subagent 自动退化纯工具面（mode guard） |
| D7 | OSC busy 上报 feature-detect + settle 前上报闭合竞态（#156 契约）；未落地静默降级 |
| D8 | 不改 legion/pi 本体；busy-hold 走上游（#156 + 补充评论已发） |
| D9 | delayed：reload 恢复计时，切 session 不迁移 |
| D10 | settle 守卫每 run 重武装、累计 ≤3 次，超限放行但保留未决清单提示 |

## 14. 验收清单（verify 门禁）

1. `npm run verify` 全绿（= `npm run typecheck` && `npm test`），且 `npm pack --dry-run` 包含
   `extensions/`、`src/`、`README.md`、`LICENSE`、`docs/CONTRACT.md`、`CHANGELOG.md`
2. background 任务：启动→立即 receipt→完成通知唤醒（print/RPC 模式实测：`pi --print` 会话收到
   `<async-task-notification>` 并继续 turn）
3. sync：短命令阻塞返回 exitCode；长命令 timeoutMs 到点 promote 转 background，任务不死；promote/abort
   等待超时不算工具错误（REV-19）
4. delayed：delayMs 后启动；pending 期 cancel；reload 后恢复
5. watch：stdout_contains/output_matches 命中 completed（含多行上 `^READY$` 因 m 命中）；
   failure_when 命中 killed(watch_failure)；非法 regex 启动前拒绝
6. async_wait：多任务等待全部终态；timeout 返回 notReady 且任务存活；混合超时同时含 results+notReady（已完成侧已 consume）；Esc 中断不杀任务
7. 输出安全：注入 ANSI 转义的任务输出，async_logs 返回已剥离
8. kill：进程组全灭（子进程不残留）；20MiB 超限 kill(output_cap)
9. settle 守卫：有未决任务时 agent_before_settle 注入提醒并 continue；3 次后放行
10. TUI（人工）：rail 最多 4 行（含汇总）且汇总行按 token 着色；elapsed 每秒跳变；点击任务进详情；
    Esc 按 rail/list 来源正确关闭或回落；面板按列表 80%×70%、详情 85%×80% 居中显示；
    极窄终端不溢出；输出 tail 跟随；RPC 下无 TUI 路径执行
11. 文档漂移门：README/CHANGELOG/CONTRACT 无「四种模式」「k kill」「copyToClipboard」
    「`<session-id>-<pid>`」「重试 ≤3 次」等旧措辞；CONTRACT 含 REV-13…REV-19，CHANGELOG 有 0.3.0 段。

## 15. 加固层（2026-10-15 事故后追加）

- **factory API 契约测试**：pi 1.2.0 的 factory-time ExtensionAPI **没有** `mode`/`ui`/`cwd`（探针实测，
  仅 registerTool/on/sendMessage/appendEntry/sessionManager 等）。TUI 绑定只能从事件 ctx
  （`pi.on(event, (event, ctx) => ...)`）获取。`tests/i-factory-contract.test.ts` 固化该形状：
  mock 的 factory pi **禁止**发明真实宿主没有的字段（此前两起生产事故均源于 mock 幻觉字段）。
- **工具返回值契约**：pi 不自动包装扩展工具返回值；全部 execute 必须经 `toolResult()` 包装成
  `{content:[{type:"text"}], details, isError}`（TUI getTextOutput 直接 `result.content.filter`）。
  `tests/a-tool-result-contract.test.ts` 逐工具断言。
- **rail 终态滞留**：completed/failed/killed 任务在轨道图上保留 `PI_ASYNC_RAIL_LINGER_MS`
  （默认 30s）供用户看到结果，之后自动消失；running/pending 恒显示；全空闲渲染空（§8）。

## 16. 0.3.0 修订（REV-13 … REV-19）

每条格式：**原因 / 影响面 / 回退开关**。实现细节以 `docs/PLAN-0.3.0.md` §2 冻结形状为准。

### REV-13（cwd）

- **原因**：`spawnDetached` 不传 `cwd`、工具 `execute` 只接 3 参，任务继承 pi **进程** cwd；用户在
  session 里 `cd` 到子目录后 `async_run("pwd")` 跑错目录（P0-2）。
- **影响面**：`RunOptions.cwd` / `TaskSnapshot.cwd`（持久化）；`spawnDetached({cwd})`；delayed 任务保留
  提交时 cwd；reload 按持久化 cwd 恢复；TUI `R` 重跑在**原任务的 cwd** 执行（不是当前 session cwd）；
  `execute` 改 5 参读 `ctx.cwd`。
  缺省链：`options.cwd ?? config.cwd ?? process.cwd()`。
- **回退开关**：无（正确性修复）。

### REV-14（notify honesty / 补发）

- **原因**：`sendMessage` 返回 void（无 ack），旧实现的通知「重试 ≤3 次 + rollback」是死代码；
  `claimNotification` 在投递前就把 `notified=true` 落盘，一次失败就永久静默（P0-3）。
- **影响面**：`NotifyOutcome = queued|skipped|failed`；先 `noteNotifyAttempt` 再 `sendMessage`，成功后
  `markNotified`；失败释放内存 claim 且 `notified=false`；`session_start` 调 `resendUnnotified()`
  补发（终态 + 未 notified + 未 consume + attempts<2 + 24h 内）；`async_wait` 取回结果置
  `outputConsumed` 抑制通知；`async_status` 暴露 `notified` / `outputConsumed` / `notifyAttempts`。
- **回退开关**：单任务 `notifyOnCompletion: false`；没有「恢复假重试」开关（无 ack 就无法实现）。

### REV-15（name 别名 / 工具契约）

- **原因**：模型按 name 调用会报 `Unknown task id(s)`；`async_kill` 未知 id 静默成功；非 sync 传
  `onTimeout` 被静默忽略；sync 非 0 退出不带 `isError`；`async_status` 无过滤（P1-1）。
- **影响面**：`registry.resolveTaskId(idOrName)`（重名报错并列候选 id）；`async_wait`/`async_logs`/
  `async_kill` 接受 name；未知 id/name → `Unknown task or name: ...` + `isError`；非 sync 传 `onTimeout` → throw；
  sync 以非 0 状态**真的结束**时 → `isError:true`（详情见 REV-19；payload 保留完整 `SyncResult`）；`async_status` 新增
  `status` / `name` / `limit`（1–50，默认 50），`includeHistory` 与显式 `status` 按
  `(finishedAt ?? createdAt)` 降序；`delayedEnv` 值打码为 `***`。
- **回退开关**：无（只放宽入参、收紧错误面）。

### REV-16（env policy）

- **原因**：旧 `{...process.env, ...opts.env}` 把子进程变成凭证副本，且 `env` 来自 LLM 参数，模型可
  覆盖 `PATH` / `LD_PRELOAD` / `NODE_OPTIONS`（P0-6）。
- **影响面**：`EnvPolicy = safe|all|none`；`buildChildEnv(base, extra, policy)` 纯函数；默认 `safe` 剥离
  敏感键（含 `npm_config_*` 中带 auth/token/password 的键，冻结清单之外的加固）；**三种策略下**显式危险键均 throw（安全不可关闭）；普通键可覆盖；`none` 只给最小白名单；
  始终删除 `PI_ASYNC_INTERNAL_MAX_OUTPUT_BYTES`；delayed 任务的 `metadata.delayedEnv` 在工具面与面板
  打码。
- **回退开关**：`PI_ASYNC_ENV_INHERIT=all`（恢复完整继承，但显式危险键覆盖仍被拒绝）/ `none`
  （最小白名单）；未知值 → `safe`。

### REV-17（dataDir / session_shutdown reason / reload 恢复）

- **原因**：dataDir 落在 `<cwd>/.pi/async/<session-id>-<pid>/`（可被 git/分享带走）；`session_shutdown`
  忽略 `reason`，`/reload` 会 SIGTERM 正在跑的构建；reload 后 `taskTimeoutMs` / watch 预算重置；orphan
  running 永久残留（P0-5 / P0-6 / P1-4）。
- **影响面**：dataDir → `<session dir>/pi-async/<sessionId>/`（无 sessionManager → `~/.pi/async/<pid>/`）；
  产物 0600；dataDir 变更时 copy+rename 迁移，失败保留旧目录且 `configure()` 不 throw；
  `session_shutdown.reason`：`reload`/`resume` → `suspend()`（不 kill），`quit`/`new`/`fork`/未知 →
  `shutdown()`；`timeoutAt` / `watchDeadline` / `cwd` 持久化并在 reload 后按剩余预算重建；
  `configure()` 首次加载 dataDir 后调用 `reapOrphans()`：running 且 pid 已死（或无 pid）→ `failed` +
  `failureKind:"lost"`，pending delayed 的 `dueAt` 超出 retention 窗口 → 同样标 `lost`；未过期的
  pending delayed 由 `reloadFromDisk()` 按剩余 delay 重新挂 timer（同进程 reload 与跨进程新会话一致）。
- **回退开关**：终态产物保留窗口由 `PI_ASYNC_RETENTION_MS` / `PI_ASYNC_RETENTION_COUNT` 控制
  （orphan pending delayed 只看 `PI_ASYNC_RETENTION_MS`，见 §11）；不提供「回到项目根目录」的开关（安全默认）。

### REV-18（TUI `x` 键 / `c` 只显示路径 / overlay 单例）

- **原因**：`k` 在列表=上移、在详情=kill，同键双语义易误杀；`ui.copyToClipboard` 在 pi 1.2–1.5 不存在，
  `c` 永远走 fallback（却在文档里写成「复制」）；每次 `/async` 叠加 overlay；面板打开时任务完成不刷新
  （P0-7 / P0-8 / P1-3）。
- **影响面**：kill 改为 `x`（`K` 亦可，二次确认），`k` 保持上移；`c` 改为 `ui.notify(path)`「显示 output
  路径」，删除 copyToClipboard 分支与表述；模块级 `panelOpen` 单例（已打开时只 `ui.notify("Async panel is
  already open")` 后返回，不叠加 overlay、不主动 re-render）；
  `registry.subscribe(() => requestRender())`，`dispose()` 退订；kill 带 `.catch()` 写 `actionError` +
  `ui.notify(...,"error")`；详情保留 header + footer，超预算时 `… (+K lines)`；rail 删不可达的
  PageUp/PageDown 代码。
- **回退开关**：无（可靠性修复）。

### REV-19（sync `promote` / `abort` 超时不是工具错误）

- **原因**：`onTimeout: "promote"`（默认）或 `"abort"` 到期后任务仍在跑（`status: "running"`），
  旧判定把「未结束」也算成 sync 失败；`PLAN §2.7` 的 isError 口径是「sync 非 0 退出」，不是「等待超时」。
- **影响面**：`async_run` sync 分支的 `isError` 只在任务**真的结束**（`status` ∈ completed/failed/killed）
  且非 completed / 非 0 exit 时为 true；promote/abort 返回 `isError:false`，payload 保留完整 `SyncResult`
  （`status` / `promoted` / `exitCode?` / `outputTail`）。`promoted:true` 表示等待超时且任务已转
  background；`abort` 超时返回 `promoted:false` + `status:"running"`。
- **回退开关**：无（只是把错误面收窄回 PLAN 口径）；调用方若要「超时即失败」的语义，改看
  `promoted` / `status` 自行判定。
