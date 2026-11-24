# 终态快照不声称进程存活：判活 / 退出码三态（#116 / D-07 裁决 B）

基线：`origin/main` @ `56fff93`（0.5.3）。契约修订：`docs/CONTRACT.md` §27（REV-35）、§6 通知字段表、
§8 详情显示。实现分支：`pi-subagent/piasync-116-d07-c3041e34`。

## 1. 事故面（修前）

两处说了与事实相反的话：

| # | 位置 | 修前 | 事实 |
|---|---|---|---|
| 1.4 | `finalize()`（`src/core/registry.ts`） | 无条件 `processAlive = false` | D4（`success_when` 命中、`status=completed`、进程仍在跑）时快照与事实**相反**；通知字段表（`src/core/notify.ts` 的 `fields`）里没有这个字段，下游分不清「观测到死」与「默认 false」 |
| 3.3 | `live.exit.then` 的退役分支 `return { code }` | 退出码取到即丢 | 跨进程物理不可得（不假装），但**同进程 `/reload`** 拿得到 |

修前的 D4 是可量测的，不是形态学担忧：`tests/l-snapshot-honesty.test.ts` 的验收 1 在同一个断言序列里
先证 `registry.isProcessAlive(taskId) === true`（进程还活着），紧接着读快照 —— 0.5.3 的快照说的是
`processAlive: false`，同一个任务、同一个瞬间、两个相反的事实。

## 2. 做法（B）

### 2.1 三态字段（`TaskSnapshot`，`src/core/task.ts`）

| 字段 | 值 | 含义 |
|---|---|---|
| `processAlive` | `false` / `null` / 缺 | `false` = 退出**被观测到**；`null` = 什么都没观测到；缺 = 还没有任何主张（运行中 / 旧快照） |
| `processAliveKnown` | `true` / `false` | `true` **仅当** `processAlive` 是一次观测的结论，不是默认值 |
| `exitCode` | 数字 / `null` / 缺 | 数字 = 观测到的退出码；`null` = 没拿到；缺 = 运行中 |
| `exitCodeKnown` | `true` / `false` | `true` **仅当** `exitCode` 是数字 |

`null` 是**显式写进 JSON 的**（不是缺字段）：缺字段只表示「旧快照」，两者绝不能混。

### 2.2 `finalize()` 多一个「观测到了什么」参数

```ts
private finalize(task, status, code?, killKind?, observed: FinalizeObservation = "unknown")
// observed: "exit"    → 退出事件（带 code 时 code 就是观测值）
//           "gone"    → 探活证明进程组已消失，但没有退出值
//           "unknown" → 什么都没观测到（D4 watch 命中、未确认的 kill、无 pid 的快照）
```

调用点逐个分类（`grep -n "this.finalize(" src/core/registry.ts`）：

| 调用点 | `observed` | 理由 |
|---|---|---|
| `markWatchSuccess`（D4） | `unknown` | 命中时进程还在跑 |
| 退出回调：`failure_when` 命中 / `success_when` 命中 / 普通退出 / output_cap | `exit` | 就在退出事件里，退出码就是子进程的 |
| 退出回调：`killKind` 已置（killed） | `killed` | 退出事件也看到了，但结论是 `killKind`：**不记录退出码**（§6 失败矩阵），否则签名死亡的 spawn 兜底 `1` 会被当成判决 |
| `kill()`（`killTree` 返回 `confirmed`） | `gone` / `unknown` | 确认组死 = 证据；未确认 = 不许声称 |
| `reapOrphans` / `sweepLiveness` / `reloadFromDisk` 装载期 watcher | `gone`（有 pid 才成立） | 探活说组没了（两次连续才结算，REV-28c 不变）；没有 pid 可探 → `unknown` |
| 无 pid 的快照、pending 取消、`settleDroppedSnapshots`、blind/timeout 先结算再 kill、启动失败 / spawn 抛错 | `unknown` | 没有可观测的进程（或还没确认），所以 `processAlive: null` |

`exitCode` 的取法（`finalize` 里一行）：`killed` → `null`；否则有 `code` 用它；否则沿用对象上已有的数字
（退役代交接写进内存的那个）；否则 `unknown` → `null`，`gone` → 读**退役代落盘的观测**（见 2.3）。

两个非 `null` 的来源都有明确出处：退出事件里拿到的数字（`exit`），或 pi-async 自己的判决
（**启动失败**写 `exitCode: 1`，§8 既有约定 —— 此时 `processAliveKnown` 仍是 `false`，因为没有进程
可观测）。契约 §27 把这两条写成「确定的数字」的唯二来源。

### 2.3 同进程 `/reload` 的退出码交接（3.3）

- 退役代在 `live.exit.then` 的退役分支里不再丢弃 `code`：`recordObservedExit(task, code)`
  **合并写回**已持久化的快照（只改 `exitCode` / `exitCodeKnown`，绝不碰 `status` / `finishedAt` /
  `killKind`；已经终态的记录不碰 —— 终态快照是唯一记录，REV-28a 不变）。
- 收养代结算该任务时（`persistedExitCode()`）读到这个数字就落进终态快照；读不到就 `null` + `false`。
- **跨进程收养不交接**（物理不可得，不假装）：上一代宿主进程死了，退出码也随之消失。

### 2.4 显示层只有一个判据

`snapshotLiveness()` / `formatExitStatus()` / `exitSuffix()`（`src/core/task.ts`）是唯一的措辞来源，
四处在用：`notifyLivenessFields()` 喂通知字段表（`src/core/notify.ts`）、TUI 详情状态行
（`src/tui/panel.ts`）、hold 与 `pi -p` 结果行（`src/guard/hold.ts` / `print-wait.ts`）、完成卡片
（`extensions/index.ts`）。

- `snapshotLiveness()` 的闸门是 `processAliveKnown`，**不是** `processAlive`：0.5.3 及更早无条件写的
  `false` 是默认值，不是证据，所以旧快照读作 `unknown`（不迁移、不推断）。
- 通知字段表新增 `process-alive`（`true`/`false`/`unknown`）、`process-alive-known`、
  `exit-code-known`；`exit-code` 只在**拿到数字**时输出（`exit 0` 仍是真退出码，`null` 不输出）。
- TUI 详情对**每个终态快照**追加 `· process: alive|exited|unknown · exit <code>|exit unknown`。
- 结果行（hold / `pi -p`）遇到没有观测的退出码说 `exit unknown`，绝不出现 `exit null` / `exit 0`；
  一行的完成卡片**省略**退出段（一行里塞不下「unknown」，而 `kill kind` / 状态已经给了结论），
  但绝不写一个没人见过的码。

## 3. 验收逐条

### 验收 1 — D4（watch 命中、进程仍在）→ `null` + `known:false`（修前 `false`）

`tests/l-snapshot-honesty.test.ts`「acceptance 1」：`printf 'READY\n'; sleep 30` + `success_when`
`stdout_contains READY` → 任务 `completed`，`registry.isProcessAlive()` 仍为 `true`，快照
`processAlive === null`、`processAliveKnown === false`、`exitCode === null`、`exitCodeKnown === false`，
且落盘 JSON 里 `processAlive` 键**存在**（值为 `null`）。红→绿证据见 §4 变异 ①。

### 验收 2 — 观测到真退出 → `false` + `known:true`（对照组）

`exit 3` → `processAlive: false`、`processAliveKnown: true`、`exitCode: 3`、`exitCodeKnown: true`；
通知 XML 同时含 `<process-alive>exited</process-alive>`、`<exit-code>3</exit-code>`、
`<exit-code-known>true</exit-code-known>`，structured details 里也是同一组值（`sendCompletionNotification`
真发一次、断言 details）。**确定性没有变成 `null`。**

### 验收 3 — 收养任务两个用例

- **拿得到**「acceptance 3a」：`sleep 0.3; exit 7` → `suspend()` → 退役代把 `exitCode: 7` +
  `exitCodeKnown: true` 写进磁盘快照（此时 `status` 仍是 `running`，退役代不结算）→ `configure()`
  收养 → 终态 `failed/lost`、`processAlive: false` + `known: true`（探活是证据）、
  `exitCode: 7` + `exitCodeKnown: true`（读的是退役代落盘的观测）。
- **拿不到**「acceptance 3b」：磁盘上人工放一个 `status: running` + 死 pid 的快照（等价于上一代宿主进程
  死了）→ `reloadFromDisk()` 收养 → `failed/lost`、`processAlive: false` + `known: true`（死 pid 是证据）、
  `exitCode: null` + `exitCodeKnown: false`（跨进程不可能有）。**不假装。**

### 验收 4 — 旧快照按「未知」显示，不崩、不推断

「acceptance 4」直接喂 0.5.3 形状的快照：`processAlive: false` 但**没有** `processAliveKnown` →
`snapshotLiveness()` 返回 `unknown`，详情行是 `process: unknown`（且不含 `process: exited`）；
完全没这两个字段（0.5.2 及更早）同样 `unknown`、详情行 `process: unknown · exit unknown`，不抛错。
旧快照里的**数字** `exitCode: 7` 仍显示 `exit 7` —— 旧代码只在观测到退出码时才写数字，那个值是证据形状的，
而 `false` 不是（这条非对称是有意的，契约 §27 写明）。

### 验收 5 — 通知字段表与实现一致（含生产链路）

`buildNotificationXml` 的字段表（`src/core/notify.ts`）新增三个字段；「acceptance 5」断言
`unknown` 被**写出来**（`<process-alive>unknown</process-alive>` + `<process-alive-known>false</...>`），
且没有 `<exit-code>`；有数字时 `<exit-code>0</exit-code>` 与 `<exit-code-known>true</exit-code-known>` 同时出现。
`notifyLivenessFields()` 是 payload 构造（`extensions/index.ts`）与测试共用的唯一来源。
另外 `tests/d-reload.test.ts` 有一条走**真** `init()` / 真 `onFinalize` / 真 renderer 的用例（#116 F9 的
复核发现）：D4 任务完成后，发出去的那条 `async-task-notification` 的 `details` 里
`processAlive === "unknown"`、`processAliveKnown === false`、`exitCodeKnown === false` 且**没有** `exitCode`
键，XML 里是 `<process-alive>unknown</process-alive>`；同一 payload 交给完成卡片渲染器时，卡片不含 `exit`
段。这条用例在把 `...notifyLivenessFields(snapshot)` 从生产 payload 里拿掉时会红。

### 验收 7 — typecheck / 测试对照

| | 用例数 | pass | fail | skipped |
|---|---|---|---|---|
| `origin/main` @ `56fff93`（跑两次） | 501 | 472 | **16** | 13 |
| 本分支（最终代码） | 508 (+7) | 479 | **16** | 13 |

新增 7 条：`tests/l-snapshot-honesty.test.ts` 6 条（验收 1–5 + 对照组）+ `tests/d-reload.test.ts` 1 条
（生产通知组装与完成卡片，见 §5 F9）。

两次运行的红集合**逐条 `diff` 为空**（同一份 16 条，全部是 macOS 既存红，与改动无关）：

```text
a hold still resolves in a process with no other live handles (no unref'd poll timer)
a host that cannot take the rail back gets the fallback line, and the screen still says it once
a host with no widget surface at all still names the tasks — in the footer
a missing cwd rejects a background submit and fails a delayed task
a missing output file returns missing:true instead of throwing
a rail the host clears mid-turn comes back while the hold is waiting
async_kill still kills a process after watch timeout finalized it
async_logs splits stdout/stderr streams and reports a missing stream file
blind exhausted: failed + killKind=watch_failure + failureKind=blind_exhausted (distinct from timeout)
Esc ends the wait exactly like any other exit: the rail's first row is the summary again
hold + rail are one source: the rail lists exactly the tasks the hold waits for
pending delayed task can be canceled as a user kill
tests/g-revive-after-suspend.test.ts
the waiting row displaces the summary row instead of adding a row of its own
when the hold ends the rail's first row is the summary row again
while a hold waits, the rail's first row is the wait and the three task rows stay
```

一次中间运行（实现已定稿、只差注释）出现过 15 红：`async_kill still kills a process after watch timeout
finalized it` 这一条在 macOS 上是既存 flake（基线跑也会 `kill EPERM`；单独跑 `tests/b-watch-integration.test.ts`
时**基线与本分支各 3 次全部失败**）。它在后来的两次完整运行里回到红集合，红集合因此与基线逐条相同。
不声称「全绿」：这台 Mac 上就是 16 红。

`npm run typecheck`：exit 0（多次，含变异回滚后）。

CI（ubuntu）为准：`tests/g-revive-after-suspend.test.ts` 的三处断言按新契约改写（`exitCode` 从 `undefined`
变成 `null` / 观测值；退役代落盘的退出码允许为「观测值或 null」），本机无法执行（`requireLinuxProc` 跳过），
所以两处断言写成「`null` 或观测值」的**不变式**而非钉死数字 —— 那两条路径上探活 watcher（100ms）与退役代
退出回调存在真实竞态，钉死数字会造出一条 flaky 测试。

## 4. 变异（必红）

### 变异 ① `finalize` 回到无条件 `processAlive = false`（0.5.3 行为）

```diff
-    task.processAlive = processObserved ? false : null;
+    task.processAlive = false; // MUTATION ①: unconditional false (0.5.3 behaviour)
```

`node --experimental-strip-types --test tests/l-snapshot-honesty.test.ts tests/d-reload.test.ts` → **2 红**：

```text
not ok 11 - a D4 completion notifies `processAlive: unknown` and the card omits the exit segment (#116)
not ok 12 - #116 acceptance 1: a watch hit that leaves the process running says `processAlive: null` (was false)
  error: 'no exit was observed → null, never false'
# pass 15 / # fail 2
```

（其余 15 条仍绿：对照组、收养两用例、旧快照、通知表都不依赖这一行 —— 红得精准。）

### 变异 ② 把 `null` 当 `false` 渲染（去掉 `processAliveKnown` 闸门）

```diff
 export function snapshotLiveness(task) {
-  if (task.processAliveKnown !== true) return "unknown";
-  if (task.processAlive === false) return "exited";
   if (task.processAlive === true) return "alive";
-  return "unknown";
+  return "exited"; // MUTATION ②: render `null` as `false`
 }
```

同一次两个文件 → **4 红**：

```text
not ok 11 - a D4 completion notifies `processAlive: unknown` and the card omits the exit segment (#116)
not ok 12 - #116 acceptance 1 ...  (D4: <process-alive>exited</process-alive>)
not ok 16 - #116 acceptance 4 ...  (旧快照: process: exited 而不是 unknown)
not ok 17 - #116 acceptance 5 ...  (<process-alive>unknown</process-alive> 断言失配)
# pass 13 / # fail 4
```

两次变异都先把文件复制到 `/tmp` 再回滚（第一次用 `git checkout -- <file>` 回滚，把同文件里还没提交的
复核修复也一起冲掉了 —— 已重做并重新验证，教训写在 `docs/reports/snapshot-honesty.md` 的这一行里）。
回滚后 17 条全绿、typecheck 仍 0、全量测试红集合仍与基线逐条相同。

## 5. 独立复核与处置

改完后由一支 fresh-context 的只读 reviewer（`scout`，未参与实现）对着契约 §27 与
`git diff 56fff93..HEAD` 做对抗式复核，给出 12 条 findings（2 major / 6 minor / 4 nit）。逐条处置：

| # | 结论 | 处置 |
|---|---|---|
| F1 major：启动失败/spawn 抛错的合成 `1` 被标 `exitCodeKnown: true` | 接受「确有两个来源」，但拒绝把它当 bug | 契约 §27 写明「确定的数字」的两个来源（观测到的退出码 / pi-async 对启动失败的判决，后者 `processAliveKnown` 仍为 false）；`hasObservedExitCode()` 改为先看 `exitCodeKnown === false` 再看数字，字段变成**可读**的（不再是 write-only 同义反复） |
| F2 major：同一次信号死亡在三条路径上三种说法 | 真 bug（同一次 timeout kill 可能记 `1` 也可能记 `null`，取决于退出事件与 `killTree()` 谁先到） | 新增 `observed: "killed"`：killed 结算一律 `exitCode: null` + `false`。`node` 脚本实测：`sleep 30` + `taskTimeoutMs: 80` 现在稳定写 `exitCode: null, exitCodeKnown: false, processAlive: false, processAliveKnown: true`，与 `kill()` 的 `gone` 路径同构。契约 §27「killed 行不带退出码」钉死 |
| F3 minor：`unknown` 结算会丢掉对象上已有的数字（交接写进内存的那个） | 接受 | `finalize` 的取码顺序加一层「沿用对象上的数字」 |
| F4 minor：`sweepLiveness` 对无 pid 的快照也声称 `gone` | 接受 | 改成 `task.pid !== undefined ? "gone" : "unknown"`，与 `reapOrphans` / 装载期 watcher 一致 |
| F5 minor：旧快照在结果行里「不说」，在详情里说 `unknown` | 接受 | `exitSuffix()` 对缺失字段也输出 `exit unknown`（两个调用方都只渲染终态行） |
| F6 minor：`async_wait` 结果行开始出现 `exitCode: null` | 接受（§5/§12 形状冻结） | 回退成「有数字才有键」；三态只在快照里，契约 §27 写明 |
| F7 minor：交接可被收养代的一次 `persist()` 静默覆盖 | 接受一半 | `recordObservedExit()` 现在也更新**同一实例**当前持有的那个对象（非同对象、非终态、还没有数字时）；跨实例（真 `/reload`）仍不可及，写进已知边界 |
| F8 minor：`exitCodeKnown` 是 write-only | 接受 | 见 F1：`hasObservedExitCode()` 采纳该字段 |
| F9 minor：**生产**通知组装与完成卡片没有测试 | 接受 | `tests/d-reload.test.ts` 新增一条走真 `init()` + 真 `onFinalize` + 真 renderer 的用例（D4 任务 → `details.processAlive === "unknown"`、无 `exitCode` 键、卡片不含 `exit`） |
| F10 nit：`tests/a-notify-kinds.test.ts` 的 payload 镜像过期 | 接受 | 改成 `typeof === "number"` + `notifyLivenessFields()` |
| F11 nit：契约/报告 §2 三处措辞与代码不一致 | 接受 | 契约 §8/§27 与本文 §2.2/§2.4 全部改写（无 pid 的 `lost` 属于「没观测」，详情行对**所有**终态快照追加，killed 不带码） |
| F12 nit：死代码 / 重复收窄 / 同步读盘 | 部分接受 | 删掉未被使用的 `snapshotExitCode()`；`extensions/index.ts` 去掉重复收窄；`persistedExitCode()` 的注释写明「这次读盘**就是**交接」；`ProcessLiveness` 的 `"alive"` 保留（防御性，只有在真有 `processAlive: true` 时才会出现） |

复核同时确认了两件我原本只能推断的事：21 个 `finalize` 调用点里 18 个分类正确（F2 修完是 21/21），
以及三处 Linux-only 断言（`g-revive` 的 `null | 0`、`null`、`null | 1`）在 Linux 上两种竞态结局都成立。

## 6. 已知边界 / 未决

1. **探活抢先**：收养代的 100ms watcher 可能先于退役代的退出回调结算同一任务。终态记录是收养代的，
   手交（`recordObservedExit`）看到终态就跳过 —— 结果是 `exitCode: null`（少一条证据），
   **不会**写出与事实相反的 `false`。契约 §27「已知边界」第 1 条。
2. **跨进程收养**永远拿不到退出码（`null` + `false`）。
3. **data-dir 迁移**后退役代仍写旧目录，交接落空（同样只是少一条证据）。
4. 旧快照**不迁移**：`processAlive: false` + 无 `processAliveKnown` 一律读作 `unknown`；这是裁决 B 的
   代价，写进了契约与 README。
5. `async_kill` 返回的 `processAlive` 是**即时探活**（`isProcessAlive()`，布尔），不是快照主张，本次不动
   （契约 §7 形状冻结）。
