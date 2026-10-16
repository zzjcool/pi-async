# Changelog

本文件记录用户可见变更。格式参考 Keep a Changelog，版本遵循 SemVer。

## Unreleased

### Breaking / 行为变更

- **footer 状态栏已下架**：不再设置 `pi-async` footer 状态；任务汇总移至 rail 首行。
- **删除 `ctrl+alt+a` 快捷键**：打开任务面板请使用 `/async` 命令。
- **删除 `PI_ASYNC_DOCK_SHORTCUT` 环境变量**：升级后此前配置的该变量不再生效。
- **rail 行数上限从 ≤10 行收紧为 ≤4 行**（含汇总行与溢出指示）。
- **面板从全屏改为居中百分比尺寸**：列表 80%×70%，从 rail 直入的详情 85%×80%。

### Added

- rail 首行新增汇总：running、pending（非零时）、elapsed、`✓N` 与 `✗N`（均仅在非零时显示，全失败时不出绿色的 `✓0`）；终态计数遵循 `/async-clear` watermark。

## 0.2.0 — 2026-10-16

自 0.1.0 起的 16 个提交，主体是 Wave1/Wave2 缺陷修复，附带少量新能力与若干
**用户可见的行为变更**。升级前请看「Breaking / 行为变更」一节。

### Breaking / 行为变更

- **`async_status` 默认不再返回历史任务**（#22）。0.1.0 默认 `includeHistory !== false`
  （含历史），现在默认**仅活跃**（running/pending）；需要历史要显式传
  `includeHistory: true`，且最多返回最近 50 条。不传参的调用方会看到列表变短。
- **`output_matches` 的正则现在以 `m` 编译**（REV-10）。`^` / `$` 从「整段锚点」变成
  「行锚点」，多行输出下匹配结果可能变化。
- **per-task activity id 形状变更**：`pi-async/<taskId>` → `plugin/pi-async/<taskId>`
  （REV-8）。OSC 7501 / legion viz 侧可见。
- **`async_logs` 输出文本清洗范围扩大**：从 `stripAnsi` 改为同时剥离裸 C0 控制字符，
  并用 `truncateUtf8Bytes` 替代按字节 `subarray` 截断 —— 含 BEL/BS/FF 或多字节字符时
  返回文本与 0.1.0 不同。
- **新增校验会拒绝原先被接受的调用**：
  - `json_path_exists.path` 必须以 `$` 开头（新增 `pattern: "^\\$"`）
  - `async_run` 在非 sync 模式传 `timeoutMs`、非 delayed 模式传 `delayMs` 会被拒（#42/#45）
  - `output_matches` 拒绝嵌套量词（ReDoS 防护），匹配窗口限制 64 KiB

### Added

- 新增环境变量 `PI_ASYNC_RETENTION_MS`（默认 7 天）与 `PI_ASYNC_RETENTION_COUNT`
  （默认 100），用于按「时间 ∪ 数量」并集保留终态任务产物（#25）。
- `async_kill` 返回新增 `killKind`、`alreadyTerminal`、`warning`；`isError` 改为条件值（#33/#6）。
- 通知 XML 新增 `kill-kind` / `failure-kind` / `summary-truncated` 属性（#37）。
- `async_wait` 结果项新增可选 `killKind` / `failureKind`；`WaitOutcome` 增加混合超时态。
- 内部新增 `src/core/duration.ts`、`src/tui/width.ts`、`src/core/env.ts` 收敛重复实现。

### Fixed

- TUI：`displayWidth` / `truncateToWidth` 按显示单元截断（#7）；Esc 层级、elapsed、
  pending、footer、border、theme.fg 修复（Wave1）；`PI_ASYNC_DOCK_SHORTCUT=off`
  现在真正生效（#30）。
- 核心：watch ReDoS 与匹配窗口、reload 前代 registry 关停、UTF-8 截断、C0/XML 非法字符
  （Wave2）；sidecar/zombie 进程组清理、`wait` 消费（Wave1）；空 env 不再被解析成 0（#21）。
- 通知：killKind / failureKind / summaryTruncated 接线补全（#37）。
- 仓库：移除误提交的 62MB `docs/core` ELF dump（#50），`.gitignore` 收紧为 `/core`
  以免误伤 `src/core/`。

### 未变更

- 5 个工具（`async_run` / `async_wait` / `async_logs` / `async_status` / `async_kill`）
  的注册面与参数名集合不变；没有删除任何工具或工具参数。`PI_ASYNC_DOCK_SHORTCUT` 属于环境配置而非工具注册面，已在 Unreleased Breaking 节单独记录其删除。

## 0.1.0 — 2026-10-15

首个发布版本。
