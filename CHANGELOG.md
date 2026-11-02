# Changelog

本文件记录用户可见变更。格式参考 Keep a Changelog，版本遵循 SemVer。

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
