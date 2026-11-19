# issue #81 重新分诊（基线 v0.5.0）

- **原 issue**：[#81](https://github.com/zzjcool/pi-async/issues/81)，建于 2026-11-02（0.3.0 之后），27 个 checkbox，从未更新
- **分诊基线**：`origin/main` `a212cbe`（Merge PR #99 = v0.5.0，2026-11-18）
- **结论**：27 条 → ✅ 10 已完成 / 🔜 12 仍需要 / ❌ 5 放弃；新建 3 个子 issue
- **不改产品代码**：本报告只有一个新增文档文件

## 为什么重写

`#81` 诞生在 0.3.0 之后，把 `docs/PLAN-0.3.0.md` §1.2 的「明确不做」集中记录。此后 0.4.x/0.5.0 做了：

| 版本 | 改动 | 影响 #81 的哪几条 |
|---|---|---|
| 0.4.0 | REV-25 有界尾部读 + `MAX_MATCH_CHARS` 改名 | 1.3（顺带解决） |
| 0.4.1 | 面板 live stdout、`R2-1/R2-2` | 4.1/4.3（部分） |
| 0.4.2 | REV-28 复活/巡检（5s liveness sweep） | 8.3（顺带解决） |
| 0.4.3 | 一个终态只告诉一个消费者（`consumedAt` + relay） | 2.3（加固）、2.1/3.3（部分替代） |
| 0.4.5–0.4.8 | hold 行并进 rail；rail 自愈 | 4.4（口径变化） |
| 0.5.0 | 删 `mode=sync`；`async_wait` 默认下线（D4）；headless 保底（D5）；通知优先（D6） | 2.1/2.3/3.1/3.2/6.x/7.x（全部需重新评估） |

结果是：有些条目已经被顺带解决（却仍挂着 `- [ ]`），另一些已被 CONTRACT 明确否证（REV-9 不合并通知、REV-2 禁止合并 pending/error），还有几条其实只是「把已经存在的现状写成文字」。继续当待办列表读会误导后来的 agent（会去实现契约已拒绝的东西）。

## 方法

1. `gh issue view 81` 抄出全部 27 条 checkbox（原文逐字备份见下）。
2. 每条用 `rg` 定位现状到 **文件:行**；`git log --oneline --all -- <file>` 判断 0.3.0 之后是否被改过。
3. 判定三档：**已完成**（必须是代码/文档里能找到的实现，不是「大概做了」）/ **仍需要**（写明缺什么、影响面）/ **放弃**（写明与哪条冻结契约或 0.5.0 方向冲突）。
4. 判断不了的写「待定」并列出缺的信息（见文末），不猜。

复跑核对的命令（报告中所有 `文件:行` 均可直接核对）：

```bash
gh issue view 81 --json body -q .body
rg -n 'MAX_MATCH_CHARS|NESTED_QUANTIFIER|killOnSuccess|processAlive' src/
rg -n 'REV-9|REV-2|不在本条范围|match:"all"' docs/CONTRACT.md
git log --oneline --all -- src/core/watch.ts src/core/registry.ts src/tui/panel.ts src/core/notify.ts
```

## 原文备份（2026-11-02，逐字保留）

以下为 issue #81 重写前的正文，**未改动一个字**（md5 `5f9df77a784c3d38a9a11abcbf42f35e`，71 行）。

<details>
<summary>issue #81 原始正文（点击展开）</summary>

## 背景

0.3.0（PR #80，main `1b9d0ca`）已完成 P0 + 高价值 P1，并把 0.3.1/0.4 的项留在 `docs/PLAN-0.3.0.md` §1.2。本 issue 把这些「刻意不做」的项集中记录，避免散落丢失。

参考：`docs/2026-11-02-review.md`、`docs/PLAN-0.3.0.md`、`CHANGELOG.md` 0.3.0 段。

## 待办清单

### 1. watch v2：正则安全 + 条件组合 + 成功动作
- [ ] `output_matches` 增加执行超时/worker 隔离，覆盖 `(a|a)*` 等形状黑名单漏掉的多项式 ReDoS。
- [ ] `success_when` / `failure_when` 增加 `match: "all" | "any"`（默认 `any`，保持兼容），当前组内是 OR。
- [ ] 明确 64K 尾部字符窗口语义（常量名是 BYTES，实际按 JS 字符），文档 + 测试。
- [ ] `watch` 增加 `killOnSuccess?: boolean`（默认 false，保持 D4），或至少在状态/通知里显式 `processAlive`。
- [ ] `blind_checks` 对 `json_path_exists` 长期 pending 的策略（当前 pending 重置盲检，只能等 watch timeout）。

验收：新增 ReDoS 超时用例；AND 组合用例；D4 进程存活/成功动作用例；文档同步。

### 2. 通知批量合并
- [ ] 同一短窗口内完成的多任务合并为一条通知，避免 N 个任务 N 次 `triggerTurn`。
- [ ] 保持每任务 taskId/status/exitCode/killKind 可追溯；XML/消息 schema 变更需走 CONTRACT REV。
- [ ] `async_wait` 消费后的通知抑制语义不变。

验收：2–3 个任务同时完成只产生 1 条消息/1 次 turn；单任务行为不变。

### 3. 跨进程 / 持久 waiter
- [ ] 明确 `async_wait` 是否要跨 `/reload`、跨 pi 进程；当前 waiter 是内存对象，reload 即丢。
- [ ] 若要做：daemon/IPC 或文件事件方案，带锁、超时、崩溃恢复；若不做：在 README/CONTRACT 明确「wait 只限当前 generation」。
- [ ] 恢复被收养任务的退出码/信号信息（当前 reload 后进程死只能标 `failed/lost`）。

验收：文档结论 + （若实现）跨 reload wait 用例。

### 4. TUI 体验第二轮
- [ ] 详情滚动/固定 header+footer 的完整视口模型（0.3.0 只做了 `… (+K lines)` 与 PageUp/PageDown）。
- [ ] Kitty 键盘协议的 Enter/方向键兼容；regular（非 fullscreen）模式的面板入口。
- [ ] 面板内 `R` rerun 的 cwd/环境策略复核；叠加 overlay 已有单例，保留测试。
- [ ] 可选：`ui.setStatus` footer 汇总（`PI_ASYNC_FOOTER=1`）是否保留/移除的最终裁决。

验收：24 行终端下 output tail 与键位提示都可见；regular 模式有可用入口；真实 TUI 场景回归。

### 5. Windows 支持决策
- [ ] 当前强制 `/bin/sh -c` + POSIX 进程组 + `/proc`；Windows 明确不支持还是提供 PowerShell/cmd 分支。
- [ ] 若不支持：README/安装说明显式写「POSIX only」，CI 不承诺 Windows。
- [ ] 若支持：spawn/kill/进程组/路径全部要分支，另开设计。

验收：文档决策 + （若支持）Windows smoke。

### 6. `ui.setActivity` / OSC busy
- [ ] 官方 pi 1.2–1.5 无 `setActivity`；当前只有 feature-detect shim，实际 no-op。
- [ ] 上游若落地：接入 aggregate + per-task activity，并恢复 `plugin/pi-async/<id>` 契约。
- [ ] 若上游不做：删除能力承诺，只保留 `setStatus`/rail/面板作为观测面。

验收：与上游 API 状态一致的文档；不再出现「已实现但 no-op」的表述。

### 7. 第 6 个工具（仅在证据充分时）
- [ ] 5 工具面是冻结契约；先收集「缺一个专门 list/filter/attach 工具」的真实需求。
- [ ] 若需要：优先扩展 `async_status`/`async_logs`，而不是新增工具。
- [ ] 任何新增/删除工具走 CONTRACT REV + 迁移说明。

### 8. 存储/配额收尾
- [ ] 全局磁盘配额 `PI_ASYNC_TOTAL_BYTES`（当前 per-dataDir 保留 100 个/7 天）。
- [ ] 跨 dataDir 旧目录清理（当前每个 session 一个目录，旧目录不自动删）。
- [ ] 非终态孤儿任务的定期回收（0.3.0 只在 configure 时 reapOrphans）。

验收：配额/清理开关 + 测试；默认行为不误删活跃任务。

## 非目标

- 不把 pi-async 改成 agent 编排器（属于 pi-legion）。
- 不为了「功能更多」破坏 5 工具冻结面。
- 不在没有 ack 的前提下伪造通知「已送达」。


</details>

## 逐条判定表（27 条）

判定口径：**已完成** = 代码/契约/测试里能指到实现；**仍需要** = 明确缺什么；**放弃** = 与冻结契约或 0.5.0 方向冲突，或条件分支不成立。

### §1 watch v2

| 条目 | 判定 | 证据（文件:行 / commit） | 理由 |
|---|---|---|---|
| 1.1 `output_matches` 执行超时/worker 隔离 | 🔜 仍需要（P3） | `src/core/watch.ts:25` 黑名单自述 "does not catch every polynomial case"；`:273-277` 求值直接 `regex.test(matchSubject(...))`，全同步；全仓 `worker_threads`/`vm` 零命中；commit `edff67e`（黑名单） | 只挡形状、不挡复杂度，`(a\|a)*` 仍可通过校验。改动面 6–8 文件（求值需从同步变异步，牵动 `WatchLoop`/`attachWatch`/19 处同步断言）+ CONTRACT。**未拆 issue**：需先证明 64K 主体下真能挂（见待定 V1） |
| 1.2 `success_when`/`failure_when` 的 `match: "all"` / `"any"` | ❌ 放弃 | `docs/CONTRACT.md:152`「各自是 OR（首个命中即返回），没有 `match:"all"` 模式」；`src/core/watch.ts:241-252` 首个命中即 return；schema 无字段且 `additionalProperties:false`（`src/tools/index.ts:179`）；README:250 / SKILL:82 给替代写法 | 契约冻结且主动否证；REV-29 的方向是**删旋钮**不是加旋钮；AND 与 pending 三态（一个 pending + 一个 matched）没有定义落点 |
| 1.3 64K 尾部窗口的字节/字符语义 | ✅ 已完成 | `src/core/watch.ts:12-18`（常量改名 + 注释「UTF-16 code units, not bytes」）、`:45-48`；CONTRACT:157-158、1100、1106-1109；README:253；SKILL:80；`tests/w2-safety.test.ts:106-120`；commit `5ed6600`（REV-25） | 注释/契约/README/测试四处已对齐，`MAX_MATCH_CHARS` 还被测试 import（改名不能悄悄回退）。仅剩 nuance：用例用 ASCII，未用 CJK 自证「码元≠字节」，不构成阻断 |
| 1.4 `killOnSuccess` 或状态/通知显式 `processAlive` | 🔜 仍需要（P3，只做后半句） | `src/core/registry.ts:1246`（`finalize` 无条件 `processAlive = false`）、`src/core/task.ts:112`；全仓无「置 true」的写入点；通知字段表 `src/core/notify.ts:29-38` 无该字段；`rg killOnSuccess` 只命中 review 文档 | `killOnSuccess` 是**新旋钮**，与 D4 契约（`registry.ts:1253` 注释 / CONTRACT:631）和收窄方向冲突 → 放弃；但 `processAlive` 只说了一半：D4 场景（watch 命中、进程仍在、状态已 completed）快照报 `false`，`async_status` 在与事实相反。**未拆 issue**（与 3.3 同属「终态快照的进程真相」，可合并成一条） |
| 1.5 `blind_checks` 对 `json_path_exists` 长期 pending 的策略 | ❌ 放弃 | `src/core/watch.ts:198-203`（pending 不计数且清零）；CONTRACT:148-151（REV-2：pending 不累计 blind、**禁止**与 error 合并）、`:159-161`（超大 JSON 永远 pending，由退出/timeout/kill 终结） | 这条要的「策略」**已经存在且被冻结**：出口是 `timeoutMs`/进程退出/`async_kill`。加「pending N 次算失败」要推翻 REV-2。合法残留只是 SKILL 加半句「超大 JSON 用 `jq -e`」 |

### §2 通知批量合并

| 条目 | 判定 | 证据 | 理由 |
|---|---|---|---|
| 2.1 同窗口多任务合并成一条通知 | ❌ 放弃 | CONTRACT:231-234（REV-9：v1 **每任务一条**、**不合并**，「真合并需改多任务 XML schema + 窗宽策略，另开后续 REV」）；`extensions/index.ts:404-405` 挂起 + `:225-233` flush（同一边界仍 N 条）；per-task 闩 `src/core/registry.ts:836-841` | 0.5.0 真正解决的是「N 次 `triggerTurn` 各自冷启动」，不是「N 条消息」：所有 pending 在同一 turn boundary 一起投递（`turn_end`/`before_settle`/`settled`）。内容合并会与 per-task `claimNotification`/`consumedAt`（一个终态恰好一个消费者）正面冲突，收益只剩 token |
| 2.2 每任务字段可追溯 + schema 变更走 REV | ✅ 已完成 | `src/core/notify.ts:29-38`（task-id/name/status/exit-code/kill-kind/failure-kind/output-file/summary/summary-truncated/guidance）、`:42-56` details 孪生；CONTRACT:236-243 失败矩阵 | 字段齐全；0.5.0 未改 XML schema，无需 REV |
| 2.3 `async_wait` 消费后的通知抑制语义 | ✅ 已完成（且被推广） | `src/core/registry.ts:1225-1234`（`waitResult` 先 `consume()`）、`:812`（`outputConsumed`）、`:822-833`（`consumedAt`）、`:836-841`/`:979-985`（claim/resend 都查）；`src/tools/index.ts:333/357/388`（wait/logs/status 都置闩）；`tests/i-settle-owner.test.ts:430,465` | 抑制从 wait 独占升级为通用不变量（0.4.3 `43e5c29`）。`async_wait` 默认下线后语义不但没退化，反而由 `async_status`/`async_logs` 接管了「消费即抑制」 |

### §3 跨进程 / 持久 waiter

| 条目 | 判定 | 证据 | 理由 |
|---|---|---|---|
| 3.1 明确 wait 是否跨 `/reload`、跨进程 | 🔜 仍需要（P2，纯文档） | `src/core/registry.ts:131`（`waiters = new Set`）、`:966-967`（`suspend()` 直接 `clear()`）；`:710-717`（waiter 自带 timeout，reload 后以 `notReady` 收场）；README/CONTRACT 无 generation 字样 | 决策事实上已是「不跨」，但**没有任何一句写下来**。用户/后来者读不到三件事：waiter 属于当前 generation、reload 在飞的 wait 以 `notReady` 收场（不 kill 任务）、结果仍可从 `async_status`/`async_logs` 取回 |
| 3.2 若做 daemon/IPC；否则文档写清 | ❌ 放弃（daemon 分支） | 全仓 `fs.watch`/`net.createServer`/SOCK 零命中；事实来源是磁盘快照 `<taskId>.json`（`registry.ts:1288-1293`），不是 waiter | waiter 只是 promise 解析器，为它引进程级 IPC（锁/超时/崩溃恢复）去续命一个**默认不注册**的工具，收益/风险比极差。文档分支并入 3.1，避免同一件事两个 issue |
| 3.3 恢复被收养任务的退出码/信号 | 🔜 仍需要（P3，只做同进程） | `src/core/registry.ts:399`（退役分支 `return { code }`：code 拿到又丢掉）、`:429-430`；adopt 死 pid → `finalize(snapshot,"failed")` 无 code（`:1147-1150`）、`:1244`（`exitCode = code` 即 undefined）；CONTRACT:500-501 把现状冻结 | 同进程 `/reload` 下子进程**仍是我们的子进程**，`handle.exit` 仍会 resolve，代价只是退役分支先落盘再 return（几行）；跨进程要 wrapper/daemon = 3.2 已否决。改行为需 REV。**未拆 issue**（与 1.4 后半同源） |

### §4 TUI 体验第二轮

| 条目 | 判定 | 证据 | 理由 |
|---|---|---|---|
| 4.1 详情滚动 / 固定 header+footer 的完整视口模型 | 🔜 仍需要（P2，含 2 个实测 bug） | `src/tui/panel.ts:437-445`（`move()` 同时改 `selected` 与 `scroll`）、`:401-408`（`scroll` 只喂 `outputLines.slice`）、`:341`（退化视口 `return [last]` 丢 header）、`:334-348`（折叠中间）；CONTRACT:451-460 承诺 header+footer | 实测：详情里按 ↑/↓ 会**同时切换选中的任务**（README:90 说「详情里滚输输出」），且 `… (+K lines)` 折叠区**不可达**（scroll 从不作用于 command/metadata）。这是 README/契约与实现的不一致，不只是「模型不够完整」 |
| 4.2 Kitty Enter/方向键 + regular 模式面板入口 | 🔜 仍需要（P3，只余边角） | `src/tui/panel.ts:181-185`（只兼容 Esc 的 `\x1b[27u`）、`:482`/`:500-501`（裸比较 `\r`/`\x1b[A`）、`:247`（`keybindings` 收到但丢弃）；README:99 + CONTRACT:434（regular 用 `/async` + 键盘） | **regular 入口已完成**（`/async` 命令，0.3.0 已删快捷键）：这一半可结案。残余是 Kitty 下 Shift+Enter `\x1b[13;2u` 与 modified arrows，宜改用 pi-tui `matchesKey`/keybindings，而不是继续手写字节比较 |
| 4.3 面板内 `R` rerun 的 cwd/env 策略复核 | 🔜 仍需要（P3，文档 1 句） | `src/tui/panel.ts:507-512`（只传 command/name/mode/cwd）、`:506`（cwd = **原任务** cwd，REV-13）；env 由 `src/core/spawn.ts:76` 取**当前** `process.env` + 当前策略；background 快照不存 env（`registry.ts:359-365`）；watch/`taskTimeoutMs`/notify 三字段在快照里但 rerun 没传 | 复核结论已经清楚（cwd 保持原任务、env 不继承、三个字段被丢），但**只有 CONTRACT:461 一句 cwd**，env 语义没写。要么写进契约，要么补齐字段——建议只写文档，避免 rerun 变成「隐形复刻」 |
| 4.4 `PI_ASYNC_FOOTER` 保留/移除的最终裁决 | ✅ 已完成（裁决 = 保留） | `src/tui/status.ts:103-105`（默认 off，严格 `=== "1"`）、`:107-124`（唯一路径 `initStatus`→`refreshFooter`，宿主无 `setStatus` 直接 return）；调用点 `extensions/index.ts:289/332/414/421`；README:118 + CONTRACT:451 已记 opt-in | 裁决：**保留 opt-in，零改动**。理由：它已是成本最低形态（默认关、无 timer、异常吞掉），删除是 breaking（改 4 处文档 + 删测试），而它和 rail 首行同源、信息重复在 opt-in 下可接受 |

### §5 Windows 支持决策

| 条目 | 判定 | 证据 | 理由 |
|---|---|---|---|
| 5.1 明确不支持，还是提供 PowerShell/cmd 分支 | ✅ 已完成（裁决 = 不支持） | `src/core/spawn.ts:80`（`/bin/sh -c` + `detached`）、`:198` 与 `src/core/registry.ts:1372-1392`（`/proc` 优先）、`:226-230`（负 pid = 进程组）、`src/core/env.ts:53-54`（POSIX 白名单）；`src/`、`extensions/` 零 `process.platform`；`git log --all --grep=windows` 空 | 裁决：**不支持**。三条硬依赖（shell / 进程组信号 / `/proc` 判活）都在热路径，替代要重写 kill + 两处 pidAlive + env 白名单；仓库零 Windows 需求信号。裁决记录在本报告，落实为用户面文字见 5.2 |
| 5.2 若不支持：文档显式「POSIX only」，CI 不承诺 | 🔜 仍需要（P2） | `rg -i 'windows\|wsl\|posix' README.md` → 空；`package.json:29-31` 只有 `engines.node`、无 `os`；CI 5 个 job 全 `ubuntu-24.04`（`ci.yml:17,53,91`）；CONTRACT 唯一提及是描述性括注 `:490` | CI 侧已满足（无 windows runner）；**文档侧一处都没写**。建议 README Install + Known limitations + CONTRACT §12 各一句，**不要**加 `package.json` `os`（那会变成 npm 拒装，是行为变更） |
| 5.3 若支持：spawn/kill/进程组/路径全部分支 | ❌ 放弃 | 条件不成立（5.1 裁决不支持）；需分支的面已枚举：shell `spawn.ts:80`、kill `:226-230`、判活 `:198`/`registry.ts:1374`、env `env.ts:54`、路径、CI、测试守卫（仅 `tests/g-revive-after-suspend.test.ts:25` 有平台守卫） | 随 5.1 归档，不进入设计。将来若真要做，必须独立设计 + REV，不是几行 `if` |

### §6 `ui.setActivity` / OSC busy

| 条目 | 判定 | 证据 | 理由 |
|---|---|---|---|
| 6.1 官方无 `setActivity`，当前只有 no-op shim | ✅ 已完成（事实已核） | `src/core/bus.ts:11-36`（三处 `typeof ui?.setActivity !== "function" → return`）；`ExtensionUIContext` 无该成员（`pi-coding-agent/dist/core/extensions/types.d.ts:72-135`）；CONTRACT:264-266 | 描述的两个事实都成立，且 shim 已从 `src/tui/host.ts` 迁到 `src/core/bus.ts`（host.ts 现在只剩 30 行绑定逻辑） |
| 6.2 上游落地则接 aggregate + per-task，恢复 `plugin/pi-async/<id>` | ✅ 已完成（代码已就位） | `src/core/bus.ts:4-9`（`plugin/pi-async/<taskId>`）、`:11-19`（aggregate `pi-async`）、`extensions/index.ts:330-331`/`:411-413`（finalize 清 + state raise/clear）；`tests/a-bus.test.ts:18` 冻结 id 形状 | 接线已存在且被测试钉住，上游一落地即生效，**不需要新写**。残留（不阻断）：`src/guard/settle-guard.ts:217-231` 有一份不 import bus 的私有副本，文案还不同（`N async task(s)` vs `N async tasks`），宜收敛 |
| 6.3 若上游不做：删除能力承诺，只留 setStatus/rail/面板 | 🔜 仍需要（P2） | CONTRACT:264-266「不构成能力承诺…三处调用在生产上是 no-op」紧接 `:267-271` 把「每任务 `id=plugin/pi-async/<task-id>`，raise/clear 与状态同步」写成**冻结契约条目** + REV-8 裁决 → 自相矛盾；README/skills 已零承诺 | 只需修 CONTRACT 那 3 行措辞：把 per-task 两条标成「shim 形状」。否则读者会以为「已实现但 no-op」是能力 |

### §7 第 6 个工具

| 条目 | 判定 | 证据 | 理由 |
|---|---|---|---|
| 7.1 5 工具面冻结 + 先收集真实需求 | ✅ 已完成（结论 = 不加） | CONTRACT:40/115-117/571/1226（默认 5 + 可选 1，REV-29）；`tests/k-toolsurface.test.ts:61,70` deepEqual pin；`docs/2026-11-02-review.md:228,333` 已给结论；`async_status` 已具 filter：`src/tools/index.ts:362-386` | 需求已收：加 list/filter 工具的诉求被「扩展 `async_status`」吸收；无未满足证据。**陷阱**：第 6 席已被 `async_wait`（暴露态）占用，将来「加工具」实际是第 7 个或顶掉 wait，需在 7.3 条文里澄清 |
| 7.2 若需要：优先扩展 `async_status`/`async_logs` | ✅ 已完成（已执行） | `async_status`：`includeHistory`/`status`/`name`/`limit` + recency 排序（`src/tools/index.ts:362-386`、`registry.ts:668-687`）；`async_logs`：`maxBytes`/`tail`/`stream`（`:344-349`） | 0.3.0 P1-1 就是这么落地的。唯一假设性缺口是 attach/follow（`async_logs` 无 cursor），仓库内零请求证据 |
| 7.3 任何增删工具走 CONTRACT REV + 迁移说明 | 🔜 仍需要（P2，条文） | 先例：REV-23 新增 `async_extend`（CONTRACT:927-941）、REV-29 删 sync + wait 下线（`:1186-1266`）；但 `CONTRIBUTING.md`（13 行）无此规则；且 CONTRACT:980 仍写「§3 的『工具集（6 个）』」= 漂移，漂移门 `tests/f-reminder.test.ts:401-408` 只扫 §17→§18 扫不到 | 实践是习惯不是条文，下一个 agent 不会遵守；顺带修 `:980`。这条也是「0.5.0 D4 之后工具面变更流程」唯一未落定的部分 |

### §8 存储 / 配额收尾

| 条目 | 判定 | 证据 | 理由 |
|---|---|---|---|
| 8.1 全局磁盘配额 `PI_ASYNC_TOTAL_BYTES` | 🔜 仍需要（P3） | 源码零引用（只 `docs/2026-11-02-review.md:261` + `docs/PLAN-0.3.0.md:166` 的 `enforceDiskQuota()`）；真实旋钮是 per-dataDir 的 `PI_ASYNC_RETENTION_MS/COUNT`（`registry.ts:62-63,161-162`）；单任务上限 3×20 MiB（`spawn.ts:72,85-87` 三个流）；`PI_ASYNC_KEEP`/`PI_ASYNC_MAX_AGE` 全仓不存在 | 现状**有界但不聚合**：7 天窗口内的终态不受 100 约束（`registry.ts:1197-1200` 是并集），长会话可无界。「全局」必须跨目录统计 → 与 8.2 同一套枚举机制；低风险落法是先做 per-dataDir 字节配额 |
| 8.2 跨 dataDir 旧目录清理 | 🔜 仍需要（P3） | 契约明文出界：CONTRACT:563「跨 session 目录的整目录回收**不在本条范围**」；`configure()` 就 mkdir（`registry.ts:220`）；全仓无 rmdir / 递归删除；实测本机 117 个目录 / 4.0 MiB，其中 54 个 >7 天、86 个空目录 | 三方都空：宿主不认这个目录（pi 源码零 `pi-async` 命中、session 自身也不清理）、README 无手动指引、插件不删。但删目录不可逆，必须三闸：不是当前 dataDir / 目录内无活 pid 快照 / mtime > N（N 须 > `RETENTION_MS`）；且**绝不能删父目录**（单父目录下最多 33 个并发会话） |
| 8.3 非终态孤儿任务的定期回收 | ✅ 已完成（进程内） | `src/core/registry.ts:1000-1021`（`reapOrphans`，configure 时）+ `:1026-1034`/`:1057-1085`（REV-28c 5s liveness sweep：两轮确认、绝不 kill）；测试 `tests/d-storage.test.ts:114-140,309-352`、`tests/g-revive-after-suspend.test.ts` | 「只在 configure 时」**已不成立**：running 死 pid 现在由 5s 巡检定期结算（0.4.2 `eff1879`）。跨 dataDir 的孤儿（宿主被硬杀后留下的 detached 组）属 8.2，不属本条 |

## 重建后的结构

issue #81 正文改为四段：

1. **结论摘要**（27 → 10/12/5，基线 commit，指向本报告与子 issue）
2. **✅ 已完成（10）**：表格「条目 | 证据」。可核对的一行证据，不再保留 `- [ ]`（勾选框会误导「还没做」）
3. **🔜 仍需要（12，按价值排序）**：表格「条目 | 优先级 | 缺什么 | 落到哪个子 issue / 为何未拆」。排序依据 = 用户可见性 × 改动成本倒数的乘积，不是模块顺序
4. **❌ 放弃（5）**：表格「条目 | 理由」，每条都指向冻结契约或条件不成立，而不是「以后再说」

底部保留 **原始正文（逐字）** 于 `<details>`，历史价值不丢；issue 标题从「0.3.1: deferred items from 0.3.0 …」改为反映重分诊。

## 新建子 issue

| # | 标题 | 优先级 | 覆盖 #81 条目 | 类型 |
|---|---|---|---|---|
| #101 | TUI 详情视口：把「选择」与「滚动」拆开，让 `… (+K lines)` 可达 | P2 | 4.1、4.2（Kitty 边角） | 代码 + 测试 |
| #100 | 契约/文档收口：POSIX-only、wait 的 generation 边界、activity 措辞、工具面 REV 条文 | P2 | 5.2、3.1、6.3、7.3、4.3（+ CONTRACT:980 漂移、6.2 副本收敛） | 纯文档 |
| #102 | 存储生命周期：跨 dataDir 清理 + 全局字节配额 | P3 | 8.2、8.1 | 代码 + 契约 REV |

未拆 issue 的 3 条（1.1、1.4、3.3，剩下 9 条已落到 3 个子 issue）说明：

- **1.1**（ReDoS 执行超时）：需先有「64K 主体下真能挂」的证据（待定 V1），且改动是架构级（同步→异步求值）。先记在 #81，等触发条件。
- **1.4 后半 + 3.3**（终态快照的进程真相）：两条同源（`finalize` 之后的快照说了与进程相反的话/丢了退出码），都需要一次 CONTRACT REV 裁决 D-07 的边界（「终态快照永不声称进程存活」是否要改成「终态快照报实测」）。裁决先行，故不拆实现 issue。

## 待定（信息不足，不猜）

| # | 问题 | 缺什么 | 影响哪条 |
|---|---|---|---|
| V1 | `(a|a)*` 在本仓 V8 上能否把 64K 主体的同步求值打爆 | 需要一次基准/超时实验（本次只读，未执行） | 1.1 的优先级（不影响「只有形状黑名单」这一事实） |
| V2 | idle 时连续 N 次 `sendMessage({triggerTurn:true})` 是合并成一次唤醒还是 N 次 provider 请求 | 在宿主二进制里，仓库无源码；`docs/reports/notify-first.md` 只有单任务 transcript | 2.1 的真实成本（判定已是放弃，仅影响理由强度） |
| V3 | `/reload` 时在飞的 `async_wait` 是宿主先 abort，还是靠自身 timeout 落 `notReady` | `tests/` 无用例（`suspend` + `wait` 无命中） | 3.1 文档措辞要写哪一种收场 |
| V4 | pi 1.3/1.4/1.5 是否真无 `setActivity` | 本地只装了 pi 1.2.0，只能核到 1.2.0 类型 | 6.1/6.2（不影响「当前是 no-op」的结论） |
| V5 | legion `extension_activity` 转发（#156）是否已落地 | 无 legion 源码/网络 | 6.2 的真机验收时机 |
