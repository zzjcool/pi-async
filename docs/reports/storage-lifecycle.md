# 0.5.2 — 存储生命周期：跨 dataDir 回收 + 全局字节配额（#102）

- 分支：`fix/storage-lifecycle-102`（提交在 `pi-subagent/pi-async-102-99316a5e`）
- PR：https://github.com/zzjcool/pi-async/pull/106（正文写 `Fixes #102`）
- 基线：`origin/main` `91a4d88`（0.5.0 已发，#105 已合入；派发时的 `985a083` 已前进，先 rebase 到 `91a4d88`）
- 版本：`CHANGELOG.md` 顶部新增 `## [Unreleased] — 0.5.2 (minor)`；**未发版、未打 tag、未 `npm publish`**，
  `package.json` 仍是 `0.5.0`（沿用 0.4.x/0.5.1 的做法，版本号由 release 提交单独抬）
- 契约：`docs/CONTRACT.md` §10（跨目录那句改写）、§11（5 个新变量）、新增 §25（REV-32）
- 改动面：新增 `src/core/storage.ts`（纯判定/排序，无删除副作用）；`src/core/registry.ts`
  （`sweepStorage` / `evictCandidate` / `maybeSweepStorage` / `lastStorageCleanup`、owner marker、`removeArtifacts`
  改为返回真实释放量、`prune()` 与 `expiredTaskIds()` 共享 age/id 兜底）；新增 `tests/a-storage-sweep.test.ts`
  （32 例）；README、CONTRACT、CHANGELOG 与本报告

本文件只记录可复核的事实：两个工作项的最终形态、每条验收的「撤掉修复即红」证据、独立审查的结论与处理、
测试条数。

## 1. 结论

| 工作项 | 状态 | 默认 | 判据 |
|---|---|---|---|
| **S1 跨 dataDir 回收** | 落地：三闸 + owner marker + 「判无知就不删」 | **关闭**（`PI_ASYNC_SWEEP_SIBLINGS=1` 开启） | 非当前 dataDir（**目录身份**判定）/ 无人使用（无活 pid 快照 **且** 无活 owner）/ 空闲 ≥ `max(配置, retention+1)` |
| **S2 全局字节配额** | 落地：先算账 → 分层 → 全序淘汰 → 停手条件 | **关闭**（`PI_ASYNC_TOTAL_BYTES=<字节>` 开启） | `used > quota` 才淘汰；恰好等于不删 |
| 可观测 | 落地：每条删除**先日志再删** + `StorageReport` + `lastStorageCleanup()` | 常开（仅在被开启时产生） | 日志含目标/原因/字节数；报表含 removed/skipped/evicted/protected/unreadable/overQuota |
| 静默删数据 | **不存在**：默认只淘汰 retention 本来就该丢的；超限停手并报「配额已满」 | — | `overQuota: true` + 日志指引 |

- 新增 32 例测试全绿；`npm run typecheck` 绿。全量 `npm test` 只增不减，失败集合与基线**逐条相同**（见 §9）。
- **对抗式审查抓出 5 个 major 数据丢失/配额失效缺陷，全部已修并各自有「撤掉修复即红」的回归断言**（§8）。

## 2. S1：跨 dataDir 回收

### 2.1 改造前

`docs/CONTRACT.md` §10 原文把跨目录回收**划出范围**：「跨 session 目录的整目录回收不在本条范围（仍只读留档）」。
`prune()` 只作用于**当前** dataDir；每次 `pi -p` 都是新 sessionId → 新目录，旧目录永不再被打开。
实测（issue #102 原文）117 个 session 目录 / 4.0 MiB，其中 54 个 mtime > 7 天、86 个是 `configure()` 就 mkdir 的
空目录。全仓没有 `rmdir`/递归删除；`migrateDataDir` 成功也只删同名产物文件。

### 2.2 改造后

`PI_ASYNC_SWEEP_SIBLINGS=1` 时，`configure()`（节流 `PI_ASYNC_SWEEP_INTERVAL_MS`，默认 60 s）对
`dirname(resolve(dataDir))` 的**直接子项**逐一判定。整目录删除必须**三闸同时成立**：

| 闸 | 判据 | 覆盖测试 |
|---|---|---|
| **1 不是当前 dataDir** | **目录身份**相等：`dev`+`ino`（回退 `realpath`），不是比字符串 | `the live data dir is never a reclamation target`、`the live data dir is recognised through a symlink alias` |
| **2 无人使用** | (a) 目录内无 `running`/`pending` 且 `pidAlive(pid)` 的快照；**(b) owner marker 不存在，或其 pid 已死** | `a sibling whose running task still owns a live pid is skipped`、`an idle data dir of a live session is protected by its owner marker` |
| **3 空闲足够久** | `now - max(目录 mtime, 最新产物 mtime) ≥ max(PI_ASYNC_SWEEP_SIBLING_AGE_MS, PI_ASYNC_RETENTION_MS + 1)` | `a sibling that has not passed the age gate is kept`、`the age gate can never fall below the retention window` |

**闸 2(b) 不是过度设计**：真实布局是 `<sessionDir>/pi-async/<sessionId>`，而 `sessionDir` 是按 **cwd** 分的
（同目录多个 `pi` 进程共用一个 sweep root）。只带着终态任务空转的进程 B，目录 mtime 早过 14 天、没有非终态快照
——只看快照的话，B 活着却被删掉整份数据。`ensureDataDir()` 因此原子写入 `.pi-async-owner`（`{pid, at}`，0600），
它**不是产物**（不计字节、不当快照解析、不迁移），`surveyDataDir()` 把它列为允许内容（不让目录变 `foreign`）。

**判无知的默认答案是「不删」**（不许静默删数据）。每种情况只记 `skipped` 原因，不动文件：

| 情况 | reason |
|---|---|
| 当前 dataDir（含软链/大小写/`..` 别名） | `current` |
| 目录里有 dataDir 永远不会写的东西（子目录、软链、非产物文件） | `foreign_content` |
| 有 `.json` 解析不出快照（损坏 / 半写 / 未知 status）或触到快照扫描上限 | `unreadable_snapshot` |
| owner marker 存在但读不出 pid | `unreadable_owner` |
| 非终态快照指向活 pid | `live_task` |
| owner marker 的 pid 仍活着 | `owner_alive` |
| 未过年龄闸 | `recently_active` |
| 超过本轮扫描上限（`MAX_SCAN_DIRS = 256`，按名字排序后截断） | `scan_limit` |
| `rm` 抛错 | `delete_failed` |
| `dirname(dataDir)` 是文件系统根（`/`） | 整轮拒绝 + 日志 |

其它不变量：

- **父目录永不是目标**：只遍历 `root` 的直接子项（测试 `the parent pi-async directory itself is never a target`）。
- **`*.tmp` 残留既不「洗白」也不「定罪」**：空目录/只有 `migrateDataDir` 残留的目录确实是回收对象，但那**由年龄闸
  决定**，不是由「没有产物文件」决定（测试 `*.tmp residue neither condemns a fresh dir nor saves an idle one`）。
- **符号链接不跟随**：`lstat` 不是普通目录就跳过；`rm` 只作用于 root 的直接子项。

### 2.3 与 retention 的一处有意不对称

S1 的年龄闸**只按年龄**，不叠加 `PI_ASYNC_RETENTION_COUNT`。`prune()` 的 count 窗口是「每个 dataDir 内最新 N 个
终态任务」——它假设这个 dataDir 还会被打开；S1 回收的恰恰是**已废弃**（owner 已死 + 空闲超闸）的目录，对它们
套 count 窗口等于永不回收。这条不对称已写入 §25.7（审查 finding 6 要求明文，而不是留在「钳位保证不会早于过期」
这种不准确的措辞里）。

## 3. S2：全局字节配额

### 3.1 单位与记账（先算账）

- **单位 = 字节**。`PI_ASYNC_TOTAL_BYTES` 是整数、`0` = 关闭（非法/负值回退 `0`，走既有 `envNumber`）。
  报表与日志用二进制单位（KiB/MiB/GiB）渲染便于人读，**判据只比字节**。
- **产物族** = `.json` / `.output` / `.stdout` / `.stderr`（`lstat().size` 求和）；`*.tmp`、子目录、软链、owner marker
  **不计入**。
- **范围 = 整个 sweep root**（不只当前 dataDir）：这正是「全局」的含义。
- **dataDir 的认定用正证据**：是当前 dataDir、或有可解析快照、或无异物。当前 dataDir 里出现一个 `.DS_Store`
  也**仍然计入**（否则配额会「自我失效」并谎报 `overQuota: false`）；被排除的非 dataDir 目录若占用字节，
  会记入 `report.skipped`（`not_a_data_dir`）。
- **同界含于配额**：`used <= quota` 在预算内，只有 `used > quota` 才淘汰（测试 `the limit is inclusive —
  exactly at the quota deletes nothing`，配额**恰好**取独立算出的 `used`）。
- `usedBytesBefore` 含被保护部分（活任务、读不出的目录），`usedBytesAfter = before - freedBytes`；
  `freedBytes` 只累计**真的被 unlink 的普通文件**（`lstat` 确认 + `rm` 成功），不是计划量。

### 3.2 分层与删序（确定性）

候选只收**终态**任务的产物集（一个任务的四个后缀作为整体）+ **无快照指向的孤儿产物**：

| tier | 含义 | 谁可以删 |
|---|---|---|
| 0 | 孤儿产物（没有快照能观察它） | 总是 |
| 1 | **policy-expired**：`finishedAt ?? createdAt` 在 retention 窗口外，**且**不在最新 `PI_ASYNC_RETENTION_COUNT` 个之内 | 总是 |
| 2 | 仍在 retention 窗口内 | **只有 `PI_ASYNC_QUOTA_HARD=1`** |

tier 1 与 `prune()` 的并集策略逐字同义（含 age/id 兜底同源）→ 默认配额永远不会删掉「retention 仍承诺保留」的结果
（测试 `the count window still protects a task from the soft tier`）。

**删序是全序**：`tier` → `ageAnchor` 升序 → `taskId`（孤儿用路径）→ **`dataDir`** 字典序升序。
最后一键是必需的：`migrateDataDir()` 的 best-effort 清理可能把同一 taskId 留在两个目录（审查 finding 7），
没有它两条候选「相等」，顺序就退化成输入顺序（测试 `the order is total across data dirs too`）。
同 age 的任务靠 id 兜底，因此同一棵树上两次 pass 删的是同一个前缀、同一个序列（测试
`eviction order is total — tier, then age, then task id`：20 条同 tier 同 age 的候选，输入顺序故意打乱，
断言结果逐字相等且 `reverse()` 后不变）。**停手条件**：累计到 `used <= quota` 立刻停。

### 3.3 「不知道」不等于「没人要」

读不出快照的目录（解析失败 / 未知 status / 触到 `MAX_SNAPSHOTS_PER_DIR = 512`）**整目录不产生候选**，
记入 `report.unreadableDirs`，字节仍计入 `used` → 配额诚实地报 `overQuota`。
（审查 findings 2 & 3：此前这种目录里的产物会被当 tier 0「孤儿」，软模式就删掉。）

### 3.4 超限行为（宁可保留，也不静默删）

- **软模式（默认）**：tier 0+1 删完仍超 → **停手**，保留其余产物，`overQuota: true`，并写一条明确日志
  （`storage: quota still exceeded after N eviction(s): X used > Y quota — kept the remaining artifacts
  (raise PI_ASYNC_TOTAL_BYTES, or set PI_ASYNC_QUOTA_HARD=1 …)`）。
- **硬模式（`PI_ASYNC_QUOTA_HARD=1`）**：继续按同一顺序淘汰 tier 2，**每一条删除之前先写一条日志**并在
  `evicted` 里逐条列出（`reason: "unexpired"`）。当前 dataDir 的淘汰走既有 `removeArtifacts()`：文件 + 内存快照
  + timer + `notifyClaims` 一起消失，不留幽灵任务。
- **不删在飞任务**（两处独立保护，各有测试与变异）：非终态快照的产物**永远不是候选**；目录里有活着的非终态
  任务时**整目录**不贡献候选（并记入 `report.protectedDirs`，使「配额满了却什么都没删」可解释）。

## 4. 可观测性（为什么不是 `async_status`）

- 每一次删除**先写日志再删**：`console.warn("pi-async: storage: …")`，逐条含目标、原因、字节数；有删除时再写汇总。
- `sweepStorage(now?)` 返回 `StorageReport`：`removedDirs` / `skipped[{path,reason,detail}]` /
  `evicted[{dataDir,taskId,files,bytes,reason}]` / `protectedDirs` / `unreadableDirs` / `usedBytesBefore` /
  `usedBytesAfter` / `overQuota` / `freedBytes` / `lines`（`lines` 与日志逐条相同）；`registry.lastStorageCleanup()`
  取最近一轮。
- **`async_status` 返回形状不变**：改 payload 字段/`isError` 语义属 §12 的破坏性工具面变更（需另立 REV + 迁移
  说明），本条目不做，也不新增工具。
- **不使用 activity**：§7 已裁定 activity 是 write-only、「任何消费者不得把 activity 的有无当作工作证据」。

## 5. 调用点与副作用边界

- 调用点在 `configure()` 末尾：低频、幂等、带节流；**不放构造器**（D-04）、**不放每任务 hot path**
  （`prune()`/`finalize()` 未改）。
- 两个开关都不设时 `sweepStorage()` 在**任何 `stat`/`readdir` 之前**返回空报表 → 默认安装行为与 0.5.1 一致
  （测试 `with every switch at its default, configure() deletes nothing`）。
- 一轮出错只 `console.error`，`configure()` 不 throw（D-05）——审查用 `chmod 000` 兄弟目录与「父路径是文件」
  两种坏配置实测确认。
- 工作有界：`MAX_SCAN_DIRS = 256` × `MAX_SNAPSHOTS_PER_DIR = 512`（排序后截断，截断确定）。最坏一轮是同步的
  约 13 万次读；节流间隔就是上界频率，默认关闭。**已知限制**：`~/.pi` 在 NFS/iCloud 上时会明显——已在 §25.6
  写明，缓解手段是抬高 `PI_ASYNC_SWEEP_INTERVAL_MS` 或关掉（审查 finding 9，按「记录 + 有界」处理，未改为异步）。
- **不可逆**：删掉的产物/目录无法恢复。**回退开关只有一个方向**：两个开关回默认 `0` 即停止后续清理。

## 6. 测试（32 例，`tests/a-storage-sweep.test.ts`）

三闸各 2 例（含反向用例）、父目录、`*.tmp`、`foreign_content`、`unreadable_snapshot`、`unreadable_owner`、
软链别名、owner marker 保护与 owner 死后回收、文件系统根拒绝、默认关闭、节流、配额边界 3 例、跨 dataDir 淘汰序、
软模式超限、硬模式、活任务保护、pending 保护、孤儿优先、count 窗口、删序全序、跨目录全序、sibling 序、env 2 例、
读不出快照不产生候选、快照上限「无结论」、当前 dataDir 含杂物仍计入。

所有 fixture 都在 `mkdtemp` 的假 session 树下构造，**不指向真实 `$HOME`**；`sleep 30` 子进程在 `finally` 里回收；
不依赖墙钟（只用 30 天 / 1 小时的相对偏移）。`bytesOf()` 在测试里**自己写死**四个后缀（不引用模块常量），
避免「用被测代码验证被测代码」。

## 7. 要求的三项变异（撤掉修复即红）

命令一律 `timeout 240 node --experimental-strip-types --test tests/a-storage-sweep.test.ts`（最终 32 例）。

### M1 — 去掉配额检查（`if (after <= opts.quotaBytes) break;` → `if (true) break;`）

```
m1 -> red=6
quota: one byte over the limit evicts, and the bookkeeping reflects it
quota: a soft pass evicts policy-expired tasks oldest-first, across data dirs
quota: a hard pass drops still-retained results oldest-first and says so
quota: a pending delayed task is in flight too — its artifacts survive a hard pass
quota: an unreferenced artifact goes before any retained result
quota: a junk file in the live data dir does not disable the quota
```

### M2 — 把删序改成随机（`orderEvictions` → `sort(() => Math.random() - 0.5)`）

```
m2 -> red=2
quota: an unreferenced artifact goes before any retained result
determinism: eviction order is total — tier, then age, then task id
```

（连跑 3 次分别红 2/4/5 条，`determinism` 每次必红：20 条同 tier 同 age 的候选，随机排序恰好等于期望序列的
概率是 1/21!，实际不可能通过。）

### M3 — 让删除命中在飞任务（三处保护分别撤掉）

```
m3a -> red=1   # 撤掉 S1 闸 2(a)：活 pid 判定
cross-dataDir: a sibling whose running task still owns a live pid is skipped

m3b -> red=1   # 撤掉「有活任务的目录不参与配额」
quota: a live running task is never a candidate, even under a hard quota

m3c -> red=1   # 撤掉「非终态不是候选」
quota: a pending delayed task is in flight too — its artifacts survive a hard pass
```

## 8. 独立审查（fresh-context）与处理

独立会话（不继承实现历史）按「数据丢失 / 配额正确性 / 默认关闭回归 / 测试是否真的钉住结论」四轴审阅，
结论 `VERDICT: changes-needed`，5 个 major + 4 minor + 3 nit。**全部处理完毕**，每个 major 都有回归断言：

| # | 严重度 | 发现（审查原文要点） | 处理 | 回归断言（撤掉即红） |
|---|---|---|---|---|
| 1 | major | 闸 1 用 `resolve()` 比字符串，软链/大小写别名下会删掉**当前** dataDir | 改**目录身份** `dev`+`ino`（回退 `realpath`） | `R1` → `the live data dir is recognised through a symlink alias` |
| 2 | major | 读不出的快照被当「孤儿」，**软模式**就删 | `planEvictions` 对 `unreadable` 目录**不产生任何候选** | `R2` → `an unreadable snapshot is never treated as an unreferenced artifact` |
| 3 | major | `MAX_SNAPSHOTS_PER_DIR` 截断把尾部快照变孤儿（可能是活任务） | 同上：上限 = 「无结论」，不是「孤儿」 | `R2` → `the snapshot scan cap means "no verdict", never "orphan"` |
| 4 | major | 当前 dataDir 里一个 `.DS_Store` 就让配额自我失效并谎报 `overQuota:false` | dataDir 认定改**正证据**（当前目录永远计入） | `R3` → `a junk file in the live data dir does not disable the quota` |
| 5 | major | 活着的 session 只剩终态任务时，其 dataDir 会被删（同 repo 并行 `pi`） | owner marker `.pi-async-owner` + 闸 2(b) | `R4` → `an idle data dir of a live session is protected by its owner marker` |
| 6 | minor | 钳位只对 `retentionMs`，与 count 并集不匹配、文档措辞不实 | 行为保留（有意不对称），§25.7 明文写清理由 | 文档 |
| 7 | minor | 全序缺 `dataDir` 兜底键，迁移残留可让顺序退化成输入序 | 加 `compare(a.dataDir, b.dataDir)` | `R5` → `the order is total across data dirs too` |
| 8 | minor | `expiredTaskIds()` 与 `prune()` 同 age 时挑不同「陌生人」 | 两者共享 age 键 + `compareIds` 兜底 | 代码同源 |
| 9 | minor | 一轮是同步、最多 256×512 次读，NFS/iCloud 上明显 | 记录为已知限制（§25.6）+ 有界 + 默认关闭；未改异步 | 文档 |
| 10 | nit | `evicted[].files` 是计划量、`usedBytesAfter` 是推导值、边界检查是词法且 `statSync` 跟随软链 | 改成「`lstat` 确认普通文件 + `rm` 成功才计入」，返回真实 `{bytes,files}` | 代码 |
| 11 | nit | 文档漂移（23/24/26 三处数字、CHANGELOG 重复前言、§25.4 与实现不符、缺文件系统根说明） | 全部修正 | 文档 |
| 12 | nit | 测试没钉住最要紧的几类（读不出快照、上限、当前目录含杂物、别名）、`bytesOf` 借用了模块常量、一处断言同义反复 | 补 6 例 + `bytesOf` 写死后缀 + 删掉同义反复断言 | 见上 R1–R5 |

审查同时**确认没有问题**的轴（逐项验证过，非默认假设）：默认关闭时确实零 I/O（`sweepStorage`/`maybeSweepStorage`
在第一次 fs 调用前返回）、构造器无副作用（D-04）、`configure()` 不 throw（D-05）、`prune()` 语义与
`async_status`/工具面未被改动、测试 hermetic（只用 `mkdtemp`，无真实 `$HOME`，无墙钟脆弱性，`sleep` 子进程被回收）。

## 9. 测试数字（不许上调基线）

本机（macOS，无 `/proc`）实测：

| | total | pass | fail | skip |
|---|---|---|---|---|
| 基线 `origin/main` `91a4d88`（未改动） | 442 | 414 | 15 | 13 |
| 本分支，全量跑第 1 次 | **474** | **446** | 15 | 13 |
| 本分支，全量跑第 2 次 | **474** | **445** | 16 | 13 |
| 增量 | **+32** | **+32** | 0 / +1（见下） | 0 |

- 新增 32 例**全部通过**（单文件跑 32/32）；`npm run typecheck` 绿；既有断言**一条未改、未放宽、无 `|| true`**。
- 失败集合与基线**逐条相同**，唯一例外是下面那条既有 flake：第 1 次全量没命中它、第 2 次命中（`comm` 差集
  里只有它一条）→ 净回归为 **0**。
- 基线那 15 条都是 macOS 环境性失败（`/var` → `private/var` 软链导致 `realpath(root)` 与 `resolve(child)` 不对称、
  无 `/proc` 的存活判定、TUI rail/hold 时序），CI（Ubuntu）上不出现。
- 另有 1 条**既有 flake** `async_kill still kills a process after watch timeout finalized it`（`kill EPERM`，
  `tests/b-watch-integration.test.ts:104`）：在未改动的 `origin/main` 独立 worktree 上单文件跑 3 次 3 次全红，
  本分支 3 次 1 次红 —— 与本次改动无关。两次全量正好一次命中、一次不命中（15 / 16 的来源）。

## 10. 合入后复核（REV-33）：闸 2 的两个判活口子

本节记录一次**独立派发**的复核（派发时的 `main` 已前进到含 PR #106 的 `d0407d1`，本子树先 fast-forward 到
`origin/main` 再动手）。复核的目标不是「重做 #102」，而是验证 §25 的**核心安全承诺**是否真的成立：
「正在运行的任务/活着的 session 的目录绝不被删」。

### 10.1 结论：合入的实现有三个 fail-open 口子，均已在本次修掉

| # | 缺陷 | 方向 | 后果 | 状态 |
|---|---|---|---|---|
| **D1** | owner marker 的 pid 用 `pidAlive()`（进程**组**语义）探测 | fail-open | **活着的 session 的整份 data dir 被 `rm -rf`** | 已修 |
| **D2** | 「marker 存在但**读不出来**」被吞成「**没有** marker」 | fail-open | 同上（EACCES/EIO、marker 成了目录、悬空软链） | 已修 |
| **D3** | 快照的 `pid` 只要求是 `number`：`pid: 0` 在 macOS 判「活」、Linux 判「死」 | 平台相关判定 | 同一快照两个平台相反结论 | 已修 |

三条都属于同一类错误：**把「无法证明活着」读成「证明死了」**。§25.3 的原文承诺是「判无知的默认答案是
**不删**」，实现没做到。

**一次被复核抓到的自我回归（诚实记录）**：本次补丁的第一版给「非终态但快照没有 pid」加了**永久保护**
（`unproven_task`）。独立审查指出：`pending`（延迟任务）在 spawn 前本来就没有 pid，而 `shutdown()`
**故意**把这类快照留在盘上 —— 于是每个「排过延迟任务后退出」的目录会永远无法回收，实测「10 年后仍拒绝回收」。
这是把一个罕见的 fail-open 换成一个**常见且无界**的泄漏，方向错误，**已回退**。现在的规则是：
`pending` 快照**不提供**判活证据（既不算活、也不算死），由 owner marker + 年龄闸定生死 —— 这正是 marker
存在的理由。该结论有回归断言钉住（见 §10.4 的 M6）。

### 10.2 D1 的机理与证据

`writeOwnerMarker()` 写的是 `process.pid`（`src/core/registry.ts`），而 `pidAlive(pid)` 答的是
**进程组**问题：

- Linux：`/proc/<pid>/stat` 里 `pgrp === pid`（`pgrp` 是 *字段 5 = 进程组 id*）；
- macOS：`process.kill(-pid, 0)`（负号 = 向进程组发信号）。

任务子进程经 `spawn("/bin/sh", …, { detached: true })`（`src/core/spawn.ts:80`）成为 session/组组长，
所以 `pid == pgid`，组语义对**任务 pid** 是对的（也是 0.4.2 REV-28c/#6 刻意要的：组长退出但组里还有人
要算活）。但 **pi session 进程通常是 shell 进程组的成员，不是组长** —— 于是「活着的 session」被报成死的。

实测（本机 macOS，`node -e`，非组长子进程）：

```
childPid=78802  kill(-pid,0)=ESRCH → pidAlive()=false   # 明明是活着的进程
                kill( pid,0)=ok   → 进程确实存在
```

再把这条事实接进真实路径（scout 独立复现，fixture 全在 `mkdtemp`）：

```
CASE1  marker pid = 活着的非组长进程 → removedDirs=["…/session-live-nonleader"]  existsAfter=false
CASE2  marker pid = 活着的组长进程   → removedDirs=[]  skipped=["owner_alive"]    existsAfter=true
```

**为什么 32 例测试全绿却漏了它**：`tests/a-storage-sweep.test.ts` 的 marker fixture 用的是
`registry.submit({command:"sleep 30"}).pid` —— 一个 `detached` 的**任务** pid，必然是组长，于是
`pidAlive()` 恰好返回 `true`（理由错、结果对）。生产永远不会写这种值。

### 10.3 修复

- `src/core/registry.ts`：新增 `processAlive(pid)` —— **进程**语义（`process.kill(pid, 0)`；`EPERM` = 存在
  但不是我 的权限 → 算活；Linux 上再查 `/proc/<pid>/stat` 状态位，`Z` 僵尸算死）。**只给 owner marker 用**。
  `pidAlive()` 一字未改：任务 pid 继续走组语义，REV-28c 的语义边界不动。
- `src/core/storage.ts`：`siblingVerdict()` 接两个**独立注入**的判活函数（`pidAlive` 给任务、`processAlive`
  给 marker），避免「一个回调两处用」再次把两种语义混起来；`surveyDataDir()` 只接受**正整数** marker pid
  （`isPid()`），`0`/负数/小数 → `ownerUnreadable`（`0` 会被当成「我自己的进程组」、负数当成「进程组 N」，
  都不是关于那个进程的证据）。
- D2：`surveyDataDir()` 把「marker 的存在」与「marker 的可读性」分开。旧代码用一个 `try/catch` 把
  读失败归成 `markerRaw = undefined`（= 没有 marker）；现在先把 entry 记成 `absent` / `plain` /
  `unreadable`，非普通文件（目录、软链、socket）直接 `unreadable_owner` —— 本模块从不跟随软链，
  即使软链指向一个能读的 JSON 也不算证据。
- D3：快照的 `pid` 同样只接受**正整数**（`isPid`），否则整个目录记 `unreadable_snapshot`：`0` 会被
  `kill(-0, 0)` 当成「我自己的进程组」，负数当成「进程组 N」，两者都不能回答「那个进程还在吗」。
- **不做**：给「非终态但无 pid」加永久保护（见 §10.1 的自我回归记录）。这类快照不提供判活证据，
  由 marker + 年龄闸判定；这一条也有回归断言（M6）。

### 10.4 变异证据（撤掉修复即红，逐条实测）

| 变异 | 命令 | 结果 |
|---|---|---|
| M4 marker 改回组语义（`opts.processAlive` → `opts.pidAlive`） | `node --test tests/a-storage-sweep.test.ts` | **1 fail**：`#102 REV-33: a marker pid that is live but NOT a process-group leader protects the dir` |
| M5 撤掉 marker pid 的正整数闸（回到「任何有限数」） | 同上 | **1 fail**：`#102 REV-33: an unprobeable marker pid is unknown, never proof of death` |
| M6 把 `pending` 快照重新当成「永久保护」（第一版补丁的写法） | 同上 | **1 fail**：`#102 REV-33: a pending snapshot has no pid, so the owner marker decides — not the snapshot`（断言「无人认领的那个目录必须仍可回收」） |
| M6b 读不出 marker 时当作「没有 marker」（合入时的写法） | 同上 | **1 fail**：`#102 REV-33: a marker that cannot be read is unknown, never 'no owner'` |
| M6c 快照 pid 回到「任何 number」（合入时的写法） | 同上 | **1 fail**：`#102 REV-33: a snapshot pid that cannot be probed makes the directory unknown` |
| M7 把「一字节超限」用例改回软模式 | 同上 | **1 fail**：`#102 quota: one byte over the limit evicts…`（该用例原来那句 `existsSync("a.json")` 是**空转断言**：`a` 从未被创建，永远为真；已改成断言真正被淘汰的 `older.json` + 对照 `newer.json` 仍在） |

新增 6 例里，「非组长 marker」那条**自带 fixture 断言**：先断言该 pid `kill(pid,0)` 成功、且 `kill(-pid,0)`
必须是 `ESRCH` —— 也就是说，如果将来某个平台让这个子进程变成组长，测试会主动红，而不是「恰好通过」。
另有一条 `pending` 快照的用例，两半在同一轮里对照：marker 活 → 保留（`owner_alive`），无 marker 且过龄 → 回收。

### 10.5 复核过、**不改**的项（附理由）

| 发现 | 结论 | 理由 |
|---|---|---|
| **S2 配额不读 owner marker**：活着的空转 session 的**终态**产物仍可能被配额淘汰 | 不改代码，改文档 | tier 1 是那个 session 自己的 `prune()` 下一轮也会删的（同一并集策略），tier 2 需要显式 `PI_ASYNC_QUOTA_HARD=1`。若让 marker 也保护配额，「活着但 14 天没动静的 session」会永久钉住配额。文档原先把 marker 写成「这个目录还有人用吗」（读起来覆盖 S2），已在 §25.2/README 里把范围收窄到 S1 |
| **tier 0「孤儿」按目录判定**：`migrateDataDir()` 残留使同一 taskId 出现在两个目录时，没有快照的那份算孤儿并软模式即删 | 不改 | 已核对：迁移后 `metadata.outputFile` 指向新目录，且快照与产物同目录；旧目录那份本来就是 best-effort 清理的残留。契约 §25.4 已明文覆盖这个两目录场景 |
| 0.5.1 及更早目录**没有 marker**，只能靠「无活 pid + 年龄闸」判定 | 不改，记为已知边界 | 无法凭空取得证据。残留风险有界（需要同目录 14 天零写入），且新版本一写入就补 marker。已写进 §25.7 |
| pid 复用（死 session 的 marker pid 被无关进程复用） | 不改，记为已知边界 | 只往「多保留」方向错，不会误删 |
| `not_a_directory` / `not_a_data_dir` / `delete_failed` 三个 reason 不在 `SweepSkipReason` 联合里，契约表格也缺 | 修（纯文档/类型） | 类型诚实化 + 契约表格补齐；`report.skipped.reason` 是 `string`，不影响运行 |
| `CONTRACT.md` 旧引用的 `registry.ts:1374-1377` 已漂移成配额记账行 | 修（纯文档） | 改成按**函数名**引用 `pidAlive()`，以后不再随行号漂移 |
| `registry.ts` 注释「`<= 0` means every configure」与环境变量语义不符（负值会被 `envNumber` 回退成默认 60000） | 修（注释） | 只有程序化 `config.sweepIntervalMs` 能为负 |

### 10.6 复核过、但**未在本次修**的配额路径问题（审计有据，范围外）

第二轮独立复核（专门盯 `planEvictions` / `evictCandidate` / `envNumber`）又找到四处，均在**合入的配额路径**
里，但都是**既有语义**或**保守方向**，本次不动，只如实记录：

| 发现 | 方向 | 为何不改 |
|---|---|---|
| 当前 dataDir 的任务被淘汰时走 `removeArtifacts()`，它按 `metadata.outputFile` 删文件，而不是按 surveyed 文件清单。若 metadata 指向别处（迁移后 `persist()` 失败被吞、备份恢复、手拷目录），会**少删**本任务的文件、甚至删掉**另一个任务**的同名文件 | 可致错删 | 这是 `removeArtifacts()` 与 `prune()` 的**既有**共享语义（#102 之前就在），修它要动 `prune()`/`D-11` 边界与 `migrateDataDir`，属独立变更。正常写入路径（`join(dataDir, taskId+".output")`）不受影响 |
| 同一 taskId 在两个目录都留有副本时，两份是**独立候选**，配额可能两份都删（虽然只删大的那份就够了） | 多删 | 删序是确定的全序（§25.4），不是最优子集；被删的仍是 policy-expired / 显式 hard 的候选，不违反保留承诺。已写入 §25.7 |
| `planEvictions.bytesAfter` 是**乐观值**（按 surveyed 字节递减），与 `StorageReport.overQuota`（按实测递减）可能不一致 | 保守 | 后果只会是**少删** + 诚实报满，下一轮补完；已写入 §25.7 |
| `MAX_SCAN_DIRS = 256` 截断掉的目录既不计字节也不产候选 → 目录数超 256 时配额可能报 `overQuota: false` 而盘上仍超 | 记账不精确（有界） | 已写入 §25.7；改上限要付同步 I/O 代价（§25.6） |
| `PI_ASYNC_TOTAL_BYTES=1e18` 被接受（有限整数、无 `max`），等于开了个够不着的配额 | 无害 | 不 throw、不改行为；加 `max` 反而可能把合理的大值静默降级 |

另修了一处**事实性注释错误**：`sweepStorage()` phase 2 的注释原写「`foreign_content` 目录的字节不进配额」，
对「异物 + 可解析快照」的目录是**假的**（这种目录照样计数、照样产候选）。代码与契约 §25.2 一致，注释已改对。

### 10.7 测试数字

| | total | pass | fail | skip |
|---|---|---|---|---|
| 基线 `origin/main` `46d046e`（含 PR #106/#108，未改动） | 480 | 451 | 16 | 13 |
| 本分支 | **484** | **455** | 16 | 13 |
| 增量 | **+4** | **+4** | 0 | 0 |

- 单文件：`tests/a-storage-sweep.test.ts` **38/38** 全绿（合入时 32 例 → +6）。
- 16 条失败/13 条 skip 与基线**逐条相同**：在 `/tmp` 里用 `git archive origin/main` 独立展开一份未改动基线
  跑全量，失败用例名集合与本分支 `diff` 为空（16 条同名；macOS 环境性：`/var`→`private/var` 软链、无 `/proc`、
  TUI 时序；CI 为 Ubuntu）。
- `npm run typecheck` 在本 worktree **无法执行**：`tsc: command not found`（没有 `node_modules`，`typescript`
  未安装）。这是环境缺失，不是本次改动的问题；已用 `node --experimental-strip-types`（`npm test` 的路径）
  实际加载全部改动过的模块来兜底，并逐行复核类型。
