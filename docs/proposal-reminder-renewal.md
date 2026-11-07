# 提案：软超时提醒 + 续期（reminder / renewal）

状态：**已裁决并实现**（见 `docs/CONTRACT.md` §18 REV-23，实现落在 0.4.0）
起因：真实使用反馈——任务跑久了没人管，agent 卡在等待或忘了还挂着活；现有 `taskTimeoutMs`
只有硬杀一档，杀掉一个正在跑的长构建比不杀更糟。

## 0. 裁决结果（冻结于 CONTRACT §18）

| 决策点 | 裁决 |
|---|---|
| 默认策略 | background 且**无 `watch`** 的任务默认 **20 分钟**（`1_200_000` ms）提醒一次；显式 `remindAfterMs` 优先（`0` 关闭）；带 `watch` 默认不提醒；硬期限（`timeoutAt`）会先到时**不布防** |
| 提醒本身 | **绝不杀**：提醒路径不调 `kill`、不改 `status`、不写 `failureKind`；按 2 倍退避，最多 3 次，用尽后静默、任务继续运行 |
| 续期入口 | **新工具 `async_extend`**（工具面从 5 个变 6 个）：`{ taskId, remindAfterMs?, taskTimeoutMs? }`，任一次续期重置计数与间隔 |

补充裁决：`notifyOnCompletion: false` 一并静默提醒（单一「打扰面」开关）；`taskTimeoutMs` 语义不变，
仍是 agent 主动可选配置的硬杀、**不设默认**。

## 1. 要解决的问题

三个不同的问题被现在的一个旋钮混在一起：

| 真实需求 | 现状 | 缺什么 |
|---|---|---|
| 任务跑太久了，叫醒我一下，告诉我跑了多久 | 无（只有完成通知） | 运行期提醒通道 |
| 决定继续等 → 续期 | 无 | `async_extend` |
| 决定不要了 → 停止 | `async_kill` | 已有 |
| 绝对不许超过 N 毫秒 | `taskTimeoutMs` 硬杀 | 已有，保留 |

核心主张：**提醒 ≠ 杀**。提醒是给 agent 的注意力信号，杀是对进程的生命周期决策，两者应该分开。

## 2. 与既有机制的关系（避免造第二套）

| 既有 | 语义 | 与提案的关系 |
|---|---|---|
| `notify.ts` `sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` | 会话唤醒通道 | 直接复用；完成通知就是从这里唤醒的 |
| `settle-guard.ts` `maxReminders = 3` | **turn 维度**：不许带着活跃任务报 verdict | 互补，不重叠；需去重（见 §6） |
| `armTaskTimeout` (`registry.ts:354`) | 一次性 `setTimeout` + 从 registry 重读状态 | 提醒定时器的样板，照抄这个形状 |
| `task.timeoutAt` (D-03) | 绝对期限，reload 后按剩余时间重布防 | 提醒也应存**绝对时刻**，同法重布防 |
| 0.3.0 D-12（删掉 settle-guard 的 `setInterval`） | timer 里持有 stale ctx + 抛错 → `uncaughtException` 崩溃 | **禁止用长寿命 `setInterval` 闭包持 ctx** |

关键约束（来自 D-12 教训）：提醒定时器必须是
1. 一次性 `setTimeout`，触发后按需重布防；
2. 回调里 `registry.get(taskId)` 重读状态，不闭包持有 snapshot / ctx；
3. 触发路径包在 `try/catch` 里，失败只记录，绝不 escape 成 `uncaughtException`。

## 3. 建议的契约形状

### 3.1 `async_run` 新增字段

```ts
remindAfterMs?: number;   // 运行 N 毫秒后提醒一次；缺省 = 见 §4 默认策略
```

保留 `taskTimeoutMs` 的硬杀语义不变（重命名会破坏现有用户与测试）。

### 3.2 新工具 `async_extend`

```ts
async_extend({ taskId, remindAfterMs?, taskTimeoutMs? })
// → { taskId, name, status, elapsedMs, remindAt?, timeoutAt? }
```

- 语义：**续期**。移动提醒时刻与/或硬期限，返回新的绝对时刻供 agent 核对。
- 只接受活跃任务；终态返回 `alreadyTerminal` 而不是报错（对齐 `async_kill` 的既有惯例）。
- 为什么单独开工具而不是给 `async_run` 加 action：命名即语义，且 `async_kill` 已有先例；
  同时保留 `triggerTurn` 语义清晰。

### 3.3 提醒消息形状

沿用 `<async-task-notification>` 的 XML 风格，独立 `customType`：

```xml
<async-task-reminder>
  <task-id>…</task-id><name>build</name><status>running</status>
  <elapsed-ms>600000</elapsed-ms><remind-count>1</remind-count>
  <output-file>…</output-file><summary>最后 200 字节</summary>
</async-task-reminder>
```

正文只带一句动作指引：`Call async_extend to keep waiting, or async_kill to stop it.`
**只带 tail，不带全量输出**（提醒会烧 token 并触发新 turn）。

## 4. 决策点（已裁决，以上表与 CONTRACT §18 为准）

> 下面保留提案原文，便于对照裁决差异（例如默认间隔从建议的 10 分钟定为 20 分钟；
> 「未领取提醒堆积」由「同一任务只有一个一次性 timer + 计数上限」解决，不引入待领取队列）。

1. **默认是否开启**：建议「background 任务、无 `taskTimeoutMs`、无 `watch`」时默认 10 分钟提醒一次。
   理由：这正是「跑飞了没人管」的唯一形态；有 watch 或硬期限的任务已有兜底。
2. **重复策略**：只提醒一次等 agent 裁决 / 几何退避（10m→20m→40m，最多 3 次）/ 一直提醒。
   建议几何退避 + 上限 3，与 settle-guard 的 `maxReminders` 口径一致。
3. **提醒预算耗尽后是否杀**：建议**不杀**，只记 `unresolved` 并从提醒队列摘除——
   杀一个长构建是最坏结果；进程生命周期仍只由 `taskTimeoutMs` / `async_kill` 决定。
4. **是否尊重 `notifyOnCompletion: false`**：建议提醒走独立开关（或同一个 `notify*` 家族），
   但默认跟随——否则会出现「用户明确关掉通知却被提醒」。
5. **`PI_ASYNC_NUDGE=0` 是否一并关闭提醒**：建议关闭（它们同属「打扰面」）。
6. **提醒超时与 approve 语义**：如果 agent 期间没结束 turn，提醒会不会堆积？建议
   「同一任务同时只有一条未领取提醒」，未领取期间不重复布防。

## 5. 实现落点（预估，非最终）

| 文件 | 改动 |
|---|---|
| `src/core/task.ts` | `TaskSnapshot` 加 `remindAt?` / `remindCount?`；`RunOptions` 加 `remindAfterMs?` |
| `src/core/registry.ts` | `armReminder()` 仿 `armTaskTimeout`；reload 时按 `remindAt` 重布防（`:746` 同款逻辑） |
| `src/core/notify.ts` | 新增 `sendReminder()`，复用 claim/attempt 的幂等形状 |
| `src/tools/index.ts` | `remindAfterMs` 字段 + `async_extend` 注册 |
| `skills/async-tasks/SKILL.md` | 「提醒到了就裁决：续期或停」一条纪律 |
| `docs/CONTRACT.md` | 新节 §x + REV 记录；`KillKind` 是否新增 `reminder_exhausted` 待裁决 |

## 6. 已知冲突点

- **与 settle-guard 的双重提醒**：settle guard 在 turn 结束时提醒「你有任务没收」；
  reminder 在运行中提醒「这任务跑久了」。两者都可能在同一 turn 内出现。
  建议：reminder 只在**任务运行中**投递，settle guard 只在**settle 边界**投递，
  并在 settle 时把已投放的 reminder 计入 `remindCount`，避免连发。
- **与 watch 的重叠**：`watch.timeoutMs` 到期是 `failed` + `watch_timeout` + 杀进程组。
  一个任务同时有 watch 和 reminder 会让「同一个超时」有两种终态语义。
  建议：有 `watch` 时 reminder 不自动开启，需显式传 `remindAfterMs`。
- **与 sync 模式**：sync 的 `timeoutMs` 是「我等多久」，promote 后转 background。
  promote 那一刻应开始计算 `remindAfterMs`，而不是从最初 `createdAt` 起算。
