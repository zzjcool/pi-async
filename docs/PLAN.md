# pi-async 实施计划 v1

上游契约：`docs/CONTRACT.md` v1（FROZEN，2026-10-15）。D1–D10 与 §1–14 全部为冻结约束，
本计划只做拆分、排期、接口冻结与文件归属，**不重新设计**；计划与契约冲突时以契约为准并回报 lead。
调研事实（已确认，禁止重新侦察）：pi-background-tasks 通知机制/registry 参考、legion-viz（MIT）在
`vendor/reference/`、better-bg 条件系统、patty 通知/输出、pi 1.2.0 TUI API 形态。

---

## 0. 目标与不做的事

**目标**：按契约交付 pi-async v1 —— 任务注册表 + background/sync/delayed 三模式 + watch 条件引擎 +
完成唤醒链路 + settle 守卫/OSC 上报 + 主会话 TUI（轨道图/面板/footer）。

**Non-goals**（除契约 §0 刻意不做清单外，本计划额外声明）：
- 不改 `vendor/reference/`（只读参考）；不改 pi-legion / pi 本体（D8）。
- 各线 worker 不改 `package.json` / `extensions/index.ts`（Step 0 冻结后仅 Step I 收口改动）；需要依赖
  变更时报 lead，不自行加依赖。
- 本计划不做基线实测；一切验证归 worker verify 门禁（`npm run typecheck && npm test`）。

---

## 1. 三条并行线与文件归属（防冲突核心）

| 归属 | 文件 |
|---|---|
| **Step 0（串行基座）** | `package.json`、`tsconfig.json`、`extensions/index.ts`、`LICENSE`、`src/core/task.ts`（全量实装）、`src/core/output.ts`（`stripAnsi` 实装 + 其余 stub）、其余全部模块的 **compilable stub**：`src/core/{registry,spawn,watch,notify,bus}.ts`、`src/tools/index.ts`、`src/tui/{rail,panel,status}.ts`、`src/guard/settle-guard.ts`、`tests/task-state.test.ts`、`tests/helpers/` |
| **Line A（core）** | `src/core/{registry,spawn,output,notify,bus}.ts`、`src/tools/index.ts`、`src/guard/settle-guard.ts`、`tests/a-*.test.ts` |
| **Line B（modes）** | B1 独占 `src/core/watch.ts`、`tests/b-watch-*.test.ts`；**B2 增量独占** `src/core/registry.ts` + `src/tools/index.ts`（A 合并后移交）、`tests/b-*.test.ts` |
| **Line C（tui）** | `src/tui/{rail,panel,status}.ts`、`tests/c-*.test.ts` |
| **Step I（集成收尾）** | `extensions/index.ts`（API 名收口）、`README.md`、跨线 e2e 测试 |

**共享文件序列化规则**：
- `src/core/registry.ts`、`src/tools/index.ts`：Phase 1 归 Line A 独占；A 合并后 Phase 2 移交 Line B（B2）独占。**绝不并行持有**。
- `package.json`、`extensions/index.ts`、`tsconfig.json`：Step 0 定死后冻结，改动只走 Step I。
- `src/core/task.ts`：Step 0 全量实装后冻结（纯类型/状态词汇，全线只 import）；发现缺口报 lead 走契约修订，不自行改。

---

## 2. 冻结接口（worker 不得自行发明签名）

> `PiCtx` 为 peer 依赖 `@earendil-works/pi-coding-agent` 导出的扩展上下文类型的别名（Step 0 统一
> `import type` 路径，各线复用）。具体 hook/方法实名与安装版本有出入时，仅修正调用形态，不改语义（风险 R1）。

```ts
// ===== src/core/task.ts（Step 0 实装，全线共享词汇，之后冻结）=====
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "killed";
export type TaskMode = "background" | "sync" | "delayed";
export type KillKind = "user" | "timeout" | "output_cap" | "shutdown" | "watch_failure";
export const TERMINAL_STATUSES: readonly TaskStatus[];          // completed | failed | killed
export function isTerminal(s: TaskStatus): boolean;
export function deriveName(command: string): string;            // ≤48 chars（§3）

export type Condition =
  | { type: "exit_code"; equals: number }
  | { type: "stdout_contains"; value: string }
  | { type: "stderr_contains"; value: string }
  | { type: "json_path_exists"; path: string }                   // $.a.b[0]，启动前校验
  | { type: "output_matches"; regex: string };                    // 建议锚定（promptGuidelines）

export interface WatchSpec {
  intervalMs: number;                    // 默认 30_000，min 1_000
  timeoutMs: number;                     // watch 必填
  success_when: Condition[];
  failure_when: Condition[];
  blind_checks?: number;                 // 默认 3
}

export interface RunOptions {
  command: string; name?: string; mode?: TaskMode;
  delayMs?: number; timeoutMs?: number; onTimeout?: "promote" | "abort";
  taskTimeoutMs?: number; notifyOnCompletion?: boolean; triggerOnCompletion?: boolean;
  env?: Record<string, string>; watch?: WatchSpec;
}
export interface RunReceipt { taskId: string; name: string; status: TaskStatus; mode: TaskMode; outputHint: string; }
export interface SyncResult extends RunReceipt { exitCode?: number; outputTail: string; promoted: boolean; }

export type WaitOutcome =
  | { results: Array<{ taskId: string; status: TaskStatus; exitCode?: number; outputTail: string }> }
  | { notReady: Array<{ taskId: string; status: "running" | "pending"; elapsedMs: number }> };

export interface TaskSnapshot {
  taskId: string; name: string; command: string; mode: TaskMode; status: TaskStatus;
  pid?: number; exitCode?: number; killKind?: KillKind; failureKind?: "lost";
  createdAt: number; startedAt?: number; finishedAt?: number; dueAt?: number;   // dueAt: delayed
  taskTimeoutMs?: number; notified: boolean; outputConsumed: boolean;
  watch?: WatchSpec; metadata: Record<string, unknown>;   // notified 闩持久化于此（§2）
}
```

```ts
// ===== src/core/output.ts（stripAnsi 由 Step 0 实装；REV-3：Line A 保留 spawn 流式输出捕获，不导出 OutputCapture）=====
export function stripAnsi(text: string): string;                 // ANSI/CSI/OSC 全剥离（§9 安全项）
```

```ts
// ===== src/core/spawn.ts（Line A）=====
export interface SpawnHandle { pid: number; exit: Promise<{ code: number }>; }
export function spawnDetached(command: string, opts: { outputFile: string; env?: Record<string, string> }): SpawnHandle;
export async function killTree(pid: number, opts?: { graceMs?: number }): Promise<{ confirmed: boolean }>;
// §10：SIGTERM → 3s grace → 组 SIGKILL → 有界探测；confirmed=false 时调用方响亮报错泄漏
```

```ts
// ===== src/core/registry.ts（Line A 主体；B2 增量实装 delayed/sync/watch 接线）=====
export interface RegistryEvents {
  onFinalize(snapshot: TaskSnapshot): void;     // 终态一次性广播；waiter 在此 resolve（事件驱动，禁 sleep 轮询）
  onStateChange(snapshot: TaskSnapshot): void;  // TUI 刷新 / OSC raise-clear
}
export interface RegistryConfig { dataDir: string; maxTasks?: number; maxOutputBytes?: number; }
export class TaskRegistry {
  constructor(config: RegistryConfig);
  setEvents(events: RegistryEvents): void;
  submit(opts: RunOptions): TaskSnapshot;                       // background：立即 spawn
  scheduleDelayed(opts: RunOptions, delayMs: number): TaskSnapshot;   // B2 实装（A 阶段 stub throw）
  runSync(opts: RunOptions, timeoutMs: number, onTimeout: "promote" | "abort",
          signal?: AbortSignal): Promise<SyncResult>;            // B2 实装（A 阶段 stub throw）
  attachWatch(taskId: string, spec: WatchSpec): void;            // B2 实装：挂 WatchLoop，终态自动 stop
  markWatchSuccess(taskId: string, detail: string): void;        // D4：不杀进程，标 completed
  get(taskId: string): TaskSnapshot | undefined;
  list(opts?: { includeHistory?: boolean }): TaskSnapshot[];
  wait(taskIds: string[], timeoutMs: number, signal?: AbortSignal): Promise<WaitOutcome>;
  logs(taskId: string, opts: { maxBytes?: number; tail?: boolean }):
    { text: string; truncated: boolean; fullPath: string };       // 返回前 stripAnsi（§9）
  kill(taskId: string, kind: KillKind): Promise<void>;
  cancel(taskId: string): boolean;                               // delayed pending → killed(kind=user)
  consume(taskId: string): void;                                 // outputConsumed 闩（§5）
  activeCount(): { running: number; pending: number };
  hasActiveWork(): boolean;
  shutdown(): Promise<void>;                                     // 幂等：admission close + drain + kill(shutdown)
  reloadFromDisk(): Promise<void>;                               // running&pid 死→failed(lost)；delayed 恢复计时（D9）
}
```

```ts
// ===== src/core/notify.ts（Line A）=====
export interface NotifyPayload {
  taskId: string; name: string; status: TaskStatus; exitCode?: number;
  outputFile: string; summary?: string; guidance?: string;   // guidance 仅 failed（D5）
}
export function buildNotificationXml(p: NotifyPayload): string;   // <async-task-notification> + guidance 等字段
export async function sendCompletionNotification(
  pi: PiCtx, registry: TaskRegistry, p: NotifyPayload
): Promise<boolean>;  // sendMessage({customType:"async-task-notification"},{deliverAs:"followUp",triggerTurn:true})；
                      // notified 闩单次投递；失败回滚闩重试 ≤3；outputConsumed 闩抑制（§5/D5）
```

```ts
// ===== src/core/bus.ts（Line A）=====
export function reportActivity(pi: PiCtx, active: { running: number; pending: number }): void;
// ui.setActivity("pi-async", {message}) feature-detect；全清传 undefined；禁 printf OSC；尊重 PI_PROGRAM_STATUS
// 上报时机：任务启动、终态、agent_before_settle（§7，闭合 retire 竞态）
```

```ts
// ===== src/guard/settle-guard.ts（Line A，§7/D10）=====
export class SettleGuard {
  constructor(pi: PiCtx, registry: TaskRegistry,
             opts?: { maxReminders?: number /* 默认 3 */; heartbeatMs?: number /* 默认 60_000 */ });
  register(): void;      // 挂 agent_before_settle hook + session_shutdown 摘除 + 心跳 appendEntry
}
// 行为：未终态任务存在 → appendEntry 提醒（taskId 列表 + async_wait 引导）+ continue:true；
// 每 run 重新武装；累计 ≤3 次后放行但 verdict 提示保留未决清单。
```

```ts
// ===== src/tools/index.ts（Line A 注册 5 工具；B2 补 mode/watch 分发）=====
export function registerTools(pi: PiCtx, registry: TaskRegistry): void;
// async_run | async_wait | async_logs | async_status | async_kill
// schema enforce：sync.timeoutMs 必填；async_wait.timeoutMs 必填；watch.timeoutMs 必填、intervalMs≥1000；
// async_logs.maxBytes ≤ 50KiB；MAX_TASKS 超限拒绝（§11）。
// promptGuidelines 按 §4 写进 async_run description（check 不 ||true、regex 锚定、jq -e、未知态→失败）。
```

```ts
// ===== src/core/watch.ts（Line B）=====
export function validateWatchSpec(spec: WatchSpec): { ok: true } | { ok: false; error: string };
// regex 编译、json path 语法、intervalMs/timeoutMs 边界，启动前拒绝（不产生 pending 任务）
export function evalConditions(conds: Condition[], ctx: { output: string; exitCode?: number }): boolean;
export interface WatchLoopDeps {
  taskId: string; spec: WatchSpec;
  readOutput: () => string; getExitCode: () => number | undefined;
  onSuccess: (detail: string) => void;      // → registry.markWatchSuccess
  onFailure: () => void;                    // → registry.kill(taskId, "watch_failure")
  onBlindExhausted: () => void;             // blind_checks 连续无法求值 → failed
  onWatchTimeout: () => void;               // watch.timeoutMs 到期
}
export class WatchLoop {
  constructor(deps: WatchLoopDeps);
  start(): void; stop(): void;
}
```

```ts
// ===== src/tui/*（Line C；所有入口自检 pi.mode === "tui"，D6；custom() 返回 undefined 即 return）=====
// rail.ts（REV-1 修订：渲染纯函数与可交互 widget 工厂拆开，事件与注册归 registerRail）
export function renderRailRows(snapshots: TaskSnapshot[], width: number): string[];
// 纯渲染：每行 '▶ name · state · elapsed'；≤10 行；空闲返回 []（单测锚点）
export interface RailWidget {
  render: (width?: number) => string[];
  handleMouse: (event: TuiMouseEvent) => { handled: boolean } | undefined;  // wheel 滚动；press→latch→click 同任务才触发 onOpenTask
  dispose?: () => void;
}
export function createRailFactory(pi: PiCtx, registry: TaskRegistry,
  opts: { onOpenTask?: (taskId: string) => void }): (tui: Tui, theme: Theme) => RailWidget;
export function registerRail(pi: PiCtx, registry: TaskRegistry): void;
// setWidget("pi-async-rail", createRailFactory(...), {placement:"aboveEditor"}) 的唯一调用点；
// 工厂捕获 tui/theme（legion status.ts 同款），dispose 清 ticker
// status.ts
export function initStatus(pi: PiCtx, registry: TaskRegistry): void;
// setStatus("pi-async", " N running · M done ") + 经 bus.reportActivity 上报
// panel.ts
export function registerPanelCommands(pi: PiCtx, registry: TaskRegistry): void;
// /async、/async-clear、Ctrl+Alt+A（registerShortcut 冲突→回退 /async，不硬抢）
export function openPanel(pi: PiCtx, registry: TaskRegistry, initialTaskId?: string): void;
// ctx.ui.custom({overlay:true, overlayOptions:{width:"100%",maxHeight:"100%",anchor:"top-left",row:0,col:0}})
// 自绘 mask+frame（改造 vendor/reference/legion-viz，保留 MIT attribution 注释，§12）
```

```ts
// ===== extensions/index.ts（Step 0 骨架，唯一扩展入口；实例 API 名以安装 typings 为准）=====
export async function init(pi: PiCtx): Promise<void> {
  const registry = new TaskRegistry({ dataDir: /* .pi/async/<session-id>-<pid> 解析 */ });
  await registry.reloadFromDisk();
  registry.setEvents({ onFinalize: /* notify + OSC clear */, onStateChange: /* TUI/OSC */ });
  registerTools(pi, registry);
  if (pi.mode === "tui") { initStatus(pi, registry); /* setWidget rail */ registerPanelCommands(pi, registry); }
  new SettleGuard(pi, registry).register();
  pi.on("session_shutdown", () => registry.shutdown());
}
```

---

## 3. 步骤拆分

### Step 0 — 脚手架基座（串行，必须最先合）
- **文件清单**：§1 表格 Step 0 行全量。要点：
  - `package.json`：`name: pi-async`、`type: module`、keywords 含 `pi-package/pi-extension`；
    `scripts.typecheck = "tsc --noEmit"`、`scripts.test`（node:test 跑 TS 的 runner 配置在此一次定死，
    Node ≥22.19 可用 type stripping，后续线**不得改 test script**）；
    peerDependencies：`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`（不进 dependencies，§12）。
  - 全部 stub 文件导出 §2 冻结签名，body 为 `throw new Error("pi-async: not implemented (<line>)")`，
    保证任意线在只有 Step 0 的 worktree 里 typecheck 通过。
  - `task.ts` 与 `stripAnsi` **全量实装**（纯函数、零依赖），供三线共享与单测。
  - `tests/helpers/`：`makeSnapshot()` 等纯数据构造器（C 线 fake registry 快照流用）。
- **依赖**：无。
- **验收**：`npm run typecheck` && `npm test`（`tests/task-state.test.ts`：isTerminal/deriveName/TERMINAL_STATUSES）。
- **任务卡要点**：单 worker，`worktree: false`（直接父 checkout，最快合入主线）；verify:
  `["npm run typecheck", "npm test"]`；禁止 import `vendor/reference`；禁止越过 §2 发明签名。

### Line A — core（registry + tools + settle 守卫 + OSC，§7 归此线）
**A1 进程与输出**（`spawn.ts` + `output.ts` 的 OutputCapture）
- 文件：`src/core/spawn.ts`、`src/core/output.ts`（替换 stub body）、
  `tests/a-output-cap.test.ts`、`tests/a-strip-ansi.test.ts`、`tests/a-kill-tree.test.ts`。
- 验收：cap 测试用小 capBytes 仿 20MiB 边界（不真写 20MiB）；kill-tree 用 `bash -c 'sleep 5 & sleep 5'`
  验证进程组全灭无残留 + grace 升级链 + confirmed=false 报错文案；strip-ansi 覆盖 ESC/CSI/OSC 注入样本（§14-7）。
- verify：`["npm run typecheck", "npm test"]`。

**A2 注册表与通知**（`registry.ts` + `notify.ts` + `bus.ts`）
- 文件：`src/core/registry.ts`、`src/core/notify.ts`、`src/core/bus.ts`、
  `tests/a-registry-background.test.ts`、`tests/a-notify-latch.test.ts`、`tests/a-bus.test.ts`。
- 要点：事件驱动 waiter（onFinalize resolve，**禁 setTimeout 轮询**，patty 教训）；notified/outputConsumed
  双闩；metadata 原子写；MAX_TASKS admission；reloadFromDisk（pid 死→failed(lost)）；shutdown 幂等 drain；
  taskTimeoutMs 寿命；delayed/sync/watch 相关方法保持 stub throw（B2 接管）。
- 验收：mock sendMessage 计数验证闩/重试≤3/回滚；`PI_PROGRAM_STATUS` 与 setActivity 缺失时静默降级。
- 依赖：A1（OutputCapture/spawn）。verify：`["npm run typecheck", "npm test"]`。

**A3 工具面 + settle 守卫**（`tools/index.ts` + `guard/settle-guard.ts`）
- 文件：`src/tools/index.ts`、`src/guard/settle-guard.ts`、
  `tests/a-tools-schema.test.ts`、`tests/a-settle-guard.test.ts`。
- 要点：5 工具 schema（§3/§4/§5 全部 enforce 项 + promptGuidelines 文案）；async_run 在本阶段仅放行
  `mode=background`，delayed/sync 返回 `"not implemented (line B)"` —— **这是全计划唯一允许的临时 stub，B2 消灭**；
  settle 守卫：每 run 重武装、≤3 次、超限放行保留未决清单（D10）、60s 心跳 appendEntry、
  `PI_LEGION_NODE_ID` 检测默认开启（§6）；OSC 上报时机含 before_settle（§7）。
- 依赖：A2。验收：schema 负例（缺 timeoutMs、超 MAX_TASKS）；守卫 3 次放行序列。
- verify：`["npm run typecheck", "npm test"]`。
- A1→A2→A3 同一 worker 顺序推进；外部仅依赖 Step 0。

### Line B — watch + delayed + sync 模式
**B1 watch 条件引擎**（与 A/C 并行，零共享文件）
- 文件：`src/core/watch.ts`（全量实装）、`tests/b-watch-conditions.test.ts`、
  `tests/b-watch-validate.test.ts`、`tests/b-watch-loop.test.ts`。
- 要点：5 种 Condition 求值（含 `$.a.b[0]` 解析、`output_matches` regex）；validateWatchSpec 启动前拒绝
  非法 regex/jsonpath/边界；WatchLoop 四路径（success 不杀进程 D4 / failure→watch_failure / blind / timeout），
  interval 用可注入时钟或 1s 实测短间隔。
- 依赖：仅 Step 0（用 `tests/helpers` fake deps，不触碰 registry/tools）。
- verify：`["npm run typecheck", "npm test"]`。

**B2 delayed + sync + watch 接线**（串行：A 合并后，`registry.ts`/`tools/index.ts` 移交 B 独占）
- 文件：`src/core/registry.ts`、`src/tools/index.ts`（增量）、`src/core/watch.ts`（如需接线缝微调）、
  `tests/b-delayed.test.ts`、`tests/b-sync-mode.test.ts`、`tests/b-watch-integration.test.ts`。
- 要点：delayed（dueAt 持久化、pending 期 cancel→killed(user)、reload 恢复计时 D9）；sync（timeoutMs
  enforce、到点 promote 任务存活 / abort、返回 exitCode + outputTail ≤8KiB/200 行）；async_run 移除
  background-only stub，mode 分发 + watch 参数（仅 background/delayed）→ attachWatch，WatchLoop 随终态 stop。
- 依赖：A 已合并 + B1。验收对应 §14-3/4/5 全部断言。
- verify：`["npm run typecheck", "npm test"]`。

### Line C — TUI（与 A/B1 并行）
**C1 轨道图 + footer + 全屏面板**
- 文件：`src/tui/rail.ts`、`src/tui/status.ts`、`src/tui/panel.ts`、
  `tests/c-rail-render.test.ts`、`tests/c-panel-keys.test.ts`、`tests/c-status-format.test.ts`。
- 要点：§8 全部冻结项——rail ≤10 行（单测断言行数）、空闲不渲染、palette 延迟解析+OKLab 撞色回退、
  press→latch→click、wheel；footer 格式串；面板 overlay 参数冻结值、自绘 mask+frame（改造 legion-viz，
  **保留 MIT attribution 注释**）、h 历史切换、详情+tail（128KiB UI 缓冲/12 行跟随/上滚暂停）、k/R/c/Esc、
  running 最新输出行 pill（复用 `core/output.stripAnsi`）；所有入口 `pi.mode === "tui"` guard +
  `custom()` 返回 undefined 兜底（D6）；shortcut 冲突回退 `/async`。
- 依赖：仅 Step 0（fake snapshot 流驱动渲染单测）；真 registry 联动留给 Step I。
- verify：`["npm run typecheck", "npm test"]`。

### Step I — 集成收尾（B2 与 C 合并后，lead 或单 worker）
- 文件：`extensions/index.ts`（hook/方法实名收口，R1 落地点）、`README.md`、`tests/i-e2e.test.ts`。
- 要点：跨线 e2e（§14-2/3/4/5/6/9 用真 registry + 子进程）；`pi --print` 收 `<async-task-notification>`
  实测属 worker verify 门禁；§14-10 TUI 人工 checklist 整理交用户；清理全部 `not implemented` 残留断言为 0。

---

## 4. 集成顺序与合并计划

```
Step 0 ──► (A ∥ B1 ∥ C 并行开发) ──► merge A ──► B2（registry/tools 独占移交 B）──► merge B ──► merge C ──► Step I
```

- **Step 0 必须最先合**：所有线从含 stub 的基座分支，typecheck 恒绿。
- **A 先于 B2**：`registry.ts`/`tools/index.ts` 两阶段独占（A→B2），绝不并行持有。
- **C 的文件与 A/B 完全不相交**，A 合并后任意时刻可合（若 C 先于 B2 完成，可提前合入，无冲突）；
  计划默认排在 B2 后，减少 e2e 反复。
- 冲突风险点：B2 与 A 在 `registry.ts` 的增量冲突（靠独占规则消除）；各线对 `extensions/index.ts`
  的私自修改（靠冻结规则消除，violation 即 reject）；`package.json` 依赖私加（同上）。
- MR 由主 agent 统一合回默认分支；reviewer 任务卡必须附 D1–D10 与「临时 stub 清单」（A3 的
  background-only stub 是唯一合法临时项，B2 前不判缺失）。

## 5. 文档更新

| 步骤 | 文档项 |
|---|---|
| Step 0 | `LICENSE`（MIT）；package.json keywords（pi-package/pi-extension） |
| Line A | 无（工具 description 内含 promptGuidelines，随代码走） |
| Line C | 复用 legion-viz 的文件内 attribution 注释（§12） |
| Step I | `README.md`：安装/启用方式、5 工具与 2 命令（/async、/async-clear）与键位、§11 环境变量表、legion child 下 async_wait 收割义务（§6）、已知限制（不承诺 crash-durability、busy-hold 依赖上游 #156） |

## 6. 风险与回滚点

1. **pi 1.2.0 API 实名与冻结 wiring 有出入**（hook 注册方式、setWidget options、custom 返回值、
   session id/pid 字段）：不重新设计，worker 对照安装的 typings 与官方扩展源码修正调用形态，语义不变；
   涉及 `extensions/index.ts` 的改动统一在 Step I 收口。回滚点：每线独立 MR，API 修正失败只 block 该线。
2. **共享文件独占被违反**（B2 提前动 registry / 两线并行改同一文件）：reviewer 把越界改动判 reject，
   回滚该 MR 重派；合并顺序 0→A→B2→C→I 不因个别线延期而重排，只顺延。
3. **事件驱动 wait 退化成轮询**（patty 教训）：reviewer 专项检查 `setTimeout` 轮询模式；
   `a-registry-background.test.ts` 断言 waiter 由 finalize 精确 resolve。node:test 跑 TS 的 runner
   配置若在 Step 0 失败，允许 Step 0 worker 换等价 runner（如 tsx）**一次定死**，之后禁改（避免
   package.json 多线冲突）。

## 7. 验收标准（机器可查 + §14 映射）

- 全局门禁：`npm run typecheck` && `npm test` 全绿；仓库内 `grep -r "not implemented" src/` 为空（Step I 后）。
- §14 映射：1→各线 verify；2→`i-e2e` + worker `pi --print` 实测；3→`b-sync-mode.test.ts`；
  4→`b-delayed.test.ts`；5→`b-watch-integration.test.ts` + `b-watch-validate.test.ts`；
  6→`a-registry-background.test.ts`（wait 多任务/notReady/AbortSignal）；7→`a-strip-ansi.test.ts`；
  8→`a-kill-tree.test.ts` + `a-output-cap.test.ts`；9→`a-settle-guard.test.ts`；10→人工 checklist（Step I 交付）。

---

## 8. 修订记录

| 日期 | REV | 内容 | 触发 |
|---|---|---|---|
| 2026-10-15 | REV-1 | §2 rail.ts 接口拆分：原 `createRailFactory(registry): (width)=>string[]` 纯渲染函数无法承载 CONTRACT §8 的 wheel/press→latch→click 交互与 setWidget 注册。修订为：`renderRailRows`（纯渲染，单测锚点，不变）+ `createRailFactory(pi, registry, {onOpenTask}): (tui, theme) => RailWidget {render, handleMouse, dispose}` + `registerRail`（setWidget 唯一调用点，工厂捕获 tui/theme，legion status.ts 同款模式）。TuiMouseEvent/Theme/TUI 类型自 peer `@earendil-works/pi-tui` import type。C 线 c-rail-render.test.ts 锚 renderRailRows 纯函数；新增 c-rail-mouse.test.ts 测 press→latch→click/wheel。 | worker-C 按契约正确拒绝（PLAN §2 与 CONTRACT §8 矛盾） |
| 2026-10-15 | REV-2 | CONTRACT §4 blind_checks 语义澄清：仅「检查基础设施失败」（readOutput 报错等）计入 blind 累计；「尚未可判定」（exit_code 未退出、json_path_exists 输出尚非 JSON）为 pending 态，不累计、照常轮询。原实现两者合并导致 default 参数下 watch >90s 的健康任务被误判 failed（reviewer 探针验证）。WatchLoop 求值增加三态：matched / pending / error；仅 error 计 blind。 | reviewer-b1 major finding（探针验证） |
| 2026-10-15 | REV-3 | §2 output.ts 接口修订：实际输出上限由 `spawn.ts` 的流式 stdout/stderr 捕获与进程组终止实现；删除未被使用的 `OutputCapture` 类，`output.ts` 仅提供 `stripAnsi`。 | reviewer-A F6（死代码/双实现） |
| 2026-10-15 | REV-4 | CONTRACT §4 增补（B2 reviewer critical F1 裁决）：watch 三条失败路径（failure_when 命中 / blind 耗尽 / watch timeout）finalize 时必须同步 kill 进程组；仅 success_when（D4）留活。消灭「终态任务+活进程」导致的 async_kill 静默 no-op 与 shutdown 永久挂起（探针验证 sleep infinity 场景宿主退不出）。 | reviewer-B2 critical F1（探针验证） |
| 2026-10-15 | REV-5 | CONTRACT §10 reload 语义收窄（终审 F3 裁决）：reload 恢复仅限同进程存活期内的 /reload；跨 pid 崩溃遗留目录只读留档不恢复（与 v1 不承诺 crash-durability 一致）。另：终审 F1 裁决 triggerOnCompletion:false 走 deliverAs:followUp 不带 triggerTurn（回补 §3 断链）；F2 裁决 panel.ts 实装 PI_ASYNC_DOCK_SHORTCUT（保留 try/catch 回退 /async）。 | reviewer-final 终审 3 major |
