# PLAN-HOLD — settle hold（默认开，OSC 保持 working）

> 冻结契约，实施前不得改动 D 编号决策。修订必须在本文件标注「修订原因」并注明日期。
>
> **修订 1（2026-11 第一轮 review 后）**：D-3 #3 改为白名单；D-4 只 hold `running`；D-5 加单调时钟；
> D-6 改为「终态后自带 results entry + `continue:true`」；D-8 加 `footerRefreshMs` 注入；D-10 追加测试。
>
> **修订 2（2026-11 第二轮 review 后）**：**删除 F2b 早退启发式**（探针读错队列，见 §6），D-5 回到
> 「等满了/全终态」两条出口；D-5 的 `holdMs` 解析去掉 `min:0` 以便负数也视为关闭；D-6 回退文案不得
> 出现 `(running)`；D-10 删除早退用例、补「两个 running 先完成一个」用例；D-11 修措辞。

## 0. 目标与非目标

**目标**：主会话在一个 turn 结束时，如果还有「会唤醒会话」的 async 任务在跑，**不要立刻 settle**（settle 才会把终端 OSC 7501 从 `working` 翻成 `done`），而是在 `agent_before_settle` 边界内阻塞等待，直到这些任务全部终态或到达上限。

**非目标（不做）**：
- 不改 `src/guard/settle-guard.ts`、`src/context/nudges.ts`、`src/core/registry.ts`、`src/core/notify.ts`。
- 不改 notify 的单次投递语义（`notified` 一旦置位不再重发）——由此产生的 Esc 场景限制只记录、不修，见 §4。
- 不改军团（legion child）行为（D-3）。
- 不改 print / json 模式行为（D-3）。
- 不动 TUI working spinner（`agent_end` 时已被 harness 清掉；本特性只保证 OSC 7501 与 footer 文案）。
- 不新增第 7 个工具、不改工具 schema、不改 promptGuideline 文本。

## 1. 宿主事实（实施依据，已源码核实）

| # | 事实 | 证据 |
|---|---|---|
| H1 | `agent_before_settle` handler 被**串行 await**，无超时、无 watchdog、无 signal | `dist/core/extensions/runner.js:759-800`（`const handlerResult = (await handler(event, ctx))`） |
| H2 | hold 期间 `_isAgentRunActive === true` → `session.isStreaming === true`、`isIdle === false` | `dist/core/agent-session.js:1081-1083, 1442` |
| H3 | OSC 7501 只在 `agent_settled` 时才从 `working` 翻成 `done`/`idle`，扩展无写入 API | `dist/modes/interactive/program-status-reporter.js:63-66, 104` |
| H4 | 边界返回后 `shouldContinue = result.continue \|\| agent.hasQueuedMessages()`；hold 期间完成的 completion notification 走 `agent.followUp()` 入队 → **自动续跑一轮** | `dist/core/agent-session.js:1597, 1875-1878` |
| H5 | hold 期间 `ctx.signal === undefined`（底层 run 已结束），无法用 abort signal 打断 hold | `pi-agent-core/dist/agent.js:217` + `agent-session.js:2836` |
| H6 | TUI Esc → `void session.abort()`，只置标记并 `await waitForIdle()`；不会打断我们的 await | `dist/core/agent-session.js:1988-2000` |
| H7 | aborted run 不触发 `agent_before_settle` | `dist/core/agent-session.js:1468, 1475` |

## 2. 冻结决策

### D-1 新模块，独立于 SettleGuard
新增 `src/guard/hold.ts`，导出：

```ts
export function registerHold(pi: PiCtx, registry: TaskRegistry, opts?: { holdMs?: number; pollMs?: number }): () => void
```

- 返回幂等 disposer（重复调用无副作用）。
- `SettleGuard` 一行都不改（`tests/d-settle.test.ts` 对「恰 4 个 hook」的断言必须继续通过）。
- `extensions/index.ts` 里**在** `new SettleGuard(...).register()` **之前** 调用 `activeHold = registerHold(pi, registry)`，并在 `session_start` 的生命周期清理里像 `activeNudges` 一样释放上一代实例（`extensions/index.ts:122-131` 同款写法）。

### D-2 注册的 hook（恰好 3 个：`agent_before_settle` / `agent_start` / `session_shutdown`）
- `agent_before_settle`（async）：hold 主体。
- `agent_start`：`heldThisGeneration = false`（每 generation 重新武装）。
- `session_shutdown`：`dispose()`。
- 用与 SettleGuard 完全相同的 feature-detect 写法（`hooks.on?.(...)` 返回 unsubscribe，否则 `hooks.off?.(...)`）。
- `PI_ASYNC_HOLD=0` → **一个 handler 都不注册**，`registerHold` 直接返回 `() => undefined`（与 `PI_ASYNC_NUDGE=0` / `PI_ASYNC_SETTLE_GUARD=0` 现有风格一致）。
- `PI_ASYNC_HOLD_MS` 解析为 ≤ 0 时同样不注册。

### D-3 gate：不 hold 的情形（顺序即优先级，命中即 `return undefined`，不得有副作用）
1. `disposed`。
2. `process.env.PI_LEGION_NODE_ID !== undefined`（军团 child：现有 D10 有界 reminder 通道负责，不得叠加）。
3. `ctx` 存在且 `ctx.mode !== "tui"` → 不 hold（**白名单**：只有交互 TUI 会话 hold）。
   `print`/`json` 会拖住进程退出；`rpc` 的 abort 会等 `waitForIdle` 而客户端有 30s 超时（review F3）。
   `ctx` 缺失（老宿主/mock）→ **不**阻断，按可 hold 处理。
4. `typeof registry.list !== "function"`。
5. `heldThisGeneration` 已为 true（每 generation 最多 1 次）。
6. 没有 holdable 任务（见 D-4）。

### D-4 holdable 判定（与 nudges 的 `wakesYou` 同口径，就地复制 + 注释同步要求）
一个任务 holdable，当且仅当：

```ts
task.status === "running"                       // 注意：不是「非终态」
&& task.metadata.notifyOnCompletion !== false
&& task.metadata.triggerOnCompletion !== false
```

理由：只在「本来就会唤醒会话」的任务上 hold，语义才自洽（这些任务的 completion notification 会在 hold 期间入队并触发续跑，见 H4）。`notifyOnCompletion:false` 的任务是刻意的 fire-and-forget（例如 dev server），不得拖住 turn。

**必须是 `running` 而不是非终态**（修订 1，review F1）：`mode:"delayed"` 的 `pending` 任务默认
`notifyOnCompletion: true`，但它在整个 hold 预算内不可能终态（`dueAt` 可达任意远），会导致
**每个 turn 结束都烧满 `PI_ASYNC_HOLD_MS`**。延时任务不 hold。

**注意**：不得把 `wakesYou` 从 `nudges.ts` 导出/重构（那是测试冻结面），就地写 3 行并加注释「keep in sync with src/context/nudges.ts wakesYou」。

### D-5 hold 主循环
```
ids    = holdable.map(t => t.taskId)          // 进入边界时的快照，后续新任务不纳入
start  = performance.now()                    // 单调时钟（修订 1，review F4）
while (performance.now() - start < holdMs) {
  await sleep(min(pollMs, holdMs - (performance.now() - start)))   // setTimeout + unref()
  const stillLive = registry.list({ includeHistory: false })
      .filter(t => ids.includes(t.taskId))
  if (stillLive.length === 0) return true     // 全终态
}
return false                                   // 超时
```

- 时间预算用 `performance.now()`（单调），保证 `holdMs` 不被墙钟回拨突破。
- **两条出口，没有第三条**（修订 2）：全终态 / 超时。不尝试探测宿主队列——`ctx.hasPendingMessages()`
  数的是会话级用户队列 `_steeringMessages + _followUpMessages`，而 hold 期间的完成通知进的是
  `agent.followUpQueue`（`agent-session.js:1877` vs `:1924-1926`），该探针在正常路径恒为 `false`，
  任何基于它的早退都会把多任务 hold 截到「首个完成后 2 个 poll」（见 §6 修订 2）。
- `holdMs` = `opts.holdMs` 优先；否则 `envNumber("PI_ASYNC_HOLD_MS", 600_000, { integer: true })`
  （**不带 `min`**，以便负数也原样返回，再由 `!(holdMs > 0)` 视为关闭——修订 2 / review F3）。
- `pollMs` = `envNumber("PI_ASYNC_HOLD_POLL_MS", 1_000, { integer: true, min: 50 })`，`opts.pollMs` 优先（测试用）。
- 不调用 `registry.wait`（它会 `consume()` 掉输出并抑制通知，见 D-7）。
- 不改任务状态、不 kill、不写盘。
- 整个循环内每轮 `registry.list` 都必须包 try/catch：registry 在 hold 期间可能被 `suspend()`/`shutdown()`；任何异常 → 立即结束 hold 并 `return undefined`。

### D-6 释放语义
- **全部终态（正常路径）**（修订 1，review F2a）：**自带结果 + 续跑**——
  ```ts
  const done = <snapshot 内任务, 按 id 从 registry.list({ includeHistory: true }) 取>;  // 不内联 outputTail
  return {
    entries: [...(event.entries ?? []), {
      type: "custom_message", customType: "async-task-settle-results", display: false,
      content: `Held the turn for ${n} async task(s); all finished: ` +
        `${done.map(t => `${t.name ?? t.taskId} (${t.status}${t.exitCode === undefined ? "" : `, exit ${t.exitCode}`})`).join(" · ")}. ` +
        `Read the output with async_logs before answering.`,
    }],
    continue: true,
  }
  ```
  理由：续跑不能只依赖宿主队列——Esc 会 `clearAllQueues()` 把入队的通知丢掉，而 `notified` 已闩上
  （review F2）。自带 `continue` 让「任务已全部结束」这件事一定有下一轮 provider 请求；同时结果
  落进 transcript，即使被 abort 抑制也不会从上下文里消失。
  `continue` 不会造成循环：再次进入边界时 `ids` 里的任务全终态 → gate #6 直接返回 `undefined`。
  **不得**内联 `outputTail`（每条 8KiB，会撑爆上下文）；只给 id/name/status/exitCode + 指路 `async_logs`。
  **回退文案不得自相矛盾**（修订 2 / review minor 4）：历史行取不到时，只写取到的行，绝不把开边界快照的
  `status: "running"` 当终态写进 `all finished`；总任务数用 `ids.length`，明细只列已知行，缺失时写
  `(records pruned)`。
- **超时**：`return undefined`（不带 entries/continue）。不 consume、不动 `notified`、不抑制任何通知；
  此时 SettleGuard 的既有 advisory 逻辑照常执行（它在本模块之后注册，看到的是仍未终态的任务）。
- **异常/销毁**：`return undefined`。整个 handler 体包 try/catch，catch 里静默返回 undefined（hold 绝不能让 turn 失败）。
- 总耗时上限：`holdMs + pollMs`，不得更久。

### D-7 通知与输出
hold 期间**不得**调用 `registry.consume` / `claimNotification` / `markNotified`。完成通知在 hold 期间照常发出并走 `agent.followUp()` 入队（H4），这正是续跑的驱动器。hold 只负责「拖时间」，不负责投递。

### D-8 footer 状态（best-effort，不得抛）
hold 期间：

```ts
ctx.ui?.setStatus?.("pi-async-hold", `waiting for ${n} task${n === 1 ? "" : "s"} ${formatElapsedMs(elapsed)}`)
```

刷新间隔可注入：`opts.footerRefreshMs`（默认 15_000，测试用小值钉住刷新行为——review F5）。

- 每 **15s** 刷新一次（`setInterval(...).unref()`），`finally` 里 `setStatus("pi-async-hold", undefined)` 清除并 `clearInterval`。
- 每次调用包 try/catch；`ui`/`setStatus` 不存在则整体跳过（老宿主/mock）。
- 文案前缀固定 `waiting for `，时长用 `formatElapsedMs`（`src/core/duration.ts`）。
- 不在 hold 里碰 `setWorkingVisible` / `setWorkingMessage`（未验证，留作后续）。

### D-9 环境变量（写进 README 与 CONTRACT）
| 变量 | 默认 | 含义 |
|---|---|---|
| `PI_ASYNC_HOLD` | 未设置 = **开启** | `0` 关闭整个特性（一个 handler 都不注册） |
| `PI_ASYNC_HOLD_MS` | `600000` | 单次 hold 上限；`0` 关闭 |
| `PI_ASYNC_HOLD_POLL_MS` | `1000` | 轮询间隔 |

### D-10 测试：新增 `tests/h-hold.test.ts`（`PI_ASYNC_HOLD` 未设置 = 默认开启，测试内用 `withEnv` 隔离并复原）
至少覆盖：
1. `PI_ASYNC_HOLD=0` → `on` 调用次数为 0，disposer 可重复调用。
2. `PI_ASYNC_HOLD_MS=0` → 同样不注册。
3. `PI_LEGION_NODE_ID` 存在 → 不 hold（handler 立即 `undefined`，不 sleep）。
4. `ctx.mode === "print"` / `"json"` → 不 hold；`ctx` 缺失 → 允许 hold。
5. 全是 `notifyOnCompletion:false` 的任务 → 不 hold。
6. 正常路径：fake registry 第 2 次 `list()` 返回全终态 → handler 在一小段时间后 resolve 为 `undefined`，且结果对象**没有** `continue` 键、**没有** `entries`；`ui.setStatus` 先收到含 `waiting for 2 tasks` 的文案、最终收到 `undefined`。
7. 超时路径：任务始终 running → handler 在 `holdMs` 附近 resolve 为 `undefined`。
8. 每 generation 一次：连续两次 `agent_before_settle`，第二次立即 `undefined`（不等待）；`agent_start` 后重新武装。
9. `registry.list` 抛错 → handler resolve 为 `undefined`，不抛。
10. `ui.setStatus` 抛错 → 不影响结果；stale `ui` getter 抛错时 register/handler/dispose 都不得抛（对齐 `tests/a-settle-guard.test.ts:107-130` 的回归样式）。
11. 注册顺序：`extensions/index.ts` 中 hold 先于 guard（可在 `tests/i-factory-contract.test.ts` 里加一条断言，或在本文件用 fake pi 断言 `agent_before_settle` 的两个 handler 顺序）。

修订 1 追加（review F1/F2/F5/F6），同样必须有断言：
12. `pending`（delayed）任务**不**触发 hold；`running` + 一个 `pending` 只等 running 那个。
13. 正常结束返回**带** `entries`（`customType: "async-task-settle-results"`、`display: false`、含 `async_logs` 指路、不含 outputTail）；**不得**用整串精确匹配钉死行的先后（真机 `list({includeHistory:true})` 按 `finishedAt` 降序，集合相等即可）。
14. `ctx.mode === "rpc"` → 不 hold；`ctx.mode === "tui"` → hold。
15. footer 刷新：`opts.footerRefreshMs` 小值下 `setStatus` 至少收到 2 次带非零 elapsed 的调用；单数任务文案 `waiting for 1 task`。
16. `session_shutdown` 后 handler 立即 `undefined` 且不再 sleep；fake registry 上挂 `wait`/`consume`/`claimNotification` 间谍，断言**从未被调用**（D-7）。
17. **多任务不早退**（修订 2）：两个 `running` 任务，第一个在第 1 个 poll 后终态、第二个仍在跑 → hold **必须继续**，直到第二个终态或预算耗尽；不得因为「有任务完成了」而提前结束。
18. 时长断言一律用 `performance.now()` 计时（实现用单调钟，测试不得用 `Date.now()` 计窗口）。

### D-11 文档
- `docs/CONTRACT.md` §7.1 用修订后 §3 的新文本逐字替换；§1 文件树加入 `src/guard/hold.ts`；§11 环境变量表追加
  `PI_ASYNC_HOLD` / `PI_ASYNC_HOLD_MS` / `PI_ASYNC_HOLD_POLL_MS` 三行（风格照表内既有行）。
- **措辞纪律**（修订 2 / review minor 5）：不得写「不改动 SettleGuard 的任何决策」——`continue: true` 恰是
  guard 在主会话刻意不做的事；改写「不改动 guard 自身逻辑」。频率一律写「每 run 最多 1 次」
  （`agent_start` 每个 run 都会触发，`continue` 也算新 run），不写「每 turn / 每 generation」。
- `README.md`：在 settle guard / 后台任务相关小节加一段「默认 hold：turn 结束时如果还有会唤醒你的任务，run 会等到它们全部结束（上限 `PI_ASYNC_HOLD_MS`，默认 10 分钟）再 settle，终端 OSC 状态全程保持 working」，并列出 D-9 三个环境变量；补充一句「长驻服务（dev server）请用 `notifyOnCompletion: false` 启动，否则每个 turn 结束都会被 hold 到上限」。
- `CHANGELOG.md`：在最新未发布版本段落加一条 `feat(hold): keep the run unsettled while wakeable async tasks are in flight`。

## 3. CONTRACT §7.1 冻结文本（逐字，修订 2 = 当前版本）

```md
### 7.1 Settle hold（默认开，D-14）

- 注册于 `agent_before_settle`（每 run 最多 1 次，`agent_start` 重新武装），在 SettleGuard **之前**
  注册，不改动 guard 自身逻辑。
- 条件：存在 holdable 任务——`status === "running"` + `notifyOnCompletion !== false` +
  `triggerOnCompletion !== false`（`pending`/delayed 任务不 hold：预算内不可能终态）。
  仅在交互 TUI 会话 hold（`ctx.mode === "tui"` 或 ctx 缺失）；军团 child（`PI_LEGION_NODE_ID` 存在）、
  `print`/`json`/`rpc` 都不 hold。
- 行为：在边界内轮询等待（`PI_ASYNC_HOLD_POLL_MS`，默认 1000ms），直到快照内的 holdable 任务全部
  终态或到达 `PI_ASYNC_HOLD_MS`（默认 600000ms，单调时钟计时）。只有这两条出口，不探测宿主队列。
- 返回：全部终态 → 追加一条 `custom_message`（`customType: "async-task-settle-results"`、`display: false`、
  不含 outputTail、指路 `async_logs`）并 **`continue: true`**；超时 → 原样 `undefined`（不带 entries/continue）。
  `continue` 不会成环：再次进入边界时快照内任务已终态。
- 不 consume 输出、不动 `notified`、不抑制通知、不改任务状态、不内联 outputTail。
- footer：`waiting for N task(s) <elapsed>`（key `pi-async-hold`），15s 刷新，结束后清除；全部 best-effort。
- 开关：`PI_ASYNC_HOLD=0` 不注册任何 handler；`PI_ASYNC_HOLD_MS <= 0` 同样关闭。
```

## 6. 修订 1 原因（2026-11，review 后）

| # | review finding | 修订 |
|---|---|---|
| F1 | major：`pending`(delayed) 任务被当成 holdable，且默认 notify=on，导致每个 turn 必烧满 `PI_ASYNC_HOLD_MS` | D-4 改为 `status === "running"` |
| F2 | major：Esc → 宿主 `clearAllQueues()` 丢掉入队的 completion notification，而 `notified` 已闩上 → 唤醒永久丢失，且 hold 仍跑满预算 | D-6 正常路径自带 results + `continue: true`（结果不丢）；D-5 加 `hasPendingMessages` 早退（不白等） |
| F3 | minor：非军团 `rpc` 会话会 hold，而 rpc abort 有 30s 客户端超时 | D-3 #3 改白名单 `ctx.mode === "tui"` |
| F4 | minor：墙钟回拨可突破 `holdMs` 上限 | D-5 改 `performance.now()` |
| F5 | minor：15s 刷新与单数文案无测试 | D-8 加 `opts.footerRefreshMs`，D-10 #15 |
| F6 | minor：dispose 后行为、D-7「不 consume/不 claim/不 wait」无测试 | D-10 #16 |
| F7 | minor：文档索引缺口（§1 文件树、§11 env 表、README 的 delayed/Esc 说明） | D-11 追加 |
| **修订 2** | review 第二轮 F1/F2（major）：F2b 早退探针读错队列——`ctx.hasPendingMessages()` = `session.pendingMessageCount`（仅会话级 `_steeringMessages`+`_followUpMessages`，`agent-session.js:1924-1926,2844`），而 hold 期间的完成通知走 `this.agent.followUp()`（`:1877`）**不进**该计数 ⇒ 探针在正常路径恒为 `false`，多任务 hold 会在首个任务完成后 2 个 poll 提前返回 `undefined`，连带丢掉 results entry 与 `continue`（正是 F2a 要防的事）。单测把错误前提当断言钉住了。 | **删除早退**（D-5 回到两条出口），删除对应用例，新增 D-10 #17「两个 running 先完成一个不得早退」 |
| 修订 2 | minor：`PI_ASYNC_HOLD_MS=-1` 因 `envNumber({min:0})` 回退默认值反而开启 10 分钟 hold | D-5 去掉 `min`，由 `!(holdMs > 0)` 判定关闭 |
| 修订 2 | minor：历史行缺失时回退边界快照会产出 `all finished: A (running)` | D-6 增加回退文案约束 |
| 修订 2 | minor：§7.1「不改动 SettleGuard 的任何决策」「每 generation/每 turn」措辞与事实不符（`continue` 恰是 guard 不做的事；`agent_start` 每 run 触发） | D-11 措辞纪律 + §3 文本改为「每 run」 |
| 修订 2 | minor：测试有死断言、精确钉插入序、用墙钟计时 | D-10 #13/#18 |

## 4. 已知限制（接受，写进 README）

1. TUI 的 working 转圈在 `agent_end` 时就被 harness 清掉，hold 期间**不会**重新点亮；本次只保证 OSC 7501 与 footer 文案。
2. hold 期间按 Esc：harness 只置 abort 标记（H6），不会打断我们的 await → 最长要等到 `PI_ASYNC_HOLD_MS` 才放行；放行后该 run 仍按 aborted 结算。TUI 输入不冻结（`void abort()`）。
3. 长驻服务若用默认 `notifyOnCompletion: true` 启动，会每个 turn 结束都 hold 到上限。
4. `print` / `json` / `rpc` 模式行为完全不变。
5. hold 期间按 Esc：宿主会 `clearAllQueues()` 清掉已入队的 completion notification（`notified` 已闩上，
   不会再发）→ **在 hold 期间完成、且 Esc 在其后** 的任务不会有唤醒；但结果仍在返回的
   `async-task-settle-results` entry 里落进 transcript，下一轮对话可见。**hold 本身无法感知 Esc**
   （边界内没有任何 host signal：`ctx.signal === undefined`），所以会继续等，最长到 `PI_ASYNC_HOLD_MS`
   才放行；这是当前没有纠正手段的已知限制（探针路线已在修订 2 里证否）。
6. hold 期间完成、但 Esc 之后才完成的任务仍会正常唤醒（settle 后 `triggerTurn` 会开新 run）。
7. 唤醒丢失的根因在 `notify.ts` 的单次投递语义（`notified` 送达即闩、不重试）与宿主 `clearAllQueues`，
   修它超出本特性所有权，留作后续独立议题。
8. hold 期间 `waitForIdle()` 也会一直等到放行，所以任何 `await session.abort()` 的命令最多要等
   `PI_ASYNC_HOLD_MS`（例如 `/tree` 导航：`interactive-mode.js:4758` → `agent-session.js:1999`）。
   Esc 本身仍是 `void abort()`，不走这条路径，输入不冻结。

## 5. 验收

- `npm run typecheck` 与 `npm test` 全绿（含既有 30+ 测试文件，不得靠改旧断言绕过）。
- 新增 `tests/h-hold.test.ts` 覆盖 D-10 的 11 条。
- `git diff --stat` 只允许出现：`src/guard/hold.ts`、`extensions/index.ts`、`tests/h-hold.test.ts`、`docs/CONTRACT.md`、`docs/PLAN-HOLD.md`、`README.md`、`CHANGELOG.md`。
