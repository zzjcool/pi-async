# Changelog

本文件记录用户可见变更。格式参考 Keep a Changelog，版本遵循 SemVer。

## 0.4.1 — 2026-11-08（面板实时输出 + 什么时候不该 async）

主题是**点击任务就看得见 stdout**，以及把「只在需要时异步」「先规划批次」写进提示，而不是靠口头交代。

### Added

- **详情页实时输出（REV-26，CONTRACT §21.1）**：
  - 输出窗口按剩余高度分配，**带 8 行下限**（`MIN_OUTPUT_ROWS`）：40 行终端 + 真实任务 metadata
    从固定 12 行变为 17 行；24 行终端（xterm 默认）仍有 8 行（无下限时只剩 4 行——review R2-3 实测，
    比改动前更差，故加下限，超发行由 `… (+K lines)` 折叠）。PageUp/PageDown 步长跟随窗口。
  - 面板自有 **1Hz ticker** 自刷新（固定 1000ms、`unref`、`teardown()` 统一 `clearInterval`）：
    running 任务的输出增长不产生 registry 事件，旧实现只靠事件驱动，详情尾部会冻结在打开那一刻。
  - 上滚锚定：`follow=false` 时新输出 `scroll += delta`，正在读的那几行原地不动；输出尚未超过窗口时
    按 ↑/`k` 不会留下幽灵 offset 把视图钉在旧行（R2-1）。
  - output 标签新增 live 标记：`output (live):` / `output (live, tail truncated):`。
- **「先规划批次」进常驻提示（REV-27，CONTRACT §21.2）**：`promptGuidelines` 第 4 条——独立长命令
  放在同一条消息里一起起，用一次 `async_wait` 收。此前全仓没有「提前规划 / 并行铺开」的措辞。
- **skill 补 `## When not to use async` + `## Plan the batch first`**：秒级命令、结果立刻要用且一分钟内
  结束、没有可重叠的工作、拿 async 掩盖失败，都不该用 `async_run`；并明确 `mode=sync` 同样注册为真实
  任务（因此会出现在 rail 里），只用于「下一步必须等它 **且** 可能超出 bash 窗口」。

### Fixed

- 点击 rail 或 `/async` 打开任务详情看不到 stdout：输出窗口过小（矮终端甚至少于 12 行）+ 运行期
  不重绘（见上）；小终端下命令/metadata 现让位给输出（折叠为 `… (+K lines)`）。
- `custom()` 在面板已建立后 reject 时未清理 1Hz ticker 与 registry 订阅（R2-2）。
- `docs/CONTRACT.md` §8 补「rail 不按 mode 过滤」（sync 也计入 running），§19 的 `promptGuidelines`
  条目从 3 条校准到 4 条；`README.md` 同步。

### 已知限制

- 输出超过 128KiB 尾窗后旧行滚出窗口，上滚锚定会随窗口漂移（此时 `output (tail truncated)` 同时出现），
  要看更早的输出请用 `c` 显示的 output 路径 + `bash`。

## 0.4.0 — 2026-11-07（settle hold + 有界 watch 读取）

主题是**状态与代价都不再说谎**：turn 结束不再闪一下 `done`（settle hold，默认开）；watch 不再每个轮询
tick 整文件重读；契约与报错文案校准到实现。此外含 0.3.1 之后未发版的 REV-23（运行期提醒 +
`async_extend`）与 REV-24（代际交接）。

### Added

- **settle hold（默认开，CONTRACT §7.1 / D-14）**：交互 TUI 主会话在一个 turn 结束时，如果还有
  「会唤醒会话」的 **running** async 任务（`notifyOnCompletion !== false` + `triggerOnCompletion !== false`）
  在跑，就在 `agent_before_settle` 边界内轮询等待它们全部终态再 settle，上限 `PI_ASYNC_HOLD_MS`
  （默认 10 分钟，单调时钟计时）；期间终端 OSC 7501 保持 `working`，不再闪一下 `done`。全部终态时追加一条
  `async-task-settle-results` custom_message（只有 name/status/exitCode，不含 outputTail）并 `continue: true`，
  让结果落进 transcript 且一定还有一轮续跑；超时则原样放行（无 entries/continue）。
  每 run 最多 1 次（`agent_start` 重新武装），不 consume、不抑制通知；轮询只有「全终态」与「预算耗尽」
  两条出口，不探测宿主队列（`ctx.hasPendingMessages()` 数的是会话级用户队列，hold 期间的完成通知走
  `agent.followUpQueue`，读它会在首个任务完成后误判并截断多任务 hold）。`pending`/delayed 任务、
  军团 child、`print`/`json`/`rpc` 模式都不 hold；footer 显示 `waiting for N tasks <elapsed>`。
  `PI_ASYNC_HOLD=0` 关闭整个特性，`PI_ASYNC_HOLD_MS <= 0` 同样关闭，`PI_ASYNC_HOLD_POLL_MS` 调轮询间隔。
  已知限制：hold 期间按 Esc 不会打断等待（边界内没有 host signal），`/tree` 这类 `await session.abort()`
  的命令也会等到放行；TUI 的 working 转圈在 `agent_end` 时已被宿主清掉，hold 不负责重新点亮。
- **运行期提醒 + 续期（REV-23，CONTRACT §18）**：主题是**提醒 ≠ 杀**——`taskTimeoutMs` 只有硬杀一档，
  杀掉正在跑的长构建比不杀更糟；而没有硬期限的 background 任务跑飞了又没人管。
  - `async_run` 新增 `remindAfterMs`（运行时长；`0` = 关闭）。background 且无 `watch` 的任务默认
    **20 分钟**（`1_200_000` ms）后收到一条 `async-task-reminder`（`deliverAs: followUp` + 触发新 turn，
    只带 8 KiB tail 切片）。带 `watch` 默认不提醒（`watch.timeoutMs` 已是期限），显式传才开；
    `timeoutAt` 会先到时**不布防**。`notifyOnCompletion: false` 一并静默提醒。
  - **提醒绝不改变任务**：不调 `kill`、不改 `status`、不写 `failureKind`；按 2 倍退避（1× → 2× → 4×）
    最多 3 次，用尽后不再布防、任务继续运行。抑制在**触发时**求值（已终态 / 输出已收割 /
    `notifyOnCompletion: false` / registry 已 closed 或 suspended），跳过时不重布防。
  - **新工具 `async_extend`（工具面 5 → 6）**：`{ taskId, remindAfterMs?, taskTimeoutMs? }` 续期提醒和/或
    硬期限，任一次续期重置计数与间隔，`0` 清除对应期限；两者都不传报错；终态任务返回 `alreadyTerminal`
    而不是错误（对齐 `async_kill`）。带 `promptSnippet`，否则不进系统提示（REV-20）。
  - **reload 安全**：`TaskSnapshot` 新增 `remindAt`（绝对时刻）/ `remindCount`；`/reload` 按剩余预算重布防
    并 `unref`（不会单独撑住宿主进程），已过期的 `remindAt` 立即触发一次并继续退避。一次性 `setTimeout`、
    回调内重读 registry、`try/catch` 包住——不复活 D-12 的 `setInterval`。
  - `SKILL.md` 增加一条纪律：默认 20 分钟提醒，收到提醒要么 `async_extend` 续期要么 `async_kill` 停止；
    提醒本身不杀进程。工具清单断言与 `CONTRACT §17` 的计数同步为 6 个。
- **工具在调用期解析活跃 registry（REV-24）**：`registerTools(pi, TaskRegistry | (() => TaskRegistry))`，
  传解析器时每次 `execute` 现取活代数，传实例保持旧行为；`tests/g-generation-handoff.test.ts` 覆盖
  解析器改道、跨代接管、无活代时报可操作错误。
- **`watch` schema 补齐字段级 description**：`intervalMs` / `timeoutMs` / `success_when` / `failure_when` /
  `blind_checks` 以及各 condition 的 `value` / `equals` / `regex`。其中 `blind_checks` 此前是裸字段，
  而它的语义（只计基础设施失败、默认 3、pending 不累计）恰恰是最容易误用的一项。
- `SKILL.md` 增加一个可复制粘贴的完整 `watch` 示例（含 `type` 判别字段与各 payload），
  并列出两种启动前即被拒的写法。

### Changed

- 常量 `MAX_OUTPUT_MATCH_BYTES` → `MAX_MATCH_CHARS`：旧名声称 bytes，实现是 `String.length` /
  `String.prototype.slice`（UTF-16 码元）。0.4.0 未发布，不留兼容别名。
- **契约把「窗口」拆成两层**：**读取窗口**（8 MiB，`WATCH_READ_BYTES` = `MAX_LOG_WINDOW`）与
  **正则窗口**（64K 码元，只对 `output_matches` 成立，子串条件扫全量）。README / SKILL 的面向模型措辞
  一并改正（此前提到的「整文件重读代价」已不存在）。
- `docs/CONTRACT.md` 校准 22 处到实现（逐条有代码依据）：
  - **矛盾纠正**：`taskTimeoutMs` 无 watch 必填约束（§3）；匹配窗口的表述（§4）；`shutdown()` 不杀
    pending delayed、只清 timer 并保留快照（§10）；工具集是 **6 个**（§3 漏了 `async_extend`）；
    `success_when` 详情只进 `metadata.watchSuccess`，完成通知 XML 不含该字段（§4/§6）；
    `context` 与 `context_with_system` 是**双注册 + signature 去重**（§17 REV-21）；D9 切 session **会**迁移
    产物（§13）；guidance 在 `failed` **或** `killKind=timeout` 时都带（§6）；`sync.timeoutMs` 必填是
    execute 运行时强制、不是 schema（§3）；`suspended` 无**运行期**重置路径（§19.2）；
    check 纪律在随包 skill 而不在 `promptGuidelines`（§4）。
  - **陈旧数值/失效引用**：常量名与语义；发布流程不再写死版本号（指向 §17 / §18–§19），并修正为
    Trusted Publishing（OIDC）+ `workflow_dispatch`；§18.8 去掉失效行号；§1 目录树补齐 `env.ts` /
    `duration.ts` / `context/nudges.ts` / `context/resources.ts` / `tui/host.ts` / `tui/width.ts` /
    `guard/hold.ts`；`notified` 标注为快照**顶层**字段；§18.11 交叉引用 §17 → §3；
    `initStatus` 不再写「仅 reportActivity」。
  - **反向缺口补写（代码有、文档没写）**：`async_kill` 的返回形状与 `isError` 判据（§16 REV-15）；
    `logs()` 的 8 MiB `MAX_LOG_WINDOW` 硬顶（§9）；`metadata.remindAfterMs` / `metadata.remindIntervalMs`
    与 reload 的退避基线来源（§18.8）；`resendUnnotified` 的 `notifyOnCompletion === false` 门（§2）。
- `README.md` / `skills/async-tasks/SKILL.md`：把「匹配窗口是尾部 64K」改成**只对 `output_matches` 成立**
  （子串条件扫全量）。这两处是模型**实际会读到**的措辞（`skills/` 经 `resources_discover` 注入），
  所以不能只改契约。
- `src/context/nudges.ts` 改了一条与实现不符的注释（原写“registration time 择一，宿主拿不到两个”，
  实际是两个钩子同时注册、靠 signature 去重）：**仅注释**，无逻辑变更。
- `docs/PLAN-CONTEXT.md` 顶部加状态横幅：本文是 0.3.1 阶段计划快照，当前契约以 `docs/CONTRACT.md`
  （已按 0.4.0 实现校准）为准。

### Fixed

- **watch 每个轮询 tick 整文件读取输出**：`readWatchOutput` 原本对 `.output` / `.stdout` / `.stderr`
  各自 `readFileSync` 整份读入，大日志在 watch 期间被反复全量加载。改走 `logs()` 的有界尾部读
  （`WATCH_READ_BYTES` = `MAX_LOG_WINDOW` = 8 MiB，**每流各一次**）。
  （默认写盘 cap 是 20 MiB，见 `PI_ASYNC_MAX_OUTPUT_BYTES`，所以「多 GB」需要先调大该 cap。）
- 行为变化（有意）：滚出尾部 8 MiB 的输出对**所有**条件不再可见。此时终态由命令退出码或 `timeoutMs`
  决定（区分是否命中要看 `metadata.watchSuccess`，不看 `status`）。看更早的输出用通知 XML 或
  `async_status` 的 `metadata.outputFile` 路径配 `bash`（如 `grep -n marker <file>`）；`async_logs` 救不了
  ——工具层硬顶 50 KiB，且只有头部 / 尾部两档，中间段取不到。
- 保留原有两条语义：数据目录外路径仍 throw（D-11）；合并输出文件缺失仍 throw（让 `blind_checks`
  能计为基础设施失败）；`stdout` / `stderr` 缺席仍按空串处理。
- **扩展代际切换后 `async_run` 永久拒绝准入**：宿主对同名工具是「首次注册胜」，而二次 `init()` 会把前代
  registry `suspend()`（REV-17）。两者叠加时，存活的工具闭包指向已退役的一代，`async_run` 持续报
  `admission is closed`，只能重启会话恢复。现在工具在**调用期**解析活跃 registry。
- **过时的只读快照**（同根因、更难发现）：`async_status` / `async_logs` 在退役代上不报错，返回旧一代的
  内存快照——一个「看起来正常但已经过时」的世界。同样由 REV-24 修复。
- 经由旧闭包进来的调用现在会把 **dataDir / cwd 配到活代数**上，不再让新代带着空配置开工。
- admission 的两条错误文案补上原因与出路（关闭 / 被 reload-resume 退役），不再只报 `closed`。
- **报错可操作性**（起因：`output_matches` 写 `(?i)fatal` 只收到 `invalid regex`，`delayMs` 缺 `mode`
  只收到「不合法」，两次都要靠猜才能改对）：
  - `output_matches` 的正则编译失败不再折叠成一句 `invalid regex`：回显原始正则、保留 V8 的原因
    （`Invalid group` / `Unterminated character class`），并在内联标志（`(?i)` / `(?m)` / `(?s)` / `(?x)`）
    时明确指出「编译固定带 `m`，JS 没有内联标志」+ 给出替代写法（字符类或 `stdout_contains`）。
  - `delayMs is only valid for delayed mode` 补上修复动作：`(pass mode: "delayed" to schedule it, or omit delayMs)`；
    `delayMs is required for delayed mode` 补上单位示例。
  - `docs/CONTRACT.md` 删掉 `\A` / `\z` 的错误建议——JS 把这两个当字面量 `A` / `z`，**不报错但锚定静默失效**，
    比报错更难查；改为 `[\s\S]*` 或 `stdout_contains` 的指引。
  - `docs/CONTRACT.md` 的 `intervalMs` 注释从「默认 30_000」改为「必填无默认」（与 schema、
    `validateWatchSpec` 的实际行为一致）。
  - 回归测试：内联标志与未闭合字符类必须分别给出可操作的报错（`tests/b-watch-validate.test.ts`）。

## 0.3.1 — 2026-11-07（可发现性层）

主题是**让模型重新发现这些能力**。0.3.0 把「状态面不说谎」做扎实了，但模型在系统提示里只看得到
`async_run` 一个工具（约 2% 的 shell 调用走异步）。本版只改提示面与上下文注入，不动任务行为。
详见 `docs/PLAN-CONTEXT.md` 与 `docs/CONTRACT.md` §17（REV-20/21/22）。

### Added

- **5 个工具全部带 `promptSnippet`**（REV-20）：宿主只列出带 snippet 的工具，此前
  `async_wait` / `async_logs` / `async_status` / `async_kill` 在系统提示的 Available tools 段缺席。
- **情境注入**（REV-21）：
  - `bash` 前台调用 ≥60s（或 `tail -f` / `until` / `watch` / `sleep N` 形状）返回后，追加一行建议改用
    `async_run`；宿主没给 wall time 时用 `tool_execution_start` 的起点计时兜底；
  - 有活跃任务时，每次 provider 请求前注入一行 `<async-state>`（空闲零 token，状态不变不重复）；
    尾句按真实的每任务通知开关分句，`notifyOnCompletion: false` 的任务标 `no-notify`，不再一律声称
    「完成会叫醒你」；
  - `async_run` 的 receipt 只在**例外**时多说一句（`willNotify: false` / `willWake: false` + 对应 hint），
    通用规则不重复计费；
  - 主会话 settle 前给出一次**不带 `continue`** 的建议（带着后台任务结束 turn 是合法的）。
- **采纳率度量**：`npm run adoption` 扫 pi 会话 JSONL，输出 bash 耗时分布、前台阻塞时间、sleep 轮询占比
  与 nudge 覆盖率（dev-only，不进包）。
- **随包 skill**（REV-22）：`skills/async-tasks/SKILL.md`，经 `resources_discover` 注册。check 纪律、
  watch 语义、promote/abort 等内容移到这里，按需加载。
- `PI_ASYNC_NUDGE=0` 关闭 `tool_result` / `context` 情境钩子。

### Changed

- `async_run` 的 description 收缩为两句，模式/超时语义下沉到字段级 description；check 纪律移入 skill。
- `promptGuidelines` 重写为 3 条「触发条件 → 动作」，并明确「不必为了结束 turn 而阻塞在 `async_wait`」
  （原话术把异步用法翻译成阻塞等待，review 记录 `async_wait` 超时中位数 210s）。
- **`killed` + `killKind=timeout` 的通知现在带 `guidance`**（D5 修订）：状态仍是 `killed`，只是补上下一步
  （调大 `taskTimeoutMs` 或改用 `watch`）。`completed` 仍然纯信息。
- settle 守卫的 `agent_before_settle` 改为所有会话注册：legion child 行为不变（≤3 次 + `continue`），
  主会话只给一次建议。

## 0.3.0 — 2026-11-02

自 0.2.0 起的累积发布（含 0.2.0 之后未发版的 6 个提交）。主题是**不再对用户和模型撒谎**：任务在
session cwd 执行、通知诚实标注 best-effort、工具契约对未知输入报错、子进程默认不继承凭证、
`/reload` 不再杀任务。升级前请先看 Breaking。

### Breaking

- **通知语义改为 best-effort**：`pi.sendMessage` 无 ack，删除「发送失败重试 ≤3 次 + 回滚」的假重试。
  `notified` 只在 `sendMessage` 返回后置 true；失败保持 false 并累加 `notifyAttempts`。
- **子进程环境默认 `safe`**：默认剥离 `*_API_KEY` / `*_TOKEN` / `*_SECRET` / `*_PASSWORD` /
  `*_CREDENTIAL*` 以及 AWS / GitHub / npm 专用键；显式 `env` 传 `PATH`、`LD_PRELOAD`、`NODE_OPTIONS`
  等危险键**直接报错**。`PI_ASYNC_ENV_INHERIT=all` 恢复完整继承，但**显式危险键覆盖在任何策略下仍被
  拒绝**（安全规则不可关闭）。
- **sync 非 0 退出现在返回 `isError: true`**（payload 仍保留完整 `SyncResult`）；但 promote/abort 的**等待
  超时不算错误**（REV-19，见 Changed）。
- **非 sync 模式传 `onTimeout` 会报错**（此前静默忽略）；**`async_kill` 对未知 id/name 报错**
  （此前静默成功）。
- **数据目录移出项目根**：改为 `<session dir>/pi-async/<sessionId>/`，无 sessionManager 时退回
  `~/.pi/async/<pid>/`（0.2.0 为 `<cwd>/.pi/async/<session-id>-<pid>/`）。
- **TUI 键位**：`k` 不再是 kill（改为上移），kill 改为 `x`（或 `K`，需二次确认）；
  `c` 不再「复制」输出路径（pi 无 clipboard API），只显示路径。
- **删除 `PI_ASYNC_HEARTBEAT_MS`**：settle 守卫心跳整体删除（自定义 entry 不进 LLM 上下文，
  60s 周期也命不中 legion 的 500ms `collectArtifactGrowing` 窗口）。
- **footer 改为默认关闭（opt-in）**：任务汇总默认显示在 rail 首行；仅当 `PI_ASYNC_FOOTER=1` **且**宿主
  提供 `setStatus` 时才额外渲染一行汇总（不再无条件设置 `pi-async` footer）。
- **删除 `ctrl+alt+a` 快捷键**：打开任务面板请使用 `/async` 命令。
- **删除 `PI_ASYNC_DOCK_SHORTCUT` 环境变量**：升级后此前配置的该变量不再生效。
- **rail 行数上限从 ≤10 行收紧为 ≤4 行**（含汇总行与溢出指示）。
- **面板从全屏改为居中百分比尺寸**：列表 80%×70%，从 rail 直入的详情 85%×80%。

### Added

- rail 首行新增汇总：running、pending（非零时）、elapsed、`✓N` 与 `✗N`（均仅在非零时显示，全失败时不出绿色的 `✓0`）；终态计数遵循 `/async-clear` watermark。
- `async_run` 新增 `promptSnippet` / `promptGuidelines`，模型在系统提示里就知道何时该用
  `async_run` / `async_wait` / `async_logs`。
- `async_wait` / `async_logs` / `async_kill` 的 `taskId` 支持任务 **name** 别名（重名报错并列出
  候选 id）；`async_status` 新增 `status` / `name`（大小写不敏感子串）/ `limit`（1–50，默认 50）
  过滤，`includeHistory: true` 按完成时间降序。
- `async_logs` 新增 `stream: "merged" | "stdout" | "stderr"`；输出文件缺失返回 `missing: true`
  而不抛错；越界路径读取被拒。
- 通知消息新增结构化 `details`，并通过 `registerMessageRenderer("async-task-notification")` 渲染成
  卡片（`✓ name (completed, 1.2s) · exit 0`，失败带 `✗` 与 killKind/failureKind）。
- `async_status` 快照暴露 `cwd` / `timeoutAt` / `watchDeadline` / `notifyAttempts` / `processAlive`；
  `delayedEnv` 的值打码为 `***`（保留键）。
- `session_start` 对未确认任务**补发一次**通知（24h 内、`notifyAttempts < 2`、未被消费）。
- 新增环境变量 `PI_ASYNC_ENV_INHERIT`（`safe` / `all` / `none`）、`PI_ASYNC_MAX_SYNC_TIMEOUT_MS`
  （默认 600000）、`PI_ASYNC_SETTLE_GUARD`（`0` 关闭守卫）。
- `safe` 环境策略在冻结清单（`*_TOKEN` / `*_API_KEY` / `*_SECRET` / `*_PASSWORD` / `*_CREDENTIAL*` 等）
  之外额外剥离 `npm_config_*` 中带 `auth` / `token` / `password` 的键（如 `npm_config__authToken`）：
  父 shell 导出的 npm 凭据不再进入任务，普通 `npm_config_registry` 等仍透传。
- delayed 任务启动失败（`cwd` 不存在 / 危险 `env` / spawn 报错）写 `metadata.startError`，并在完成通知的
  `guidance` 中以 `Start error: ...` 出现。
- 任务 `cwd` 持久化并在 reload 后恢复；`taskTimeoutMs` 的 `timeoutAt` 与 watch 的 `watchDeadline`
  在 reload 后按剩余预算重建定时器。
- 启动时孤儿清理：非终态且 pid 已死（或无 pid）的任务标 `failed` + `failureKind: "lost"`；pending
  delayed 的 `dueAt` 超出 retention 窗口同样标 `lost`，未过期的 pending delayed 按剩余 delay 恢复
  （不区分进程）。
- `<taskId>.stdout` / `<taskId>.stderr` sidecar 与按流读取；所有产物文件创建为 0600。
- settle guard 新增 `agent_settled` 兜底：aborted 且有活跃任务时发一条 `async-task-unresolved`
  followUp（不 `triggerTurn`，每 generation 最多 1 条）。
- 新增 `npm run verify` 与 `prepublishOnly`；CI 增加 node 22/24 matrix、pi 1.5.0 相容 job 与
  `npm pack --dry-run`；新增 tag 触发的 `release.yml`（publish + GitHub release）。
- 新增 `PI_ASYNC_FOOTER`（默认关）：设为 `1` 且宿主有 `setStatus` 时额外显示一行汇总。

### Changed

- settle guard 提醒改用 `custom_message`（`display: false`，进入 LLM 上下文），不再用
  `appendEntry`（custom entry 不进上下文）。
- `session_shutdown` 读取 `reason`：`reload` / `resume` → `suspend()`（不杀进程，交给下一代收养）；
  `quit` / `new` / `fork` / 未知 → `shutdown()`（kill）。
- factory 期不再 `mkdir` / `reloadFromDisk` / 起 timer；首个 `session_start` 才 `configure()` 并补发。
- 工具 `execute` 使用 `ctx.cwd`（第 5 参）；delayed 任务保留提交时 cwd；任务不再依赖 pi 进程目录。
- 面板改为事件驱动刷新（订阅 registry 事件，`dispose()` 退订），overlay 单例；kill 失败不再冒泡成
  unhandledRejection，改为 `actionError` + `ui.notify`。
- 详情视图不再静默裁掉 footer 键位提示：超出预算时保留 header + 最后 N 行并插入 `… (+K lines)`。
- rail 删除不可达的 PageUp/PageDown `handleInput` 代码；汇总计数与任务行使用同一可见窗口。
- peerDependencies 保持 `^1.2.0`（本次用到的 `ctx.cwd`、`execute` 第 5 参、`onUpdate`、
  `promptSnippet`、`registerMessageRenderer`、`agent_settled.aborted` 在 1.2.0 类型里已存在），
  CI 另跑 pi 1.5.0 的 typecheck/test。
- sync `onTimeout: "promote"` / `"abort"` 的等待超时**不再是工具错误**（REV-19）：`isError` 只在任务真的以
  非 0 状态结束时为 true；promoted/abort 的 payload 带 `promoted` 与 `status: "running"`。
- `R` rerun 在原任务的 `cwd` 执行（不再用当前 session cwd）。

### Fixed

- **settle 守卫心跳会在 ctx 失效后杀死整个 pi 进程**（崩溃 2026-10-21，`pi` 1.3.0）。
  宿主一旦使捕获的 factory ctx 失效（会话替换或 reload），`pi.appendEntry` 就会抛
  "This extension ctx is stale"；而心跳跑在 `setInterval` 回调里，**不在 pi 事件循环的
  try/catch 内**，异常逃逸成 `uncaughtException`，pi 直接退出。0.3.0 的处置：心跳已整体删除
  （见 Breaking），守卫只保留事件驱动路径，且不论哪条 teardown 没跑到都能自愈：
  - 不再在被失效 ctx 上调用 `appendEntry` —— 提醒走 `agent_before_settle` 返回的 `custom_message` entry；
  - `reportActivity` 读取 `pi.ui` 时捕获 stale ctx，异常即 `dispose()` 自身，不再重试已死的 API；
  - `init()` 在生成新一代时先 `dispose()` 上一代守卫（`activeGuard`），不依赖某个 teardown 事件已先抵达；
  - 钩子释放改用 `pi.on()` 返回的退订函数 —— 真实宿主**没有** `pi.off()`，此前的
    `hooks.off?.()` 恒为空操作，等同于从不解绑。
- 任务在 pi **进程** cwd 而不是 session cwd 执行（`async_run("pwd")` 跑错目录）的问题。
- 通知 claim 在投递前置位、导致一次失败后永久静默的问题。
- 面板打开期间任务完成不刷新的问题；面板 `kill` 失败导致进程退出的问题。
- 数据目录落在项目根、可能被 git 或分享带走凭证的问题。
- `safe` 环境策略此前仅按 `*_TOKEN` / `*_SECRET` 等后缀匹配，会漏掉 npm 的 `npm_config_*` 凭据键
  （如 `npm_config__authToken`，其名字不以 token 结尾）；现在按前缀 + `auth`/`token`/`password`
  子串一并剥离，普通 npm 设置不受影响。

### 契约修订（REV-13 … REV-19）

- **REV-13（cwd）** 原因：任务继承 pi 进程 cwd，与 session cwd 不一致。行为：`RunOptions.cwd` /
  `TaskSnapshot.cwd` 持久化，`spawnDetached` 显式传 `cwd`，delayed 与 reload 保留提交目录。
  回退：无开关（正确性修复）。
- **REV-14（notify honesty / 补发）** 原因：`sendMessage` 无 ack，重试与回滚是死代码，claim 前置会
  永久静默。行为：单次投递、claim 后置、`session_start` 补发（24h / attempts<2）、`async_wait`
  消费即抑制、状态暴露 `notified` / `outputConsumed` / `notifyAttempts`。回退：单任务
  `notifyOnCompletion: false`。
- **REV-15（name 别名 / 工具契约）** 原因：模型按 name 调用失败、未知 id 静默成功、非 sync 的
  `onTimeout` 被吞、sync 失败不带 `isError`。行为：name 别名 + 重名候选、未知 id 报错、模式错配
  参数报错、sync 非 0 → `isError`、`async_status` 过滤/排序。回退：无（只放宽入参、收紧错误面）。
- **REV-16（env policy）** 原因：子进程默认拿到全部 provider 凭证，`env` 可经模型覆盖 `PATH` /
  `LD_PRELOAD`。行为：默认 `safe` 剥离敏感键（含 `npm_config_*` 中带 auth/token/password 的键）、
  危险键显式拒绝、delayed env 脱敏、`PI_ASYNC_INTERNAL_MAX_OUTPUT_BYTES` 始终删除。回退：
  `PI_ASYNC_ENV_INHERIT=all`（完整继承；显式危险键在任何策略下仍被拒绝）/ `none`（最小白名单）。
- **REV-17（dataDir / reload）** 原因：dataDir 在项目根可被 git 带走；`/reload` 会 kill 正在跑的
  任务；超时与 watch 预算 reload 后重置。行为：session 目录 + 0600 + 迁移失败保留旧目录、
  `session_shutdown.reason` 分流 `suspend` / `shutdown`、`timeoutAt` / `watchDeadline` 重建、
  `configure()` → `reapOrphans()` 清孤儿（running 死 pid / 超出 retention 的 pending delayed → `failed/lost`），
  未过期的 pending delayed 在下一个加载该 dataDir 的会话按剩余 delay 恢复。回退：
  `PI_ASYNC_RETENTION_MS` / `PI_ASYNC_RETENTION_COUNT` 控制终态产物保留窗口（orphan pending delayed
  只看 `PI_ASYNC_RETENTION_MS`）；不提供「回到项目根」开关。
- **REV-18（TUI）** 原因：`k` 在列表是上移、在详情是 kill，易误杀；`copyToClipboard` 不存在导致
  `c` 永远走 toast fallback；overlay 可叠加；面板打开时冻结。行为：kill 改 `x` / `K` 并二次确认、
  `c` 只显示路径、overlay 单例、事件驱动刷新、详情保留 footer。回退：无。
- **REV-19（sync 超时不是工具错误）** 原因：`promote` / `abort` 超时后任务仍在跑（`status: "running"`），
  旧口径把它当成失败；PLAN §2.7 的 isError 口径是「非 0 退出」。行为：`isError` 只在 sync 任务真的以
  非 0 状态结束时为 true，payload 保留 `promoted` / `status` / `exitCode`。回退：调用方改看 `promoted`。

## 0.2.0 — 2026-10-16

自 0.1.0 起的 16 个提交，主体是 Wave1/Wave2 缺陷修复，附带少量新能力与若干
**用户可见的行为变更**。升级前请看「Breaking / 行为变更」一节。

### Breaking / 行为变更

- **`async_status` 默认不再返回历史任务**（#22）。0.1.0 默认 `includeHistory !== false`
  （含历史），现在默认**仅活跃**（running/pending）；需要历史要显式传
  `includeHistory: true`，且最多返回最近 50 条。不传参的调用方会看到列表变短。
- **`output_matches` 的正则现在以 `m` 编译**（REV-10）。`^` / `$` 从「整段锚点」变成
  「行锚点」，多行输出下匹配结果可能变化。
- **per-task activity id 形状变更**：`pi-async/<taskId>` → `plugin/pi-async/<taskId>`
  （REV-8）。OSC 7501 / legion viz 侧可见。
- **`async_logs` 输出文本清洗范围扩大**：从 `stripAnsi` 改为同时剥离裸 C0 控制字符，
  并用 `truncateUtf8Bytes` 替代按字节 `subarray` 截断 —— 含 BEL/BS/FF 或多字节字符时
  返回文本与 0.1.0 不同。
- **新增校验会拒绝原先被接受的调用**：
  - `json_path_exists.path` 必须以 `$` 开头（新增 `pattern: "^\\$"`）
  - `async_run` 在非 sync 模式传 `timeoutMs`、非 delayed 模式传 `delayMs` 会被拒（#42/#45）
  - `output_matches` 拒绝嵌套量词（ReDoS 防护），匹配窗口限制 64 KiB

### Added

- 新增环境变量 `PI_ASYNC_RETENTION_MS`（默认 7 天）与 `PI_ASYNC_RETENTION_COUNT`
  （默认 100），用于按「时间 ∪ 数量」并集保留终态任务产物（#25）。
- `async_kill` 返回新增 `killKind`、`alreadyTerminal`、`warning`；`isError` 改为条件值（#33/#6）。
- 通知 XML 新增 `kill-kind` / `failure-kind` / `summary-truncated` 属性（#37）。
- `async_wait` 结果项新增可选 `killKind` / `failureKind`；`WaitOutcome` 增加混合超时态。
- 内部新增 `src/core/duration.ts`、`src/tui/width.ts`、`src/core/env.ts` 收敛重复实现。

### Fixed

- TUI：`displayWidth` / `truncateToWidth` 按显示单元截断（#7）；Esc 层级、elapsed、
  pending、footer、border、theme.fg 修复（Wave1）；`PI_ASYNC_DOCK_SHORTCUT=off`
  现在真正生效（#30）。
- 核心：watch ReDoS 与匹配窗口、reload 前代 registry 关停、UTF-8 截断、C0/XML 非法字符
  （Wave2）；sidecar/zombie 进程组清理、`wait` 消费（Wave1）；空 env 不再被解析成 0（#21）。
- 通知：killKind / failureKind / summaryTruncated 接线补全（#37）。
- 仓库：移除误提交的 62MB `docs/core` ELF dump（#50），`.gitignore` 收紧为 `/core`
  以免误伤 `src/core/`。

### 未变更

- 5 个工具（`async_run` / `async_wait` / `async_logs` / `async_status` / `async_kill`）
  的注册面与参数名集合不变；没有删除任何工具或工具参数。`PI_ASYNC_DOCK_SHORTCUT` 属于环境配置而非工具注册面，已在 0.3.0 的 Breaking 节单独记录其删除。

## 0.1.0 — 2026-10-15

首个发布版本。
