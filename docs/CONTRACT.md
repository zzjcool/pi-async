# pi-async 冻结契约 v1

状态：**FROZEN**（2026-10-15；0.3.0 修订 2026-11-02：REV-13…REV-19） | 仓库：/root/code/pi-async | Node ≥ 22.19, pi ≥ 1.2.0（TUI）
修订规则：任何字段/语义变更必须走 REV 条目登记原因，worker 不得自行解释矛盾。

## 0. 定位与范围

pi-async 是 pi 的异步任务运行时扩展：任务注册表 + 两种任务模式（background / delayed；`sync` 已由 REV-29 删除）+
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
│   │   ├── env.ts          # EnvPolicy（safe/all/none）子进程环境构建 + 危险键拒绝（REV-16）
│   │   ├── duration.ts     # 时长格式化（Ns / Mm Ss / Hh Mm），rail/panel 共用
│   │   └── bus.ts          # 预留 eventbus + OSC activity 上报
│   ├── context/
│   │   ├── nudges.ts       # 情境注入：bash 长命令事后教学 / <async-state> 行（REV-21）
│   │   └── resources.ts    # resources_discover：把随包 skill 注册给宿主（REV-22）
│   ├── tools/
│   │   └── index.ts        # 默认 5 个工具（+ 可选 async_wait）的注册与 schema（REV-29）
│   ├── tui/
│   │   ├── rail.ts         # 任务轨道图 widget（≤4 行，含汇总行）
│   │   ├── panel.ts        # 百分比尺寸面板（列表+详情）
│   │   ├── status.ts       # 汇总格式与共享 clear watermark 谓词；initStatus 上报 activity + opt-in footer
│   │   ├── host.ts         # TUI 宿主上下文惰性绑定（factory 期无 mode/ui，见 §15）
│   │   └── width.ts        # 显示宽度计算（东亚宽字符/emoji 占 2 列）与截断
│   └── guard/
│       ├── settle-guard.ts # agent_before_settle custom_message 提醒 + agent_settled 兜底（无心跳）
│       └── hold.ts         # settle hold：会唤醒会话的 running 任务终态前不 settle（D-14 / §7.1）
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
- 通知诚实语义（REV-14）：`notified` 持久闩（快照**顶层**字段 `TaskSnapshot.notified`，不在 metadata 内；
  reload 不重置）；**单次投递，不重试、不回滚**（宿主 `sendMessage` 无 ack）。发送前 `notifyAttempts++`，
  `sendMessage` 返回后置 `notified=true`；失败保持 false。`session_start` 对未确认任务补发一次
  （24h 内、attempts<2、未被消费）。补发与完成通知共用同一道开关门：`metadata.notifyOnCompletion === false`
  的任务**不参与补发**（`resendUnnotified` 逐条跳过）。

## 3. 任务模式与启动参数（async_run 工具，冻结）

```ts
async_run({
  command: string,                    // 必填
  name?: string,                      // 展示名；缺省从 command 派生（≤48 chars）
  mode: "background" | "delayed",     // 默认 background（REV-29 删除 sync）
  // ── delayed ──
  delayMs?: number,                   // mode=delayed 必填；pending 到期启动；其他模式传它报错
  // ── 已删除（REV-29）──
  // timeoutMs / onTimeout：sync 专用旋钮随 mode=sync 一并删除；additionalProperties:false 因此
  // 让宿主直接拒绝这两个字段（不再有「传给错误模式」的运行期校验分支）
  // ── 通用 ──
  taskTimeoutMs?: number,             // 任务自身寿命；缺省 = 无限；无任何模式/组合强制（watch 也不要求它）
  notifyOnCompletion?: boolean,       // 默认 true
  triggerOnCompletion?: boolean,      // 默认 true：完成 sendMessage({triggerTurn:true}) 唤醒
  env?: Record<string, string>,       // 追加到 spawn env
  watch?: WatchSpec,                  // 见 §4；模式仅 background/delayed
})
```

- **执行目录（REV-13）**：所有任务在 **session cwd**（`ctx.cwd`，工具 execute 第 5 参）执行，
  `TaskSnapshot.cwd` 持久化；delayed 任务保留提交时 cwd；reload 后按持久化 cwd 恢复。缺省回退
  `process.cwd()`。

**返回（receipt）**：`{ taskId, name, status, mode, outputHint }`。`async_run` 不再有阻塞返回形态
（sync 的 `{ ...receipt, exitCode?, outputTail, promoted }` 随 REV-29 删除）；需要「现在就拿到结果」时，
`PI_ASYNC_EXPOSE_WAIT=1` 暴露的 `async_wait`（§5）是唯一的阻塞原语，否则用 `async_logs` / 完成通知收割。
所有任务**同步启动**：spawn 成功即返回 `running`；
spawn 失败立即抛错，无重试等待。admission 检查为 closed / `suspend()` 之后（见 §19 的两条可操作文案）/ maxTasks / 空命令，均同步完成。
shutdown 先 drain 再退出。
（**REV-6 裁决**：原「≤30s admission 预检」从未实现且与同步 spawn 设计冲突，改为描述现状；见 #29。）

**工具集（默认 5 个 + 可选 1 个，REV-29）**：`async_run` / `async_logs` / `async_status` / `async_kill` /
`async_extend`（REV-23，§18），外加仅在 `PI_ASYNC_EXPOSE_WAIT=1` 时注册的 `async_wait`。
命令面：`/async`（开面板）、`/async-clear`（清历史徽章）。工具面的增/删/改名/默认注册面变更规则见 §12
（必须新增 REV；第 6 席已被可选的 `async_wait` 占用）。

**可发现性面（REV-20/21/22/27/29）**：每个已注册工具各带一条 `promptSnippet`（逐字见 §17；默认 5 条，
暴露 `async_wait` 时 6 条），`async_run` 另带 4 条 `promptGuidelines`（0.4.1 起含批次规划，§21.2；未暴露
`async_wait` 时追加第 5 条说明并指向 `async_logs`）；check 纪律不再拼进 description，移入随包分发的 skill（§17 REV-22）。
运行时另有两条情境注入：`bash` 长命令返回后追加一行 `tool_result` 建议，以及每次请求前（有活跃任务时）
一行 `<async-state>`。两者都 best-effort，`PI_ASYNC_NUDGE=0` 关闭。

## 4. WatchSpec（照抄 better-bg 条件系统，冻结）

```ts
interface WatchSpec {
  intervalMs: number;                 // 必填无默认，min 1_000（schema 与 validateWatchSpec 均强校验）
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
  | { type: "output_matches"; regex: string }         // 合并输出流匹配（设备码等）；编译带 m（^/$ 按行）；不支持内联标志 (?i)
```

- `success_when` 命中 → **不杀进程**：任务标 completed，命中详情写入 `metadata.watchSuccess`（`async_status`
  可见）；**完成通知的 XML 不含该字段**（§6 字段表）。进程按 taskTimeoutMs/kill 自然管理。
  （区别于 better-bg 的 check 命令模式：我们 watch 的是**已存在任务**的输出/退出。）
- 条件在 async_run 时**启动前校验**，非法 regex/JSON path 直接拒绝（不产生 pending 任务）。
- **blind_checks 语义（REV-2 澄清）**：仅计「检查基础设施失败」（readOutput 抛错等）；
  「尚未可判定」（exit_code 未退出 / json_path 输出尚非 JSON）为 **pending 态，不累计 blind、照常
  继续轮询**。两者是不同语义，禁止合并。条件持续 pending 时**不**触发 blind 兜底；watch 由
  `timeoutMs` 到期、进程退出或 `async_kill` / `failure_when` 终结（WatchSpec 字段注释已与本条对齐，见 #27）。
- **组内 OR**：`success_when` / `failure_when` 各自是 OR（首个命中即返回），没有 `match:"all"` 模式。
- **两层窗口，各有理由（REV-25）**：
  - **读取窗口**：每次求值（每个 tick，以及进程退出时那一次）的 `readWatchOutput` 经 `logs()` 只读**尾部**，
    上限 `WATCH_READ_BYTES` = `MAX_LOG_WINDOW`（8 MiB，**每流各一次**）。不再整文件 `readFileSync`。
    滚出读取窗口的输出对**任何**条件都不可见。
  - **正则窗口**：`output_matches` 在读取窗口内再截到尾部 `MAX_MATCH_CHARS`（64×1024，按
    **UTF-16 码元**截断，不是字节）。它是**内存 / 取舍边界**——把一次求值要拷贝、要走的主体会
    有界——**不是 ReDoS 防线，也不是可接受的工作量上界**：引擎代价随主体长度指数增长，窗口只决定
    「最多能长到多长」；而封顶值早在 16 码元就贴着预算（19 码元越过 25 ms、26 码元 5 s，
    `docs/reports/redos-benchmark.md` §4.2），所以对任何有用长度的输入它都挡不住（REV-34 修正本条
    此前的因果陈述）。求值侧的防线是 REV-34 的**硬预算 + 可抢占执行**，不是窗口大小。
  - 因此可见范围：`stdout_contains` / `stderr_contains` 是**尾部 8 MiB**（不是无限）；
    `json_path_exists` 只能解析尾部 8 MiB 内的 JSON（超大 JSON 会因此永远 `pending`，由进程退出、`timeoutMs` 或 `async_kill` 终结 watch）；
    `output_matches` 是尾部 64K 码元；`exit_code` 只看退出码，与窗口无关。
  - 缺失的合并输出文件仍 **throw**（让 `blind_checks` 计为基础设施失败）；`stdout` / `stderr` 缺席按空串处理（#4）。
- **check 纪律在随包 skill，不在工具面（REV-22）**：不 `|| true` 自吞错误、未知态映射失败、结构化输出
  优先 `jq -e`、`output_matches` 须加锚定（编译固定带 `m`，`^`/`$` 按行边界，故 `^READY$` 可命中
  多行输出中的某一行）——全文见 `skills/async-tasks/SKILL.md`；工具面只留 `watch` 的 schema
  description 一句压缩版（OR-ed / first-match-wins / 不吞错）。`async_run` 的 4 条 `promptGuidelines`
  讲的是**使用时机 / 收割 / 命名 / 批次规划**，与 check 纪律无关（§17 REV-20 / REV-22，§21.2 REV-27）。
- **watch 失败性终态的进程处置（REV-4 裁决）**：`failure_when` 命中、blind 耗尽、watch timeout
  三条 watch 失败路径在 finalize 任务的同时**必须 kill 进程组**（与 `failure_when → killed(watch_failure)`
  同语义）；仅 `success_when`（D4）不干预进程。杀失败时响亮上报（kill 链已有 catch），
  绝不允许「终态任务 + 活进程」残留导致 async_kill 静默不杀或 shutdown 挂起。
  - **终态标注（REV-11）**：`failure_when` → `killed` + `killKind=watch_failure`；blind 耗尽 /
    watch timeout → `failed` + `killKind=watch_failure` + 对应 `failureKind`
    （`blind_exhausted` / `watch_timeout`）。三条都杀进程，用 status+failureKind 区分语义。
- **REV-10 裁决（#48）**：`output_matches` 以 `new RegExp(regex, "m")` 编译（validate 与求值同）。
  契约原先要求锚定（`^READY$`）防止过早匹配，但无 `m` 时 `^`/`$` 只锚整段输出，多行流上锚定
  永不相交。加 `m` 使锚定与意图一致；整段匹配请用不含 `^`/`$` 的模式。**JS 没有 `\A`/`\z`**（会被当作字面
  量 `A`/`z`，静默失效——比报错更难查）；跨行整段匹配用 `[\s\S]*` 或改用 `stdout_contains`。
  同理，`regex` 不接受内联标志：`(?i)`/`(?m)`/`(?s)` 会抛 `Invalid group`（编译只带固定的 `m`，
  没有调用方可选的 flags）；大小写无关请用字符类 `[Rr][Ee][Aa][Dd][Yy]`。启动前校验会回显原始
  正则与 V8 原因，映射回具体的修复动作。

## 5. async_wait（唤醒原语，冻结）

**注册面（REV-29，0.5.0）**：`async_wait` **默认不注册**；只有宿主设置 `PI_ASYNC_EXPOSE_WAIT=1` 时才进
工具面（默认 5 个，暴露后 6 个）。开关**每次调用重新读 env**（不在模块顶层缓存）。旧会话/旧注册若仍调到它，
execute **不 throw**，返回 `toolResult({ taskId: null, available: false, error: <原因+开启方式>,
enableWith: "PI_ASYNC_EXPOSE_WAIT=1", alternatives: ["async_status","async_logs"] }, true)`（isError=true，
正常 resolve）；宿主对「未注册名字」的回包是 `Tool async_wait not found`。

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
- **代际边界（#100，判据）**：waiter 属于**发起它的那个 registry 实例**（`Waiter` 接口 + `waiters =
  new Set<Waiter>()` 容器，`src/core/registry.ts:60,131`）；任务 finalize 只唤醒本实例注册的 waiter（`:1258,:1263`）。每次
  `async_wait` 调用先 `configure(ctx)` 再由 `resolveRegistry()` 解析当前活代（`src/tools/index.ts:326-327`）。
  仓库没有跨代 epoch/token —— 代边界就是实例边界。
  1. `/reload` 即丢：`suspend()` 调 `this.waiters.clear()`，原文「Pending waiters belong to the retired
     generation; never wake them with stale results.」（`src/core/registry.ts:966-967`）。
  2. 在飞的 wait 不是失败、也不 kill 任务：`suspend()` 只停 timer/watch + 持久化（`:951-952` 注释；
     `:955-968` 无 kill；`tests/d-reload.test.ts:150`）。被 clear 的 waiter 仍靠自身 `timeoutMs` 定时器
     到点（`cleanup()` 才 `clearTimeout`），进入 timeout 分支后按该实例内存快照返回
     `{ notReady: [{ taskId, status: "running"|"pending", elapsedMs }] }`（`:708-717`；`elapsedMs` =
     任务创建至今）；工具层 `isError=false`（`src/tools/index.ts:334`）。宿主主动 abort 该调用时走
     `Wait aborted` reject（`:718`），pi-async 自己不 abort。
  3. 跨进程无共享 waiter：waiter 不落盘，全仓无 IPC/socket/`fs.watch`；结果事实在
     `<dataDir>/<taskId>.json` 与输出文件（`src/core/registry.ts:1294-1295`），新代 `reloadFromDisk()`
     （`:1124`）之后用 `async_status` / `async_logs` 取回。**判据：wait 只命中该实例内存里的任务；
     要跨代/跨进程收割，用状态工具，不要等 waiter。**
  - 例外（不改上述判据）：退役实例被自己的 `configure()` 复活（REV-28a）且磁盘真相在孤儿 waiter 到期
    前已把任务改成终态时，该 wait 返回 `{ results, notReady: [] }` —— timeout 分支读的是 `this.tasks`
    的当前内容（`:711-716`）。

## 6. 唤醒链路与 legion 兼容（冻结）

| 环境 | triggerOnCompletion 行为 |
|---|---|
| 主会话（TUI/RPC/print） | `pi.sendMessage({customType:"async-task-notification"}, {deliverAs:"followUp", triggerTurn:true})`；idle → 立即新 turn；busy → followUp 队列 |
| legion child，turn 内 | 同上 |
| legion child，跨 turn | **hold 模式**：settle 前守卫上报 busy（见 §7）；上游 #156 busy-hold 落地前，通知可能无法送达——**契约要求 agent 在 legion 环境用 async_wait 收割后再报 verdict**（守卫强制提醒，最多 3 次） |

- 环境检测：`PI_LEGION_NODE_ID` 存在 → legion child 环境，settle 守卫默认开启。
- 通知 XML：`<async-task-notification>` + task-id/name/status/exit-code/**kill-kind**/**failure-kind**/**process-alive**/**process-alive-known**/**exit-code-known**/output-file/summary/**summary-truncated**/guidance
  （guidance 仅在 `failed` **或** `killKind === "timeout"` 时带，completed 纯信息——patty chatter 教训；
  §17 REV-21 修订）。
  - `kill-kind` / `failure-kind`：有值才输出（与 snapshot 同名语义）；模型据此区分非零退出 / output_cap / watch 失败 / lost，无需先 round-trip `async_status`（#37）。
  - `summary-truncated`：summary 因 output_cap 或通知 tail 上限被截断时输出 `true`，避免把截断前缀误读为完整输出。
  - **`process-alive` / `process-alive-known` / `exit-code-known`（REV-35，0.5.4）**：判活与退出码的
    **诚实三态**。`process-alive` 取 `true` / `false` / `unknown` 三个值（不是缺字段）；`process-alive-known`
    为 `true` **仅当**那次判活是观测到的（进程退出被看到 / 探活证明进程组已消失）；`exit-code` 只在拿到
    **观测到的数字**时输出，`exit-code-known` 为 `false` 时表示「没拿到」，**不得**读成「退出码 0」。
    旧快照（无这三字段）通知里也不会有——缺字段读作 `unknown`，不推断、不迁移（§27）。
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

- `agent_before_settle`（所有会话注册，REV-21）且存在未终态任务：
  - **legion child**（`PI_LEGION_NODE_ID` 存在）：
    - `reminders < maxReminders`（默认 3）→ 返回 `{ entries: [...event.entries, custom_message],
      continue: true }`，提醒内容为「N 个异步任务未收割（taskId 列表），先 async_status 或 async_logs
      （暴露 async_wait 时含它）处理再报 verdict」（REV-29）；**每 run 重新武装，累计 ≤3 次**。
    - `custom_message` 形状（D-12，0.3.0）：`{ type: "custom_message",
      customType: "async-task-settle-reminder", content: "...", display: false }`。**不得用
      `appendEntry`**：custom entry 不进 LLM 上下文，模型看不到提醒。
    - 达到上限 → 返回 `{ entries: [...event.entries, unresolvedEntry] }`，不带 `continue`：
      放行但在 entries 里保留未决清单。
  - **主会话**（REV-21）：每 generation 最多 1 条
    `{ type: "custom_message", customType: "async-task-settle-advisory", display: false }`，
    **永不带 `continue`**（主会话带着后台任务结束 turn 是合法行为，不得被强制重跑）。文案见 §17。
- `agent_settled` 兜底（D-13，0.3.0）：对所有会话注册；`event.aborted === true` 且 registry 有活跃
  任务 → `pi.sendMessage({ customType: "async-task-unresolved", content: "<一句话 + 活跃任务 id 列表
  + 用 async_status/async_logs（暴露 async_wait 时含它）收尸>" }, { deliverAs: "followUp" })`；**不设 `triggerTurn`**，
  每 generation 最多 1 条（`agent_start` 重置）。理由：pi 1.5 的 aborted run 会跳过
  `agent_before_settle`，Esc 中断场景需要单独覆盖。
- 开关：`PI_ASYNC_SETTLE_GUARD=0` → 整个守卫不注册任何 handler。`dispose()` 幂等，退订所有 handler。
- **无心跳**：不建 `setInterval`、不写 `async-task-heartbeat` entry、不读 `PI_ASYNC_HEARTBEAT_MS`。
- **OSC busy 上报只是 host-API shim，不是已实现能力**（官方 pi 1.2–1.5 均无 `ui.setActivity`；
  `src/core/bus.ts` 的三个 shim 函数都做 `typeof ui?.setActivity !== "function"` 特性检测，生产上是
  no-op；settle 守卫也走同一个 shim，不自带副本）。保留它只为上游将来加 API 时自动生效；
  README/CHANGELOG 不得把它写成已实现能力。
  - **它能表达什么**：一次 write-only 的 `(id, { message: string } | undefined)` 调用
    （`src/core/bus.ts:31,45,53`）。两个 id：聚合 `"pi-async"`（`bus.ts:10,31`）与每任务
    `plugin/pi-async/<task-id>`（`bus.ts:13-15`）。清除 = 传 `undefined`（没有 idle/working 枚举，
    也没有结构化字段）。
  - **它不能表达什么**：不能读回（`src/` / `extensions/` 无 getActivity，activity 不进模型上下文）、
    不能表达每任务进度/耗时/优先级、**不能证明「真的在干活」或「没有工具在飞」**。legion 跨机场景
    今天没有转发通道（见下一条 RPC 段：依赖上游 #156 的 `extension_activity`），该侧 activity 字段
    恒缺/恒错；**任何消费者不得把 activity 的有无当作工作证据**。外部唯一诚实的 busy 信号是 settle
    hold 不结束 run（§7.1 / README「Settle hold」，OSC 7501 保持 `working`）。
  - **shim 形状（上游落地后才生效的形状约束，不是能力承诺）**：
    - 聚合文案 `{ message: "N async tasks" }`（`src/core/bus.ts` 的 `reportActivity`，恒复数）；每任务
      raise/clear 与任务状态同步（`extensions/index.ts:411-413`）。
    - 每任务 id 必须带 `plugin/` 前缀 —— **REV-8 裁决（#26）**：对齐 legion
      `docs/contracts/osc-busy-plugin.md` 的 `plugin/<name>/…`；聚合源仍为 `pi-async`（§7 冻结）。
      此前实现漏前缀会导致宿主按 `plugin/` 路由时 per-task activity 静默无效。
    - **禁止 printf OSC**；尊重 `PI_PROGRAM_STATUS`
    - 上报时机：任务启动、终态、以及 `agent_before_settle`（闭合 retire 竞态窗口的关键，见 #156 补充评论）
  - **实现收敛（#107，替换此前的「已知实现分叉」）**：`src/guard/settle-guard.ts` 不再自带私有
    `reportActivity()`；`agent_before_settle` 与 `register()` 都调 `src/core/bus.ts` 的
    `reportActivity`（一处实现、一个文案 `N async tasks`，恒复数）。该 shim 在宿主拒写（stale ctx）时
    吞掉异常并返回 `false`；守卫据此在答完当前 settle 边界后 `dispose()` 死代——异常不参与、也不改变
    settled 判定（0.3.2 stale-ctx 自愈保留）。
- RPC（legion child）内：setActivity 依赖 legion `extension_activity` 转发（#156 落地后生效），
  未落地时静默降级，不影响工具面；**因此 RPC/跨机侧没有可用的 activity 证据**。

### 7.1 Settle hold（默认开，D-14）

- 注册于 `agent_before_settle`（每 run 最多 1 次，`agent_start` 重新武装），在 SettleGuard **之前**
  注册，不改动 guard 自身逻辑。
- 条件：存在 holdable 任务——`status === "running"` + `notifyOnCompletion !== false` +
  `triggerOnCompletion !== false`（`pending`/delayed 任务不 hold：预算内不可能终态）。
  仅在交互 TUI 会话 hold（`ctx.mode === "tui"` 或 ctx 缺失）；军团 child（`PI_LEGION_NODE_ID` 存在）、
  `print`/`json`/`rpc` 都不 hold。**print 会话由另一条结构性保底负责（§23 REV-30），不是 hold**：
  它不需要唤醒型任务的过滤，也没有 TUI 表面。
- 行为：在边界内轮询等待（`PI_ASYNC_HOLD_POLL_MS`，默认 1000ms），直到快照内的 holdable 任务全部
  终态或到达 `PI_ASYNC_HOLD_MS`（默认 600000ms，单调时钟计时）。
- **出口（修订 4，0.4.3）**：0.4.2 的两条（全终态 / 预算耗尽）加上三条「让位于用户」的出口 ——
  用户永远优先于等待。任何非「全终态」出口都 **不带 entries/continue** 并释放扣住的通知（见修订 3）。
  1. **全部终态** → results entry + `continue: true`；
  2. **预算耗尽** → 原样 `undefined`（与无 hold 时一致）；
  3. **用户按 Esc** → 立即返回 `undefined`。宿主在 `agent_before_settle` 期间**无法抢占** handler
     （`emitBoundary` 无超时、无 race，`runner.js:767-814`），本边界的 `ctx.signal` 恒为 `undefined`
     （run 的 AbortController 在 `before_settle` 之前就清了，`pi-agent-core/dist/agent.js:216-223`），
     `session.abort()` 只置一个 handler 读不到的 flag（`agent-session.js:2073-2084`）。因此 Esc 走
     **原始终端输入**：`ui.onTerminalInput` 仅在 hold 期间订阅，只匹配单独 `\x1b`（方向键/Alt 序列
     `\x1b[A` 等不匹配），且**永不 consume**，宿主自己的 Esc 语义不变；用 `Promise.race` 打断 sleep，
     毫秒级生效而不是等一个 poll；
  4. **用户已入队消息**（`ctx.hasPendingMessages() === true`）→ 本轮立即返回 `undefined`，让宿主在
     下一个 turn 投递它。与已废弃的 F2b 探针的区别：完成通知走 `agent.followUpQueue`，**不在**该计数里
     （`agent-session.js:1959-1965`），所以这个探针对通知永远为 `false`、只对用户文本为 `true`；
  5. `dispose` / registry 抛错 → 原样 `undefined`。
- **进度可见性（修订 4 / 修订 5 / 修订 6）**：`agent_end` 在 `before_settle` **之前**就把宿主的 working 行清掉了
  （`interactive-mode.js:3060-3064`），hold 期间屏幕看起来像死机。hold 因此自带一行 widget，每 250ms 换一帧
  （10 帧 braille），`finally` 里无条件清除。
  **修订 6（0.4.6）/ 修订 7（0.4.7）：明细只属于 rail，而“rail 在不在”看的是它此刻画什么。**
  rail 正在列出本 hold 等待的**每一个** taskId 时（`railShowsTasks` 向已挂载 widget 的 `taskIds()`
  取一次，与 rail 的渲染共用同一窗口/滚动状态），hold 行只写
  `setWidget("pi-async-hold", ["<frame> waiting <hold-elapsed> — Esc stops waiting"], { placement: "aboveEditor" })`
  ——`<hold-elapsed>` 是**这一轮被 hold 多久**，与任何任务的耗时都不是同一个数字，rail 上也看不到。
  > **修订 8（0.4.8）已删除这一行**：`pi-async-hold` 这个 widget key 不复存在，`pi-async-hold` 只剩 footer 的
  > status key；等待行改为 rail 首行（见下文修订 8），因此本节描述的“输入框上方独立一行”是 0.4.4–0.4.7 的历史。
  任务名/状态/耗时由 rail 行承担：0.4.5 把它们搬到 hold 行后，同一终端里汇总行、rail 行、hold 行
  三行在说同一件事（用户截图报的冗余）。
  **其他一切情况**——宿主没有 `setWidget`、widget 已被宿主清掉、rail 的窗口没覆盖这些任务——都退回
  修订 5 的明细行，并调 `ensureRailSurface()` 让 rail 在下一帧重装，因此不存在“两边都不列名字”的帧。
  **0.4.6 的信赖链是错的（裁决，0.4.7）**：0.4.6 把 `registerRail` 成功过一次当成“rail 就在屏幕上”
  （`surfaces.ts` 里一个只置位、永不撤销的标志）。宿主会在 `resetExtensionUI()` 里 dispose 并清空
  **所有** extension widget（`interactive-mode.js:2004-2014`，由会话切换 `:383` 与 `/reload` `:5510`
  触发），而 `registerRail` 当时只从首个 TUI ctx 绑定时调过一次——于是 rail 消失、标志仍为真、
  hold 闭嘴，用户屏幕上只剩一行 `⠋ waiting …`。修订 7 把“注册”降级为“安装配方”：widget 由宿主
  创建时挂上 `mountRailDetail`、被 `dispose()` 时撤销，hold 每帧现取一次；`registerRail` 幂等，
  widget 不在就重装（`rail.ts` / `surfaces.ts`），首帧最多 1s 后自愈。退回修订 6 的写法会让
  `tests/h-hold.test.ts` 的 fallback 用例与 `tests/e-rail-liveness.test.ts` 变红。
  明细行内容（同名于修订 5）：
  `["<frame> N async task(s) <elapsed> — <name> (<status>, <elapsed>) · … — Esc stops waiting"]`，
  每项与模型侧 `<async-state>` 同形（`src/context/nudges.ts:75`）；无名/空白名用 `taskId` 前 8 位；
  按终端**格宽**截断（CJK 算 2 格，`src/tui/width.ts`），放不下的记 `+N more`，**永远单行**（换行会抖动 editor）。
  footer 仍是 `waiting for N task(s) <elapsed>`。两条分支都是 best-effort（D-8）。
  **不要改成静态符号或中英混排（裁决，0.4.6）**：首字符必须保留 braille 动画帧（`⠋⠙⠹…`，250ms/帧）——
  `agent_end` 已清掉宿主 working 行，静止的符号（如 `⏸`）会让 hold 看起来就是死机，换帧是这一行唯一的
  “还活着”信号；文案必须保持英文（`waiting`）——该行其余部分（`Esc stops waiting`）与全仓 UI 文案
  均为英文，中英混排会割裂。两点都是有意为之，不是待办。
  不借用 `setWorkingVisible`/`setWorkingMessage`：`workingVisible` 是会话级持久状态，hold 结束后没有
  任何事件会把它收回，会留下永久 spinner。
  **修订 8（0.4.8）：等待行并进 rail，输入框上方不再单独一行。** 修订 6/7 把明细收进 rail 之后，
  `⠙ waiting 2m 28s — Esc stops waiting` 与 rail 首行仍是两块界面在说同一件事，用户裁决
  「外观版的话我觉得可以，这样输入框上方的 `⠙ waiting 2m 28s — Esc stops waiting` 这个我觉得就可以不要了」。
  因此 hold 期间 **rail 首行就是等待行**：`⠙ async_wait · running <hold-elapsed> — Esc stops waiting`
  （braille 首字符保留、250ms 换帧；文案英文；唯一来源是 `src/tui/surfaces.ts` 的
  `waitingRow(frame, elapsed, detail?)`，rail 首行与 hold 兜底行都调它，别处不许再拼一遍 `async_wait`）。
  它 **顶掉**首行汇总行而不是新增一行：`RAIL_MAX_LINES=4` 冻结，用户示意正是「等待行 + 3 行任务」，
  所以 `RAIL_TASK_SLOTS` 仍是 3 —— 调小会让第三个任务失去名字行 ⇒ `railShowsTasks` 变假 ⇒ 兜底行回来，
  同一件事又说两遍。hold 每帧 `setHoldSurface({frame, elapsed})` + `railRepaint()` 驱动 250ms 重绘
  （rail 自己的 ticker 是 1Hz，不够用）；`clearWaiting` 在 `holdUntilSettled` 的 `finally` 里撤销声明，
  因此结束后首行自动回到汇总行（覆盖全终态 / 超时 / Esc / 用户入队 / dispose / registry 抛错全部出口）。
  兜底键改为 `pi-async-hold-fallback`，**只在 rail 画不出来时存在**（宿主没有 `setWidget`、widget 被清且
  装不回来、rail 窗口没覆盖这些任务），内容
  `⠙ async_wait · running <elapsed> — <name> (status, elapsed) · … — Esc stops waiting`；
  §8 不变式（每个等待中的任务名必须在屏幕上出现一次）因此保住：rail 正常画 ⇒ 名字只在 `▶` 行；
  否则先 `setHoldSurface(undefined)`，再 `ensureRailSurface()` 自愈并**立即复检**，仍不行才由 hold 自己带名。
  两面互斥：任何时刻全屏最多一处 `async_wait` 文本（测试用 `split("async_wait").length - 1 === 1` 断言）。
  宿主**完全没有** `setWidget` 时 footer 追加任务名
  （`waiting for N task(s) <elapsed> — name (status, elapsed) · …`），这是 §8 的最后落点；有 `setWidget` 时
  footer 保持原样（不重复任务名）。
  **宿主 working 行仍不可借用（复核，0.4.8）**：`interactive-mode.js` 的 `setWorkingVisible()` 中
  `if (this.session.isStreaming && …) this.showWorkingStatusIndicator();` —— hold 期间 `agent_end` 已过、
  没有流式输出，借用无效，修订 4 的裁决继续保留。
- 返回：全部终态 → 追加一条 `custom_message`（`customType: "async-task-settle-results"`、`display: false`、
  不含 outputTail、指路 `async_logs`）并 **`continue: true`**；其余出口 → 原样 `undefined`（不带 entries/continue）。
  `continue` 不会成环：再次进入边界时快照内任务已终态。
- **通知归属（修订 3，0.4.3）**：hold 真正在等待时**拥有**快照内任务的终态播报权。`onFinalize` 对
  这些 id 不再调用 `sendCompletionNotification`，而是由 `HoldNotificationRelay`（`src/guard/hold-notify.ts`）
  扣住，等 hold 出口决定：
  - 全终态 → results entry 是唯一播报，扣住的通知被丢弃，并对这些 id 落 `notified = true`
    （否则下次 `session_start` 的 `resendUnnotified` 会再播一次）；
  - 超时/`dispose`/registry 抛错 → 立即把扣住的通知交还给正常发送路径（**永不吞掉完成通知**）。
  理由：pi 在 run 仍在流式时只把 `followUp` 入队（`agent-session.js:1959-1962`），要到模型**停止**时
  （`agent-loop.js:196-203`）才投递，因此 results entry（边界 draft，同步落盘）必然先到，通知必然后到
  并独占一个 turn。0.4.2 两路都发 → 会话里出现「迟到的重复回执」（实测 01a1e5b5：ln393→ln404 49.586s、
  ln432→ln441 38.226s，模型自述「重复回执」）。顺序由宿主固定，**不是竞态**。
- 仍然：不 consume 输出、不改任务状态、不内联 outputTail；`notified` 仅在「results entry 已播报」
  这一种情况下由 hold 置位（修订 3 取代 0.4.2 的「不动 `notified`／不抑制通知」）。
- footer：`waiting for N task(s) <elapsed>`（key `pi-async-hold`），15s 刷新，结束后清除；全部 best-effort
  （0.4.3 起它只是辅助信号，主信号是上面的 250ms 等待行 —— 修订 8 起那行在 rail 首行；实测 16s hold 只触发
  3 次 footer 写）。宿主**完全没有** `setWidget` 时 footer 追加任务名（修订 8，§8 的最后落点）。
- 开关：`PI_ASYNC_HOLD=0` 不注册任何 handler；`PI_ASYNC_HOLD_MS <= 0` 同样关闭。

### 7.2 终态播报唯一性（0.4.3，D-15）

一个终态**只播报一次，且只给一个消费者**。三个可能的消费者：

1. **hold 的 results entry**（§7.1 修订 3）—— in-run、同步落盘，优先；
2. **工具**：`async_wait` 返回的终态行、`async_status` 返回列表里的终态行、`async_logs` 读到的已终态任务；
3. **完成通知** `async-task-notification`（followUp）。

规则：

- 工具把终态交给模型时调 `registry.markConsumed(taskId)`，写持久化字段 `consumedAt`；`claimNotification()`
  与 `resendUnnotified()` 遇到 `consumedAt` 一律跳过 → 消费者 2 赢了，3 不再播。
- **只对终态行上锁**：读 running 任务的部分输出、或列表里看到 running，绝不上锁（否则完成通知会被静默关掉）。
- `onFinalize` 在 run 仍活动（`agent_start` … `agent_settled`）时**不立即入队**：
  - hold 拥有该任务 → 走 §7.1 修订 3 的 relay；
  - 否则挂进 `pendingNotifications`，在 `agent_before_settle`（hold 之后、guard 之前）与 `agent_settled`
    结算：结算时 `sendCompletionNotification` 重新检查全部 latch，已被消费的跳过；
  - session 空闲 → 立即 `sendMessage(followUp, triggerTurn)` 唤醒（行为不变）；
  - `triggerOnCompletion: false` 不延后（它本来就不会多起一个 turn）。
- 为什么必须延后：pi 在 streaming 时只把 followUp 入队，模型**停止**后才投递（`agent-session.js:1959-1962`
  → `agent-loop.js:196-203`）。0.4.2 在 `finalize` 就入队，于是「模型已用 `async_wait` 拿到结果」之后仍
  会在 85–138s 后收到第二条（实测会话 `2026-11-17T02-35-00-296Z_01a1e75b`：wait 02:57:10 / 02:58:16，
  通知 02:59:23 / 02:59:35，均落在 assistant 停止后 +9–12ms）。
- **持久化**：`consumedAt` 写进 `<taskId>.json`（重载后仍生效）；`notified` 保持「host 已接受」语义不变；
  `outputConsumed` 保持原有「输出已读 / #15 提醒抑制」语义，两者不合并。
- **投递通道（修订 2，0.4.4）**：父 run 活动时用 `deliverAs: "steer"`，并在 **`turn_end`** 结算。理由：
  宿主只在模型**不再发起 tool call** 时才抽 `followUp`（`pi-agent-core/dist/agent-loop.js:197`），但
  **每个 turn 边界**都抽 steering（同文件 `:191`），而且 `turn_end` 之后立刻读 steering（`:188-199`）。
  实测反例（0.4.3）：任务 `finishedAt` 04:15:24.745，通知 04:18:23.383 才注入（**+178.638s**），
  因为父会话一直在连续调工具；改用 steer + `turn_end` 结算后，同场景延迟降为一个 turn。
  idle 仍用 `followUp` + `triggerTurn: true`（直接开新一轮唤醒）。
- **单次终态只入队一次**：`pendingNotifications` 以 taskId 为键，flush 前先整体 `clear`，
  `turn_end` / `agent_before_settle` / `agent_settled` 三个 flush 点幂等；`notified` / `notifyAttempts`
  语义不变（发送一次 = `notifyAttempts+1`，host 接受后 `notified=true`）。测试钉住：跨三个边界 +
  `resendUnnotified` 重放后仍只有 1 条、`notifyAttempts === 1`。
- `notifyOnCompletion: false` / `triggerOnCompletion: false` 语义不变。

## 8. TUI（冻结，仅主会话）

- guard：所有 TUI 路径 `ctx.mode === "tui"`（hasUI 陷阱）；rail/面板跳过 rpc/json/print。
- **rail 存在性（产品不变式，0.4.7）**：只要有 `running`/`pending` 任务，输入框上方就**必须**有 rail 行，
  与 hold 生命周期无关（没有任何 hold 时也画）；没有活跃任务时按既有 linger/watermark 规则显示或返回 `[]`。
  rail 的存在不许由“有没有 hold”“hold 结束没有”决定。`registerRail` 因此是**幂等且自愈**的：
  宿主仍持有本 registry 的 widget → 什么都不做；widget 已被宿主 `dispose()`/清空 → 重装
  （`armRailSurface` 保存安装配方，`ensureRailSurface` 以 1s 上限节流）。触发点：首个 TUI 绑定、
  **每个** lifecycle 事件（`session_start`/`message_start`）、任务进入 `running`/`pending` 的 state 事件、
  以及 hold 每帧发现自己没被 rail 覆盖时。rail 读的是**活** registry（`() => activeRegistry ?? registry`），
  所以 `configure()` 采纳上一代工作后不会画出空列表。测试：`tests/e-rail-liveness.test.ts`
  （无 hold 也有 rail / 任务结束行消失 / 宿主清空后自愈 / 无 setWidget 时 hold 带名 / 同一任务集合）。
- **轨道图 widget**（`setWidget("pi-async-rail", factory, {placement:"aboveEditor"})`）：
  整体最多 4 行（`RAIL_MAX_LINES=4`），含首行汇总；任务槽位为 `RAIL_TASK_SLOTS=3`，溢出时为
  `RAIL_TASK_SLOTS_OVERFLOW=2`。无溢出时为汇总 1 行 + 最多 3 行任务；
  有溢出时为汇总 1 行 + 2 行任务 + 1 行溢出指示。任务行格式 `▶ name · state · elapsed`
  （running=类型色 / completed=settled 色 / failed=error / killed=dim；配色走 legion palette
  延迟解析 + OKLab 撞色检测）；wheel 滚动；press→latch→click 命中任务 → 打开详情。
  鼠标事件仅在 fullscreen / alt-screen（开启鼠标上报）时可用；regular 模式用 `/async` + 键盘。
  `renderRailRows(snapshots, width, now?)` 为纯函数，内部最多渲染 3 个任务行；没有可见任务时
  整个 widget 返回 `[]`，不显示汇总行。
  **hold 期间首行不是汇总行（修订 8，0.4.8）**：hold 在等时首行换成等待行
  `⠙ async_wait · running <hold-elapsed> — Esc stops waiting`（顶掉汇总行，不是新增一行），
  `▶ name · state · elapsed` 任务行、任务槽位数与总行数上限（4）都不变；hold 结束后首行自动回到汇总行。
- **汇总行**：由 `summarySegments`/`formatSummary` 生成，段序为 `▶ N running · N pending · <elapsed> · ✓N · ✗N`；
  `pending` 仅在数量大于 0 时显示；`✓N` 与 `✗N` 对称，均仅在各自数量大于 0 时显示
  （全失败场景不再出现绿色的 `✓0`）；无 running 时 elapsed 为 `—`。
  **单任务不显示时长（修订 6，0.4.6）**：`running + pending === 1` 时整段 elapsed 省略（`▶ 1 running`），
  因为 rail 恰好只渲染那一行任务，其行尾耗时就是这个数字；0 个活任务保留 `—`（没有可重复的对象），
  ≥2 个活任务保留汇总时长（没有单独一行能读到它）。
  `▶` 在 running/pending 非零时为 accent、否则 dim；running 数为 accent，pending/elapsed 为 dim，
  完成数为 success，失败数为 error。宽度不足时优先移除可选段并 truncate，再上色。汇总行不可点击。
  running/pending 始终计数；完成数与 failed/killed 失败数仅统计通过 `/async-clear` 共享 watermark 的终态任务。
  1Hz 重绘 ticker 归 rail widget 所有，保证 elapsed 持续跳秒。
- **footer 默认关闭（opt-in，REV-12 + PLAN §2.9）**：任务汇总默认在 rail 首行，不调用
  `setStatus("pi-async", …)`；仅当 `PI_ASYNC_FOOTER=1` **且**宿主 `ui.setStatus` 存在时，渲染一行
  汇总（可选、默认关闭）。`initStatus` 保留 `reportActivity`（feature-detect），`setStatus` 调用为
  best-effort（宿主拒绝不得影响会话）。`clearedAtMs`/`survivesClearCutoff`/`clearDoneStatus`
  保留，由 `panel.ts` 与 `/async-clear` 共享。
- **判活与退出码的显示（REV-35，0.5.4）**：终态快照不声称进程存活；未知写 `null`。**每一个终态快照**的
  详情状态行都追加 `· process: exited|alive|unknown` 与 `· exit <code>|exit unknown`（行数不变，接在
  `status:` 那行后面；运行中的快照不追加，它还没有主张）：`process: unknown` **绝不**渲染成 `exited`，
  `exit unknown` **绝不**渲染成 `exit 0`。旧快照没有这两个字段 → 按「未知」显示，不做迁移、不推断。
- **面板**（仅 `/async`）：`ctx.ui.custom({overlay:true, overlayOptions:
  {width:"80%", maxHeight:"70%", anchor:"center"}})`；从 rail 点击直入详情时为
  `{width:"85%", maxHeight:"80%", anchor:"center"}`。固定百分比尺寸，不提供环境变量开关。
  自绘 mask+frame（legion live-overlay 模式）；左列任务列表（含历史，`h` 切换），点击/Enter 进详情：
  identity/status/elapsed/command/metadata + 输出 tail（128KiB UI 缓冲；详情体是一个**视口**：title/status
  与 footer 键位提示固定，中间全部内容（三条分隔线、command、metadata、output 标签、全部输出行）
  一起滚动，跟随滚动、上滚暂停；见 §21.1 / §24）；
  键位 `x`（或 `K`）kill（二次确认）/`R` rerun/`c` **显示** output 路径（不是复制）/`q` 关闭；
  **`R` rerun 的复刻边界（#100）**：cwd = 原任务 cwd（REV-13）；env **不复刻** —— 快照不存 env
  （`TaskSnapshot` 无该字段），rerun 只传 `command` / `name` / `mode` / `cwd`（`src/tui/panel.ts:532-537`），
  子进程拿**当前** `process.env` + 当前 `PI_ASYNC_ENV_INHERIT` 策略（`src/core/spawn.ts:78`）；
  `watch` / `taskTimeoutMs` / `notifyOnCompletion` / `triggerOnCompletion` 同样不复制。
  **详情内 `↑`/`↓`/`j`/`k` 只滚视口、不改选中任务，换任务用 `[`（上一个）/`]`（下一个）**（REV-31）；
  列表内 `↑`/`↓`/`j`/`k` 仍是选择，`k` 不是 kill（REV-18）。Esc 层级：rail 点击直入详情后 Esc 关闭；
  列表内进入详情后 Esc 回落列表。面板为单例：已打开时再次 `/async` 只 `ui.notify("Async panel is already open")` 后
  返回（不叠加 overlay、也不主动 re-render）；面板刷新 = `registry.subscribe` 事件驱动 **+ 面板自有
  1Hz ticker**（§21.1），`dispose()` 退订并清 timer；详情帧保留 header（title + status）+ footer 键位提示，
  高度不足时 command/metadata 落在窗口外（顶部 `… (+K lines)` 的 K = 窗口上方隐藏行数，上滚可读回），
  退化到连一行内容都放不下时先留 footer（告警 + 键位提示）再补 title。
- **rail 不按 mode 过滤**：background 与 delayed 都注册成真实任务，delayed 的 pending 期与到期后的
  running 期都出现在 rail（REV-29：sync 已删除，rail 配色槽位不变 —— background=0 / delayed=2）；
  任务行只渲染 `name · state · elapsed`，不显示 mode，仅用配色区分（见上方任务行格式）。
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
  - **硬顶 8 MiB（`MAX_LOG_WINDOW`）**：`maxBytes` 一律先夹到 `min(请求值, 8 MiB)` 再读，防误传超大窗口
    导致无界分配；模型侧默认窗口仍是 50 KiB。
- ANSI/CSI/OSC 剥离：`async_logs` 返回与 TUI 显示前必须剥离（安全项，防输出注入转义序列）。
- ~~sync 返回 outputTail ≤ 8 KiB / 200 行~~（REV-29 删除：`async_run` 不再返回 outputTail；读取窗口统一走
  `async_logs`，默认 50 KiB / 走 §9 的 8 MiB 硬顶）。

## 10. 杀伤与清理（冻结）

- detached 进程组 spawn（POSIX only，平台边界见 §12）；kill：SIGTERM → 3s grace → 组 SIGKILL → 有界探测；
  无法证明死亡 → 响亮报错「Descendant processes may have leaked」。
- `session_shutdown(reason)`（REV-17）：`reload` / `resume` → `registry.suspend()`（停 timer/watch、
  持久化快照，**不 kill 进程**，交给下一代 `configure()` 收养；无后继代时由同一实例的下一次
  `configure()` 回收，见下方 REV-28a 段与 §19.6）；`quit` / `new` / `fork` / 未知 →
  `registry.shutdown()`（幂等：admission close + drain + **running 任务** kill(kind=shutdown)；
  pending（delayed 未到期）**不杀、不改状态**，仅清 delay timer/watch 并保留 pending 快照，
  以便同进程 reload 继续恢复）；
  **不承诺 crash-durability**（metadata 原子写，output 不 fsync）。
- reload / 重启恢复（REV-17）：同进程 `/reload` 不杀任务；新代 `configure()` 重新载入后按持久化的
  `timeoutAt` / `watchDeadline` / `cwd` 重建剩余预算（不是重置）；running 且 pid 已死/无 pid → 标 failed(lost)；
  pending delayed 在**下一个加载该 dataDir 的会话**（不区分进程）中按剩余 delay 恢复计时。
  **0.4.2 修订（REV-28a，事故驱动）**：`suspend()` 之后若宿主**没有**重建扩展（reload/resume 无后继代），
  同一实例的**下一次 `configure()`** 就是回收路径，且**顺序冻结**：
  (1) `fenceRetiredHandles()`：清 `suspended`、给所有旧 `live` 句柄打 `retired`（其迟到 exit 回调与
  仍在 `await killTree` 的旧 `kill()` 一律 no-op，绝不覆写复活后的快照）、清 timer/watcher、
  `stopLiveness()`；
  (2) 原样走 cwd/dataDir 的 `changed`/`migrateDataDir`/`switchDataDir` 决策——**此时非终态快照仍在内存**，
  迁移才能重写它们的 `metadata.outputFile`（先删任务会让迁移看不到它们：任务被遗弃，或收养后
  `logs()` 抛 `Refusing to read task output outside the async data directory`）；
  (3) `dropForReAdoption()`：从 `tasks`/`live` 移除非终态快照并清 `notifyClaims`（终态快照留内存），
  然后走既有的 `reloadFromDisk()` + `reapOrphans()`（此时无 id 冲突）。
  收养后 running+活 pid → 建 100ms watcher 并按剩余预算重挂 `timeoutAt`/`remindAt`/watch；
  running+死 pid → `failed` + `failureKind:"lost"` + `finishedAt` 并落盘。
  磁盘快照**缺失/损坏**（`<taskId>.json` 被删或非法 JSON）时，被 `dropForReAdoption()` 删掉的对象必须
  回填并按 `failed/lost` 结算一次：否则任务静默消失——无终态、无 state 事件、宿主 per-task activity 幽灵 spinner。
  **kill 跨复活的语义**：`async_kill` 已经在 `await killTree()` 时，若期间发生 suspend+configure，它**不**结算
  任务（stale 句柄闸门）——工具返回复活后的 `running` 状态（`processAlive` 按探测结果），随后由复活后的
  watcher/巡检按 `lost` 结算。这是有意的：进程已死这件事只有复活后的所有者能诚实记录。
  修订原因：`suspended` 此前**没有任何复位路径**，一代被退役而宿主无后继代时，退出回调永远不履约
  （不 finalize、不落盘、不通知），任务 JSON 停在开始快照、状态永远不翻，且 admission 恒报 suspended ——
  整个会话的 async 永久不可用。同实例的下一次 `configure()` 是该止血点。
- **运行时存活巡检（REV-28c，0.4.2）**：注册表按 `livenessIntervalMs`（默认 5000ms，env
  `PI_ASYNC_LIVENESS_INTERVAL_MS`，`unref()`）巡检；仅在有非终态任务时惰性启动、无则停，
  `suspend()`/`shutdown()` 必须清除；**`<= 0` 关闭巡检**；巡检**绝不** kill 进程。
  判据：非终态里 running 且进程组已死/无 pid，**连续两次观测**（`Map` 计数，观测到活即清零，
  任务终态/被移除即清理）→ `failed` + `failureKind:"lost"`（与加载期同形，落盘并通知）；
  pending **不**发明新语义（仍按加载期处理）。
  修订原因（两条）：退出回调只在未被退役的代里履约，丢句柄/跨代路径下没有第二条收尾通道，幽灵 running
  会无限涨计时；**两轮确认**是 0.4.2 reviewer 实测后修订的——单轮会在「OS 已退出 / Node 尚未派发 `exit`」
  的窗口误判（注入 1ms 间隔时 40 个 `true` 任务里 33 个被误标 `failed/lost`），且 `setsid sleep &` 型
  leader 先退、真实 exit 码是 0 的守护任务会被巡检抢先判死。
  **胜负是结构性的，不靠两个间隔的相对大小**：巡检在 `spawnExitGraceMs > 0` 且该任务的 spawn 句柄
  **已观测到子进程 `exit`** 时直接跳过（`SpawnHandle.exitObserved`）——exit 一旦被观测，REV-28d 的兜底
  必然接手结算，巡检永远不抢；`spawnExitGraceMs <= 0`（兜底关闭）时巡检仍是唯一结算者。改前
  `{livenessIntervalMs:1000, spawnExitGraceMs:5000}` 会让巡检抢赢，同一命令默认参数却是 `completed/0`。
- **spawn 退出兜底（REV-28d，0.4.2）**：`'close'` 仍是主信号；新增 `'exit'` 兜底——子进程退出后若流在宽限窗口
  （默认 5000ms，env `PI_ASYNC_SPAWN_EXIT_GRACE_MS`，可注入）内没全部 end（孙进程持有 fd 1/2 时 `'close'`
  永不到达），用退出码 settle 并结束写流。宽限前已写出的输出保留，迟到输出可丢；统一 `settled` 守卫，
  禁止重复 settle。**`<= 0` 关闭兜底**（不是「立即结算丢输出」）。
  `<= 0` 只有两层能取到：构造函数注入（`TaskRegistry({ spawnExitGraceMs: 0 })` / `{ livenessIntervalMs: 0 }`）
  才是「显式关闭」；env 走 `min: 0`，**负数/非法值回退默认值**，env 只能写 `0` 关闭。
  修订原因：`close` 依赖全部 stdio 关闭，孙进程持有 fd 时收尾会永久悬挂。
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
  - **跨 dataDir 回收与全局字节配额（#102 / REV-32，两者默认关闭）**：`PI_ASYNC_SWEEP_SIBLINGS=1` 时，
    `configure()`（低频、带节流）会回收 `dirname(dataDir)` 下**其他** session 目录；`PI_ASYNC_TOTAL_BYTES` > 0 时
    按**字节**记账并淘汰终态产物。未开启时本条其余行为一字不变（不 stat、不 readdir）。详见 §25。
  - 孤儿 `running` 同样由 `reapOrphans()` 处理。

## 11. 配置与环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_ASYNC_MAX_OUTPUT_BYTES` | 20 MiB（`20971520`） | 写盘 cap；超限 → kill(kind=output_cap) → failed |
| `PI_ASYNC_MAX_TASKS` | `32` | 注册表上限（running + pending），超了拒绝新任务 |
| `PI_ASYNC_EXPOSE_WAIT` | 关闭（未设） | `1` → 额外注册 `async_wait`（默认 5 个工具，暴露后 6 个；REV-29）。每次调用重新读 env |
| `PI_ASYNC_ENV_INHERIT` | `safe` | 子进程 env 策略：`safe` 剥离敏感键（含 `npm_config_*` 中带 auth/token/password 的键）并拒绝危险显式键；`all` 恢复完整继承（显式危险键覆盖**在任何策略下仍被拒绝**）；`none` 只给 `PATH`/`HOME`/`SHELL`/`TERM`/`LANG`/`LC_*`/`TMPDIR`/`USER`（存在的）。未知值按 `safe` 处理 |
| `PI_ASYNC_SETTLE_GUARD` | 开启（未设） | `0` → 守卫不注册任何 handler |
| `PI_ASYNC_NUDGE` | 开启（未设） | `0` → 不注册 `tool_result` / `context`(+"_with_system") 情境钩子（REV-21） |
| `PI_ASYNC_HOLD` | 开启（未设） | `0` → settle hold 关闭，一个 handler 都不注册（D-14） |
| `PI_ASYNC_HOLD_MS` | `600_000`（10 分钟） | 单次 hold 上限（单调时钟计时）；**≤ 0 关闭**（负数不会回退到默认值） |
| `PI_ASYNC_HOLD_POLL_MS` | `1_000` | hold 期间轮询 `registry.list` 的间隔（低于 50 回退默认） |
| `PI_ASYNC_PRINT_WAIT` | 开启（未设） | `0` → headless（`pi -p`）保底关闭，一个 handler 都不注册，回到 0.4.x「进程可以带着未完成任务退出」（REV-30） |
| `PI_ASYNC_PRINT_WAIT_MS` | `600_000`（10 分钟） | print 会话等待的整体预算（单调时钟，从第一次真正等待开始，跨回合累计，不重置；**回合之间的 provider 时间也计入**）；用尽 → 打印仍在跑的任务并 `exitCode=1` |
| `PI_ASYNC_PRINT_POLL_MS` | `500` | print 会话等待期间轮询 `registry.list` 的间隔（低于 50 回退默认） |
| `PI_ASYNC_PRINT_MAX_CONTINUATIONS` | `5` | print 保底允许消耗的强制续跑次数（整个进程累计，宿主不提供上限，见 REV-30）；**`0` = 从第一个边界起就限流**（有 running 任务即打印并退 1） |
| `PI_ASYNC_FOOTER` | 关闭（未设） | `1` 且宿主 `ui.setStatus` 存在时额外渲染一行 footer 汇总；rail 首行仍是默认状态面 |
| `PI_ASYNC_RETENTION_MS` | `604_800_000`（7 天） | 终态任务产物保留时长；与 COUNT 取并集 |
| `PI_ASYNC_RETENTION_COUNT` | `100` | 每个 dataDir 最多保留的「最新」终态任务数；与 MS 取并集 |
| `PI_ASYNC_SWEEP_SIBLINGS` | `0`（关闭） | #102 / REV-32：`1` → `configure()` 回收 `dirname(dataDir)` 下的其他 session 目录（三闸，见 §25） |
| `PI_ASYNC_SWEEP_SIBLING_AGE_MS` | `1_209_600_000`（14 天） | #102 / REV-32：sibling 目录的空闲时长下限（取 `max(该值, PI_ASYNC_RETENTION_MS + 1)`，即**永远**严格大于 retention 窗口） |
| `PI_ASYNC_SWEEP_INTERVAL_MS` | `60_000` | #102 / REV-32：`configure()` 触发存储巡检的节流间隔；`0` = 每次 configure 都跑 |
| `PI_ASYNC_TOTAL_BYTES` | `0`（关闭） | #102 / REV-32：**全局**字节配额（单位：字节，统计 `.json`/`.output`/`.stdout`/`.stderr`），跨整个 sweep root；`0` = 不限 |
| `PI_ASYNC_QUOTA_HARD` | `0`（关闭） | #102 / REV-32：`1` → 配额超限时**也**淘汰仍在 retention 窗口内的终态产物（逐条先日志再删）；默认只淘汰 retention 本来就该丢的，超了就报「配额已满」 |
| `PI_ASYNC_RAIL_LINGER_MS` | `30_000` | 终态任务在 rail 上滞留时长 |
| `PI_ASYNC_LIVENESS_INTERVAL_MS` | `5000` | 运行期存活巡检间隔（REV-28c）；**`0` 关闭巡检**；负数/非法值回退默认（`min:0`）；连续两次观测到进程组消失才结算，且已观测到 `exit` 的任务一律跳过 |
| `PI_ASYNC_SPAWN_EXIT_GRACE_MS` | `5000` | `'exit'` 退出兜底宽限（REV-28d）；**`0` 关闭兜底**，回到「只听 `'close'`」（此时巡检是唯一结算者，连续两次观测到进程组消失后按 `failed`/`lost` 结算）；负数/非法值回退默认（`min:0`） |

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
- 发布流程（**版本号不在本条目写死**：0.3.1 见 §17，0.4.0 见 §18–§19；实际值以 `package.json` 与
  `package-lock.json` 为准）：peerDependencies 保持 `^1.2.0`
  （**不抬下限、不进 dependencies**）；CI 是 node 22/24 matrix + 一个 pi 1.5.0 相容 job（`npm install
  --no-save @earendil-works/pi-coding-agent@1.5.0 @earendil-works/pi-tui@1.5.0`）；
  `.github/workflows/release.yml` 由维护者推送 `v*` tag 触发（**不自动建 tag**），也支持
  `workflow_dispatch` 手动运行（用于「tag 已存在、补发当前 package.json 版本」）；执行
  `npm run verify` → 校验 tag 与 package.json 版本一致（仅 tag 触发时）→ `npm publish --provenance`
  （**Trusted Publishing / OIDC**：`id-token: write`，**无 `NODE_AUTH_TOKEN` / `NPM_TOKEN`**）→
  `gh release create --generate-notes`（`GITHUB_TOKEN`）。
- **平台 = POSIX only（#100）**：依赖 `/bin/sh -c` + `detached` 进程组（`src/core/spawn.ts:80`）、负 pid
  进程组信号（`spawn.ts:226,230`）与 `/proc/<pid>/stat` 判活（`spawn.ts:198-201`、`registry.ts` 的
  `pidAlive()`；缺 `/proc` 时退化到 `kill(-pid, 0)`，僵尸组不再区分）。支持 Linux 与 macOS（后者无 `/proc`，走退化
  路径），**Windows 未支持/未验证**；CI 只跑 Ubuntu（`.github/workflows/ci.yml:17,53,91`）。不加
  `package.json` 的 `os` 字段：那会把「不承诺」变成 npm 拒装，属行为变更，需 REV。
- **工具面是冻结契约（#100）**：增/删/改名/改默认注册面必须新增 REV 段（格式同 §16：原因 / 影响面 /
  回退开关）+ 验收清单 + CHANGELOG 段 + 迁移说明，并同步 `tests/k-toolsurface.test.ts` 与 §17 的
  snippet 清单。第 6 席已被 `async_wait`（仅 `PI_ASYNC_EXPOSE_WAIT=1` 暴露）占用：新增 list/attach
  工具实际是第 7 个，或顶掉 `async_wait`，不是「用空位」。破坏性判据（任一命中即按破坏性处理，必须给
  迁移说明）：删除或改名工具；修改已有参数的类型/必填性/默认值；修改返回 payload 字段或 `isError`
  语义；改变默认注册面（把可选工具转默认、收紧或更换 env 开关、改默认工具数量）。纯新增且默认不注册
  的工具仍是工具面变更（需 REV），但可标注「非破坏」并只给开启方式。
- vendor/reference 不编译不 import，只作参考。
- MIT License；legion viz 整块复用处保留 attribution 注释。

## 13. D 编号决策（已定，reviewer 对照用）

| # | 决策 |
|---|---|
| D1 | 不做子 agent 委派（delegate/attested/Fusion），只做 shell 任务运行时 |
| D2 | ~~sync 模式 timeout 必填，默认 promote 而非报错~~ **REV-29 删除**：`mode=sync` 与 `timeoutMs`/`onTimeout` 一并移除；阻塞收割改由可选的 `async_wait`（`PI_ASYNC_EXPOSE_WAIT=1`）承担 |
| D3 | async_wait timeout 必填；返回 notReady 不杀任务 |
| D4 | success_when 命中不杀进程（completed 是观察结论，进程归 taskTimeout/kill 管理） |
| D5 | 通知 completed 纯信息；failed 与 `killed`+`killKind=timeout` 带 guidance；outputConsumed 闩防 chatter（REV-21 修订） |
| D6 | TUI 仅主会话；subagent 自动退化纯工具面（mode guard） |
| D7 | OSC busy 上报 feature-detect + settle 前上报闭合竞态（#156 契约）；未落地静默降级 |
| D8 | 不改 legion/pi 本体；busy-hold 走上游（#156 + 补充评论已发） |
| D9 | delayed：reload 恢复计时；dataDir 变更（切 session）时 copy+rename 迁移 `.json/.output/.stdout/.stderr` 并重写 `metadata.outputFile`，任务不丢（§10 / REV-17） |
| D10 | settle 守卫每 run 重武装、累计 ≤3 次，超限放行但保留未决清单提示 |
| D-14 | settle hold（§7.1）：仅在交互 TUI 会话、且存在会唤醒会话的 **running** 任务时，在 `agent_before_settle` 内等它们全部终态再 settle（上限 `PI_ASYNC_HOLD_MS`，默认 600000ms，单调时钟；**出口**：全终态 / 超时 / **Esc** / **用户已入队消息** / dispose，见 §7.1 修订 4）；全部终态时自带 `async-task-settle-results` entry + `continue: true`（不内联 outputTail），超时原样放行；`pending`/delayed、军团 child、`print`/`json`/`rpc` 都不 hold；**修订 3（0.4.3）**：hold 等待期间快照内任务的完成通知被扣住，全终态时由 results entry 独占播报并落 `notified`，非全终态出口则原样交还；**修订 4（0.4.3）**：Esc 经 `ui.onTerminalInput` 毫秒级释放，用户入队消息下一 poll 释放，hold 期间自带 250ms 刷新的 widget 进度行（修订 1 / 2 / 3 / 4） |
| D-15 | 终态播报唯一性（§7.2，0.4.3）：`consumedAt` latch；`async_wait`/`async_status`/`async_logs` 交付终态即上锁；run 活动期通知不立即入队，延后到 turn/ settle 边界再裁决；`claimNotification`/`resendUnnotified` 跳过已消费任务；只对终态行上锁；**修订 2（0.4.4）**：活动 run 用 `deliverAs:"steer"` + `turn_end` 结算（`followUp` 只在模型停手时才抽），idle 仍 `followUp` + `triggerTurn` |

## 14. 验收清单（verify 门禁）

1. `npm run verify` 全绿（= `npm run typecheck` && `npm test`），且 `npm pack --dry-run` 包含
   `extensions/`、`src/`、`README.md`、`LICENSE`、`docs/CONTRACT.md`、`CHANGELOG.md`
2. background 任务：启动→立即 receipt→完成通知唤醒（RPC 模式实测；**print 模式改为 §23 REV-30 的
   结构性保底**：`scripts/headless-smoke.sh wait` 断言任务完成后模型被再次唤醒且其结论进入 stdout）
3. ~~sync：短命令阻塞返回 exitCode；长命令 timeoutMs 到点 promote 转 background~~ **REV-29 删除**：
   验收改为「`mode=sync` 被 execute 白名单拒绝（`Unsupported async_run mode: sync`），schema 不再含
   `timeoutMs`/`onTimeout`」（`tests/k-toolsurface.test.ts`、`tests/w2-safety.test.ts`）
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
  `async_kill` 接受 name；未知 id/name → `Unknown task or name: ...` + `isError`；~~非 sync 传 `onTimeout` → throw~~（REV-29 删除）；
  sync 以非 0 状态**真的结束**时 → `isError:true`（详情见 REV-19；payload 保留完整 `SyncResult`）；`async_status` 新增
  `status` / `name` / `limit`（1–50，默认 50），`includeHistory` 与显式 `status` 按
  `(finishedAt ?? createdAt)` 降序；`delayedEnv` 值打码为 `***`。
  - `async_kill` 的返回形状：`{ taskId, status, killKind?, alreadyTerminal, processAlive, warning? }`；
    `isError` 判据为 `Boolean(warning && status !== "killed")`——「确认不了死但任务已 killed」只作
    `warning` 呈现，不算工具错误；未知 id/name 照旧抛错。
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
- **REV-29 删除**：整条随 `mode=sync` 一起作废（`runSync` / `SyncResult` / `promoted` 均已不存在）。

## 17. 0.3.1 可发现性修订（REV-20 … REV-22）

基线 `main @ 5d77350`（0.3.0）。计划文档：`docs/PLAN-CONTEXT.md`。本节取代 0.3.0 的 D-17
（「只有 async_run 带 snippet」）与 D5 的「仅 failed 带 guidance」。

### REV-20（工具全部进系统提示；0.4.0 增补 `async_extend`，见 §18；REV-29 改为默认 5 个 + 可选 `async_wait`）

- **原因**：宿主只把带 `promptSnippet` 的工具列进系统提示的 Available tools 段（pi 1.5.0
  `dist/core/system-prompt.js:84-85`）。0.3.0 只给 `async_run` 挂了 snippet，`async_wait` /
  `async_logs` / `async_status` / `async_kill` 在模型主视觉区缺席，且该不对称被测试冻结。
- **影响面**：**默认 5 个工具**（`async_run` / `async_logs` / `async_status` / `async_kill` / `async_extend`）
  各带一条 snippet（逐字）；`PI_ASYNC_EXPOSE_WAIT=1` 时第 6 个 `async_wait` 也带同一条（REV-29）：
  - `async_run`：`Run a long or gating shell command detached (build/test over a minute, server, watcher); returns a taskId, not output.`
  - `async_wait`：`Block until async tasks finish or the budget expires; results land in context. Never kills.`
  - `async_logs`：`Read the bounded, ANSI-stripped output of an async task, including while it is still running.`
  - `async_status`：`List active async tasks with elapsed time; includeHistory for recent finished ones.`
  - `async_kill`：`Stop an async task and its whole process group.`
  - `async_extend`：`Renew a running task: move its reminder and/or hard-timeout deadline. Never kills; use async_kill to stop.`
- `async_run.description` 收缩为两句：
  `Run a shell command as a managed async task. mode=background (default) returns a taskId immediately; mode=delayed starts after delayMs.`
  （REV-29 删除 sync 半句。）check 纪律从 description 移除（见 REV-22）；模式语义下沉到字段级 description。
- `promptGuidelines`（逐字；0.3.0 为 3 条，0.4.1 起第 4 条见 §21.2，区分主会话与 child）：
  1. `Reach for async_run before bash when a command may outlive ~60s or never exit (builds, test suites, dev servers, watchers, network waits); quick file operations stay in bash.`
  2. `Do not sit in async_wait only to end a turn: if you do not need the result yet, end the turn and the completion notification wakes you. In a legion child, collect with async_wait before returning a verdict.`
  3. `Pass name so later calls address the task by name, and read output with async_logs (works while running) instead of re-running the command.`
  4. （0.4.1 / REV-27，§21.2）`Plan the batch first: launch independent long commands together (several async_run calls in one message) and collect them with a single async_wait later.`
  5. （REV-29，仅 `!waitToolExposed()` 时追加）`async_wait is not available in this session (set PI_ASYNC_EXPOSE_WAIT=1 to expose it); end the turn and the completion notification wakes you, and read output with async_logs.`
- 前 4 条顺序/内容**逐字冻结**（`tests/d-tool-contract.test.ts` 逐字 pin）；第 5 条是暴露态的纯追加，
  暴露时不出现。
- **回退开关**：无（文案是产品面，不是行为开关）。

### REV-21（情境注入：bash 事后教学 / 活跃状态行 / 主会话 settle 建议 / timeout guidance）

- **原因**：静态 snippet 无法表达「你刚才把 90 秒的命令放进了前台」或「你现在有 2 个任务在跑」。
  0.3.0 在 `tool_call`/`tool_result` 上零钩子，也无法在主会话提示「带着任务结束 turn 是允许的」。
- **影响面**（新模块 `src/context/nudges.ts`，均 best-effort、绝不抛异常）：
  - `tool_result`（仅 `toolName === "bash"`）：`wall_time_seconds >= 60` 或命令匹配
    `/\btail\s+-[fF]\b|\buntil\s|\bwatch\s+\S|\bsleep\s+\d{2,}/` 时，在 content 末尾追加一行（保留
    `structuredContent`）：
    `(took {N}s in the foreground; async_run could have run it in the background — use mode=background with watch for servers/builds; end the turn and the completion notification wakes you)`
    （REV-29：`mode=sync` 半句删除，见 §22。）
    （无 wall time 时删掉 `took {N}s in the foreground; `）。`structuredContent.wall_time_seconds` 缺失时，
    用 `tool_execution_start` 记录的起点计算耗时（`tool_result` 在 `afterToolCall` 内触发，早于
    `tool_execution_end`，此时 `durationMs` 尚不可用）；`tool_execution_end` 负责清理残留条目。
  - `context_with_system` **与** `context` **两个钩子同时注册**（不按宿主择一：注册期无法可靠判断宿主
    用哪个），靠 signature 去重保证宿主不会收到重复内容：有活跃任务时在 messages 末尾追加一条 user 消息
    （`UserMessage` 必须带 `timestamp`）：
    `<async-state>{n} async task(s) active: {name (status, elapsed[, no-notify]) · …}{ +K more} {tail}</async-state>`
    默认最多 5 项；空闲时返回 `undefined`（零 token）；任务集合或状态不变时不重复注入；`agent_start` 重新武装。
    `tail` 按**真实的每任务通知开关**选择（`notifyOnCompletion === false` 或 `triggerOnCompletion === false`
    的任务标 `no-notify`）：
    - 全部会通知：`— end the turn and the completion notification wakes you.`（REV-29 默认；
      暴露 `async_wait` 时追加 `, or call async_wait if you need one now.`）
    - 混合：`— end the turn and let notifications wake you where enabled; read the rest with async_logs.`
      （暴露时为 `… or call async_wait for the rest.`）
    - 全部不会通知：`— none of these will notify you; collect them with async_logs before you need the result.`
      （暴露时为 `collect them with async_wait …`）
    理由是 0.3.0 的核心不变量：不得用全局断言陈述 per-task 事实。
  - **REV-29 前的原始文案（回滚时逐字还原用）**：全唤醒
    `— end the turn and the completion notification wakes you, or call async_wait if you need one now.`；
    混合 `— end the turn and let notifications wake you where enabled, or call async_wait for the rest.`；
    全不唤醒 `— none of these will notify you; collect them with async_wait before you need the result.`；
    bash nudge 尾巴 `, or mode=sync with timeoutMs when you need the result soon)`。
    REV-29 只改「默认（未暴露 `async_wait`）」这一路的措辞，暴露态仍用上面四句原样。
  - `async_run` receipt（REV-21，修正版 D-C5）：通用规则只在系统提示/`<async-state>` 里讲一次；
    receipt 只承载**例外**。`notifyOnCompletion: false` → `willNotify: false` + `outputHint`
    `Notifications are off for this task; collect it with async_wait or async_logs.`；
    `triggerOnCompletion: false` → `willWake: false` + `outputHint`
    `This task will notify but will not start a new turn; collect it with async_wait if you need the result now.`；
    默认情况不新增字段（不重复计费）。**REV-29**：`!waitToolExposed()` 时这两条 hint 的 `async_wait` 半句
    改为 `async_logs`（`… collect it with async_logs.` / `… collect it with async_logs if you need the result now.`）。
  - 主会话 `agent_before_settle`（见 §7）：`async-task-settle-advisory`，**全部任务都会唤醒会话**时文案为
    `{n} async task(s) still running: {ids}. If this answer does not need them, stop here — their completion notifications will wake you.`
    （**REV-29** 默认；暴露 `async_wait` 时追加 ` Otherwise collect them with async_wait.`）
    每 generation 最多 1 条，**不带 `continue`**。
    **修订 1（0.4.3）**：「会唤醒」= `running` + `notifyOnCompletion !== false` + `triggerOnCompletion !== false`
    （与 hold 的 holdable 同一判定）。混合时改用
    `{n} async task(s) still running: {ids}. {w} of them will wake you when they finish; collect the other {n-w} with async_logs if you need them now.`
    （**REV-29** 默认；暴露 `async_wait` 时为 `with async_wait`）；
    一个都不会唤醒时改用
    `{n} async task(s) still running: {ids}. None of them will start a new turn; collect them with async_logs if you need one now.`
    （暴露时为 `with async_wait`）
    —— 不得用整句笼统断言「通知会唤醒你」（§13 的 per-task 事实原则）。
  - timeout 通知：`killKind === "timeout"` 时 guidance 为
    `Killed at taskTimeoutMs. Rerun with a larger taskTimeoutMs, or watch for a success_when condition instead of a hard deadline.`
    `buildNotificationXml` 的发送门放宽为 `(status === "failed" || killKind === "timeout") && guidance`；
    `status` 仍是 `killed`（行动建议，不改判状态）。
- **回退开关**：`PI_ASYNC_NUDGE=0` 关闭 `tool_result` / `context` / `tool_execution_*` 钩子；settle 建议随
  `PI_ASYNC_SETTLE_GUARD=0` 一起关闭。
- **度量**：`npm run adoption`（`scripts/adoption-report.mjs`，dev-only，不进包）读 pi 会话 JSONL 的
  `toolResult.durationMs`，复用 `bashNudge` 谓词输出「覆盖率 / 前台阻塞时间 / sleep 轮询占比」。
  2026-11-06 基线（本机 15 个会话）：bash 1710 次、`async_run` 2 次（0.1%）、≥60s 50 次（2.9%，
  111.7 分钟）、nudge 覆盖 88 次（5.1%）、sleep 轮询 29 次（47.1 分钟）。

### REV-22（长纪律移入随包 skill）

- **原因**：check 纪律（不 `|| true`、未知态映射失败、`jq -e`、regex 锚定、ReDoS 形状）原本硬拼在
  `async_run` 的 description 尾部（~450 字符），既挤占工具面又埋没「何时该用」。
- **影响面**：新增 `skills/async-tasks/SKILL.md`（frontmatter `name` + `description`），经
  `src/context/resources.ts` 的 `resources_discover` 以 `{ skillPaths: [<包根>/skills] }` 注册；
  目录缺失时返回 `undefined`（静默降级）。`package.json` 的 `files` 增加 `"skills/"`。
  工具面的 `watch` 字段保留一行压缩版纪律（OR-ed / first-match-wins / 不吞错），其余全文进 skill。
- **验收**：`tests/e-skill.test.ts` 断言 frontmatter、关键事实（64K characters、OR-ed、`|| true`、
  `jq -e`、`taskTimeoutMs`、`blind_checks`）与发布清单。
- **回退开关**：无（skill 缺失自动降级为「没有 skill」，工具面不受影响）。


## 18. 0.4.0 提醒与续期（REV-23，冻结）

起因：`taskTimeoutMs` 只有硬杀一档，杀掉正在跑的长构建比不杀更糟；而没有硬期限的 background
任务跑飞了又没人管，agent 会卡在等待或忘记自己还挂着活。裁决：**提醒 ≠ 杀**。提醒是注意力信号，
杀是进程生命周期决策，两者分离。

### 18.1 旋钮

```ts
// async_run 新增可选字段
remindAfterMs?: number   // 首次提醒的运行时长；0 = 关闭；缺省见 18.2
```

`taskTimeoutMs` 语义**不动**：仍是 agent 主动可选配置的硬杀，**不设默认**。

### 18.2 默认策略（REV-23 裁决）

有效间隔 `effectiveRemindMs` 在任务**开始运行时**求值，按顺序：

1. 显式 `remindAfterMs` 优先（`0` = 关闭）。
2. 否则任务带 `watch` → 关闭（watch 的 `timeoutMs` 已是期限，避免同一个超时出现两种终态语义）。
3. 否则 → **20 分钟**（`1_200_000` ms）。
4. 若 `task.timeoutAt` 存在且 `now + effectiveRemindMs >= task.timeoutAt` → **不布防**
   （硬期限必然先到，不做注定迟到的提醒）。

`notifyOnCompletion: false` → 提醒一并静默（单一「打扰面」开关）。

### 18.3 提醒消息形状

- `customType: "async-task-reminder"`，`deliverAs: "followUp"`，`triggerTurn: true`（与完成通知同通道）。
- XML 字段：`task-id` / `name` / `status` / `elapsed-ms` / `remind-count` / `output-file` /
  `summary`（tail）/ `guidance`。
- 只带 tail 切片（与完成通知同一日志读取路径，8 KiB / tail），**绝不带全量输出**：提醒会烧 token
  并触发新 turn。
- `guidance` 固定语义：还在跑、没有硬期限、不会被自动杀；`async_extend` 续期或 `async_kill` 停止。

### 18.4 重复策略

- 首次 `now + effectiveRemindMs`；之后每次触发按 **2 倍退避**重布防（20m → 40m → 80m）。
- 最多 **3 次**（对齐 settle-guard 的 `maxReminders`）。用尽后不再布防、不杀、不写终态，任务继续运行。
- 任意一次 `async_extend` 重置计数与间隔。

### 18.5 绝不杀（REV-23 裁决）

提醒路径**不得**调用 `kill`、不得改 `status`、不得写 `failureKind`。进程生命周期只由
`taskTimeoutMs` / `async_kill` / watch 失败路径决定。提醒只履行告知义务。

### 18.6 抑制条件

触发时逐条检查，任一成立则跳过**且不重布防**：

1. 任务已终态；
2. `outputConsumed === true`（agent 已收割，不必再吵）；
3. `metadata.notifyOnCompletion === false`；
4. registry 已 closed / suspended。

### 18.7 `async_extend` 工具

```ts
async_extend({ taskId, remindAfterMs?, taskTimeoutMs? })
```

- `taskId` 接受 taskId 或 name（REV-15 同款）；未知 → 抛 `Unknown task or name: ...`。
- 两者都不传 → 抛 `async_extend needs remindAfterMs or taskTimeoutMs`。
- 终态任务 → 返回 `{ taskId, name, status, alreadyTerminal: true, elapsedMs }`，**不报错**
  （对齐 `async_kill`）。
- `remindAfterMs`：置 `task.remindAt = now + remindAfterMs`，`remindCount = 0` 并布防；
  `0` → 清除 `remindAt` 并 disarm。
- `taskTimeoutMs`：置 `task.timeoutAt = now + taskTimeoutMs` 并重布防硬杀；`0` → 清 `timeoutAt` 并 disarm。
- 返回 `{ taskId, name, status, elapsedMs, remindAt?, remindCount, timeoutAt? }`。
- **必须带 `promptSnippet`**（REV-20：没有 snippet 的工具不进系统提示）。

### 18.8 持久化与 reload

- `TaskSnapshot` 新增 `remindAt?: number`（绝对时刻）与 `remindCount?: number`。
- `metadata` 里还有两个持久字段，reload 的退避基线靠它们（不看 `remindAt`）：
  - `metadata.remindAfterMs`：`async_run` 的**显式旋钮**；delayed 任务在 pending 期也必须记住它
    （间隔到真正开跑时才求值），故随快照落盘。
  - `metadata.remindIntervalMs`：任务**开始运行时**求值出的首次间隔（显式值 / 带 watch 关闭 / 缺省 20 分钟）；
    缺席 = 该任务不提醒。reload 时 `reminderBaseMs()` 只读这个字段作为退避基线——只靠 `remindAfterMs`
    无法还原「开始时求值」的结果。
- reload 按剩余时间重布防（对齐 `timeoutAt` 的 D-03 做法：
  `rearmReminderFromDisk()`，与 `reloadFromDisk()` 里按 `timeoutAt` 重建硬杀的那步并列）。`remindAt` 已过期 →
  立即触发一次并继续退避。
- 与 `timeoutAt` 同样 `unref`：从磁盘恢复的提醒定时器不得单独撑住宿主进程。

### 18.9 与 settle-guard 的边界

- reminder 只在任务**运行中**投递；settle-guard 只在 turn **settle 边界**投递。两者内容不同
  （reminder 带 elapsed + extend 动作；settle advisory 只说有任务没收），**不互删、不去重**。
- 提醒**不计入** settle-guard 的 `maxReminders`。
- 禁止为提醒复活 `setInterval`（D-12 事故：timer 里持有 stale ctx 抛错 → `uncaughtException` 崩溃）。
  只用一次性 `setTimeout`，回调内 `registry.get(taskId)` 重读状态，`try/catch` 包住，失败仅 `console.error`。

### 18.10 与 watch 的边界

带 `watch` 的任务**不默认**开提醒；显式传 `remindAfterMs` 才开。

### 18.11 验收清单

- 默认布防：background + 无 watch → `remindAt ≈ start + 1_200_000`。
- `remindAfterMs: 0` → 无 `remindAt`、无定时器。
- 显式值覆盖默认；带 watch 时默认不布防、显式仍可开。
- 触发 → `sendMessage` 收到 `customType: "async-task-reminder"`，含 `elapsed-ms` 与 `remind-count`。
- 退避：第 2 次为 2×、第 3 次为 4×，之后停。
- **提醒不改变 `status`、不杀进程**。
- `outputConsumed` / `notifyOnCompletion:false` / 终态 → 跳过且不重布防。
- `async_extend` 移动 `remindAt`、重置计数；终态返回 `alreadyTerminal`；两参数都不传报错。
- reload 后按剩余预算重布防。
- 工具清单断言与 `docs/CONTRACT.md` §3 的「默认 5 个 + 可选 1 个」表述同步（REV-29：暴露
  `async_wait` 时 6 个，默认 5 个）。

### 18.12 实现补充（REV-23a，冻结）

实现期间补齐三处契约留白：

1. **guidance 必须随硬期限变化**。§18.3 的固定 `guidance` 只在任务**没有** `taskTimeoutMs` 时成立；
   有硬期限时声称「不会被自动杀」是假话，会诱导 agent 忽略真实的 kill。故拆成两版：
   无硬期限 → 原文（保持 `REMINDER_GUIDANCE` 逐字不变）；有硬期限 → 带剩余秒数并点名 `taskTimeoutMs`。
   **状态面不说谎优先于文案稳定。**
2. **`async_extend` 的「重置」只在传了 `remindAfterMs` 时发生**（把 §18.4「任意一次 extend 重置计数与
   间隔」精确化）。只传 `taskTimeoutMs` 属于延期，不重置提醒计数——否则「我只想推迟硬期限」会顺带
   把提醒预算洗白。
3. **`summary-truncated` 是诚实标记**：提醒的 tail 切片被截断、或输出总量已 `capped` 时，带
   `<summary-truncated>true</summary-truncated>`，语义与完成通知一致；提醒同样不得暗示「你看到了全部」。

## 19. 0.4.0 代际交接：工具必须解析活跃 registry（REV-24，冻结）

### 19.1 事故面

会话中出现永久不可恢复的状态：`async_run` 持续报
`Async task admission is closed (registry suspended)`，且工具 schema 停留在旧版本。
必须重启会话才能恢复。

### 19.2 根因

宿主对**同名工具跨 extension 是 first-wins**（`dist/core/extensions/runner.js:411`），而
`init()` 在同一模块实例上二次执行时会把前代 registry `suspend()`（`extensions/index.ts:144`，
REV-17 设计）。两者叠加 → 存活下来的工具闭包指向**已被退役的那一代**：

- `suspended` 无**运行期**重置路径（唯一置 true 在 `suspend()`；全仓无运行期 `= false`，字段初始化
  `private suspended = false` 不算重置）
- `configure()` 不会清 `suspended`，且工具闭包里的 `ensureConfigured` 还会把旧一代标成
  `configured = true`
- admission 在 `submit` / `scheduleDelayed` / `runSync` 三条路径前置，所以新工作**确定性失败**

注意：`async_logs` / `async_status` 这类只读工具**不会**报错——它们读的是退役代的**内存快照**，
返回的是「看起来正常但已经过时」的世界。这比报错更危险。

### 19.3 裁决

1. **工具在调用期解析 registry，而不是注册期闭包捕获**。
   `registerTools(pi, registrySource, ...)` 的第二个参数接受 `TaskRegistry | (() => TaskRegistry)`；
   传函数时每个 `execute` 先调 `resolveRegistry()`。传实例保持旧行为（嵌入方与既有测试不受影响）。
2. **extension 侧传解析器**：`registerTools(pi, () => activeRegistry ?? registry, ensureConfigured)`。
   回退到闭包实例是**有意的**：`activeRegistry` 在 shutdown 时被清空，此时没有活代数可路由，
   让退役代自己报出可操作的错误。
3. **`ensureConfigured` 必须配置活代数**：`const target = activeRegistry ?? registry`，仅当
   `target === registry`（自己的代）时才走一次性短路。否则经旧闭包进来的调用会让新代在
   **没有 dataDir / cwd** 的情况下开工。`configure()` 幂等，重复进入无害。
4. **不得由工具层或解析层重置 `suspended`**。让调用改道（上三条），而不是让失效的代被"顺手"复活；
   唯一允许的复位路径是**同一实例上的一次 `configure()`**（见 §19.6 的 REV-28a/REV-28b，0.4.2 修订）。

### 19.4 admission 文案（状态面不说谎）

```
Async task admission is closed (this session shut down; start a new session to run async tasks)
Async task admission is closed (registry suspended: a reload or resume retired this generation
  and a newer one owns new work; reload the session if this tool still points here)
```

两条都必须说明**为什么**与**怎么办**；只报「closed」是本次事故的次生伤害。

### 19.5 验收清单

- 同一 tool 对象在解析器目标切换后服务新目标（单元级）。
- 二次 `init()` 之后，仍持有前代工具对象的调用方：`async_run` **成功**，且新任务归新代所有。
- `registerTools(pi, registry)` 直接传实例的旧签名继续可用。
- **0.4.2 起按「退役代是否还会被 configure」分两类**（REV-28a/REV-28b，取代原先笼统的
  「无活代数 → 一定报错」）：
  - `session_shutdown(quit|new|fork)` 走 `shutdown()` → `closed`：**该已 shutdown 的实例自身不可复活**
    （`closed` 不是 `suspended`，没有任何 revival 路径），同一调用报出「this session shut down;
    start a new session」那条可操作错误。更早被 `suspend()` 的退役代不受影响——它仍可被 configure 自愈。
  - `session_shutdown(reload|resume)` 走 `suspend()` → **无后继代时**下一个 `session_start` /
    `message_start`（或带 ctx 的工具调用）即自愈：`async_run` 成功、任务归退役代（它已重新登记为 live），
    被杀的子进程快照被结算为 `failed/lost`。
  - 只有**从未再 configure** 的退役代（纯净 registry 嵌入方、直接传实例给 `registerTools`）继续报
    `registry suspended` 那条可操作错误。

### 19.6 0.4.2 修订（REV-28a/REV-28b，事故驱动）

§19.3 第 4 条的「退役单向」只在**有后继代**时成立。线上事故：宿主在
`session_shutdown(reason=reload|resume)` 之后**没有**重建扩展，于是没有新一代，退役代就是唯一一代 ——
旧裁决下只剩「整个会话 async 永久不可用」。修订如下（未废弃 §19.2/§19.3 的 1–3 条）：

1. **REV-28a：`suspend()` 仍是围栏，但同一实例的下一次 `configure()` 是合法的回收点**。
   未被重新 configure 的退役代继续拒绝新工作（`registry.ts` 的 admission 不变、既有测试语义不变）；
   但同一实例再次 `configure({dataDir,...})` 且自己处于 `suspended` 时，必须 un-suspend 并重新收养：
   先给所有 `live` 句柄打 `retired` 并从 `tasks`/`live` 移除非终态快照（磁盘权威），再走
   既有 `reloadFromDisk()` + `reapOrphans()`（详见 §10 的 0.4.2 修订）。退役 `live` 的迟到 exit 必须
   是 no-op，**不能**覆盖 revival 后的快照（防双 finalize / 旧快照覆写新快照）；仍在 `await killTree`
   的旧 `kill()` 同理不得结算（`registry.ts` 的 stale-object 闸门＋`retired` 句柄闸门）。
2. **REV-28b：`ensureConfigured` 不得在 registry `suspended` 时短路**。`activeRegistry === undefined`
   且本实例是唯一代时，把它重新登记为 live。效果：reload/resume 无后继代之后，**下一个
   `session_start` / `message_start`（或带 ctx 的工具调用）**即自愈，不需要用户 `/reload`。
   注意：`onLifecycle` 里的 `ensureConfigured` 必须**每次**生命周期事件都调用；一次性 `startup` 闩
   只守 `resendUnnotified`（否则只有工具调用能自愈，与本节承诺不符）。
3. **§19.4 的 suspended 文案保留**：它现在描述的是**从未再被 configure** 的实例（纯 registry 嵌入方、
   或直接传实例给 `registerTools` 的路径），依然是可操作的诚实错误；不是自愈路径的失败信号。

## 20. 0.4.0 watch 读取有界 + 常量改名（REV-25，冻结）

起因：`readWatchOutput` 每次求值都把 `.output` / `.stdout` / `.stderr` **整文件** `readFileSync`，
一个大日志（默认写盘 cap 20 MiB，可调 `PI_ASYNC_MAX_OUTPUT_BYTES`）在 watch 期间会被反复全量读入；同时契约把「尾部 64K 窗口」写成所有条件的通用性质，
而实现里只有 `output_matches` 截断。

### 20.1 读取有界

`readWatchOutput` 改走 `logs({ maxBytes: WATCH_READ_BYTES, tail: true })`：

- `WATCH_READ_BYTES = MAX_LOG_WINDOW`（8 MiB），每次求值（tick 或进程退出）每流各一次**有界尾部读**。
- 保留两条既有语义：数据目录外路径 **throw**（D-11）；**合并输出文件缺失 throw**，使 `blind_checks`
  能计为基础设施失败（#37/#68）。`logs()` 对缺失返回 `missing: true`，此处转回 throw。
- `stdout` / `stderr` 缺席仍按空串处理，流分离不变（#4）。

### 20.2 两层窗口，语义分离

| 窗口 | 值 | 适用范围 | 理由 |
|---|---|---|---|
| 读取窗口 | 8 MiB（`MAX_LOG_WINDOW`） | 所有条件 | 内存 / CPU 有界 |
| 正则窗口 | 64K 码元（`MAX_MATCH_CHARS`） | 仅 `output_matches` | 内存 / 取舍边界——拷贝量与 `slice` 有界；**不是** ReDoS 防线，也不是工作量上界（REV-34 修正） |

滚出读取窗口的输出对**所有**条件都不可见。这是有意语义（watch 决定的是「最近发生了什么」），
不是实现妥协。**补救路径是 `output-file` 路径 + `bash`**（如 `grep -n marker <file>`）；
`async_logs` **救不了**：工具层硬顶 50 KiB，且只有头部 / 尾部两档，中间段取不到。

### 20.3 常量改名

`MAX_OUTPUT_MATCH_BYTES` → `MAX_MATCH_CHARS`：旧名声称 bytes，实现是 `String.length` /
`String.prototype.slice`（UTF-16 码元）。0.4.0 未发布，直接改名，不留兼容别名。

### 20.4 验收清单

- 尾部窗口内的标记可命中；超出窗口的标记不命中，终态由退出码或 `timeoutMs` 决定
  （`tests/b-watch-integration.test.ts` 的 9 MiB 用例）。区分是否命中要看 `metadata.watchSuccess`，
  而不是看 `status`（命令自行 `exit 0` 时也是 `completed`）。
- 合并输出文件缺失仍走 blind 计数；数据目录外路径仍 throw。
- `output_matches` 仍只在尾部 64K 码元内求值（`MAX_MATCH_CHARS`）。

### 20.5 已知限制（接受，不修）

窗口起点若横切一个 ANSI/OSC 序列，会留下半截转义残片：`logs()` 是「先切窗口再
`stripLogControls`」，而 `ANSI_ESCAPE` 只修补**结尾**未闭合的序列、不修**开头**残片。
影响仅限 >8 MiB 文件窗口头部的数十字节，对条件判定无实际意义。修它需要改动 `logs()` 的
清洗顺序（会影响 `async_logs` 的每个窗口），收益不足，记录在此。

## 21. 0.4.1 面板实时输出 + 批次规划指导（REV-26 / REV-27，冻结）

### 21.1 详情页把 stdout 当主视图（REV-26）

- **详情体是一个视口（#101 / REV-31 起）**：`budget = height - 2`；`header` = title + status
  （**1–2 行**：`matchBudgetExceeded > 0` 的任务多一行求值预算计数，REV-34；其余任务仍是 2 行）与
  `footer` = `actionError`/kill 确认提示 + 键位提示（1–3 行）固定，`viewportRows = budget - header - footer`
  是中间内容的窗口。内容 = 三条分隔线 + command 行 + metadata 行 + output 标签 + **全部**输出行；
  `scroll` = 距尾部的行数（0 = 尾部），`pageStep = viewportRows`。0.5.0 的实现把中间内容**永久**折进
  `… (+K lines)`（`withBodyBudget`）、且 `scroll` 只切输出尾窗，于是折叠区不可达（#101 D2）；
  现在同一个标记只是「窗口上方被隐藏的行数」，上滚即读回。
  实测（80 列、running 任务、200 行输出）：

  | 终端行数 | metadata 键数 | 渲染出的输出行 | 折叠标记 |
  |---|---|---:|---|
  | 40 | 3（真实任务的 outputFile/notifyOnCompletion/triggerOnCompletion） | 27 | 否 |
  | 24（xterm 默认） | 3 | 13 | 是（`… (+K lines)`） |
  | 40 / 24 | 0 | 27 / 13 | 否 / 是 |

  `MIN_OUTPUT_ROWS = 8` 保留为**折叠判据**：`middle + MIN_OUTPUT_ROWS > viewportRows` 时（例：24 行终端 +
  真实 metadata）才出现标记，40 行终端 + 长日志不出现 —— R2-3 与 D-30 两条既有断言都不改不放宽。
  极端高度：`budget <= header + 1` 时只留 header + footer（0.5.0 只返回 footer，header 消失，见 #101 D3）。
- **PageUp/PageDown 步长 = 当前视口高度**（模块级 `pageStep`，每次详情渲染更新），不再是固定 12，
  也不是 0.5.0 的「输出窗口行数」。
- **1Hz 自刷新**：面板 widget 工厂内 `setInterval(1000)` + `unref`，`teardown()` 统一 `clearInterval`
  —— `done` / `dispose` / `custom()` 失败三条路径共用同一 teardown（前两条直接调用；`custom()` 的
  reject/throw 发生在工厂闭包之外，通过 `killWidget` 句柄回调 `teardown`；工厂未执行时句柄为
  `undefined`，无需清理）。理由：running 任务的输出增长不产生 `registry` 事件，纯事件驱动会把尾部
  冻结在打开那一刻。固定 1000ms，**无环境变量开关**（与 rail ticker 同模式）。
- **上滚锚定**：`follow=false` 且内容行数（#101 起 = 整个详情体）增长时 `scroll += delta`，用户正在读的
  行原地不动；command/metadata 行数恒定，所以增长只来自输出。`follow=true` 仍贴尾部；切换任务时重置
  锚点（不拿上一个任务的计数补偿）。两条归一化防止幽灵 offset：夹取后 `scroll === 0 ⇒ follow = true`；
  上一帧没有隐藏任何内容（`contentCount <= viewportRows`，变量名 `lastHadOverflow`）时直接
  `scroll = 0; follow = true` —— 否则「输出还没超视口时按了一次 ↑/`k`」会让视图永久锚在按键那一刻的行
  （R2-1 回归）。
- **output 标签**（`outputSection` 第 5 个可选参数 `live`）：`output:` / `output (tail truncated):` /
  `output (live):` / `output (live, tail truncated):`；`live = status ∈ {running, pending}`。
  4 参调用保持原标签，既有调用与测试不受影响。
- 列表视图因同一 ticker 获得实时刷新（running 任务的最新输出行）。

### 21.2 「什么时候不要 async」+「先规划批次」（REV-27）

- **缺口**：常驻提示只有单向「>~60s 就 `async_run`」；mode 判定表在按需加载的 skill 里；
  「提前规划 / 并行铺开 / 预估耗时」的措辞全仓不存在（grep 零命中）。
- **`promptGuidelines` 追加第 4 条（逐字）**：
  `Plan the batch first: launch independent long commands together (several async_run calls in one message) and collect them with a single async_wait later.`
- **`skills/async-tasks/SKILL.md` 新增两节**（位置：`## Choose the mode` 之后、`## Collect, do not poll`
  之前）：`## When not to use async`（秒级命令、结果立刻要用且一分钟内结束、没有可重叠的工作、
  拿 async 掩盖失败）与 `## Plan the batch first`（先扫描独立长命令 → 同一条消息里一起起 →
  做本地工作 → 一次 `async_wait` 收），并明确 `mode=sync` 同样注册成真实任务（因此在 rail 里可见、
  计入 running），只用于「下一步必须等它 **且** 可能超出 bash 窗口」。
- **回退开关**：无（文案是产品面，不是行为开关）。

### 21.3 验收清单

- 40 行终端 + 200 行输出：详情渲染 ≥ 20 行输出；24 行终端 + 3 个 metadata 键：≥ 8 行
  （`tests/c-panel-live.test.ts` D-30 / R2-3）。
- 无 registry 事件时 1Hz 重绘；`q` / `dispose` 之后不再重绘，且 `dispose` 确实以被创建的 ticker 句柄
  调用 `clearInterval`（`mock.timers` + `mock.method` 驱动，无真实等待）。
- 输出未超窗口时按 ↑/`k` 不得留下幽灵 offset（R2-1）；上滚后新输出不顶走正在读的行；
  `follow` 仍贴尾（D-32）。
- `custom()` 在工厂执行后 reject 时 ticker 与订阅都被清（R2-2）。
- 4 条 guideline 逐字冻结（`tests/d-tool-contract.test.ts`）；skill 两节存在且顺序正确
  （`tests/e-skill.test.ts`）。

## 22. 0.5.0 工具面收窄 / async_wait 默认不注册 / 文案（REV-29，冻结）

基线 `feat/notify-first`（0.4.7）。三条决策 D3 / D4 / D6 一并落地；**sync 不留兼容层**。

### 22.1 删除 `mode=sync`（D3）

- **原因**：阻塞形态与「完成通知唤醒」是两条互相打架的收割路径，模型为「马上就要结果」去坐等
  `mode=sync`，正是 0.4.x 想消灭的模式；`timeoutMs`/`onTimeout` 两个旋钮只为它存在。真需要阻塞时，
  可选的 `async_wait`（§22.2）是唯一原语。
- **影响面**：
  - `TaskMode = "background" | "delayed"`（`src/core/task.ts`）；`RunOptions.timeoutMs` /
    `RunOptions.onTimeout` / `SyncResult` 接口删除（`RunReceipt` 保留）。
  - `TaskRegistry.runSync()` 与私有 `syncResult()` 删除；`createAndStart(opts)` 收窄为只建 background；
    `validateRunWatch(opts)` 不再有 sync 拒绝分支（watch 对 background/delayed 都合法）。`submit` 的
    `opts.mode !== "background"` 白名单与文案 `submit only accepts background mode` **不变**。
  - `async_run` schema：`mode.enum = ["background","delayed"]`；`timeoutMs` / `onTimeout` 字段、默认上界
    常量、`resolveMaxSyncTimeoutMs()`、`PI_ASYNC_MAX_SYNC_TIMEOUT_MS` 读取全部删除。`additionalProperties:
    false` 使宿主直接拒绝这两个参数（不再是运行期「只对 sync 有效」的校验）。
  - `execute` 保留：mode 白名单（`Unsupported async_run mode: sync`）、`delayMs` 在 delayed 必填、
    非 delayed 传 `delayMs` 报错。`async_run.description` 与 `mode` 字段描述见 §17。
  - TUI 配色：`src/tui/rail.ts` 的 `typeColor()` 改为 `mode === "delayed" ? 2 : 0`，**TYPE_TOKENS 槽位
    与既有 rail 颜色测试完全不变**。升级时从磁盘恢复的 0.4.x 快照若仍是 `mode: "sync"`（`reloadFromDisk`
    只校验 `status`），它按 background 取色（slot 0）——纯外观、不崩、不越界；此后不会再产生这类快照。
  - 承载该 API 的四个文件（`src/core/task.ts` / `src/core/registry.ts` / `src/tools/index.ts` /
    `src/tui/rail.ts`）不得再出现 `runSync` / `SyncResult` / `onTimeout` / `PI_ASYNC_MAX_SYNC_TIMEOUT_MS`，
    也不得出现词边界 `sync`（`async` 含该子串，审计必须用 `\bsync\b`）；`src/context/nudges.ts` 另按
    词边界 `sync` 审计（它只承载过用户文案）。`src/guard/settle-guard.ts` 的 2026-10-21 事故注释里
    合法保留 `Timeout._onTimeout`（与 sync 无关，故不进 API 名审计）；
    `src/guard/hold.ts` 的英文注释 `Keep in sync with` 与 `src/core/notify.ts` 的 `Sync throw` 同样与
    sync 模式无关，属可接受残留。
- **回退开关**：无（无兼容层）。

### 22.2 `async_wait` 默认不注册（D4）

- **原因**：默认路径是「结束 turn，完成通知唤醒」。把阻塞原语摆在默认工具面里，模型就会用它替代通知；
  而宿主对未注册工具的调用本身是安全的，所以缺省不注册 + 可读降级即可。
- **影响面**：
  - `src/tools/index.ts` 导出 `WAIT_TOOL = "async_wait"`、`waitToolExposed()`（**每次调用读
    `process.env.PI_ASYNC_EXPOSE_WAIT === "1"`，不在模块顶层缓存**）、`WAIT_UNAVAILABLE`。
  - `registerTools` 里 `async_wait` 的注册整体包在 `if (waitToolExposed())` 内：默认（含 headless）
    工具面 5 个（`async_run`/`async_logs`/`async_status`/`async_kill`/`async_extend`），暴露后 6 个。
  - 优雅降级：`async_wait.execute` 开头有调用时闸门。`!waitToolExposed()` 时**不 throw**，直接返回
    `toolResult({ taskId: null, available: false, error: WAIT_UNAVAILABLE, enableWith: "PI_ASYNC_EXPOSE_WAIT=1",
    alternatives: ["async_status","async_logs"] }, true)`（`isError: true`，正常 resolve）。覆盖「旧会话 /
    旧注册仍调到它」；宿主对**未注册**名字的回包仍是 `Tool async_wait not found`（不崩）。
  - 文案不得劝模型调用未暴露的工具：`notificationException()` 两条 hint 与 `ASYNC_RUN_PROMPT_GUIDELINES`
    用 `waitMention(exposed, otherwise)` / 追加式第 5 条实现（§17）。
- **回退开关**：`PI_ASYNC_EXPOSE_WAIT=1`（暴露 `async_wait`，措辞同步回到 async_wait 版本）。

### 22.3 文案（D6）

- `src/context/nudges.ts`：`bashNudge` 删除 `or mode=sync with timeoutMs when you need the result soon`，
  默认文案为 `({took Ns in the foreground; }async_run could have run it in the background — use
  mode=background with watch for servers/builds; end the turn and the completion notification wakes you)`。
- `<async-state>` 三条 tail（全唤醒 / 混合 / 全不唤醒）在 `!waitToolExposed()` 时不出现 `async_wait`，
  分别落到 `… wakes you.` / `… read the rest with async_logs.` / `… collect them with async_logs …`；
  暴露时保持原措辞。**保留**「按 per-task 事实分三态」不变量与既有护栏
  （全不通知分支不得出现 `wakes you`，全唤醒分支不得出现 `no-notify`）。
- `src/guard/settle-guard.ts` 的 advisory / unresolved / reminder / aborted 文案同理：
  `!waitToolExposed()` 用 `async_status` + `async_logs`，暴露时才出现 `async_wait`。
- 任何默认路径生成的 `<async-state>` / nudge / advisory **不得**包含 `async_wait`。
- `skills/async-tasks/SKILL.md`：删掉 sync 描述，`async_wait` 改为「默认不存在，只有宿主设置
  `PI_ASYNC_EXPOSE_WAIT=1` 时才暴露；默认做法是结束回合等完成通知」；`## When not to use async` 与
  `## Plan the batch first` 逐行更新（不再依赖 `async_wait`，也不再有 `mode=sync` 行）。

### 22.4 验收清单（REV-29）

- `tests/k-toolsurface.test.ts`（新增）：默认 5 个工具名 `deepEqual`；`PI_ASYNC_EXPOSE_WAIT=1` 时 6 个；
  暴露态注册后关掉开关 → `async_wait.execute` resolve、`details.payload.available === false`、
  文本含 `not available in this configuration` 与 `PI_ASYNC_EXPOSE_WAIT=1`、`isError === true`；
  `task.ts`/`registry.ts`/`tools/index.ts`/`rail.ts` 源码无 `runSync|SyncResult|onTimeout|
  PI_ASYNC_MAX_SYNC_TIMEOUT_MS`、无词边界 `sync`、无 `mode … sync`；`async_run` schema 的
  `mode.enum` 与 `timeoutMs`/`onTimeout` 缺席。
- `tests/e-nudges.test.ts`：默认真实 `registerNudges` + `context_with_system` 生成的 `<async-state>`
  不含 `async_wait`；三态默认 tail 文案；`bashNudge` 不含词边界 `sync` / `async_wait`；暴露时全唤醒分支
  含 `async_wait`。
- `tests/d-settle.test.ts` / `tests/a-settle-guard.test.ts`：默认提醒/advisory 用 `async_status` +
  `async_logs`；新增「暴露态保留 async_wait 措辞」用例。
- 删除 `tests/b-sync-mode.test.ts`（delayed 断言迁入 `tests/b-delayed.test.ts`）；`tests/w2-safety.test.ts`
  的 `syncResult` UTF-8 用例删除（#17 仍由同文件 `truncateUtf8Bytes` 用例覆盖）；`tests/f-reminder.test.ts`
  的工具面断言改为默认 5 个 + §17 的 5+1 口径。

## 23. 0.5.0 headless 保底：`pi -p` 不得带着未完成任务退出（REV-30，冻结）

### 23.1 事故面

`pi -p` 是「一个 prompt 进、一条 assistant 回答出、进程退出」。宿主没有任何东西把一个运行中的后台任务
和进程寿命绑在一起（`print-mode.js` 的完成判据是 `session.prompt()` resolve）。0.4.x 的实测：任务需要
3s，进程 **565 ms** 就退出，`session_shutdown` 把任务杀掉，stdout 为空、退出码 0 —— 一次没有任何信号的
静默失败。凭模型自觉调用 `async_wait` 不能解决：默认工具面里已经没有它（REV-29），而且「进程什么时候
退出」本来就不是模型的决定。

### 23.2 裁决（结构性，不依赖模型动作）

- **只在 `ctx.mode === "print"` 生效**（`src/guard/print-wait.ts`）。`tui`/`rpc`/`json`/缺失 ctx 一律
  立即返回：print 是这个模块唯一服务的模式，缺失 ctx 不得被当成 print（否则每个模式都会白等十分钟）。
- **等待位置**：`agent_before_settle`。宿主对该 handler 的 `await` 没有超时（`runner.js:782`），
  所以这是 headless 进程唯一合法的「花墙钟时间」的地方。
- **等待对象**：`status === "running"` 的任务。`pending`（delayed）不算：`dueAt` 可能在一小时外，
  把它算进来只会每次打印运行都烧掉整个预算；它的快照留在磁盘上给下一个会话。
  **不**按 `notifyOnCompletion` 过滤——print 模式没有别的播报通道，静默任务同样不能带着输出一起走。
- **正常出口**：全部终态 → 提交一条 `custom_message`（`customType: "async-task-print-results"`，
  `display: false`，内容形如 `Waited for N async task(s); all finished: a (completed, exit 0) · b (failed, exit 7).
  Read the output with async_logs before answering.`，明细**一行、最多 8 项**（以 ` · ` 分隔，超出补 `+N more`），
  只含 name/status/exitCode，**绝不内联 outputTail**；history 已被 prune 时明细只列仍能读到的行，缺的行数并入
  `+N more`，一行都读不到时退化为 `… they finished (records pruned). …`）并返回 `continue: true`。
  host 因此再发一次 provider 请求（`agent-session.js:1521-1525`，不受模式限制），
  模型的回答成为最后一条 assistant 消息，也就是 `print-mode.js:117-138` 打印的东西。
- **终态归属**：复用 0.4.3 的 `HoldNotificationRelay`（`open`/`claim`/`commit`/`release`，与 hold 同一个
  实例），全终态时 `commit` 掉的 id 逐个 `markNotified`。等待期间落地的完成通知不会变成一条没人读的
  followUp，也不会在下一个 `session_start` 被 `resendUnnotified` 重播。
- **两道界**（缺一不可，宿主不提供上限：`PI/docs/extensions.md:748` 明确 `continue: true` 可成环）：
  1. **续跑上限** `PI_ASYNC_PRINT_MAX_CONTINUATIONS`（默认 5，整个进程累计，`agent_start` **不**重置）；
  2. **整体预算** `PI_ASYNC_PRINT_WAIT_MS`（默认 600000ms，单调时钟 `performance.now()`，从第一次真正
     等待开始累计，跨回合不重置）。
- **限流出口**：cap 或预算用尽 → `notify.release()`（扣住的通知原样交还）→ **stderr** 一行
  `pi-async: still running N async task(s) after C continuation(s) and Ts: <taskId> (<name>), …`
  （**必须含每个 taskId**）→ `process.exitCode = 1` → 返回 `undefined`（允许 settle）。
  扩展里设的 `process.exitCode` 有效：`main.js:877` 只在 `runPrintMode()` 返回非零时覆盖。
- **失败面**：registry 抛错 / dispose → 释放通知、返回 `undefined`、**不改退出码**（teardown 或坏 registry
  不是任务失败）。任何路径都不 throw、不 `process.exit()`。
- **开关**：`PI_ASYNC_PRINT_WAIT=0` → 一个 handler 都不注册（0.4.x 行为），用于对照实验与紧急回退。
- **不做的事**：不改 `hold.ts`（0.4.8 的 hold 仍只在 TUI 生效）、不渲染任何 TUI、不消费输出、
  不写 `consumedAt`；它与 hold 按 `ctx.mode` 完全互斥。

### 23.3 宿主事实（实测，pi 1.5.2）

| 事实 | 证据 |
|---|---|
| print 模式 `ctx.mode === "print"`，`hasUI === false` | `print-mode.js:55-60` → `agent-session.js:2756-2762` → `runner.js:630-633` |
| `agent_before_settle` handler 无超时、按注册顺序串行 await | `runner.js:767-814` |
| `{entries, continue:true}` 在 print 模式真会再发一次 provider 请求 | `agent-session.js:1521-1525`；`scripts/headless-smoke.sh wait` 实测 3 次请求 |
| `custom_message` draft 让 `canContinue` 为真 | `agent-session.js:670-689` |
| print 只打印**最后一条** assistant 消息的 text | `print-mode.js:117-138` |
| `process.exitCode = 1` 在扩展里设置有效 | `main.js:877` |
| print 模式的 `console.log`/`process.stdout.write` 落 stderr | `output-guard.js:38-59`（所以限流提示用 `console.error`） |
| 扩展无法拦截未注册工具名 | `agent-loop.js:479-492`（`Tool <name> not found`，不触发任何钩子） |

### 23.4 验收清单（REV-30）

- `tests/j-print-wait.test.ts`（新增）：任务完成前 handler 不 resolve（≥100ms，结果 `continue: true` +
  `async-task-print-results`）；relay 扣住的通知不被发送且 `markNotified` 落盘；cap 用尽 → `undefined`
  + stderr 含 taskId + `process.exitCode === 1`；整体预算用尽 → 同上且 `release` 被调用；
  `tui`/`rpc`/缺失 ctx 立即返回且不读 registry；`PI_ASYNC_PRINT_WAIT=0` → 0 个 handler；
  entries 不含 outputTail；预算跨回合累计；hook 恰好 3 个且 dispose 幂等。
- `scripts/headless-smoke.sh`（真实 `pi -p` + `test/docker/tools/mock-llm.py` 脚本化 endpoint）：
  - `wait`：任务 3s、进程 wall ≥ 3s、请求 ≥ 3、**stdout 含 `CONCLUSION-AFTER-TASK`**、退出码 0；
  - `cap`：第一个任务完成花掉 1 次续跑，第二个永不完成 → 退出码非 0、stderr 含
    `after 1 continuation(s)` 与仍在跑的 taskId；
  - `off`：`PI_ASYNC_PRINT_WAIT=0` 复现 0.4.x（wall < 任务时长、stdout 无结论）= 变异证据。
- 全量 `npm test` 与 `npm run typecheck` 全绿。

## 24. 0.5.1 详情视口：选择与滚动分离（REV-31，冻结）

基线 `main` `985a083`（0.5.0 已发）；来源 issue #101（`docs/reports/pi-async-81-triage.md` 的 4.1 + 4.2）。
三个缺陷都在 `src/tui/panel.ts` 一个文件里；本修订只改详情视图的键义与视口语义，不动 rail、不动 `R` rerun
的字段策略、不新增快捷键注册。

### 24.1 三个缺陷与裁决

- **D1（选择/滚动分离）**：详情内 `↑`/`↓`/`j`/`k` **只滚视口，不改 `selected`**。0.5.0 的 `move()` 先改
  `selected` 再改 `scroll`，而详情渲染读的是 `selected` —— 滚一下日志就跳到相邻任务（与 README 的
  「in task details, scroll output」冲突）。换任务新增 **`[`（上一个）/`]`（下一个）**；列表模式键义不变
  （`↑`/`↓`/`j`/`k` 仍是选择，`k` 不是 kill，REV-18）。
- **D2（折叠区可达）**：采用 issue 的 **(a) 统一视口** —— 详情体 = 固定 header（title + status，
  `matchBudgetExceeded > 0` 时为 1–2 行，见 REV-34）+ 可滚动
  内容（三条分隔线 + command + metadata + output 标签 + **全部**输出行）+ 固定 footer（`actionError` /
  kill 二次确认 + 键位提示）。0.5.0 的 `withBodyBudget` 把中间内容**永久**折进 `… (+K lines)`，而 `scroll`
  只作用于输出尾窗，折叠区没有任何按键可达；现在标记是「窗口上方被隐藏的行数」，`↑`/`k` 滚一行、
  `PageUp` 滚一个视口即可读回。
- **D3（退化视口）**：`budget <= header + footer`（约 5–7 行终端；footer 最多 3 行：error + kill 确认 +
  键位提示）时先留 **footer**（告警与键位提示永不先丢）再补 title；0.5.0 的 `if (tailCount <= 0) return [last]`
  只返回 footer，§8 承诺的 header 消失。只要还剩一行内容就留给视口（`budget = 4` 时是最新输出那行）。
- **D5（顺带修正，不属原 issue）**：详情里滚轮方向与 `↑`/`↓` 相反 —— 0.5.0 的 `scroll += wheelDelta` 在
  宿主「向下 = 正值」的编码下等于上滚。现在 `scroll -= wheelDelta`：滚轮向下 = `↓` = 朝最新行。
  （列表视图一直是对的，本次不动。）

### 24.2 语义与不变量

- `viewportRows = budget - header - footer`；`scroll` = 距尾部的行数（0 = 尾部，与 0.5.0 同向）；
  `pageStep = viewportRows`（D-30「一页 = 一个窗口」不变，但窗口从「输出窗口」变成「视口」）。
- 既有裁决全部保留，**判据换成视口量**：
  - **R2-3**：折叠条件 `middle + MIN_OUTPUT_ROWS > viewportRows`（旧 `chrome + MIN_OUTPUT_ROWS > budget`）。
    40 行 + 200 行输出**不**出现标记（D-30 断言），24 行 + 真实 metadata 出现标记（R2-3 断言）。
  - **R2-1**：「上一帧没有隐藏任何内容」判据 `contentCount <= viewportRows`（变量 `lastHadOverflow`），
    夹取后 `scroll === 0 ⇒ follow = true` 不变。
  - **D-32**：锚定按内容行数差补偿；command/metadata 恒定，所以增长只来自输出行。
  - **D-33**：`output (live):` 标签不变（现在是可滚动内容的一员，长日志时在窗口上方）。
- **用户可见差异**（两处，均写进 README）：
  - `… (+K lines)` 的 K 是「窗口上方隐藏的总行数」（含输出行）；0.5.0 只数被折叠的 command/metadata 行。
  - `output (live):` 标签随内容滚动，不再常驻窗口顶部；`actionError` / kill 提示反而**上移**成固定 footer。
- **回退开关**：无。回退方式是把 `renderBody` 的详情分支整段退回 0.5.0 的 `withBodyBudget` 实现
  （本修订前一个 commit），无环境变量、无双实现开关。

### 24.3 验收清单

- `tests/d-tui-keys.test.ts`：详情内 `↑`/`k`/`j`/`↓` 后 `selected` 不变且视口滚动；列表内 `↑`/`↓` 仍改选择；
  `[`/`]` 在详情内换任务；`k` 永不 kill（既有断言保留，改成「不换任务」）。
- `tests/c-panel-live.test.ts`：14 行终端 + 30 行 command 时折叠（`… (+37 lines)` 的 K 被逐字钉住），
  `PageUp` 后能读到 `command:` 与前几行；退化高度（7/6 行）仍见 title 与 footer，8 行时保留 1 行最新输出；
  滚轮向下与 `↓` 同向。
- `tests/d-tui-keys.test.ts`：8 行终端 + 错误行 + kill 二次确认同时存在（footer 3 行）时，键位提示仍是
  最后一行（`viewportRows` 不得变负、`pageStep` 不得反向）。
- 既有 D-30 / R2-1 / R2-3 / D-32 / D-33 / d-tui-refresh「短终端折叠 + footer」断言不改不放宽。
- 全量 `npm test` 441 条全绿（0.5.0 基线 435 条，只增不减）；`npm run typecheck` 全绿。
- 变异：逐个撤掉 D1/D2/D3 修复 → 对应断言必须红（证据见 `docs/reports/tui-detail-viewport.md`）。

## 25. 存储生命周期：跨 dataDir 回收 + 全局字节配额（REV-32，冻结；判活与「无证据」两条由 REV-33 修订，见 §25.9）

基线 `origin/main` `91a4d88`（0.5.0 已发，#105 已合入）；来源 issue #102（父 #81 的 8.1 + 8.2）。
本修订**只新增两个默认关闭的存储开关**；不改 `prune()` 的既有语义（§10 的并集策略一字不动），
不动 `reapOrphans()` / 存活巡检（REV-28c）的任何裁决，不改工具面（§12 冻结，见 §25.5）。

### 25.1 原因

- 目录布局是 `<session dir>/pi-async/<sessionId>`（`extensions/index.ts:43-50`）；每次 `pi -p` 都是新
  sessionId → 新目录，而 `configure()` 的 retention/`prune()` 只作用于**当前** dataDir，旧目录**永不再被
  打开**。实测 `~/.pi/sessions/*/pi-async/*` 累积 117 个 session 目录 / 4.0 MiB，其中 54 个 mtime > 7 天、
  86 个是只有 `mkdirSync` 的空目录 → 产物只增不减。
- `PI_ASYNC_TOTAL_BYTES` 此前在源码里零引用（只在草稿文档里出现过），没有任何字节上限。

### 25.2 术语与单位（先定义，后判据）

- **sweep root**：`dirname(resolve(dataDir))`。真实布局里就是 `<session dir>/pi-async/`；无 sessionManager
  时是 `~/.pi/async/`。**只处理 root 的直接子项，root 自身永远不是目标**（单个父目录下实测最多 33 个并发
  session 子目录，删父目录等于抹掉所有会话）。
- **产物族**：`.json`（元数据快照）+ `.output`（合并输出）+ `.stdout` / `.stderr`（分流 sidecar）。
  字节记账**只数这四个后缀**的普通文件（`lstat` 的 `size` 之和）；`*.tmp`（`migrateDataDir` 的
  copy→rename 残留）、子目录、符号链接不计入、也不会被配额淘汰单点删除。
- **配额单位 = 字节**。`PI_ASYNC_TOTAL_BYTES` 是整数、`0` = 关闭（负值/非法值回退 `0`，见 `envNumber`）。
  报表与日志用二进制单位（KiB/MiB/GiB）渲染，便于人读；**判据只比字节**。
- **同界含于配额**：`used <= quota` 视为在预算内，只有 `used > quota` 才淘汰（边界见 §25.8 的「恰好等于」用例）。
- **owner marker**：`<dataDir>/.pi-async-owner`，`{pid, at, marker}`，由 `ensureDataDir()` 在目录首次就绪时原子写入
  （temp+rename，0600），`migrateDataDir()` 成功后删除旧目录的 marker。它**不是产物**（不匹配四个后缀，
  因此不计字节、不被当快照解析、不被迁移），`surveyDataDir()` 把它列为**允许内容**（不会让目录变 `foreign`）。
  它回答的是 **S1 的问题**「这个目录所属的 session 还有进程在吗」——**只对 S1 生效**：S2 配额不看 marker
  （配额保护的是「目录内有活着的非终态任务」，见 §25.4）。
  - **marker 的 pid 用「进程存在」判活（REV-33）**：`process.kill(pid, 0)` 成功或 `EPERM`（存在但不是我
    的权限）即视为活；Linux 上再查 `/proc/<pid>/stat` 的状态位，`Z`（僵尸）算死。**不是** `pidAlive()` 的
    进程组语义：marker 记的是 `process.pid`，而 pi session 进程通常是 shell 进程组的成员、不是组长——
    用组语义判它会把活着的 session 判成死的（0.5.2 合入后的缺陷，§25.9）。
  - marker 的 `pid` 必须是**正整数且在 `pid_t` 范围内**；`0`/负数/小数/`1e21` 无法诚实探测（`0` 会变成
    「我自己的进程组」、负数变成「进程组 N」、超范围会让 `kill()` 抛 `ERR_INVALID_ARG_TYPE` 而被误读成
    「已死」），一律按 `unreadable_owner` 当作**不知道**——目录保留，绝不据此认定 owner 已死。
  - **marker 是 FIFO/socket 时不许读**：`readFileSync` 在 FIFO 上会**永久阻塞**（会把 `configure()` 挂死）。
    `surveyDataDir()` 先看 dirent 再决定读不读，非常规文件一律不读、直接按 `unreadable_owner` 处理。
  - **marker 的存在本身就是证据**（REV-33）：名字在、但读不出来（EACCES/EIO/EISDIR、悬空软链、
    根本不是普通文件）**不等于**「没有 marker」，一律 `unreadable_owner` 并跳过。本模块从不跟随软链，
    所以「marker 是软链」也按不可读处理（即使它指向一个能读的 JSON）。
  - **单 marker 只记一个 owner**：两个进程共用同一个 dataDir 时后写者覆盖前者；后者死后目录会被回收，
    即使前者还活着。走真实布局（一个 sessionId 一个进程）碰不到；记为已知边界（§25.7）。
- **dataDir 的认定（正证据，不是「没有异物」）**：一个目录算 dataDir 当且仅当 **它是当前 dataDir**、
  **或**含至少一个可解析快照、**或**没有任何异物。`.`/`..`/软链/大小写不敏感的别名都用**目录身份**
  （`dev`+`ino`，回退 `realpath`）判定，而不是比较字符串 —— 否则闸 1 会被别名绕过，
  清理会删掉本 registry 正在使用的目录。

### 25.3 S1：跨 dataDir 回收（三闸，任何一闸不成立就不删）

`PI_ASYNC_SWEEP_SIBLINGS=1` 时，对 root 下每个**其他**目录逐一判定；**三闸同时成立**才整目录 `rm -rf`：

1. **不是当前 dataDir**（按**目录身份**：`dev`+`ino`，回退 `realpath`，见 §25.2）——当前目录哪怕早已没人动、全是终态产物也不删。
2. **没人用**：(a) 不含「非终态且 pid 仍活着」的快照（`running`/`pending` + `pidAlive`：`/proc` 优先，
   macOS 退化到 `kill(-pid, 0)`；**组语义**，因为任务子进程 `detached` 后 pid 即 pgid）；**且** (b) owner marker
   不存在，或它的 pid 已死（**进程语义**，见 §25.2 / REV-33）。判活**不复用** `reapOrphans()` 的结算逻辑、
   **不 kill 任何进程**。
   **(c) 非终态快照里没有 pid（延迟 `pending` 任务）时不提供任何判活证据**：既不算「活着」，也不算「死了」
   ——它降到 marker + 年龄闸判定（那才是能回答「还会有人回来吗」的闸）。**不能**把它当成永久保护：
   `shutdown()` 会故意留下 `pending` 快照，那样会让每个「排过延迟任务后退出」的目录永不回收
   （REV-33 复核抓到的反向回归，已回退）。
3. **空闲时长 ≥ `max(PI_ASYNC_SWEEP_SIBLING_AGE_MS, PI_ASYNC_RETENTION_MS + 1)`**。默认年龄闸 = 14 天
   （2 × 默认 retention 7 天）；**钳位使得年龄闸永远严格大于 retention 窗口**，因此本闸不会早于
   「产物本来也该过期」的时刻生效。
   「空闲时长」= `max(目录 mtime, 目录内最新产物文件 mtime)`——活着的会话写快照走 temp+rename，
   会顶起目录 mtime，所以这个代理量比只看目录 mtime 更保守。

**判无知的默认答案是「不删」**（`不许静默删数据`）：以下情况一律跳过并记入 `skipped` 原因：

| 情况 | reason |
|---|---|
| 当前 dataDir（含软链/大小写/`..` 别名，按目录身份判定） | `current` |
| 目录里有 dataDir 永远不会写的东西（子目录、软链、非产物文件） | `foreign_content` |
| 有 `.json` 解析不出快照（损坏/半写/不认识） | `unreadable_snapshot` |
| 非终态快照指向活 pid | `live_task` |
| **非终态**快照的 `pid` 存在但不可探测（`0`/负数/小数/超出 `pid_t`）：终态快照的 pid 从不被探测，不受此限 | `unreadable_snapshot` |
| owner marker 的 pid 仍活着（进程语义） | `owner_alive` |
| owner marker 存在且读不出正整数 pid（解析失败、**不是普通文件**、EISDIR/EACCES/EIO） | `unreadable_owner` |
| 未过年龄闸 | `recently_active` |
| 超过本轮扫描上限（`MAX_SCAN_DIRS = 256`，按名字排序后截断） | `scan_limit` |
| root 下的条目不是**不跟随软链的普通目录**（符号链接 / 普通文件） | `not_a_directory` |
| 不是 dataDir 的目录却带有产物字节（不参与配额也不产生候选） | `not_a_data_dir` |
| `rm` 抛错 | `delete_failed` |
| `dirname(dataDir)` 是文件系统根（`/`） | 直接拒绝整轮，日志明示 |

`foreign_content` 是防「root 猜错」的最后一道闸：dataDir 里有 `<uuid>.<suffix>` 与 `*.tmp` 之外的东西，
就说明 `dirname(dataDir)` 不是 pi-async 的布局（例如有人把 dataDir 指到 `~/proj/data`），此时删 sibling
等于删别人的项目 —— 一律不删。**不能只按「目录里没有产物文件」判定可删**：空目录确实是回收对象，但那
由年龄闸决定；`*.tmp` 残留同样既不让目录变得「可删」、也不让它变得「不可删」。

### 25.4 S2：全局字节配额（先算账，再按确定性顺序删）

`PI_ASYNC_TOTAL_BYTES > 0` 时，每轮：

1. **算账**：root 下所有 dataDir（含当前）的产物字节求和（含被保护的部分，所以「满了」是诚实的）。
2. **候选**：只挑**终态**任务的产物集（一个任务的四个后缀作为一个整体），外加**没有快照指向的孤儿产物**
   （`tier 0`）。**非终态永远不是候选**；**目录里有活着的非终态任务时，整个目录不贡献候选**（保守优先于配额）。
   **读不出快照的目录（`.json` 解析失败、未知 status、或触到 `MAX_SNAPSHOTS_PER_DIR` 上限）整目录不产生候选**
   —— 「不知道」绝不能被读成「没人要」：一个解析不出快照的产物，正是删掉就再也没人看得见的产物。
   这类目录记入 `report.unreadableDirs`，其字节仍计入 `used`，因此配额会诚实地报 `overQuota`。
3. **分层**（`tier` 越小越先删）：
   - `0` 孤儿产物（没有任何快照能观察它）；
   - `1` **policy-expired**：`finishedAt ?? createdAt` 落在 retention 窗口外，**且**不在最新
     `PI_ASYNC_RETENTION_COUNT` 个之内 —— 与 `prune()` 的并集策略逐字同义，所以默认配额**永远不会删掉
     retention 仍承诺保留的东西**；
   - `2` 仍在 retention 窗口内（**只有 `PI_ASYNC_QUOTA_HARD=1` 才会成为候选**）。
4. **删序（确定、全序、与插入/readdir 顺序无关）**：`tier` 升序 → `ageAnchor` 升序 → `taskId`（孤儿用文件路径）
   字典序升序 → `dataDir` 字典序升序。最后一键是必需的：`migrateDataDir()` 的 best-effort 清理可能把同一个
   taskId 留在两个目录里，没有它这两条候选会「相等」，顺序就退化成输入顺序。
   `prune()` 与 `expiredTaskIds()` 共用同一个 age 键**和**同一个 id 兜底，两者对「同 age 的陌生人」判断一致；
   tier 1 与 `prune()` 的并集策略逐字同义，所以默认配额永远不会删掉 retention 仍承诺保留的结果。
5. **停手条件**：累计到 `used <= quota` 立即停（不是「全删」）。
6. **超限行为**：
   - 软模式（默认）：非 tier 2 的删完仍超 → **停手**，保留其余产物，报表 `overQuota: true`，并写一条
     明确日志（含 used/quota 与「抬高 `PI_ASYNC_TOTAL_BYTES` 或设 `PI_ASYNC_QUOTA_HARD=1`」的指引）。
     **绝不为了凑配额去删活任务、删非终态、删 retention 还承诺的结果。**
   - 硬模式（`PI_ASYNC_QUOTA_HARD=1`）：继续按同一顺序淘汰 tier 2，**每一条删除之前先写一条日志**
     （任务 id、目录、原因、字节数），并在返回的 `evicted` 里逐条列出。
7. 当前 dataDir 的任务被淘汰时走既有 `removeArtifacts()`：文件、内存快照、timer、`notifyClaims` 一起消失
   （不留幽灵任务）；sibling 目录只删盘上文件，目录本身保留。

### 25.5 可观测性（为什么不是 `async_status`）

- 每一次删除**先写日志再删**：`console.warn("pi-async: storage: …")`，逐条含**目标、原因、字节数**，
  末尾一条汇总（freed / 剩余 / root）。
- `sweepStorage(now?)` 返回 `StorageReport`（`removedDirs` / `skipped[]` / `evicted[]` / `usedBytesBefore` /
  `usedBytesAfter` / `overQuota` / `freedBytes` / `lines`），`registry.lastStorageCleanup()` 取最近一轮。
  `lines` 与日志逐条相同 —— 测试与 embedder 都能断言「删了多少、为什么删」。
- **`async_status` 的返回形状不变**（仍是快照数组）：改 payload 字段/语义属 §12 的破坏性工具面变更，
  本条不做，也不新增工具。**不使用 activity**：§7 已裁定 activity 是 write-only、不能读回、
  「任何消费者不得把 activity 的有无当作工作证据」，所以它不能当清理证据。

### 25.6 调用点、节流与不可逆性

- 调用点在 `configure()` 末尾（低频、幂等、带 `PI_ASYNC_SWEEP_INTERVAL_MS` 节流，默认 60s；`0` = 每次）。
  **不放构造器**（D-04 工厂无副作用）、**不放 `TaskRegistry` 的每任务 hot path**；整轮受
  `MAX_SCAN_DIRS = 256` / `MAX_SNAPSHOTS_PER_DIR = 512` 约束（先按名字排序再截断，截断本身也是确定的）。
  最坏情况是一轮 256 × 512 次同步读（`~/.pi` 落在 NFS/iCloud 上时最明显）：一轮是同步的、且在
  `configure()` 的调用路径上，所以节流间隔就是它的上界频率。要更省就抬高
  `PI_ASYNC_SWEEP_INTERVAL_MS` 或把开关关掉（默认就是关的）。
- 一轮出错只 `console.error`，`configure()` 不 throw（D-05）。
- **不可逆**：删掉的产物与目录无法恢复（没有回收站、没有归档副本）。**回退开关只有一个方向**：
  `PI_ASYNC_SWEEP_SIBLINGS` / `PI_ASYNC_TOTAL_BYTES` 回到默认 `0` 即停止后续清理（已删的不会回来），
  此时行为与 0.5.x 完全一致。

### 25.7 已知边界（不在本条范围）

- 不杀跨进程的活 pid 孤儿；只跳过。
- 不删父目录、不删当前 dataDir、不删未过年龄闸的 sibling。
- **S2 不看 owner marker**：配额保护的单位是「目录内有活着的非终态任务」，不是「目录属于活 session」。
  因此活着的空转 session 的**终态**产物仍可能被配额淘汰（tier 1 是它自己的 `prune()` 也会删的，tier 2 需显式
  `PI_ASYNC_QUOTA_HARD=1`）。这是有意的：marker 回答的是 S1 的问题（整目录回收），把它接进配额会让
  「一个活着但 14 天没动静的 session」永久钉住配额。
- **marker 之前的目录没有自证能力**：0.5.1 及更早的 session 从不写 marker。这类目录只能靠
  「没有活 pid 的非终态快照 + 年龄闸」判定；如果那个老进程**还活着**但只剩终态任务，就区分不出来。
  残留风险是有界的：需要同一目录下 14 天没有任何写入。新版本一旦写入就补上 marker（§25.2）。
- **`pending` 快照不提供判活证据**：延迟任务在 spawn 前没有 pid，这类目录靠 marker + 年龄闸判定。
  后果：一个 **0.5.1 及更早**（从不写 marker）的 session 如果只剩 `pending` 任务且还活着，理论上在
  14 天后可被回收。与上面「无 marker 的旧目录」是同一条残留风险。
- **单 marker 单 owner**：两个进程共用同一个 dataDir（同一 sessionId 并发打开）时，marker 是 last-writer-wins；
  后写者死后目录会被回收，即使另一个 owner 还活着。代价是该会话丢失数据目录（其任务在内存里仍可见，
  但盘上产物没了）。要彻底封闭需改 marker schema（记 owner 集合），属独立变更。
- **survey 与 rmSync 之间无二次确认**：一轮先全部 survey（含判定），再统一删；几十毫秒到百毫秒的窗口里
  若有进程恰好“恢复”到那个旧目录，会丢。这是既有设计（§25.6 的同步一轮），修需重新判定，未做。
- **marker 写失败只记日志**（`writeOwnerMarker` 不得打断 `persist()`）：写不出 marker 的活 session
  在年龄闸后可能丢目录（与「无 marker 的旧目录」同一条风险）。
- **pid 复用只往保守方向错**：一个死 session 的 marker pid 被无关进程复用时，该目录会一直被保留。
  只漏回收，不误删。
- **扫描上限也是记账上限**：`MAX_SCAN_DIRS = 256` 按名字排序截断，截断掉的目录既不计字节也不产候选。
  因此 `usedBytesBefore` / `overQuota` 只对**已经扫到的**目录成立：目录数超过 256 时，配额可能在
  「还有未扫描字节在盘上」的情况下报 `overQuota: false`。这是有界但真实的不精确；要更准就抬高上限（同步代价见 §25.6）。
- **头部饥饿**：截断是按名字排序取前 256 个。如果前 256 个里有大量**永久跳过**的目录（例如每个都带一个
  `.DS_Store` → `foreign_content`），排在后面的可回收目录**永远不会被扫到**。这是既有语义（与上面的记账上限同源），
  REV-33 修掉「活 session 被删」之后它才变得可见（旧代码会先删掉那些头部的目录）。
- **扫描/计划的字节是“扫到的”，删除后的字节是“量到的”**：`planEvictions` 乐观地按 surveyed size 递减，
  `StorageReport` 用实际 `lstat` 到的 size 累计。两者不一致时（文件消失、变成非普通文件、metadata 指向异常），
  实际结果只会是**少删 + 诚实地报 `overQuota`**，要等下一轮补完。
- 不清理 `*.tmp` 残留（只有整目录回收会连带带走）。
- 一个目录里有活着的非终态任务时，该目录的**终态**产物也不会被配额淘汰（保守；下一轮该目录空闲后再参与）。
- **S1 的年龄闸只按年龄，不叠加 `PI_ASYNC_RETENTION_COUNT`**（有意的不对称）：`prune()` 的 count 窗口是
  「每个 dataDir 内最新 N 个终态任务」——它假设这个 dataDir 还会被打开。S1 回收的恰恰是**已废弃**的
  session 目录（新 sessionId 每次都是新目录，旧目录永不再被 `configure()`），对它们套用 count 窗口等于
  永不回收。判断「已废弃」靠的不是猜测：owner marker 的 pid 已死 + 空闲超过年龄闸。

### 25.8 验收清单

- `tests/a-storage-sweep.test.ts`：三闸（当前 dataDir 不删 / 无活 pid 快照/无活 owner 才删 / 未过期不删）
  与反向用例（三闸都满足时目录被删）；父目录不被删；`*.tmp` 残留不被误判；`foreign_content` /
  `unreadable_snapshot` / `unreadable_owner` / `unknown status` 不删；年龄闸钳位不弱于 retention；**软链别名下当前 dataDir
  仍不被删**；**活 session 的空转 dataDir 被 owner marker 保护**（owner 死后可回收）；文件系统根被拒绝。
- **REV-33 的判活断言**：marker 的 pid 是一个**活着但不是进程组长**的进程时目录仍被保护（并自带
  fixture 断言：该 pid 活着、且 `kill(-pid, 0)` 必须是 ESRCH，否则测试主动红）；marker pid 为 `0` / 负数 / 小数
  → `unreadable_owner`；marker 变成**非普通文件 / 悬空软链** → `unreadable_owner`（不得读成「无 owner」）；
  快照 `pid: 0` → `unreadable_snapshot`；**`pending` 无 pid 的目录由 marker 定生死**（marker 活 → 保；
  marker 不存在且过龄 → 回收），并以此钉住「不得把 pending 当永久保护」的反向回归。
- 配额：恰好等于配额不删（边界）、多一字节才删；软模式只淘汰 policy-expired 且超限时 `overQuota: true`
  并保留；硬模式淘汰仍保留的产物且逐条日志；活任务永不被淘汰；**读不出快照/触到快照上限不产生候选**；
  **当前 dataDir 里有一个 `.DS_Store` 不会让配额自行失效**。
- 删序确定性：`orderEvictions` 用 20 条同 tier 同 age 的候选断言全序（与输入顺序无关）；
  **跨目录同 taskId 时 `dataDir` 兜底**；`orderSiblings` 用 `lastActivityMs` + name 兜底断言。
- 默认关闭：两个开关都不设时 `configure()` 不删任何东西、`sweepStorage()` 是零 I/O 空操作。
- 测试**不指向真实 `$HOME`**：全部在 `mkdtemp` 的假 session 树下构造。
- 全量 `npm test` 只增不减（新增 38 例全绿；本机 macOS 上另有 15 个**既有**失败与本次无关，其中 `kill EPERM`
  那条 flake 在未改动的 `origin/main` 上同样复现），`npm run typecheck` 全绿；变异证据见
  `docs/reports/storage-lifecycle.md`。

### 25.9 REV-33：0.5.2 合入后复核的判活修正

**原因（为什么这条要写进冻结契约）**：PR #106 合入后的独立复核发现闸 2 的判活口子，能把一个
**还活着的 session** 的 data dir 判成可回收——正是本条声称要防的事。两项都不是「新需求」，而**是实现
没做到契约已经承诺的事**，所以按修订记录而不是新增能力。

1. **marker 用错判活语义**。`writeOwnerMarker()` 写的是 `process.pid`（§25.2），但 `siblingVerdict()` 用
   `pidAlive()` 探测它，而 `pidAlive()` 答的是**进程组**问题（`/proc` 里 `pgrp === pid`，否则
   `kill(-pid, 0)`）——任务子进程 `detached` 后 pid == pgid，所以对任务是对的；session 进程通常只是
   shell 进程组的成员，于是「活着的 session」被报成死的，整目录在过完年龄闸后被 `rm -rf`。
   实测（macOS）：非组长子进程 `kill(pid, 0)` 成功、`kill(-pid, 0)` = ESRCH → 旧代码删除目录且
   `skipped` 里根本没有 marker 的影子；压测同形状的 leader pid 则被保护。Linux 同一结论：非组长进程的
   `pgrp` 永不等于它的 pid。**合入时那 32 例测试全绿**，因为它们把 marker 里的 pid 填成 `submit()` 的
   任务 pid（detached ⇒ leader），生产永远不会写这种值。
2. **「读不出 marker」被当成「没有 marker」**。旧代码把 `readFileSync` 的任何失败（EACCES/EIO、marker 变成
   目录或悬空软链）归成 `markerRaw = undefined`，于是「不知道 owner 是谁」直接退化成「没人拥有这个目录」。
   同类问题：快照的 `pid` 只要求是 `number`，`pid: 0` 在 macOS 上是「我自己的进程组」（判活）、在 Linux
   上是「永不死」（判死）——同一个快照在两个平台得出相反结论。

**影响面（改了什么）**：

- `src/core/registry.ts` 新增 `processAlive(pid)`（**进程**语义：`kill(pid,0)`，`EPERM` = 活，Linux `Z` = 死），
  **只给 owner marker 用**；`pidAlive()` 一字不改，任务 pid 继续走组语义（REV-28c 的#6 语义不动）。
- `src/core/storage.ts`：marker 的 pid 只接受**正整数**（其余 `ownerUnreadable`）；**marker 的存在本身是证据**
  ——名字在但读不出/不是普通文件 → `ownerUnreadable`，不得当成「无 owner」；快照的 pid 同样只接受正整数，
  否则整个目录记 `unreadable_snapshot`；`siblingVerdict()` 接两个**独立注入**的判活函数（避免一次注入
  两处复用又把两种语义混起来）。理由都是同一条：**「无法证明」不得等于「已死」**。
- **明确不做**：给「非终态但无 pid」加永久保护。`shutdown()` 会将 `pending` 快照留在盘上（延迟任务在 spawn
  前就没有 pid），加永久保护会让每个「排过延迟任务后退出」的目录永不回收——复核实测该写法的第一版补丁
  确实把这类目录钉死了 10 年，**已回退**：这类快照不提供判活证据，降到 marker + 年龄闸判定。
- 新增 8 例回归（含一个**自觉地断言自己处在难例**的 fixture：marker 的 pid 必须活着且不是进程组长，
  否则测试自己红），并把一条**空转断言**（`a.json` 从未被创建，永远为真）改成断言真正被淘汰的文件。
- **只对非终态快照做 pid 校验**：终态任务的 pid 从不被探测，若把不可探测的终态 pid 也算成「目录不可读」，
  该目录的产物会**永不淘汰**、配额永远报满（这是第一版补丁引入的配额回归，第二轮回核抓到并修掉）。
- 不改工具面、不改默认值、不改 `prune()`/`reapOrphans()`、不新增 env。

**回退开关**：无（纯安全修正；若需与 0.5.2 行为一致，把 `PI_ASYNC_SWEEP_SIBLINGS` / `PI_ASYNC_TOTAL_BYTES`
置回默认 `0` 即与 0.5.x 完全一致）。

**证据**：`docs/reports/storage-lifecycle.md` §11（逐项断言、变异「撤掉即红」、仍存留的已知边界）。

## 26. 条件求值可抢占：硬预算 + 超预算 = 未命中（REV-34，冻结）

**事故面（量得到，不是形态学风险）**：`output_matches` 的正则求值全程同步跑在主线程上
（`src/core/watch.ts` 的 `evaluateCondition`），于是一个**26 码元**的输入就能把宿主冻住：

- `(a|a)*$` + 主体 `"a"*25 + "!"`：冷路径 **5.02 s**（热 781 ms，`docs/reports/redos-benchmark.md` §4.2）；
  19 码元就越过 25 ms（冷 39.0 ms），而良性形状跑满 64K 只要 0.06 ms（冷 0.14 ms）。
- 期间事件循环完全停摆：先上弦的 **100 ms 定时器**被拖到 **3.12 s** 才触发（同上 §5（2））。
  这意味着 `timeoutMs` / `intervalMs`（两者都在同步求值**返回之后**才被读到）**无法抢占**，
  TUI、其它任务的读取、通知投递一起被冻。
- 现有唯一守卫是形状黑名单（`NESTED_QUANTIFIER`，`src/core/watch.ts`），4 个已知形状只挡住
  `(a+)+$`；`(a|a)*$` / `(a|aa)+$` / `(.*a){20}$` 都能通过校验。形状匹配**不可能完备**（`docs/reports/redos-benchmark.md` §6 的 REV-R3），
  所以它只能算深度防御。

**影响面（改了什么，按 §16 的格式）**：

- **新增源码** `src/core/regex-worker.ts`（worker 池：复用、硬预算、越界 terminate + 重建、按 pattern
  缓存 `RegExp`）。`output_matches` 是唯一走它的条件类型。
- **内部 API 变异步**：`evalConditions` / `evaluateConditionsDetailed`（`src/core/watch.ts`）由同步变
  `async`；`evaluateConditionsDetailed` 由私有变导出，返回里多一个 `budgetExceeded` 计数。对嵌入式调用方
  是源码级破坏（必须 `await`），对工具面**不动**（§12 冻结的 5/6 个工具与其 schema 一字未改）。
- **快照新增可选字段** `matchBudgetExceeded?: number`（`TaskSnapshot`，`src/core/task.ts`）：因此
  `async_status` 的每行多一个**可选**键。**判定为非破坏**——这是新增可选字段，不是修改既有字段的语义，
  不迁移、不带默认值，旧快照读入后为 `undefined`（`async_status` 与详情把它当 0）。§12 的「修改返回
  payload 字段」判据针对的是**既有字段意义的改变**，本条不属于那类。
- **新消息类型 `async-watch-notice`**（`src/core/notify.ts`，`customType` 与 completion/reminder 同级）：
  `deliverAs: "followUp"`、**`triggerTurn: false`**——它是信息，不该开一个新回合；模型在下一次回合边界
  读到它，用户侧在 transcript 里看到它。每条任务只发一次（闩锁 `metadata.matchBudgetNotified`，随快照
  持久化，reload 不重播）。与 completion/reminder 一样，这条消息**没有专用 renderer**（宿主按通用
  `customType` 消息渲染），与既有提醒一致。
- **快照 metadata 新增键** `matchBudgetNotified`（布尔闩锁，模型在 `async_status` 里看得到）。
- **TUI 详情**多一行（仅 `matchBudgetExceeded > 0`）：header 因此是 1–2 行，§21.1 / §24 的「2 行」已
  按本条改写；视口算术不变（渲染取 `header.length`），超预算任务的中间窗口少一行。
- **不改**：工具面与 schema、`MAX_MATCH_CHARS`（仍是 64K）、读取窗口（8 MiB）、`blind_checks` /
  `timeoutMs` / `intervalMs` 语义、REV-4 的三条 kill 路径、黑名单规则本身。

**裁决 1（可抢占是硬要求）**：`output_matches` 的求值必须跑在**可被抢占的执行上下文**里（独立 worker
thread），**不得**留在主线程上。「求值完再检查耗时」在同进程里是无效实现——上一条实测已经证明期间什么
都跑不了。单次求值（一条条件一次）的**硬预算 25 ms**：依据是良性形状 < 0.1 ms（冷 0.14–0.33 ms，仍有
~75–100× 余量），而三种病态形状都在 28 码元以内越线。worker **复用**；越预算即 `terminate()` 并重建，
**worker 冷启动不计入预算**（否则良性形状第一轮就会被误判超预算）。预算只在消息投递之后计时。

**裁决 2（超预算的语义，钉死）**：预算越界 **不是**失败，也**不是**基础设施错误：

- 该轮该条件视为**未命中**（`matched: false`），`pending` 语义照旧，**不累计** `blind_checks`，
  不修改 `timeoutMs` / `intervalMs` 的行为，**绝不**因此把任务判失败或 kill（REV-4 的三条杀路径不动）。
- 每任务一个计数器 `matchBudgetExceeded`（只增不减，非终态与终态快照都保留），出现在 `async_status`
  的返回与 TUI 详情里。
- 每条任务**只提示一次**（不刷屏）：首次越界发一条提示，文案说明「条件求值超预算，已按未命中处理」，
  之后静默；计数继续累加。提示是**通知**，不是终态，不改 `status` / `failureKind`。
- **同一轮内的先后不变**：`failure_when` 先求值、再求值 `success_when`（既有 OR / 首命中语义，§4）。
  因此「`failure_when` 越预算 + `success_when` 命中」按 **success 结算**——放弃一次失败裁决不比让一个
  真命中落空更保守，而 `matchBudgetExceeded` 仍记这一轮（用户能从计数看出这一轮有一次未完成的裁决）。

**裁决 3（64K 窗口的理由改正）**：`MAX_MATCH_CHARS`（64K 码元）保留，但它的理由是**内存 / 取舍边界**
（一次求值要拷贝、要 `slice` 的主体会被有界），**不是**「限制 ReDoS 影响面」。§4 的「正则窗口」条目与 §20.2 的窗口表格行已按本条改写——原来那句话被 19 码元 / 26 码元两个数据点**证伪**：距 25 ms 预算，
只差 3 个码元。相应地 `src/core/watch.ts` 与 `src/core/registry.ts` 里把窗口说成 ReDoS 防线的注释同步改正。

**裁决 4（黑名单的定位）**：`rejectDangerousRegex` 是**深度防御**，不是防线。`(.*a){n}` 一类「有界重复
套 `.*`」永远挡不住，所以**防线是运行期预算**，不是形状判断。不做静态分析判「这个模式会不会爆」，也不换
正则引擎（另拆）。

今天 `(a|a)*$` / `(a|aa)+$` / `(.*a){20}$` **仍然通过校验**——这是有意的：#113 的复现形状必须能被求值，
否则本条没有可测的靶子（`tests/w3-preemption.test.ts` 的量具就是它们）。将来若收紧黑名单（例如补上
「含 `|` 的组 + 量词」），**必须同时**把 w3 的量具换成一个不被新规则拒绝的病态形状，并在同一次改动里
证明预算仍然咬得住；否则「收紧」只是把测试逼红，不改变防线。

**裁决 4b（超预算不是「测量到的未命中」）**：预算越界的字面语义是**放弃这一轮的裁决**（reason 同裁决 2：
按未命中处理）。用户可见文案必须说清这一点——`(a|a)*$` 穷举完指数路径后**会真的匹配**（`docs/reports/redos-benchmark.md`
§5（1）），所以一次越界可能**漏掉一个真命中**（`success_when`：一直不命中，最后由 `timeoutMs` 终结）或
**漏掉一次真失败**（`failure_when`）。提示与详情行的措辞因此是「abandoned verdict / no verdict」，不是
「确定的未命中」；能不能接受这个取舍由用户按提示换 `stdout_contains` 或收窄正则。

**裁决 5（异步化后的交错，REV-R5）**：求值变成 `await` 之后，同一个 task 可能在等待期间被 watch
timeout / 用户 `async_kill` / 代际 retire 终结。恢复执行时**必须重新判** `isTerminal(status)`（以及
`stopped` / `suspended` / `retired`），终态快照是唯一记录，`await` 之后不得重写终态，也不得再
`scheduleNext()`。进程退出路径（`live.exit.then` 里那次求值）同样走预算，同样遵守这条。

**已知限制（接受，不修）**：

- worker **起不来**（平台限制、被禁）时，该轮记为 `error`（既有语义：`blind_checks` 计一次基础设施
  失败），并在 stderr 打一行原因。不静默放行、也不偷偷退回同步求值（那会复活本条要修的冻结）。
- 每轮把 ≤64K 码元的**主体** `postMessage` 给 worker 是一次拷贝（128 KB 上限），量级在微秒。
- `readWatchOutput` 每轮同步读 8 MiB 尾部（REV-25）自身的停顿不在本条范围；它有自己的界。

**回退开关**：无（这是缺陷修复；需要回到旧行为只能回退代码）。

**验收**（`docs/reports/watch-preemption.md` 是证据）：

1. 对 `("a"*29+"!")`（30 码元）与 `("a"*25+"!")`（26 码元）配 `(a|a)*$` 求值时，**10 ms 定时器在
   200 ms 内触发**。修前两者都在同步求值里把定时器拖到秒级（28 码元实测 3.12 s，§5（2）已经量过；
   26/30 码元同一个量级）。
2. 同一轮 `async_status` 显示 `matchBudgetExceeded ≥ 1`，任务**不是** `failed`；`timeoutMs` / `intervalMs`
   在挂住场景下仍按预期生效（修前它们被饿死）。
3. 良性模式与 64K 良性输入的命中结果与 `main` **逐字相同**（对照表）。
4. 变异必红：① 去掉预算回到同步求值 → 验收 1 红；② 把超预算当失败 → 验收 2 红。

## 27. 终态快照不声称进程存活：判活/退出码三态（REV-35，冻结）

基线 `main` `56fff93`（0.5.3 已发）；来源 issue #116（裁决 B，覆盖 `docs/reports/pi-async-81-triage.md`
的 1.4 + 3.3）。证据见 `docs/reports/snapshot-honesty.md`。

**事故面（两处说了与事实相反的话）**：

- `finalize()` 无条件写 `processAlive: false`。D4 场景（`success_when` 命中、任务 `status = completed`、
  **进程仍在跑**）的快照因此与事实相反；而 `src/core/notify.ts` 的通知字段表里根本没有这个字段，下游
  无从分辨「观测到死了」与「默认填了 false」。
- 收养任务的退出码取到又丢掉：`live.exit.then` 的退役分支（`if (this.suspended || live.retired) return { code }`）
  拿到了子进程退出码，但一个字节也没落盘。跨进程本就物理不可得，**同进程 `/reload` 却可以**。

**裁决（B，钉死）**：终态快照的价值是「最后一次**确定**的事实」。不知道就写不知道——`processAlive: false`
会让下游（agent、人、将来的统计）把「没看见」当成「看见了死」。代价是文档必须明说这条边界，并在
显示层把 `null` 渲染成「未知」而不是「已退出」。

**影响面（改了什么，按 §16 的格式）**：

- **快照新增/变更字段**（`TaskSnapshot`，`src/core/task.ts`）：
  - `processAlive?: boolean | null`：`false` = 退出**被观测到**；`null` = 什么也没观测到（**JSON 里出现
    `null`，不是缺字段**，以便与「旧快照没这个字段」区分）；运行中的快照不写。
  - `processAliveKnown?: boolean`：`true` **仅当** `processAlive` 是一次观测的结论（不是默认值）。
  - `exitCode?: number | null`：数字 = 拿到退出码；`null` = 没拿到。
  - `exitCodeKnown?: boolean`：`true` **仅当** `exitCode` 是一个**确定的**数字。确定有两个来源：
    观测到的退出码（退出事件里拿到的那个），或 pi-async 自己下的判决（**启动失败**：进程根本没起来，
    §8 规定写 `exitCode: 1`，此时 `processAliveKnown` 仍是 `false` —— 没有进程可观测）。除此之外
    一律 `null` + `false`，读作「没拿到」，**不得**与 `exitCode: 0` 混为一谈。
  - **killed 行不带退出码**：`status: killed` 的结算一律 `exitCode: null` + `false`（§6 的失败矩阵
    只给 killed 行 `kill-kind`）。信号死亡的子进程，spawn 层（REV-28d）会报一个 `1` 兜底值 —— 那是
    它自己的兜底，不是子进程的判决，所以不作为退出码记录。这条与「谁先结算」无关：退出事件先到或
    `killTree()` 的确认先到，写出来的都是同一份记录。
- **`finalize()` 多一个「观测到了什么」参数**：`"exit"`（退出事件/退出码）/ `"gone"`（探活证明进程组
  已消失，但没有退出值）/ `"unknown"`（默认：什么都没观测到）。只有前两者写 `processAlive: false` +
  `Known: true`，`"unknown"` 写 `null` + `false`。
- **通知字段表**（`src/core/notify.ts`）：新增 `process-alive` / `process-alive-known` / `exit-code-known`
  三个 XML 字段（structured details 同步）。`exit-code` 只在拿到数字时输出。
- **显示层**：`snapshotLiveness()` / `formatExitStatus()` / `exitSuffix()`（`src/core/task.ts`）是唯一
  判据；`async_status`（原始快照字段）、`async_wait` / hold / print-wait 的结果行、TUI 详情状态行、
  完成卡片都走它。**每一个终态快照**的详情状态行都带 `· process: <alive|exited|unknown> · exit <code
  |unknown>`（运行中的快照不带：还没有主张）。
  旧快照（无新字段）读作 `unknown`，**不推断**：`processAlive: false` 而没有 `processAliveKnown` 时
  **不**当「已退出」（0.5.3 及更早无条件写 `false`，那个 `false` 是默认值，不是证据）。
  例外且只此一处：`exitCode` 是**数字**而 `exitCodeKnown` 缺失时按已知处理——旧代码只在观测到退出码时
  才写数字，这个值是证据形状的（`false` 不是）。
- **`async_wait` 的结果行形状不变**（§5/§12 冻结）：`exitCode?: number` 仍是「有数字或没有这个键」，
  未知就是不出现；三态只在**快照**里（谁需要区分「未知」与「没有」读 `async_status`）。
- **同进程 `/reload` 的退出码交接（3.3）**：退役代在退出回调里把观测到的数字**合并写回**已持久化的
  快照（只碰 `exitCode` / `exitCodeKnown`，绝不动 `status` / `finishedAt` / `killKind`），收养代在结算
  该任务时读取这个观测（`persistedExitCode()`）。**不做**跨进程交接（物理不可得，不假装）。
- **不改**：工具面与 schema（§12 冻结）、`isProcessAlive()`（`async_kill` 的即时探活，仍是布尔）、
  REV-28a 的「终态快照是唯一记录」、kill 语义、watch 语义。

**不变量**：

1. 没观测到进程退出 → 终态快照 `processAlive: null` + `processAliveKnown: false`。这一类是：D4 watch
   命中（进程还在跑）、未确认的 kill、**没有 pid 可探的快照**、pending 取消、`lost` 但没有探活证据。
2. 观测到退出 → `processAlive: false` + `processAliveKnown: true`。两种观测都算：退出事件，或探活
   证明进程组已消失（`pidAlive()` 说没了 / 两次连续死探针 / 收养代的 watcher / `killTree()` 确认）。
   `lost` 但探活到进程组已死，属于这一类，不是第一条。
   有退出码时 `exitCode` 是数字且 `exitCodeKnown: true`；killed 行或没拿到时 `exitCode: null` + `false`。
3. 旧快照（无 `processAliveKnown` / `exitCodeKnown`）一律按「未知」显示，**不迁移、不推断**。
4. 终态快照的其它字段不被退役代的交接写坏（REV-28a 不变）。

**已知边界（接受，不修）**：

- 收养代的探活 watcher（默认 100 ms）可能先于退役代的退出回调结算同一任务：那时记录已经终态，
  交接**跳过**（`status` 是收养代的，退出码保持 `null`）。这条只在同进程 `/reload` 的竞态窗口内出现，
  不会写出与事实相反的 `false`——只是少一条证据。
- 跨进程收养（宿主重建进程）拿不到退出码：`exitCode: null` + `exitCodeKnown: false`，不假装。

**回退开关**：无（缺陷修复；回到旧行为只能回退代码）。

**验收**（`docs/reports/snapshot-honesty.md` 是证据）：

1. D4 场景（watch 命中、进程仍在）→ `processAlive: null` + `processAliveKnown: false`；修前是 `false`。
2. 观测到真退出 → `processAlive: false` + `processAliveKnown: true`（对照组：确定性不变成 `null`）。
3. 收养任务：同进程拿到退出码 → 落盘且 `exitCodeKnown: true`；拿不到 → `null` + `false`（两个用例）。
4. 旧快照（无这两个字段）读出来显示「未知」，不崩、不推断。
5. 通知字段表里能看到这三个字段（表与实现一致）。
6. 变异必红：① `finalize()` 回到无条件写 `false` → 验收 1 红；② 把 `null` 当 `false` 渲染 → 验收 1/4 红。
7. `npm run typecheck` exit 0；`npm test` 与 `main` 基线逐条相同（红集合 `diff` 为空）；CI 绿。
