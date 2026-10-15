# Issue: 任务详情页 Esc 返回失效，无法退回任务列表

## 现象（用户报告）

在 pi-async 任务面板中选中任务按 `Enter` 进入详情页后：

- 按 `Esc` 无法返回任务列表；
- 整个面板无法正常退出/返回，用户被"困"在详情视图中。

## 环境

- 版本：d4fd482（Fix TUI never registering）
- 面板入口：`Ctrl+Alt+A` / `/async`

## 根因分析（已定位到 `src/tui/panel.ts`）

`handleInput` 对 Esc 的处理只匹配**裸 Esc 字节序列** `\u001b`（panel.ts:153）：

```ts
if (data === "\u001b") { if (detail) { detail = false; ... } else done(undefined); return; }
```

但终端中 Esc 往往不是单独发送的。pi 1.2.0 的 TUI keybinding 管线（keybindings/normal mode）通常会拦截/改写按键事件，custom overlay 的 `handleInput(data)` 收到的 `data` 可能是：

1. **带修饰/转义的序列**，例如 Kitty keyboard protocol 下的 `\u001b[27u` / `ctrl+\u001b` 等编码，`data === "\u001b"` 严格相等不成立；
2. 若用户按的是 `Alt` 系组合或终端开启了增强键盘协议，同样不会匹配裸 `\u001b`。

此外详情页顶部还有一层更常见的卡死路径：

- panel.ts:153 只处理 `data === "\u001b"`；而 `key === "q"` 分支（panel.ts:152）在 confirmKill 拦截逻辑之外是全局生效的——如果 `q` 也同时失效，说明整个 `handleInput` 在 overlay 场景下可能根本没有收到按键（例如 full-screen overlay 的 input 路由被 mode/ui 事件上下文吃掉，与 d4fd482 修复的"绑定 mode/ui 时机"属于同一类问题）。

## 复现步骤

1. `pi` 启动，`Ctrl+Alt+A` 打开面板；
2. `Enter` 进入任一任务详情；
3. 按 `Esc`（或 `q`）→ 无响应，无法返回列表、无法关闭面板。

## 期望行为

- 详情页按 `Esc` 返回任务列表（README 第 44 行已承诺：`Esc` / `q` Return from details / close the panel）；
- 列表页按 `Esc`/`q` 关闭面板。

## 建议修复方向

1. `handleInput` 中对 Esc 的匹配改为前缀 + 定时判定（裸 `\u001b` 或 `\u001b[` 后无后续即视为 Esc），或直接复用 pi-tui 的按键事件 API（若 custom overlay 支持结构化 key event，优先用事件而非原始字节串比较）；
2. 确认 overlay 模式下 `handleInput` 是否确实收到按键——若收不到，参考 d4fd482 的 mode/ui 事件上下文绑定方式排查 input 路由；
3. 补充回归测试：模拟详情页发送 `\u001b`（及 Kitty 协议变体）断言 `detail === false`。

## 附注

工作区当前有未提交改动（`src/tui/rail.ts`、`tests/c-rail-render.test.ts`，rail linger 相关），与本 issue 无关，排查时注意区分。
