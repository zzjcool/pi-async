# pi-async 插件方案汇总报告

日期：2026-10-15 | 仓库：/root/code/pi-async | 状态：设计冻结前的调研汇总

## 0. 背景问题

pi-legion 的 subagent（RPC 子进程）使用异步任务插件（如 pi-background-tasks）时：
child 把任务 `bg_run` 交出去后结束 turn → legion 只看 session JSONL 最后 assistant 的
stopReason（`shared/session.ts:616-660`）→ 判 success → **retire（SIGTERM→SIGKILL 整棵子树）**
→ 后台任务和它的完成通知一起被杀。

## 1. 调研结论汇总（4 路侦察）

### 1.1 竞品能力矩阵

| 能力 | pi-background-tasks 2.6.10 (ISC) | pi-patty 1.1.6 (MIT) | pi-better-bg 0.9.0 (MIT) | doompi α (MIT) | 我们计划 | 判定 |
|---|---|---|---|---|---|---|
| 延迟执行 | ❌ | ❌ | ❌ | ❌ | ✅ | 全空白，最强差异化 |
| 同步阻塞 launch（必传 timeout） | ❌ "never blocks" | ❌ | 🟡 仅首 check 15s | ❌ | ✅ | 空白；需配「超时转后台」逃生口 |
| 轮询+输出匹配 | ❌ | 🟡 monitor 逐行流 | ✅ bg_task_watch | ❌ | ✅ | 现成可借鉴（better-bg） |
| TUI 面板+点击 | 🟡 最全，键盘 | 🟡 select/editor | 🟡 navigator | 🟡 全屏+真 PTY attach | ✅ 鼠标 | 键盘版现成；鼠标全生态仅 legion 实战 |
| 显式 async_wait | 🟡 隐式唤醒 | 🟡 刻意不唤醒 | 🟡 batcher | 🟡 反例 | ✅ | 空白 |

### 1.2 pi 1.2.0 TUI 能力（已验证）

- 鼠标：仅 fullscreen 模式（默认）派发 `TuiMouseEvent`（press/click/wheel/clickCount）到组件
  `handleMouse`；regular 模式无鼠标。
- `ctx.ui.custom({overlay:true, overlayOptions})` 支持全屏浮层（width:"100%", row:0, col:0 +
  自绘 mask/hit-test，legion live-overlay 模式）。
- 官方公开导出：`UserMessageComponent/AssistantMessageComponent/ToolExecutionComponent/
  getMarkdownTheme/Markdown` 等，可直接 import（legion 已冻结构造签名实测 1.1.0）。
- widget（`setWidget` 工厂）上限 10 行；`setStatus` 单行；`registerShortcut` 有保留键位表。
- ⚠️ RPC 模式（所有 legion subagent）：`custom()` → undefined，setWidget 工厂被丢弃，
  **TUI 只能活在主会话**；guard 必须用 `ctx.mode === "tui"`（`hasUI` 在 RPC 也是 true，知名陷阱）。

### 1.3 可借鉴资产（已归档 vendor/reference/，许可证全部宽松）

- better-bg `conditions.ts`（98 行）：5 种 watch 条件 + validateCondition 启动前校验 + blind_checks
- patty `output.ts`：O(tail) 读取（openSync+fstatSync）、ANSI/CSI/OSC 剥离（防输出注入，安全项）、流式跟随
- patty `notify.ts`：通知合并 + 兜底 drain；chatter 抑制两版演化的结论
- patty `lifecycle.ts`：裸 sleep 检测与替代引导
- legion `viz/`：canvas 字符网格、palette OKLab 撞色检测、model 四态折叠、layout 响应式分栏、panels frame
- pi-background-tasks 工程机制（未拷源码，ISC，思路借鉴）：admission 30s 预检 + shutdown drain、
  writeJsonAtomic + metadataWriteChain、进程组 SIGTERM→SIGKILL 升级链、notified 单次投递闩

## 2. OSC 7501（issue #156）分析

issue：zzjcool/pi-legion#156 "OSC 7501: full async-busy chain (root + children + plugin contract)"
（含两则 Archer 接线锁评论，第二则作废第一则）。

### 2.1 Issue 核心内容

- **目标**：有任何 live 子工作（legion child / 子侧异步 / 插件报 busy）时，根 OSC 不得提前
  idle/done；外部观察者（终端/Herdr/看板）不误判。
- **Pi 侧**（上游 PR，本波必做）：`ui.setActivity(source, activity|undefined)`（对齐既有 setBlocked）；
  `ProgramStatusReporter.activities: Map<source,…>`；优先级 `blocked > compacting > (runActive ||
  activities.size>0 → working) > resting`；**层级 id**（`id=legion/<slug>`、`plugin/<name>/…`）多记录序列；
  禁止扩展自己 printf OSC。
- **legion 侧**：`emitBusy` 双写 `setActivity`；每 live child 写 `id=legion/<slug>`；**子内再挂异步经
  RPC 转发 `extension_activity`（raise/clear+source）到父**（「仅靠 agent_settled→awaiting 会漏
  busy」）；**禁止解析子 PTY OSC 字节**。
- **插件契约**（实现可另仓，契约在 issue）：① 有未完成异步 → setActivity/子 id working；② 结束 →
  clear；③ 不抢写根；④ 尊重 `PI_PROGRAM_STATUS` / 7501 `?` 握手。

### 2.2 现状核实（本机 pi 1.2.0 dist）

- `ProgramStatusReporter` **已有** `setBlocked(source, status)`（dialog blocked 语义）。
- **没有** `setActivity`、没有 `activities` Map、没有层级 `id`/多记录 emit——全部待上游 PR。
- OSC 7501 是**出口协议**（写给终端的转义序列），消费方是外部观察者；Pi 明确禁止插件抢写。

### 2.3 「OSC 7501 能否完美解决阻塞问题」——结论：不能单独解决，但是正确的配套契约

分层看 OSC 7501 解决什么、不解决什么：

| 层 | OSC 7501 (#156) 是否解决 | 说明 |
|---|---|---|
| 外部观察误判（终端/Herdr 看到 idle 以为完成） | ✅ 直接解决 | 这就是 issue 的主目标 |
| legion retire 误杀 child | ⚠️ 间接提供信号，不自动解决 | retire 决策在 legion `watch()` 内部（runtime.ts:949），issue 范围只到「根保 working」+RPC 转发 busy 信号；**用这个信号阻止 retire 仍需 legion 侧新逻辑**（本质就是我们讨论过的「约定+hold」方案，#156 把它标准化了） |
| 竞态（child settle 与 busy raise 的先后） | ❌ 未覆盖 | busy 信号经 RPC 扇入父进程，仍可能晚于 watch() finally 的 retire |
| 上游依赖 | ❌ 今天不可用 | pi 1.2.0 无 setActivity/层级 id，需先落 Pi PR + legion 版本 |
| 主会话内跨 turn 唤醒 | 与之无关 | sendMessage(triggerTurn) 已可用（bg_run 同款） |

**关键判断**：#156 的「插件契约」与我们 pi-async 的设计**天然互补、不冲突**——
- OSC 7501 = **信号/契约层**（busy 上报、状态聚合、外部可见性）
- pi-async = **任务运行时层**（注册表、wait 原语、TUI、调度）

我们的插件按 #156 契约实现 busy 上报后：上游落地 → 跨 turn 异步对 legion「自然正确」；
上游未落地/旧版本 → async_wait 阻塞模式仍然兜底。两条腿都要。

## 3. pi-async 插件最终形态（综合设计）

### 3.1 任务模式（四种）

1. **delayed**（差异化）：`delayMs` 后启动。语义决策点：跨 reload/重启是否仍生效
   （借鉴 better-bg session 归属：reload 恢复、切 session 暂停、恢复补执行逾期 deadline）。
2. **sync 阻塞**（差异化）：launch 即阻塞至完成，**timeout 必传**；超时可配置自动转
   background（patty 逃生口）而非报错；Esc/abort 中断等待但不中断任务（better-bg 首检窗口模式）。
3. **background + watch**：启动即返回 + 轮询/输出匹配等待（照抄 better-bg 条件系统 +
   blind_checks + check 编写反模式作 promptGuidelines；patty monitor 逐行事件流作补充）。
4. **事件驱动 async_wait**（差异化原语）：等待任意任务终态，事件驱动非轮询，返回 typed not-ready；
   必须配 outputConsumed/notified 抑制闩（patty chatter 教训）。

### 3.2 legion 兼容（hold 机制）

- 双模式：检测 legion env（PI_LEGION_NODE_ID 等）→ child 内默认 **hold 模式**（async_wait 阻塞、
  settle 守卫提醒收割）；主会话 wake 模式（triggerTurn 唤醒）。
- settle 守卫（agent_before_settle + continue:true，每 run 重新武装，≤3 次防死循环）。
- 心跳 appendEntry 触发 legion `collectArtifactGrowing` 宽限续期；任务 deadline 防 child 被无限续命。

### 3.3 TUI（主会话，fullscreen）

- 任务轨道图 widget（借鉴 legion railway：时间轴 axisColumn、lane 分配、四态折叠、OKLab 配色、
  press→latch→click 命中）+ footer `setStatus` 摘要。
- 全屏面板（Ctrl+Alt+A / `/async`）：任务列表 → 点击/Enter 详情（输出 tail 跟随、metadata、kill、
  rerun；借鉴 bg-tasks 管理器键位 + doompi PTY attach 思路）。
- 全部 TUI 路径 `ctx.mode === "tui"` guard；subagent 内自动退化为纯工具面。

### 3.4 OSC 7501 契约对齐（#156 插件契约四条）

1. 有未完成异步 → `ui.setActivity("pi-async", {message})`（feature-detect，无 API 则跳过）+ 每任务
   `id=plugin/pi-async/<task-id>` working。
2. 终态/取消/错误 → setActivity clear + id clear；notified 闩防重复。
3. 不 printf OSC、不抢写根记录。
4. 支持 `PI_PROGRAM_STATUS` / 7501 `?` 握手语义（跟随 Pi reporter，自身不直接握手）。
   RPC 模式下 setActivity 依赖 legion 的 extension_activity 转发（#156 落地后生效）。

### 3.5 工程机制

- durable registry：`.pi/async/<session-id>-<pid>/<task-id>.{output,json}`，writeJsonAtomic，
  metadataWriteChain 串行化，notified 持久闩。
- 输出安全：patty ANSI 剥离；输出预算 bytes/lines 双限 + 截断提示 + 超限可杀。
- kill：进程组 SIGTERM→grace→SIGKILL，无法证明死亡响亮报错。
- admission 30s 预检 + shutdown drain；SynchronousActivationCloseFence。

## 4. 风险与开放问题

1. **上游依赖时间线**：setActivity/层级 id 在 pi 未落地前，busy 上报静默降级；legion 的
   extension_activity 转发落地前，child busy 信号到不了父——此期间 async_wait 是唯一可靠机制。
2. **retire 竞态**：即使 #156 全落地，watch() finally 的 retire 与 busy 信号到达仍是竞态，
   legion 侧最终仍需「busy 时 hold」决策逻辑（可推动 legion 按同一契约实现，或我们 fork）。
3. **delayed 任务的持久语义**（无先例，需自定）：建议 reload 恢复 + 切 session 暂停 + 恢复补执行。
4. **watch 条件反模式**：check 不能 `|| true` 自吞、未知态映射失败、优先 jq -e 结构化。
5. TUI 鼠标在 widget 内的边界（窄屏/截断）需实测；message renderer 是否收到 handleMouse 待验证。
6. node_modules 升级覆盖：legion 改动一律走 fork/上游 PR，不改本机安装。

## 5. 建议路线

1. 冻结契约文档（工具 schema、状态机、#156 对齐、文件布局）→ planner 拆三条并行线
   （core registry+tools / TUI / watch+delayed）→ worker 实现 → reviewer 门禁。
2. 同步推动上游：pi 的 setActivity + 层级 id PR（#156 已锁方案）、legion 的
   extension_activity 转发 + busy-hold。
3. vendor/reference 只作参考，实现时按许可重写；legion viz 若整块复用需保留 MIT attribution。
