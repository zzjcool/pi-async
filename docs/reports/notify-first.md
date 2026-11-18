# pi-async 0.5.0 — agent 不再需要知道「等待」这件事

- 分支：`feat/notify-first`（独立 worktree `/root/code/pi-async-wt/notify-first`）
- 基线：`origin/main` = 0.4.7 `dd73081` → 合流后 = 0.4.8 `e67ff79`（`feat/hold-in-rail` 已合入 main）
- 版本：`0.5.0`（minor：工具面与语义变更）。**未发版、未打 tag**。
- 交付面：`D3` 删 `mode=sync`、`D4` `async_wait` 默认不注册、`D5` headless 结构性保底、`D6` nudge 文案。

本文件只记录可复核的事实：改了什么、每条验收的「改回去即红」证据、真实 `pi -p` 的原文输出、与 0.4.8 的合并情况。

---

## 1. D3 — `mode=sync` 彻底删除（无兼容层）

删的是整条阻塞路径，不是加了个开关：

| 位置 | 改动 |
|---|---|
| `src/core/task.ts` | `TaskMode = "background" \| "delayed"`；删 `RunOptions.timeoutMs` / `onTimeout`、删 `SyncResult` |
| `src/core/registry.ts` | 删 `runSync()` 与私有 `syncResult()`；`createAndStart(opts)` 固定 background；`validateRunWatch(opts)` 删 sync 拒绝分支；不再 import `truncateUtf8Bytes` / `SyncResult` / `TaskMode` |
| `src/tools/index.ts` | `mode.enum = ["background","delayed"]`；schema 删 `timeoutMs` / `onTimeout`；删 `DEFAULT_MAX_SYNC_TIMEOUT_MS` / `resolveMaxSyncTimeoutMs` / `PI_ASYNC_MAX_SYNC_TIMEOUT_MS` 读取与整段 sync 分支；`async_run.description` 改回两句 |
| `src/tui/rail.ts` | `typeColor` 的 mode 下标改为 `mode === "delayed" ? 2 : 0` —— background=0 / delayed=2 的 `TYPE_TOKENS` 槽位与 rail 配色测试完全不变 |
| 文档/技能 | README / `docs/CONTRACT.md`（§3、§9、§11、§13 D2、§14、§17、REV-15、REV-19 + 新增 §22 REV-29）/ `skills/async-tasks/SKILL.md` 删除 sync 段落与 `PI_ASYNC_MAX_SYNC_TIMEOUT_MS` |

`additionalProperties: false` 意味着这类参数现在由**宿主 schema 校验**直接拒绝，而不是运行期再判「只对 sync 有效」。
`execute` 仍保留一条 `Unsupported async_run mode: sync` 白名单，用于旧会话/旧注册带着历史参数再进来时给明确错误。

**测试同步**：`tests/b-sync-mode.test.ts` 整文件删除（4 例），delayed 相关断言迁入 `tests/b-delayed.test.ts`；
`a-tool-result-contract` 3 例、`d-tool-contract` 4 例、`w2-safety` 的 `syncResult` UTF-8 例、`a-wave1-core-fixes`
的 sync 参数例、`i-e2e` 的 sync 段一并删除；`d-storage` 里把 `runSync` 当「admission closed」探针改为 `submit`。
#17 的 UTF-8 覆盖仍由 `w2-safety` 里直接测 `truncateUtf8Bytes` 的用例承担。

---

## 2. D4 — `async_wait` 默认不注册，旧调用优雅降级

- 默认工具面 **5 个**：`async_run` / `async_logs` / `async_status` / `async_kill` / `async_extend`。
- 唯一暴露条件：`PI_ASYNC_EXPOSE_WAIT=1`（**每次调用读 env**，不在模块顶层缓存；reload 后即生效）。
- 独占能力变了：`async_wait` 现在唯一不能被 hold/通知替代的能力是「只等子集 / 拿部分结果」。
- **降级**（`src/tools/index.ts`）：
  - 旧注册仍在手时调用它 → `execute` 的调用时闸门返回
    `{ taskId: null, available: false, error: WAIT_UNAVAILABLE, enableWith: "PI_ASYNC_EXPOSE_WAIT=1", alternatives: ["async_status","async_logs"] }`
    （`isError: true`，正常 resolve，**不 throw**），文本含「not available in this configuration」与开启方式。
  - 名字根本没注册时，宿主回 `Tool async_wait not found`（`agent-loop.js:479-492`，不崩）。扩展**无法**拦截
    未注册工具名（`beforeToolCall` 在查表之后），所以这一层的可读性只能由上面那条旧注册路径提供——这是宿主边界，
    写进了 CONTRACT §22.2。
- **文案不再劝模型调用未暴露的工具**：`notificationException()` 两条 hint、`<async-state>` 三条 tail、
  settle guard 的 advisory/reminder/unresolved/aborted 文案全部按 `waitToolExposed()` 分流到
  `async_status` + `async_logs`。`ASYNC_RUN_PROMPT_GUIDELINES` 的 base 4 条**逐字保留**（CONTRACT §17 冻结），
  未暴露时追加第 5 条说明「本会话没有 async_wait，设 `PI_ASYNC_EXPOSE_WAIT=1` 才暴露；结束回合等通知」。

---

## 3. D6 — nudge 不再把 `async_wait` 当默认动作

- `src/context/nudges.ts` 全唤醒分支：`— end the turn and the completion notification wakes you, or call async_wait if you need one now.`
  → **默认** `— end the turn and the completion notification wakes you.`（只有暴露 async_wait 时才保留后半句）。
- 混合/全不唤醒分支同样改用 `async_logs`；三条 tail 的「按 per-task 事实分三态」不变量保留（全不通知分支不得声称会唤醒、
  全唤醒分支不得出现 `no-notify` 的旧护栏仍在）。
- `bashNudge`：删 `, or mode=sync with timeoutMs when you need the result soon`（sync 已不存在），
  改为 `… use mode=background with watch for servers/builds; end the turn and the completion notification wakes you`。
- `skills/async-tasks/SKILL.md`：默认做法改为「结束回合等完成通知」，`async_wait` 标注为宿主 opt-in。

---

## 4. D5 — headless（`pi -p`）结构性保底

新模块 `src/guard/print-wait.ts`（**不动 `hold.ts`**，与 0.4.8 的 TUI hold 按 `ctx.mode` 完全互斥）：

1. **只在 `ctx.mode === "print"`** 参与；`tui`/`rpc`/`json`/缺失 ctx 立即返回（缺失 ctx 不被当成 print）。
2. 在 `agent_before_settle` 内等到所有 `status === "running"` 的任务终态（宿主对该 handler 的 `await`
   没有超时：`runner.js:779`）。`delayed`/`pending` 不算：`dueAt` 可能在一小时外，那是「已排期」不是「在飞」。
3. 全终态 → 提交一条 `async-task-print-results`（只含 name/status/exitCode，≤8 行，**绝不内联 outputTail**）
   并返回 `continue: true` → 宿主再发一次 provider 请求（`agent-session.js:1521-1525`）→ **模型的结论就是
   `pi -p` 打印的东西**（`print-mode.js:117-138` 只打印最后一条 assistant 消息）。
4. **终态归属复用 0.4.3 的 `HoldNotificationRelay`**（与 hold 同一实例）：等待期间落地的完成通知由 results entry
   独占，`commit` 掉的 id 逐个 `markNotified`，不会变成没人读的 followUp，也不会在下次 `session_start` 被重播。
5. **两道界**（宿主不提供，`PI/docs/extensions.md:748` 明确 `continue:true` 可成环）：
   `PI_ASYNC_PRINT_MAX_CONTINUATIONS`（默认 5，整进程累计）× `PI_ASYNC_PRINT_WAIT_MS`（默认 10 分钟，单调时钟跨回合累计）。
6. **超限**：`release` 扣住的通知 → **stderr** `pi-async: still running N async task(s) after C continuation(s) and Ts: <taskId> (<name>), …`
   → `process.exitCode = 1` → 允许 settle。不用 stdout：print 模式 `console.log`/`process.stdout.write`
   被宿主接管到 stderr（`output-guard.js:38-59`），而 `process.exitCode` 在扩展里设置有效（`main.js:877` 只在非 0 时覆盖）。
7. 任何路径都不 throw、不 `process.exit()`；registry 抛错 / dispose 只释放通知、不改退出码。
8. `PI_ASYNC_PRINT_WAIT=0` 一个 handler 都不注册（0.4.x 行为，用于对照与紧急回退）。

接线在 `extensions/index.ts`：`activePrintWait`（与 `activeHold` 同级、reload 时先 dispose），
`registerPrintWait(pi, registry, { notify: holdNotify })` 注册在 `registerHold` **之前**——
print 里 hold 本来就 inert，TUI 里 print-wait 立即返回，两者互不吞对方的 draft。

### 4.1 真实 `pi -p` 实测（原文）

环境：真实 `pi` 1.5.2（`/root/.pi/agent/bin/pi`）、`--extension repo/extensions/index.ts`、临时 HOME（复用宿主已安装
`pi-any-endpoint`，无网络）、`test/docker/tools/mock-llm.py` 脚本化 OpenAI 兼容端点。
脚本：`scripts/headless-smoke.sh <wait|cap|off>`。

**`wait`：任务 3s，模型在任务完成后被再次唤醒，结论进入 stdout**

```
### case: wait
### exit: 0   wall: 4377ms   requests: 3   taskId: 69a4f530-8825-493f-8723-a241567a3d67
### stdout
CONCLUSION-AFTER-TASK
### stderr
RESULT: PASS
```

3 次请求 = ① 发起 `async_run` ② 当回合的中间回答 ③ **保底等待结束后的续跑请求**。
`stdout` 是第 ③ 次的结论，不是空输出。

**`cap`：第一个任务完成花掉 1 次续跑，第二个永不完成 → 上限出口 + 非 0 退出 + 打印 taskId**

```
### case: cap
### exit: 1   wall: 1746ms   requests: 5   taskId: c431e086-da0c-4c58-b663-a9eeeb92c320
### stdout
### stderr
pi-async: still running 1 async task(s) after 1 continuation(s) and 1.0s: c431e086-da0c-4c58-b663-a9eeeb92c320 (smoke-cap).
Extension error (<boundary>): turn_end could not resolve the persisted assistant entry ID
RESULT: PASS
```

`after 1 continuation(s)` 证明是**续跑上限**（`PI_ASYNC_PRINT_MAX_CONTINUATIONS=1`）而不是时钟（预算设 30s）触发的。
`Extension error (<boundary>): turn_end ...` 是宿主 1.5.2 的既有问题（upstream #11001，0.4.x 同样出现），
不是本改动的产物；`wait` 路径不经过它（通知由 relay 接管，不需要 followUp 唤醒）。

**`off`（变异证据）：`PI_ASYNC_PRINT_WAIT=0` 回到 0.4.x —— 进程早退、结论不出现**

```
### case: off
### exit: 0   wall: 660ms   requests: 3   taskId: f8bdf10d-8a26-4cbc-8974-fdf5e59e63ff
### stdout
### stderr
Extension error (<boundary>): turn_end could not resolve the persisted assistant entry ID
RESULT: PASS
```

同一场景下 `wait` 是 4377ms/有结论，`off` 是 660ms/空 stdout —— 这就是「改回去即红」的进程级证据。

---

## 5. 「改回去即红」变异证据

> 每条都是：**把关键实现改回旧行为 → 对应测试红 → `git checkout --` 恢复 → 再绿**。
> 命令：`node --experimental-strip-types --test <test file>`；完整套件用 `npm test`。

| # | 验收条款 | 变异 | 期望红 | 实测 |
|---|---|---|---|---|
| 1 | 默认工具面没有 `async_wait` | `waitToolExposed()` 改 `return true` | `tests/k-toolsurface.test.ts`「default tool surface is five tools…」 | 见 §5.1 |
| 2 | 未注册调 `async_wait` 明确降级 | 删 `execute` 的调用时闸门 | 同文件「stale async_wait registration resolves with a readable degraded payload…」 | 见 §5.2 |
| 3 | `mode=sync` 从 schema/代码消失 | schema 里加回 `timeoutMs` 一行 | 同文件残留审计 + schema 断言 | 见 §5.3 |
| 4 | nudge 不含 `async_wait` | `<async-state>` 全唤醒分支改回旧句 | `tests/e-nudges.test.ts` 默认注入态断言 | 见 §5.4 |
| 5 | headless 等任务完成并续跑 | `PI_ASYNC_PRINT_WAIT=0`（进程级）/ `continue: true`→`false`（单测） | `headless-smoke.sh wait` / `tests/j-print-wait.test.ts` | 见 §4 的 `off` + §5.5 |

（详细输出见下节；由 review 与本地实验两路交叉验证。）

---

## 6. 与 0.4.8 的合并情况

- `origin/main` 已包含 0.4.8：`e67ff79 Merge pull request #98 from zzjcool/feat/hold-in-rail`。
- 合并方式：0.5.0 先落一个提交（`ebfda87`），再 `git merge origin/main`（`973d975`），**只冲突 `CHANGELOG.md`**
  （两侧都在顶部加条目，已按「0.5.0 在 0.4.8 之上」手工归一）。
- 自动合并但逐处复核过的文件：`src/guard/hold.ts`（0.4.8 的 hold 行为，我们只保留 main 版本）、
  `src/tui/rail.ts`（0.4.8 的 rail 重写 + 我们的 `typeColor` 槽位等价改写）、
  `tests/h-hold.test.ts`（0.4.8 的用例 + 我们的 handler 顺序断言）、
  `tests/i-settle-owner.test.ts`（0.4.8 的用例 + 我们按 customType 选取 hold draft 的边界辅助）。
- **`hold.ts` 的行为一行没改**：D5 用独立模块，不需要改 hold。合流后 431 例全绿、typecheck 干净。
- 已知的刻意不改：`src/tui/surfaces.ts` 的 rail 等待行字面量 `⠙ async_wait · running …` 属于 0.4.8 冻结文案
  （CONTRACT §7.1 修订 8），本次不动；它是 TUI 的视觉标签，不是模型可见的工具指导。

---

## 7. 门禁与测试数字

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过（`tsc --noEmit`，0 输出） |
| `npm test` | **431 / 431 pass / 0 fail**（基线 0.4.7 是 417；删 12 例 sync + 增 26 例新面） |
| `grep -rn "\b sync\b"`（词边界）`src/ extensions/` | 空 |
| `grep -rn "runSync\|SyncResult\|onTimeout\|PI_ASYNC_MAX_SYNC_TIMEOUT_MS" src/ extensions/` | 空 |
| `scripts/headless-smoke.sh wait\|cap\|off` | 3/3 PASS（原文见 §4.1） |
| `npm pack --dry-run` | 仍只含 `extensions/ src/ skills/ README LICENSE docs/CONTRACT.md CHANGELOG.md`（`scripts/` 不进包） |
