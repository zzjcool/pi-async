# pi-async 冻结契约 v1

状态：**FROZEN**（2026-10-15） | 仓库：/root/code/pi-async | Node ≥ 22.19, pi ≥ 1.2.0（TUI）
修订规则：任何字段/语义变更必须走 REV 条目登记原因，worker 不得自行解释矛盾。

## 0. 定位与范围

pi-async 是 pi 的异步任务运行时扩展：任务注册表 + 四种任务模式 + 完成唤醒 +
主会话 TUI（轨道图 + 全屏面板）+ OSC 7501 busy 契约对齐（zzjcool/pi-legion#156）。

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
│   │   ├── notify.ts       # 完成通知/唤醒、合并、抑制闩
│   │   └── bus.ts          # 预留 eventbus + OSC activity 上报
│   ├── tools/
│   │   └── index.ts        # 5 个工具的注册与 schema
│   ├── tui/
│   │   ├── rail.ts         # 任务轨道图 widget（≤10 行）
│   │   ├── panel.ts        # 全屏面板（列表+详情）
│   │   └── status.ts       # footer setStatus + setActivity
│   └── guard/
│       └── settle-guard.ts # agent_before_settle 守卫 + 心跳
├── vendor/reference/       # 已就位（只读参考，不编译）
└── docs/
```

运行时数据（不进仓库）：`.pi/async/<session-id>-<pid>/<task-id>.output` + `<task-id>.json`（atomic write）。

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
- `notified` 持久闩（写进 metadata，reload 不重置），单次投递；发送失败回滚重试 ≤3 次。

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

**返回（receipt）**：`{ taskId, name, status, mode, outputHint }`；sync 模式返回
`{ ...receipt, exitCode, outputTail }`。所有任务启动 ≤30s admission 预检，shutdown 先 drain 再退出。

**工具集（5 个）**：`async_run` / `async_wait` / `async_logs` / `async_status` / `async_kill`。
命令面：`/async`（开面板）、`/async-clear`（清历史徽章）。

## 4. WatchSpec（照抄 better-bg 条件系统，冻结）

```ts
interface WatchSpec {
  intervalMs: number;                 // 默认 30_000，min 1_000
  timeoutMs: number;                  // watch 必填：watch 期限（schema enforce）
  success_when: Condition[];          // 任一命中 → 任务完成语义（不干预进程，见下）
  failure_when: Condition[];          // 任一命中 → kill(kind=watch_failure)
  blind_checks?: number;              // 默认 3：连续 N 次无法求值 → failed
}
type Condition =
  | { type: "exit_code"; equals: number }
  | { type: "stdout_contains"; value: string }
  | { type: "stderr_contains"; value: string }
  | { type: "json_path_exists"; path: string }        // $.a.b[0] 形式，启动前校验
  | { type: "output_matches"; regex: string }         // 我们新增：对合并输出流匹配（设备码等）
```

- `success_when` 命中 → **不杀进程**：任务标 completed，通知带命中详情；进程按 taskTimeoutMs/kill 自然管理。
  （区别于 better-bg 的 check 命令模式：我们 watch 的是**已存在任务**的输出/退出。）
- 条件在 async_run 时**启动前校验**，非法 regex/JSON path 直接拒绝（不产生 pending 任务）。
- **blind_checks 语义（REV-2 澄清）**：仅计「检查基础设施失败」（readOutput 抐错等）；
  「尚未可判定」（exit_code 未退出 / json_path 输出尚非 JSON）为 **pending 态，不累计 blind、照常
  继续轮询**。两者是不同语义，禁止合并。
- promptGuidelines（写进工具 description）：check 不要 `|| true` 自吞错误；未知态映射失败；
  结构化输出优先 jq -e；`output_matches` 的 regex 须加锚定防止过早匹配。
- **watch 失败性终态的进程处置（REV-4 裁决）**：`failure_when` 命中、blind 耗尽、watch timeout
  三条 watch 失败路径在 finalize 任务的同时**必须 kill 进程组**（与 `failure_when → killed(watch_failure)`
  同语义）；仅 `success_when`（D4）不干预进程。杀失败时响亮上报（kill 链已有 catch），
  绝不允许「终态任务 + 活进程」残留导致 async_kill 静默不杀或 shutdown 挂起。
  - **终态标注（REV-11）**：`failure_when` → `killed` + `killKind=watch_failure`；blind 耗尽 /
    watch timeout → `failed` + `killKind=watch_failure` + 对应 `failureKind`
    （`blind_exhausted` / `watch_timeout`）。三条都杀进程，用 status+failureKind 区分语义。

## 5. async_wait（唤醒原语，冻结）

```ts
async_wait({ taskIds: string[], timeoutMs: number })   // timeoutMs 必填（schema enforce）
// → 全部到达终态：{ results: Array<{taskId, status, exitCode?, outputTail}> }
// → 超时：{ notReady: Array<{taskId, status: "running"|"pending", elapsedMs}> }（不杀任务）
```

- 事件驱动：await 内部 waiter（任务 finalize 时 resolve），**禁止 sleep 轮询**（patty 教训）。
- 支持 AbortSignal（Esc）；中断等待不中断任务。
- 消费即抑制：async_wait 取回结果的任务，完成通知被 `outputConsumed` 闩抑制（防 chatter）。

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
- 心跳：有 running/pending 任务期间，每 60s `pi.appendEntry` 一条 heartbeat（触发 legion
  `collectArtifactGrowing` 宽限续期）；session jsonl 增长由守卫的提醒消息自然产生，心跳为兜底。

## 7. Settle 守卫 + OSC busy 上报（冻结，对齐 #156 插件契约）

- `agent_before_settle` 时存在未终态任务 → append 一条「N 个异步任务未收割（taskId 列表），先
  async_wait/async_status 处理再报 verdict」+ `continue: true`；**每 run 重新武装，累计 ≤3 次**，
  超过后放行但 verdict 提示里保留未决清单。
- OSC busy 上报（feature-detect，无 API 则跳过）：
  - `ui.setActivity("pi-async", { message: "N async tasks" })`，全清时 `undefined`
  - 每任务 `id=plugin/pi-async/<task-id>`，raise/clear 与任务状态同步
  - **禁止 printf OSC**；尊重 `PI_PROGRAM_STATUS`
  - 上报时机：任务启动、终态、以及 `agent_before_settle`（闭合 retire 竞态窗口的关键，见 #156 补充评论）
- RPC（legion child）内：setActivity 依赖 legion `extension_activity` 转发（#156 落地后生效），
  未落地时静默降级，不影响工具面。

## 8. TUI（冻结，仅主会话）

- guard：所有 TUI 路径 `ctx.mode === "tui"`（hasUI 陷阱）；widget/面板/shortcut 全部跳过 rpc/json/print。
- **轨道图 widget**（`setWidget("pi-async-rail", factory, {placement:"aboveEditor"})`）：
  ≤10 行；每行一个 live 任务 `▶ name · state · elapsed`（running=类型色 / completed=settled 色 /
  failed=error / killed=dim；配色走 legion palette 延迟解析 + OKLab 撞色检测）；wheel 滚动；
  press→latch→click 命中任务 → 打开详情。空闲无任务时不渲染。
- **footer**：`setStatus("pi-async", " N running · M done ")`。
- **全屏面板**（`/async` 或 `Ctrl+Alt+A`）：`ctx.ui.custom({overlay:true, overlayOptions:
  {width:"100%", maxHeight:"100%", anchor:"top-left", row:0, col:0}})` 自绘 mask+frame
  （legion live-overlay 模式）；左列任务列表（含历史，`h` 切换），点击/Enter 进详情：
  identity/status/elapsed/command/metadata + 输出 tail（128KiB UI 缓冲，12 行跟随滚动，上滚暂停）；
  键位 `k` kill（二次确认）/`R` rerun/`c` 复制输出路径/`Esc q` 关闭。
- **running 任务在列表直接显示最新输出行**（footer pill 模式，ANSI 剥离）——设备码场景用户无需
  agent 中转即可看到输出。
- shortcut 注册冲突处理：被保留键位占用则回退 `/async` 命令，不硬抢。
- **早期输出 peek**：`async_logs` 对 running 任务即时可读；`async_run` 返回的 receipt 带
  `outputHint` 提示 agent 设备码等早期输出可直接 peek。

## 9. 输出与预算（冻结）

- 写盘 cap：默认 20 MiB（`PI_ASYNC_MAX_OUTPUT_BYTES`），超限 → kill(kind=output_cap) → failed。
- 模型读取：`async_logs { taskId, maxBytes≤50KiB, tail=true }`，truncated 带全量路径提示。
- ANSI/CSI/OSC 剥离：`async_logs` 返回与 TUI 显示前必须剥离（安全项，防输出注入转义序列）。
- sync 返回 outputTail ≤ 8 KiB / 200 行（whichever first）。

## 10. 杀伤与清理（冻结）

- detached 进程组 spawn（POSIX）；kill：SIGTERM → 3s grace → 组 SIGKILL → 有界探测；
  无法证明死亡 → 响亮报错「Descendant processes may have leaked」。
- `session_shutdown`：幂等清理（admission close + drain + 全任务 kill(kind=shutdown)）；
  **不承诺 crash-durability**（metadata 原子写，output 不 fsync）。
- reload：registry 重建后扫描 `.pi/async/<session-id>-*`，running 且 pid 已死 → 标 failed(lost)；
  delayed pending → 恢复计时（reload 保留）；**切换 session 不迁移**（旧目录只读留档）。
  **REV-5 裁决（F3）**：reload 恢复仅限同进程存活期内的 /reload（dataDir 按进程固定
  `<session-id>-<pid>`）；跨 pid 崩溃遗留目录只读留档、不恢复，崩溃后遗留的 pending 延迟任务
  不会自动续跑。理由：跨 pid 收养需处理写入归属与幂等重建，与 v1 不承诺 crash-durability 的
  定位一致。README 已知限制同步标注。

## 11. 配置与环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_ASYNC_MAX_OUTPUT_BYTES` | 20 MiB | 写盘 cap |
| `PI_ASYNC_MAX_TASKS` | 32 | 注册表上限，超了拒绝新任务 |
| `PI_ASYNC_HEARTBEAT_MS` | 60_000 | settle 守卫心跳 |
| `PI_ASYNC_DOCK_SHORTCUT` | "ctrl+alt+a" | 可 off |

## 12. 工程约束

- peerDependencies：`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`（**不进 dependencies**，
  jiti 虚拟模块映射要求）。
- 语言 TS + node:test；验证命令：`npm run typecheck` && `npm test`（worker verify 门禁用）。
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

1. `npm run typecheck` && `npm test` 全绿
2. background 任务：启动→立即 receipt→完成通知唤醒（print/RPC 模式实测：`pi --print` 会话收到
   `<async-task-notification>` 并继续 turn）
3. sync：短命令阻塞返回 exitCode；长命令 timeoutMs 到点 promote 转 background，任务不死
4. delayed：delayMs 后启动；pending 期 cancel；reload 后恢复
5. watch：stdout_contains/output_matches 命中 completed；failure_when 命中 killed(watch_failure)；
   非法 regex 启动前拒绝
6. async_wait：多任务等待全部终态；timeout 返回 notReady 且任务存活；Esc 中断不杀任务
7. 输出安全：注入 ANSI 转义的任务输出，async_logs 返回已剥离
8. kill：进程组全灭（子进程不残留）；20MiB 超限 kill(output_cap)
9. settle 守卫：有未决任务时 agent_before_settle 注入提醒并 continue；3 次后放行
10. TUI（人工）：widget 轨道图渲染 + 点击进面板详情 + 输出 tail 跟随；RPC 下无 TUI 路径执行

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
