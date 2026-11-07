# PLAN-CONTEXT — 可发现性层（L0/L1/L2）

状态：**FROZEN**（2026-11-06）
基线：`main @ 5d77350`（0.3.0）
上位契约：`docs/CONTRACT.md`（本计划以 REV-20/REV-21/REV-22 增补，不推翻 §1–§15）

## 0. 问题陈述

0.3.0 的核心不变量是「状态面不说谎」，但**可发现性没有进入不变量清单**：

- 5 个工具里只有 `async_run` 带 `promptSnippet`（`src/tools/index.ts:141-142`），而宿主只把带 snippet 的工具列进系统提示的 Available tools 段（pi 1.5.0 `dist/core/system-prompt.js:84-85`）→ `async_wait/logs/status/kill` 在模型的主视觉区缺席。
- 三条 guideline 是静态常量，无法表达「你现在有 2 个任务在跑」。
- `git grep '"tool_\|before_tool'` 零命中：模型把 20 分钟 build 塞进前台 `bash` 时，扩展看不见、也纠正不了。
- guideline #2「before ending a turn」把异步能力翻译成阻塞等待（review 记录 `async_wait` 超时中位数 210s）。
- `killed`+`timeout` 通知不带 guidance（`notify.ts:36` 只对 `failed` 开），而这是最需要「下一步」的时刻。

## 1. 目标（可验收）

1. 模型在系统提示里能**看见全部 5 个工具**，且每个 snippet 回答「什么时候用」。
2. 模型在**决策发生的位置**收到 3 类情境信号：前台长命令返回时、每次 provider 请求前（有活跃任务时）、settle 前。
3. 详细纪律（check 写法、watch 语义、promote/abort）从工具 schema 移出，进入按需加载的 skill。
4. 全部改动可被 `npm run verify` 机械验证；提示文案本身进测试断言（防漂移）。

## 2. 非目标（禁止越界）

- 不新增第 6 个工具（`CONTRACT.md` §1.2 / `PLAN-0.3.0.md:32` 仍有效）。
- 不拦截/替换原生 `bash`，不改变任何工具的现有参数与行为语义（除文案与 timeout guidance）。
- 不改 pi-legion / pi 本体；不引入新依赖。
- 不做 A/B 实验框架；采纳率度量用文档口径，不加埋点。

---

## 3. 冻结决策

### D-C1 五个工具全部带 snippet（supersedes D-17 的单点 snippet）

`src/tools/index.ts` 中逐字使用下列文案，**不得改写措辞**（测试逐字断言）：

| 工具 | snippet |
|---|---|
| `async_run` | `Run a long or gating shell command detached (build/test over a minute, server, watcher); returns a taskId, not output.` |
| `async_wait` | `Block until async tasks finish or the budget expires; results land in context. Never kills.` |
| `async_logs` | `Read the bounded, ANSI-stripped output of an async task, including while it is still running.` |
| `async_status` | `List active async tasks with elapsed time; includeHistory for recent finished ones.` |
| `async_kill` | `Stop an async task and its whole process group.` |

约束：每条 ≤ 140 字符、单行、动词开头、不含换行（宿主会把 snippet 压成一行，靠它占位）。

### D-C2 `async_run` description 收缩，语义下沉到字段

- `description` 恰为两句：
  `Run a shell command as a managed async task. mode=background (default) returns a taskId immediately; mode=sync waits up to timeoutMs then promotes; mode=delayed starts after delayMs.`
- 删除 description 末尾的 `${promptGuidelines}` 拼接（check 纪律移入 skill，见 D-C7）。
- 字段级 description（新增/补全，逐字）：

| 字段 | description |
|---|---|
| `command` | `Shell command to execute (/bin/sh -c) in the session cwd.` |
| `name` | `Short handle for later async_wait/async_logs/async_kill calls (max 48 chars).` |
| `mode` | `background (default) returns a taskId now; sync waits up to timeoutMs; delayed starts after delayMs.` |
| `timeoutMs` | `sync only: how long to wait before promoting to background (max ${maxSyncTimeoutMs} ms, from PI_ASYNC_MAX_SYNC_TIMEOUT_MS).` |
| `delayMs` | `delayed only: milliseconds to wait before starting.` |
| `taskTimeoutMs` | `Kill the task after this many ms, in any mode.` |
| `onTimeout` | `sync only: promote (default) returns while the task keeps running; abort stops waiting only — the task keeps running and still notifies.` |
| `notifyOnCompletion` | `Send a completion notification (default true).` |
| `triggerOnCompletion` | `Start a new turn when the task finishes (default true).` |
| `env` | `Extra environment variables for the child process (safe policy applied).` |
| `watch` | `Poll output (>=1s) for success_when/failure_when; conditions are OR-ed, first match wins, and checks must not swallow errors (no `\|\| true`).` |

### D-C3 guidelines：2–3 条「触发条件 → 动作」，区分主会话与 child

替换现有三条，逐字：

```ts
const ASYNC_RUN_PROMPT_GUIDELINES = [
  "Reach for async_run before bash when a command may outlive ~60s or never exit (builds, test suites, dev servers, watchers, network waits); quick file operations stay in bash.",
  "Do not sit in async_wait only to end a turn: if you do not need the result yet, end the turn and the completion notification wakes you. In a legion child, collect with async_wait before returning a verdict.",
  "Pass name so later calls address the task by name, and read output with async_logs (works while running) instead of re-running the command.",
];
```

### D-C4 bash 事后教学（`tool_result` 钩子）

新模块 `src/context/nudges.ts`：

```ts
export function bashNudge(input: { command: string; wallTimeSeconds?: number }): string | undefined;
```

触发条件（满足其一）：
- `wallTimeSeconds >= 60`
- 命令匹配 `/\btail\s+-f\b|\buntil\s|\bwatch\s+\S|\btail\s+-F\b/`

返回文本（逐字，`N` 为四舍五入秒数，无 wall time 时省略该子句）：

```
(took {N}s in the foreground; async_run could have run it in the background — use mode=background with watch for servers/builds, or mode=sync with timeoutMs when you need the result soon)
```

行为：把该行作为**额外的 text block 追加**到 bash 的 `tool_result.content` 末尾；`isError` 不变；任何异常都吞掉（best-effort）；`PI_ASYNC_NUDGE=0` 关闭。

### D-C5 活跃任务的情境行（`context_with_system`，回退 `context`）

```ts
export function asyncStateLine(tasks: TaskSnapshot[], now: number, max?: number): string | undefined;
```

- `tasks.length === 0` → `undefined`（空闲零成本，绝不注入）。
- 最多列 `max`（默认 5）个，多余折成 ` +K more`；每项 `name (status, elapsed)`，`elapsed` 用 `src/core/duration.ts` 的 `formatElapsedMs`。
- 文本（逐字）：

```
<async-state>{n} async task(s) active: {items} — end the turn and the completion notification wakes you, or call async_wait if you need one now.</async-state>
```

- 注入方式：在 `context_with_system` 的 `messages` 末尾追加一条 `{ role: "user", content: line }`；`context` 事件作为回退（同样形状）。
- 同一行内容在一轮之内不重复注入（按内容 hash 记忆，`agent_start` 清空）；`PI_ASYNC_NUDGE=0` 关闭。

### D-C6 settle guard：主会话只给「建议」，不给 `continue`

- `agent_before_settle` 改为**所有会话**都注册。
- legion child（`PI_LEGION_NODE_ID` 存在）：保持 0.3.0 行为（≤3 次提醒，`continue: true`；超预算写 `async-task-unresolved` 且不带 `continue`）。
- 主会话：**每 generation 最多 1 条**，`customType: "async-task-settle-advisory"`，`display: false`，**永不带 `continue`**，文本逐字：

```
{n} async task(s) still running: {ids}. If this answer does not need them, stop here — their completion notifications will wake you. Otherwise collect them with async_wait.
```

- `agent_start` 重置主会话的发送闩。

### D-C7 skill：长纪律按需加载

- 新增 `skills/async-tasks/SKILL.md`（Agent Skills 规范：frontmatter `name` + `description`）。
  - `name: async-tasks`
  - `description: Run long shell commands (builds, servers, watchers) as async tasks and collect them correctly. Use when a command may outlive a minute, when a dev server or watcher must keep running, or when a watch condition must gate progress.`
- 正文必须覆盖：何时用 vs 不用（含「快命令留在 bash」）、三种模式与 `promote`/`abort` 的语义（abort 只停等待、不杀进程）、`taskTimeoutMs` 与 watch `timeoutMs` 的区别、watch 是 ≥1s 轮询且匹配窗口是尾部 **64K 字符不是字节**、条件 OR-ed first-match-wins、check 四条反模式（不 `|| true`、未知态映射失败、`jq -e`、`output_matches` 锚定且正则按行编译）、`blind_checks` 只计基础设施错误、legion child 的收割纪律、`async_status` 的默认视图。
- 注册：`src/context/resources.ts` 导出 `registerSkillDiscovery(pi): void`，监听 `resources_discover` 返回 `{ skillPaths: [<abs path to skills/>] }`；路径用 `import.meta.url` 解析，目录不存在时不返回（静默降级）。
- `package.json` 的 `files` 加入 `"skills/"`。

### D-C8 timeout 通知带 guidance（修订 D5 的「仅 failed」）

- `extensions/index.ts` 的 guidance 组装新增：
  `if (snapshot.killKind === "timeout") failureNotes.push(...)`，文本逐字：
  `Killed at taskTimeoutMs. Rerun with a larger taskTimeoutMs, or watch for a success_when condition instead of a hard deadline.`
- `src/core/notify.ts:36` 的发送门放宽为 `(status === "failed" || killKind === "timeout") && guidance`。
- 不改变 `status`（`killed` 仍然是 `killed`）：这是**行动建议**，不是状态改判。

### D-C9 文案即契约

`tests/` 必须逐字断言 D-C1/D-C2/D-C3/D-C4/D-C5/D-C6 的文案（用常量导出或字符串字面量），防止后续重构静默漂移。当前 `tests/d-tool-contract.test.ts:78-79` 只断言「2–3 条」是反模式，必须升级。

---

## 4. 分步与文件所有权

| 步 | 范围 | 文件所有权 | verify |
|---|---|---|---|
| **L0** | D-C1/D-C2/D-C3 + 测试升级 | `src/tools/index.ts`、`tests/d-tool-contract.test.ts` | `npm run verify` |
| **L1** | D-C4/D-C5/D-C6/D-C8 + 测试 | `src/context/nudges.ts`(新)、`src/guard/settle-guard.ts`、`extensions/index.ts`、`src/core/notify.ts`、`tests/e-nudges.test.ts`(新)、`tests/d-settle.test.ts`、`tests/a-settle-guard.test.ts`、`tests/a-notify-kinds.test.ts`、`tests/a-notify-latch.test.ts` | `npm run verify` |
| **L2** | D-C7 + 测试 | `skills/async-tasks/SKILL.md`(新)、`src/context/resources.ts`(新)、`extensions/index.ts`、`package.json`、`tests/e-skill.test.ts`(新) | `npm run verify` |
| **收口** | REV-20/21/22 落 `CONTRACT.md`、CHANGELOG、README | 主会话 | `npm run verify` |

L1 与 L2 都改 `extensions/index.ts` → **串行**，同一时刻只有一个 writer。

## 5. 集成顺序

L0 → L1 → L2 → 文档收口。每步先 `npm run verify` 全绿再进入下一步；任一步失败回到该步修订，不带着红灯前进。

## 6. 验收清单

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 全绿（0.3.0 基线 182+ 用例，新增用例不低于 12 条）
- [ ] 5 个工具都有非空 `promptSnippet`，逐字等于 D-C1
- [ ] `async_run.description` 不含 `|| true` 字样（check 纪律已移出）
- [ ] `bashNudge` 在 3 类输入上的行为被断言（长耗时/短耗时/watch 型命令）
- [ ] `asyncStateLine` 在 0 任务时返回 `undefined`（零成本）
- [ ] 主会话 settle 建议 `continue` 字段不存在；legion child 行为不变
- [ ] `killed`+`timeout` 的通知 XML 含 `<guidance>`
- [ ] `resources_discover` 返回的 skill 路径存在且 `SKILL.md` frontmatter 可解析
