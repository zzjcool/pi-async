# 0.4.8 — 等待行并进 rail（输入框上方不再有独立一行）

- 契约：`docs/CONTRACT.md` §7.1「修订 8」（冻结契约 `/tmp/hold-in-rail-contract.md`，D1–D5）
- 用户裁决（原话）：「外观版的话我觉得可以，这样输入框上方的 `⠙ waiting 2m 28s — Esc stops waiting`
  这个我觉得就可以不要了」
- 基线：`origin/main` `dd73081` = 0.4.7；分支 `feat/hold-in-rail`

## 1. 改前 / 改后

### 改前（0.4.7，hold 期间）

```
▶ 1 running                                                     ← rail 汇总行
▶ watch-rail-demo · running · 1s                                ← rail 任务行
⠼ waiting 1s — Esc stops waiting                               ← 输入框上方独立一行（本次删除）
━━━━━━━━━━━━━━ editor ━━━━━━━━━━━━━━
waiting for 1 task 0s                                           ← footer（保留）
```

### 改后（0.4.8，同一个 hold）

```
⠼ async_wait · running 1s — Esc stops waiting                  ← rail 首行：等待行顶掉汇总行
▶ watch-rail-demo · running · 1s                                ← rail 任务行（一字未改）
━━━━━━━━━━━━━━ editor ━━━━━━━━━━━━━━
waiting for 1 task 0s                                           ← footer（保留）
```

三点语义：

1. 等待行**顶掉**汇总行，不是新增一行 —— `RAIL_MAX_LINES=4` 冻结，用户示意正是「等待行 + 3 行任务」，
   所以 `RAIL_TASK_SLOTS` 仍是 3（调小会让第三个任务丢掉 `▶` 名字行 ⇒ `railShowsTasks` 变假 ⇒ 兜底行回来，
   同一件事说两遍）。
2. 首字符仍是 braille 动画帧（250ms/帧）。`agent_end` 已经清掉宿主的 working 行，换帧是这一行唯一的
   「还活着」信号；文案仍为英文。
3. 唯一文案来源是 `src/tui/surfaces.ts` 的 `waitingRow(frame, elapsed, detail?)`：rail 首行与 hold 兜底行
   都调它，别处不许再拼一遍 `async_wait`。

## 2. 删掉的代码清单

`src/guard/hold.ts`：

| 删除 | 说明 |
| --- | --- |
| `const WIDGET_KEY = "pi-async-hold"` | 每帧无条件写 widget 的键（`pi-async-hold` 现在只是 footer 的 **status** key，`FOOTER_KEY`） |
| `setProgress(ctx, tasks, elapsedMs, tick)` 里的 `setWidget(WIDGET_KEY, [clamped], { placement: "aboveEditor" })` 分支 | 0.4.3–0.4.7 的「输入框上方那行」 |
| `clearProgress(ctx)` | 换成 `clearWaiting(ctx)`：撤销 rail 声明 + 重绘 + 清兜底行 |
| `detailedRow(frame, tasks, elapsed, width, tail)` | 0.4.5 的明细行拼装；现在由 `waitingRow()` + `fitTaskList()` 组成 |
| `railShowsTasks()` 之后的“无条件 `ensureRailSurface()` 后照旧写 widget” | 现在先撤销 `holdSurface`，自愈后**立即复检**，能上 rail 就一帧都不落兜底 |

新增：

- `export const HOLD_FALLBACK_WIDGET_KEY = "pi-async-hold-fallback"`（只在 rail 画不出来时存在；不进用户文档）
- `setWaiting(ctx, tasks, elapsedMs, tick)` / `clearWaiting(ctx)`，`clearWaiting` 在 `holdUntilSettled` 的
  `finally` 里调用（覆盖全终态 / 超时 / Esc / 用户入队 / dispose / registry 抛错全部出口）
- footer 在 `typeof ctx.ui.setWidget !== "function"` 时追加任务名（§8 的最后落点）

`src/tui/surfaces.ts`：`HoldSurface`、`setHoldSurface`/`holdSurface`、`waitingRow`、`railRepaint`、`RailDetail.repaint?`；
`resetRailSurfaceForTests()` 一并清 hold surface。`railShowsTasks` / `ensureRailSurface` / `railMounted` /
`railTaskIds` 语义**未改**（0.4.7 的「按画面判定」必须保住，没有退回“注册即信任”）。

`src/tui/rail.ts`：`render()` 里 `const holding = holdSurface()`；`holding` 存在 ⇒ 首行
`coloredWaiting(frame, elapsed, width, theme)`（`truncateToWidth` 到 width，accent 色，`theme.fg` 兜底到原文），
否则仍是 `coloredSummary(...)`；`mountRailDetail` 增加 `repaint: () => tui.requestRender()`（1Hz ticker 不够）。

## 3. 三条不变式 + 测试名 + 实际输出

### 不变式 1 — hold 期间 rail 首行是等待行，任务行与 4 行上限都不变

测试：`tests/i-hold-in-rail.test.ts`
「while a hold waits, the rail's first row is the wait and the three task rows stay」
断言：`rows.length === RAIL_MAX_LINES`、`rows[0]` 匹配
`/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] async_wait · running \d+s — Esc stops waiting$/`、
`rows.filter(r => r.startsWith("▶")).length === 3`、每行匹配 `/^▶ watch-t7x · running · \d+m \d+s$/`、
逐帧 `holdSurface()` 快照里 `frame` 与 `elapsed` 各至少两种取值。
另有 `tests/i-hold-in-rail.test.ts`「the waiting row displaces the summary row instead of adding a row of its own」
钉住“顶掉汇总行”：`rows` 里 `startsWith("▶")` 的只有任务行，`/^▶ \d/`（汇总计数行）**不存在**。

同一时刻的三处证据（真实渲染，`registerRail` + `registerHold`，3 个 running 任务）：

```
INVARIANT 1 — rail row 0 is the wait, three task rows stay (4 rows, cap 4):
  ⠹ async_wait · running 0s — Esc stops waiting
  ▶ watch-t71 · running · 4m 6s
  ▶ watch-t6z2 · running · 4m 6s
  ▶ watch-t73 · running · 4m 6s
  holdSurface() = {"frame":"⠹","elapsed":"0s"}
  fallback widget rows = []
  async_wait occurrences = 1
```

### 不变式 2 — 全屏任何时刻最多一处 `async_wait`，且名字总在屏幕上（§8）

测试：`tests/i-hold-in-rail.test.ts`
「a host that cannot take the rail back gets the fallback line, and the screen still says it once」
（宿主清空 widget 且不再接受 rail 的那一帧）、
「a host with no widget surface at all still names the tasks — in the footer」、
`tests/h-hold.test.ts`「without a rail the hold names every task it is waiting for (fallback)」、
「with a rail that lists the tasks on screen the hold paints no line of its own」（rail 覆盖时兜底写入 0 条）、
「a rail that does not list the waited task never silences the hold row」、
`tests/e-rail-liveness.test.ts`「hold + rail are one source: the rail lists exactly the tasks the hold waits for」。
断言统一用 `screen.split("async_wait").length - 1 === 1`；兜底行匹配
`/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] async_wait · running \d+s — <name> \(running, .*\) — Esc stops waiting$/`。

```
INVARIANT 2 — the fallback frame still names the tasks, and says it once:
  ⠼ async_wait · running 1s — watch-t71 (running, 4m 7s) · watch-t6z2 (running, 4m 7s) +1 more — Esc stops waiting
  async_wait occurrences = 1
```

（同一帧里 rail widget 已经不在，所以这一处 `async_wait` 就是全屏唯一一处；rail 在的帧由上面的
`fallback widget rows = []` + `occurrences = 1` 覆盖。）

### 不变式 3 — hold 结束后 rail 首行恢复成汇总行

测试：`tests/i-hold-in-rail.test.ts`「when the hold ends the rail's first row is the summary row again」、
「Esc ends the wait exactly like any other exit: the rail's first row is the summary again」；
`tests/h-hold.test.ts`「the waiting row disappears when the hold exits on an all-terminal snapshot」/
「… on the budget」/「… when the user presses Esc」（三种出口都断言 `holdSurface() === undefined`
且兜底 widget 最后一条 `content === undefined`）。

```
INVARIANT 3 — after the hold, row 0 is the summary row again:
  ▶ 3 running · 4m 7s
  ▶ watch-t71 · running · 4m 7s
  ▶ watch-t6z2 · running · 4m 7s
  ▶ watch-t73 · running · 4m 7s
  holdSurface() = undefined
  async_wait occurrences = 0
```

### 变异验证（改回去即红，均为整仓 `node --experimental-strip-types --test tests/*.test.ts`）

| 改回旧行为 | 红 |
| --- | --- |
| rail 已在画时仍写自己的兜底行（0.4.3–0.4.7 形态） | 9 |
| 等待行与汇总行并列，而不是顶掉汇总行 | 7 |
| `RAIL_TASK_SLOTS` 调成 2（为等待行腾地方） | 4 |
| `finally` 里不调 `clearWaiting` | 7 |
| 无 widget 宿主时 footer 只报数量 | 2 |

## 4. 一次真实 hold 实测（0.4.7 树 vs 当前树）

recipe（契约 D5）：`git worktree add /tmp/pi-async-before origin/main`，同一个 `/tmp` 脚本分别对两棵树跑
**真实** `extensions/index.ts` 的 `init()` + **真实** `async_run`（`sleep 3`）+ **真实** `agent_before_settle`，
宿主是记录 `setWidget`/`setStatus` 的自制 stub（widget 工厂在 `setWidget` 时立即构建，与
`interactive-mode.js:1970-2003` 的 `setExtensionWidget` 同序）。脚本用 `timeout 120` 包裹。

脚本：`/tmp/hold-rail-screen.mjs`（两棵树各跑一次，`node --experimental-strip-types`）。跑完
`git worktree remove /tmp/pi-async-before`。

### 4.1 0.4.7（`/tmp/pi-async-before`，`dd73081`）

```
=== before any task ===
<widget "pi-async-rail">  0 row(s)
<footer>  (none)
async_wait occurrences on this screen: 0

=== during the hold (t ≈ 1.2s, the task is still sleeping) ===
<widget "pi-async-rail">  2 row(s)
▶ 1 running
▶ watch-rail-demo · running · 1s
<widget "pi-async-hold">  1 row(s)
⠼ waiting 1s — Esc stops waiting
<footer "pi-async-hold">  waiting for 1 task 0s
async_wait occurrences on this screen: 0

=== after the hold returned ===
<widget "pi-async-rail">  2 row(s)
▶ 0 running · — · ✓1
▶ watch-rail-demo · completed · 3s
<footer "pi-async-hold">  (cleared)
async_wait occurrences on this screen: 0

hold result: {"continue":true,"entries":["async-task-settle-results"]}
```

### 4.2 0.4.8（当前树 `feat/hold-in-rail`）

```
=== before any task ===
<widget "pi-async-rail">  0 row(s)
<footer>  (none)
async_wait occurrences on this screen: 0

=== during the hold (t ≈ 1.2s, the task is still sleeping) ===
<widget "pi-async-rail">  2 row(s)
⠼ async_wait · running 1s — Esc stops waiting
▶ watch-rail-demo · running · 1s
<footer "pi-async-hold">  waiting for 1 task 0s
async_wait occurrences on this screen: 1

=== after the hold returned ===
<widget "pi-async-rail">  2 row(s)
▶ 0 running · — · ✓1
▶ watch-rail-demo · completed · 3s
<footer "pi-async-hold">  (cleared)
async_wait occurrences on this screen: 0

hold result: {"continue":true,"entries":["async-task-settle-results"]}
```

读法：

- 0.4.7 hold 期间屏幕上有 **3 行**（`▶ 1 running` 汇总 + `▶ watch-rail-demo · running · 1s` 任务行 +
  `⠼ waiting 1s — Esc stops waiting` 独立一行）；0.4.8 只有 **2 行**，等待行在 rail 首行，
  `▶ 1 running` 汇总行让位 —— 用户不想要的就是被删掉的那一行。
- 结束那一帧两棵树一致：首行回到汇总行（`▶ 0 running · — · ✓1`），任务行显示 `completed · 3s`，
  footer 被清空，整屏没有 `async_wait` 残留。
- 两条路径的 hold 出口都是 `continue: true` + `async-task-settle-results`（修订 8 只动外观，不动出口）。

## 5. 计划偏差（1 处，按验收断言取舍）

D3 第 5 步给的是 `budget = terminalColumns() - displayWidth(head) - displayWidth(tail)`，没有减去
`waitingRow()` 在 head 与 detail 之间插入的 ` — `（3 格）。按字面实现，兜底行会比终端宽 3 格，被最后那道
`truncateToWidth` 从尾部吃掉 —— 结果是 `… +N more — Esc stops wai…`，与 D4 里冻结的
「窄终端正则结尾 `+N more — Esc stops waiting$` 不变」直接冲突（已实测：先按字面实现，该用例红）。

处理：预算里显式扣掉这个分隔符

```ts
const detailBudget = width - displayWidth(`${head} — `) - displayWidth(tail);
const row = waitingRow(frame, elapsed, fitTaskList(tasks, detailBudget));
```

于是「放得下就绝不截断尾巴、放不下就记 `+N more`」两条都成立（`tests/h-hold.test.ts`
「a narrow terminal truncates the task list instead of wrapping the row」在 80 列下断言
`displayWidth(row) <= 79` 且以 `… +5 more — Esc stops waiting` 结尾）。其余 D1–D5 条目按原文实现。

## 6. 越界项（父会话已收尾）

`README.md` 有两处在描述**被删掉的那一行**（不在 worker 的文件所有权清单里，故 worker 未动；
**父会话已改**，随本提交一起）：

- `README.md:154-166`（It visibly moves）：「renders its own row above the editor … removes it in a
  `finally`」→ 改为「the **rail's first row** becomes the wait … hands row 0 back to the summary row in a
  `finally`」，并点明 0.4.8 删掉了 0.4.4–0.4.7 那行独立等待行、两面互斥（全屏最多一处等待行）。
- `README.md:234-236`（Known limitations）：「now renders its own live progress row (spinner + elapsed +
  `Esc stops waiting`)」→ 「renders its live wait as the rail's first row」。

同一段里后面的「The per-task detail … stays in the rail … the rail is re-installed on the next frame」
与 0.4.8 仍然成立，未改。`docs/PLAN-HOLD.md` 是 0.4.3 的历史计划文档，按惯例不回填。
