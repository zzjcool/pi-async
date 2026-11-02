# pi-async 0.3.0 实施计划（冻结契约）

- 状态：FROZEN 2026-11-02
- 目标版本：`0.3.0`
- 基线：`main @ fba7b46`；`npm run typecheck` 通过；`npm test` 182/182 通过
- 评审依据：`docs/2026-11-02-review.md`
- 规则：本文件冻结接口与文件归属；worker 不得越界改文件。需要改契约先报告父会话，不得自行解释。

---

## 1. 目标与非目标

### 1.1 0.3.0 必须完成（P0 + 高价值 P1）

1. **cwd 正确性**：任务在 session cwd 执行，而不是 pi 进程 cwd。
2. **通知诚实化**：去掉假重试；claim 后置；session_start 补发；状态面暴露 notified/outputConsumed。
3. **工具契约不撒谎**：kill 未知 id 报错；支持 name 别名；非 sync 拒绝 onTimeout；sync 失败 isError；status 过滤/排序。
4. **安全与存储**：env 安全继承、危险键拒绝、delayed env 脱敏、outputFile 路径校验、孤儿 running 清理。
5. **settle guard 修复**：custom_message draft；agent_settled.aborted 兜底；删除无效 heartbeat。
6. **TUI 可靠性**：面板事件驱动刷新；kill catch；kill 键改成 `x`；overlay 单例；详情不静默裁掉 footer。
7. **发布工程**：0.3.0 版本、CHANGELOG、CI 1.5.0 矩阵、publish workflow、lock 版本一致。

### 1.2 明确不做（留 0.3.1/0.4）

- watch 正则执行超时/worker（需要进程隔离，改动大）。
- 通知批量合并（debounce）——保持每任务一条，避免改 XML schema。
- 跨进程 waiter / daemon / IPC。
- TUI 全量重写（只做可靠性修复，不做新视觉系统）。
- Windows 支持（保持 POSIX `/bin/sh`）。
- agent 编排（属于 legion）。
- `ui.setActivity` 的官方化（官方 pi 1.2–1.5 无此 API，保留 feature-detect shim，不再宣传）。
- 新增第 6 个工具（5 工具面冻结）。

### 1.3 版本与兼容

- `version`: `0.3.0`。
- `peerDependencies` **保持** `@earendil-works/pi-coding-agent: ^1.2.0`、`@earendil-works/pi-tui: ^1.2.0`。
  - 原因：本次用到的 `ctx.cwd`、`execute` 第 5 参、`onUpdate`、`promptSnippet`、`registerMessageRenderer`、`agent_settled.aborted` 在 pi 1.2.0 类型里都已存在（已核验）。
  - CI 增加 pi `1.5.0` 类型/测试 job；不因为“最新版”而抬 peer 下限。
- 所有行为变化写进 `CHANGELOG.md` 的 `0.3.0` 段，breaking 单独列。

---

## 2. 冻结接口

> 以下签名是 worker 之间的唯一契约。实现可以加私有辅助函数，但不得改变这些公开形状；需要改先报告。

### 2.1 `src/core/task.ts`

```ts
export type TaskSnapshot = {
  // 现有字段保持不变
  taskId: string; name: string; command: string; mode: TaskMode; status: TaskStatus;
  pid?: number; exitCode?: number; killKind?: KillKind; failureKind?: FailureKind;
  createdAt: number; startedAt?: number; finishedAt?: number; dueAt?: number;
  taskTimeoutMs?: number; notified: boolean; outputConsumed: boolean;
  watch?: unknown; metadata: Record<string, unknown>;
  // 0.3.0 新增（全部可选，旧快照可读）
  cwd?: string;                 // 任务执行目录
  timeoutAt?: number;           // taskTimeoutMs 的绝对 deadline
  watchDeadline?: number;       // watch 超时的绝对 deadline
  notifyAttempts?: number;      // 已尝试通知次数
  processAlive?: boolean;       // 快照生成时的进程存活判断（可选）
};

export type RunOptions = {
  command: string; name?: string; mode: TaskMode;
  timeoutMs?: number; delayMs?: number; taskTimeoutMs?: number;
  notifyOnCompletion?: boolean; triggerOnCompletion?: boolean;
  env?: Record<string, string>; watch?: WatchSpec;
  cwd?: string;                 // 0.3.0 新增；缺省 process.cwd()
};
```

### 2.2 `src/core/spawn.ts`

```ts
export type EnvPolicy = "safe" | "all" | "none";

export function spawnDetached(
  command: string,
  opts: {
    outputFile: string;
    env?: Record<string, string>;
    cwd?: string;
    envPolicy?: EnvPolicy;      // 缺省 "safe"
  },
): SpawnHandle;
```

- `safe`（默认）：
  - 继承 `process.env`，但剥离敏感键：`*_API_KEY`、`*_TOKEN`、`*_SECRET`、`*_PASSWORD`、`*_CREDENTIAL*`、`AWS_SECRET_ACCESS_KEY`、`AWS_ACCESS_KEY_ID`、`AWS_SESSION_TOKEN`、`GITHUB_TOKEN`、`GH_TOKEN`、`NPM_TOKEN`。
  - 显式 `env` 中的危险键直接 **throw**，不静默忽略：`PATH`、`LD_PRELOAD`、`LD_LIBRARY_PATH`、`NODE_OPTIONS`、`BASH_ENV`、`ENV`、`SHELLOPTS`、`PYTHONPATH`、`GIT_SSH_COMMAND`。
  - 允许显式 `env` 覆盖普通键（如 `FOO`、`CI`、`NODE_ENV`）。
  - 始终删除 `PI_ASYNC_INTERNAL_MAX_OUTPUT_BYTES`。
- `all`：旧的 `{...process.env, ...env}` 行为；仅显式设置 `PI_ASYNC_ENV_INHERIT=all` 时启用。
- `none`：只给 `PATH`、`HOME`、`SHELL`、`TERM`、`LANG`、`LC_*`、`TMPDIR`、`USER`（存在的）。
- `cwd`：传给 `spawn(..., { cwd })`；不存在或不可读时由 `spawn` 抛错，registry 回滚任务。

### 2.3 `src/core/notify.ts`

```ts
export type NotifyOutcome = "queued" | "skipped" | "failed";

export async function sendCompletionNotification(
  pi: PiCtx,
  registry: TaskRegistry,
  p: NotifyPayload,
  options?: { triggerTurn?: boolean },
): Promise<NotifyOutcome>;
```

语义：
- `skipped`：`outputConsumed` 已为 true，或 `notifyOnCompletion=false`。
- `failed`：宿主无 `sendMessage`，或同步抛错；`notified` 保持 false，`notifyAttempts++`。
- `queued`：`sendMessage` 已返回（不等于模型已读）；`notified=true`，`notifyAttempts++`。
- 不做 3 次重试；不做 rollback（没有 ack，rollback 是自欺）。
- 发送顺序：先 `noteNotifyAttempt`（持久化 attempts），再 `sendMessage`，成功后 `markNotified`。
- 并发去重：内存 `notifyClaims` 在发送前占位；失败释放；成功保留到 generation 结束。
- 消息体：
  - `customType: "async-task-notification"`。
  - `content`: 现有 XML，保持模型可读。
  - `details`: 新增结构化对象 `{ taskId, name, status, exitCode?, killKind?, failureKind?, summary?, summaryTruncated?, outputFile, guidance? }`，供 TUI renderer 使用。

### 2.4 `src/core/registry.ts`

新增/调整公开方法（现有方法保持兼容）：

```ts
export type RegistryEvent =
  | { type: "state"; snapshot: TaskSnapshot }
  | { type: "finalize"; snapshot: TaskSnapshot };

export class TaskRegistry {
  constructor(config: { dataDir: string; cwd?: string; /* 现有 retention 等 */ });

  /** 0.3.0：会话初始化后调用；幂等。用于切换 dataDir/cwd 并首次 reload。 */
  configure(opts: { dataDir?: string; cwd?: string }): void;

  /** 事件订阅（TUI/通知用），返回 unsubscribe。 */
  subscribe(listener: (event: RegistryEvent) => void): () => void;

  /** 按 taskId 或 name 解析；未知抛错；name 重名抛错并列出候选 id。 */
  resolveTaskId(idOrName: string): TaskSnapshot;

  /** 0.3.0：/reload 用。停 timer/watch，不杀进程；持久化当前状态。 */
  suspend(): Promise<void>;

  /** 0.3.0：session_start 补发。返回补发条数。 */
  resendUnnotified(opts?: { maxAgeMs?: number; maxAttempts?: number }): Promise<number>;

  /** 0.3.0：启动时清理 pid 已死的非终态任务。返回处理条数。 */
  reapOrphans(now?: number): number;
}
```

- `submit/scheduleDelayed/runSync` 的 options 接受 `cwd`；`TaskSnapshot.cwd` 持久化。
- `startTask` 设置 `task.cwd = options.cwd ?? this.config.cwd ?? process.cwd()`。
- `taskTimeoutMs` 设置时同时写 `timeoutAt = Date.now() + taskTimeoutMs`；reload 时按 `timeoutAt` 重建 timer。
- `attachWatch` 接受可选 `deadline`；reload 时用持久化的 `watchDeadline` 恢复。
- `configure`：
  - 若首次调用且 `reloadFromDisk` 未执行，则设置 dataDir/cwd 并 `reloadFromDisk()`。
  - 若 dataDir 变化且当前已有任务，迁移 `.json/.output/.stdout/.stderr`（copy + rename）后重新 load；迁移失败则保留旧目录并报错，不得丢任务。
- `suspend()` 不 kill；`shutdown()` 保持 kill（quit 用）。
- `reapOrphans()`：非终态 + `pid` 存在 + `!pidAlive(pid)` → `failed` + `failureKind:"lost"`；无 pid 的 running → `failed/lost`；pending delayed 保留（除非 dueAt 超过 retention）。
- `prune()` 保持只清终态；新增 `enforceDiskQuota()`（可选，默认关闭，`PI_ASYNC_TOTAL_BYTES` 设置时启用）。

### 2.5 `src/core/env.ts`

```ts
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> | undefined,
  policy: EnvPolicy,
): Record<string, string>;
```

- 纯函数，便于测试；`spawn.ts` 调用它。
- `safe/all/none` 规则见 2.2。

### 2.6 `src/guard/settle-guard.ts`

```ts
export class SettleGuard {
  register(): void;
  dispose(): void;
}
```

行为：
- `agent_before_settle`（仅 `PI_LEGION_NODE_ID` 存在时注册）：
  - 无活跃任务 → `reminders=0`，返回 `undefined`。
  - `reminders >= maxReminders`（默认 3）→ 返回 `{ entries: [...event.entries, unresolvedEntry] }`，不再 `continue`。
  - 否则 `reminders++`，返回 `{ entries: [...event.entries, custom_message], continue: true }`。
  - `custom_message` 形状：`{ type: "custom_message", customType: "async-task-settle-reminder", content: "...", display: false }`。
- `agent_settled`（对所有会话注册，`PI_ASYNC_SETTLE_GUARD=0` 可关）：
  - 若 `event.aborted === true` 且 `registry.hasActiveWork()`，发一条 `pi.sendMessage({customType:"async-task-unresolved", content: "..."}, {deliverAs:"followUp"})`；不设置 `triggerTurn`。
  - 每 generation 最多 1 条，避免刷屏。
- 删除 heartbeat `setInterval` 与 `appendEntry("async-task-heartbeat")`；`reportActivity` 保留（feature-detect）。
- `dispose()` 幂等，退订所有 handler。

### 2.7 `src/tools/index.ts`

- `execute` 签名改为 5 参：`(toolCallId, params, signal, onUpdate, ctx)`。
- `async_run`：`ctx.cwd` 传入 registry；`ctx` 缺省时回退 `process.cwd()`。
- `async_run` schema 增加：
  - `sync.timeoutMs` 的 `maximum` 由 `PI_ASYNC_MAX_SYNC_TIMEOUT_MS` 决定，默认 `600000`（10 分钟）；运行时同样校验。
  - `promptSnippet`：`"Run a shell command in the background, with optional watch conditions and completion notification."`
  - `promptGuidelines`：2–3 条，明确 `async_run` / `async_wait` / `async_logs` 的使用场景。
- `async_wait`、`async_logs`、`async_kill` 的 `taskId` 参数支持 name（`registry.resolveTaskId`）。
- `async_kill` 未知 id/name → `throw new Error("Unknown task or name: ...")`。
- `async_kill` 返回增加 `processAlive?: boolean`；未知/已终态语义清楚。
- `async_run` 非 sync 传 `onTimeout` → throw；非 sync 传 `timeoutMs`/`delayMs` 保持现有 throw。
- `async_run` sync 非 0 退出 → `toolResult(result, true)`（`isError:true`），但 payload 保留完整 `SyncResult`。
- `async_status` 参数扩展：
  ```ts
  { includeHistory?: boolean; status?: TaskStatus | "active"; name?: string; limit?: number }
  ```
  - 默认 active；`limit` 1–50，默认 50。
  - `includeHistory:true` 按 `finishedAt ?? createdAt` 降序。
  - 结果仍是 `TaskSnapshot[]`，但 `metadata` 中的 `delayedEnv` 值用 `"***"` 脱敏（保留键）。
- `async_logs` 参数增加 `stream?: "merged" | "stdout" | "stderr"`（默认 merged）。
  - `output` 文件缺失 → 返回 `{text:"", truncated:false, fullPath, missing:true}`，不 throw。
  - 读取前校验 `fullPath` 在 dataDir 内；越界 → throw。
- 所有工具结果继续走 `toolResult()` 包装（pi 1.2–1.5 仍必要）。

### 2.8 `extensions/index.ts`

- 数据目录：
  - `resolveDataDir(ctx)`：优先 `join(ctx.sessionManager.getSessionDir(), "pi-async", ctx.sessionManager.getSessionId())`；否则 `join(os.homedir(), ".pi", "async", String(process.pid))`。
  - factory 期不再 `reloadFromDisk()`、不再 `mkdirSync` 数据目录、不再启动 heartbeat。
  - 首次 `session_start` 调用 `registry.configure({dataDir, cwd: ctx.cwd})`，然后 `resendUnnotified()`。
  - 工具 execute 若 registry 未 configure，则用 `ctx.cwd` 做一次最小 configure（无 sessionManager 时用 fallback）。
- `session_shutdown(event)`：
  - `reason === "reload"` → `await registry.suspend()`，不 kill。
  - `reason === "quit"`（或未知）→ `await registry.shutdown()`。
  - `reason === "new" | "fork"` → `await registry.shutdown()`（旧会话任务不跨会话）。
  - `reason === "resume"` → `await registry.suspend()`（允许下一代收养）。
- `onFinalize`：
  - `notifyOnCompletion=false` → 跳过。
  - 调用 `sendCompletionNotification`，不写 `.catch(console.error)` 作为唯一处理；失败要 `console.error` + `registry` 状态保持 `notified=false`。
- `registerMessageRenderer("async-task-notification", ...)`：
  - 用 `message.details` 渲染一行卡片：`✓ name (completed, 1.2s) · exit 0`；失败带 `✗` 和 `killKind/failureKind`。
  - 没有 details 时回退到 `message.content` 的第一行。
- `registerTools` 在 factory 注册即可；TUI 仍从首个 `session_start`/`message_start` ctx 绑定。
- `pi.on("agent_settled")` 由 settle guard 内部注册，extensions 不重复。

### 2.9 TUI（`src/tui/panel.ts`、`rail.ts`、`status.ts`）

- `panel.ts`：
  - 订阅 `registry.subscribe(() => requestRender())`，`dispose()` 退订。
  - kill 键从 `k` 改为 `x`（`K` 也可）；`k` 保持上移。更新提示行与 README。
  - kill 调用：`void registry.kill(...).catch((e) => { actionError = String(e); host.ui?.notify?.(actionError, "error"); requestRender(); })`。
  - `c` 键不再调用不存在的 `copyToClipboard`；改为 `host.ui?.notify?.(path, "info")`，提示“output path”。
  - overlay 单例：模块级 `panelOpen` 标记；已打开时再次 `/async` 只 `requestRender`/notify，不叠加。
  - 详情：`frame` 前计算 body 预算；超出时保留 header + 最后 N 行，并插入 `… (+K lines)`；footer 键位提示固定保留。若实现滚动，`PageUp/PageDown` 滚动 body。
  - 列表最新输出行使用 tail 读取（复用 `readUiOutput` 或新增 `readTail`），不再整文件读。
- `rail.ts`：
  - 删除不可达的 `handleInput` PageUp/PageDown 代码与相关测试。
  - 汇总计数与任务行使用同一可见窗口（linger），避免 `✓N` 有数但无行。
- `status.ts`：
  - 保留 `summarySegments`/watermark；不再新增 footer（HEAD 已下架）。
  - 若 `ui.setStatus` 可用且 `PI_ASYNC_FOOTER=1`，可选显示一行汇总；默认关闭。

### 2.10 文档与发布

- `README.md`：
  - 版本/安装、5 工具表、配置表（补 `PI_ASYNC_RAIL_LINGER_MS`、`PI_ASYNC_ENV_INHERIT`、`PI_ASYNC_MAX_SYNC_TIMEOUT_MS`、`PI_ASYNC_SETTLE_GUARD`）。
  - 键位表：`x` kill；`c` 显示路径；鼠标仅 fullscreen。
  - 明确通知是 best-effort + session_start 补发；`async_wait` 会抑制通知。
  - 明确 watch 组内 OR、64K 字符窗口、blind_checks 只计 error。
  - 数据目录位置与安全建议。
- `CHANGELOG.md`：0.3.0 段，Added/Changed/Fixed/Breaking；列出所有 REV。
- `docs/CONTRACT.md`：
  - 修正“四种模式”为三种。
  - §7 settle guard 改为 custom_message + agent_settled 兜底；删除 heartbeat 描述。
  - §11 环境变量补全。
  - 新增 REV-13（cwd）、REV-14（notify honesty）、REV-15（name alias / tool contract）、REV-16（env policy）、REV-17（dataDir / reload reason）、REV-18（TUI key `x`）。
- `package.json`：
  - `version: "0.3.0"`；`package-lock.json` 同步。
  - scripts：`"verify": "npm run typecheck && npm test"`；`"prepublishOnly": "npm run verify"`。
  - 不新增 dependencies；devDependencies 保持现状，CI 单独安装 pi 1.5.0。
- `.github/workflows/ci.yml`：
  - node 22/24 matrix；一个 job 安装 `@earendil-works/pi-coding-agent@1.5.0` + `@earendil-works/pi-tui@1.5.0` 后 typecheck/test。
  - `npm pack --dry-run`。
- `.github/workflows/release.yml`：
  - tag `v*` → `npm ci`、`npm run verify`、`npm publish --provenance`（`NPM_TOKEN` secret）、`gh release create`。
  - 不自动创建 tag；tag 由维护者打。

---

## 3. 文件归属（严格）

| 工作流 | 负责文件 | 测试文件 | 禁止触碰 |
|---|---|---|---|
| W1 Core runtime | `src/core/spawn.ts`、`src/core/env.ts`、`src/core/registry.ts`、`src/core/task.ts`、`src/tools/index.ts`、`extensions/index.ts` | `tests/d-cwd.test.ts`、`tests/d-reload.test.ts`、`tests/d-env-policy.test.ts`、`tests/d-tool-contract.test.ts`、`tests/d-storage.test.ts` | `src/core/notify.ts`、`src/guard/*`、`src/tui/*`、docs、package.json |
| W2 Notify | `src/core/notify.ts` | `tests/d-notify.test.ts` | 其他 src |
| W3 Settle | `src/guard/settle-guard.ts` | `tests/d-settle.test.ts` | 其他 src |
| W4 TUI | `src/tui/panel.ts`、`src/tui/rail.ts`、`src/tui/status.ts` | `tests/d-tui-refresh.test.ts`、`tests/d-tui-keys.test.ts` | `src/core/*`、`src/guard/*`、`extensions/index.ts` |
| W5 Docs/Release | `README.md`、`CHANGELOG.md`、`docs/CONTRACT.md`、`package.json`、`package-lock.json`、`.github/workflows/*` | — | 所有 `src/`、`extensions/`、`tests/` |

- W1 是唯一允许改 `extensions/index.ts` 的 worker；W3 只改 `settle-guard.ts`，其 handler 注册由 W1 在 `extensions/index.ts` 调入。
- W2 只改 `notify.ts`；registry 的通知方法由 W1 按 §2.4 实现。
- W4 只改 TUI；需要的新 registry 方法由 W1 按 §2.4 实现。
- W5 在 W1–W4 行为稳定后定稿；可以先写 release workflow/package 版本，但 README/CHANGELOG 必须等代码完成。

---

## 4. 实施顺序与并行

1. 父会话先冻结本文件（已完成）。
2. W1、W2、W3、W4 并行开工；W1 是长 pole，优先启动。
3. W5 并行写 release scaffolding；等 W1–W4 完成后 30 分钟内定稿文档。
4. W1–W4 各自跑目标测试 + `npx tsc --noEmit`；若因他人未完成文件报错，只记录，不修改他人文件。
5. 集成者（centurion）在全部 worker 完成后运行 `npm run typecheck && npm test`，逐项修复集成缝隙；必要时派 fresh-context reviewer。
6. 集成者提交分支/MR，不 push main、不 npm publish。
7. 主会话 review → merge → 版本/CHANGELOG 定稿 → tag `v0.3.0` → 发布（有 NPM_TOKEN 才 publish）。

---

## 5. 验收清单（0.3.0 必须全绿）

- [ ] `npm run typecheck` 通过（pi 1.2.0 类型基线）。
- [ ] `npm test` 全绿（≥182 + 新增测试）。
- [ ] CI 的 pi 1.5.0 job 通过。
- [ ] `npm pack --dry-run` 包含 `extensions/`、`src/`、`README.md`、`LICENSE`、`docs/CONTRACT.md`、`CHANGELOG.md`。
- [ ] `async_run("pwd")` 在 session cwd 执行。
- [ ] `async_kill` 未知 id/name 返回 isError。
- [ ] 非 sync 传 `onTimeout` 返回 isError。
- [ ] sync 非 0 退出返回 isError，payload 保留 exitCode/outputTail。
- [ ] `async_wait` 可用 name 解析；重名报错并列出候选。
- [ ] 通知失败时 `notified=false`、`notifyAttempts>0`；session_start 补发一次。
- [ ] `session_shutdown({reason:"reload"})` 不 kill running；`quit` kill。
- [ ] `taskTimeoutMs` 与 `watchDeadline` 在 reload 后恢复。
- [ ] 默认 env 不含 `*_API_KEY`/`*_TOKEN`；显式 `PATH` 被拒；`PI_ASYNC_ENV_INHERIT=all` 可恢复旧行为。
- [ ] `metadata.outputFile` 越界读取被拒。
- [ ] 孤儿 running 启动时标 failed/lost。
- [ ] settle guard 的提醒出现在 `agent_before_settle` 的 `entries` 中，且类型为 `custom_message`。
- [ ] `agent_settled({aborted:true})` 且有活跃任务时发送 followUp 提醒。
- [ ] 面板打开时任务完成会刷新；kill 失败不崩；`x` kill 需二次确认。
- [ ] README/CHANGELOG/CONTRACT 无“四种模式”“k kill”“copyToClipboard”等漂移。
- [ ] `npm view pi-async version` 发布后为 `0.3.0`（发布步骤单独执行）。

---

## 6. 发布步骤（主会话执行）

```bash
# 1) 合并 MR 后，在 main 上确认
git status --short          # 必须干净
npm ci
npm run verify
npm pack --dry-run

# 2) 版本/CHANGELOG 已由 W5 更新；确认
node -p "require('./package.json').version"   # 0.3.0

# 3) 提交与 tag
git add -A && git commit -m "release: 0.3.0"
git tag v0.3.0
git push origin main --tags

# 4) 发布（需要 NPM_TOKEN；没有则让维护者执行）
npm publish --provenance

# 5) GitHub release（需要 gh auth）
gh release create v0.3.0 --generate-notes

# 6) 验证
npm view pi-async version
```

**注意：** 本计划不授权 worker 执行 `npm publish`、`git push main`、`gh release create`。这些由主会话在 review 通过后执行；无凭据时只准备到 tag 前一步。

---

## 7. 风险与回退

- **风险 1：dataDir 迁移丢任务。** 回退：迁移前 copy 到新目录，成功后再删旧；失败保留旧目录并报错。
- **风险 2：env 安全策略破坏用户工作流。** 回退：`PI_ASYNC_ENV_INHERIT=all`；CHANGELOG 明确 breaking。
- **风险 3：sync 失败改 isError 改变模型行为。** 回退：保留 payload 完整；如模型误判，可在 0.3.1 改为 `ok:false` 字段。
- **风险 4：settle guard custom_message 造成重复提醒。** 回退：`maxReminders=3` + `agent_settled` 每 generation 1 条；`PI_ASYNC_SETTLE_GUARD=0` 关闭。
- **风险 5：reload 不 kill 导致孤儿。** 回退：下一代 `reapOrphans` + `suspend` 持久化；`quit` 仍 kill。
- **风险 6：TUI 刷新订阅泄漏。** 回退：`dispose()` 退订；单例 overlay；测试覆盖。
