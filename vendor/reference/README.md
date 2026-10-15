# vendor/reference — 第三方参考代码（只读，不直接编译进产物）

按来源归档，许可证均允许借鉴。正式实现时以此为参考重写或按许可合入。

| 文件 | 来源 | 许可证 | 借鉴点 |
|---|---|---|---|
| `better-bg-conditions.ts` / `better-bg-types.ts` | pi-better-background-tasks 0.9.0 (MIT) | `src/conditions.ts` | watch 条件系统：5 种条件类型 + `validateCondition` 启动前校验 JSON path + 条件求值器 |
| `patty-output.ts` | pi-patty-bg-tasks 1.1.6 (MIT) | `src/output.ts` | O(tail) 文件读取（openSync+fstatSync 防竞态）、`readLastLine` ANSI/CSI/OSC 剥离（安全项：防输出注入转义序列）、`streamLog` 流式跟随 |
| `patty-notify.ts` | pi-patty-bg-tasks 1.1.6 (MIT) | `src/notify.ts` | 通知合并（turn 内累积 → agent_end flush 一条摘要）+ 异常 turn 兜底 drain；chatter 抑制的演化结论 |
| `patty-sleep-guard.ts` | pi-patty-bg-tasks 1.1.6 (MIT) | `src/lifecycle.ts` | 裸 `sleep N` 结构性检测与替代方案引导（`detectBlockedSleep`） |
| `legion-viz/canvas.ts` | pi-legion 2.0.x (MIT, github.com/zzjcool/pi-legion) | `src/tui/viz/canvas.ts` | 字符网格：宽字符安全、同色连续 cell 合并渲染、ellipsize |
| `legion-viz/palette.ts` | 同上 | `src/tui/viz/palette.ts` | role→token 延迟配色 + OKLab 色差撞色检测（0.025 阈值换 fallback token） |
| `legion-viz/model.ts` | 同上 | `src/tui/viz/model.ts` | VizNode 四态折叠（running/settled/failed/retired）+ 同名消歧 |
| `legion-viz/layout.ts` | 同上 | `src/tui/viz/layout.ts` | wide/stacked/portrait 响应式三档布局 |
| `legion-viz/panels.ts` | 同上 | `src/tui/viz/panels.ts` | `frame()` 焦点边框、chart/log/timing 面板骨架 |
