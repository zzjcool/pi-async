# Changelog

本文件记录用户可见变更。格式参考 Keep a Changelog，版本遵循 SemVer。

## 0.5.3 — 2026-11-24（条件求值可抢占；含 0.5.1 详情视口与 0.5.2 存储生命周期）

> 本节与下面两节在同一次发布里出厂：0.5.1 与 0.5.2 当时「不发版、不打 tag」，所以它们的
> 内容首次随 **0.5.3** 发布；`v0.5.1` / `v0.5.2` 没有对应 tag，属历史，不再补。

条件求值可抢占（#113）：`output_matches` 的正则求值不再跑在主线程上，而是一个 25 ms 硬预算的可抢占
worker；越预算**按未命中处理**，不是失败。契约修订见 `docs/CONTRACT.md` §26（REV-34），证据见
`docs/reports/watch-preemption.md`。`package.json` 版本不动（由 release 提交统一抬）。

### Fixed

- **26 码元就能冻死宿主**：`(a|a)*$` + `"a"*25 + "!"` 冷路径 **5.02 s**，期间事件循环完全停摆（先上弦的
  100 ms 定时器被拖到 3.12 s），所以 `timeoutMs` / `intervalMs` 无法抢占。修后同一输入的求值在 25 ms
  内被掐断，10 ms 定时器照常触发（`docs/reports/watch-preemption.md` §2）。
- **`MAX_MATCH_CHARS` 的理由写错了**：`CONTRACT.md` §4 / §20.2 把 64K 窗口说成「限制 ReDoS 影响面」，
  而实测 19 码元就越过 25 ms、26 码元就冻死 5 s——窗口确实给代价封顶，但封顶值早在十六七个码元处就
  远超预算，所以它既不是防线、也不是可接受的上界。窗口保留，理由是**内存 / 取舍边界**；防线是可抢占
  预算（REV-34）。
- **形状黑名单的定位**：4 个已知灾难形状只挡住 `(a+)+$`。它现在是**深度防御**，不是防线（REV-34 裁决 4）。

### Added

- `async_status` / TUI 详情新增每任务计数器 `matchBudgetExceeded`：`output_matches` 求值超预算的次数。
  超预算的轮次按**未命中**处理（不累计 `blind_checks`、不动 `timeoutMs`、绝不 kill），每条任务首次越界
  发**一条**提示（`async-watch-notice`，不触发新回合），之后静默。提示与详情行说的是「这一轮的裁决被
  放弃，按未命中计」——不是「测量到未命中」：这类正则最终可能真的会匹配（见 `docs/reports/redos-benchmark.md`
  §5（1）），所以越界也可能漏掉一个真命中或一次真失败，文案与 `README` / skill 都写明了这个取舍。

## 0.5.2 — 2026-11-24（存储生命周期，随 0.5.3 出厂）

存储生命周期（#102）：新增两个**默认关闭**的开关，解决「旧 session 目录只增不减」与「没有字节上限」。
不发版、不打 tag、`package.json` 版本不动（由 release 提交统一抬）。契约修订见 `docs/CONTRACT.md` §25
（REV-32；合入后复核的两处判活修正为 REV-33，见 §25.9）。

### Added

- **跨 dataDir 回收（`PI_ASYNC_SWEEP_SIBLINGS=1`）**：`configure()`（默认 60s 节流）会回收
  `dirname(dataDir)` 下**其他** session 目录，但必须**三闸同时成立**：不是当前 dataDir、目录内没有
  指向活 pid 的非终态快照、空闲时长超过 `PI_ASYNC_SWEEP_SIBLING_AGE_MS`（默认 14 天，且永远严格大于
  `PI_ASYNC_RETENTION_MS`）。父目录永远不是目标；`foreign_content` / 损坏快照 / 软链 / 超出扫描上限
  一律跳过并记录原因 —— 判无知时的默认答案是「不删」。
- **全局字节配额（`PI_ASYNC_TOTAL_BYTES=<字节>`）**：跨整个 sweep root 统计 `.json`/`.output`/`.stdout`/
  `.stderr` 的字节数；`used > quota` 才淘汰，恰好等于配额视为在预算内。淘汰顺序是确定的全序
  （孤儿产物 → retention 本就该丢的终态 → 只有 `PI_ASYNC_QUOTA_HARD=1` 才动的「仍保留」终态；
  同层内按 `finishedAt ?? createdAt` 升序、`taskId` 字典序兜底）。非终态任务、以及当前有活任务的目录，
  永远不是候选。
- **可观测**：每次删除**先写日志再删**（`pi-async: storage: …`，含目标、原因、字节数），一轮结束有汇总行；
  `registry.sweepStorage()` 返回 `StorageReport`，`registry.lastStorageCleanup()` 取最近一轮。
  `async_status` 的返回形状不变（§12 工具面冻结），activity 不作为证据（§7）。

### Fixed

- **回收不再是「只读留档」**：`docs/CONTRACT.md` §10 此前明文把跨 session 目录回收划出范围，导致 117 个
  session 目录 / 4.0 MiB（其中 54 个 mtime > 7 天、86 个空目录）永不被回收；现在有干净的开关与三闸。
- **`PI_ASYNC_TOTAL_BYTES` 不再是死配置**：此前源码零引用，现在真正生效（默认 `0` = 不限）。
- 配额超限时**不静默删数据**：默认停手并报 `overQuota: true` + 日志说明，而不是删掉用户可能还要的结果。
- **dataDir 里新增一个 `.pi-async-owner` 文件**（`{pid, at}`，0600）：它让清理能区分「已废弃」与
  「活着但只剩终态任务」，否则同一个 repo 下并行的第二个 `pi` 会丢掉整份数据。它不是产物、不计字节、
  不迁移、不参与 retention。
- 判「是不是 dataDir」用**正证据**（当前 dataDir / 有可解析快照 / 无异物），而不是「没有异物」：
  当前 dataDir 里出现一个 `.DS_Store` 不会再让配额悄悄失效。
- 目录身份按 `dev`/`ino`（回退 `realpath`）判定：`dataDir` 经软链/大小写别名指向同一目录时不会被当成 sibling 删掉。
- 读不出快照（损坏、未知 status、触到快照扫描上限）的目录**整目录不产生淘汰候选**：`overQuota` 诚实地报满，
  而不是把看不见的产物当「孤儿」删掉。
- **owner marker 的判活用错语义（REV-33，0.5.2 合入后复核）**：marker 记的是 `process.pid`，但此前用
  `pidAlive()`（进程**组**语义）探测。任务子进程 `detached` 后 pid 即 pgid，所以对任务成立；而 pi session
  进程通常只是 shell 进程组的成员，于是**活着的 session 被报成死的**，过完年龄闸后整目录被删。
  现在 marker 走独立的 `processAlive()`（`kill(pid,0)`，`EPERM` 算活、Linux 僵尸算死），任务 pid 仍走组语义。
  合入时的 32 例测试全绿是因为 fixture 把 marker 的 pid 填成了任务 pid（必然的组长），而生产永不这样写。
- **「读不出 owner marker」不再被当成「没有 owner」（REV-33）**：marker 名字在、但读不出来
  （EACCES/EIO、变成目录、悬空软链）此前被吞成 `markerRaw = undefined`，等价于「无人拥有」→ 目录被删。
  现在 marker 的**存在**本身就是证据：不可读/非普通文件一律 `unreadable_owner` 并保留；marker 里非正整数
  （`0`/负数/小数）的 pid 同样记 `unreadable_owner`，不再被拿去探测。
- **快照里不可探测的 pid 不再被当成「已死」（REV-33）**：`pid: 0` 在 macOS 上会被 `kill(-0, 0)` 判成「活着」、
  在 Linux 上判成「已死」——同一个快照两个平台相反；`pid: 1e21` 会让 `kill()` 抛 `ERR_INVALID_ARG_TYPE`。
  现在**非终态**快照的 pid 必须是 `pid_t` 范围里的正整数，否则整个目录记 `unreadable_snapshot`（不猜测）。
  **终态快照的 pid 从不被探测，因此不受此限**——否则一个坏 pid 会让整个目录的产物永不淘汰、配额永远报满。
- **owner marker 是 FIFO 时不再挂死 `configure()`（REV-33）**：`readFileSync` 在 FIFO 上会永久阻塞。现在先看
  dirent 再决定读不读，非常规文件（FIFO/socket/目录/软链）一律不读，按 `unreadable_owner` 处理。
- **不为 `pending` 快照加永久保护（有意）**：延迟任务在 spawn 前没有 pid，`shutdown()` 又会故意把这类快照
  留在盘上；把它们当「可能是活的」永久保留，会让每个「排过延迟任务后退出」的目录永不回收。它们不提供
  判活证据，由 owner marker + 年龄闸定生死（复核抓到的第一版写法正是这个反向回归，已回退）。

## 0.5.1 — 2026-11-24（详情视口，随 0.5.3 出厂）

只改任务详情视图（`src/tui/panel.ts`）：选择与滚动分开，被折叠的行变成可读回，极窄终端不再只剩 footer。
不发版、不打 tag。契约修订见 `docs/CONTRACT.md` §24（REV-31）。

### Fixed

- **详情里 `↑`/`↓`/`j`/`k` 不再切换选中的任务**（#101 D1）：这四个键在详情内只滚视口，换任务改用
  `[`（上一个）/`]`（下一个）；列表内键义不变（仍是选择）。此前滚一下日志就会跳到相邻任务，
  与 README 的「in task details, scroll output」直接矛盾。
- **`… (+K lines)` 折叠区不再不可达**（#101 D2）：详情体改成一个视口 —— title/status 与 footer 键位提示
  固定，中间的分隔线、command、metadata、output 标签与全部输出行一起滚动。折叠标记现在是「窗口上方被
  隐藏的行数」，`↑`/`k` 滚一行、`PageUp` 滚一个视口即可读回。
- **极窄终端不再只剩 footer**（#101 D3）：高度退化到放不下一行内容时仍保留 title + status 与键位提示
  （旧实现只返回最后一行，header 消失）。footer 涨到 3 行（错误 + kill 确认 + 提示）时也先留 footer，
  键位提示永远是最后一行。
- **详情里的滚轮方向与 `↑`/`↓` 一致**（#101 顺带修正）：宿主把「滚轮向下」编码为正的 `wheelDelta`，
  旧代码 `scroll += delta` 于是向下滚反而上滚；现在向下 = `↓` = 朝最新行。列表视图方向一直是对的。
- **换任务不再带上一个任务的 kill 错误行**（#101 后续修正）：详情里用 `[` / `]` 换任务时 `actionError`
  随它的任务一起清掉；此前 `error: Error: kill denied` 会留在新任务的 footer 上，看起来像是新任务失败了
  （`Enter`/`Esc` 本就会清它，只有 `[`/`]` 这条路径漏了）。

### Changed

- 详情 footer 键位提示：`↑/↓ scroll · [ ] task · x kill · R rerun · c show output path`
  （新增 `[`/`]`；为把整行压在 80 列的内宽 76 格里，`x kill/cancel` 缩成 `x kill`，
  `c show output path` 仍完整可见）。
- `… (+K lines)` 的 K 改为统计「窗口上方隐藏的总行数」（含输出行）；此前只统计被折叠的
  command/metadata 行。
- `output (live):` 标签随内容滚动（长日志时在窗口上方，不再常驻）；`actionError` 与 kill 二次确认提示
  改为固定 footer，永不滚出屏幕。
- `PageUp`/`PageDown` 仍是一页 = 一个窗口，窗口的定义从「输出窗口」变成「视口」。

## 0.5.0 — 未发布（agent 不再需要知道「等待」这件事）

四条一起改的是同一个问题：等任务是运行时的事，不是模型的事。能阻塞的模式删了，会唤醒的那条路少了一个
岔口，模型不再被劝去调一个默认不存在的工具，headless 进程也不会再带着未完成的任务退出。

基于 0.4.8（`feat/hold-in-rail`，已合入 main）的代码线；本条目只描述相对 0.4.8 的差异。

### Removed（D3）

- **`async_run` 的 `mode=sync` 彻底删除，无兼容层**：`timeoutMs` / `onTimeout` 不再是 `async_run` 的
  参数（schema 里没有这两个字段，`additionalProperties: false` 让宿主直接拒绝），
  `PI_ASYNC_MAX_SYNC_TIMEOUT_MS` 不再被读取。传 `mode: "sync"` 会得到
  `Unsupported async_run mode: sync`；`mode` 只剩 `background`（默认）与 `delayed`（需 `delayMs`）。
  需要「现在就拿到结果」时用可选的 `async_wait`（见下）或 `async_logs`。
- 据此，TUI 的 mode 配色槽位固定为 background=0 / delayed=2（行为与配色都不变），rail 上不再有
  「sync 期间也在跑」这一类任务。

### Changed（D4）

- **`async_wait` 默认不注册**：默认工具面是 5 个（`async_run` / `async_logs` / `async_status` /
  `async_kill` / `async_extend`）。宿主设置 `PI_ASYNC_EXPOSE_WAIT=1` 才额外注册 `async_wait`（6 个）。
  开关每次调用重新读，不需要改代码即可在 reload 后生效。
- 旧会话/旧注册若仍调到 `async_wait`，**不再抛错**：返回 `{ taskId: null, available: false, error,
  enableWith: "PI_ASYNC_EXPOSE_WAIT=1", alternatives: ["async_status","async_logs"] }`（`isError: true`，
  正常 resolve），说明原因与开启方式。
- 默认工具面上任何模型可见文本都不再有 `async_wait`：`async_run.name` 的字段描述（`Short handle for
  later async_logs/async_kill calls`）、第 5 条 guideline、receipt 的两条例外 hint、
  `<async-state>` 的三条 tail、settle guard 的 advisory / reminder / unresolved / aborted 文案，
  默认一律指向 `async_status` + `async_logs`；只有 `PI_ASYNC_EXPOSE_WAIT=1` 时才保留 `async_wait` 措辞。
  默认路径生成的文本里不会出现 `async_wait`。

### Changed（D6）

- `bash` 长命令事后提示删掉 `or mode=sync with timeoutMs when you need the result soon`，改为
  `… use mode=background with watch for servers/builds; end the turn and the completion notification
  wakes you`。
- `<async-state>` 的全唤醒分支删掉 `, or call async_wait if you need one now`，默认为
  `— end the turn and the completion notification wakes you.`；混合/全不唤醒分支同样改用 `async_logs`。
  三态（全唤醒 / 混合 / 全不唤醒）的 per-task 事实不变量不变。
- `skills/async-tasks/SKILL.md` 删掉 sync 章节，`async_wait` 描述为「默认不存在，宿主设
  `PI_ASYNC_EXPOSE_WAIT=1` 才暴露；默认做法是结束回合等完成通知」。

### Added（D5）

- **headless（`pi -p`）结构性保底**：print 会话在 `agent_before_settle` 边界等到所有 `running` 任务终态，
  提交一条 `async-task-print-results`（只含 name/status/exit，不含 output tail）并返回 `continue: true`，
  宿主因此再发一次 provider 请求——**模型的结论成为最终输出**，而不是 0.4.x 的「565 ms 退出 + 空 stdout + 任务被杀」。
  等待复用完成通知归属中继：等待期间落地的通知由 results entry 独占播报并落 `notified`。
- 两道界：`PI_ASYNC_PRINT_MAX_CONTINUATIONS`（默认 5，`0` = 首个边界即限流）与 `PI_ASYNC_PRINT_WAIT_MS`
  （默认 10 分钟，从第一次真正等待起按墙钟累计，回合之间的 provider 时间计在内——这是刻意的整进程上限，
  代价是长运行后半段新起的任务会被立即限流而不是等待）。
  超限 **stderr** 打印 `still running N async task(s) after C continuation(s) and Ts: <taskId> …` 并以
  `exitCode = 1` 退出（不静默）；`PI_ASYNC_PRINT_WAIT=0` 关闭整条保底（0.4.x 行为，用于对照/紧急回退）。
- 只等 `running`；`delayed`/`pending` 是「已排期的工作」，不阻塞退出（否则每次打印运行都会烧掉整个预算）。
- `scripts/headless-smoke.sh`（真 `pi -p` + 脚本化 mock endpoint）：`wait` / `cap` / `off` 三态可复跑。

## 0.4.8 — 2026-11-18（等待行并进 rail：输入框上方不再有独立一行）

hold 期间输入框上方原来会多出一行——与 rail 首行说同一件事。用户裁决：
「外观版的话我觉得可以，这样输入框上方的 `⠙ waiting 2m 28s — Esc stops waiting` 这个我觉得就可以不要了」。
0.4.8 把它并进 rail，rail 就是唯一那块：

```
⠙ async_wait · running 2m 28s — Esc stops waiting
▶ watch-t71 · running · 4m 6s
▶ watch-t6z2 · running · 4m 6s
▶ watch-t73 · running · 4m 6s
```

### Changed

- **hold 期间 rail 首行就是等待行（CONTRACT §7.1 修订 8）**：`⠙ async_wait · running <hold-elapsed> —
  Esc stops waiting`。braille 首字符仍在 250ms 换帧（`agent_end` 已清掉宿主 working 行，换帧是这一行唯一
  的「还活着」信号），文案仍为英文，唯一文案来源是 `src/tui/surfaces.ts` 的 `waitingRow()`。
  它 **顶掉**首行汇总行，而不是新增一行：4 行上限不变，所以仍是「等待行 + 3 行任务」；`RAIL_TASK_SLOTS`
  刻意保持 3——调小会让第三个任务失去 `▶` 名字行，`railShowsTasks` 变假，兜底行回来，同一件事说两遍。
  hold 结束后首行自动回到汇总行（`clearWaiting` 在 `finally` 里，覆盖全终态/超时/Esc/入队/dispose/异常）。
- **删除输入框上方那一行**：`WIDGET_KEY = "pi-async-hold"` 常量与 `setProgress`/`clearProgress` 里无条件写
  widget 的分支全部删掉（`pi-async-hold` 现在只是 footer 的 status key）。0.4.7 已经把判定改成
  「看画面而不是看注册」，但那一行本身仍然冗余；顺手把这一行在 0.4.4–0.4.7 的演化收尾：
  0.4.4 起是 `⠋ waiting for N async task(s) <elapsed> — Esc stops waiting`（只有数量）；0.4.5 改成带名
  `⠋ 1 async task 7m 13s — watch-t4q-yamlfix (running, 7m 19s) — Esc stops waiting`；
  0.4.6 只留 `⠋ waiting 7m 13s — Esc stops waiting`（明细交给 rail）；0.4.7 把「rail 在不在」从注册标志改成
  「此刻画不画这些任务」并让 rail 自愈；0.4.8 直接把这一行并进 rail 首行。
- **兜底行只在 rail 画不出来时存在**（新键 `HOLD_FALLBACK_WIDGET_KEY = "pi-async-hold-fallback"`，不写进用户文档）：
  宿主没有 `setWidget`、widget 被清且装不回来、rail 窗口没覆盖这些任务 ⇒ `setHoldSurface(undefined)` →
  `ensureRailSurface()` 自愈并立即复检 → 仍不行才自己带名
  `⠙ async_wait · running <elapsed> — <name> (status, elapsed) · … — Esc stops waiting`。
  两面互斥，全屏任何时刻最多一处 `async_wait`（§8 不变式：每个等待中的任务名必须在屏幕上出现一次）。
- **宿主完全没有 `setWidget` 时 footer 带名**（§8 的最后落点）：
  `waiting for N task(s) <elapsed> — name (status, elapsed) · …`；有 `setWidget` 时 footer 保持原样。
- 任务行 `▶ name · state · elapsed` 的格式、排序、hover/点击、wheel 滚动、溢出指示、`RAIL_MAX_LINES=4`
  全部不变；无任务时 rail 仍返回 `[]`。`railShowsTasks`/`ensureRailSurface` 语义不退回 0.4.6 的「注册即信任」。
- 复核后仍不借用宿主 working 行：`interactive-mode.js` 的 `setWorkingVisible()` 里是
  `if (this.session.isStreaming && …) this.showWorkingStatusIndicator();`，hold 期间没有流式输出。

### Tests

- 新增 `tests/i-hold-in-rail.test.ts`（真实 `createRailFactory` + 自制宿主）：hold 期间 rail 首行是等待行且
  三行任务名都在（4 行上限、帧在换、elapsed 在走）；等待行顶掉汇总行；全屏 `async_wait` 只出现一次
  （含 rail 被清掉又装不回来的兜底帧）；无 widget 宿主时 footer 带名；hold 结束/Esc 后首行恢复汇总行。
- `tests/h-hold.test.ts`：progress 相关用例按新语义重写（无 rail 时兜底行带名、rail 覆盖时自己一行都不画、
  rail 不覆盖/被 dispose 立刻带名、三种出口首行消失、窄终端与无名任务）。
  `tests/i-settle-owner.test.ts`、`tests/e-rail-liveness.test.ts` 改用新键并按 rail 首行断言。
- 变异验证（改回去即红）：hold 无视 rail 照常画自己的行 → 9 红；等待行与汇总行并列而不是顶掉 → 7 红；
  `RAIL_TASK_SLOTS` 调成 2 → 4 红；`finally` 里不调 `clearWaiting` → 7 红；footer 不带名 → 2 红。
- 真实 hold 实测（`docs/reports/hold-in-rail.md`）：同一个脚本对 0.4.7 树与当前树各跑一次真实
  `init()` + `async_run`（`sleep 3`）+ `agent_before_settle`，0.4.7 屏上 3 行（rail 2 行 + 独立等待行），
  0.4.8 屏上 2 行（rail 首行即等待行），结束后两面都回到汇总行。

## 0.4.7 — 2026-11-17（rail 自愈：注册 ≠ 可见）

0.4.6 把「`registerRail` 调通过一次 `setWidget`」当成「rail 就在屏幕上」，据此把任务名从 hold 行删掉。
那条信赖链是错的：宿主会 dispose 并清空**所有** extension widget，而 rail 只在首个 TUI ctx 绑定时
装过一次。结果两边同时静默——屏幕上只剩 `⠋ waiting 51s — Esc stops waiting`，用户看不到在跑什么。

### Fixed

- **rail 的存在由任务状态决定，与 hold 无关**（CONTRACT §8 产品不变式）：只要有 running/pending 任务，
  输入框上方就必须有 rail 行，没有 hold 时也画。`registerRail` 变成**幂等且自愈**：宿主仍持有本 registry
  的 widget → 什么都不做；widget 已被宿主清掉 → 重装。自愈触发点：每个 lifecycle 事件
  （`session_start`/`message_start`）、任务进入 running/pending、以及 hold 每帧发现自己没被 rail 覆盖时
  （节流上限 1s）。用户侧效果：会话切换（`/new`、`/resume`、`/fork`）或 `/reload` 之后 rail 不再永久消失。
- **hold 行不再信标志，只信画面**（CONTRACT §7.1 修订 7）：省略任务名的唯一条件变成「已挂载的 rail
  此刻列出的 taskId 集合覆盖了本 hold 等待的每一个任务」（`railShowsTasks` → widget 的 `taskIds()`，
  与 rail 渲染共用同一窗口/滚动状态）。宿主没有 `setWidget`、widget 被清掉、rail 窗口没覆盖这些任务
  ⇒ hold **立刻**自己带名，并请求 rail 下一帧重装，因此不存在「两边都不列名字」的帧。
- **rail 读活 registry**：`registerRail(pi, () => activeRegistry ?? registry)`，`configure()` 采纳上一代
  工作后 rail 不会对着被退休的实例画空列表。
- 内部：`src/tui/surfaces.ts` 从「一次性注册标志」改为活记录（`armRailSurface` / `mountRailDetail` /
  `unmountRailDetail` / `railShowsTasks` / `ensureRailSurface`），widget 的 `dispose()` 会撤销自己，
  宿主清空 widget 后下一次取数就是真话。

### Tests

- `tests/e-rail-liveness.test.ts`（新增，按宿主 `setWidget`/`clearExtensionWidgets` 语义务实现）：
  无 hold 也有 rail 行；任务结束后行消失；宿主清空 widget 后自愈重装；无 `setWidget` 时 hold 带名；
  hold 等待集合与 rail 行集合同源；hold 期间宿主清空 rail ⇒ 下一帧重装且这一帧就带名；
  `init()` 端到端：宿主清空 widget 后，**下一个 lifecycle 事件**与**下一个任务出现**各自都能把 rail 装回来。
- `tests/h-hold.test.ts`：rail 覆盖 hold 的任务时省略明细；rail 不覆盖 / 被 dispose ⇒ 立刻恢复带名。
- 三条不变式都做了变异验证（改回旧行为即变红）：hold 无条件闭嘴 → 7 红；widget 不挂 detail → 3 红；
  `ensureRailSurface` 不重装 → 2 红；hold 不请求重装 → 1 红；`bindTui` 退回一次性注册 → 1 红；
  去掉任务 state 事件的自愈钩子 → 1 红（就是“任务出现时重装”那条）。

## 0.4.6 — 2026-11-17（明细只在 rail：hold 行与汇总行不再重复任务信息）

0.4.5 把「在等哪些任务」搬进了 hold 等待条，结果同一个终端里三行在说同一件事：
`▶ 1 running · 7m 19s`（汇总行）、`▶ watch-t4q-yamlfix · running · 7m 19s`（rail 行）、
`⠋ 1 async task 7m 13s — watch-t4q-yamlfix (running, 7m 19s) — Esc stops waiting`（hold 行）。
逐任务明细只有一份来源：**rail**。

### Changed

- **hold 行只保留「这一轮被 hold 多久」**（CONTRACT §7.1 修订 6）：rail 已注册时写
  `⠋ waiting 7m 13s — Esc stops waiting`——hold 的 elapsed 与任务耗时不是同一个数字，rail 上没有它。
  **回退**：rail 未注册（宿主没有 `setWidget`）时退回 0.4.5 的带名明细，因为那时没有别处能看。
  rail 是否注册由 `src/tui/surfaces.ts` 记录的事实标志决定（`registerRail` 真的调通 widget 后才置位），不靠猜。
  > **0.4.7 更正**：这条信赖链错了——「注册」不等于「可见」。宿主会清空 widget 而标志仍然为真，
  > 于是 rail 和 hold 同时静默。0.4.7 改为按 rail 此刻真正列出的任务判定，并让 rail 自愈。
- **汇总行在只有一个 running/pending 任务时不再显示时长**（CONTRACT §8）：`▶ 1 running` 就够，
  那个数字就在唯一那行任务行的行尾；0 个活任务仍显示 `—`，≥2 个仍保留汇总时长（否则没有单行能读到）。
- rail 行本身不变（它仍是明细来源）。宽度/截断规则不变；两处都是 best-effort（D-8）。

## 0.4.5 — 2026-11-17（等待条重新显示在等哪些任务）

hold 期间屏幕上唯一的界面行只有 `N async tasks <elapsed>`，用户无法分辨在跑的是自己的 watch 还是某个
无关探针，只能打开 rail/panel 或等 hold 结束。现在它直接列出快照内的每一个任务。

### Added

- **等待条列出正在等待的任务**（CONTRACT §7.1 修订 5）：每项 `name (status, elapsed)`，与模型侧
  `<async-state>` 同形（`src/context/nudges.ts:75`）；无名/空白名用 `taskId` 前 8 位；按终端**格宽**
  （CJK=2 格）截断并以 `+N more` 收尾，**始终单行**（不换行抖动 editor）；每任务耗时随 250ms 帧刷新，
  集合随 poll（默认 1s）刷新。footer 仍是 `waiting for N task(s) <elapsed>`，明细只在 widget。
  纯 cosmetic：渲染失败一律吞掉，不会结束 hold（D-8）。
- 这是**补上从未实现的能力**，不是修复退化：hold 自 0.4.0 起的三个版本（`b2b6b47` / `71b690b` / `43e5c29`）
  等待条都只报数量，任务名此前只存在于 rail、`/async` 面板与 hold 结束后的 results entry。

## 0.4.4 — 2026-11-17（忙碌父会话的完成通知不再被压到 run 结束）

主题是**投递通道选错**：`sendMessage` 用 `deliverAs:"followUp"`，而宿主只在模型**不再发起 tool call** 时
才抽 followUp 队列（`pi-agent-core/dist/agent-loop.js:197`），steering 队列则**每个 turn 边界**都抽
（同文件 `:191`）。所以父会话只要还在连续调工具，完成通知就必然被压到整个 run 结束——实测
`finishedAt` 04:15:24.745 → 注入 04:18:23.383（**+178.6s**），12 秒后又出现第二条。

### Fixed

- **活动 run 改用 steer + `turn_end` 结算**（CONTRACT §7.2 修订 2）：任务终态时父会话在 streaming →
  `deliverAs:"steer"`，并在**下一个 `turn_end`** 结算（宿主在 `turn_end` 之后立刻读 steering：
  `agent-loop.js:188-199`），不再等 `agent_before_settle`。空闲会话仍是 `followUp` + `triggerTurn: true`
  （直接开新一轮唤醒）。0.4.3 的「延后到边界再裁决」保留——只是把最早结算点从 settle 提前到 turn 边界。
- **单次终态只入队一次**：`pendingNotifications` 以 taskId 为键、flush 前整体 `clear`，`turn_end` /
  `agent_before_settle` / `agent_settled` 三个结算点幂等；`notified` / `notifyAttempts` 语义不变
  （一次发送 = `notifyAttempts+1`，host 接受后 `notified=true`）。新增用例锁住：跨三个边界 +
  `resendUnnotified` 重放后仍只有 1 条、`notifyAttempts === 1`。
- **`triggerOnCompletion: false` 也走同一条仲裁**：不再在 finalize 当场入队，避免长 run 里同样迟到；
  区别只是 idle 时不会 `triggerTurn` 起新一轮。

## 0.4.3 — 2026-11-17（一个终态只播报一次；hold 可被 Esc 打断）

两个主题。一是**同一个终态被重复播报**：hold 期间完成的任务先收到 `async-task-settle-results`（当场、in-run），
38~50 秒后又收到 `async-task-notification`（宿主把流式期间的 `followUp` 压到模型停止后才投递），
表现为「迟到的重复回执」，还会白烧一个 turn；同一机制在模型已用 `async_wait` 收下结果时再犯一次
（实测 `2026-11-17T02-35-00-296Z_01a1e75b`：wait 之后 85–138 秒又收到通知）。二是**hold 拦住用户**：
按 Esc 无效、界面 working 行静止像死机，只能等预算或强退。

### Fixed（同一任务只播报一次）

- **hold 期间由 results entry 独占播报**：hold 真正在等待时改用 `HoldNotificationRelay`
  （`src/guard/hold-notify.ts`）接管快照内任务的终态播报权——`onFinalize` 不再为这些 id 发送通知，
  而是扣住；hold 全部终态时由 results entry 独占播报并对这些 id 落 `notified = true`（`resendUnnotified`
  不会在下次 `session_start` 再播一遍），超时/`dispose`/registry 抛错等其它出口立即把通知交还给
  正常路径（**永不吞掉完成通知**）。顺序问题不是竞态：pi 在 `isStreaming` 时只把 `followUp` 入队
  （`agent-session.js:1959-1962`），要到模型停止时才投递（`agent-loop.js:196-203`），而边界 draft
  同步落盘（`agent-session.js:560-574`），所以 results 必先到、通知必后到。实测会话 `01a1e5b5`：
  ln393→ln404 相差 49.586s、ln432→ln441 相差 38.226s，模型自述「重复回执／迟到回执」。
- **settle advisory 不再笼统承诺唤醒**（CONTRACT §17 修订 1）：只有 `running` + 会通知 + 会起 turn 的
  任务才说「their completion notifications will wake you」；混合时说明「几个会唤醒、其余用 async_wait 收」，
  一个都不会唤醒时直接说「None of them will start a new turn」。此前 `notifyOnCompletion: false` 的任务
  也会被同一句话许诺唤醒。

### Fixed（已消费的终态不再重复通知）

- **单一消费者 latch**（CONTRACT §7.2 / D-15）：`async_wait` 返回的终态行、`async_status` 列表里的
  终态行、`async_logs` 读到的已终态任务，都会 `registry.markConsumed(taskId)` 写持久化字段
  `consumedAt`；`claimNotification()` 与 `resendUnnotified()` 跳过已消费任务。只对**终态**行上锁，
  读 running 任务的部分输出不会静默关掉它的完成通知。
- **run 活动期间不再提前入队**：`onFinalize` 在 `agent_start` … `agent_settled` 之间只把发送挂进
  `pendingNotifications`，到 `agent_before_settle`（hold 之后、guard 之前）与 `agent_settled` 再结算；
  结算时重新检查 latch，已被 `async_wait`/`async_status`/`async_logs` 消费的直接跳过。空闲会话仍
  立即发送并唤醒（行为不变），`triggerOnCompletion: false` / `notifyOnCompletion: false` 语义不变。
  没有这条延后，`consumedAt` 来得太晚：0.4.2 在 finalize 就入队，而宿主直到模型停止才投递。


### Fixed（hold 拦住用户：无法 Esc、看起来像死机）

- **Esc 现在能立刻退出 hold**（CONTRACT §7.1 修订 4）：pi 对 `agent_before_settle` handler 无超时、
  无法抢占（`runner.js:767-814`），该边界的 `ctx.signal` 恒为 `undefined`（run 的 AbortController 在
  `before_settle` 之前已清，`pi-agent-core/dist/agent.js:216-223`），`session.abort()` 只置一个 handler
  读不到的 flag（`agent-session.js:2073-2084`）。旧版因此只能等预算（最长 10 分钟），用户只能强退。
  现在 hold 在等待期间订阅 `ui.onTerminalInput`，只识别单独 `\x1b`（方向键/Alt `\x1b[A` 不误判、
  永不 consume），用 `Promise.race` 打断 sleep → **毫秒级**释放；宿主随后自行 settle 成 aborted
  并抑制 continuation。
- **用户入队消息让位**：`ctx.hasPendingMessages()` 为 true（TUI 里 Enter 提交的消息会进 steer 队列）
  时，hold 在下一个 poll（≈1s）释放，消息由宿主在下一个 turn 投递 —— 不再是「输入石沉大海 10 分钟」。
  与 0.4.0 删掉的 F2b 探针不矛盾：完成通知走 `agent.followUpQueue`，**不在**该计数里。
- **hold 期间界面不再像死机**：`agent_end` 在 `before_settle` **之前**就清掉宿主的 working 行
  （`interactive-mode.js:3060-3064`），而旧版只靠 15s 一次的 footer 文本。hold 现在自带一行 widget：
  `⠋ waiting for N async task(s) 12s — Esc stops waiting`，每 250ms 换帧、每秒跳时间，`finally` 里清除
  （不借 `setWorkingVisible`：那是会话级持久状态，会在 settle 后留下永久 spinner）。实测 16s hold 的
  真实 TUI：widget 重绘 112 次、10 帧全出现；同期 footer 只写了 3 次。
- **消息顺序不变**：Esc/入队/超时等非「全终态」出口一律**不带 results entry**，并释放被扣住的完成通知，
  所以 #1 的「一个终态一次播报」在这些路径上同样成立（新增用例同时断言两件事）。

### Changed

- CONTRACT §7.1 修订 3 / D-14：`不抑制通知` 改为「hold 拥有快照内终态播报权」，并明确两条出口的归属规则。
  legion child 语义不变（§7 原样：child 不 hold，仍走自己的有界 settle reminder）。

## 0.4.2 — 2026-11-12（suspend 后的幽灵 running 任务）

主题是**退役的那一代能自己回来**：宿主 retire 了扩展却没有下一代时，async 不再永久不可用。

### Fixed

- **suspend 后任务永远是 running（幽灵任务）**：宿主 `session_shutdown(reason=reload|resume)` 退役 registry
  后若不重建扩展，子进程退出回调撞 `suspended` 围栏 → 不 finalize、不落盘、不通知，`<taskId>.json`
  永远停在开始快照，20 分钟 reminder 也被清掉的 timer 掐死，TUI 计时永远上涨。现在**同一实例的下一次
  `configure()`** 会 un-suspend 并从磁盘重新收养（REV-28a，CONTRACT §10 / §19.6）：先给旧 `live` 句柄打
  `retired`、再走 dataDir 迁移（顺序保证 `metadata.outputFile` 被重写）、最后移除非终态快照并重新收养：
  running+活 pid 重建 watcher 并按剩余预算重挂 `timeoutAt`/`remindAt`/watch，
  running+死 pid → `failed` + `failureKind:"lost"` 并落盘；
  退役 `live` 的迟到 exit（以及仍在 `await killTree` 的旧 `kill()`）是 no-op，不会覆写复活后的快照；
  磁盘快照缺失/损坏时任务按 `failed/lost` 结算一次，不再静默消失。
- **退役代永久拒绝 admission**：`ensureConfigured` 在 registry `suspended` 时短路，`activeRegistry` 被清空后
  再没有任何代接收新工作（`Async task admission is closed (registry suspended: ...)` 到会话结束）。
  现在下一个 `session_start` / `message_start`（或带 ctx 的工具调用）即自愈（REV-28b）——**生命周期事件本身**
  就能触发（不再被一次性 `startup` 闩挡住）；**从未再 configure** 的退役代仍报同一条可操作错误（围栏保留）。
- **运行时存活巡检（REV-28c）**：非终态里 running 且进程组已死/无 pid 的任务由低频存活巡检标
  `failed` + `failureKind:"lost"`（与加载期同形，落盘并通知；默认 5000ms / `PI_ASYNC_LIVENESS_INTERVAL_MS`、
  可注入、`unref()`、仅在有非终态任务时惰性启动，`suspend()`/`shutdown()` 清除，**`0` 关闭巡检**；
  env 走 `min:0`，只有构造函数注入才能取 `<=0` 表示「显式关闭」）。
  巡检从不 kill 进程，pending 语义不变。**需要连续两次观测到死**（契约修订）：单轮会在「OS 已退出 /
  Node 尚未派发 `exit`」的窗口误判（实测 1ms 间隔下 40 个 `true` 任务误标 33 个），也会把真实 exit 0 的
  守护任务判成 `lost`。与退出兜底的胜负是**结构性**的：巡检跳过任何「已被 spawn 句柄观测到 `exit`」的任务
  （兜底必然接手），因此不取决于两个间隔的相对大小（旧的 `{巡检 1000ms, 兜底 5000ms}` 会让巡检抢赢）。
- **孙进程持有 fd 1/2 时 `'close'` 永不到达 → 任务永久悬挂（REV-28d）**：`spawnDetached` 保留 `'close'`
  为主信号，新增 `'exit'` 兜底——退出后宽限窗口（默认 5000ms / `PI_ASYNC_SPAWN_EXIT_GRACE_MS`，可注入）
  内流未全部 end 则用退出码 settle 并结束写流；宽限前已写出的输出保留，迟到输出可丢，`settled` 守卫
  保证只 settle 一次；**`0` 关闭兜底**（不是「立即结算丢输出」；env 负数回退默认，只有构造函数注入为
  `<= 0` 才是「显式关闭」）。

### Fixed（复审回归）

- **watch-success 任务的 task timeout 不再泄漏**：退出回调原先在「终态早退」之后才清 `live.timer`，而
  `finalize()` 对 success_when 命中且进程未退的任务**故意保留**该 timer（D4/#33）——于是进程自然退出后
  这个 ref'd timer 无人清理，把宿主钉到 `taskTimeoutMs`，且 `metadata.capped` 的落盘变成死代码。
  现在基础设施清理（清 timer、读 `capped`、必要时 persist）无条件先做，只有「改写 status/exitCode/watch」
  受终态闸门保护。
- **kill 跨复活的返回语义**：`async_kill` 在 `await killTree()` 期间遇到 suspend+configure 时不再结算任务，
  返回复活后的 `running`（不 finalize），随后由复活后的 watcher/巡检按 `lost` 结算。

### Added

- 测试 `tests/g-revive-after-suspend.test.ts`：退役→死亡→revive 落盘、仍活着→watcher 收尾、
  迟到 exit 不覆写（只 finalize 一次）、`kill()` 等待 TERM 忽略子进程跨 revive 不覆写、revive+换 dataDir
  的迁移（含终态快照在内存）、磁盘快照缺失/损坏按 lost 结算、存活巡检、两轮确认、exit-0 守护任务
  由兜底判 `completed`、孙进程持 fd 的 exit 兜底；
  「watch-success 任务的 timer 释放」、复活后剩余 `taskTimeout`/delayed 计划/`remindAt` 重挂（3 条）、
  「巡检结构性让位给退出兜底（interval ≪ grace 也不抢）」；
  `tests/g-generation-handoff.test.ts` 的「无活代数」用例按 REV-28b 改为自愈 + 围栏断言，并新增
  「reload 后只靠 `session_start` 自愈（不调任何工具）」用例。

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
  （REV-8）。这是 **id 形状约束，不是可见性承诺**：写入唯一走宿主的 `ui.setActivity`
  （feature-detect；官方 pi 1.2–1.5 无该 API 时是 no-op），本仓库不自行发 OSC 转义，
  legion 侧要等上游 #156 的转发通道。
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
